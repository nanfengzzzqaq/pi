import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_WHITERABBITNEO_BASE_URL,
	DEFAULT_WHITERABBITNEO_MODEL_ID,
	registerDetectedWhiteRabbitNeo,
} from "../src/whiterabbitneo.ts";

describe("registerDetectedWhiteRabbitNeo", () => {
	it("registers the detected local Ollama model", async () => {
		const runtime = {
			getProvider: vi.fn(() => undefined),
			registerProvider: vi.fn(),
		};
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ data: [{ id: DEFAULT_WHITERABBITNEO_MODEL_ID }] }), { status: 200 }),
			);

		expect(await registerDetectedWhiteRabbitNeo(runtime, { env: {}, fetch: fetchMock })).toBe(true);
		expect(fetchMock).toHaveBeenCalledWith(
			`${DEFAULT_WHITERABBITNEO_BASE_URL}/models`,
			expect.objectContaining({ headers: { Authorization: "Bearer ollama" } }),
		);
		expect(runtime.registerProvider).toHaveBeenCalledWith(
			"whiterabbitneo",
			expect.objectContaining({
				baseUrl: DEFAULT_WHITERABBITNEO_BASE_URL,
				models: [expect.objectContaining({ id: DEFAULT_WHITERABBITNEO_MODEL_ID })],
			}),
		);
	});

	it("does not register when the expected model is absent", async () => {
		const runtime = {
			getProvider: vi.fn(() => undefined),
			registerProvider: vi.fn(),
		};
		const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));

		expect(await registerDetectedWhiteRabbitNeo(runtime, { env: {}, fetch: fetchMock })).toBe(false);
		expect(runtime.registerProvider).not.toHaveBeenCalled();
	});
});
