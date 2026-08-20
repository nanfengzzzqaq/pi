/**
 * 本地资源管理器后端。
 *
 * Windows 安装版可直接浏览本机磁盘，作为客户端内置的资源管理器；
 * 非 Windows 环境仍限制在工作区、数据目录与显式配置目录内。
 */
import { copyFileSync, type Dirent, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { DATA_DIR } from "./paths.ts";
import { decodeTextBuffer, isTextFilePath } from "./text-files.ts";
import { getWorkspacePath } from "./workspace.ts";

const MAX_READ_BYTES = 10 * 1024 * 1024;
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const MAX_SEARCH_FILES = 50_000;
const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;
const SEARCH_TIMEOUT_MS = 8_000;
const SEARCH_IGNORED_DIRECTORIES = new Set([".git", ".svn", "node_modules"]);

export interface FsRoot {
	path: string;
	name: string;
	kind: "workspace" | "quick" | "drive" | "data" | "configured";
}

function pathKey(path: string): string {
	return process.platform === "win32" ? resolve(path).toLocaleLowerCase("en-US") : resolve(path);
}

function pathWithin(path: string, root: string): boolean {
	const candidate = pathKey(path);
	const parent = pathKey(root);
	return candidate === parent || candidate.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

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
export function listRoots(): FsRoot[] {
	const roots: FsRoot[] = [];
	const workspace = getWorkspacePath();
	if (workspace)
		roots.push({ path: resolve(workspace), name: `工作区 · ${basename(workspace) || workspace}`, kind: "workspace" });

	if (process.platform === "win32") {
		const home = process.env.USERPROFILE;
		if (home) {
			for (const [name, child] of [
				["桌面", "Desktop"],
				["文档", "Documents"],
				["下载", "Downloads"],
			] as const) {
				const path = join(home, child);
				if (existsSync(path)) roots.push({ path, name, kind: "quick" });
			}
		}
		for (let code = 65; code <= 90; code++) {
			const path = `${String.fromCharCode(code)}:\\`;
			if (existsSync(path)) roots.push({ path, name: `本地磁盘 (${String.fromCharCode(code)}:)`, kind: "drive" });
		}
	}

	roots.push({ path: resolve(DATA_DIR), name: "Pi 数据", kind: "data" });
	for (const path of configuredRoots()) roots.push({ path, name: basename(path) || path, kind: "configured" });

	const seen = new Set<string>();
	return roots.filter((root) => {
		const key = pathKey(root.path);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function withinRoots(absPath: string): string | null {
	if (process.platform === "win32" && isAbsolute(absPath) && existsSync(absPath)) return parse(absPath).root;
	const roots = [...workspaceRoots(), DATA_DIR, ...configuredRoots()];
	for (const root of roots) {
		if (pathWithin(absPath, root)) return root;
	}
	return null;
}

export function isWorkspacePath(path: string): boolean {
	const workspace = getWorkspacePath();
	return Boolean(workspace && pathWithin(path, workspace));
}

export interface FsEntry {
	name: string;
	type: "dir" | "file";
	size: number | null;
	mtime: number;
	/** 相对根目录的路径（前端定位用） */
	rel: string;
	/** 当前项是否位于 Agent 工作区内 */
	isWorkspace: boolean;
}

export interface AllowedFileInfo {
	path: string;
	name: string;
	size: number;
	mimeType: string;
}

export interface FsSearchResult {
	path: string;
	name: string;
	size: number;
	mtime: number;
	isWorkspace: boolean;
	line: number | null;
	preview: string | null;
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
				isWorkspace: isWorkspacePath(entryAbs),
				root,
			});
		} catch {
			/* 跳过无法访问的项 */
		}
	}
	entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
	return entries;
}

export function getDirectoryInfo(path: string): { path: string; parent: string | null; isWorkspace: boolean } {
	const abs = resolve(path);
	if (!withinRoots(abs)) throw new Error("路径不在可浏览范围内");
	if (!statSync(abs).isDirectory()) throw new Error("目标不是目录");
	const parent = dirname(abs);
	return { path: abs, parent: parent === abs ? null : parent, isWorkspace: isWorkspacePath(abs) };
}

/** 读取文件（限大小），返回 base64 + mime 推断 */
export function readFileAsBase64(path: string): { dataBase64: string; mimeType: string; size: number } {
	const abs = resolve(path);
	if (!withinRoots(abs)) throw new Error("路径不在可浏览范围内");
	const stat = statSync(abs);
	if (!stat.isFile()) throw new Error("目标不是文件");
	if (stat.size > MAX_READ_BYTES) throw new Error(`文件超过 ${MAX_READ_BYTES / 1024 / 1024}MB，无法直接读取`);
	const data = readFileSync(abs);
	return { dataBase64: data.toString("base64"), mimeType: mimeForPath(abs), size: stat.size };
}

export function readTextFile(path: string): { text: string; encoding: string; size: number; mimeType: string } {
	const abs = resolveAllowedFilePath(path);
	if (!isTextFilePath(abs)) throw new Error("该文件不是可直接预览的文本格式");
	const stat = statSync(abs);
	if (stat.size > MAX_READ_BYTES) throw new Error(`文本文件超过 ${MAX_READ_BYTES / 1024 / 1024}MB，无法直接预览`);
	const decoded = decodeTextBuffer(readFileSync(abs));
	return { ...decoded, size: stat.size, mimeType: mimeForPath(abs) };
}

/** 在当前目录下递归搜索文件名或文本内容；全程本地执行，不调用模型。 */
export function searchFiles(
	path: string,
	query: string,
	mode: "name" | "content",
): { results: FsSearchResult[]; scanned: number; truncated: boolean } {
	const root = resolve(path);
	if (!withinRoots(root)) throw new Error("路径不在可浏览范围内");
	if (!statSync(root).isDirectory()) throw new Error("目标不是目录");
	const needle = query.trim().toLocaleLowerCase("zh-CN");
	if (!needle) return { results: [], scanned: 0, truncated: false };

	const results: FsSearchResult[] = [];
	const queue = [root];
	const startedAt = Date.now();
	let scanned = 0;
	let truncated = false;
	while (queue.length > 0) {
		if (
			scanned >= MAX_SEARCH_FILES ||
			results.length >= MAX_SEARCH_RESULTS ||
			Date.now() - startedAt > SEARCH_TIMEOUT_MS
		) {
			truncated = true;
			break;
		}
		const directory = queue.shift();
		if (!directory) break;
		let entries: Dirent[];
		try {
			entries = readdirSync(directory, { withFileTypes: true, encoding: "utf8" });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (results.length >= MAX_SEARCH_RESULTS || scanned >= MAX_SEARCH_FILES) {
				truncated = true;
				break;
			}
			const entryPath = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (!SEARCH_IGNORED_DIRECTORIES.has(entry.name.toLocaleLowerCase("en-US"))) queue.push(entryPath);
				continue;
			}
			if (!entry.isFile()) continue;
			scanned++;
			try {
				const stat = statSync(entryPath);
				let line: number | null = null;
				let preview: string | null = null;
				let matched = entry.name.toLocaleLowerCase("zh-CN").includes(needle);
				if (mode === "content") {
					matched = false;
					if (stat.size <= MAX_SEARCH_FILE_BYTES && isTextFilePath(entryPath)) {
						const lines = decodeTextBuffer(readFileSync(entryPath)).text.split(/\r?\n/);
						const index = lines.findIndex((value) => value.toLocaleLowerCase("zh-CN").includes(needle));
						if (index >= 0) {
							matched = true;
							line = index + 1;
							preview = lines[index].trim().slice(0, 240);
						}
					}
				}
				if (matched) {
					results.push({
						path: entryPath,
						name: entry.name,
						size: stat.size,
						mtime: stat.mtimeMs,
						isWorkspace: isWorkspacePath(entryPath),
						line,
						preview,
					});
				}
			} catch {
				/* 跳过搜索过程中失效或无权限的文件 */
			}
		}
	}
	return { results, scanned, truncated };
}

export function mimeForPath(path: string): string {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	const map: Record<string, string> = {
		png: "image/png",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		gif: "image/gif",
		webp: "image/webp",
		svg: "image/svg+xml",
		txt: "text/plain",
		md: "text/markdown",
		mdx: "text/markdown",
		json: "application/json",
		jsonl: "application/x-ndjson",
		yaml: "text/yaml",
		yml: "text/yaml",
		toml: "text/plain",
		xml: "application/xml",
		js: "text/javascript",
		jsx: "text/javascript",
		mjs: "text/javascript",
		ts: "text/typescript",
		tsx: "text/typescript",
		css: "text/css",
		scss: "text/css",
		html: "text/html",
		csv: "text/csv",
		tsv: "text/tab-separated-values",
		log: "text/plain",
		ini: "text/plain",
		docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		doc: "application/msword",
		xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		xls: "application/vnd.ms-excel",
		pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
		ppt: "application/vnd.ms-powerpoint",
		pdf: "application/pdf",
		zip: "application/zip",
		"7z": "application/x-7z-compressed",
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

export function getAllowedFileInfo(path: string): AllowedFileInfo {
	const abs = resolveAllowedFilePath(path);
	const stat = statSync(abs);
	return { path: abs, name: basename(abs), size: stat.size, mimeType: mimeForPath(abs) };
}

/** 把一个本地文件复制到当前资源管理器目录；同名时自动追加序号，避免覆盖。 */
export function copyFileIntoDirectory(source: string, destinationDir: string): AllowedFileInfo {
	const from = resolveAllowedFilePath(source);
	const destination = resolve(destinationDir);
	if (!withinRoots(destination)) throw new Error("目标目录不在可浏览范围内");
	if (!statSync(destination).isDirectory()) throw new Error("目标不是目录");
	const target = uniqueDestination(destination, basename(from));
	copyFileSync(from, target);
	return getAllowedFileInfo(target);
}

/** 接收浏览器拖入的文件内容并保存到当前资源管理器目录。 */
export function importFileIntoDirectory(name: string, dataBase64: string, destinationDir: string): AllowedFileInfo {
	const destination = resolve(destinationDir);
	if (!withinRoots(destination)) throw new Error("目标目录不在可浏览范围内");
	if (!statSync(destination).isDirectory()) throw new Error("目标不是目录");
	const safeName =
		basename(name)
			.replace(/[\\/:*?"<>|]/g, "_")
			.slice(0, 200) || "未命名文件";
	const data = Buffer.from(dataBase64, "base64");
	if (data.length > MAX_IMPORT_BYTES) throw new Error(`文件超过 ${MAX_IMPORT_BYTES / 1024 / 1024}MB 上限`);
	const target = uniqueDestination(destination, safeName);
	writeFileSync(target, data);
	return getAllowedFileInfo(target);
}

function uniqueDestination(directory: string, name: string): string {
	const extension = extname(name);
	const stem = basename(name, extension);
	let target = join(directory, name);
	let index = 1;
	while (existsSync(target)) {
		target = join(directory, `${stem} (${index})${extension}`);
		index++;
	}
	return target;
}
