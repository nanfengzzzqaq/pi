import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";

const temporaryDirectories: string[] = [];

function modelsFile(config: unknown): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-model-budget-config-"));
	temporaryDirectories.push(directory);
	const path = join(directory, "models.json");
	writeFileSync(path, JSON.stringify(config), "utf8");
	return path;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("models.json thinking budget compatibility", () => {
	it("accepts the complete capped Qwen compatibility contract", async () => {
		const config = await ModelConfig.load(
			modelsFile({
				providers: {
					local: {
						models: [
							{
								id: "qwen-local",
								reasoning: true,
								compat: {
									thinkingFormat: "qwen-chat-template",
									thinkingTokenBudgetField: "thinking_token_budget",
									thinkingTokenBudgetCap: 8192,
									chatTemplateKwargs: {
										enable_thinking: { $var: "thinking.enabled" },
										thinking_budget: { $var: "thinking.budget" },
									},
								},
							},
						],
					},
				},
			}),
		);

		expect(config.getError()).toBeUndefined();
		expect(config.getProvider("local")?.models?.[0]?.compat).toMatchObject({
			thinkingTokenBudgetField: "thinking_token_budget",
			thinkingTokenBudgetCap: 8192,
		});
	});
});
