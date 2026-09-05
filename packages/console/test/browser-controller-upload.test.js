import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { AgentBrowserController } from "./browser-controller-fixture.js";

function fakeWebContents(getUrl) {
	const contents = new EventEmitter();
	contents.getURL = getUrl;
	contents.getTitle = () => "Fixture";
	contents.isLoading = () => false;
	contents.isDestroyed = () => false;
	contents.navigationHistory = {
		canGoBack: () => false,
		canGoForward: () => false,
	};
	contents.executeJavaScriptInIsolatedWorld = vi.fn(async () => ({ ok: true }));
	return contents;
}

describe("AgentBrowserController upload origin lock", () => {
	it("rejects a cross-origin redirect before attachment bytes reach the isolated page", async () => {
		let currentUrl = "https://portal.example.com/web/app.html#/home";
		const webContents = fakeWebContents(() => currentUrl);
		const controller = Object.create(AgentBrowserController.prototype);
		controller.status = "浏览器已准备";
		controller.view = { webContents };
		controller.open = async () => controller.state();
		controller.emitState = () => controller.state();

		// The caller locks the legitimate origin before reading its local file.
		const allowedOrigin = new URL(controller.state().url).origin;
		// A redirect wins the race before uploadFiles captures WebContents.getURL().
		currentUrl = "https://attacker.invalid/collect";

		await expect(
			controller.uploadFiles(
				[{ name: "report.pdf", mimeType: "application/pdf", dataBase64: "U0VOU0lUSVZFLUJZVEVT" }],
				undefined,
				allowedOrigin,
			),
		).rejects.toThrow("当前页面来源与调用方锁定来源不一致");
		expect(webContents.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
	});
});
