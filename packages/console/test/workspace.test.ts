import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyWorkspaceFiles, previewWorkspaceCopy } from "../src/workspace.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-workspace-copy-"));
	directories.push(root);
	const source = join(root, "source");
	const target = join(root, "target");
	mkdirSync(join(source, "session-a"), { recursive: true });
	mkdirSync(join(source, "session-b"));
	writeFileSync(join(source, "session-a", "same.txt"), "a");
	writeFileSync(join(source, "session-b", "same.txt"), "b");
	return { root, source, target };
}
describe("explicit workspace copies", () => {
	it("preserves directory structure and source files, including same-named files", () => {
		const { source, target } = fixture();
		const preview = previewWorkspaceCopy(source, target);
		expect(preview).toMatchObject({ files: 2, totalBytes: 2, conflicts: [] });
		expect(copyWorkspaceFiles(source, target, preview.revision).copiedFiles).toBe(2);
		expect(readFileSync(join(target, "session-a", "same.txt"), "utf8")).toBe("a");
		expect(readFileSync(join(target, "session-b", "same.txt"), "utf8")).toBe("b");
		expect(readFileSync(join(source, "session-a", "same.txt"), "utf8")).toBe("a");
	});
	it("requires a new preview after source changes and never overwrites an occupied destination", () => {
		const { source, target } = fixture();
		const preview = previewWorkspaceCopy(source, target);
		writeFileSync(join(source, "session-a", "same.txt"), "changed");
		expect(() => copyWorkspaceFiles(source, target, preview.revision)).toThrow("重新预览");
		mkdirSync(target);
		writeFileSync(join(target, "unrelated.txt"), "keep");
		const occupied = previewWorkspaceCopy(source, target);
		expect(occupied.conflicts).toEqual(["unrelated.txt"]);
		expect(() => copyWorkspaceFiles(source, target, occupied.revision)).toThrow("必须为空");
		expect(readFileSync(join(target, "unrelated.txt"), "utf8")).toBe("keep");
	});
	it("rejects containment and includes empty directory changes in the revision", () => {
		const { source, target } = fixture();
		expect(() => previewWorkspaceCopy(source, join(source, "child"))).toThrow("互相包含");
		const previous = previewWorkspaceCopy(source, target);
		mkdirSync(join(source, "empty"));
		expect(() => copyWorkspaceFiles(source, target, previous.revision)).toThrow("重新预览");
	});
});
