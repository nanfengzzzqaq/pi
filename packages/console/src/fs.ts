/**
 * 本地资源管理器后端：受限的目录浏览与文件读取。
 *
 * 可浏览根目录：
 *  - 控制台数据目录（data/，含 workspaces/agent/bin 等）
 *  - 可选环境变量 PI_CONSOLE_FS_ROOT 指定的目录（如用户文档目录）
 * 路径一律规范化后校验必须落在某个根内，防止任意文件访问。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { DATA_DIR } from "./paths.ts";
import { getWorkspacePath } from "./workspace.ts";

const MAX_READ_BYTES = 10 * 1024 * 1024;

function configuredRoots(): string[] {
	const extra = process.env.PI_CONSOLE_FS_ROOT;
	return extra ? [resolve(extra)] : [];
}

/** 工作区（用户自定义）作为第一浏览根 */
function workspaceRoots(): string[] {
	const path = getWorkspacePath();
	return path ? [path] : [];
}

/** 可浏览的根目录列表（工作区优先，其次数据目录与配置根） */
export function listRoots(): Array<{ path: string; name: string }> {
	const roots = [...workspaceRoots(), DATA_DIR, ...configuredRoots()];
	return roots.map((path) => ({ path, name: basename(path) || path }));
}

function withinRoots(absPath: string): string | null {
	const roots = [...workspaceRoots(), DATA_DIR, ...configuredRoots()];
	for (const root of roots) {
		if (absPath === root || absPath.startsWith(root + sep)) return root;
	}
	return null;
}

export interface FsEntry {
	name: string;
	type: "dir" | "file";
	size: number | null;
	mtime: number;
	/** 相对根目录的路径（前端定位用） */
	rel: string;
}

/** 列目录；path 为绝对路径（必须落在某个根内） */
export function listDir(path: string): Array<FsEntry & { root: string }> {
	const abs = resolve(path);
	const root = withinRoots(abs);
	if (!root) throw new Error("路径不在可浏览范围内");
	const entries: Array<FsEntry & { root: string }> = [];
	for (const name of readdirSync(abs, { withFileTypes: true })) {
		const entryAbs = join(abs, name.name);
		try {
			const stat = statSync(entryAbs);
			entries.push({
				name: name.name,
				type: name.isDirectory() ? "dir" : "file",
				size: name.isDirectory() ? null : stat.size,
				mtime: stat.mtimeMs,
				rel: name.name,
				root,
			});
		} catch {
			/* 跳过无法访问的项 */
		}
	}
	entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
	return entries;
}

/** 读取文件（限大小），返回 base64 + mime 推断 */
export function readFileAsBase64(path: string): { dataBase64: string; mimeType: string; size: number } {
	const abs = resolve(path);
	if (!withinRoots(abs)) throw new Error("路径不在可浏览范围内");
	const stat = statSync(abs);
	if (!stat.isFile()) throw new Error("目标不是文件");
	if (stat.size > MAX_READ_BYTES) throw new Error(`文件超过 ${MAX_READ_BYTES / 1024 / 1024}MB，无法直接读取`);
	const data = readFileSync(abs);
	return { dataBase64: data.toString("base64"), mimeType: guessMime(abs), size: stat.size };
}

function guessMime(path: string): string {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	const map: Record<string, string> = {
		png: "image/png",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		gif: "image/gif",
		webp: "image/webp",
		txt: "text/plain",
		md: "text/markdown",
		json: "application/json",
		js: "text/javascript",
		ts: "text/typescript",
		css: "text/css",
		html: "text/html",
		csv: "text/csv",
		docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
		pdf: "application/pdf",
	};
	return map[ext] ?? "application/octet-stream";
}

export function ensureExists(path: string): boolean {
	return existsSync(path);
}

/** 校验并返回可浏览根目录内的文件绝对路径，供流式预览等无需读取全文件的功能复用。 */
export function resolveAllowedFilePath(path: string): string {
	const abs = resolve(path);
	if (!withinRoots(abs)) throw new Error("路径不在可浏览范围内");
	const stat = statSync(abs);
	if (!stat.isFile()) throw new Error("目标不是文件");
	return abs;
}
