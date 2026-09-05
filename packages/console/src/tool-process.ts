import { type ChildProcess, execFile, spawn } from "node:child_process";

export interface ToolProcessOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	shell?: boolean;
	timeoutMs: number;
	maxBuffer?: number;
	signal?: AbortSignal;
}

export class ToolProcessError extends Error {
	stdout: string;
	stderr: string;
	code: number | string | null;
	killed: boolean;
	constructor(message: string, stdout = "", stderr = "", code: number | string | null = null, killed = false) {
		super(message);
		this.name = "ToolProcessError";
		this.stdout = stdout;
		this.stderr = stderr;
		this.code = code;
		this.killed = killed;
	}
}

/** End the owned process tree; callers still await close before declaring completion. */
export function terminateToolProcess(child: ChildProcess): void {
	if (!child.pid || child.exitCode !== null) return;
	if (process.platform === "win32") {
		execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, (error) => {
			if (error && child.exitCode === null) child.kill("SIGKILL");
		});
	} else {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			child.kill("SIGKILL");
		}
	}
}

/** Bounded, cancellable CLI execution shared by capability tools. */
export async function runToolProcess(
	file: string,
	args: string[],
	options: ToolProcessOptions,
): Promise<{ stdout: string; stderr: string }> {
	options.signal?.throwIfAborted();
	return await new Promise((resolve, reject) => {
		const child = spawn(file, args, {
			cwd: options.cwd,
			env: options.env,
			shell: options.shell ?? false,
			windowsHide: true,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let outputBytes = 0;
		let failure: string | null = null;
		let settled = false;
		const stop = (message: string) => {
			if (failure || settled) return;
			failure = message;
			terminateToolProcess(child);
		};
		const abort = () => stop("操作已取消");
		const timer = setTimeout(
			() => stop(`命令执行超时（${Math.ceil(options.timeoutMs / 1000)} 秒）`),
			options.timeoutMs,
		);
		timer.unref();
		const cleanup = () => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
		};
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
		for (const [stream, isError] of [
			[child.stdout, false],
			[child.stderr, true],
		] as const) {
			stream.setEncoding("utf8");
			stream.on("data", (chunk: string) => {
				outputBytes += Buffer.byteLength(chunk);
				if (outputBytes > (options.maxBuffer ?? 16 * 1024 * 1024)) {
					stop("命令输出超过上限");
					return;
				}
				if (isError) stderr += chunk;
				else stdout += chunk;
			});
		}
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(new ToolProcessError(error.message, stdout, stderr));
		});
		child.once("close", (code) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (failure || code !== 0)
				reject(
					new ToolProcessError(
						failure ?? (stderr.trim() || `命令执行失败（退出码 ${code}）`),
						stdout,
						stderr,
						code,
						failure !== null,
					),
				);
			else resolve({ stdout, stderr });
		});
	});
}
