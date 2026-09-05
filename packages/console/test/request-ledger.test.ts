import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RequestLedger } from "../src/request-ledger.ts";

const directories: string[] = [];
function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "pi-request-ledger-"));
	directories.push(directory);
	return { directory, ledger: new RequestLedger(directory, "first-process") };
}
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("durable message receipts", () => {
	it("retries reuse a receipt without persisting the message or executing a second turn", () => {
		const { directory, ledger } = fixture();
		const payload = { text: "private fixture prompt", attachments: ["fixture/path"] };
		expect(ledger.accept("session", "request", payload).duplicate).toBe(false);
		ledger.finish("session", "request", "completed");
		expect(ledger.accept("session", "request", payload)).toMatchObject({
			duplicate: true,
			receipt: { status: "completed" },
		});
		expect(readFileSync(join(directory, "requests", "session", "request.json"), "utf8")).not.toContain(payload.text);
		expect(() => ledger.accept("session", "request", { text: "different" })).toThrow("不同内容");
	});
	it("keeps an upload-stage cancellation ahead of a late message POST", () => {
		const { ledger } = fixture();
		ledger.finish("session", "request", "cancelled");
		expect(ledger.accept("session", "request", { text: "late" })).toMatchObject({
			duplicate: true,
			receipt: { status: "cancelled" },
		});
	});
	it("a restart exposes interruption and never retries an accepted request", () => {
		const { directory, ledger } = fixture();
		ledger.accept("session", "request", { text: "fixture" });
		const restarted = new RequestLedger(directory, "second-process");
		expect(restarted.read("session", "request")).toMatchObject({
			status: "failed",
			error: expect.stringContaining("不会自动重发"),
		});
		expect(restarted.accept("session", "request", { text: "fixture" }).duplicate).toBe(true);
	});
	it("rejects paths outside the receipt directory", () => {
		const { ledger } = fixture();
		expect(() => ledger.read("../external", "request")).toThrow();
		expect(() => ledger.finish("session", "../../external", "cancelled")).toThrow();
	});
});
