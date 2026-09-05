import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AntigravityOAuthCoordinator, type AntigravityOAuthOperations } from "../src/antigravity-oauth.ts";

type Interaction = Parameters<ModelRuntime["login"]>[2];
const active: AntigravityOAuthCoordinator[] = [];
afterEach(async () => {
	for (const coordinator of active.splice(0)) await coordinator.stop();
	vi.useRealTimers();
});

function setup(login: (interaction: Interaction) => Promise<void>, options: Partial<AntigravityOAuthOperations> = {}) {
	let connected = false;
	const operations = {
		isAvailable: () => true,
		isConnected: () => connected,
		login: vi.fn(async (interaction: Interaction) => {
			await login(interaction);
			connected = true;
		}),
		logout: vi.fn(async () => {
			connected = false;
		}),
		...options,
	};
	const coordinator = new AntigravityOAuthCoordinator(operations);
	active.push(coordinator);
	return { coordinator, operations };
}

describe("Antigravity OAuth", () => {
	it("supports manual callback retries, rejects stale input, and never returns the callback", async () => {
		const { coordinator, operations } = setup(async (interaction) => {
			interaction.notify({ type: "auth_url", url: "https://accounts.google.com/o/oauth2/v2/auth?state=test" });
			expect(await interaction.prompt({ type: "text", message: "Callback" })).toBe("invalid");
			expect(await interaction.prompt({ type: "text", message: "Try again" })).toBe(
				"http://localhost:51121/oauth-callback?code=test-secret&state=test",
			);
		});
		const first = await coordinator.start();
		expect(first).toMatchObject({ phase: "waiting", connected: false, promptId: expect.any(String) });
		await coordinator.start();
		expect(operations.login).toHaveBeenCalledTimes(1);
		expect(() => coordinator.respond(first.promptId, "")).toThrow("完整回调地址");
		coordinator.respond(first.promptId, "invalid");
		await vi.waitFor(() => expect(coordinator.status().promptId).toBeTruthy());
		expect(coordinator.status().promptId).not.toBe(first.promptId);
		expect(() => coordinator.respond(first.promptId, "stale")).toThrow("过期");
		coordinator.respond(
			coordinator.status().promptId,
			"http://localhost:51121/oauth-callback?code=test-secret&state=test",
		);
		await vi.waitFor(() => expect(coordinator.status().connected).toBe(true));
		expect(JSON.stringify(coordinator.status())).not.toMatch(/test-secret|verificationUrl|promptId/);
		expect((await coordinator.logout()).connected).toBe(false);
		expect(operations.logout).toHaveBeenCalledTimes(1);
	});

	it("cleans up an outstanding prompt when the browser callback wins", async () => {
		let complete = () => {};
		let promptFinished = false;
		const { coordinator } = setup(async (interaction) => {
			const manual = interaction.prompt({ type: "text", message: "Callback" }).finally(() => {
				promptFinished = true;
			});
			await Promise.race([
				manual,
				new Promise<void>((resolve) => {
					complete = resolve;
				}),
			]);
		});
		await coordinator.start();
		complete();
		await vi.waitFor(() => expect(coordinator.status().connected).toBe(true));
		expect(promptFinished).toBe(true);
	});

	it("cancels a pending login and allows a fresh attempt without deleting stored accounts", async () => {
		const { coordinator, operations } = setup(async (interaction) => {
			await interaction.prompt({ type: "manual_code", message: "Callback" });
		});
		const first = await coordinator.start();
		expect((await coordinator.stop()).phase).toBe("idle");
		expect(operations.logout).not.toHaveBeenCalled();
		expect((await coordinator.start()).promptId).not.toBe(first.promptId);
	});

	it("expires abandoned logins", async () => {
		vi.useFakeTimers();
		const { coordinator } = setup(async (interaction) => {
			await interaction.prompt({ type: "text", message: "Callback" });
		});
		await coordinator.start();
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(coordinator.status()).toMatchObject({ phase: "error", error: expect.stringContaining("超时") });
	});

	it("does not expose provider errors containing secrets", async () => {
		const { coordinator } = setup(async () => {
			throw new Error("access_token=secret-refresh-token&code=secret-code");
		});
		expect(await coordinator.start()).toMatchObject({ phase: "error" });
		expect(JSON.stringify(coordinator.status())).not.toContain("secret");
	});

	it("rejects non-Google authorization URLs and reports missing modules", async () => {
		const { coordinator } = setup(async (interaction) => {
			interaction.notify({ type: "auth_url", url: "https://example.test/login" });
		});
		expect((await coordinator.start()).phase).toBe("error");
		const missing = setup(async () => {}, { isAvailable: () => false });
		expect((await missing.coordinator.start()).available).toBe(false);
		expect(missing.operations.login).not.toHaveBeenCalled();
	});
});
