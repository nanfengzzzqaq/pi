import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	copyFileSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { resolveMigratedDataPath } from "./storage.ts";

interface AttachmentSnapshotEntry {
	directory: string;
	name: string;
}

type AttachmentSnapshotIndex = Record<string, AttachmentSnapshotEntry>;

const SNAPSHOT_DIRECTORY = "attachment-snapshots";
const INDEX_FILE = "index.json";
const REFERENCE_PREFIX = "pi-attachment:";

interface SnapshotManifest {
	snapshotId: string;
	workingPath: string;
	name: string;
	sha256: string;
	createdAt: number;
}
function readManifest(path: string): SnapshotManifest {
	const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!raw || typeof raw !== "object") throw new Error("附件原始记录已损坏，请恢复备份");
	const manifest = raw as SnapshotManifest;
	parseSnapshotIndex(
		JSON.stringify({ [manifest.workingPath]: { directory: manifest.snapshotId, name: manifest.name } }),
	);
	if (
		typeof manifest.workingPath !== "string" ||
		!manifest.workingPath ||
		!/^[a-f0-9]{64}$/u.test(manifest.sha256) ||
		!Number.isFinite(manifest.createdAt) ||
		basename(path) !== `${manifest.snapshotId}.json`
	)
		throw new Error("附件原始记录已损坏，请恢复备份");
	return manifest;
}
function recoverManifestEntries(directory: string, index: AttachmentSnapshotIndex): AttachmentSnapshotIndex {
	const manifestDir = join(directory, "manifests");
	if (!existsSync(manifestDir)) return index;
	const manifests: SnapshotManifest[] = [];
	for (const name of readdirSync(manifestDir)) {
		if (!name.endsWith(".json")) continue;
		manifests.push(readManifest(join(manifestDir, name)));
	}
	for (const manifest of manifests.sort((a, b) => a.createdAt - b.createdAt))
		index[manifest.workingPath] = { directory: manifest.snapshotId, name: manifest.name };
	return index;
}

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
	if (!existsSync(path) && !existsSync(`${path}.bak`))
		return recoverManifestEntries(directory, Object.create(null) as AttachmentSnapshotIndex);
	try {
		return parseSnapshotIndex(readFileSync(path, "utf8"));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code !== "ENOENT") throw error;
		let backup: string;
		let index: AttachmentSnapshotIndex;
		try {
			backup = readFileSync(`${path}.bak`, "utf8");
			index = recoverManifestEntries(directory, parseSnapshotIndex(backup));
		} catch {
			index = recoverManifestEntries(directory, Object.create(null) as AttachmentSnapshotIndex);
			if (!Object.keys(index).length) throw new Error(`附件索引无法读取，已保留原文件，请从备份恢复：${path}`);
		}
		// Preserve the damaged bytes without removing the live index before a replacement is ready.
		if (existsSync(path)) copyFileSync(path, `${path}.corrupt-${randomUUID()}`, constants.COPYFILE_EXCL);
		atomicWrite(path, `${JSON.stringify(index, null, "\t")}\n`);
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
	const manifestDirectory = join(directory, "manifests");
	mkdirSync(manifestDirectory, { recursive: true });
	// Upgrade valid legacy mappings before rotating the index backup.
	for (const [key, entry] of Object.entries(index)) {
		const manifestPath = join(manifestDirectory, `${entry.directory}.json`);
		if (!existsSync(manifestPath)) {
			const bytes = readFileSync(join(directory, entry.directory, entry.name));
			atomicWrite(
				manifestPath,
				JSON.stringify({
					snapshotId: entry.directory,
					workingPath: key,
					name: entry.name,
					sha256: createHash("sha256").update(bytes).digest("hex"),
					createdAt: 0,
				} satisfies SnapshotManifest),
			);
		}
	}
	const snapshotDirectory = randomUUID();
	const safeName = basename(fileName).slice(0, 200) || "未命名文件";
	const targetDirectory = join(directory, snapshotDirectory);
	mkdirSync(targetDirectory, { recursive: true });
	const snapshotPath = join(targetDirectory, safeName);
	atomicWrite(snapshotPath, data);
	const previousEntry = index[attachmentKey(workingPath)];
	const previousTime = previousEntry
		? readManifest(join(manifestDirectory, `${previousEntry.directory}.json`)).createdAt
		: 0;
	const manifest: SnapshotManifest = {
		snapshotId: snapshotDirectory,
		workingPath: attachmentKey(workingPath),
		name: safeName,
		sha256: createHash("sha256").update(data).digest("hex"),
		createdAt: Math.max(Date.now(), previousTime + 1),
	};
	atomicWrite(join(manifestDirectory, `${snapshotDirectory}.json`), JSON.stringify(manifest));

	index[attachmentKey(workingPath)] = { directory: snapshotDirectory, name: safeName };
	const content = `${JSON.stringify(index, null, "\t")}\n`;
	parseSnapshotIndex(content);
	atomicWrite(`${indexPath}.bak`, hadIndex ? previous : content);
	atomicWrite(indexPath, content);
	return snapshotPath;
}

/** 历史消息优先显示原始副本；旧消息或缺失快照继续使用原工作路径。 */
export function resolveAttachmentSnapshots(dataDir: string, sessionId: string, workingPaths: string[]): string[] {
	return createAttachmentSnapshotResolver(dataDir, sessionId)(workingPaths);
}

export function getAttachmentReference(dataDir: string, sessionId: string, snapshotPath: string): string {
	const directory = sessionSnapshotDirectory(dataDir, sessionId);
	const snapshotId = basename(dirname(snapshotPath));
	if (
		resolve(dirname(dirname(snapshotPath))) !== resolve(directory) ||
		!existsSync(join(directory, "manifests", `${snapshotId}.json`))
	)
		throw new Error("附件不属于当前会话");
	const manifest = readManifest(join(directory, "manifests", `${snapshotId}.json`));
	if (basename(snapshotPath) !== manifest.name) throw new Error("附件原始记录不匹配");
	return `${REFERENCE_PREFIX}${sessionId}/${snapshotId}`;
}

/** Reuse one index snapshot while projecting a history page. */
export function createAttachmentSnapshotResolver(dataDir: string, sessionId: string): (paths: string[]) => string[] {
	const directory = sessionSnapshotDirectory(dataDir, sessionId);
	const index = readSnapshotIndex(directory);
	const verified = new Set<string>();
	return (workingPaths) =>
		workingPaths.map((workingPath) => {
			let entry = index[attachmentKey(workingPath)];
			if (workingPath.startsWith(REFERENCE_PREFIX)) {
				const [owner, snapshotId, extra] = workingPath.slice(REFERENCE_PREFIX.length).split("/");
				if (owner !== sessionId || !snapshotId || !/^[a-f0-9-]+$/iu.test(snapshotId) || extra !== undefined)
					throw new Error("附件引用不属于当前会话");
				const manifest = readManifest(join(directory, "manifests", `${snapshotId}.json`));
				entry = { directory: snapshotId, name: manifest.name };
			}
			if (!entry) {
				const migrated = resolveMigratedDataPath(workingPath, dataDir);
				if (resolve(dirname(dirname(migrated))) !== resolve(directory)) return migrated;
				const manifestPath = join(directory, "manifests", `${basename(dirname(migrated))}.json`);
				if (!existsSync(manifestPath)) {
					if (!existsSync(migrated)) throw new Error("原始附件缺失，请从备份恢复");
					return migrated;
				}
				const manifest = readManifest(manifestPath);
				if (basename(migrated) !== manifest.name) throw new Error("附件原始记录不匹配");
				entry = { directory: manifest.snapshotId, name: manifest.name };
			}
			const snapshotPath = join(directory, entry.directory, entry.name);
			if (!existsSync(snapshotPath)) throw new Error("原始附件缺失，请从备份恢复；工作副本不会冒充原件");
			const manifestPath = join(directory, "manifests", `${entry.directory}.json`);
			if (!verified.has(snapshotPath) && existsSync(manifestPath)) {
				const manifest = readManifest(manifestPath);
				if (createHash("sha256").update(readFileSync(snapshotPath)).digest("hex") !== manifest.sha256)
					throw new Error("原始附件校验失败，请从备份恢复");
				verified.add(snapshotPath);
			}
			return snapshotPath;
		});
}

/** 删除会话时一并删除只属于该会话的消息附件快照。 */
export function deleteAttachmentSnapshots(dataDir: string, sessionId: string): void {
	const directory = sessionSnapshotDirectory(dataDir, sessionId);
	if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
}
