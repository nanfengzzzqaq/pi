/**
 * OfficeCLI 实时预览进程管理。
 *
 * 每个文档最多保留一个 `officecli watch` 进程。OfficeCLI 自己负责渲染页面，
 * 并通过 SSE 把文档修改增量推送给嵌入客户端的预览页。
 */
import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { promisify } from "node:util";
import { binaryPath, isBinaryReady } from "./officecli.ts";

const execFileAsync = promisify(execFile);
const WATCH_START_TIMEOUT_MS = 15_000;
const UNWATCH_TIMEOUT_MS = 5_000;
const WATCH_OUTPUT_LIMIT = 16 * 1024;
const OFFICE_EXTENSIONS = new Set([".docx", ".xlsx", ".pptx"]);

export interface OfficePreviewInfo {
	id: string;
	filePath: string;
	fileName: string;
	port: number;
	url: string;
}

interface OfficePreviewSession extends OfficePreviewInfo {
	child: ChildProcessWithoutNullStreams;
	key: string;
}

const sessionsById = new Map<string, OfficePreviewSession>();
const sessionIdsByPath = new Map<string, string>();
const startsByPath = new Map<string, Promise<OfficePreviewInfo>>();

function pathKey(filePath: string): string {
	const absolute = resolve(filePath);
	return process.platform === "win32" ? absolute.toLocaleLowerCase("en-US") : absolute;
}

function publicInfo(session: OfficePreviewSession): OfficePreviewInfo {
	return {
		id: session.id,
		filePath: session.filePath,
		fileName: session.fileName,
		port: session.port,
		url: session.url,
	};
}

export function isOfficePreviewPath(filePath: string): boolean {
	return OFFICE_EXTENSIONS.has(extname(filePath).toLocaleLowerCase("en-US"));
}

/** 从 OfficeCLI 的启动输出中提取系统分配的预览端口。 */
export function parseOfficePreviewPort(output: string): number | null {
	const match = output.match(/Watch:\s+https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)/i);
	if (!match) return null;
	const port = Number(match[1]);
	return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

async function startNewPreview(filePath: string, key: string): Promise<OfficePreviewInfo> {
	if (!(await isBinaryReady())) throw new Error("OfficeCLI 未安装，请先在工具页安装");

	const absolute = resolve(filePath);
	if (!isOfficePreviewPath(absolute)) throw new Error("实时预览仅支持 .docx、.xlsx 和 .pptx 文件");
	const stat = statSync(absolute);
	if (!stat.isFile()) throw new Error("预览目标不是文件");

	const child = spawn(binaryPath(), ["watch", absolute, "--port", "0"], {
		cwd: dirname(absolute),
		windowsHide: true,
		stdio: "pipe",
	});
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");

	return await new Promise<OfficePreviewInfo>((resolveStart, rejectStart) => {
		let output = "";
		let settled = false;
		let session: OfficePreviewSession | null = null;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill();
			rejectStart(new Error("OfficeCLI 实时预览启动超时"));
		}, WATCH_START_TIMEOUT_MS);

		const finish = (error?: Error): void => {
			if (settled) return;
			const port = parseOfficePreviewPort(output);
			if (!error && port !== null) {
				settled = true;
				clearTimeout(timer);
				child.stdout.off("data", onData);
				child.stderr.off("data", onData);
				session = {
					id: randomUUID(),
					filePath: absolute,
					fileName: basename(absolute),
					port,
					url: `http://127.0.0.1:${port}/`,
					child,
					key,
				};
				sessionsById.set(session.id, session);
				sessionIdsByPath.set(key, session.id);
				resolveStart(publicInfo(session));
				return;
			}
			if (error) {
				settled = true;
				clearTimeout(timer);
				const detail = output.trim();
				rejectStart(new Error(detail ? `${error.message}\n${detail}` : error.message));
			}
		};

		const onData = (chunk: string | Buffer): void => {
			output = `${output}${String(chunk)}`.slice(-WATCH_OUTPUT_LIMIT);
			finish();
		};

		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.once("error", (error) => finish(error));
		child.once("exit", (code) => {
			if (session) {
				sessionsById.delete(session.id);
				if (sessionIdsByPath.get(session.key) === session.id) sessionIdsByPath.delete(session.key);
			}
			if (!settled) finish(new Error(`OfficeCLI 实时预览进程提前退出（代码 ${code ?? "未知"}）`));
		});
	});
}

/** 启动预览；同一文件已有存活预览时直接复用。 */
export async function startOfficePreview(filePath: string): Promise<OfficePreviewInfo> {
	const key = pathKey(filePath);
	const existingId = sessionIdsByPath.get(key);
	const existing = existingId ? sessionsById.get(existingId) : undefined;
	if (existing && existing.child.exitCode === null) return publicInfo(existing);

	const pending = startsByPath.get(key);
	if (pending) return await pending;

	const start = startNewPreview(filePath, key).finally(() => startsByPath.delete(key));
	startsByPath.set(key, start);
	return await start;
}

/** 停止一个预览。优先用 OfficeCLI 官方 unwatch 清理，再兜底结束子进程。 */
export async function stopOfficePreview(id: string): Promise<boolean> {
	const session = sessionsById.get(id);
	if (!session) return false;
	sessionsById.delete(id);
	if (sessionIdsByPath.get(session.key) === id) sessionIdsByPath.delete(session.key);

	try {
		await execFileAsync(binaryPath(), ["unwatch", session.filePath], {
			timeout: UNWATCH_TIMEOUT_MS,
			windowsHide: true,
		});
	} catch {
		// 预览进程可能已退出；下面统一做兜底清理。
	}
	if (session.child.exitCode === null) session.child.kill();
	return true;
}

export async function stopAllOfficePreviews(): Promise<void> {
	await Promise.all([...sessionsById.keys()].map((id) => stopOfficePreview(id)));
}

/** 进程退出阶段不能再等待异步命令，只结束仍存活的 watch 子进程。 */
export function terminateAllOfficePreviewsNow(): void {
	for (const session of sessionsById.values()) {
		if (session.child.exitCode === null) session.child.kill();
	}
	sessionsById.clear();
	sessionIdsByPath.clear();
}
