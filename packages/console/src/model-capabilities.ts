/** Only explicit, structured model capabilities are trusted; names are not capability evidence. */
export interface ModelCapabilities {
	contextWindow?: number;
	maxTokens?: number;
	vision?: boolean;
	reasoning?: boolean;
}

export interface DiscoveredModel extends ModelCapabilities {
	id: string;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function limit(...values: unknown[]): number | undefined {
	return values.find(
		(value): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 4_000_000,
	);
}

function flag(...values: unknown[]): boolean | undefined {
	return values.find((value): value is boolean => typeof value === "boolean");
}

export function parseModelCapabilities(value: unknown): ModelCapabilities {
	const model = record(value);
	const capabilities = record(model.capabilities);
	const architecture = record(model.architecture);
	const limits = record(model.limits);
	const provider = record(model.top_provider);
	const modalities = model.input_modalities ?? architecture.input_modalities;
	const parameters = model.supported_parameters;
	const contextWindow = limit(
		model.max_model_len,
		model.context_length,
		model.context_window,
		model.contextWindow,
		model.max_context_length,
		limits.context_window,
		provider.context_length,
	);
	const maxTokens = limit(
		model.max_output_tokens,
		model.max_completion_tokens,
		model.maxTokens,
		limits.max_output_tokens,
		provider.max_completion_tokens,
	);
	const vision = flag(
		model.vision,
		capabilities.vision,
		Array.isArray(modalities) && modalities.every((item) => typeof item === "string")
			? modalities.includes("image")
			: undefined,
	);
	const reasoning = flag(
		model.reasoning,
		capabilities.reasoning,
		Array.isArray(parameters) && parameters.every((item) => typeof item === "string")
			? parameters.some((item) => item === "reasoning" || item === "reasoning_effort")
			: undefined,
	);
	return {
		...(contextWindow !== undefined ? { contextWindow } : {}),
		...(maxTokens !== undefined ? { maxTokens } : {}),
		...(vision !== undefined ? { vision } : {}),
		...(reasoning !== undefined ? { reasoning } : {}),
	};
}

export function parseDiscoveredModels(body: unknown): DiscoveredModel[] {
	const data = record(body).data;
	if (!Array.isArray(data)) throw new Error("模型接口没有返回 OpenAI 格式的 data 数组");
	const models = new Map<string, DiscoveredModel>();
	for (const entry of data) {
		const id = record(entry).id;
		if (typeof id !== "string" || !id.trim() || id.length > 300) continue;
		const name = id.trim();
		models.set(name, { ...models.get(name), id: name, ...parseModelCapabilities(entry) });
	}
	return [...models.values()].sort((left, right) => left.id.localeCompare(right.id));
}
