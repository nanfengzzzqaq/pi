import { describe, expect, it, vi } from "vitest";
import { InstallCompletion } from "../src/install-completion.ts";

describe("installation activation", () => {
	it("stays busy after the download until activation settles, and catches disk failures", async () => {
		const completion = new InstallCompletion();
		let fail = (_error: Error) => {};
		const activation = new Promise<void>((_resolve, reject) => {
			fail = reject;
		});
		const base = { running: false, error: null, phase: "complete" };
		completion.start(
			"fixture",
			() => base,
			() => activation,
		);
		expect(completion.busy).toBe(true);
		expect(completion.progress("fixture", base)).toMatchObject({ running: true, phase: "activating" });
		fail(new Error("disk failure with private path"));
		await vi.waitFor(() => expect(completion.busy).toBe(false));
		expect(completion.progress("fixture", base)).toMatchObject({
			running: false,
			phase: "failed",
			error: expect.stringContaining("启用未完成"),
		});
		expect(completion.progress("fixture", base).error).not.toContain("private path");
	});
});
