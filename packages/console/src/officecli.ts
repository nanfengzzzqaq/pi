/**
 * OfficeCLI 二进制管理（后端基础设施）。
 *
 * - 二进制位置：data/bin/officecli.exe（Windows）/ officecli（其他平台）
 * - 只检查、不自动下载；下载/更新完全由用户通过接口触发
 * - 下载源：iOfficeAI/OfficeCLI 官方 GitHub Release，按平台选资产，
 *   SHA256 校验（优先 asset.digest，其次 SHA256SUMS），先落临时文件再原子替换，失败保留旧版
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { DATA_DIR, PACKAGE_ROOT } from "./paths.ts";

const execFileAsync = promisify(execFile);

const GITHUB_LATEST = "https://api.github.com/repos/iOfficeAI/OfficeCLI/releases/latest";
const VERSION_TIMEOUT_MS = 5000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

const BIN_DIR = join(DATA_DIR, "bin");
const RECORD_FILE = join(BIN_DIR, "officecli.json");
/** 用户主动卸载后阻止安装包在下次启动时重新预置。 */
const DISABLED_FILE = join(BIN_DIR, "officecli.disabled");

/**
 * 首启引导：安装版把 OfficeCLI 预置在 app/data/bin（随程序分发），
 * 而运行时数据目录外置在 %APPDATA%。目标缺失时把预置副本拷过去，保证装完即用。
 */
export function seedBundledBinary(): boolean {
	const exeName = process.platform === "win32" ? "officecli.exe" : "officecli";
	const bundled = join(PACKAGE_ROOT, "data", "bin", exeName);
	const target = join(BIN_DIR, exeName);
	try {
		if (existsSync(DISABLED_FILE)) return false;
		if (!existsSync(target) && existsSync(bundled)) {
			mkdirSync(BIN_DIR, { recursive: true });
			copyFileSync(bundled, target);
			const bundledRecord = join(PACKAGE_ROOT, "data", "bin", "officecli.json");
			if (existsSync(bundledRecord) && !existsSync(join(BIN_DIR, "officecli.json"))) {
				copyFileSync(bundledRecord, join(BIN_DIR, "officecli.json"));
			}
			return true;
		}
	} catch {
		// 引导失败不阻断启动，用户仍可页面下载
	}
	return false;
}

/** Windows x64: officecli-win-x64.exe；其他平台按官方资产命名 */
function assetName(): string {
	const platform = process.platform;
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	if (platform === "win32") return `officecli-win-${arch}.exe`;
	if (platform === "darwin") return `officecli-mac-${arch}`;
	return `officecli-linux-${arch}`;
}

export function binaryPath(): string {
	return join(BIN_DIR, process.platform === "win32" ? "officecli.exe" : "officecli");
}

/**
 * 让 Pi 的原生 bash 工具也能直接调用 `officecli`。
 * 只修改当前客户端进程及其子进程环境，不写系统 PATH。
 */
export function ensureBinaryOnProcessPath(): void {
	const binDir = dirname(binaryPath());
	const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
	const current = process.env[pathKey] ?? "";
	const entries = current.split(delimiter).filter(Boolean);
	if (entries.some((entry) => entry.toLocaleLowerCase("en-US") === binDir.toLocaleLowerCase("en-US"))) return;
	process.env[pathKey] = current ? `${binDir}${delimiter}${current}` : binDir;
}

interface VersionRecord {
	version: string;
	downloadedAt: string;
	sha256: string;
}

interface ReleaseAsset {
	name: string;
	browser_download_url: string;
	digest?: string;
	size?: number;
}

interface ReleaseInfo {
	tag_name: string;
	/** API 可达时的资产明细；降级路径下为 undefined（资产名可推导、SHA256 用 SHA256SUMS） */
	assets?: ReleaseAsset[];
}

/** 通过 releases/latest 的 302 跳转拿最新 tag（不走 API，匿名限流时仍可用） */
async function fetchLatestTagViaRedirect(): Promise<string | null> {
	try {
		const res = await fetch("https://github.com/iOfficeAI/OfficeCLI/releases/latest", {
			headers: { "User-Agent": "pi-console" },
			redirect: "manual",
			signal: AbortSignal.timeout(15000),
		});
		// 302 是预期信号；其他状态（404 等）无 location 可解析
		const match = res.headers.get("location")?.match(/\/releases\/tag\/([^/]+)$/);
		return match ? decodeURIComponent(match[1]) : null;
	} catch {
		return null;
	}
}

async function fetchLatestRelease(): Promise<ReleaseInfo | null> {
	try {
		const res = await fetch(GITHUB_LATEST, {
			headers: { "User-Agent": "pi-console", Accept: "application/vnd.github+json" },
			signal: AbortSignal.timeout(15000),
		});
		if (res.ok) return (await res.json()) as ReleaseInfo;
		// API 限流（403）或失败：降级到 302 跳转拿 tag
		const tag = await fetchLatestTagViaRedirect();
		return tag ? { tag_name: tag } : null;
	} catch {
		const tag = await fetchLatestTagViaRedirect();
		return tag ? { tag_name: tag } : null;
	}
}

/** 运行 officecli --version，5 秒超时；返回版本串（已去空白），不可用返回 null */
async function probeInstalledVersion(): Promise<string | null> {
	if (!existsSync(binaryPath())) return null;
	try {
		const { stdout } = await execFileAsync(binaryPath(), ["--version"], { timeout: VERSION_TIMEOUT_MS });
		const match = stdout.trim().match(/(\d+\.\d+\.\d+(?:[-+.\w]*)?)/);
		return match ? match[1] : stdout.trim().slice(0, 40) || null;
	} catch {
		return null;
	}
}

export interface OfficeCliStatus {
	installed: boolean;
	version: string | null;
	latestVersion: string | null;
	latestTag: string | null;
	updateAvailable: boolean | null;
	path: string;
}

/** 只探测本机，不访问网络；工具目录页用它避免每次打开都请求 GitHub。 */
export async function getLocalStatus(): Promise<OfficeCliStatus> {
	const version = await probeInstalledVersion();
	return {
		installed: version !== null,
		version,
		latestVersion: null,
		latestTag: null,
		updateAvailable: null,
		path: binaryPath(),
	};
}

export async function getStatus(): Promise<OfficeCliStatus> {
	const version = await probeInstalledVersion();
	const release = await fetchLatestRelease();
	const latestVersion = release ? (release.tag_name || "").replace(/^v/, "") || null : null;
	const installedButRemoteUnknown = version !== null && latestVersion === null;
	return {
		installed: version !== null,
		version,
		latestVersion,
		latestTag: release?.tag_name ?? null,
		// 无法得知 latest 时（网络失败）不确定，返回 null
		updateAvailable: latestVersion === null ? (installedButRemoteUnknown ? null : false) : version !== latestVersion,
		path: binaryPath(),
	};
}

// ---------------------------------------------------------------------------
// 下载（用户触发，带进度）
// ---------------------------------------------------------------------------

export interface DownloadProgress {
	running: boolean;
	phase: "idle" | "downloading" | "verifying" | "replacing";
	receivedBytes: number;
	totalBytes: number | null;
	error: string | null;
	version: string | null;
}

let progress: DownloadProgress = {
	running: false,
	phase: "idle",
	receivedBytes: 0,
	totalBytes: null,
	error: null,
	version: null,
};

export function getDownloadProgress(): DownloadProgress {
	return { ...progress };
}

async function sha256OfFile(path: string): Promise<string> {
	const { createReadStream } = await import("node:fs");
	const hash = createHash("sha256");
	await new Promise<void>((resolve, reject) => {
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("end", () => resolve());
		stream.on("error", reject);
	});
	return hash.digest("hex");
}

/** 从 SHA256SUMS 文本里找对应资产的哈希 */
function hashFromSums(text: string, asset: string): string | null {
	for (const line of text.split("\n")) {
		const match = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
		if (match && match[2].trim() === asset) return match[1].toLowerCase();
	}
	return null;
}

/**
 * 从官方 Release 下载当前平台对应的 OfficeCLI，校验并替换。
 * 同一时间只允许一个下载任务。
 */
export async function downloadLatest(): Promise<void> {
	if (progress.running) return;
	progress = { running: true, phase: "downloading", receivedBytes: 0, totalBytes: null, error: null, version: null };
	try {
		const release = await fetchLatestRelease();
		if (!release?.tag_name) throw new Error("无法获取 OfficeCLI 最新 Release 信息（GitHub 不可达或限流）");

		// 资产名可推导；API 可达时用资产明细（digest/size），否则只依赖 URL 模板 + SHA256SUMS
		const name = assetName();
		const asset = release.assets?.find((a) => a.name === name);
		const downloadUrl =
			asset?.browser_download_url ??
			`https://github.com/iOfficeAI/OfficeCLI/releases/download/${release.tag_name}/${name}`;

		mkdirSync(BIN_DIR, { recursive: true });
		const tempPath = `${binaryPath()}.download`;

		// 流式下载 + 进度
		const res = await fetch(downloadUrl, {
			headers: { "User-Agent": "pi-console" },
			signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
		});
		if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}`);
		const totalBytes = res.headers.has("content-length")
			? Number(res.headers.get("content-length"))
			: (asset?.size ?? null);
		progress.totalBytes = totalBytes;

		const { createWriteStream } = await import("node:fs");
		await new Promise<void>((resolve, reject) => {
			const writer = createWriteStream(tempPath);
			const reader = res.body!.getReader();
			const pump = async (): Promise<void> => {
				try {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						progress.receivedBytes += value.byteLength;
						if (!writer.write(value)) await new Promise<void>((w) => writer.once("drain", () => w()));
					}
					writer.end(() => resolve());
				} catch (error) {
					writer.destroy();
					reject(error);
				}
			};
			void pump();
			writer.on("error", reject);
		});

		// SHA256 校验：优先 asset.digest，其次官方 SHA256SUMS（都拿不到时放弃）
		progress.phase = "verifying";
		let expected: string | null = null;
		if (asset?.digest?.startsWith("sha256:")) {
			expected = asset.digest.slice("sha256:".length).toLowerCase();
		} else {
			const sumsUrl = `https://github.com/iOfficeAI/OfficeCLI/releases/download/${release.tag_name}/SHA256SUMS`;
			const sumsRes = await fetch(sumsUrl, {
				headers: { "User-Agent": "pi-console" },
				signal: AbortSignal.timeout(30000),
			});
			if (sumsRes.ok) expected = hashFromSums(await sumsRes.text(), name);
		}
		if (!expected) {
			unlinkSync(tempPath);
			throw new Error("无法获得官方 SHA256 校验值，已放弃安装");
		}
		const actual = await sha256OfFile(tempPath);
		if (actual !== expected) {
			unlinkSync(tempPath);
			throw new Error(`SHA256 校验失败：期望 ${expected}，实际 ${actual}`);
		}

		// 备份旧版 → 替换 → 写版本记录
		progress.phase = "replacing";
		if (existsSync(binaryPath())) copyFileSync(binaryPath(), `${binaryPath()}.bak`);
		renameSync(tempPath, binaryPath());
		const version = (release.tag_name || "").replace(/^v/, "");
		const record: VersionRecord = { version, downloadedAt: new Date().toISOString(), sha256: expected };
		writeFileSync(RECORD_FILE, `${JSON.stringify(record, null, "\t")}\n`, "utf8");
		if (existsSync(DISABLED_FILE)) unlinkSync(DISABLED_FILE);

		progress = {
			running: false,
			phase: "idle",
			receivedBytes: progress.receivedBytes,
			totalBytes: progress.totalBytes,
			error: null,
			version,
		};
	} catch (error) {
		progress = {
			running: false,
			phase: "idle",
			receivedBytes: 0,
			totalBytes: null,
			error: error instanceof Error ? error.message : String(error),
			version: null,
		};
	}
}

export interface OfficeCliUninstallResult {
	removedFiles: number;
	disabledMarker: string;
}

/**
 * 删除客户端拥有的 OfficeCLI 文件，并写入停用标记。
 * 标记用于区分“首次安装尚未预置”和“用户明确卸载”，避免下次启动自动装回。
 */
export function uninstall(): OfficeCliUninstallResult {
	if (progress.running) throw new Error("OfficeCLI 正在安装，暂时不能卸载");
	let removedFiles = 0;
	for (const path of [binaryPath(), RECORD_FILE, `${binaryPath()}.bak`, `${binaryPath()}.download`]) {
		if (!existsSync(path)) continue;
		unlinkSync(path);
		removedFiles += 1;
	}
	mkdirSync(BIN_DIR, { recursive: true });
	writeFileSync(DISABLED_FILE, `${JSON.stringify({ disabledAt: new Date().toISOString() }, null, "\t")}\n`, "utf8");
	progress = {
		running: false,
		phase: "idle",
		receivedBytes: 0,
		totalBytes: null,
		error: null,
		version: null,
	};
	return { removedFiles, disabledMarker: DISABLED_FILE };
}

/** 二进制是否存在且能跑（供包工具在调用前给出明确错误） */
export async function isBinaryReady(): Promise<boolean> {
	return (await probeInstalledVersion()) !== null;
}

/** 供包工具使用的运行入口：execFile 数组传参，cwd = 会话工作目录 */
export async function runOfficeCli(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
	if (!(await isBinaryReady())) {
		throw new Error("OfficeCLI 未安装，请在页面点击下载");
	}
	try {
		const { stdout, stderr } = await execFileAsync(binaryPath(), args, {
			cwd,
			timeout: 120_000,
			maxBuffer: 20 * 1024 * 1024,
			windowsHide: true,
		});
		return { stdout: truncate(stdout), stderr: truncate(stderr) };
	} catch (error) {
		const err = error as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
		if (err.killed) throw new Error("OfficeCLI 执行超时（120 秒）");
		const detail = [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").trim();
		throw new Error(detail || "OfficeCLI 执行失败");
	}
}

/**
 * 读取 OfficeCLI 二进制内置的完整官方技能。
 * 技能通常有数百行，不能复用普通工具调用的 8KB 输出截断。
 */
export async function loadOfficialSkill(skillName: string): Promise<string> {
	if (!(await isBinaryReady())) {
		throw new Error("OfficeCLI 未安装，请先在工具页安装");
	}
	try {
		const { stdout, stderr } = await execFileAsync(binaryPath(), ["load_skill", skillName], {
			timeout: 30_000,
			maxBuffer: 5 * 1024 * 1024,
			windowsHide: true,
		});
		const content = stdout.trim();
		if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
			throw new Error(stderr.trim() || "OfficeCLI 返回的技能不是标准 SKILL.md");
		}
		return `${content}\n`;
	} catch (error) {
		const err = error as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
		if (err.killed) throw new Error("读取 OfficeCLI 官方技能超时");
		const detail = [err.stderr, err.message].filter(Boolean).join("\n").trim();
		throw new Error(detail || `无法读取 OfficeCLI 官方技能：${skillName}`);
	}
}

function truncate(text: string): string {
	const limit = 8000;
	return text.length > limit ? `${text.slice(0, limit)}\n…(输出已截断，共 ${text.length} 字符)` : text;
}

/** 当前文件大小（诊断用） */
export function binarySize(): number | null {
	try {
		return statSync(binaryPath()).size;
	} catch {
		return null;
	}
}
