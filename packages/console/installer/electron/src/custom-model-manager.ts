import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type { Credential } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { createConsoleCredentials } from "./credentials.ts";
import {
	type CustomModelDefinition,
	loadCustomModels,
	normalizeCustomModel,
	toProviderConfig,
	writeCustomModels,
} from "./custom-models.ts";
import { atomicFileWrite } from "./durable-json.ts";

type ManagedCredential = Credential & { consoleModelRevision?: string };
interface PendingChange {
	providerId: string;
	revision: string;
	kind: "save" | "delete";
	models: CustomModelDefinition[];
}

export function registerCustomModel(runtime: ModelRuntime, definition: CustomModelDefinition): void {
	runtime.registerProvider(definition.providerId, toProviderConfig(definition));
	if (definition.authMode === "none") {
		const provider = runtime.getProvider(definition.providerId);
		if (!provider) throw new Error("自定义模型注册失败");
		runtime.registerNativeProvider({
			...provider,
			auth: {
				apiKey: {
					name: "无需鉴权",
					check: async () => ({ type: "api_key", source: "无需鉴权" }),
					resolve: async () => ({
						auth: { apiKey: "unused", headers: { Authorization: null } },
						source: "无需鉴权",
					}),
				},
			},
		});
	}
}

/** The journal contains model definitions only; keys never leave the credential file. */
export function createCustomModelManager(
	file: string,
	credentials: ReturnType<typeof createConsoleCredentials>,
	runtime: ModelRuntime,
) {
	const pendingFile = `${file}.pending.json`;
	const queues = new Map<string, Promise<unknown>>();
	const finish = (change: PendingChange) => {
		writeCustomModels(file, change.models);
		try {
			unlinkSync(pendingFile);
		} catch {
			/* A committed journal can be replayed safely on startup. */
		}
	};
	const enqueue = <T>(provider: string, action: () => Promise<T>): Promise<T> => {
		const work = (queues.get(provider) ?? Promise.resolve()).catch(() => {}).then(action);
		queues.set(provider, work);
		void work
			.finally(() => {
				if (queues.get(provider) === work) queues.delete(provider);
			})
			.catch(() => {});
		return work;
	};
	return {
		async recover(): Promise<void> {
			if (!existsSync(pendingFile)) return;
			await credentials.commit((records) => {
				const value: unknown = JSON.parse(readFileSync(pendingFile, "utf8"));
				if (!value || typeof value !== "object") throw new Error("模型配置恢复记录无效");
				const change = value as PendingChange;
				if (
					!Array.isArray(change.models) ||
					typeof change.providerId !== "string" ||
					typeof change.revision !== "string" ||
					!["save", "delete"].includes(change.kind)
				)
					throw new Error("模型配置恢复记录无效");
				change.models = change.models.map((entry) => normalizeCustomModel(entry.providerId, entry));
				const committed =
					change.kind === "delete"
						? !Object.hasOwn(records, change.providerId)
						: (records[change.providerId] as ManagedCredential | undefined)?.consoleModelRevision ===
							change.revision;
				return {
					result: undefined,
					next: records,
					commit: () => {
						if (committed) finish(change);
						else unlinkSync(pendingFile);
					},
				};
			});
		},
		save(definition: CustomModelDefinition, apiKey?: string) {
			return enqueue(definition.providerId, async () => {
				const normalized = normalizeCustomModel(definition.providerId, definition);
				await credentials.commit((records) => {
					const previous = records[definition.providerId];
					const key =
						normalized.authMode === "none"
							? "unused"
							: apiKey?.trim() || (previous?.type === "api_key" ? previous.key : undefined);
					if (!key) throw new Error("请填写 API Key，或明确选择无需鉴权");
					const revision = randomUUID();
					const models = loadCustomModels(file).filter((entry) => entry.providerId !== normalized.providerId);
					models.push(normalized);
					const change: PendingChange = { providerId: normalized.providerId, revision, kind: "save", models };
					atomicFileWrite(pendingFile, JSON.stringify(change));
					const credential: ManagedCredential = { type: "api_key", key, consoleModelRevision: revision };
					return {
						result: undefined,
						next: { ...records, [definition.providerId]: credential },
						commit: () => finish(change),
					};
				});
				let runtimePending = false;
				try {
					registerCustomModel(runtime, normalized);
					const result = await runtime.refresh({ allowNetwork: false, providers: [normalized.providerId] });
					runtimePending = result.aborted || result.errors.size > 0;
				} catch {
					runtimePending = true;
				}
				return { definition: normalized, runtimePending };
			});
		},
		remove(providerId: string) {
			return enqueue(providerId, async () => {
				const removed = await credentials.commit((records) => {
					const models = loadCustomModels(file);
					const nextModels = models.filter((entry) => entry.providerId !== providerId);
					if (nextModels.length === models.length) return { result: false, next: records, commit: () => {} };
					const change: PendingChange = { providerId, revision: randomUUID(), kind: "delete", models: nextModels };
					atomicFileWrite(pendingFile, JSON.stringify(change));
					const next = { ...records };
					delete next[providerId];
					return { result: true, next, commit: () => finish(change) };
				});
				let runtimePending = false;
				try {
					if (removed) runtime.unregisterProvider(providerId);
					const result = await runtime.refresh({ allowNetwork: false, providers: [providerId] });
					runtimePending = result.aborted || result.errors.size > 0;
				} catch {
					runtimePending = true;
				}
				return { removed, runtimePending };
			});
		},
		clearApiKey(providerId: string) {
			return enqueue(providerId, async () => {
				const removed = await credentials.deleteApiKey(providerId);
				let runtimePending = false;
				try {
					const result = await runtime.refresh({ allowNetwork: false, providers: [providerId] });
					runtimePending = result.aborted || result.errors.size > 0;
				} catch {
					runtimePending = true;
				}
				return { removed, runtimePending };
			});
		},
	};
}
