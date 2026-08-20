/**
 * 应用自更新（用户触发）：从 GitHub Release 拉取最新 Setup exe，
 * 静默重装（NSIS /S 覆盖安装目录）后自动重启客户端。
 *
 * 更新链：下载到 <DATA_DIR>/update/ → 校验大小和 SHA256 → 派生独立 PowerShell 进程
 * （等 2 秒让本进程退出释放文件 → 运行 Setup /S → 重启当前客户端）
 * → 本进程 exit。
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	createReadStream,
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DATA_DIR, PACKAGE_ROOT } from "./paths.ts";

const REPO = "nanfengzzzqaq/pi";
const GITHUB_LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/** 当前应用版本（staging/app 与开发目录共用同一个 package.json） */
export const APP_VERSION = (() => {
	try {
		const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
		return String(manifest.version ?? "0.0.0");
	} catch {
		return "0.0.0";
	}
})();

interface ReleaseAsset {
	name: string;
	url?: string; // GitHub Assets API 地址（私有仓库下载唯一可靠途径）
	browser_download_url: string;
	size?: number;
	digest?: string;
}

export interface UpdateInfo {
	current: string;
	latest: string | null;
	updateAvailable: boolean | null;
	assetUrl: string | null;
	/** Assets API 地址（带 token 时优先用它下载，私有仓库必需） */
	assetApiUrl: string | null;
	assetName: string | null;
	assetSize: number | null;
	assetDigest: string | null;
	notes: string | null;
	error: "authentication" | "network" | "github" | null;
	httpStatus: number | null;
}

/**
 * 可选的 GitHub 访问令牌（私有仓库的 Release 检查/下载需要；公开仓库无需配置）。
 * 明文存 <DATA_DIR>/agent/github-token.txt，仅本机使用。
 */
const TOKEN_FILE = join(DATA_DIR, "agent", "github-token.txt");

export type GithubAuthSource = "saved" | "environment" | "gh-cli";

export interface GithubCredential {
	token: string;
	source: GithubAuthSource;
}

interface GithubCredentialOptions {
	readSavedToken?: () => string | null;
	environment?: NodeJS.ProcessEnv;
	readCliToken?: () => string | null;
}

function readSavedGithubToken(): string | null {
	try {
		const token = readFileSync(TOKEN_FILE, "utf8").trim();
		return token || null;
	} catch {
		return null;
	}
}

function readGithubCliToken(): string | null {
	try {
		const token = execFileSync("gh", ["auth", "token", "--hostname", "github.com"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 3000,
			windowsHide: true,
		}).trim();
		return token || null;
	} catch {
		return null;
	}
}

/** Resolve GitHub authentication without exposing the token to the browser. */
export function resolveGithubCredential(options: GithubCredentialOptions = {}): GithubCredential | null {
	const readSavedToken = options.readSavedToken ?? readSavedGithubToken;
	const environment = options.environment ?? process.env;
	const readCliToken = options.readCliToken ?? readGithubCliToken;

	const saved = readSavedToken()?.trim();
	if (saved) return { token: saved, source: "saved" };
	const environmentToken = (environment.GH_TOKEN ?? environment.GITHUB_TOKEN)?.trim();
	if (environmentToken) return { token: environmentToken, source: "environment" };
	const cli = readCliToken()?.trim();
	return cli ? { token: cli, source: "gh-cli" } : null;
}

export function githubToken(): string | null {
	return resolveGithubCredential()?.token ?? null;
}

export function githubAuthStatus(): { configured: boolean; source: GithubAuthSource | null; saved: boolean } {
	const credential = resolveGithubCredential();
	return {
		configured: credential !== null,
		source: credential?.source ?? null,
		saved: readSavedGithubToken() !== null,
	};
}

export function setGithubToken(token: string): void {
	mkdirSync(join(DATA_DIR, "agent"), { recursive: true });
	writeFileSync(TOKEN_FILE, token, { encoding: "utf8", mode: 0o600 });
}

export function clearGithubToken(): boolean {
	if (!existsSync(TOKEN_FILE)) return false;
	rmSync(TOKEN_FILE, { force: true });
	return true;
}

/** GitHub 请求公共头（带可选令牌） */
function githubHeaders(credential: GithubCredential | null = resolveGithubCredential()): Record<string, string> {
	const headers: Record<string, string> = { "User-Agent": "pi-console" };
	if (credential) headers.Authorization = `Bearer ${credential.token}`;
	return headers;
}

/** 通过 302 跳转拿最新 tag（GitHub API 匿名限流时的降级路径） */
async function latestTagViaRedirect(
	fetchImpl: typeof fetch,
	credential: GithubCredential | null,
): Promise<string | null> {
	try {
		const res = await fetchImpl(`https://github.com/${REPO}/releases/latest`, {
			headers: githubHeaders(credential),
			redirect: "manual",
			signal: AbortSignal.timeout(15000),
		});
		const match = res.headers.get("location")?.match(/\/releases\/tag\/([^/]+)$/);
		return match ? decodeURIComponent(match[1]) : null;
	} catch {
		return null;
	}
}

function compareVersions(a: string, b: string): number {
	const pa = a.replace(/^v/, "").split(".").map(Number);
	const pb = b.replace(/^v/, "").split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const da = pa[i] ?? 0;
		const db = pb[i] ?? 0;
		if (da !== db) return da - db;
	}
	return 0;
}

interface CheckUpdateOptions {
	fetch?: typeof fetch;
	credential?: GithubCredential | null;
}

export async function checkUpdate(options: CheckUpdateOptions = {}): Promise<UpdateInfo> {
	const fetchImpl = options.fetch ?? fetch;
	const credential = options.credential === undefined ? resolveGithubCredential() : options.credential;
	const info: UpdateInfo = {
		current: APP_VERSION,
		latest: null,
		updateAvailable: null,
		assetUrl: null,
		assetApiUrl: null,
		assetName: null,
		assetSize: null,
		assetDigest: null,
		notes: null,
		error: null,
		httpStatus: null,
	};

	let tag: string | null = null;
	let assets: ReleaseAsset[] = [];
	let networkFailed = false;
	try {
		const res = await fetchImpl(GITHUB_LATEST_API, {
			headers: { ...githubHeaders(credential), Accept: "application/vnd.github+json" },
			signal: AbortSignal.timeout(15000),
		});
		info.httpStatus = res.status;
		if (res.ok) {
			const release = (await res.json()) as { tag_name?: string; assets?: ReleaseAsset[]; body?: string };
			tag = release.tag_name ?? null;
			assets = release.assets ?? [];
			info.notes = release.body ?? null;
		}
	} catch {
		networkFailed = true;
	}
	if (!tag) tag = await latestTagViaRedirect(fetchImpl, credential);

	if (!tag) {
		if (info.httpStatus === 401 || info.httpStatus === 403 || (info.httpStatus === 404 && !credential)) {
			info.error = "authentication";
		} else if (networkFailed || info.httpStatus === null) {
			info.error = "network";
		} else {
			info.error = "github";
		}
		return info;
	}
	info.latest = tag.replace(/^v/, "");

	const asset = assets.find((a) => /Setup-.*\.exe$/i.test(a.name));
	if (asset) {
		info.assetUrl = asset.browser_download_url;
		info.assetApiUrl = asset.url ?? null;
		info.assetName = asset.name;
		info.assetSize = asset.size ?? null;
		info.assetDigest = asset.digest ?? null;
	} else {
		// 降级：发布资产统一使用 ASCII 名称，避免 URL 和 Windows 代码页差异。
		info.assetName = `PiConsole-Setup-${info.latest}.exe`;
		info.assetUrl = `https://github.com/${REPO}/releases/download/${tag}/${encodeURIComponent(info.assetName)}`;
	}

	info.updateAvailable = compareVersions(APP_VERSION, info.latest) < 0;
	return info;
}

// ---------------------------------------------------------------------------
// 下载与安装
// ---------------------------------------------------------------------------

export interface UpdateProgress {
	running: boolean;
	receivedBytes: number;
	totalBytes: number | null;
	error: string | null;
	phase: "idle" | "downloading" | "installing";
}

let progress: UpdateProgress = { running: false, receivedBytes: 0, totalBytes: null, error: null, phase: "idle" };

export function getUpdateProgress(): UpdateProgress {
	return { ...progress };
}

export interface UpdateRelaunchTarget {
	path: string;
	source: "current-electron" | "default-electron" | "legacy-launcher";
}

interface RelaunchTargetOptions {
	electronRuntime?: boolean;
	currentExecutable?: string;
	localAppData?: string;
	packageRoot?: string;
	pathExists?: (path: string) => boolean;
}

/**
 * 确定安装完成后的真实启动目标。Electron 必须优先使用当前进程路径，
 * 因为安装器允许用户把客户端安装到任意磁盘。
 */
export function resolveUpdateRelaunchTarget(options: RelaunchTargetOptions = {}): UpdateRelaunchTarget | null {
	const pathExists = options.pathExists ?? existsSync;
	const electronRuntime = options.electronRuntime ?? Boolean(process.versions.electron);
	const currentExecutable = options.currentExecutable ?? process.execPath;
	if (electronRuntime && pathExists(currentExecutable)) {
		return { path: currentExecutable, source: "current-electron" };
	}

	const localAppData = options.localAppData ?? process.env.LOCALAPPDATA;
	if (localAppData) {
		const defaultElectron = join(localAppData, "Programs", "PiConsole", "PiConsole.exe");
		if (pathExists(defaultElectron)) return { path: defaultElectron, source: "default-electron" };
	}

	const legacyLauncher = join(options.packageRoot ?? PACKAGE_ROOT, "..", "launcher.vbs");
	if (pathExists(legacyLauncher)) return { path: legacyLauncher, source: "legacy-launcher" };
	return null;
}

function powerShellLiteral(value: string): string {
	if (/[\0\r\n]/.test(value)) throw new Error("更新路径包含不支持的控制字符");
	return `'${value.replaceAll("'", "''")}'`;
}

/** 生成带 UTF-8 BOM 的更新辅助脚本，确保中文和自定义磁盘路径不会被 cmd 代码页破坏。 */
export function buildUpdateHelperScript(
	setupPath: string,
	relaunchTarget: UpdateRelaunchTarget,
	errorLogPath: string,
): string {
	return (
		"\uFEFF" +
		[
			"$ErrorActionPreference = 'Stop'",
			`$setupPath = ${powerShellLiteral(setupPath)}`,
			`$relaunchPath = ${powerShellLiteral(relaunchTarget.path)}`,
			`$errorLogPath = ${powerShellLiteral(errorLogPath)}`,
			"Remove-Item -LiteralPath $errorLogPath -Force -ErrorAction SilentlyContinue",
			"Start-Sleep -Seconds 2",
			"try {",
			"\t$installer = Start-Process -FilePath $setupPath -ArgumentList '/S' -PassThru -Wait",
			'\tif ($installer.ExitCode -ne 0) { throw "安装程序退出码：$($installer.ExitCode)" }',
			'\tif (-not (Test-Path -LiteralPath $relaunchPath -PathType Leaf)) { throw "更新完成，但启动文件不存在：$relaunchPath" }',
			"\tStart-Process -FilePath $relaunchPath",
			"} catch {",
			"\t($_ | Out-String) | Set-Content -LiteralPath $errorLogPath -Encoding UTF8",
			"}",
			"",
		].join("\r\n")
	);
}

/** 对下载结果同时校验传输长度和 GitHub Release 返回的 SHA256。 */
export async function verifyDownloadedInstaller(
	path: string,
	receivedBytes: number,
	expectedBytes: number | null,
	expectedDigest: string | null,
): Promise<void> {
	if (expectedBytes !== null && receivedBytes !== expectedBytes) {
		throw new Error(`下载不完整（${receivedBytes}/${expectedBytes} 字节）`);
	}
	if (!expectedDigest) return;
	const match = expectedDigest.match(/^sha256:([0-9a-f]{64})$/i);
	if (!match) throw new Error(`更新包校验算法不受支持：${expectedDigest.split(":", 1)[0]}`);
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	const actual = hash.digest("hex");
	if (actual.toLowerCase() !== match[1].toLowerCase()) {
		throw new Error(`更新包 SHA256 校验失败（期望 ${match[1]}，实际 ${actual}）`);
	}
}

export async function runUpdate(): Promise<void> {
	if (progress.running) return;
	progress = { running: true, receivedBytes: 0, totalBytes: null, error: null, phase: "downloading" };
	try {
		const credential = resolveGithubCredential();
		const info = await checkUpdate({ credential });
		if (!info.assetUrl) throw new Error("无法获得更新包下载地址（GitHub 不可达或 Release 缺少 Setup 资产）");
		if (info.updateAvailable === false) throw new Error(`当前已是最新版 v${APP_VERSION}`);

		const updateDir = join(DATA_DIR, "update");
		mkdirSync(updateDir, { recursive: true });
		const setupPath = join(updateDir, info.assetName ?? "Pi控制台-Setup.exe");

		// 带 token 时优先走 Assets API（私有仓库 browser_download_url 直链会 404）；
		// 无 token（公开仓库）用 browser_download_url 直链
		const downloadUrl = credential && info.assetApiUrl ? info.assetApiUrl : info.assetUrl;
		const downloadHeaders = githubHeaders(credential);
		if (downloadUrl === info.assetApiUrl) downloadHeaders.Accept = "application/octet-stream";

		const res = await fetch(downloadUrl, {
			headers: downloadHeaders,
			signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
		});
		if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}`);
		const responseLengthHeader = res.headers.get("content-length");
		const responseLength = responseLengthHeader === null ? null : Number(responseLengthHeader);
		progress.totalBytes =
			typeof responseLength === "number" && Number.isSafeInteger(responseLength) && responseLength >= 0
				? responseLength
				: info.assetSize;

		await new Promise<void>((resolve, reject) => {
			const writer = createWriteStream(setupPath);
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

		try {
			await verifyDownloadedInstaller(setupPath, progress.receivedBytes, progress.totalBytes, info.assetDigest);
		} catch (error) {
			if (existsSync(setupPath)) unlinkSync(setupPath);
			throw error;
		}

		progress.phase = "installing";
		installAndRestart(setupPath);
		// 不在这里 exit：给 HTTP 响应留时间，由派生进程的 2 秒延迟兜底
	} catch (error) {
		progress = {
			running: false,
			receivedBytes: 0,
			totalBytes: null,
			error: error instanceof Error ? error.message : String(error),
			phase: "idle",
		};
	}
}

/**
 * 派生独立 PowerShell 进程执行更新收尾：等 2 秒释放当前程序 → 静默安装 →
 * 从原安装位置重新启动。VBS 仅用于确实存在的旧版客户端。
 */
function installAndRestart(setupPath: string): void {
	const relaunchTarget = resolveUpdateRelaunchTarget();
	if (!relaunchTarget) throw new Error("无法确定更新后的客户端启动位置，请下载最新安装包手动更新");
	const updateDir = join(DATA_DIR, "update");
	const helperPath = join(updateDir, "apply-update.ps1");
	const errorLogPath = join(updateDir, "update-error.log");
	const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
	if (!systemRoot) throw new Error("无法定位 Windows PowerShell");
	const powerShell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	if (!existsSync(powerShell)) throw new Error(`Windows PowerShell 不存在：${powerShell}`);
	writeFileSync(helperPath, buildUpdateHelperScript(setupPath, relaunchTarget, errorLogPath), "utf8");
	const child = spawn(
		powerShell,
		["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helperPath],
		{
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		},
	);
	child.once("spawn", () => {
		child.unref();
		setTimeout(() => process.exit(0), 1500);
	});
	child.once("error", (error) => {
		progress = {
			running: false,
			receivedBytes: 0,
			totalBytes: null,
			error: `无法启动更新辅助程序：${error.message}`,
			phase: "idle",
		};
	});
}
