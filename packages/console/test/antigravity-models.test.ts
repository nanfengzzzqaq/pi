import { describe, expect, it, vi } from "vitest";
import { createAntigravityModelRefresher } from "../src/bundled-providers.ts";

describe("Antigravity catalog refresh", () => {
	it("requires Google login and coalesces overlapping account-only refreshes", async () => {
		let complete = () => {};
		const gate = new Promise<void>((resolve) => {
			complete = resolve;
		});
		const runtime = {
			isUsingOAuth: vi.fn(() => false),
			getModels: vi.fn(() => []),
			refresh: vi.fn(async () => {
				await gate;
				return { aborted: false, errors: new Map<string, Error>() };
			}),
		};
		const refresh = createAntigravityModelRefresher(runtime);
		await expect(refresh()).rejects.toThrow("请先登录");
		expect(runtime.refresh).not.toHaveBeenCalled();
		runtime.isUsingOAuth.mockReturnValue(true);
		const first = refresh();
		const second = refresh();
		expect(runtime.refresh).toHaveBeenCalledTimes(1);
		expect(runtime.refresh).toHaveBeenCalledWith({
			providers: ["antigravity"],
			allowNetwork: true,
			force: true,
			signal: expect.any(AbortSignal),
		});
		complete();
		await Promise.all([first, second]);
		await refresh();
		expect(runtime.refresh).toHaveBeenCalledTimes(2);
		expect(runtime.getModels).toHaveBeenCalledWith("antigravity");
	});

	it("redacts credential errors and permits retry after a failed refresh", async () => {
		const runtime = {
			isUsingOAuth: () => true,
			getModels: () => [],
			refresh: vi.fn(async () => ({ aborted: false, errors: new Map<string, Error>() })),
		};
		runtime.refresh.mockRejectedValueOnce(new Error("refresh_token=secret"));
		const refresh = createAntigravityModelRefresher(runtime);
		await expect(refresh()).rejects.toThrow("模型目录刷新未完成");
		await expect(refresh()).resolves.toBe(0);
		runtime.refresh.mockResolvedValueOnce({
			aborted: false,
			errors: new Map([["antigravity", new Error("access_token=secret")]]),
		});
		await expect(refresh()).rejects.not.toThrow("secret");
		runtime.refresh.mockResolvedValueOnce({ aborted: true, errors: new Map<string, Error>() });
		await expect(refresh()).rejects.toThrow("模型目录刷新未完成");
	});
});
