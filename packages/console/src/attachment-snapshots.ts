import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

interface AttachmentSnapshotEntry {
	directory: string;
	name: string;
}

type AttachmentSnapshotIndex = Record<string, AttachmentSnapshotEntry>;

const SNAPSHOT_DIRECTORY = "attachment-snapshots";
const INDEX_FILE = "index.json";

function validateSessionId(sessionId: string): string {
	if (!/^[a-f0-9-]+$/iu.test(sessionId)) throw new Error("会话标识无效，无法保存附件原始副本");
	return sessionId;
}

function sessionSnapshotDirectory(dataDir: string, sessionId: string): string {
	return join(dataDir, SNAPSHOT_DIRECTORY, validateSessionId(sessionId));
}

function attachmentKey(workingPath: string): string {
	return workingPath.trim().replace(/\\/g, "/");
}

function readSnapshotIndex(directory: string): AttachmentSnapshotIndex {
	try {
		const parsed = JSON.parse(readFileSync(join(directory, INDEX_FILE), "utf8")) as unknown;
		if (typeof parsed === "object" && parsed !== null) return parsed as AttachmentSnapshotIndex;
	} catch {
		// 首次保存或索引损坏时从空索引继续；现有快照文件不会被覆盖。
	}
	return {};
}

/**
 * 保存用户消息附件的不可变原始副本，并把模型可编辑的工作路径映射到该副本。
 * 原始副本位于 Pi 数据目录，工作路径仍位于会话 cwd；模型提示词只包含工作路径。
 */
export function saveAttachmentSnapshot(
	dataDir: string,
	sessionId: string,
	workingPath: string,
	fileName: string,
	data: Buffer,
): string {
	const directory = sessionSnapshotDirectory(dataDir, sessionId);
	const snapshotDirectory = randomUUID();
	const safeName = basename(fileName).slice(0, 200) || "未命名文件";
	const targetDirectory = join(directory, snapshotDirectory);
	mkdirSync(targetDirectory, { recursive: true });
	const snapshotPath = join(targetDirectory, safeName);
	writeFileSync(snapshotPath, data);

	const index = readSnapshotIndex(directory);
	index[attachmentKey(workingPath)] = { directory: snapshotDirectory, name: safeName };
	writeFileSync(join(directory, INDEX_FILE), `${JSON.stringify(index, null, "\t")}\n`, "utf8");
	return snapshotPath;
}

/** 历史消息优先显示原始副本；旧消息或缺失快照继续使用原工作路径。 */
export function resolveAttachmentSnapshots(dataDir: string, sessionId: string, workingPaths: string[]): string[] {
	const directory = sessionSnapshotDirectory(dataDir, sessionId);
	const index = readSnapshotIndex(directory);
	return workingPaths.map((workingPath) => {
		const entry = index[attachmentKey(workingPath)];
		if (!entry) return workingPath;
		const snapshotPath = join(directory, entry.directory, entry.name);
		return existsSync(snapshotPath) ? snapshotPath : workingPath;
	});
}

/** 删除会话时一并删除只属于该会话的消息附件快照。 */
export function deleteAttachmentSnapshots(dataDir: string, sessionId: string): void {
	const directory = sessionSnapshotDirectory(dataDir, sessionId);
	if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
}
