/**
 * 后台任务面板 — 检测智能体启动的本地服务端口，可单独或全部停止。
 *
 * Windows 下用 netstat -ano 找 LISTENING 端口，tasklist 补进程名；
 * 只显示开发者工具类进程（node/python/npm 等），避免误杀系统服务。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 只显示这些进程名的监听端口（开发服务器典型运行时）。 */
const DEV_PROCESS_PATTERN =
	/^(node|nodejs|npm|npx|pnpm|yarn|bun|deno|python|python3|py|uv|pipenv|java|javaw|go|dotnet|ruby|php|rustc|cargo|tsx|vite|webpack|esbuild|uvicorn|gunicorn|flask|streamlit|ollama)(\.exe)?$/i;

export interface BackgroundTask {
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

async function listWindowsTasks(): Promise<Map<number, { name: string; command: string | null }>> {
	const map = new Map<number, { name: string; command: string | null }>();
	const { stdout } = await execFileAsync("tasklist", ["/FO", "CSV", "/NH"], {
		maxBuffer: 16 * 1024 * 1024,
		timeout: 15_000,
		windowsHide: true,
	});
	for (const line of stdout.split("\n")) {
		const cells = line.match(/("([^"]|"")*")/g);
		if (!cells || cells.length < 2) continue;
		const name = cells[0].replaceAll('""', '"').slice(1, -1);
		const pid = Number(cells[1].replaceAll('"', ""));
		if (!name || !Number.isFinite(pid) || pid <= 0) continue;
		map.set(pid, { name, command: null });
	}
	return map;
}

async function listUnixTasks(pids: number[]): Promise<Map<number, { name: string; command: string | null }>> {
	const map = new Map<number, { name: string; command: string | null }>();
	const { stdout } = await execFileAsync("ps", ["-o", "pid=,comm=,args=", "-p", pids.join(",")], {
		maxBuffer: 16 * 1024 * 1024,
		timeout: 15_000,
	});
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const [pid, comm, ...rest] = trimmed.split(/\s+/);
		const numeric = Number(pid);
		if (!Number.isFinite(numeric)) continue;
		map.set(numeric, { name: comm || pid, command: rest.join(" ") || null });
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
		const { stdout } = await execFileAsync("netstat", ["-anv", "-p", "tcp"], {
			maxBuffer: 16 * 1024 * 1024,
			timeout: 15_000,
		}).catch(async () => {
			// macOS/BSD 语法不同；Linux 常见 netstat 或 ss
			const ss = await execFileAsync("ss", ["-ltnp"], { maxBuffer: 16 * 1024 * 1024, timeout: 15_000 });
			return ss;
		});
		// 兼容 ss 输出：LISTEN 0 511 127.0.0.1:5173 users:(("node",pid=123,fd=20))
		listening = [];
		for (const line of stdout.split("\n")) {
			const match = line.trim().match(/LISTEN\s+\d+\s+\d+\s+(\S+?)(?::(\d+))\s+.*pid=(\d+)/i);
			if (!match) continue;
			const port = Number(match[2]);
			const pid = Number(match[3]);
			if (port > 0 && pid > 0) listening.push({ address: match[1], port, pid });
		}
	}
	if (listening.length === 0) return [];
	const pids = [...new Set(listening.map((l) => l.pid))];
	const processes =
		process.platform === "win32"
			? await listWindowsTasks().catch(() => new Map<number, { name: string; command: string | null }>())
			: await listUnixTasks(pids).catch(() => new Map<number, { name: string; command: string | null }>());
	const tasks: BackgroundTask[] = [];
	for (const line of listening) {
		const proc = processes.get(line.pid);
		if (!proc || !DEV_PROCESS_PATTERN.test(proc.name)) continue;
		tasks.push({
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

export async function killBackgroundTask(pid: number, expectedName: string): Promise<void> {
	if (!Number.isInteger(pid) || pid <= 0) throw new Error("无效的进程标识");
	// 终止前再次核对进程名仍匹配开发者工具清单，避免竞态误杀
	const tasks = await listBackgroundTasks();
	const match = tasks.find((t) => t.pid === pid);
	if (!match) throw new Error("该进程已不在监听列表中");
	if (match.processName !== expectedName) throw new Error("进程信息已变化，请刷新后重试");
	if (process.platform === "win32") {
		await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 15_000, windowsHide: true });
	} else {
		process.kill(pid, "SIGTERM");
	}
}
