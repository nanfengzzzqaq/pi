import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { AssistantMessage, SimpleStreamOptions, Tool, ToolResultMessage } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const responseStream = {
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
					const promise = Promise.resolve(responseStream) as Promise<typeof responseStream> & {
						withResponse: () => Promise<{
							data: typeof responseStream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: responseStream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

const usage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type CapturedPayload = {
	messages?: Array<{
		role?: string;
		content?: unknown;
		reasoning_content?: string;
		tool_calls?: unknown[];
	}>;
	tools?: unknown[];
	tool_choice?: unknown;
	thinking?: unknown;
	reasoning_effort?: string;
};

describe("DeepSeek V4 compatibility", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("publishes direct Flash, Pro, and Vision metadata with official limits and effort mappings", () => {
		const effortMaps: Record<string, Record<string, string | null>> = {
			"deepseek-v4-flash": { minimal: null, low: "low", medium: null, high: "high", max: "max" },
			"deepseek-v4-flash-vision-exp": { minimal: null, low: "low", medium: null, high: "high", max: "max" },
			"deepseek-v4-pro": { minimal: null, low: null, medium: null, high: "high", max: "max" },
		};
		for (const [id, thinkingLevelMap] of Object.entries(effortMaps)) {
			const model = getModel("deepseek", id as "deepseek-v4-flash");
			expect(model).toBeDefined();
			expect(model).toMatchObject({
				api: "openai-completions",
				baseUrl: "https://api.deepseek.com",
				reasoning: true,
				contextWindow: 1_000_000,
				maxTokens: 384_000,
				thinkingLevelMap,
				compat: {
					supportsStore: false,
					supportsDeveloperRole: false,
					maxTokensField: "max_tokens",
					requiresReasoningContentOnAssistantMessages: true,
					requiresAssistantContentOnToolCalls: true,
					supportsToolChoiceWithThinking: false,
					thinkingFormat: "deepseek",
				},
			});
		}

		expect(getModel("deepseek", "deepseek-v4-flash")?.input).toEqual(["text"]);
		expect(getModel("deepseek", "deepseek-v4-pro")?.input).toEqual(["text"]);
		expect(getModel("deepseek", "deepseek-v4-flash-vision-exp")?.input).toEqual(["text", "image"]);
	});

	it("replays reasoning for tool and non-tool assistant turns and sends image input", async () => {
		const model = getModel("deepseek", "deepseek-v4-flash-vision-exp")!;
		const toolCallAssistant: AssistantMessage = {
			role: "assistant",
			api: "openai-completions",
			provider: "deepseek",
			model: model.id,
			content: [
				{ type: "thinking", thinking: "inspect the screenshot", thinkingSignature: "reasoning_content" },
				{ type: "toolCall", id: "call_1", name: "inspect", arguments: { target: "form" } },
			],
			usage,
			stopReason: "toolUse",
			timestamp: 2,
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "inspect",
			content: [{ type: "text", text: "form is visible" }],
			isError: false,
			timestamp: 3,
		};
		const finalAssistant: AssistantMessage = {
			role: "assistant",
			api: "openai-completions",
			provider: "deepseek",
			model: model.id,
			content: [
				{ type: "thinking", thinking: "the form can be completed", thinkingSignature: "reasoning_content" },
				{ type: "text", text: "Ready." },
			],
			usage,
			stopReason: "stop",
			timestamp: 4,
		};
		const tools: Tool[] = [
			{
				name: "inspect",
				description: "Inspect a form",
				parameters: Type.Object({ target: Type.String() }),
			},
		];
		let captured: unknown;
		const options: SimpleStreamOptions = {
			apiKey: "test",
			reasoning: "max",
			onPayload: (payload) => {
				captured = payload;
			},
		};

		await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "Inspect this form" },
							{ type: "image", mimeType: "image/png", data: "aGVsbG8=" },
						],
						timestamp: 1,
					},
					toolCallAssistant,
					toolResult,
					finalAssistant,
					{ role: "user", content: "Continue", timestamp: 5 },
				],
				tools,
			},
			options,
		).result();

		const payload = (captured ?? mockState.lastParams) as CapturedPayload;
		const assistantMessages = payload.messages?.filter((message) => message.role === "assistant") ?? [];
		expect(payload.messages?.[0]?.content).toEqual([
			{ type: "text", text: "Inspect this form" },
			{ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
		]);
		expect(assistantMessages[0]).toMatchObject({
			content: "",
			reasoning_content: "inspect the screenshot",
		});
		expect(assistantMessages[0]?.tool_calls).toHaveLength(1);
		expect(assistantMessages[1]).toMatchObject({
			content: "Ready.",
			reasoning_content: "the form can be completed",
		});
		expect(payload.tools).toHaveLength(1);
		expect(payload.thinking).toEqual({ type: "enabled" });
		expect(payload.reasoning_effort).toBe("max");
		expect(payload).not.toHaveProperty("tool_choice");
	});

	it.each(["required", "none"] as const)(
		"preserves max-reasoning tool_choice=%s by disabling thinking in the final payload",
		async (toolChoice) => {
			const model = getModel("deepseek", "deepseek-v4-flash")!;
			let captured: unknown;
			const options: Omit<SimpleStreamOptions, "toolChoice"> & { toolChoice: typeof toolChoice } = {
				apiKey: "test",
				reasoning: "max",
				toolChoice,
				onPayload: (payload) => {
					captured = payload;
				},
			};

			await streamSimple(
				model,
				{
					messages: [{ role: "user", content: "Use the single workflow tool", timestamp: 1 }],
					tools: [
						{
							name: "travel_fill_draft",
							description: "Run the deterministic workflow",
							parameters: Type.Object({}),
						},
					],
				},
				// "required" exceeds the provider-neutral union; it is forwarded
				// verbatim for OpenAI-compatible adapters.
				options as SimpleStreamOptions,
			).result();

			const payload = (captured ?? mockState.lastParams) as CapturedPayload;
			expect(payload.tool_choice).toBe(toolChoice);
			expect(payload.thinking).toEqual({ type: "disabled" });
			expect(payload).not.toHaveProperty("reasoning_effort");
			expect(payload.tools).toHaveLength(1);
		},
	);

	it("keeps tool_choice available when DeepSeek thinking is disabled", async () => {
		const model = getModel("deepseek", "deepseek-v4-flash")!;
		let captured: unknown;
		const options: Omit<SimpleStreamOptions, "toolChoice"> & { toolChoice: "required" } = {
			apiKey: "test",
			toolChoice: "required",
			onPayload: (payload) => {
				captured = payload;
			},
		};

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "Use the tool", timestamp: 1 }],
				tools: [
					{
						name: "inspect",
						description: "Inspect a form",
						parameters: Type.Object({}),
					},
				],
			},
			// Same one-shot "required" widening as the tool-choice policy test above.
			options as unknown as SimpleStreamOptions,
		).result();

		const payload = (captured ?? mockState.lastParams) as CapturedPayload;
		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.tool_choice).toBe("required");
	});
});
