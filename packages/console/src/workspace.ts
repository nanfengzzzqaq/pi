/**
 * 工作区设置：用户可自行指定会话的工作目录（Agent 读写文件的根）。
 *
 * - 持久化到 <DATA_DIR>/workspace.json
 * - 设置了工作区后：新会话的 cwd = 工作区目录（多会话共享同一工作区），
 *   文件管理器的浏览根也包含工作区
 * - 未设置时回退默认：<DATA_DIR>/workspaces/<sessionId>
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

/** 校验路径是存在的目录并保存；返回规范化后的路径，失败抛错 */
export function setWorkspacePath(path: string): string {
	const trimmed = path.trim();
	if (!trimmed) {
		mkdirSync(DATA_DIR, { recursive: true });
		writeFileSync(WORKSPACE_FILE, `${JSON.stringify({ path: null }, null, "\t")}\n`, "utf8");
		return "";
	}
	const abs = resolve(trimmed);
	if (!existsSync(abs)) throw new Error(`路径不存在：${abs}`);
	if (!statSync(abs).isDirectory()) throw new Error(`路径不是目录：${abs}`);
	mkdirSync(DATA_DIR, { recursive: true });
	writeFileSync(WORKSPACE_FILE, `${JSON.stringify({ path: abs }, null, "\t")}\n`, "utf8");
	return abs;
}

export function workspaceExists(): boolean {
	const path = getWorkspacePath();
	return path !== null && existsSync(path);
}
