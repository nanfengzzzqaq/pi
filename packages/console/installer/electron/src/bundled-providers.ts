import { createRequire } from "node:module";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

const require = createRequire(import.meta.url);

/** Resolve the pinned adapter from the application, including in the Electron installation. */
export function bundledProviderExtensionPaths(): string[] {
	try {
		return [require.resolve("pi-antigravity")];
	} catch {
		// An incomplete source update must still allow the existing providers to run.
		return [];
	}
}

/** Login only refreshes local metadata; explicitly discover the account catalog afterwards. */
export function createAntigravityModelRefresher(
	runtime: Pick<ModelRuntime, "isUsingOAuth" | "refresh" | "getModels">,
): () => Promise<number> {
	let pending: Promise<number> | undefined;
	return async () => {
		if (!runtime.isUsingOAuth("antigravity")) throw new Error("请先登录 Google Antigravity");
		pending ??= (async () => {
			try {
				const result = await runtime.refresh({
					providers: ["antigravity"],
					allowNetwork: true,
					force: true,
					signal: AbortSignal.timeout(20_000),
				});
				if (result.aborted || result.errors.size > 0) throw new Error("Catalog refresh failed");
				return runtime.getModels("antigravity").length;
			} catch {
				// OAuth refresh errors may contain tokens. Keep details out of the HTTP response.
				throw new Error("模型目录刷新未完成，请检查网络后重试；已有模型仍可使用");
			}
		})().finally(() => {
			pending = undefined;
		});
		return pending;
	};
}
