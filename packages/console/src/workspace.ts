/** Selecting a workspace never moves files. Copying requires a separate, current preview. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { readDurableJson, writeDurableJson } from "./durable-json.ts";
import { DATA_DIR } from "./paths.ts";
import { canonicalDestination, copyVerifiedDirectory } from "./storage.ts";

const WORKSPACE_FILE = join(DATA_DIR, "workspace.json");
function parseWorkspace(value: unknown): { path: string | null } {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("工作区配置格式无效");
	const entry = value as { path?: unknown };
	if (entry.path !== null && (typeof entry.path !== "string" || !entry.path.trim()))
		throw new Error("工作区配置格式无效");
	return { path: entry.path as string | null };
}
export function getWorkspacePath(): string | null {
	return readDurableJson(WORKSPACE_FILE, parseWorkspace, () => ({ path: null })).path;
}
export interface WorkspaceResult {
	path: string;
	migrated: number;
}
export function setWorkspacePath(path: string): WorkspaceResult {
	const selected = path.trim() ? realpathSync(resolve(path.trim())) : null;
	if (selected && !statSync(selected).isDirectory()) throw new Error("工作区路径不是目录");
	writeDurableJson(WORKSPACE_FILE, { path: selected }, parseWorkspace, () => ({ path: null }));
	return { path: selected ?? "", migrated: 0 };
}
export function workspaceExists(): boolean {
	const path = getWorkspacePath();
	return path !== null && existsSync(path);
}

export interface WorkspaceCopyPreview {
	source: string;
	target: string;
	files: number;
	totalBytes: number;
	conflicts: string[];
	revision: string;
}
export function previewWorkspaceCopy(sourcePath: string, targetPath: string): WorkspaceCopyPreview {
	if (!sourcePath.trim() || !targetPath.trim()) throw new Error("请选择来源和目标目录");
	const source = realpathSync(resolve(sourcePath));
	if (!statSync(source).isDirectory()) throw new Error("来源不是目录");
	const target = canonicalDestination(targetPath);
	const key = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
	const prefix = (value: string) => (value.endsWith(sep) ? key(value) : `${key(value)}${sep}`);
	if (key(source) === key(target) || key(source).startsWith(prefix(target)) || key(target).startsWith(prefix(source)))
		throw new Error("来源与目标不能相同或互相包含");
	const conflicts = existsSync(target)
		? statSync(target).isDirectory()
			? readdirSync(target)
			: ["目标不是目录"]
		: [];
	const entries: string[] = [];
	let files = 0;
	let totalBytes = 0;
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				entries.push(JSON.stringify([relative(source, path), "directory"]));
				walk(path);
			} else if (entry.isFile()) {
				const stat = statSync(path);
				files++;
				totalBytes += stat.size;
				entries.push(JSON.stringify([relative(source, path), stat.size, stat.mtimeMs, stat.ctimeMs]));
			} else throw new Error(`来源含有链接或特殊文件，无法安全复制：${entry.name}`);
		}
	};
	walk(source);
	const revision = createHash("sha256")
		.update(JSON.stringify([source, target, entries, conflicts]))
		.digest("hex");
	return { source, target, files, totalBytes, conflicts, revision };
}
export function copyWorkspaceFiles(sourcePath: string, targetPath: string, expectedRevision: string) {
	const preview = previewWorkspaceCopy(sourcePath, targetPath);
	if (!expectedRevision || preview.revision !== expectedRevision) throw new Error("复制来源或目标已变化，请重新预览");
	if (preview.conflicts.length) throw new Error("目标目录必须为空，已有文件不会覆盖");
	const stage = join(dirname(preview.target), `.pi-workspace-copy-${randomUUID()}`);
	let installed = false;
	try {
		mkdirSync(dirname(preview.target), { recursive: true });
		mkdirSync(stage);
		const copiedFiles = copyVerifiedDirectory(preview.source, stage);
		if (previewWorkspaceCopy(sourcePath, targetPath).revision !== expectedRevision)
			throw new Error("复制期间来源或目标发生变化，请重新预览");
		if (existsSync(preview.target)) rmdirSync(preview.target);
		renameSync(stage, preview.target);
		installed = true;
		return { source: preview.source, target: preview.target, copiedFiles };
	} finally {
		if (!installed && existsSync(stage)) rmSync(stage, { recursive: true });
	}
}
