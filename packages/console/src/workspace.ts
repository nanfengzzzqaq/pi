/**
 * 工作区设置：用户可自行指定会话的工作目录（Agent 读写文件的根）。
 *
 * - 持久化到 <DATA_DIR>/workspace.json
 * - 设置了工作区后：新会话的 cwd = 工作区目录（多会话共享同一工作区），
 *   文件管理器的浏览根也包含工作区
 * - 未设置时回退默认：<DATA_DIR>/workspaces/<sessionId>
 * - 切换工作区时，把旧活动目录（旧自定义工作区 + 默认 workspaces 内容）
 *   递归合并到新工作区，避免"文件落在 C 盘"式的错位
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DATA_DIR } from "./paths.ts";

const WORKSPACE_FILE = join(DATA_DIR, "workspace.json");

export function getWorkspacePath(): string | null {
	try {
		const raw = JSON.parse(readFileSync(WORKSPACE_FILE, "utf8")) as { path?: unknown };
		if (typeof raw?.path === "string" && raw.path.trim()) return raw.path;
	} catch {
		/* 不存在或损坏 */
	}
	return null;
}

/** 递归合并 src 到 dest：目录逐项拷贝，目标已存在的同名文件保留目标侧 */
function mergeDir(src: string, dest: string): number {
	let migrated = 0;
	if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
	for (const entry of readdirSync(src, { withFileTypes: true })) {
		const from = join(src, entry.name);
		const to = join(dest, entry.name);
		try {
			if (entry.isDirectory()) {
				migrated += mergeDir(from, to);
			} else if (!existsSync(to)) {
				copyFileSync(from, to);
				migrated++;
			}
		} catch {
			/* 单个文件失败不阻断整体迁移 */
		}
	}
	return migrated;
}

/**
 * 默认 workspaces 源的迁移：把每个会话子目录的**内容**平铺合并到目标根，
 * 不保留 UUID 目录层（避免迁移后文件埋在 workspaces/<uuid>/ 子目录里）。
 * 目标已有同名目录时改为合并进该目录。
 */
function mergeWorkspacesFlat(src: string, dest: string): number {
	let migrated = 0;
	for (const entry of readdirSync(src, { withFileTypes: true })) {
		const from = join(src, entry.name);
		const to = join(dest, entry.name);
		try {
			if (entry.isDirectory()) {
				if (existsSync(to) && statSync(to).isDirectory()) {
					migrated += mergeDir(from, to);
				} else {
					migrated += mergeDir(from, dest);
				}
			} else if (!existsSync(to)) {
				copyFileSync(from, to);
				migrated++;
			}
		} catch {
			/* 跳过单个失败项 */
		}
	}
	return migrated;
}

export interface WorkspaceResult {
	path: string;
	/** 迁移的文件数（含目录内文件） */
	migrated: number;
}

/**
 * 设置工作区并迁移旧活动目录内容。
 * path 为空串表示清除工作区（回到默认，不迁移）。
 */
export function setWorkspacePath(path: string): WorkspaceResult {
	if (!path.trim()) {
		mkdirSync(DATA_DIR, { recursive: true });
		writeFileSync(WORKSPACE_FILE, `${JSON.stringify({ path: null }, null, "\t")}\n`, "utf8");
		return { path: "", migrated: 0 };
	}
	const abs = resolve(path.trim());
	if (!existsSync(abs)) throw new Error(`路径不存在：${abs}`);
	if (!statSync(abs).isDirectory()) throw new Error(`路径不是目录：${abs}`);

	// 迁移源：旧自定义工作区（保留结构）+ 默认 workspaces（平铺合并，用户在 C 盘留下的文件）
	const oldCustom = getWorkspacePath();
	const defaultWorkspaces = join(DATA_DIR, "workspaces");
	let migrated = 0;
	if (oldCustom && oldCustom !== abs && existsSync(oldCustom)) {
		if (abs.startsWith(`${oldCustom}\\`) || abs.startsWith(`${oldCustom}/`)) {
			/* 目标在旧工作区内部，跳过避免递归复制 */
		} else {
			migrated += mergeDir(oldCustom, abs);
		}
	}
	if (existsSync(defaultWorkspaces) && defaultWorkspaces !== abs) {
		if (abs.startsWith(`${defaultWorkspaces}\\`) || abs.startsWith(`${defaultWorkspaces}/`)) {
			/* 同上 */
		} else {
			migrated += mergeWorkspacesFlat(defaultWorkspaces, abs);
		}
	}

	mkdirSync(DATA_DIR, { recursive: true });
	writeFileSync(WORKSPACE_FILE, `${JSON.stringify({ path: abs }, null, "\t")}\n`, "utf8");
	return { path: abs, migrated };
}

export function workspaceExists(): boolean {
	const path = getWorkspacePath();
	return path !== null && existsSync(path);
}
