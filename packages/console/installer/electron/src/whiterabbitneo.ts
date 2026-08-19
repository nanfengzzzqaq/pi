import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const WHITERABBITNEO_PROVIDER_ID = "whiterabbitneo";
export const DEFAULT_WHITERABBITNEO_BASE_URL = "http://127.0.0.1:11434/v1";
export const DEFAULT_WHITERABBITNEO_MODEL_ID = "whiterabbitneo-v3:latest";

const DEFAULT_DISCOVERY_TIMEOUT_MS = 1_000;

interface WhiteRabbitNeoEnvironment {
	WHITERABBITNEO_API_KEY?: string;
	WHITERABBITNEO_BASE_URL?: string;
	WHITERABBITNEO_MODEL_ID?: string;
}

interface WhiteRabbitNeoDiscoveryOptions {
	env?: WhiteRabbitNeoEnvironment;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
}

type ProviderConfig = Parameters<ModelRuntime["registerProvider"]>[1];

function normalizedEnvironmentValue(value: string | undefined, fallback: string): string {
	return value?.trim() || fallback;
}

function whiteRabbitNeoConfig(env: WhiteRabbitNeoEnvironment): ProviderConfig {
	const baseUrl = normalizedEnvironmentValue(env.WHITERABBITNEO_BASE_URL, DEFAULT_WHITERABBITNEO_BASE_URL).replace(
		/\/+$/u,
		"",
	);
	const modelId = normalizedEnvironmentValue(env.WHITERABBITNEO_MODEL_ID, DEFAULT_WHITERABBITNEO_MODEL_ID);
	return {
		name: "WhiteRabbitNeo Local",
		baseUrl,
		apiKey: normalizedEnvironmentValue(env.WHITERABBITNEO_API_KEY, "ollama"),
		api: "openai-completions",
		models: [
			{
				id: modelId,
				name: "WhiteRabbitNeo V3 (Local)",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32_768,
				maxTokens: 8_192,
				compat: {
					supportsStore: false,
					supportsDeveloperRole: false,
					supportsReasoningEffort: false,
					supportsUsageInStreaming: true,
					supportsStrictMode: false,
					maxTokensField: "max_tokens",
				},
			},
		],
	};
}

function modelIdsFromResponse(value: unknown): string[] {
	if (typeof value !== "object" || value === null || !("data" in value) || !Array.isArray(value.data)) return [];
	return value.data.flatMap((entry) => {
		if (typeof entry !== "object" || entry === null || !("id" in entry) || typeof entry.id !== "string") return [];
		return [entry.id];
	});
}

/** Register the local Ollama model only when its OpenAI-compatible endpoint is reachable. */
export async function registerDetectedWhiteRabbitNeo(
	modelRuntime: Pick<ModelRuntime, "getProvider" | "registerProvider">,
	options: WhiteRabbitNeoDiscoveryOptions = {},
): Promise<boolean> {
	if (modelRuntime.getProvider(WHITERABBITNEO_PROVIDER_ID)) return false;
	const env = options.env ?? process.env;
	const config = whiteRabbitNeoConfig(env);
	const modelId = config.models?.[0]?.id;
	if (!config.baseUrl || !modelId) return false;

	try {
		const response = await (options.fetch ?? globalThis.fetch)(`${config.baseUrl}/models`, {
			headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : undefined,
			signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS),
		});
		if (!response.ok || !modelIdsFromResponse(await response.json()).includes(modelId)) return false;
		modelRuntime.registerProvider(WHITERABBITNEO_PROVIDER_ID, config);
		return true;
	} catch {
		return false;
	}
}
