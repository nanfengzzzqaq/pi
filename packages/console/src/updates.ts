/**
 * 应用自更新（用户触发）：从 GitHub Release 拉取最新 Setup exe，
 * 静默重装（NSIS /S 覆盖安装目录）后自动重启客户端。
 *
 * 更新链：下载到 <DATA_DIR>/update/ → 校验大小 → 派生独立 cmd 进程
 * （等 2 秒让本进程退出释放 node.exe → 运行 Setup /S → 重启 vbs 启动器）
 * → 本进程 exit。
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
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
	browser_download_url: string;
	size?: number;
	digest?: string;
}

export interface UpdateInfo {
	current: string;
	latest: string | null;
	updateAvailable: boolean | null;
	assetUrl: string | null;
	assetName: string | null;
	assetSize: number | null;
	notes: string | null;
}

/** 通过 302 跳转拿最新 tag（GitHub API 匿名限流时的降级路径） */
async function latestTagViaRedirect(): Promise<string | null> {
	try {
		const res = await fetch(`https://github.com/${REPO}/releases/latest`, {
			headers: { "User-Agent": "pi-console" },
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

export async function checkUpdate(): Promise<UpdateInfo> {
	const info: UpdateInfo = {
		current: APP_VERSION,
		latest: null,
		updateAvailable: null,
		assetUrl: null,
		assetName: null,
		assetSize: null,
		notes: null,
	};

	let tag: string | null = null;
	let assets: ReleaseAsset[] = [];
	try {
		const res = await fetch(GITHUB_LATEST_API, {
			headers: { "User-Agent": "pi-console", Accept: "application/vnd.github+json" },
			signal: AbortSignal.timeout(15000),
		});
		if (res.ok) {
			const release = (await res.json()) as { tag_name?: string; assets?: ReleaseAsset[]; body?: string };
			tag = release.tag_name ?? null;
			assets = release.assets ?? [];
			info.notes = release.body ?? null;
		}
	} catch {
		/* 走降级 */
	}
	if (!tag) tag = await latestTagViaRedirect();

	if (!tag) return info; // 网络不可达：latest 为 null，不确定
	info.latest = tag.replace(/^v/, "");

	const asset = assets.find((a) => /Setup-.*\.exe$/i.test(a.name));
	if (asset) {
		info.assetUrl = asset.browser_download_url;
		info.assetName = asset.name;
		info.assetSize = asset.size ?? null;
	} else {
		// 降级：资产名可推导（Pi控制台-Setup-<version>.exe）
		info.assetName = `Pi控制台-Setup-${info.latest}.exe`;
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

export async function runUpdate(): Promise<void> {
	if (progress.running) return;
	progress = { running: true, receivedBytes: 0, totalBytes: null, error: null, phase: "downloading" };
	try {
		const info = await checkUpdate();
		if (!info.assetUrl) throw new Error("无法获得更新包下载地址（GitHub 不可达或 Release 缺少 Setup 资产）");
		if (info.updateAvailable === false) throw new Error(`当前已是最新版 v${APP_VERSION}`);

		const updateDir = join(DATA_DIR, "update");
		mkdirSync(updateDir, { recursive: true });
		const setupPath = join(updateDir, info.assetName ?? "Pi控制台-Setup.exe");

		const res = await fetch(info.assetUrl, {
			headers: { "User-Agent": "pi-console" },
			signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
		});
		if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}`);
		progress.totalBytes = res.headers.has("content-length")
			? Number(res.headers.get("content-length"))
			: (info.assetSize ?? null);

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

		// 简单完整性检查：实收字节数与 content-length 一致
		if (progress.totalBytes && progress.receivedBytes !== progress.totalBytes) {
			if (existsSync(setupPath)) unlinkSync(setupPath);
			throw new Error(`下载不完整（${progress.receivedBytes}/${progress.totalBytes} 字节）`);
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
 * 派生独立的 cmd：等待 2 秒（本进程退出、node.exe 解锁）→ 静默安装 →
 * 重新运行安装目录里的 vbs 启动器（客户端重开）。
 */
function installAndRestart(setupPath: string): void {
	// PACKAGE_ROOT = <安装目录>\app，启动器在安装目录根部
	const launcher = join(PACKAGE_ROOT, "..", "Pi控制台.vbs");
	const script = `timeout /t 2 /nobreak >nul & "${setupPath}" /S & wscript.exe "${launcher}"`;
	spawn("cmd.exe", ["/c", script], {
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});
	setTimeout(() => process.exit(0), 1500);
}
