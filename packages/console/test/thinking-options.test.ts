import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { applyServerCapabilities, normalizeCustomModel, toProviderConfig } from "../src/custom-models.ts";
import { parseModelCapabilities } from "../src/model-capabilities.ts";
import { sessionThinkingOptions } from "../src/thinking-options.ts";

function definition(modelId = "local", efforts?: string[]) {
	return normalizeCustomModel("pi-console-custom-fixture", {
		name: "Fixture",
		modelId,
		baseUrl: "http://127.0.0.1:9/v1",
		reasoning: true,
		reasoningEfforts: efforts,
	});
}
function modelFrom(config = definition()): Model<"openai-completions"> {
	return {
		...toProviderConfig(config).models[0],
		api: "openai-completions",
		provider: config.providerId,
		baseUrl: config.baseUrl,
	};
}
function state(model: Model<"openai-completions">, level: AgentSession["thinkingLevel"] = "max") {
	return {
		model,
		thinkingLevel: level,
		getAvailableThinkingLevels: () => getSupportedThinkingLevels(model),
		setThinkingLevel(next: AgentSession["thinkingLevel"]) {
			this.thinkingLevel = next;
		},
	};
}
async function payload(model: Model<"openai-completions">, level: AgentSession["thinkingLevel"]) {
	let captured: Record<string, unknown> | undefined;
	await streamSimple(
		model,
		{ messages: [{ role: "user", content: "fixture", timestamp: 1 }] },
		{
			apiKey: "fixture-unused",
			reasoning: level === "off" ? undefined : level,
			onPayload(value) {
				captured = value as Record<string, unknown>;
				throw new Error("Captured before networking");
			},
		},
	).result();
	if (!captured) throw new Error("Payload was not captured");
	return captured;
}
describe("model-backed reasoning choices", () => {
	it("advertises and sends xhigh, never max, when that is the upstream maximum", async () => {
		const capabilities = parseModelCapabilities({ supported_reasoning_efforts: ["low", "xhigh"] });
		const model = modelFrom(applyServerCapabilities(definition(), { id: "local", ...capabilities }));
		const session = state(model);
		expect(sessionThinkingOptions(session)).toMatchObject({
			thinkingLevel: "xhigh",
			availableThinkingLevels: ["low", "xhigh"],
			thinkingChoices: [
				{ value: "low", label: "low" },
				{ value: "xhigh", label: "xhigh · 最高" },
			],
		});
		expect((await payload(model, session.thinkingLevel)).reasoning_effort).toBe("xhigh");
	});
	it("removes aliases for the same wire effort and clamps stale saved values", () => {
		const model = modelFrom(definition("local", ["high", "xhigh"]));
		model.thinkingLevelMap = { ...model.thinkingLevelMap, max: "xhigh" };
		expect(sessionThinkingOptions(state(model))).toMatchObject({
			thinkingLevel: "xhigh",
			availableThinkingLevels: ["high", "xhigh"],
		});
	});
	it("does not invent levels for unknown services or claim a binary Qwen switch is max", async () => {
		const unknown = modelFrom();
		expect(sessionThinkingOptions(state(unknown))).toMatchObject({
			thinkingLevel: "off",
			thinkingChoices: [{ value: "off", label: "服务端默认" }],
		});
		expect(await payload(unknown, "off")).not.toHaveProperty("reasoning_effort");
		const qwen = modelFrom(definition("qwen3.8"));
		expect(sessionThinkingOptions(state(qwen))).toMatchObject({
			availableThinkingLevels: ["off", "high"],
			thinkingChoices: [
				{ value: "off", label: "关闭思考" },
				{ value: "high", label: "开启思考" },
			],
		});
		expect(await payload(qwen, "high")).toMatchObject({ chat_template_kwargs: { enable_thinking: true } });
		expect(await payload(qwen, "off")).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
	});
	it("updates shrinking and removed capability lists while respecting manual overrides", () => {
		const initial = applyServerCapabilities(definition(), {
			id: "local",
			reasoningEfforts: ["high", "xhigh", "max"],
		});
		const shrunk = applyServerCapabilities(initial, { id: "local", reasoningEfforts: ["high"] });
		expect(sessionThinkingOptions(state(modelFrom(shrunk))).availableThinkingLevels).toEqual(["high"]);
		const removed = applyServerCapabilities(shrunk, { id: "local" });
		expect(sessionThinkingOptions(state(modelFrom(removed))).thinkingChoices[0].label).toBe("服务端默认");
		const manual = { ...initial, syncMode: "manual" as const };
		expect(applyServerCapabilities(manual, { id: "local", reasoningEfforts: ["low"] })).toEqual(manual);
		expect(parseModelCapabilities({ reasoning_efforts: ["ultra"] })).toEqual({});
		expect(() => definition("local", ["invented"])).toThrow("推理档位");
	});
});
