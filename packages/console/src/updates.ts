/**
 * 应用自更新（用户触发）：从 GitHub Release 拉取最新 Setup exe，
 * 静默重装（NSIS /S 覆盖安装目录）后自动重启客户端。
 *
 * 更新链：下载到 <DATA_DIR>/update/ → 校验大小和 SHA256 → 记录待更新状态
 * → Electron 主进程直接启动 NSIS → 优雅退出 → NSIS 覆盖安装并重启客户端。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	createReadStream,
	createWriteStream,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { launchDesktopUpdateInstaller } from "./desktop-update-runtime.ts";
import { DATA_DIR, PACKAGE_ROOT } from "./paths.ts";

const REPO = "nanfengzzzqaq/pi";
const GITHUB_LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const UPDATE_DIR = join(DATA_DIR, "update");
const PENDING_UPDATE_FILE = join(UPDATE_DIR, "pending-update.json");

/**
 * electron-builder/NSIS 原生支持的升级参数。直接启动安装包，不再经过容易被
 * Windows 策略或安全软件静默终止的 PowerShell/VBS 中间层。
 */
export const UPDATE_INSTALLER_ARGS = ["--updated", "/S", "--force-run", "/currentuser"] as const;

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

/**
 * 启动时清理历史更新残留。安装包是可重新下载的缓存：除当前待恢复的版本外，
 * 旧安装包立即清理；诊断日志等普通文件仍保留 7 天。
 */
export function cleanupStaleUpdateFiles(maxAgeMs = 7 * 24 * 60 * 60 * 1000, updateDir = UPDATE_DIR): number {
	const pendingFile = join(updateDir, basename(PENDING_UPDATE_FILE));
	const pendingSetup = readPendingUpdate(updateDir)?.setupPath;
	const pendingSetupKey = pendingSetup ? resolve(pendingSetup).toLocaleLowerCase("en-US") : null;
	let removed = 0;
	try {
		for (const name of readdirSync(updateDir)) {
			const file = join(updateDir, name);
			try {
				const stats = statSync(file);
				if (!stats.isFile() || file === pendingFile) continue;
				const managedInstaller = /^Pi.*-Setup-.*\.exe$/iu.test(name);
				const obsoleteInstaller = managedInstaller && resolve(file).toLocaleLowerCase("en-US") !== pendingSetupKey;
				const obsoleteHelper = name === "apply-update.cmd" || name === "apply-update.ps1";
				const incompleteDownload = name.endsWith(".part");
				if (obsoleteInstaller || obsoleteHelper || incompleteDownload || Date.now() - stats.mtimeMs > maxAgeMs) {
					unlinkSync(file);
					removed++;
				}
			} catch {
				/* 单个文件失败不影响其余清理 */
			}
		}
	} catch {
		/* 目录不存在或不可读 */
	}
	return removed;
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

interface ParsedVersion {
	core: number[];
	prerelease: string[] | null;
}

function parseVersion(value: string): ParsedVersion | null {
	const match = value.trim().match(/^v?(\d+(?:\.\d+){1,3})(?:-([0-9A-Za-z.-]+))?$/);
	if (!match) return null;
	const core = match[1].split(".").map(Number);
	if (core.some((part) => !Number.isSafeInteger(part))) return null;
	return { core, prerelease: match[2] ? match[2].split(".") : null };
}

function compareVersions(a: string, b: string): number | null {
	const pa = parseVersion(a);
	const pb = parseVersion(b);
	if (!pa || !pb) return null;
	for (let i = 0; i < Math.max(pa.core.length, pb.core.length); i++) {
		const da = pa.core[i] ?? 0;
		const db = pb.core[i] ?? 0;
		if (da !== db) return da - db;
	}
	if (pa.prerelease === null && pb.prerelease === null) return 0;
	if (pa.prerelease === null) return 1;
	if (pb.prerelease === null) return -1;
	for (let i = 0; i < Math.max(pa.prerelease.length, pb.prerelease.length); i++) {
		const da = pa.prerelease[i];
		const db = pb.prerelease[i];
		if (da === undefined) return -1;
		if (db === undefined) return 1;
		if (da === db) continue;
		const daNumber = /^\d+$/.test(da) ? Number(da) : null;
		const dbNumber = /^\d+$/.test(db) ? Number(db) : null;
		if (daNumber !== null && dbNumber !== null) return daNumber - dbNumber;
		if (daNumber !== null) return -1;
		if (dbNumber !== null) return 1;
		return da.localeCompare(db, "en-US");
	}
	return 0;
}

interface PendingUpdateRecord {
	fromVersion: string;
	targetVersion: string;
	setupPath: string;
	startedAt: number;
	lastError?: string;
}

export interface UpdateRecovery {
	state: "completed" | "failed";
	fromVersion: string;
	targetVersion: string;
	setupPath: string;
	startedAt: number;
	installerAvailable: boolean;
	message: string;
	lastError?: string;
}

function isManagedUpdatePath(path: string, updateDir = UPDATE_DIR): boolean {
	const candidate = resolve(path);
	const root = resolve(updateDir);
	const prefix = root.endsWith(sep) ? root : root + sep;
	const normalizedCandidate = process.platform === "win32" ? candidate.toLocaleLowerCase("en-US") : candidate;
	const normalizedPrefix = process.platform === "win32" ? prefix.toLocaleLowerCase("en-US") : prefix;
	return normalizedCandidate.startsWith(normalizedPrefix) && /^Pi.*-Setup-.*\.exe$/iu.test(basename(candidate));
}

function readPendingUpdate(updateDir = UPDATE_DIR): PendingUpdateRecord | null {
	try {
		const value = JSON.parse(
			readFileSync(join(updateDir, basename(PENDING_UPDATE_FILE)), "utf8"),
		) as Partial<PendingUpdateRecord>;
		if (
			typeof value.fromVersion !== "string" ||
			typeof value.targetVersion !== "string" ||
			typeof value.setupPath !== "string" ||
			typeof value.startedAt !== "number" ||
			!Number.isFinite(value.startedAt) ||
			!isManagedUpdatePath(value.setupPath, updateDir)
		) {
			return null;
		}
		if (value.lastError !== undefined && typeof value.lastError !== "string") return null;
		return value as PendingUpdateRecord;
	} catch {
		return null;
	}
}

function recordPendingFailure(error: unknown): void {
	try {
		const pending = readPendingUpdate();
		if (!pending) return;
		writePendingUpdate({
			...pending,
			lastError: error instanceof Error ? error.message : String(error),
		});
	} catch {
		/* 记录失败原因是尽力而为，不能掩盖原始安装错误。 */
	}
}

function writePendingUpdate(record: PendingUpdateRecord, updateDir = UPDATE_DIR): void {
	mkdirSync(updateDir, { recursive: true });
	const file = join(updateDir, basename(PENDING_UPDATE_FILE));
	const temporary = `${file}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(record, null, "\t")}\n`, "utf8");
	renameSync(temporary, file);
}

/**
 * 新版本启动时核对上一次更新结果。只有实际运行版本达到目标版本，才清理
 * 待更新记录和安装包；仍是旧版本时保留安装包供用户一键重试。
 */
export function reconcilePendingUpdate(updateDir = UPDATE_DIR, currentVersion = APP_VERSION): UpdateRecovery | null {
	const pending = readPendingUpdate(updateDir);
	if (!pending) return null;
	const installerAvailable = existsSync(pending.setupPath);
	const versionComparison = compareVersions(currentVersion, pending.targetVersion);
	if (versionComparison !== null && versionComparison >= 0) {
		try {
			if (installerAvailable) unlinkSync(pending.setupPath);
		} catch {
			/* 安装包清理失败不影响已经成功启动的新版本。 */
		}
		try {
			unlinkSync(join(updateDir, basename(PENDING_UPDATE_FILE)));
		} catch {
			/* 状态文件清理失败不影响已经成功启动的新版本。 */
		}
		return {
			state: "completed",
			...pending,
			installerAvailable: false,
			message: `已成功更新到 v${currentVersion}`,
		};
	}
	return {
		state: "failed",
		...pending,
		installerAvailable,
		message: installerAvailable
			? `上次自动安装 v${pending.targetVersion} 未完成，安装包已保留，可以直接重新安装${pending.lastError ? `（${pending.lastError}）` : ""}`
			: `上次自动安装 v${pending.targetVersion} 未完成，安装包已不存在，请重新下载`,
	};
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

	const versionComparison = compareVersions(APP_VERSION, info.latest);
	if (versionComparison === null) {
		info.latest = null;
		info.error = "github";
		return info;
	}
	info.updateAvailable = versionComparison < 0;
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
	phase: "idle" | "downloading" | "verifying" | "installing";
}

let progress: UpdateProgress = { running: false, receivedBytes: 0, totalBytes: null, error: null, phase: "idle" };
let updateRecovery = reconcilePendingUpdate();

export function getUpdateProgress(): UpdateProgress {
	return { ...progress };
}

export function getUpdateRecovery(): UpdateRecovery | null {
	return updateRecovery ? { ...updateRecovery } : null;
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
	let partialPath: string | null = null;
	try {
		const credential = resolveGithubCredential();
		const info = await checkUpdate({ credential });
		if (!info.assetUrl) throw new Error("无法获得更新包下载地址（GitHub 不可达或 Release 缺少 Setup 资产）");
		if (!info.latest) throw new Error("GitHub Release 没有有效的版本号");
		if (info.updateAvailable === false) throw new Error(`当前已是最新版 v${APP_VERSION}`);

		mkdirSync(UPDATE_DIR, { recursive: true });
		const assetName = basename(info.assetName ?? "PiConsole-Setup.exe");
		if (!/^Pi.*-Setup-.*\.exe$/iu.test(assetName)) throw new Error("GitHub Release 的更新包名称不正确");
		const setupPath = join(UPDATE_DIR, assetName);
		partialPath = `${setupPath}.${process.pid}.${Date.now()}.part`;

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
			const writer = createWriteStream(partialPath!);
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

		progress.phase = "verifying";
		await verifyDownloadedInstaller(partialPath, progress.receivedBytes, progress.totalBytes, info.assetDigest);
		renameSync(partialPath, setupPath);
		partialPath = null;

		progress.phase = "installing";
		writePendingUpdate({
			fromVersion: APP_VERSION,
			targetVersion: info.latest,
			setupPath,
			startedAt: Date.now(),
		});
		updateRecovery = null;
		await launchDesktopUpdateInstaller({
			setupPath,
			args: [...UPDATE_INSTALLER_ARGS],
			targetVersion: info.latest,
		});
	} catch (error) {
		if (partialPath) {
			try {
				rmSync(partialPath, { force: true });
			} catch {
				/* 下次启动会清理未完成的 .part 下载。 */
			}
		}
		progress = {
			running: false,
			receivedBytes: 0,
			totalBytes: null,
			error: error instanceof Error ? error.message : String(error),
			phase: "idle",
		};
		recordPendingFailure(error);
		updateRecovery = reconcilePendingUpdate();
	}
}

/** 对上次失败且安装包仍在的更新重新执行安装，不重复下载。 */
export async function retryPendingUpdate(): Promise<void> {
	if (progress.running) throw new Error("更新任务正在进行");
	const pending = readPendingUpdate();
	if (!pending || !existsSync(pending.setupPath)) throw new Error("没有可重新安装的更新包，请重新检查更新");
	progress = { running: true, receivedBytes: 0, totalBytes: null, error: null, phase: "installing" };
	updateRecovery = null;
	try {
		writePendingUpdate({
			fromVersion: pending.fromVersion,
			targetVersion: pending.targetVersion,
			setupPath: pending.setupPath,
			startedAt: Date.now(),
		});
		await launchDesktopUpdateInstaller({
			setupPath: pending.setupPath,
			args: [...UPDATE_INSTALLER_ARGS],
			targetVersion: pending.targetVersion,
		});
	} catch (error) {
		progress = {
			running: false,
			receivedBytes: 0,
			totalBytes: null,
			error: error instanceof Error ? error.message : String(error),
			phase: "idle",
		};
		recordPendingFailure(error);
		updateRecovery = reconcilePendingUpdate();
		throw error;
	}
}
