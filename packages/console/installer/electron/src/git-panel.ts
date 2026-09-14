/**
 * Git 源代码管理面板 — 供人使用的 status / 暂存 / 提交 / 推送 / 拉取 / diff。
 *
 * 只做只读加显式写操作（stage/unstage/commit/push/pull），全部经 execFile 数组传参，
 * 不拼接 shell。路径必须在会话工作区或其子目录内。
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_DIFF_CHARS = 400_000;
const COMMIT_MESSAGE_MAX = 2000;

export interface GitChange {
	path: string;
	/** 工作区状态（未暂存）两字母码，如 "M" / " D" / "??" */
	workTree: string;
	/** 暂存区状态两字母码 */
	index: string;
	staged: boolean;
	untracked: boolean;
}

export interface GitStatus {
	repository: boolean;
	branch: string | null;
	upstream: string | null;
	ahead: number;
	behind: number;
	changes: GitChange[];
	stagedCount: number;
}

export interface GitDiff {
	path: string;
	text: string;
	truncated: boolean;
}

function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
	return execFileAsync("git", args, {
		cwd,
		maxBuffer: 16 * 1024 * 1024,
		timeout: 30_000,
		windowsHide: true,
	});
}

/** 把用户提供的路径限制在仓库根内，防止越权读写。 */
function repoRelativePath(cwd: string, repoRoot: string, filePath: string): string {
	const normalized = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
	const root = resolve(repoRoot);
	const rootWithSep = root.endsWith(sep) ? root : root + sep;
	const caseInsensitive = process.platform === "win32";
	const sameRoot = (a: string, b: string) => (caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b);
	const withinRoot = (a: string, b: string) =>
		caseInsensitive ? a.toLowerCase().startsWith(b.toLowerCase()) : a.startsWith(b);
	if (!sameRoot(normalized, root) && !withinRoot(normalized, rootWithSep)) {
		throw new Error("路径不在当前仓库内");
	}
	return normalized.slice(rootWithSep.length).replaceAll("\\", "/");
}

async function repoRoot(cwd: string): Promise<string> {
	const { stdout } = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
	return stdout.trim();
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
	try {
		const root = await repoRoot(cwd);
		const [branchOut, statusOut] = await Promise.all([
			runGit(cwd, ["branch", "--show-current"]),
			runGit(cwd, ["status", "--porcelain=v1", "-b", "--untracked-files=all"]),
		]);
		const changes: GitChange[] = [];
		let ahead = 0;
		let behind = 0;
		let upstream: string | null = null;
		for (const line of statusOut.stdout.split("\n")) {
			if (!line) continue;
			// "## main...origin/main [ahead 1, behind 2]"
			if (line.startsWith("##")) {
				const info = line.slice(2).trim();
				const dots = info.indexOf("...");
				if (dots > 0) upstream = info.slice(dots + 3).split(" ")[0];
				const aheadMatch = info.match(/\[ahead (\d+)/);
				const behindMatch = info.match(/\[behind (\d+)/);
				ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
				behind = behindMatch ? Number(behindMatch[1]) : 0;
				continue;
			}
			if (line.length < 4) continue;
			const index = line[0];
			const workTree = line[1];
			const path = line.slice(3).trim();
			if (!path) continue;
			// 重命名 "R  old -> new" 显示新路径
			const renamed = path.includes(" -> ") ? path.split(" -> ").pop()! : path;
			changes.push({
				path: repoRelativePath(cwd, root, renamed),
				workTree,
				index,
				staged: index !== " " && index !== "?",
				untracked: index === "?",
			});
		}
		return {
			repository: true,
			branch: branchOut.stdout.trim() || null,
			upstream,
			ahead,
			behind,
			changes,
			stagedCount: changes.filter((c) => c.staged).length,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/not a git repository/i.test(message)) {
			return { repository: false, branch: null, upstream: null, ahead: 0, behind: 0, changes: [], stagedCount: 0 };
		}
		throw error;
	}
}

export async function gitStage(cwd: string, paths: string[], unstage: boolean): Promise<void> {
	if (paths.length === 0) return;
	if (paths.length > 500) throw new Error("单次操作的文件过多");
	const root = await repoRoot(cwd);
	const relative = paths.map((p) => repoRelativePath(cwd, root, p));
	// 显式指定路径时 --force 不需要；untracked 文件 add 也直接支持
	await runGit(cwd, unstage ? ["restore", "--staged", "--", ...relative] : ["add", "--", ...relative]);
}

export async function gitStageAll(cwd: string, unstage: boolean): Promise<void> {
	await runGit(cwd, unstage ? ["restore", "--staged", "."] : ["add", "-A"]);
}

export async function gitCommit(cwd: string, message: string): Promise<{ commit: string }> {
	const trimmed = message.trim();
	if (!trimmed) throw new Error("提交说明不能为空");
	if (trimmed.length > COMMIT_MESSAGE_MAX) throw new Error("提交说明过长");
	const { stdout } = await runGit(cwd, ["commit", "-m", trimmed]);
	const match = stdout.match(/\[.*?([0-9a-f]{7,40})\]/);
	return { commit: match ? match[1] : randomUUID().slice(0, 7) };
}

export async function gitPush(cwd: string): Promise<string> {
	const { stdout, stderr } = await runGit(cwd, ["push"]);
	return (stdout + stderr).trim() || "已推送";
}

export async function gitPull(cwd: string): Promise<string> {
	const { stdout, stderr } = await runGit(cwd, ["pull", "--ff-only"]);
	return (stdout + stderr).trim() || "已拉取";
}

export async function gitDiffFile(cwd: string, filePath: string, staged: boolean): Promise<GitDiff> {
	const root = await repoRoot(cwd);
	const relative = repoRelativePath(cwd, root, filePath);
	const args = staged ? ["diff", "--cached", "--", relative] : ["diff", "--", relative];
	if (!staged) args.splice(1, 0, "--"); // 保持普通 diff
	const { stdout } = await runGit(cwd, args);
	const truncated = stdout.length > MAX_DIFF_CHARS;
	return { path: relative, text: truncated ? stdout.slice(0, MAX_DIFF_CHARS) : stdout, truncated };
}

/** 当前工作区整体差异（含未暂存与已暂存），给面板首次加载用。 */
export async function gitDiffSummary(cwd: string): Promise<GitDiff> {
	const { stdout } = await runGit(cwd, ["diff", "HEAD"]);
	const truncated = stdout.length > MAX_DIFF_CHARS;
	return { path: "", text: truncated ? stdout.slice(0, MAX_DIFF_CHARS) : stdout, truncated };
}
