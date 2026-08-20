/**
 * Windows 原生命令工具。
 *
 * Pi 原生 bash 在 Windows 上依赖 Git Bash/Cygwin/WSL。安装版不能假设这些
 * 程序存在，因此控制台额外提供 PowerShell 工具。它始终用系统绝对路径启动，
 * 不写注册表、不修改系统 PATH，也不会覆盖电脑已有的 Git/Python/PowerShell。
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	type BashOperations,
	createBashToolDefinition,
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DATA_DIR, PACKAGE_ROOT } from "./paths.ts";

const MAX_OUTPUT_CHARS = 16_000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_TIMEOUT_SECONDS = 2_147_000;
const POWERSHELL_UPDATE_THROTTLE_MS = 150;
const PRIVATE_MINGIT_DIR = join(DATA_DIR, "runtime", "mingit");
const PRIVATE_AGENT_BIN_DIR = join(DATA_DIR, "agent", "bin");
const CODE_DEVELOPMENT_DIR = join(DATA_DIR, "tools", "code-development");

export interface WindowsToolContext {
	getWorkspaceRoot(): string;
}

export interface PrivateBashRuntime {
	root: string;
	executable: string;
}

interface RuntimeRecord {
	version?: string;
	sha256?: string;
}

interface CommandResult {
	stdout: string;
	stderr: string;
	exitCode: number | string | null;
	errorMessage: string;
}

type AnyToolDefinition = ToolDefinition<any, any, any>;

/**
 * Electron 会把标记为 asarUnpack 的可执行文件实际放进 app.asar.unpacked。
 * 读取单个文件时 Electron 会透明重定向，但 Node 的 cpSync 不能从虚拟 asar
 * 目录递归复制，因此安装版必须优先使用对应的物理目录。
 */
export function bundledWindowsRuntimeCandidates(packageRoot = PACKAGE_ROOT): string[] {
	const roots = packageRoot.toLocaleLowerCase("en-US").endsWith(".asar")
		? [`${packageRoot}.unpacked`, packageRoot]
		: [packageRoot];
	return roots.map((root) => join(root, "data", "runtime", "mingit"));
}

function getBundledWindowsRuntimeDir(): string | null {
	return (
		bundledWindowsRuntimeCandidates().find((candidate) =>
			existsSync(join(candidate, "mingw64", "bin", "busybox.exe")),
		) ?? null
	);
}

function systemPowerShellCandidates(): string[] {
	const root = process.env.SystemRoot ?? process.env.WINDIR;
	if (!root) return [];
	return [
		join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
		join(root, "Sysnative", "WindowsPowerShell", "v1.0", "powershell.exe"),
	];
}

/** 返回 Windows 自带 PowerShell 的绝对路径；不从 PATH 选择同名第三方程序。 */
export function getWindowsPowerShellPath(): string | null {
	if (process.platform !== "win32") return null;
	return systemPowerShellCandidates().find((candidate) => existsSync(candidate)) ?? null;
}

export function isWindowsPowerShellAvailable(): boolean {
	return getWindowsPowerShellPath() !== null;
}

/**
 * 安装包内的 Git for Windows MinGit 复制到 Agent 数据目录。
 * 复制仅发生在 Pi 私有目录，不执行安装器，也不修改系统环境。
 */
export function seedBundledWindowsRuntime(): boolean {
	if (process.platform !== "win32") return false;
	const bundledMinGitDir = getBundledWindowsRuntimeDir();
	if (!bundledMinGitDir) return false;
	if (resolve(bundledMinGitDir) === resolve(PRIVATE_MINGIT_DIR)) return false;
	const destination = join(PRIVATE_MINGIT_DIR, "mingw64", "bin", "busybox.exe");
	const bundledRecord = readRuntimeRecord(join(bundledMinGitDir, "pi-runtime.json"));
	const privateRecord = readRuntimeRecord(join(PRIVATE_MINGIT_DIR, "pi-runtime.json"));
	if (existsSync(destination) && bundledRecord.sha256 && privateRecord.sha256 === bundledRecord.sha256) {
		return false;
	}
	mkdirSync(PRIVATE_MINGIT_DIR, { recursive: true });
	cpSync(bundledMinGitDir, PRIVATE_MINGIT_DIR, { recursive: true, force: true });
	return true;
}

/** 把安装包预置的 rg/fd 复制到 Pi 私有 agent/bin，供官方 grep/find 工具直接使用。 */
export function seedBundledSearchRuntime(): boolean {
	if (process.platform !== "win32") return false;
	const roots = PACKAGE_ROOT.toLocaleLowerCase("en-US").endsWith(".asar")
		? [`${PACKAGE_ROOT}.unpacked`, PACKAGE_ROOT]
		: [PACKAGE_ROOT];
	const bundled = roots
		.map((root) => join(root, "data", "agent", "bin"))
		.find((root) => existsSync(join(root, "rg.exe")));
	if (!bundled) return false;
	let changed = false;
	mkdirSync(PRIVATE_AGENT_BIN_DIR, { recursive: true });
	for (const name of ["rg.exe", "fd.exe"]) {
		const source = join(bundled, name);
		const destination = join(PRIVATE_AGENT_BIN_DIR, name);
		if (!existsSync(source) || existsSync(destination)) continue;
		cpSync(source, destination, { force: true });
		changed = true;
	}
	return changed;
}

function readRuntimeRecord(path: string): RuntimeRecord {
	try {
		return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as RuntimeRecord;
	} catch {
		return {};
	}
}

/** Pi 私有的 Bash 兼容运行时；不会从系统 PATH 选择或覆盖本机 Git。 */
export function getPrivateBashRuntime(): PrivateBashRuntime | null {
	if (process.platform !== "win32") return null;
	const executable = join(PRIVATE_MINGIT_DIR, "mingw64", "bin", "busybox.exe");
	return existsSync(executable) ? { root: PRIVATE_MINGIT_DIR, executable } : null;
}

export function isPrivateBashAvailable(): boolean {
	return getPrivateBashRuntime() !== null;
}

function truncateOutput(text: string): string {
	if (text.length <= MAX_OUTPUT_CHARS) return text;
	return `（前面内容已截断）\n${text.slice(-MAX_OUTPUT_CHARS)}`;
}

function executePowerShell(
	executable: string,
	command: string,
	cwd: string,
	timeoutSeconds: number | undefined,
	signal: AbortSignal | undefined,
	onChunk?: (text: string) => void,
): Promise<CommandResult> {
	if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) {
		throw new Error("timeout 必须是大于 0 的秒数");
	}
	if (timeoutSeconds !== undefined && timeoutSeconds > MAX_TIMEOUT_SECONDS) {
		throw new Error(`timeout 不能超过 ${MAX_TIMEOUT_SECONDS} 秒`);
	}
	const utf8Command =
		"[Console]::InputEncoding = [Text.UTF8Encoding]::new($false); " +
		"[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); " +
		"$OutputEncoding = [Text.UTF8Encoding]::new($false); " +
		command;
	const decoded = new TextDecoder("utf-8");
	let pending = "";
	return new Promise((resolve) => {
		const child = spawn(
			executable,
			["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", utf8Command],
			{ cwd, env: process.env, windowsHide: true },
		);
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let aborted = false;
		let errorMessage = "";
		const appendStream = (kind: "stdout" | "stderr", chunk: Buffer) => {
			pending += decoded.decode(chunk, { stream: true });
			const lastNewline = pending.lastIndexOf("\n");
			const ready = lastNewline === -1 ? "" : pending.slice(0, lastNewline + 1);
			pending = lastNewline === -1 ? pending : pending.slice(lastNewline + 1);
			if (!ready) return;
			if (kind === "stdout") {
				stdout = keepRollingTail(stdout + ready);
			} else {
				stderr = keepRollingTail(stderr + ready);
			}
			onChunk?.(ready);
		};
		const flush = () => {
			pending += decoded.decode();
			if (!pending) return;
			onChunk?.(pending);
			pending = "";
		};
		child.stdout?.on("data", (chunk: Buffer) => appendStream("stdout", chunk));
		child.stderr?.on("data", (chunk: Buffer) => appendStream("stderr", chunk));
		const timer =
			timeoutSeconds === undefined
				? undefined
				: setTimeout(
						() => {
							timedOut = true;
							child.kill();
						},
						Math.round(timeoutSeconds * 1000),
					);
		const onAbort = () => {
			aborted = true;
			child.kill();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		const finish = (exitCode: number | string | null) => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			flush();
			if (timedOut) errorMessage = `命令超时（${timeoutSeconds} 秒）`;
			else if (aborted) errorMessage = "命令已中止";
			resolve({ stdout, stderr, exitCode, errorMessage });
		};
		child.on("error", (error) => {
			errorMessage = error.message;
			finish(null);
		});
		child.on("close", (code) => finish(code));
	});
}

/** 工具层使用的流式入口：输出按行实时回调，供 onUpdate 增量推送。 */
function executePowerShellStreaming(
	executable: string,
	command: string,
	cwd: string,
	timeoutSeconds: number | undefined,
	signal: AbortSignal | undefined,
	onChunk: (text: string) => void,
): Promise<CommandResult> {
	return executePowerShell(executable, command, cwd, timeoutSeconds, signal, onChunk);
}

/** 超过上限时保留尾部输出（长命令的末尾通常最有价值）。 */
function keepRollingTail(text: string): string {
	if (text.length <= MAX_BUFFER_BYTES) return text;
	return text.slice(-MAX_BUFFER_BYTES);
}

function formatResult(result: CommandResult): string {
	const parts = [result.stdout.trim(), result.stderr.trim() ? `错误输出：\n${result.stderr.trim()}` : ""].filter(
		Boolean,
	);
	return truncateOutput(parts.join("\n\n") || "（无输出）");
}

function privateBashEnvironment(root: string, source: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
	const env = { ...(source ?? process.env) };
	const pathKey = Object.keys(env).find((key) => key.toLocaleLowerCase("en-US") === "path") ?? "PATH";
	const privatePaths = [join(CODE_DEVELOPMENT_DIR, "bin"), join(root, "cmd"), join(root, "mingw64", "bin")];
	env[pathKey] = [...privatePaths, env[pathKey] ?? ""].filter(Boolean).join(delimiter);
	env.PI_PRIVATE_BASH = "1";
	env.MISE_DATA_DIR = join(CODE_DEVELOPMENT_DIR, "mise", "data");
	env.MISE_CONFIG_DIR = join(CODE_DEVELOPMENT_DIR, "mise", "config");
	env.MISE_CACHE_DIR = join(CODE_DEVELOPMENT_DIR, "mise", "cache");
	env.MISE_STATE_DIR = join(CODE_DEVELOPMENT_DIR, "mise", "state");
	env.MISE_YES = "1";
	if (existsSync(join(CODE_DEVELOPMENT_DIR, "bin", "mise.exe"))) {
		env.GH_CONFIG_DIR = join(CODE_DEVELOPMENT_DIR, "github");
		env.GIT_CONFIG_GLOBAL = join(CODE_DEVELOPMENT_DIR, "gitconfig");
	}
	return env;
}

function createPrivateBashOperations(runtime: PrivateBashRuntime): BashOperations {
	return {
		exec(command, cwd, { onData, signal, timeout, env }) {
			if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
				return Promise.reject(new Error("Invalid timeout: must be a finite number of seconds"));
			}
			return new Promise((resolve, reject) => {
				const child = spawn(runtime.executable, ["sh", "-c", command], {
					cwd,
					env: privateBashEnvironment(runtime.root, env),
					windowsHide: true,
				});
				const decoded = new TextDecoder("utf-8");
				let settled = false;
				let timedOut = false;
				let aborted = false;
				let pending = "";
				const emit = (chunk: Buffer) => {
					// 按行解码转发，避免多字节中文被半个 UTF-8 序列切开时显示乱码。
					pending += decoded.decode(chunk, { stream: true });
					const lastNewline = pending.lastIndexOf("\n");
					if (lastNewline === -1) return;
					const ready = pending.slice(0, lastNewline + 1);
					pending = pending.slice(lastNewline + 1);
					if (ready) onData(Buffer.from(ready, "utf8"));
				};
				const flush = () => {
					pending += decoded.decode();
					if (pending) {
						onData(Buffer.from(pending, "utf8"));
						pending = "";
					}
				};
				child.stdout?.on("data", emit);
				child.stderr?.on("data", emit);
				const timer =
					timeout === undefined
						? undefined
						: setTimeout(
								() => {
									timedOut = true;
									child.kill();
								},
								Math.round(timeout * 1000),
							);
				const onAbort = () => {
					aborted = true;
					child.kill();
				};
				signal?.addEventListener("abort", onAbort, { once: true });
				const settle = (run: () => void) => {
					if (settled) return;
					settled = true;
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					flush();
					run();
				};
				child.on("error", (error) => {
					const code = (error as { code?: unknown }).code;
					settle(() => {
						if (code === "ENOENT") reject(error);
						else reject(new Error(`命令启动失败：${error.message}`));
					});
				});
				child.on("close", (code) => {
					settle(() => {
						if (aborted && signal?.aborted) {
							reject(new Error("aborted"));
							return;
						}
						if (timedOut) {
							reject(new Error(`timeout:${timeout}`));
							return;
						}
						resolve({ exitCode: typeof code === "number" ? code : 1 });
					});
				});
			});
		},
	};
}

function createPrivateBashTool(cwd: string, runtime: PrivateBashRuntime): AnyToolDefinition {
	const definition = createBashToolDefinition(cwd, { operations: createPrivateBashOperations(runtime) });
	return defineTool({
		...definition,
		label: "运行 Bash 命令",
		description:
			"在 Pi 私有的 Bash 兼容环境中运行命令，包含 Git 和常用 Unix 命令。该环境不修改系统 PATH，也不会替换电脑已有的 Git。适合代码、仓库和跨平台脚本任务。",
		promptSnippet: "使用 Pi 私有 Bash 环境运行 Git、代码和常用 Unix 命令",
	});
}

/** Windows 客户端的常驻核心工具；非 Windows 或系统组件缺失时不注册。 */
export function instantiateWindowsTools(ctx: WindowsToolContext): AnyToolDefinition[] {
	const executable = getWindowsPowerShellPath();
	const tools: AnyToolDefinition[] = [];
	const privateBash = getPrivateBashRuntime();
	if (privateBash) tools.push(createPrivateBashTool(ctx.getWorkspaceRoot(), privateBash));
	if (executable) {
		tools.push(
			defineTool({
				name: "powershell",
				label: "运行 Windows 命令",
				description:
					"在当前 Windows 电脑上运行 PowerShell 命令，可检查磁盘、文件夹、进程、网络和系统状态。需要本机诊断时使用本工具；不要因 bash、git 或 rg 不存在就判断没有命令行。",
				promptSnippet: "使用 PowerShell 检查和操作当前 Windows 电脑",
				promptGuidelines: ["当前客户端运行在 Windows；需要检查磁盘、文件、进程或系统状态时使用 powershell。"],
				parameters: Type.Object({
					command: Type.String({ description: "要执行的 PowerShell 命令" }),
					timeout: Type.Optional(Type.Number({ description: "可选超时秒数；默认不限制" })),
				}),
				async execute(_toolCallId, params, signal, onUpdate?): Promise<AgentToolResult<unknown>> {
					let streamed = "";
					let lastEmitAt = 0;
					let emitTimer: NodeJS.Timeout | undefined;
					const emitUpdate = (force = false) => {
						if (!onUpdate) return;
						const now = Date.now();
						const elapsed = now - lastEmitAt;
						if (!force && elapsed < POWERSHELL_UPDATE_THROTTLE_MS) {
							emitTimer ??= setTimeout(() => {
								emitTimer = undefined;
								emitUpdate(true);
							}, POWERSHELL_UPDATE_THROTTLE_MS - elapsed);
							return;
						}
						lastEmitAt = now;
						onUpdate({
							content: streamed ? [{ type: "text", text: streamed }] : [],
							details: { executable },
						});
					};
					try {
						const result = await executePowerShellStreaming(
							executable,
							params.command,
							ctx.getWorkspaceRoot(),
							params.timeout,
							signal,
							(text) => {
								streamed = keepRollingTail(streamed + text);
								emitUpdate();
							},
						);
						if (emitTimer) clearTimeout(emitTimer);
						emitUpdate(true);
						const text = formatResult(result);
						if (result.exitCode !== 0) {
							throw new Error(
								`${text}\n\nPowerShell 命令失败（exit ${result.exitCode ?? "未知"}）：${result.errorMessage}`,
							);
						}
						return { content: [{ type: "text", text }], details: { executable } };
					} finally {
						if (emitTimer) clearTimeout(emitTimer);
					}
				},
			}),
		);
	}
	return tools;
}
