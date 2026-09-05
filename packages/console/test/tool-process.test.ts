import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runToolProcess } from "../src/tool-process.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("owned CLI cancellation", () => {
	it("does not launch an already cancelled command", async () => {
		const abort = new AbortController();
		abort.abort();
		await expect(
			runToolProcess("NEVER_EXECUTED_FIXTURE", [], { timeoutMs: 1000, signal: abort.signal }),
		).rejects.toThrow();
	});
	it("kills an owned writer and waits for close before reporting cancellation", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-cancel-cli-"));
		directories.push(directory);
		const script = join(directory, "writer.cjs");
		const output = join(directory, "writes.txt");
		writeFileSync(
			script,
			'const fs = require("node:fs"); if(process.argv[3] === "child") { setInterval(() => fs.appendFileSync(process.argv[2], "x"), 20); } else { require("node:child_process").spawn(process.execPath, [__filename, process.argv[2], "child"], {stdio:"inherit", windowsHide:true}); setInterval(() => {}, 100); }',
		);
		const abort = new AbortController();
		const running = runToolProcess(process.execPath, [script, output], { timeoutMs: 10_000, signal: abort.signal });
		const rejected = expect(running).rejects.toThrow("取消");
		for (let count = 0; count < 100 && !existsSync(output); count++)
			await new Promise((resolve) => setTimeout(resolve, 20));
		expect(existsSync(output)).toBe(true);
		abort.abort();
		await rejected;
		const completed = readFileSync(output, "utf8");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(readFileSync(output, "utf8")).toBe(completed);
	});
	it("reports launch and nonzero-exit failures instead of successful text", async () => {
		await expect(runToolProcess("MISSING_PI_CLI_FIXTURE.exe", [], { timeoutMs: 1000 })).rejects.toThrow();
		await expect(
			runToolProcess(process.execPath, ["-e", 'process.stderr.write("FAKE_PERMISSION_DENIED"); process.exit(7)'], {
				timeoutMs: 1000,
			}),
		).rejects.toMatchObject({ code: 7, stderr: "FAKE_PERMISSION_DENIED" });
	});
});
