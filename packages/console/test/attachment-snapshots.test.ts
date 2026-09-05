import * as fileSystem from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	deleteAttachmentSnapshots,
	getAttachmentReference,
	resolveAttachmentSnapshots,
	saveAttachmentSnapshot,
} from "../src/attachment-snapshots.ts";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fileSystem>();
	return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

const temporaryDirectories: string[] = [];

afterEach(() => {
	vi.clearAllMocks();
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("消息附件原始快照", () => {
	it("manifests recover the latest index entry while stable references preserve earlier originals", () => {
		const dataDir = mkdtempSync(join(tmpdir(), "pi-attachment-manifests-"));
		temporaryDirectories.push(dataDir);
		const sessionId = "01234567-89ab-cdef-0123-456789abcdef";
		const first = saveAttachmentSnapshot(dataDir, sessionId, "uploads/a.txt", "a.txt", Buffer.from("first"));
		const reference = getAttachmentReference(dataDir, sessionId, first);
		const latest = saveAttachmentSnapshot(dataDir, sessionId, "uploads/a.txt", "a.txt", Buffer.from("latest"));
		const directory = join(dataDir, "attachment-snapshots", sessionId);
		writeFileSync(join(directory, "index.json"), "damaged");
		writeFileSync(join(directory, "index.json.bak"), "damaged too");
		expect(resolveAttachmentSnapshots(dataDir, sessionId, ["uploads/a.txt", reference])).toEqual([latest, first]);
		writeFileSync(first, "tampered");
		expect(() => resolveAttachmentSnapshots(dataDir, sessionId, [reference])).toThrow("校验失败");
		expect(() => resolveAttachmentSnapshots(dataDir, sessionId, [`${reference}/unexpected`])).toThrow(
			"不属于当前会话",
		);
		rmSync(latest);
		expect(() => resolveAttachmentSnapshots(dataDir, sessionId, ["uploads/a.txt"])).toThrow("原始附件缺失");
	});
	it("损坏索引从有效备份恢复并保留损坏原文", () => {
		const dataDir = mkdtempSync(join(tmpdir(), "pi-attachment-recovery-"));
		temporaryDirectories.push(dataDir);
		const sessionId = "01234567-89ab-cdef-0123-456789abcdef";
		const snapshot = saveAttachmentSnapshot(dataDir, sessionId, "uploads/a.txt", "a.txt", Buffer.from("original"));
		const directory = join(dataDir, "attachment-snapshots", sessionId);
		writeFileSync(join(directory, "index.json"), "broken index");
		expect(resolveAttachmentSnapshots(dataDir, sessionId, ["uploads/a.txt"])).toEqual([snapshot]);
		expect(readFileSync(snapshot, "utf8")).toBe("original");
		const preserved = readdirSync(directory).filter((name) => name.startsWith("index.json.corrupt-"));
		expect(preserved).toHaveLength(1);
		expect(readFileSync(join(directory, preserved[0]), "utf8")).toBe("broken index");
	});

	it("主索引丢失时也能恢复，恢复后新增附件不会丢掉旧记录", () => {
		const dataDir = mkdtempSync(join(tmpdir(), "pi-attachment-missing-index-"));
		temporaryDirectories.push(dataDir);
		const sessionId = "01234567-89ab-cdef-0123-456789abcdef";
		const first = saveAttachmentSnapshot(dataDir, sessionId, "uploads/a.txt", "a.txt", Buffer.from("a"));
		const directory = join(dataDir, "attachment-snapshots", sessionId);
		rmSync(join(directory, "index.json"));
		const second = saveAttachmentSnapshot(dataDir, sessionId, "uploads/b.txt", "b.txt", Buffer.from("b"));
		expect(resolveAttachmentSnapshots(dataDir, sessionId, ["uploads/a.txt", "uploads/b.txt"])).toEqual([
			first,
			second,
		]);
	});

	it.each(["broken", "[]", '{"uploads/a.txt":{"directory":"../outside","name":"secret"}}'])(
		"无有效备份的损坏索引阻止新写入：%s",
		(damaged) => {
			const dataDir = mkdtempSync(join(tmpdir(), "pi-attachment-invalid-index-"));
			temporaryDirectories.push(dataDir);
			const sessionId = "01234567-89ab-cdef-0123-456789abcdef";
			const directory = join(dataDir, "attachment-snapshots", sessionId);
			mkdirSync(directory, { recursive: true });
			writeFileSync(join(directory, "index.json"), damaged);
			expect(() => saveAttachmentSnapshot(dataDir, sessionId, "uploads/b.txt", "b.txt", Buffer.from("b"))).toThrow(
				"附件索引无法读取",
			);
			expect(readFileSync(join(directory, "index.json"), "utf8")).toBe(damaged);
			expect(readdirSync(directory)).toEqual(["index.json"]);
		},
	);

	it("原子替换失败后保持原索引完整并清理本次临时文件", () => {
		const dataDir = mkdtempSync(join(tmpdir(), "pi-attachment-index-write-"));
		temporaryDirectories.push(dataDir);
		const sessionId = "01234567-89ab-cdef-0123-456789abcdef";
		const original = saveAttachmentSnapshot(dataDir, sessionId, "uploads/a.txt", "a.txt", Buffer.from("a"));
		const directory = join(dataDir, "attachment-snapshots", sessionId);
		const previousIndex = readFileSync(join(directory, "index.json"), "utf8");
		const rename = vi.mocked(fileSystem.renameSync).getMockImplementation()!;
		vi.mocked(fileSystem.renameSync)
			.mockImplementationOnce(rename)
			.mockImplementationOnce(rename)
			.mockImplementationOnce(() => {
				throw new Error("index is locked");
			});
		expect(() => saveAttachmentSnapshot(dataDir, sessionId, "uploads/b.txt", "b.txt", Buffer.from("b"))).toThrow(
			"index is locked",
		);
		expect(readFileSync(join(directory, "index.json"), "utf8")).toBe(previousIndex);
		expect(resolveAttachmentSnapshots(dataDir, sessionId, ["uploads/a.txt"])).toEqual([original]);
		expect(existsSync(original)).toBe(true);
		expect(readdirSync(directory).some((name) => name.endsWith(".tmp"))).toBe(false);
	});

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
