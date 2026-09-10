import type { ModelsRefreshOptions, ModelsRefreshResult } from "@earendil-works/pi-ai";

/** Structural slice of ModelRuntime so callers and tests can supply any runtime shape. */
export interface CatalogRuntime {
	getProviders(): ReadonlyArray<{ id: string; refreshModels?: unknown }>;
	getModels(): readonly unknown[];
	hasConfiguredAuth(providerId: string): boolean;
	refresh(options: ModelsRefreshOptions): Promise<ModelsRefreshResult>;
}

export interface ModelCatalogError {
	provider: string;
	message: string;
}

export interface ModelCatalogRefreshSummary {
	/** False when aborted or when any provider failed. */
	ok: boolean;
	aborted: boolean;
	/** Provider IDs whose remote catalog was re-fetched (has auth, no error). */
	refreshed: string[];
	/** Provider IDs without a configured credential; their remote catalog was not fetched. */
	skipped: string[];
	errors: ModelCatalogError[];
	/** Total models across all providers after the refresh. */
	modelCount: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Force-refresh the remote model catalog of every refreshable built-in provider.
 * Credentials are untouched: providers keep their stored keys, so updated model
 * lists become usable without re-entering authentication. Providers without a
 * configured credential are skipped because the runtime only fetches catalogs
 * for authenticated providers.
 */
export async function refreshModelCatalogs(
	runtime: CatalogRuntime,
	options: { timeoutMs?: number } = {},
): Promise<ModelCatalogRefreshSummary> {
	const refreshable = runtime.getProviders().filter((provider) => provider.refreshModels !== undefined);
	const skipped = refreshable
		.filter((provider) => !runtime.hasConfiguredAuth(provider.id))
		.map((provider) => provider.id);
	const result = await runtime.refresh({
		force: true,
		allowNetwork: true,
		signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
	});
	const errors = Array.from(result.errors, ([provider, error]) => ({
		provider,
		message: error instanceof Error ? error.message : String(error),
	}));
	const refreshed = refreshable
		.filter((provider) => runtime.hasConfiguredAuth(provider.id))
		.map((provider) => provider.id)
		.filter((id) => !result.errors.has(id));
	return {
		ok: !result.aborted && errors.length === 0,
		aborted: result.aborted,
		refreshed,
		skipped,
		errors,
		modelCount: runtime.getModels().length,
	};
}
