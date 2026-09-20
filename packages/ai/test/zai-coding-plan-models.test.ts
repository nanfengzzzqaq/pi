import { expect, it } from "vitest";
import { getBuiltinModel } from "../src/providers/all.ts";

it("exposes GLM-4.6V on the China Coding Plan catalog", () => {
	const model = getBuiltinModel("zai-coding-cn", "glm-4.6v");

	expect(model).toMatchObject({
		id: "glm-4.6v",
		provider: "zai-coding-cn",
		api: "openai-completions",
		baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.3, output: 0.9, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 32768,
		compat: {
			maxTokensField: "max_tokens",
			thinkingFormat: "zai",
			zaiToolStream: true,
		},
	});
});

it("uses API-equivalent reference costs for Coding Plan models", () => {
	expect(getBuiltinModel("zai", "glm-5.2").cost).toEqual({
		input: 1.4,
		output: 4.4,
		cacheRead: 0.26,
		cacheWrite: 0,
	});
	// The generated catalog refreshes Flash pricing at build time. Both Coding
	// Plan regions must retain the same nonzero reference cost after a refresh.
	const flashCost = getBuiltinModel("zai", "glm-5.3-flash").cost;
	expect(flashCost.input).toBeGreaterThan(0);
	expect(flashCost.output).toBeGreaterThan(0);
	expect(flashCost.cacheRead).toBeGreaterThan(0);
	expect(flashCost.cacheWrite).toBe(0);
	expect(getBuiltinModel("zai-coding-cn", "glm-5.3-flash").cost).toEqual(flashCost);
	for (const provider of ["zai", "zai-coding-cn"] as const) {
		expect(getBuiltinModel(provider, "glm-5.3").cost).toEqual({
			input: 1.4,
			output: 4.4,
			cacheRead: 0.26,
			cacheWrite: 0,
		});
	}
});

it("keeps zero costs for Coding Plan models without a matching API price", () => {
	const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

	for (const provider of ["zai", "zai-coding-cn"] as const) {
		expect(getBuiltinModel(provider, "glm-5.3-highspeed").cost).toEqual(zeroCost);
	}
});
