import { createRequire } from "node:module";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	applyConsoleCatalog,
	type ConsoleAntigravityCatalog,
	consoleAntigravityStream,
	discoverConsoleCatalog,
} from "./antigravity-catalog-adapter.mjs";
import { readDurableJson, writeDurableJson } from "./durable-json.ts";

const require = createRequire(import.meta.url);
export function bundledProviderExtensionPaths(): string[] {
	try {
		return [require.resolve("pi-antigravity")];
	} catch {
		return [];
	}
}
export interface AntigravityCatalogStatus {
	source: "discovered" | "cache" | "fallback";
	refreshStatus: "idle" | "refreshing" | "success" | "failed";
	checkedAt?: number;
	error?: string;
	discoveredModelIds: string[];
}
interface StoredCatalog {
	checkedAt: number;
	catalog: ConsoleAntigravityCatalog;
}
function parseStoredCatalog(value: unknown): StoredCatalog | null {
	if (value === null) return null;
	if (!value || typeof value !== "object") throw new Error("模型目录缓存无效");
	const entry = value as StoredCatalog;
	if (
		!Number.isFinite(entry.checkedAt) ||
		!Array.isArray(entry.catalog?.models) ||
		!entry.catalog.models.length ||
		!entry.catalog.routing ||
		typeof entry.catalog.routing !== "object"
	)
		throw new Error("模型目录缓存无效");
	for (const model of entry.catalog.models) {
		if (
			typeof model.id !== "string" ||
			!model.id ||
			typeof model.name !== "string" ||
			typeof model.reasoning !== "boolean" ||
			!Array.isArray(model.input) ||
			!model.cost ||
			!Number.isFinite(model.contextWindow) ||
			!Number.isFinite(model.maxTokens)
		)
			throw new Error("模型目录缓存无效");
		const route = entry.catalog.routing[model.id];
		if (
			!route ||
			typeof route !== "object" ||
			(route.off !== undefined && typeof route.off !== "string") ||
			(route.defaultRequestId !== undefined && typeof route.defaultRequestId !== "string") ||
			(route.routing !== undefined &&
				(!route.routing ||
					typeof route.routing !== "object" ||
					Object.values(route.routing).some((id) => typeof id !== "string")))
		)
			throw new Error("模型路由缓存无效");
	}
	return entry;
}

/** Explicit metadata discovery never promotes fallback models into an account result. */
export function createAntigravityModelRefresher(
	runtime: Pick<
		ModelRuntime,
		"isUsingOAuth" | "refresh" | "getModels" | "getAuth" | "getProvider" | "registerNativeProvider"
	>,
	cacheFile?: string,
) {
	let pending: Promise<number> | undefined;
	let currentCatalog: ConsoleAntigravityCatalog | undefined;
	let installedProvider: Provider | undefined;
	let status: AntigravityCatalogStatus = { source: "fallback", refreshStatus: "idle", discoveredModelIds: [] };
	const install = (catalog: ConsoleAntigravityCatalog): void => {
		const provider = runtime.getProvider("antigravity");
		currentCatalog = catalog;
		if (!provider) return;
		const models: Model<Api>[] = catalog.models.map((model) => ({
			...model,
			api: "antigravity-api",
			provider: "antigravity",
			baseUrl: provider.baseUrl ?? "https://daily-cloudcode-pa.googleapis.com",
		}));
		applyConsoleCatalog(catalog);
		runtime.registerNativeProvider({
			...provider,
			getModels: () => models,
			refreshModels: undefined,
			stream: (model, context, options) => consoleAntigravityStream(model, context, options),
			streamSimple: consoleAntigravityStream,
		});
		installedProvider = runtime.getProvider("antigravity");
	};
	const initialize = (): void => {
		if (currentCatalog && runtime.getProvider("antigravity") !== installedProvider) install(currentCatalog);
	};
	if (cacheFile) {
		try {
			const cached = readDurableJson(cacheFile, parseStoredCatalog, () => null);
			if (cached) {
				install(cached.catalog);
				status = {
					source: "cache",
					refreshStatus: "idle",
					checkedAt: cached.checkedAt,
					discoveredModelIds: cached.catalog.models.map((model) => model.id),
				};
			}
		} catch {
			status = { ...status, refreshStatus: "failed", error: "模型目录缓存损坏或无法读取，原文已保留，请刷新目录" };
		}
	}
	const refresh = async (): Promise<number> => {
		initialize();
		if (!runtime.isUsingOAuth("antigravity")) throw new Error("请先登录 Google Antigravity");
		pending ??= (async () => {
			status = { ...status, refreshStatus: "refreshing", error: undefined };
			try {
				const signal = AbortSignal.timeout(20_000);
				const auth = await runtime.getAuth("antigravity", { signal });
				const catalog = await discoverConsoleCatalog(auth?.auth.apiKey ?? "", signal);
				const checkedAt = Date.now();
				if (cacheFile) writeDurableJson(cacheFile, { checkedAt, catalog }, parseStoredCatalog, () => null);
				install(catalog);
				const result = await runtime.refresh({ providers: ["antigravity"], allowNetwork: false, signal });
				if (result.aborted || result.errors.size) throw new Error("Catalog activation failed");
				status = {
					source: "discovered",
					refreshStatus: "success",
					checkedAt,
					discoveredModelIds: catalog.models.map((model) => model.id),
				};
				return catalog.models.length;
			} catch {
				const error = "模型目录刷新未完成，请检查网络后重试；已有模型仍可使用";
				status = { ...status, refreshStatus: "failed", error };
				throw new Error(error);
			}
		})().finally(() => {
			pending = undefined;
		});
		return pending;
	};
	return Object.assign(refresh, {
		initialize,
		status: (): AntigravityCatalogStatus => {
			initialize();
			return { ...status, discoveredModelIds: [...status.discoveredModelIds] };
		},
	});
}
