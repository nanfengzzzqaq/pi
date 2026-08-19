import { describe, expect, it, vi } from "vitest";
import type { ProviderConfigInput } from "../src/core/provider-composer.ts";
import {
	DEFAULT_WHITERABBITNEO_BASE_URL,
	DEFAULT_WHITERABBITNEO_MODEL_ID,
	registerDetectedWhiteRabbitNeo,
	WHITERABBITNEO_PROVIDER_ID,
} from "../src/core/whiterabbitneo-provider.ts";

function runtimeStub(existing = false) {
	const registerProvider = vi.fn<(providerId: string, config: ProviderConfigInput) => void>();
	return {
		runtime: {
			getProvider: vi.fn(() => (existing ? ({ id: WHITERABBITNEO_PROVIDER_ID } as never) : undefined)),
			registerProvider,
		},
		registerProvider,
	};
}

describe("WhiteRabbitNeo local provider discovery", () => {
	it("registers the default Ollama model when it is available", async () => {
		const { runtime, registerProvider } = runtimeStub();
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({ data: [{ id: DEFAULT_WHITERABBITNEO_MODEL_ID }] }),
		);

		await expect(registerDetectedWhiteRabbitNeo(runtime, { env: {}, fetch })).resolves.toBe(true);

		expect(fetch).toHaveBeenCalledWith(
			`${DEFAULT_WHITERABBITNEO_BASE_URL}/models`,
			expect.objectContaining({ headers: { Authorization: "Bearer ollama" } }),
		);
		expect(registerProvider).toHaveBeenCalledWith(
			WHITERABBITNEO_PROVIDER_ID,
			expect.objectContaining({
				baseUrl: DEFAULT_WHITERABBITNEO_BASE_URL,
				api: "openai-completions",
				models: [expect.objectContaining({ id: DEFAULT_WHITERABBITNEO_MODEL_ID, contextWindow: 32_768 })],
			}),
		);
	});

	it("supports custom OpenAI-compatible endpoints and model IDs", async () => {
		const { runtime, registerProvider } = runtimeStub();
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({ data: [{ id: "custom-white-rabbit" }] }),
		);

		await expect(
			registerDetectedWhiteRabbitNeo(runtime, {
				env: {
					WHITERABBITNEO_API_KEY: "secret",
					WHITERABBITNEO_BASE_URL: "http://127.0.0.1:1234/v1/",
					WHITERABBITNEO_MODEL_ID: "custom-white-rabbit",
				},
				fetch,
			}),
		).resolves.toBe(true);

		expect(fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:1234/v1/models",
			expect.objectContaining({ headers: { Authorization: "Bearer secret" } }),
		);
		expect(registerProvider).toHaveBeenCalledWith(
			WHITERABBITNEO_PROVIDER_ID,
			expect.objectContaining({ baseUrl: "http://127.0.0.1:1234/v1", apiKey: "secret" }),
		);
	});

	it("does not register when the model is absent or the provider already exists", async () => {
		const missing = runtimeStub();
		const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ data: [{ id: "another-model" }] }));
		await expect(registerDetectedWhiteRabbitNeo(missing.runtime, { env: {}, fetch })).resolves.toBe(false);
		expect(missing.registerProvider).not.toHaveBeenCalled();

		const existing = runtimeStub(true);
		await expect(registerDetectedWhiteRabbitNeo(existing.runtime, { env: {}, fetch })).resolves.toBe(false);
		expect(existing.registerProvider).not.toHaveBeenCalled();
	});
});
