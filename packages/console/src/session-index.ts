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
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface SessionIndexEntry {
	cwd: string;
	sessionFile?: string;
	enabledPacks?: string[];
	title: string;
	createdAt: number;
	updatedAt: number;
}

export type SessionIndex = Record<string, SessionIndexEntry>;

function parseIndex(text: string): SessionIndex {
	const value: unknown = JSON.parse(text);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("会话索引格式无效");
	for (const entry of Object.values(value)) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("会话索引记录无效");
		const item = entry as Record<string, unknown>;
		if (
			typeof item.cwd !== "string" ||
			typeof item.title !== "string" ||
			typeof item.createdAt !== "number" ||
			!Number.isFinite(item.createdAt) ||
			typeof item.updatedAt !== "number" ||
			!Number.isFinite(item.updatedAt) ||
			(item.sessionFile !== undefined && typeof item.sessionFile !== "string") ||
			(item.enabledPacks !== undefined &&
				(!Array.isArray(item.enabledPacks) || item.enabledPacks.some((name) => typeof name !== "string")))
		) {
			throw new Error("会话索引记录无效");
		}
	}
	return value as SessionIndex;
}

/** Flush a complete sibling file before replacing the destination. */
function atomicWrite(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	let created = false;
	try {
		const descriptor = openSync(temporary, "wx", 0o600);
		created = true;
		try {
			writeFileSync(descriptor, content, "utf8");
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		renameSync(temporary, path);
	} finally {
		if (created && existsSync(temporary)) unlinkSync(temporary);
	}
}

export function readSessionIndexFile(path: string): SessionIndex {
	if (!existsSync(path) && !existsSync(`${path}.bak`)) return {};
	try {
		return parseIndex(readFileSync(path, "utf8"));
	} catch (error) {
		// Permissions and I/O failures must not be mistaken for damaged JSON.
		if (!(error instanceof SyntaxError) && error instanceof Error && "code" in error && error.code !== "ENOENT")
			throw error;
		let backup: string;
		let index: SessionIndex;
		try {
			backup = readFileSync(`${path}.bak`, "utf8");
			index = parseIndex(backup);
		} catch {
			throw new Error(`会话索引无法读取，已保留原文件，请从备份恢复：${path}`);
		}
		if (existsSync(path)) copyFileSync(path, `${path}.corrupt-${randomUUID()}`, constants.COPYFILE_EXCL);
		atomicWrite(path, backup);
		console.warn("会话索引已从最后有效备份恢复，损坏文件已保留");
		return index;
	}
}

export function writeSessionIndexFile(path: string, index: SessionIndex): void {
	const content = `${JSON.stringify(index, null, "\t")}\n`;
	parseIndex(content);
	if (existsSync(path) || existsSync(`${path}.bak`)) {
		const previous = readSessionIndexFile(path);
		atomicWrite(`${path}.bak`, `${JSON.stringify(previous, null, "\t")}\n`);
	} else {
		atomicWrite(`${path}.bak`, content);
	}
	atomicWrite(path, content);
}
