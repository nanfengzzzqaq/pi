/**
 * 交互式终端 — 每客户端独立 shell 进程（管道模式，无原生依赖）。
 *
 * 说明：出于安装版零原生模块依赖的约束，这里用 child_process 管道而不是 node-pty。
 * 普通命令行工具可正常交互（输出实时流式），需要真 TTY 的全屏程序（vim 等）不支持。
 * Windows 下优先 Git Bash，其次 PowerShell，最后 cmd。
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { hostname } from "node:os";

export interface TerminalSession {
	id: string;
	process: ChildProcessWithoutNullStreams;
	shell: string;
	createdAt: number;
	lastActiveAt: number;
	exitInfo: { code: number | null; signal: string | null } | null;
}

type OutputListener = (chunk: string) => void;

const MAX_SESSIONS = 6;
const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
const MAX_PENDING_BUFFER = 200_000;

const sessions = new Map<string, TerminalSession>();
const listeners = new Map<string, Set<OutputListener>>();
const pendingBuffers = new Map<string, string[]>();

function findGitBash(): string | null {
	const candidates = [
		process.env.PI_CONSOLE_GIT_BASH,
		"C:\\Program Files\\Git\\bin\\bash.exe",
		"C:\\Program Files (x86)\\Git\\bin\\bash.exe",
	].filter((value): value is string => typeof value === "string" && value.length > 0);
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

export function describeShell(): string {
	if (process.platform === "win32") {
		const bash = findGitBash();
		if (bash) return "Git Bash";
		return "PowerShell";
	}
	return process.env.SHELL || "/bin/sh";
}

export function startTerminal(cwd: string): TerminalSession {
	// 回收空闲会话，防止句柄泄漏
	for (const [id, session] of sessions) {
		if (session.exitInfo) {
			destroyTerminal(id);
			continue;
		}
		if (Date.now() - session.lastActiveAt > SESSION_IDLE_TTL_MS) {
			try {
				session.process.kill();
			} catch {
				/* 已退出 */
			}
			destroyTerminal(id);
		}
	}
	if (sessions.size >= MAX_SESSIONS) {
		throw new Error(`终端会话已达上限（${MAX_SESSIONS}），请先关闭不用的终端`);
	}
	const id = randomUUID();
	const isWindows = process.platform === "win32";
	const bashPath = isWindows ? findGitBash() : null;
	const command = bashPath ?? (isWindows ? "powershell.exe" : process.env.SHELL || "/bin/sh");
	const args = bashPath ? ["--login"] : isWindows ? ["-NoLogo"] : ["-i"];
	const child = spawn(command, args, {
		cwd,
		env: {
			...process.env,
			TERM: "dumb",
			// 管道模式下禁用交互式提示符的多余转义
			...(isWindows ? {} : { PS1: "\\w$ " }),
		},
		windowsHide: true,
		stdio: ["pipe", "pipe", "pipe"],
	}) as ChildProcessWithoutNullStreams;
	const session: TerminalSession = {
		id,
		process: child,
		shell: bashPath ? "Git Bash" : isWindows ? "PowerShell" : command,
		createdAt: Date.now(),
		lastActiveAt: Date.now(),
		exitInfo: null,
	};
	sessions.set(id, session);
	pendingBuffers.set(id, []);
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	const onOutput = (chunk: string) => {
		session.lastActiveAt = Date.now();
		const buffer = pendingBuffers.get(id);
		const notified = listeners.get(id);
		if (notified && notified.size > 0) {
			for (const listener of notified) listener(chunk);
		} else if (buffer) {
			buffer.push(chunk);
			// 丢弃最旧内容，保留总量的上限
			let total = buffer.reduce((sum, piece) => sum + piece.length, 0);
			while (total > MAX_PENDING_BUFFER && buffer.length > 1) {
				total -= buffer.shift()!.length;
			}
		}
	};
	child.stdout.on("data", onOutput);
	child.stderr.on("data", onOutput);
	child.on("exit", (code, signal) => {
		session.exitInfo = { code, signal };
		const notified = listeners.get(id);
		const message = `\r\n\x1b[2m[进程已退出：${signal ? `信号 ${signal}` : `退出码 ${code ?? 0}`}]\x1b[0m\r\n`;
		if (notified) for (const listener of notified) listener(message);
		const buffer = pendingBuffers.get(id);
		buffer?.push(message);
	});
	return session;
}

export function getTerminal(id: string): TerminalSession | null {
	return sessions.get(id) ?? null;
}

export function writeTerminal(id: string, data: string): void {
	const session = sessions.get(id);
	if (!session || session.exitInfo) throw new Error("终端已关闭");
	session.lastActiveAt = Date.now();
	session.process.stdin.write(data);
}

export function subscribeTerminal(id: string, listener: OutputListener): () => void {
	let set = listeners.get(id);
	if (!set) {
		set = new Set();
		listeners.set(id, set);
	}
	set.add(listener);
	const buffer = pendingBuffers.get(id);
	if (buffer) {
		for (const piece of buffer) listener(piece);
		buffer.length = 0;
	}
	return () => {
		set?.delete(listener);
		if (set && set.size === 0) listeners.delete(id);
	};
}

export function destroyTerminal(id: string): void {
	const session = sessions.get(id);
	if (session && !session.exitInfo) {
		try {
			session.process.kill();
		} catch {
			/* 已退出 */
		}
	}
	sessions.delete(id);
	listeners.delete(id);
	pendingBuffers.delete(id);
}

export function terminalPromptHint(): string {
	return `${hostname()}>`;
}
