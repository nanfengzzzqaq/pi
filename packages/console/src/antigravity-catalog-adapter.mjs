// Compatibility boundary for the pinned 0.7.1 adapter, whose TypeScript contains enums.
// Keep transport, routing and streaming in one module graph; never use its error-swallowing refresh.
import { fetchAvailableModelsCatalog, parseApiKey } from "pi-antigravity/src/client/client.js";
import { buildAntigravityCatalog } from "pi-antigravity/src/models/grouping.js";
import { ANTIGRAVITY_MODELS, applyAntigravityCatalog } from "pi-antigravity/src/models/models.js";
import { streamAntigravity } from "pi-antigravity/src/stream/index.js";

export async function discoverConsoleCatalog(apiKey, signal) {
	const credentials = parseApiKey(apiKey);
	const result = await fetchAvailableModelsCatalog(credentials.token, credentials.projectId, signal);
	signal.throwIfAborted();
	// Only advertised model families and routes may become discovered.
	const catalog = buildAntigravityCatalog(result.data.models ?? {}, { models: [], routing: {} });
	if (!catalog.models.length) throw new Error("No usable models in account catalog");
	catalog.models = catalog.models.map((model) => {
		const template = ANTIGRAVITY_MODELS.find((entry) => entry.id === model.id);
		return template ? { ...model, cost: template.cost, contextWindow: template.contextWindow, maxTokens: template.maxTokens } : model;
	});
	return catalog;
}
export const applyConsoleCatalog = applyAntigravityCatalog;
export const consoleAntigravityStream = streamAntigravity;
