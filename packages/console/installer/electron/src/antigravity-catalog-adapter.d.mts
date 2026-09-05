import type { Provider } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
export interface ConsoleAntigravityCatalog {
	models: ProviderModelConfig[];
	routing: Record<string, { off?: string; defaultRequestId?: string; routing?: Record<string, string> }>;
}
export function discoverConsoleCatalog(apiKey: string, signal: AbortSignal): Promise<ConsoleAntigravityCatalog>;
export function applyConsoleCatalog(catalog: ConsoleAntigravityCatalog): void;
// The pinned adapter accepts every provider stream options shape (its Anthropic
// toolChoice includes "any"), so accept both the simple and the per-API unions.
type ConsoleStreamOptions = Parameters<Provider["stream"]>[2] | Parameters<Provider["streamSimple"]>[2];
export const consoleAntigravityStream: (
	model: Parameters<Provider["streamSimple"]>[0],
	context: Parameters<Provider["streamSimple"]>[1],
	options?: ConsoleStreamOptions,
) => ReturnType<Provider["streamSimple"]>;
