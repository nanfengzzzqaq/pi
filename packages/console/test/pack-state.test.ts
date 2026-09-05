import { describe, expect, it, vi } from "vitest";

const writes = vi.hoisted(() => vi.fn());
vi.mock("../src/durable-json.ts", () => ({
	readDurableJson: () => [],
	writeDurableJson: writes,
	atomicFileWrite: vi.fn(),
}));

import { loadPacks, mountedPacks, mountPack, unmountPack } from "../src/packs.ts";

describe("capability state transaction", () => {
	it("commits memory only after persistence for mount and unmount", async () => {
		await loadPacks();
		writes.mockImplementationOnce(() => {
			throw new Error("FAKE_ENOSPC");
		});
		expect(() => mountPack("office-assistant")).toThrow("FAKE_ENOSPC");
		expect(mountedPacks()).not.toContain("office-assistant");
		expect(mountPack("office-assistant")).toBe(true);
		writes.mockImplementationOnce(() => {
			throw new Error("FAKE_PERMISSION_DENIED");
		});
		expect(() => unmountPack("office-assistant")).toThrow("FAKE_PERMISSION_DENIED");
		expect(mountedPacks()).toContain("office-assistant");
	});
});
