import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	copyFileSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
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

function parseSnapshotIndex(text: string): AttachmentSnapshotIndex {
	const parsed: unknown = JSON.parse(text);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("附件索引格式无效");
	const index: AttachmentSnapshotIndex = Object.create(null);
	for (const [key, value] of Object.entries(parsed)) {
		if (!key || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("附件索引记录无效");
		const entry = value as Record<string, unknown>;
		if (
			typeof entry.directory !== "string" ||
			!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(entry.directory) ||
			typeof entry.name !== "string" ||
			!entry.name ||
			entry.name === "." ||
			entry.name === ".." ||
			/[\\/\0]/u.test(entry.name)
		) {
			throw new Error("附件索引记录无效");
		}
		index[key] = { directory: entry.directory, name: entry.name };
	}
	return index;
}

function atomicWrite(path: string, content: string | Buffer): void {
	const temporary = `${path}.${randomUUID()}.tmp`;
	let created = false;
	try {
		const descriptor = openSync(temporary, "wx", 0o600);
		created = true;
		try {
			writeFileSync(descriptor, content);
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		renameSync(temporary, path);
	} finally {
		if (created && existsSync(temporary)) unlinkSync(temporary);
	}
}

function readSnapshotIndex(directory: string): AttachmentSnapshotIndex {
	const path = join(directory, INDEX_FILE);
	if (!existsSync(path) && !existsSync(`${path}.bak`)) return Object.create(null) as AttachmentSnapshotIndex;
	try {
		return parseSnapshotIndex(readFileSync(path, "utf8"));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code !== "ENOENT") throw error;
		let backup: string;
		let index: AttachmentSnapshotIndex;
		try {
			backup = readFileSync(`${path}.bak`, "utf8");
			index = parseSnapshotIndex(backup);
		} catch {
			throw new Error(`附件索引无法读取，已保留原文件，请从备份恢复：${path}`);
		}
		// Preserve the damaged bytes without removing the live index before a replacement is ready.
		if (existsSync(path)) copyFileSync(path, `${path}.corrupt-${randomUUID()}`, constants.COPYFILE_EXCL);
		atomicWrite(path, backup);
		console.warn("附件索引已从最后有效备份恢复，损坏文件已保留");
		return index;
	}
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
	const index = readSnapshotIndex(directory);
	const previous = `${JSON.stringify(index, null, "\t")}\n`;
	const indexPath = join(directory, INDEX_FILE);
	const hadIndex = existsSync(indexPath);
	const snapshotDirectory = randomUUID();
	const safeName = basename(fileName).slice(0, 200) || "未命名文件";
	const targetDirectory = join(directory, snapshotDirectory);
	mkdirSync(targetDirectory, { recursive: true });
	const snapshotPath = join(targetDirectory, safeName);
	atomicWrite(snapshotPath, data);

	index[attachmentKey(workingPath)] = { directory: snapshotDirectory, name: safeName };
	const content = `${JSON.stringify(index, null, "\t")}\n`;
	parseSnapshotIndex(content);
	atomicWrite(`${indexPath}.bak`, hadIndex ? previous : content);
	atomicWrite(indexPath, content);
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
