import { afterEach, describe, expect, it, vi } from "vitest";
import { setupAntigravityLogin } from "../web/antigravity-login.js";

const cleanups = [];
function fixture(api) {
	const elements = new Map();
	let notify;
	vi.stubGlobal("MutationObserver", class {
		constructor(callback) { notify = callback; }
		observe() {}
		disconnect() {}
	});
	const document = { getElementById(id) {
		if (!elements.has(id)) elements.set(id, { hidden: false, value: "", textContent: "", listeners: {}, addEventListener(event, fn) { this.listeners[event] = fn; } });
		return elements.get(id);
	} };
	const loadModels = vi.fn(async () => {});
	cleanups.push(setupAntigravityLogin({ document, api, loadModels, openExternalUrl: async () => {} }));
	return { get: id => document.getElementById(`antigravity-${id}`), notify: () => notify(), loadModels };
}
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.unstubAllGlobals(); });

describe("Antigravity login directory status", () => {
	it("keeps the existing catalog usable and distinguishes a fallback from account discovery after refresh failure", async () => {
		const api = vi.fn(async path => {
			if (path.endsWith("/models/refresh")) throw new Error("network unavailable");
			return { phase: "idle", connected: true, available: true, catalog: { source: "fallback", refreshStatus: "failed" } };
		});
		const app = fixture(api);
		await vi.waitFor(() => expect(app.get("model-status").textContent).toContain("已有目录保留"));
		expect(app.get("model-status").textContent).toContain("内置备用目录");
		expect(app.get("model-status").textContent).toContain("账号权限和额度");
		expect(app.get("refresh-models").disabled).toBe(false);
		expect(app.loadModels).toHaveBeenCalledOnce();
	});
	it("never restores a connected state from a model refresh that finishes after logout", async () => {
		let finishRefresh;
		const app = fixture(async (path, options) => {
			if (options?.method === "DELETE") return { phase: "idle", connected: false, available: true };
			if (path.endsWith("/models/refresh")) return new Promise(resolve => { finishRefresh = resolve; });
			return { phase: "idle", connected: true, available: true, catalog: { source: "cache", refreshStatus: "idle" } };
		});
		await vi.waitFor(() => expect(typeof finishRefresh).toBe("function"));
		app.get("logout").listeners.click();
		await vi.waitFor(() => expect(app.get("login").hidden).toBe(false));
		finishRefresh({ count: 4 });
		await Promise.resolve();
		expect(app.get("model-status").hidden).toBe(true);
		expect(app.get("logout").hidden).toBe(true);
	});
	it("coalesces repeated settings visibility checks while a status request is pending", async () => {
		let finish;
		const api = vi.fn(() => new Promise(resolve => { finish = resolve; }));
		const app = fixture(api);
		app.notify(); app.notify();
		expect(api).toHaveBeenCalledOnce();
		finish({ phase: "idle", connected: false, available: true });
		await Promise.resolve();
		await Promise.resolve();
		app.notify();
		expect(api).toHaveBeenCalledTimes(2);
		finish({ phase: "idle", connected: false, available: true });
	});
});
