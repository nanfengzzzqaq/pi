import { readDurableJson, writeDurableJson } from "./durable-json.ts";

const FILE_VERSION = 2;
const LEGACY_FILE_VERSION = 1;
const PROVIDER_PREFIX = "pi-console-custom-";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

export interface CustomModelDefinition {
	providerId: string;
	name: string;
	baseUrl: string;
	modelId: string;
	contextWindow: number;
	maxTokens: number;
	vision: boolean;
	reasoning: boolean;
	authMode?: "api_key" | "none";
}

interface CustomModelsFile {
	version: number;
	models: CustomModelDefinition[];
}

export interface CustomModelInput {
	name?: unknown;
	baseUrl?: unknown;
	modelId?: unknown;
	contextWindow?: unknown;
	maxTokens?: unknown;
	vision?: unknown;
	reasoning?: unknown;
	authMode?: unknown;
}

function requiredText(value: unknown, label: string, maxLength: number): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label}不能为空`);
	const normalized = value.trim();
	if (normalized.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符`);
	return normalized;
}

function positiveInteger(value: unknown, label: string, fallback: number): number {
	if (value === undefined || value === null || value === "") return fallback;
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label}必须是正整数`);
	return parsed;
}

export function normalizeBaseUrl(value: unknown): string {
	const raw = requiredText(value, "API 地址", 2048);
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error("API 地址不是有效网址");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("API 地址只支持 http 或 https");
	}
	if (parsed.username || parsed.password) throw new Error("API 地址不能包含用户名或密码");
	if (parsed.search || parsed.hash) throw new Error("API 地址不能包含查询参数或锚点");
	return parsed.toString().replace(/\/$/u, "");
}

export function createCustomProviderId(randomId: string): string {
	const suffix = randomId
		.toLowerCase()
		.replace(/[^a-z0-9]/gu, "")
		.slice(0, 16);
	if (!suffix) throw new Error("无法生成模型服务标识");
	return `${PROVIDER_PREFIX}${suffix}`;
}

export function isCustomProviderId(providerId: string): boolean {
	return providerId.startsWith(PROVIDER_PREFIX) && /^[a-z0-9-]+$/u.test(providerId);
}

export function normalizeCustomModel(providerId: string, input: CustomModelInput): CustomModelDefinition {
	if (!isCustomProviderId(providerId)) throw new Error("自定义模型服务标识无效");
	if (input.authMode !== undefined && input.authMode !== "api_key" && input.authMode !== "none")
		throw new Error("鉴权方式无效");
	const contextWindow = positiveInteger(input.contextWindow, "上下文长度", DEFAULT_CONTEXT_WINDOW);
	const maxTokens = positiveInteger(input.maxTokens, "最大输出长度", DEFAULT_MAX_TOKENS);
	if (contextWindow > 4_000_000) throw new Error("上下文长度不能超过 4000000");
	if (maxTokens > contextWindow) throw new Error("最大输出长度不能超过上下文长度");
	return {
		providerId,
		name: requiredText(input.name, "服务名称", 80),
		baseUrl: normalizeBaseUrl(input.baseUrl),
		modelId: requiredText(input.modelId, "模型 ID", 300),
		contextWindow,
		maxTokens,
		vision: input.vision === true,
		reasoning: input.reasoning === true,
		...(input.authMode === "none" ? { authMode: "none" as const } : {}),
	};
}

type LegacyCustomModelDefinition = Omit<CustomModelDefinition, "reasoning">;

function isLegacyDefinition(value: unknown): value is LegacyCustomModelDefinition {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.providerId === "string" &&
		isCustomProviderId(entry.providerId) &&
		typeof entry.name === "string" &&
		typeof entry.baseUrl === "string" &&
		typeof entry.modelId === "string" &&
		Number.isSafeInteger(entry.contextWindow) &&
		Number(entry.contextWindow) > 0 &&
		Number.isSafeInteger(entry.maxTokens) &&
		Number(entry.maxTokens) > 0 &&
		typeof entry.vision === "boolean"
	);
}

function isDefinition(value: unknown): value is CustomModelDefinition {
	return isLegacyDefinition(value) && typeof (value as Record<string, unknown>).reasoning === "boolean";
}

export function loadCustomModels(filePath: string): CustomModelDefinition[] {
	return readDurableJson(filePath, parseCustomModelsFile, () => ({ version: FILE_VERSION, models: [] })).models;
}

function parseCustomModelsFile(raw: unknown): CustomModelsFile {
	if (typeof raw !== "object" || raw === null) throw new Error("自定义模型配置格式无效");
	const file = raw as Partial<CustomModelsFile>;
	if (!Array.isArray(file.models)) throw new Error("自定义模型配置格式无效");
	if (file.version === FILE_VERSION && file.models.every(isDefinition))
		return {
			version: FILE_VERSION,
			models: file.models.map((entry) => normalizeCustomModel(entry.providerId, entry)),
		};
	if (file.version === LEGACY_FILE_VERSION && file.models.every(isLegacyDefinition)) {
		return {
			version: FILE_VERSION,
			models: file.models.map((definition) =>
				normalizeCustomModel(definition.providerId, { ...definition, reasoning: false }),
			),
		};
	}
	throw new Error("自定义模型配置格式无效");
}

export function writeCustomModels(filePath: string, models: CustomModelDefinition[]): void {
	const file: CustomModelsFile = { version: FILE_VERSION, models };
	writeDurableJson(filePath, file, parseCustomModelsFile, () => ({ version: FILE_VERSION, models: [] }));
}

export function saveCustomModel(filePath: string, definition: CustomModelDefinition): void {
	const models = loadCustomModels(filePath);
	const index = models.findIndex((entry) => entry.providerId === definition.providerId);
	if (index === -1) models.push(definition);
	else models[index] = definition;
	writeCustomModels(filePath, models);
}

export function removeCustomModel(filePath: string, providerId: string): boolean {
	if (!isCustomProviderId(providerId)) return false;
	const models = loadCustomModels(filePath);
	const next = models.filter((entry) => entry.providerId !== providerId);
	if (next.length === models.length) return false;
	writeCustomModels(filePath, next);
	return true;
}

function usesQwenChatTemplate(modelId: string): boolean {
	return /(^|[/_.-])qwen(?=$|[/_.-]|\d)/iu.test(modelId);
}

/**
 * Reasoning on these models shares the single `max_tokens` output ceiling, so an
 * xhigh turn can spend the whole budget on reasoning and emit no answer. The cap
 * narrows only this custom model's thinking budget; the global per-level budgets
 * stay untouched, and the server only sees the standard budget field.
 */
const QWEN_THINKING_TOKEN_BUDGET_CAP = 8192;

export function toProviderConfig(definition: CustomModelDefinition) {
	const input: ("text" | "image")[] = definition.vision ? ["text", "image"] : ["text"];
	return {
		name: definition.name,
		baseUrl: definition.baseUrl,
		api: "openai-completions" as const,
		models: [
			{
				id: definition.modelId,
				name: definition.modelId,
				reasoning: definition.reasoning,
				thinkingLevelMap: definition.reasoning
					? {
							off: null,
							minimal: null,
							low: "low",
							medium: "medium",
							high: null,
							xhigh: "xhigh",
							max: null,
						}
					: undefined,
				input,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: definition.contextWindow,
				maxTokens: definition.maxTokens,
				compat: {
					supportsStore: false,
					supportsDeveloperRole: false,
					supportsReasoningEffort: definition.reasoning,
					...(definition.reasoning && usesQwenChatTemplate(definition.modelId)
						? {
								thinkingFormat: "qwen-chat-template" as const,
								thinkingTokenBudgetField: "thinking_token_budget" as const,
								thinkingTokenBudgetCap: QWEN_THINKING_TOKEN_BUDGET_CAP,
							}
						: {}),
					supportsStrictMode: false,
					supportsOpenAIGrammarTools: false,
					maxTokensField: "max_tokens" as const,
				},
			},
		],
	};
}

export async function discoverOpenAIModels(
	baseUrl: unknown,
	apiKey: string | undefined,
	options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<string[]> {
	const endpoint = `${normalizeBaseUrl(baseUrl)}/models`;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
	try {
		const response = await (options.fetch ?? globalThis.fetch)(endpoint, {
			headers: {
				Accept: "application/json",
				...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
			},
			signal: controller.signal,
		});
		if (!response.ok) {
			const detail = (await response.text()).replace(/\s+/gu, " ").trim().slice(0, 300);
			throw new Error(`读取模型失败（HTTP ${response.status}）${detail ? `：${detail}` : ""}`);
		}
		const body = (await response.json()) as { data?: unknown };
		if (!Array.isArray(body.data)) throw new Error("模型接口没有返回 OpenAI 格式的 data 数组");
		const ids = body.data
			.map((item) => (typeof item === "object" && item !== null ? (item as { id?: unknown }).id : undefined))
			.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
			.map((id) => id.trim());
		return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
	} catch (error) {
		if (controller.signal.aborted) throw new Error("读取模型超时，请检查 API 地址是否可访问");
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}
