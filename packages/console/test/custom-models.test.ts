import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createCustomProviderId,
	discoverOpenAIModels,
	loadCustomModels,
	normalizeCustomModel,
	removeCustomModel,
	saveCustomModel,
	toProviderConfig,
} from "../src/custom-models.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function temporaryFile(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-console-custom-models-"));
	temporaryDirectories.push(directory);
	return join(directory, "custom-models.json");
}

describe("custom model configuration", () => {
	it("normalizes and persists one OpenAI-compatible model without an API key", () => {
		const file = temporaryFile();
		const providerId = createCustomProviderId("ABCD-1234");
		const definition = normalizeCustomModel(providerId, {
			name: " Local Qwen ",
			baseUrl: "https://ai.example.com/v1/",
			modelId: "qwen-local",
			contextWindow: "131072",
			maxTokens: 16384,
			vision: true,
			reasoning: true,
		});

		saveCustomModel(file, definition);

		expect(loadCustomModels(file)).toEqual([
			{
				providerId: "pi-console-custom-abcd1234",
				name: "Local Qwen",
				baseUrl: "https://ai.example.com/v1",
				modelId: "qwen-local",
				contextWindow: 131072,
				maxTokens: 16384,
				vision: true,
				reasoning: true,
			},
		]);
		expect(readFileSync(file, "utf8")).not.toContain("apiKey");
	});

	it("builds a Chat Completions provider with the enabled Qwen reasoning levels", () => {
		const definition = normalizeCustomModel(createCustomProviderId("model-1"), {
			name: "Local",
			baseUrl: "http://127.0.0.1:8000/v1",
			modelId: "qwen",
			reasoning: true,
		});

		expect(toProviderConfig(definition)).toMatchObject({
			api: "openai-completions",
			compat: {
				supportsDeveloperRole: false,
				supportsReasoningEffort: true,
				supportsOpenAIGrammarTools: false,
			},
			models: [
				{
					id: "qwen",
					reasoning: true,
					thinkingLevelMap: {
						off: null,
						minimal: null,
						low: "low",
						medium: "medium",
						high: null,
						xhigh: "xhigh",
						max: null,
					},
					input: ["text"],
					contextWindow: 128000,
					maxTokens: 16384,
				},
			],
		});
	});

	it("loads version 1 definitions with reasoning disabled until the user opts in", () => {
		const file = temporaryFile();
		writeFileSync(
			file,
			JSON.stringify({
				version: 1,
				models: [
					{
						providerId: createCustomProviderId("legacy"),
						name: "Legacy",
						baseUrl: "http://localhost:8000/v1",
						modelId: "qwen",
						contextWindow: 128000,
						maxTokens: 16384,
						vision: false,
					},
				],
			}),
			"utf8",
		);

		expect(loadCustomModels(file)[0]?.reasoning).toBe(false);
	});

	it("updates and removes only the selected custom provider", () => {
		const file = temporaryFile();
		const first = normalizeCustomModel(createCustomProviderId("first"), {
			name: "First",
			baseUrl: "http://localhost:8000/v1",
			modelId: "one",
		});
		const second = normalizeCustomModel(createCustomProviderId("second"), {
			name: "Second",
			baseUrl: "http://localhost:9000/v1",
			modelId: "two",
		});
		saveCustomModel(file, first);
		saveCustomModel(file, second);
		saveCustomModel(file, { ...first, modelId: "one-new" });

		expect(loadCustomModels(file).map((entry) => entry.modelId)).toEqual(["one-new", "two"]);
		expect(removeCustomModel(file, first.providerId)).toBe(true);
		expect(removeCustomModel(file, first.providerId)).toBe(false);
		expect(loadCustomModels(file)).toEqual([second]);
	});

	it("discovers and deduplicates model IDs from an OpenAI models endpoint", async () => {
		let requestedUrl = "";
		let authorization = "";
		const models = await discoverOpenAIModels("https://ai.example.com/v1/", "secret", {
			fetch: async (input, init) => {
				requestedUrl = String(input);
				authorization = new Headers(init?.headers).get("authorization") ?? "";
				return Response.json({ data: [{ id: "qwen-b" }, { id: "qwen-a" }, { id: "qwen-b" }] });
			},
		});

		expect(requestedUrl).toBe("https://ai.example.com/v1/models");
		expect(authorization).toBe("Bearer secret");
		expect(models).toEqual(["qwen-a", "qwen-b"]);
	});

	it("rejects invalid limits and unsupported URL schemes", () => {
		const providerId = createCustomProviderId("invalid");
		expect(() =>
			normalizeCustomModel(providerId, {
				name: "Bad",
				baseUrl: "file:///tmp/model",
				modelId: "bad",
			}),
		).toThrow("只支持 http 或 https");
		expect(() =>
			normalizeCustomModel(providerId, {
				name: "Bad",
				baseUrl: "http://localhost:8000/v1",
				modelId: "bad",
				contextWindow: 1024,
				maxTokens: 2048,
			}),
		).toThrow("不能超过上下文长度");
	});
});
