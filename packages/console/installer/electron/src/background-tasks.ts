/**
 * 后台任务面板 — 检测智能体启动的本地服务端口，可单独或全部停止。
 *
 * 从实际启动记录、父进程关系和创建时间确认归属，仅显示本次运行中智能体启动的服务。
 * 停止前重新核对创建时间、端口和会话，排除无关进程及复用的 PID。
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { getProcessOwners, type ProcessIdentity } from "./background-owner.ts";

const execFileAsync = promisify(execFile);

/** 只显示这些进程名的监听端口（开发服务器典型运行时）。 */
const DEV_PROCESS_PATTERN =
	/^(node|nodejs|npm|npx|pnpm|yarn|bun|deno|python|python3|py|uv|pipenv|java|javaw|go|dotnet|ruby|php|rustc|cargo|tsx|vite|webpack|esbuild|uvicorn|gunicorn|flask|streamlit|ollama)(\.exe)?$/i;

export interface BackgroundTask {
	taskId: string;
	sessionId: string;
	cwd: string;
	port: number;
	/** IPv4 绑定地址，如 127.0.0.1 / 0.0.0.0 */
	address: string;
	pid: number;
	processName: string;
	/** 进程命令行片段（能取到时），便于确认是哪个项目 */
	command: string | null;
}

interface NetstatLine {
	address: string;
	port: number;
	pid: number;
}

function parseNetstat(stdout: string): NetstatLine[] {
	const seen = new Set<string>();
	const lines: NetstatLine[] = [];
	for (const line of stdout.split("\n")) {
		// TCP    127.0.0.1:5173    0.0.0.0:0    LISTENING    12345
		const match = line.trim().match(/^TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
		if (!match) continue;
		const port = Number(match[2]);
		const pid = Number(match[3]);
		if (port <= 0 || pid <= 0) continue;
		const key = `${match[1]}:${port}`;
		if (seen.has(key)) continue;
		seen.add(key);
		lines.push({ address: match[1], port, pid });
	}
	return lines;
}

async function listWindowsTasks(): Promise<Map<number, ProcessIdentity>> {
	const map = new Map<number, ProcessIdentity>();
	const shell = join(
		process.env.SystemRoot ?? "C:\\Windows",
		"System32",
		"WindowsPowerShell",
		"v1.0",
		"powershell.exe",
	);
	const script =
		"$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n='StartedAt';e={([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}}) | ConvertTo-Json -Compress";
	const { stdout } = await execFileAsync(shell, ["-NoProfile", "-NonInteractive", "-Command", script], {
		maxBuffer: 16 * 1024 * 1024,
		timeout: 15_000,
		windowsHide: true,
	});
	const values = JSON.parse(stdout);
	for (const item of Array.isArray(values) ? values : [values]) {
		if (!Number.isSafeInteger(item.ProcessId) || !Number.isFinite(item.StartedAt) || !item.Name) continue;
		map.set(item.ProcessId, {
			pid: item.ProcessId,
			parentPid: item.ParentProcessId,
			name: item.Name,
			startedAt: item.StartedAt,
			identity: `${item.ProcessId}:${item.StartedAt}`,
			command: item.CommandLine ?? null,
		});
	}
	return map;
}

async function listUnixTasks(): Promise<Map<number, ProcessIdentity>> {
	const map = new Map<number, ProcessIdentity>();
	const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,lstart=,comm=,args="], {
		env: { ...process.env, LC_ALL: "C" },
		maxBuffer: 16 * 1024 * 1024,
		timeout: 15_000,
	});
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const [pid, parent, ...parts] = trimmed.split(/\s+/);
		const numeric = Number(pid);
		const date = parts.slice(0, 5).join(" ");
		const startedAt = Date.parse(date);
		if (!Number.isFinite(numeric) || !Number.isFinite(startedAt)) continue;
		map.set(numeric, {
			pid: numeric,
			parentPid: Number(parent),
			startedAt,
			identity: `${numeric}:${date}`,
			name: basename(parts[5] || ""),
			command: parts.slice(6).join(" ") || null,
		});
	}
	return map;
}

export async function listBackgroundTasks(): Promise<BackgroundTask[]> {
	let listening: NetstatLine[];
	if (process.platform === "win32") {
		const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "TCP"], {
			maxBuffer: 16 * 1024 * 1024,
			timeout: 15_000,
			windowsHide: true,
		});
		listening = parseNetstat(stdout);
	} else {
		const { stdout } = await execFileAsync(
			process.platform === "darwin" ? "lsof" : "ss",
			process.platform === "darwin" ? ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"] : ["-ltnp"],
			{
				maxBuffer: 16 * 1024 * 1024,
				timeout: 15_000,
			},
		);
		// 兼容 ss 输出：LISTEN 0 511 127.0.0.1:5173 users:(("node",pid=123,fd=20))
		listening = [];
		let macPid = 0;
		for (const line of stdout.split("\n")) {
			if (process.platform === "darwin") {
				if (/^p\d+$/.test(line)) macPid = Number(line.slice(1));
				const address = line.match(/^n(.+):(\d+)$/);
				if (address && macPid) listening.push({ address: address[1], port: Number(address[2]), pid: macPid });
				continue;
			}
			const match = line.trim().match(/LISTEN\s+\d+\s+\d+\s+(\S+?)(?::(\d+))\s+.*pid=(\d+)/i);
			if (!match) continue;
			const port = Number(match[2]);
			const pid = Number(match[3]);
			if (port > 0 && pid > 0) listening.push({ address: match[1], port, pid });
		}
	}
	if (listening.length === 0) return [];
	const processes = process.platform === "win32" ? await listWindowsTasks() : await listUnixTasks();
	const owners = getProcessOwners(processes);
	const tasks: BackgroundTask[] = [];
	for (const line of listening) {
		const proc = processes.get(line.pid);
		const owner = owners.get(line.pid);
		if (!proc || !owner || line.pid === process.pid || !DEV_PROCESS_PATTERN.test(proc.name)) continue;
		tasks.push({
			taskId: createHash("sha256")
				.update(`${proc.identity}:${line.address}:${line.port}:${owner.sessionId}`)
				.digest("hex"),
			...owner,
			port: line.port,
			address: line.address,
			pid: line.pid,
			processName: proc.name,
			command: proc.command,
		});
	}
	tasks.sort((a, b) => a.port - b.port);
	return tasks;
}

export async function killBackgroundTask(pid: number, expectedName: string, taskId: string): Promise<void> {
	if (!Number.isInteger(pid) || pid <= 0) throw new Error("无效的进程标识");
	// 终止前再次核对进程名仍匹配开发者工具清单，避免竞态误杀
	const tasks = await listBackgroundTasks();
	const match = tasks.find((t) => t.pid === pid && t.taskId === taskId);
	if (!match) throw new Error("该进程已不在监听列表中");
	if (match.processName !== expectedName) throw new Error("进程信息已变化，请刷新后重试");
	if (process.platform === "win32") {
		await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 15_000, windowsHide: true });
	} else {
		process.kill(pid, "SIGTERM");
	}
}
