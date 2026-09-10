import { describe, expect, it } from "vitest";
import { refreshModelCatalogs } from "../src/model-catalog-refresh.ts";

type CatalogRuntime = Parameters<typeof refreshModelCatalogs>[0];

function stubRuntime(
	options: {
		authenticated?: string[];
		refreshResult?: { aborted?: boolean; errors?: Map<string, Error> };
		models?: number;
	} = {},
): { runtime: CatalogRuntime; refreshOptions: () => unknown } {
	const authenticated = new Set(options.authenticated ?? []);
	let capturedOptions: unknown;
	const runtime = {
		getProviders: () => [
			{ id: "zai-coding-cn", refreshModels: () => Promise.resolve() },
			{ id: "deepseek", refreshModels: () => Promise.resolve() },
			{ id: "static-provider" },
		],
		getModels: () => new Array(options.models ?? 42).fill(null),
		hasConfiguredAuth: (id: string) => authenticated.has(id),
		refresh: async (refreshOptions: unknown) => {
			capturedOptions = refreshOptions;
			return {
				aborted: options.refreshResult?.aborted ?? false,
				errors: options.refreshResult?.errors ?? new Map<string, Error>(),
			};
		},
	};
	return { runtime, refreshOptions: () => capturedOptions };
}

describe("refreshModelCatalogs", () => {
	it("force-refreshes authenticated providers and skips the rest", async () => {
		const { runtime, refreshOptions } = stubRuntime({ authenticated: ["zai-coding-cn"], models: 7 });
		const summary = await refreshModelCatalogs(runtime);
		const options = refreshOptions() as { force?: boolean; allowNetwork?: boolean; signal?: AbortSignal };
		expect(options.force).toBe(true);
		expect(options.allowNetwork).toBe(true);
		expect(options.signal).toBeInstanceOf(AbortSignal);
		expect(summary.ok).toBe(true);
		expect(summary.aborted).toBe(false);
		expect(summary.refreshed).toEqual(["zai-coding-cn"]);
		expect(summary.skipped).toEqual(["deepseek"]);
		expect(summary.errors).toEqual([]);
		expect(summary.modelCount).toBe(7);
	});

	it("reports provider errors and excludes them from refreshed", async () => {
		const { runtime } = stubRuntime({
			authenticated: ["zai-coding-cn", "deepseek"],
			refreshResult: { errors: new Map([["deepseek", new Error("catalog unavailable")]]) },
		});
		const summary = await refreshModelCatalogs(runtime);
		expect(summary.ok).toBe(false);
		expect(summary.refreshed).toEqual(["zai-coding-cn"]);
		expect(summary.errors).toEqual([{ provider: "deepseek", message: "catalog unavailable" }]);
	});

	it("marks an aborted refresh as not ok", async () => {
		const { runtime } = stubRuntime({ authenticated: ["zai-coding-cn"], refreshResult: { aborted: true } });
		const summary = await refreshModelCatalogs(runtime);
		expect(summary.ok).toBe(false);
		expect(summary.aborted).toBe(true);
		expect(summary.refreshed).toEqual(["zai-coding-cn"]);
	});
});
