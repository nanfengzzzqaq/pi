/**
 * promptfoo 红队引擎管理（后端基础设施）。
 *
 * - 安装位置：data/redteam/node_modules/promptfoo（npm --prefix 安装）
 * - 只检查、不自动安装；安装/更新完全由用户通过接口触发
 * - 来源：npm 官方 registry 的 promptfoo 包；默认锁定 DEFAULT_VERSION，更新时跟随 latest
 * - win32 下 npm.cmd 经 cmd.exe 执行，含空格路径参数必须加引号（本机数据目录在 "kimi work" 下）
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./paths.ts";
import { runToolProcess, ToolProcessError } from "./tool-process.ts";

export const REDTEAM_PACK_NAME = "red-team";
export const DEFAULT_VERSION = "0.122.0";

const INSTALL_DIR = join(DATA_DIR, "redteam");
const VERSION_RECORD = join(INSTALL_DIR, "promptfoo-version.json");
const NPM_AVAILABILITY_TTL_MS = 60_000;

export interface RedTeamStatus {
	installed: boolean;
	version: string | null;
	path: string;
	npmAvailable: boolean;
}

export interface InstallProgress {
	running: boolean;
	error: string | null;
	version: string | null;
	log: string;
	phase: "idle" | "checking" | "installing" | "verifying" | "activating" | "complete" | "failed";
	startedAt: number | null;
	elapsedMs: number;
}

let progress: InstallProgress = {
	running: false,
	error: null,
	version: null,
	log: "",
	phase: "idle",
	startedAt: null,
	elapsedMs: 0,
};

let npmAvailabilityCache: { value: boolean; checkedAt: number } | null = null;
let installTask: Promise<void> | null = null;
let finalizeInstall: () => Promise<void> | void = () => {};

export function registerInstallFinalizer(finalizer: () => Promise<void> | void): void {
	finalizeInstall = finalizer;
}

export async function awaitInstall(): Promise<InstallProgress> {
	await installTask;
	if (progress.error) throw new Error(progress.error);
	return getInstallProgress();
}

export function getInstallProgress(): InstallProgress {
	return {
		...progress,
		elapsedMs: progress.running && progress.startedAt ? Date.now() - progress.startedAt : progress.elapsedMs,
	};
}

/** 定位已安装的 promptfoo CLI 入口（package.json bin 指向的 js 文件） */
export function promptfooBin(): string | null {
	const pkgPath = join(INSTALL_DIR, "node_modules", "promptfoo", "package.json");
	if (!existsSync(pkgPath)) return null;
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
		const bin = typeof pkg.bin === "string" ? pkg.bin : Object.values(pkg.bin ?? {})[0];
		if (typeof bin !== "string") return null;
		const abs = join(INSTALL_DIR, "node_modules", "promptfoo", bin);
		return existsSync(abs) ? abs : null;
	} catch {
		return null;
	}
}

function recordedVersion(): string | null {
	try {
		const rec = JSON.parse(readFileSync(VERSION_RECORD, "utf8"));
		return typeof rec.version === "string" ? rec.version : null;
	} catch {
		return null;
	}
}

function npmCommand(): string {
	return process.platform === "win32" ? "npm.cmd" : "npm";
}

/** shell 模式下含空格/特殊字符的参数加引号，防 cmd.exe 拆分 */
function quoteArgs(args: string[], shell: boolean): string[] {
	if (!shell) return args;
	return args.map((a) => (/[\s&|<>^"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a));
}

async function run(
	file: string,
	args: string[],
	options: { timeoutMs: number; shell?: boolean; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string; code: number | string | null; errorMessage: string }> {
	const shell = options.shell ?? false;
	try {
		const output = await runToolProcess(file, quoteArgs(args, shell), {
			...options,
			shell,
			env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
		});
		return { ...output, code: 0, errorMessage: "" };
	} catch (error) {
		if (options.signal?.aborted) throw new Error("红队引擎安装已取消");
		return {
			stdout: error instanceof ToolProcessError ? error.stdout : "",
			stderr: error instanceof ToolProcessError ? error.stderr : "",
			code: error instanceof ToolProcessError ? error.code : null,
			errorMessage: error instanceof Error ? error.message : String(error),
		};
	}
}

async function probeNpmAvailability(signal?: AbortSignal): Promise<boolean> {
	const r = await run(npmCommand(), ["--version"], { timeoutMs: 15_000, shell: process.platform === "win32", signal });
	return r.code === 0;
}

/** 工具目录短时间内可能重复刷新；缓存环境探测，真正安装前仍强制复查。 */
export async function npmAvailable(
	force = false,
	probe: () => Promise<boolean> = probeNpmAvailability,
	now = Date.now(),
): Promise<boolean> {
	if (!force && npmAvailabilityCache && now - npmAvailabilityCache.checkedAt < NPM_AVAILABILITY_TTL_MS) {
		return npmAvailabilityCache.value;
	}
	const value = await probe();
	npmAvailabilityCache = { value, checkedAt: now };
	return value;
}

export async function getLocalStatus(): Promise<RedTeamStatus> {
	return {
		installed: promptfooBin() !== null,
		version: recordedVersion(),
		path: INSTALL_DIR,
		npmAvailable: await npmAvailable(),
	};
}

/** 版本号/包规格仅允许安全字符，防注入 */
const SAFE_SPEC = /^[@\w.\-/]+$/;

async function probeVersion(signal?: AbortSignal): Promise<string | null> {
	const bin = promptfooBin();
	if (!bin) return null;
	const r = await run(process.execPath, [bin, "--version"], { timeoutMs: 30_000, signal });
	const line = r.stdout.trim().split("\n").pop()?.trim();
	return r.code === 0 && line ? line : null;
}

/**
 * 安装或更新 promptfoo（后台运行，进度用 getInstallProgress 轮询）。
 * update=false 装 DEFAULT_VERSION；update=true 跟随 latest。
 */
export function startInstall(update: boolean, options: { signal?: AbortSignal; version?: string } = {}): boolean {
	if (progress.running) return false;
	options.signal?.throwIfAborted();
	const startedAt = Date.now();
	progress = {
		running: true,
		error: null,
		version: null,
		log: "正在检查 Node.js 与 npm 环境…",
		phase: "checking",
		startedAt,
		elapsedMs: 0,
	};
	installTask = (async () => {
		try {
			if (!(await npmAvailable(true, () => probeNpmAvailability(options.signal)))) {
				throw new Error("未检测到可用的 npm。安装 promptfoo 需要本机有 Node.js 环境。");
			}
			const spec = update ? "promptfoo@latest" : `promptfoo@${options.version || DEFAULT_VERSION}`;
			if (!SAFE_SPEC.test(spec)) throw new Error("版本规格包含非法字符");
			mkdirSync(INSTALL_DIR, { recursive: true });
			progress = { ...progress, phase: "installing", log: `正在从 npm 官方源安装 ${spec}…` };
			const r = await run(npmCommand(), ["install", "--prefix", INSTALL_DIR, spec, "--no-fund", "--no-audit"], {
				timeoutMs: 15 * 60 * 1000,
				shell: process.platform === "win32",
				signal: options.signal,
			});
			if (r.code !== 0 || !promptfooBin()) {
				const detail = (r.stderr || r.stdout || r.errorMessage || "没有返回错误详情").slice(-1500);
				throw new Error(`npm install 失败（exit ${r.code ?? "未知"}）：${detail}`);
			}
			progress = { ...progress, phase: "verifying", log: "文件下载完成，正在验证 promptfoo…" };
			const version = (await probeVersion(options.signal)) ?? "unknown";
			if (version === "unknown") throw new Error("promptfoo 文件已下载，但命令行入口无法启动");
			writeFileSync(
				VERSION_RECORD,
				JSON.stringify({ version, spec, installedAt: new Date().toISOString() }, null, 2),
			);
			options.signal?.throwIfAborted();
			progress = { ...progress, phase: "activating", log: "正在启用红队能力…" };
			await finalizeInstall();
			progress = {
				running: false,
				error: null,
				version,
				log: `安装完成：${version}`,
				phase: "complete",
				startedAt,
				elapsedMs: Date.now() - startedAt,
			};
		} catch (error) {
			progress = {
				running: false,
				error: error instanceof Error ? error.message : String(error),
				version: null,
				log: "安装失败",
				phase: "failed",
				startedAt,
				elapsedMs: Date.now() - startedAt,
			};
		}
	})();
	return true;
}

/** 删除客户端专属的 promptfoo 安装目录；工作区中的配置和报告不在此目录，不会被删除。 */
export function uninstall(installDir = INSTALL_DIR): boolean {
	if (progress.running) throw new Error("红队引擎正在安装，暂时不能卸载");
	const existed = existsSync(installDir);
	rmSync(installDir, { recursive: true, force: true });
	progress = {
		running: false,
		error: null,
		version: null,
		log: "",
		phase: "idle",
		startedAt: null,
		elapsedMs: 0,
	};
	return existed;
}
