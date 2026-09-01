import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	deleteAttachmentSnapshots,
	resolveAttachmentSnapshots,
	saveAttachmentSnapshot,
} from "../src/attachment-snapshots.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("消息附件原始快照", () => {
	it("工作副本修改后仍从历史消息解析到原始内容", () => {
		const dataDir = mkdtempSync(join(tmpdir(), "pi-attachment-snapshot-"));
		temporaryDirectories.push(dataDir);
		const workspace = join(dataDir, "workspace");
		const workingPath = "uploads/报告.txt";
		mkdirSync(join(workspace, "uploads"), { recursive: true });
		writeFileSync(join(workspace, workingPath), "原始版本", "utf8");

		const snapshotPath = saveAttachmentSnapshot(
			dataDir,
			"01234567-89ab-cdef-0123-456789abcdef",
			workingPath,
			"报告.txt",
			readFileSync(join(workspace, workingPath)),
		);
		writeFileSync(join(workspace, workingPath), "修改后的版本", "utf8");

		expect(resolveAttachmentSnapshots(dataDir, "01234567-89ab-cdef-0123-456789abcdef", [workingPath])).toEqual([
			snapshotPath,
		]);
		expect(readFileSync(snapshotPath, "utf8")).toBe("原始版本");
		expect(readFileSync(join(workspace, workingPath), "utf8")).toBe("修改后的版本");
	});

	it("旧消息没有快照时保持原路径，并可随会话删除快照", () => {
		const dataDir = mkdtempSync(join(tmpdir(), "pi-attachment-snapshot-"));
		temporaryDirectories.push(dataDir);
		const sessionId = "01234567-89ab-cdef-0123-456789abcdef";
		const snapshotPath = saveAttachmentSnapshot(dataDir, sessionId, "uploads/a.txt", "a.txt", Buffer.from("a"));

		expect(resolveAttachmentSnapshots(dataDir, sessionId, ["uploads/legacy.txt"])).toEqual(["uploads/legacy.txt"]);
		deleteAttachmentSnapshots(dataDir, sessionId);
		expect(() => readFileSync(snapshotPath)).toThrow();
	});
});
