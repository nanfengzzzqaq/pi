import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), runOfficeCli: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn, execFile: (_file, _args, _options, callback) => callback(null, "", "") }));
vi.mock("../src/officecli.ts", () => ({ isBinaryReady: async () => true, binaryPath: () => "FIXTURE", runOfficeCli: mocks.runOfficeCli }));
vi.mock("../src/tool-process.ts", () => ({ terminateToolProcess: child => child.kill() }));
import { startOfficePreview, stopAllOfficePreviews, stopOfficePreview } from "../src/office-preview.ts";
import officePack from "../packs/office-assistant/index.ts";

const directories = [];
afterEach(async () => { await stopAllOfficePreviews(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("Office lifecycle", () => {
	it("cancels a pending preview and rejects late startup output", async () => {
		let child;
		mocks.spawn.mockImplementation(() => {
			child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
			child.stdout.setEncoding = child.stderr.setEncoding = () => {};
			child.exitCode = null;
			child.kill = vi.fn(() => { child.exitCode = 0; queueMicrotask(() => { child.emit("exit", 0); child.emit("close", 0); }); return true; });
			return child;
		});
		const directory = mkdtempSync(join(tmpdir(), "pi-watch-test-")); directories.push(directory);
		const file = join(directory, "fixture.docx"); writeFileSync(file, "fixture");
		const starting = startOfficePreview(file);
		const rejected = expect(starting).rejects.toThrow("取消");
		await Promise.resolve();
		await stopAllOfficePreviews();
		await rejected;
		child.stdout.emit("data", "Watch: http://127.0.0.1:32123/");
		expect(child.kill).toHaveBeenCalled();
		expect(await stopOfficePreview("nonexistent")).toBe(false);
	});
	it("rejects Office execution errors and forwards cancellation", async () => {
		mocks.runOfficeCli.mockRejectedValue(new Error("FAKE_PERMISSION_DENIED"));
		const tool = officePack({ getWorkspaceRoot: () => tmpdir() }).tools.find(tool => tool.name === "office_view");
		const abort = new AbortController();
		await expect(tool.execute("fixture", { file: "fixture.docx", mode: "text" }, abort.signal)).rejects.toThrow("FAKE_PERMISSION_DENIED");
		expect(mocks.runOfficeCli).toHaveBeenCalledWith(["view", "fixture.docx", "text"], tmpdir(), abort.signal);
	});
});
