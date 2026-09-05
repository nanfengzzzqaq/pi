import type { Credential } from "@earendil-works/pi-ai";
import { AuthStorage, type AuthStorageBackend, FileAuthStorageBackend } from "@earendil-works/pi-coding-agent";
import { replaceCredentialFile } from "./credential-file.ts";

function validateAuthContent(content: string | undefined): string | undefined {
	if (content === undefined) return undefined;
	const normalized = content.replace(/^\uFEFF/u, "");
	let value: unknown;
	try {
		value = JSON.parse(normalized);
	} catch {
		throw new Error("账号配置已损坏，已保留原文件，请从备份恢复");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("账号配置格式无效，已保留原文件，请从备份恢复");
	}
	return normalized;
}

function partitionCredentials(content: string | undefined) {
	const data = JSON.parse(validateAuthContent(content) ?? "{}") as Record<string, unknown>;
	const valid: Record<string, Credential> = Object.create(null);
	const invalid: Record<string, unknown> = Object.create(null);
	for (const [provider, value] of Object.entries(data)) {
		const item =
			value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
		const api =
			item.type === "api_key" &&
			(item.key === undefined || typeof item.key === "string") &&
			(item.env === undefined ||
				(item.env !== null &&
					typeof item.env === "object" &&
					!Array.isArray(item.env) &&
					Object.values(item.env).every((value) => typeof value === "string")));
		const oauth =
			item.type === "oauth" &&
			typeof item.access === "string" &&
			typeof item.refresh === "string" &&
			typeof item.expires === "number" &&
			Number.isFinite(item.expires);
		if (api || oauth) valid[provider] = value as Credential;
		else invalid[provider] = value;
	}
	return { valid, invalid };
}

function validNext(content: string): Record<string, Credential> {
	const { valid, invalid } = partitionCredentials(content);
	if (Object.keys(invalid).length) throw new Error("新账号记录格式无效，未修改已有账号");
	return valid;
}

/** API-key edits and OAuth share the same file lock and storage implementation. */
export function createConsoleCredentials(path: string) {
	const fileBackend = new FileAuthStorageBackend(path);
	const backend: AuthStorageBackend = {
		withLock(fn) {
			return fileBackend.withLock((current) => {
				const { valid, invalid } = partitionCredentials(current);
				const { result, next } = fn(JSON.stringify(valid));
				if (next !== undefined)
					replaceCredentialFile(path, JSON.stringify({ ...invalid, ...validNext(next) }, null, "\t"));
				return { result };
			});
		},
		withLockAsync(fn, options) {
			return fileBackend.withLockAsync(async (current) => {
				const { valid, invalid } = partitionCredentials(current);
				const { result, next } = await fn(JSON.stringify(valid));
				options?.signal?.throwIfAborted();
				if (next !== undefined)
					replaceCredentialFile(path, JSON.stringify({ ...invalid, ...validNext(next) }, null, "\t"));
				return { result };
			}, options);
		},
	};
	const store = AuthStorage.fromStorage(backend);
	return {
		store,
		async issues(): Promise<Array<{ provider: string; message: string }>> {
			return fileBackend.withLockAsync(async (current) => ({
				result: Object.keys(partitionCredentials(current).invalid).map((provider) => ({
					provider,
					message: "此账号记录已损坏，原文保留；请重新配置此账号",
				})),
			}));
		},
		/** Commit a model definition and its credential while holding the same credential lock. */
		async commit<T>(
			change: (data: Record<string, Credential>) => { result: T; next: Record<string, Credential>; commit(): void },
		): Promise<T> {
			return fileBackend.withLockAsync(async (current) => {
				const { valid, invalid } = partitionCredentials(current);
				const operation = change(valid);
				const next = JSON.stringify({ ...invalid, ...validNext(JSON.stringify(operation.next)) }, null, "\t");
				const changed = next !== current;
				if (changed) replaceCredentialFile(path, next);
				try {
					operation.commit();
				} catch (error) {
					if (changed) replaceCredentialFile(path, current ?? "{}");
					throw error;
				}
				return { result: operation.result };
			});
		},
		async apiKeys(): Promise<Record<string, string>> {
			return backend.withLockAsync(async (content) => {
				const data = JSON.parse(content ?? "{}") as Record<string, { type?: string; key?: unknown }>;
				const keys: Record<string, string> = {};
				for (const [provider, credential] of Object.entries(data)) {
					if (credential?.type === "api_key" && typeof credential.key === "string")
						keys[provider] = credential.key;
				}
				return { result: keys };
			});
		},
		async setApiKey(provider: string, key: string): Promise<void> {
			await store.modify(provider, async () => ({ type: "api_key", key }));
		},
		async deleteApiKey(provider: string): Promise<boolean> {
			return backend.withLockAsync(async (content) => {
				const data = JSON.parse(content ?? "{}") as Record<string, { type?: string }>;
				if (data[provider]?.type !== "api_key") return { result: false };
				delete data[provider];
				return { result: true, next: JSON.stringify(data, null, "\t") };
			});
		},
	};
}
