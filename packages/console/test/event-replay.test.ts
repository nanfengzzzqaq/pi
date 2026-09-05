import { describe, expect, it } from "vitest";
import { needsEventResync } from "../src/event-replay.ts";

describe("会话事件恢复", () => {
	it("新会话没有事件时直接连接", () => {
		expect(needsEventResync(-1, 0, undefined, "epoch-a", null)).toBe(false);
		expect(needsEventResync(-1, 0, undefined, "epoch-a", "epoch-a")).toBe(false);
	});

	it("同一轮会话的有效游标和首次完整缓冲可以补发", () => {
		expect(needsEventResync(-1, 4, 0, "epoch-a", null)).toBe(false);
		expect(needsEventResync(1, 4, 0, "epoch-a", "epoch-a")).toBe(false);
		expect(needsEventResync(3, 4, 0, "epoch-a", "epoch-a")).toBe(false);
	});

	it("游标恰好在保留缓冲前一个事件时可以完整补发", () => {
		expect(needsEventResync(99, 600, 100, "epoch-a", "epoch-a")).toBe(false);
		expect(needsEventResync(98, 600, 100, "epoch-a", "epoch-a")).toBe(true);
		expect(needsEventResync(-1, 600, 100, "epoch-a", null)).toBe(true);
	});

	it("后端恢复后即使序号已追平，也必须按 epoch 重建历史", () => {
		expect(needsEventResync(5, 20, 0, "epoch-new", "epoch-old")).toBe(true);
		expect(needsEventResync(-1, 0, undefined, "epoch-new", "epoch-old")).toBe(true);
	});

	it("客户端游标超出服务端范围时重建历史，避免等待序号追平", () => {
		expect(needsEventResync(5, 5, 0, "epoch-a", null)).toBe(true);
		expect(needsEventResync(100, 0, undefined, "epoch-a", null)).toBe(true);
	});

	it.each([-2, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
		"拒绝无效事件游标 %s",
		(since) => expect(needsEventResync(since, 10, 0, "epoch-a", "epoch-a")).toBe(true),
	);

	it("跳过未保留的瞬时进度事件不会让已追平的客户端反复重建", () => {
		expect(needsEventResync(9, 10, undefined, "epoch-a", "epoch-a")).toBe(false);
	});
});
