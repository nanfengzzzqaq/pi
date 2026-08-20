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
				verificationUri: "https://example.test/device",
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
	it("返回设备码并在认证完成后更新连接状态", async () => {
		const operations = fakeOperations();
		const coordinator = new CodexOAuthCoordinator(operations);
		const waiting = await coordinator.start();
		expect(waiting).toMatchObject({
			phase: "waiting",
			connected: false,
			userCode: "ABCD-EFGH",
			verificationUrl: "https://example.test/device",
		});

		operations.complete();
		await vi.waitFor(() => expect(coordinator.status().connected).toBe(true));
		expect((await coordinator.logout()).phase).toBe("idle");
		expect(operations.loggedOut).toBe(true);
	});
});
