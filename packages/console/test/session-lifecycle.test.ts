import { describe, expect, it, vi } from "vitest";
import { abortTrackedSessionPrompt, disposeSessionBeforeDelete } from "../src/session-lifecycle.ts";

describe("会话删除生命周期", () => {
	it("删除运行中会话前先中止任务", async () => {
		const abort = vi.fn(async () => undefined);
		const dispose = vi.fn();
		expect(await disposeSessionBeforeDelete({ isStreaming: true, abort, dispose }, null)).toBe(true);
		expect(abort).toHaveBeenCalledOnce();
		expect(dispose).toHaveBeenCalledOnce();
	});

	it("空闲会话无需中止但仍释放资源", async () => {
		const abort = vi.fn(async () => undefined);
		const dispose = vi.fn();
		expect(await disposeSessionBeforeDelete({ isStreaming: false, abort, dispose }, null)).toBe(false);
		expect(abort).not.toHaveBeenCalled();
		expect(dispose).toHaveBeenCalledOnce();
	});

	it("停止按钮只收敛任务，不销毁会话", async () => {
		const abort = vi.fn(async () => undefined);
		const dispose = vi.fn();
		expect(await abortTrackedSessionPrompt({ isStreaming: true, abort, dispose }, null)).toBe(true);
		expect(abort).toHaveBeenCalledOnce();
		expect(dispose).not.toHaveBeenCalled();
	});

	it("等待消息预处理完成后再中止，避免产生孤儿任务", async () => {
		let streaming = false;
		let acceptPrompt: (value: boolean) => void = () => undefined;
		let finishPrompt: () => void = () => undefined;
		const preflight = new Promise<boolean>((resolvePromise) => {
			acceptPrompt = resolvePromise;
		});
		const done = new Promise<void>((resolvePromise) => {
			finishPrompt = resolvePromise;
		});
		const abort = vi.fn(async () => {
			streaming = false;
			finishPrompt();
		});
		const dispose = vi.fn();
		const deleting = disposeSessionBeforeDelete(
			{
				get isStreaming() {
					return streaming;
				},
				abort,
				dispose,
			},
			{ preflight, done },
		);

		expect(abort).not.toHaveBeenCalled();
		streaming = true;
		acceptPrompt(true);
		expect(await deleting).toBe(true);
		expect(abort).toHaveBeenCalledOnce();
		expect(dispose).toHaveBeenCalledOnce();
	});
});
