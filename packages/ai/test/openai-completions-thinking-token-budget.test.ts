import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/compat.ts";
import type { AssistantMessage, Context, Model, SimpleStreamOptions, ThinkingBudgets } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: {
									prompt_tokens: 1,
									completion_tokens: 1,
									prompt_tokens_details: { cached_tokens: 0 },
									completion_tokens_details: { reasoning_tokens: 0 },
								},
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{ data: typeof stream; response: { status: number; headers: Headers } }>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

type CapturedParams = {
	thinking_token_budget?: number;
	thinking_budget?: number;
	thinking_budget_tokens?: number;
	thinking?: unknown;
	chat_template_kwargs?: Record<string, unknown>;
	max_tokens?: number;
	messages?: Array<Record<string, unknown>>;
};

function vllmModel(
	compat: Model<"openai-completions">["compat"] = {
		thinkingFormat: "zai",
		supportsThinkingTokenBudget: true,
	},
): Model<"openai-completions"> {
	return {
		id: "zai-org/glm-5.2",
		name: "GLM 5.2 (local vLLM)",
		api: "openai-completions",
		provider: "local-vllm",
		baseUrl: "http://localhost:8000/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 16384,
		compat,
	};
}

async function capture(
	model: Model<"openai-completions">,
	options?: {
		reasoning?: SimpleStreamOptions["reasoning"];
		thinkingBudgets?: ThinkingBudgets;
		maxTokens?: number;
		samplingParams?: Record<string, unknown>;
		messages?: Context["messages"];
		payloadOverride?: Record<string, unknown>;
	},
): Promise<CapturedParams> {
	let payload: unknown;

	await streamSimple(
		model,
		{ messages: options?.messages ?? [{ role: "user", content: "Hi", timestamp: Date.now() }] },
		{
			apiKey: "test",
			reasoning: options?.reasoning,
			thinkingBudgets: options?.thinkingBudgets,
			maxTokens: options?.maxTokens,
			samplingParams: options?.samplingParams as SimpleStreamOptions["samplingParams"],
			onPayload: (params: unknown) => {
				payload = options?.payloadOverride
					? { ...(params as Record<string, unknown>), ...options.payloadOverride }
					: params;
				return options?.payloadOverride ? payload : undefined;
			},
		},
	).result();

	return (payload ?? mockState.lastParams) as CapturedParams;
}

describe("openai-completions thinking token budget", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("sends the configured budget for the requested level", async () => {
		const params = await capture(vllmModel(), { reasoning: "medium", thinkingBudgets: { medium: 4096 } });
		expect(params.thinking_token_budget).toBe(4096);
	});

	it("omits the budget when neither the field nor the alias is set", async () => {
		const params = await capture(vllmModel({ thinkingFormat: "zai" }), {
			reasoning: "medium",
			thinkingBudgets: { medium: 4096 },
		});
		expect(params.thinking_token_budget).toBeUndefined();
		expect(params.thinking_budget).toBeUndefined();
		expect(params.thinking_budget_tokens).toBeUndefined();
	});

	it("omits the budget when thinking is off", async () => {
		const params = await capture(vllmModel(), { reasoning: undefined, thinkingBudgets: { high: 8192 } });
		expect(params.thinking_token_budget).toBeUndefined();
	});

	it("clamps xhigh and max to the high budget", async () => {
		const xhigh = await capture(vllmModel(), { reasoning: "xhigh", thinkingBudgets: { high: 8192 } });
		const max = await capture(vllmModel(), { reasoning: "max", thinkingBudgets: { high: 8192 } });
		expect(xhigh.thinking_token_budget).toBe(8192);
		expect(max.thinking_token_budget).toBe(8192);
	});

	it("leaves room for the answer when the budget meets the response ceiling", async () => {
		const params = await capture(vllmModel(), { reasoning: "high" });
		expect(params.thinking_token_budget).toBe(16384 - 1024);
	});

	it("uses the caller max_tokens as the ceiling when it is lower than the model cap", async () => {
		const params = await capture(vllmModel(), {
			reasoning: "high",
			thinkingBudgets: { high: 8192 },
			maxTokens: 4096,
		});
		expect(params.thinking_token_budget).toBe(4096 - 1024);
	});

	it.each(["thinking_budget", "thinking_budget_tokens"] as const)(
		"sends %s when thinkingTokenBudgetField is set",
		async (field) => {
			const params = await capture(vllmModel({ thinkingFormat: "qwen", thinkingTokenBudgetField: field }), {
				reasoning: "medium",
				thinkingBudgets: { medium: 4096 },
			});
			expect(params[field]).toBe(4096);
			expect(params.thinking_token_budget).toBeUndefined();
		},
	);

	it("lets thinkingTokenBudgetField win over the boolean alias", async () => {
		const params = await capture(
			vllmModel({
				thinkingFormat: "zai",
				supportsThinkingTokenBudget: true,
				thinkingTokenBudgetField: "thinking_budget",
			}),
			{ reasoning: "medium", thinkingBudgets: { medium: 4096 } },
		);
		expect(params.thinking_budget).toBe(4096);
		expect(params.thinking_token_budget).toBeUndefined();
	});

	it("caps xhigh at the model-level thinkingTokenBudgetCap while keeping max_tokens and qwen chat template", async () => {
		// Mirrors the Console custom Qwen registration: xhigh maps to the high level
		// budget (16384), which the per-model cap narrows to 8192 before the
		// answer-room clamp, leaving the other half of the 16384 output for the answer.
		const params = await capture(
			vllmModel({
				thinkingFormat: "qwen-chat-template",
				thinkingTokenBudgetField: "thinking_token_budget",
				thinkingTokenBudgetCap: 8192,
				maxTokensField: "max_tokens",
			}),
			{ reasoning: "xhigh", maxTokens: 16384 },
		);
		expect(params.thinking_token_budget).toBe(8192);
		expect(params.max_tokens).toBe(16384);
		expect(params.chat_template_kwargs).toEqual({ enable_thinking: true, preserve_thinking: true });
	});

	it("replays a reasoning-only length stop into the Qwen recovery request", async () => {
		const priorReasoning: AssistantMessage = {
			role: "assistant",
			api: "openai-completions",
			provider: "local-vllm",
			model: "zai-org/glm-5.2",
			content: [{ type: "thinking", thinking: "已经完成的分析", thinkingSignature: "reasoning_content" }],
			usage: {
				input: 100,
				output: 8192,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 8292,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "length",
			timestamp: Date.now(),
		};
		const params = await capture(
			vllmModel({
				thinkingFormat: "qwen-chat-template",
				thinkingTokenBudgetField: "thinking_token_budget",
				thinkingTokenBudgetCap: 8192,
				maxTokensField: "max_tokens",
			}),
			{
				reasoning: "xhigh",
				maxTokens: 16384,
				messages: [
					{ role: "user", content: "复杂任务", timestamp: Date.now() },
					priorReasoning,
					{ role: "user", content: "直接给出最终答案", timestamp: Date.now() },
				],
			},
		);
		expect(params.messages?.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
		expect(params.messages?.[1]).toMatchObject({
			role: "assistant",
			content: null,
			reasoning_content: "已经完成的分析",
		});
	});

	it("does not replay an aborted reasoning-only response", async () => {
		const abortedReasoning: AssistantMessage = {
			role: "assistant",
			api: "openai-completions",
			provider: "local-vllm",
			model: "zai-org/glm-5.2",
			content: [{ type: "thinking", thinking: "未完成的分析", thinkingSignature: "reasoning_content" }],
			usage: {
				input: 100,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 200,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "aborted",
			timestamp: Date.now(),
		};
		const params = await capture(vllmModel(), {
			reasoning: "xhigh",
			messages: [
				{ role: "user", content: "复杂任务", timestamp: Date.now() },
				abortedReasoning,
				{ role: "user", content: "新请求", timestamp: Date.now() },
			],
		});
		expect(params.messages?.some((message) => message.role === "assistant")).toBe(false);
	});

	it("keeps the global default budget for models without a cap, proving the cap scope", async () => {
		const withoutCap = await capture(
			vllmModel({
				thinkingFormat: "qwen-chat-template",
				thinkingTokenBudgetField: "thinking_token_budget",
				maxTokensField: "max_tokens",
			}),
			{ reasoning: "xhigh", maxTokens: 16384 },
		);
		expect(withoutCap.thinking_token_budget).toBe(16384 - 1024);
	});

	it("still leaves MIN_ANSWER_TOKENS when the cap exceeds a smaller response ceiling", async () => {
		const params = await capture(
			vllmModel({
				thinkingFormat: "qwen-chat-template",
				thinkingTokenBudgetField: "thinking_token_budget",
				thinkingTokenBudgetCap: 8192,
				maxTokensField: "max_tokens",
			}),
			{ reasoning: "xhigh", maxTokens: 4096 },
		);
		expect(params.max_tokens).toBe(4096);
		expect(params.thinking_token_budget).toBe(4096 - 1024);
	});

	it("does not widen the cap to custom budgets below it", async () => {
		const params = await capture(
			vllmModel({
				thinkingFormat: "qwen-chat-template",
				thinkingTokenBudgetField: "thinking_token_budget",
				thinkingTokenBudgetCap: 8192,
				maxTokensField: "max_tokens",
			}),
			{ reasoning: "medium", thinkingBudgets: { medium: 2048 }, maxTokens: 16384 },
		);
		expect(params.thinking_token_budget).toBe(2048);
	});

	it("re-clamps a samplingParams budget override that would exceed the model cap", async () => {
		const params = await capture(
			vllmModel({
				thinkingFormat: "qwen-chat-template",
				thinkingTokenBudgetField: "thinking_token_budget",
				thinkingTokenBudgetCap: 8192,
				maxTokensField: "max_tokens",
			}),
			{
				reasoning: "xhigh",
				maxTokens: 16384,
				samplingParams: { thinking_token_budget: 16384 },
			},
		);
		expect(params.thinking_token_budget).toBe(8192);
		expect(params.max_tokens).toBe(16384);
	});

	it("restores protected limits after an onPayload override", async () => {
		const params = await capture(
			vllmModel({
				thinkingFormat: "qwen-chat-template",
				thinkingTokenBudgetField: "thinking_token_budget",
				thinkingTokenBudgetCap: 8192,
				maxTokensField: "max_tokens",
			}),
			{
				reasoning: "xhigh",
				maxTokens: 16_384,
				payloadOverride: { thinking_token_budget: 16_384, max_tokens: 999_999 },
			},
		);
		expect(params.thinking_token_budget).toBe(8192);
		expect(params.max_tokens).toBe(16_384);
	});

	it.each([
		["undefined", undefined],
		["null", null],
		["string", "16384"],
		["NaN", Number.NaN],
		["zero", 0],
	])("restores the protected budget after a %s samplingParams override", async (_label, value) => {
		const params = await capture(
			vllmModel({
				thinkingFormat: "qwen-chat-template",
				thinkingTokenBudgetField: "thinking_token_budget",
				thinkingTokenBudgetCap: 8192,
				maxTokensField: "max_tokens",
			}),
			{
				reasoning: "xhigh",
				maxTokens: 16384,
				samplingParams: { thinking_token_budget: value },
			},
		);
		expect(params.thinking_token_budget).toBe(8192);
	});

	it("does not let samplingParams widen max_tokens beyond the model limit", async () => {
		const params = await capture(
			vllmModel({
				thinkingFormat: "qwen-chat-template",
				thinkingTokenBudgetField: "thinking_token_budget",
				thinkingTokenBudgetCap: 8192,
				maxTokensField: "max_tokens",
			}),
			{ reasoning: "xhigh", maxTokens: 16384, samplingParams: { max_tokens: 999_999 } },
		);
		expect(params.max_tokens).toBe(16384);
		expect(params.thinking_token_budget).toBe(8192);
	});

	it("does not let samplingParams widen max_tokens beyond the remaining context", async () => {
		const model = {
			...vllmModel({
				thinkingFormat: "qwen-chat-template",
				thinkingTokenBudgetField: "thinking_token_budget",
				thinkingTokenBudgetCap: 8192,
				maxTokensField: "max_tokens",
			}),
			contextWindow: 10_000,
		};
		const params = await capture(model, {
			reasoning: "xhigh",
			maxTokens: 16_384,
			samplingParams: { max_tokens: 999_999 },
			messages: [{ role: "user", content: "x".repeat(12_000), timestamp: Date.now() }],
		});
		expect(params.max_tokens).toBe(2904);
		expect(params.thinking_token_budget).toBe(1880);
	});

	it("does not let onPayload widen max_tokens beyond the remaining context", async () => {
		const model = {
			...vllmModel({
				thinkingFormat: "qwen-chat-template",
				thinkingTokenBudgetField: "thinking_token_budget",
				thinkingTokenBudgetCap: 8192,
				maxTokensField: "max_tokens",
			}),
			contextWindow: 10_000,
		};
		const params = await capture(model, {
			reasoning: "xhigh",
			maxTokens: 16_384,
			payloadOverride: { max_tokens: 999_999, thinking_token_budget: 999_999 },
			messages: [{ role: "user", content: "x".repeat(12_000), timestamp: Date.now() }],
		});
		expect(params.max_tokens).toBe(2904);
		expect(params.thinking_token_budget).toBe(1880);
	});

	it("re-clamps the capped budget against a smaller samplingParams max_tokens", async () => {
		const params = await capture(
			vllmModel({
				thinkingFormat: "qwen-chat-template",
				thinkingTokenBudgetField: "thinking_token_budget",
				thinkingTokenBudgetCap: 8192,
				maxTokensField: "max_tokens",
			}),
			{
				reasoning: "xhigh",
				maxTokens: 16384,
				samplingParams: { max_tokens: 4096 },
			},
		);
		expect(params.max_tokens).toBe(4096);
		expect(params.thinking_token_budget).toBe(4096 - 1024);
	});

	it.each([1, 1024])(
		"fails as context overflow instead of dropping the budget at max_tokens=%s",
		async (maxTokens) => {
			const model = vllmModel({
				thinkingFormat: "qwen-chat-template",
				thinkingTokenBudgetField: "thinking_token_budget",
				thinkingTokenBudgetCap: 8192,
				maxTokensField: "max_tokens",
			});
			const result = await streamSimple(
				model,
				{ messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] },
				{ apiKey: "test", reasoning: "xhigh", maxTokens },
			).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("context_length_exceeded");
			expect(mockState.lastParams).toBeUndefined();
		},
	);

	it("puts the clamped budget in chat_template_kwargs when $var is thinking.budget", async () => {
		const params = await capture(
			vllmModel({
				thinkingFormat: "chat-template",
				chatTemplateKwargs: {
					enable_thinking: { $var: "thinking.enabled" },
					thinking_budget: { $var: "thinking.budget" },
				},
			}),
			{ reasoning: "high" },
		);
		expect(params.chat_template_kwargs).toEqual({
			enable_thinking: true,
			thinking_budget: 16384 - 1024,
		});
		expect(params.thinking_token_budget).toBeUndefined();
	});

	it("omits thinking.budget from chat_template_kwargs when thinking is off", async () => {
		const params = await capture(
			vllmModel({
				thinkingFormat: "chat-template",
				chatTemplateKwargs: {
					enable_thinking: { $var: "thinking.enabled" },
					thinking_budget: { $var: "thinking.budget" },
				},
			}),
			{ reasoning: undefined },
		);
		expect(params.chat_template_kwargs).toEqual({ enable_thinking: false });
	});
});
