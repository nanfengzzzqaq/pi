import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { CodexOAuthCoordinator, type CodexOAuthOperations } from "../src/codex-oauth.ts";

type LoginInteraction = Parameters<ModelRuntime["login"]>[2];

function fakeOperations(): CodexOAuthOperations & { complete(): void; loggedOut: boolean } {
	let connected = false;
	let finish: (() => void) | null = null;
	return {
		loggedOut: false,
		isConnected: () => connected,
		async login(interaction: LoginInteraction) {
			const method = await interaction.prompt({
				type: "select",
				message: "method",
				options: [
					{ id: "browser", label: "Browser" },
					{ id: "device_code", label: "Device" },
				],
			});
			expect(method).toBe("device_code");
			interaction.notify({
				type: "device_code",
				userCode: "ABCD-EFGH",
				verificationUri: "https://auth.openai.com/codex/device",
			});
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
			connected = true;
		},
		async logout() {
			connected = false;
			this.loggedOut = true;
		},
		complete() {
			finish?.();
		},
	};
}

describe("Codex OAuth 协调器", () => {
	it("redacts token-bearing failures and ignores notifications after cancellation", async () => {
		const failure = new CodexOAuthCoordinator({
			isConnected: () => false,
			login: async () => {
				throw new Error("access_token=private-fixture");
			},
			logout: async () => {},
		});
		expect((await failure.start()).error).not.toContain("private-fixture");
		let notify: LoginInteraction["notify"] = () => {};
		let finish = () => {};
		const coordinator = new CodexOAuthCoordinator({
			isConnected: () => false,
			login: async (interaction) => {
				notify = interaction.notify;
				notify({
					type: "device_code",
					userCode: "FIXTURE",
					verificationUri: "https://auth.openai.com/codex/device",
				});
				await new Promise<void>((resolve) => {
					finish = resolve;
				});
			},
			logout: async () => {},
		});
		await coordinator.start();
		coordinator.cancel();
		notify({ type: "device_code", userCode: "STALE", verificationUri: "https://auth.openai.com/codex/device" });
		expect(coordinator.status()).toMatchObject({ phase: "idle", connected: false });
		finish();
		await coordinator.logout();
	});
	it("返回设备码并在认证完成后更新连接状态", async () => {
		const operations = fakeOperations();
		const coordinator = new CodexOAuthCoordinator(operations);
		const waiting = await coordinator.start();
		expect(waiting).toMatchObject({
			phase: "waiting",
			connected: false,
			userCode: "ABCD-EFGH",
			verificationUrl: "https://auth.openai.com/codex/device",
		});

		operations.complete();
		await vi.waitFor(() => expect(coordinator.status().connected).toBe(true));
		expect((await coordinator.logout()).phase).toBe("idle");
		expect(operations.loggedOut).toBe(true);
	});
});
