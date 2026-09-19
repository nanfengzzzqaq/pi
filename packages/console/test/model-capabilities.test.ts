import { describe, expect, it } from "vitest";
import { applyServerCapabilities, normalizeCustomModel } from "../src/custom-models.ts";
import { parseDiscoveredModels, parseModelCapabilities } from "../src/model-capabilities.ts";

describe("server model capabilities", () => {
	it("reads vLLM deployment limits and preserves unknown capabilities", () => {
		expect(parseDiscoveredModels({ data: [{ id: "local", max_model_len: 262144 }, { id: "local" }] })).toEqual([
			{ id: "local", contextWindow: 262144 },
		]);
		expect(parseModelCapabilities({ id: "qwen-vision-reasoning-1m" })).toEqual({});
	});
	it("reads explicit limits and positive and negative capabilities from compatible catalogs", () => {
		expect(
			parseModelCapabilities({
				context_length: 200000,
				top_provider: { max_completion_tokens: 32768 },
				architecture: { input_modalities: ["text", "image"] },
				supported_parameters: ["reasoning"],
			}),
		).toEqual({ contextWindow: 200000, maxTokens: 32768, vision: true, reasoning: true });
		expect(parseModelCapabilities({ capabilities: { vision: false, reasoning: false } })).toEqual({
			vision: false,
			reasoning: false,
		});
	});
	it("rejects invalid values and malformed catalogs instead of inventing capacities", () => {
		expect(
			parseModelCapabilities({ max_model_len: "262144", max_output_tokens: -1, vision: "true", reasoning: 1 }),
		).toEqual({});
		expect(parseModelCapabilities({ context_length: Infinity, maxTokens: 4_000_001 })).toEqual({});
		expect(() => parseDiscoveredModels({ models: [] })).toThrow("data 数组");
		expect(parseDiscoveredModels({ data: [{ id: "" }, { id: 12 }, null] })).toEqual([]);
	});
	it("updates an existing alias, clamps output on shrink, preserves unknowns and respects manual mode", () => {
		const original = normalizeCustomModel("pi-console-custom-fixture", {
			name: "Local",
			baseUrl: "http://localhost:8000/v1",
			modelId: "local",
			contextWindow: 131072,
			maxTokens: 16384,
			reasoning: true,
			vision: true,
		});
		const expanded = applyServerCapabilities(original, { id: "local", contextWindow: 262144 });
		expect(expanded).toMatchObject({
			contextWindow: 262144,
			maxTokens: 16384,
			reasoning: true,
			vision: true,
			serverConfig: { contextWindow: 262144 },
		});
		const shrunk = applyServerCapabilities(expanded, {
			id: "local",
			contextWindow: 4096,
			reasoning: false,
			vision: false,
		});
		expect(shrunk).toMatchObject({ contextWindow: 4096, maxTokens: 4096, reasoning: false, vision: false });
		const manual = { ...original, syncMode: "manual" as const };
		expect(applyServerCapabilities(manual, { id: "local", contextWindow: 262144 })).toEqual(manual);
		expect(() => applyServerCapabilities(original, { id: "other", contextWindow: 262144 })).toThrow("不匹配");
	});
});
