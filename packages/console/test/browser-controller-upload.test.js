import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	WebContentsView: class {},
	session: {
		fromPartition: () => ({ on: () => {} }),
	},
}));

import { AgentBrowserController } from "../installer/electron/browser-controller.js";

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
		let currentUrl = "https://app.ekuaibao.com/web/app.html#/bill";
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
				[{ name: "ticket.pdf", mimeType: "application/pdf", dataBase64: "U0VOU0lUSVZFLUJZVEVT" }],
				undefined,
				allowedOrigin,
			),
		).rejects.toThrow("当前页面来源与调用方锁定来源不一致");
		expect(webContents.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
	});

	it("revalidates the trusted page token and DOM digest after transferring bytes but before file injection", async () => {
		const url = "https://app.ekuaibao.com/web/app.html#/billEntryDetail";
		const webContents = fakeWebContents(() => url);
		const controller = Object.create(AgentBrowserController.prototype);
		controller.status = "浏览器已准备";
		controller.view = { webContents };
		controller.open = async () => controller.state();
		controller.emitState = () => controller.state();
		controller.trustedEkuaibaoPageToken = "11111111-1111-4111-8111-111111111111";
		const trustedState = {
			pageToken: controller.trustedEkuaibaoPageToken,
			digest: "a".repeat(64),
			multipleRecipients: { present: true, checked: false, source: "native-input" },
		};
		controller.inspectTrustedEkuaibaoPage = vi
			.fn()
			.mockResolvedValueOnce(trustedState)
			.mockResolvedValueOnce({ ...trustedState, digest: "b".repeat(64) });

		await expect(
			controller.uploadFiles(
				[{ name: "ticket.pdf", mimeType: "application/pdf", dataBase64: "U0VOU0lUSVZFLUJZVEVT" }],
				{ text: "上传文件", scopeTexts: ["智能识票", "上传文件"] },
				new URL(url).origin,
				{
					trustedEkuaibao: true,
					pageToken: trustedState.pageToken,
					expectedDigest: trustedState.digest,
				},
			),
		).rejects.toThrow("页面结构或字段值已变化");
		expect(controller.inspectTrustedEkuaibaoPage).toHaveBeenCalledTimes(2);
		const scripts = webContents.executeJavaScriptInIsolatedWorld.mock.calls.map(([_, entries]) =>
			String(entries?.[0]?.code || ""),
		);
		expect(scripts.some((script) => script.includes("new ownerWindow.DataTransfer"))).toBe(false);
	});

	it("binds trusted bytes, DOM digest and the unique file input to one isolated upload token", async () => {
		const url = "https://app.ekuaibao.com/web/app.html#/billEntryDetail";
		const webContents = fakeWebContents(() => url);
		const controller = Object.create(AgentBrowserController.prototype);
		controller.status = "浏览器已准备";
		controller.view = { webContents };
		controller.open = async () => controller.state();
		controller.emitState = () => controller.state();
		controller.trustedEkuaibaoPageToken = "22222222-2222-4222-8222-222222222222";
		const trustedState = {
			pageToken: controller.trustedEkuaibaoPageToken,
			digest: "c".repeat(64),
			multipleRecipients: { present: true, checked: false, source: "native-input" },
		};
		controller.inspectTrustedEkuaibaoPage = vi.fn(async () => trustedState);

		await controller.uploadFiles(
			[{ name: "ticket.pdf", mimeType: "application/pdf", dataBase64: "UERG" }],
			{ text: "上传文件", scopeTexts: ["智能识票", "上传文件"] },
			new URL(url).origin,
			{
				trustedEkuaibao: true,
				pageToken: trustedState.pageToken,
				expectedDigest: trustedState.digest,
			},
		);

		expect(controller.inspectTrustedEkuaibaoPage).toHaveBeenCalledTimes(2);
		const scripts = webContents.executeJavaScriptInIsolatedWorld.mock.calls.map(([_, entries]) =>
			String(entries?.[0]?.code || ""),
		);
		const injection = scripts.find((script) => script.includes("new ownerWindow.DataTransfer"));
		expect(injection).toBeTruthy();
		expect(injection).toContain("session.trustedGuard?.expectedDigest");
		expect(injection).toContain("同一最近边界内的唯一 file input");
		expect(injection).toContain("data-pi-trusted-upload-token");
		expect(injection).toContain("已拒绝默认选择第一个");
		expect(() => new Function(String(injection))).not.toThrow();
	});
});
