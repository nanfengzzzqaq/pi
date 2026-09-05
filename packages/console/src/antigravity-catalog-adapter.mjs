// Compatibility boundary for the pinned 0.7.1 adapter, whose TypeScript contains enums.
// Keep transport, routing and streaming in one module graph; never use its error-swallowing refresh.
// The pinned package ships TypeScript sources whose internal ".js" specifiers only resolve through
// the coding-agent's loader, so load it with the same jiti runtime — native Node type-stripping
// (the Electron main process) cannot map ".js" imports back onto ".ts" files.
import { createRequire } from "node:module";
import { createJiti } from "jiti/static";

const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url, { moduleCache: false });
const client = await jiti.import(require.resolve("pi-antigravity/src/client/client.ts"));
const grouping = await jiti.import(require.resolve("pi-antigravity/src/models/grouping.ts"));
const models = await jiti.import(require.resolve("pi-antigravity/src/models/models.ts"));
const stream = await jiti.import(require.resolve("pi-antigravity/src/stream/index.ts"));

export async function discoverConsoleCatalog(apiKey, signal) {
	const credentials = client.parseApiKey(apiKey);
	const result = await client.fetchAvailableModelsCatalog(credentials.token, credentials.projectId, signal);
	signal.throwIfAborted();
	// Only advertised model families and routes may become discovered.
	const catalog = grouping.buildAntigravityCatalog(result.data.models ?? {}, { models: [], routing: {} });
	if (!catalog.models.length) throw new Error("No usable models in account catalog");
	catalog.models = catalog.models.map((model) => {
		const template = models.ANTIGRAVITY_MODELS.find((entry) => entry.id === model.id);
		return template ? { ...model, cost: template.cost, contextWindow: template.contextWindow, maxTokens: template.maxTokens } : model;
	});
	return catalog;
}
export const applyConsoleCatalog = models.applyAntigravityCatalog;
export const consoleAntigravityStream = stream.streamAntigravity;
