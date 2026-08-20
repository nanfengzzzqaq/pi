/**
 * 可选文件工具的私有安装与运行。
 * 所有文件都落在 Pi 数据目录，不写系统 PATH，不注册文件关联，也不覆盖本机已有软件。
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	createReadStream,
	createWriteStream,
	type Dirent,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { DATA_DIR } from "./paths.ts";

const execFileAsync = promisify(execFile);
const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000;
const TOOLS_DIR = join(DATA_DIR, "tools");

export type ManagedToolId = "pdfjs" | "sevenzip" | "ocr" | "libreoffice";

export interface ManagedToolProgress {
	running: boolean;
	phase: "idle" | "downloading" | "verifying" | "extracting" | "installing" | "complete" | "failed";
	receivedBytes: number;
	totalBytes: number | null;
	error: string | null;
	version: string | null;
	log: string;
	startedAt: number | null;
	elapsedMs: number;
}

export interface ManagedToolStatus {
	installed: boolean;
	version: string | null;
	path: string;
}

interface DownloadSpec {
	url: string;
	sha256: string;
	fileName: string;
}

interface ToolRecord {
	version: string;
	installedAt: string;
	source: string;
}

const progressById = new Map<ManagedToolId, ManagedToolProgress>();

function idleProgress(): ManagedToolProgress {
	return {
		running: false,
		phase: "idle",
		receivedBytes: 0,
		totalBytes: null,
		error: null,
		version: null,
		log: "",
		startedAt: null,
		elapsedMs: 0,
	};
}

function toolDir(id: ManagedToolId): string {
	return join(TOOLS_DIR, id);
}

function recordPath(id: ManagedToolId): string {
	return join(toolDir(id), "pi-tool.json");
}

function readRecord(id: ManagedToolId): ToolRecord | null {
	try {
		return JSON.parse(readFileSync(recordPath(id), "utf8")) as ToolRecord;
	} catch {
		return null;
	}
}

function readyPath(id: ManagedToolId): string {
	if (id === "pdfjs") return join(toolDir(id), "web", "viewer.html");
	if (id === "sevenzip") return join(toolDir(id), "7z.exe");
	if (id === "ocr") return join(toolDir(id), "tesseract.exe");
	return findNamedFile(toolDir(id), "soffice.exe") ?? join(toolDir(id), "program", "soffice.exe");
}

function findNamedFile(root: string, name: string, depth = 5): string | null {
	if (depth < 0 || !existsSync(root)) return null;
	let entries: Dirent[];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return null;
	}
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isFile() && entry.name.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US")) return path;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const found = findNamedFile(join(root, entry.name), name, depth - 1);
		if (found) return found;
	}
	return null;
}

export function getManagedToolStatus(id: ManagedToolId): ManagedToolStatus {
	const record = readRecord(id);
	return { installed: existsSync(readyPath(id)), version: record?.version ?? null, path: toolDir(id) };
}

export function getManagedToolProgress(id: ManagedToolId): ManagedToolProgress {
	const progress = progressById.get(id) ?? idleProgress();
	return {
		...progress,
		elapsedMs: progress.running && progress.startedAt ? Date.now() - progress.startedAt : progress.elapsedMs,
	};
}

async function sha256OfFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	await new Promise<void>((resolvePromise, reject) => {
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("end", resolvePromise);
		stream.on("error", reject);
	});
	return hash.digest("hex");
}

async function download(id: ManagedToolId, spec: DownloadSpec, destination: string): Promise<void> {
	const current = progressById.get(id) ?? idleProgress();
	progressById.set(id, {
		...current,
		phase: "downloading",
		receivedBytes: 0,
		totalBytes: null,
		log: `正在下载 ${spec.fileName}…`,
	});
	const response = await fetch(spec.url, {
		headers: { "User-Agent": "pi-console" },
		signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
	});
	if (!response.ok || !response.body) throw new Error(`下载 ${spec.fileName} 失败：HTTP ${response.status}`);
	const totalBytes = Number(response.headers.get("content-length")) || null;
	progressById.set(id, { ...getManagedToolProgress(id), totalBytes });
	mkdirSync(dirname(destination), { recursive: true });
	const writer = createWriteStream(destination);
	const reader = response.body.getReader();
	await new Promise<void>((resolvePromise, reject) => {
		const pump = async (): Promise<void> => {
			try {
				for (;;) {
					const chunk = await reader.read();
					if (chunk.done) break;
					const currentProgress = getManagedToolProgress(id);
					progressById.set(id, {
						...currentProgress,
						receivedBytes: currentProgress.receivedBytes + chunk.value.byteLength,
					});
					if (!writer.write(chunk.value)) await new Promise<void>((done) => writer.once("drain", done));
				}
				writer.end(resolvePromise);
			} catch (error) {
				writer.destroy();
				reject(error);
			}
		};
		void pump();
		writer.on("error", reject);
	});
	progressById.set(id, { ...getManagedToolProgress(id), phase: "verifying", log: `正在校验 ${spec.fileName}…` });
	const actual = await sha256OfFile(destination);
	if (actual !== spec.sha256) throw new Error(`${spec.fileName} SHA256 校验失败`);
}

function writeRecord(id: ManagedToolId, version: string, source: string): void {
	writeFileSync(
		recordPath(id),
		`${JSON.stringify({ version, installedAt: new Date().toISOString(), source } satisfies ToolRecord, null, "\t")}\n`,
		"utf8",
	);
}

function systemExecutable(name: string): string {
	const windows = process.env.SystemRoot ?? process.env.WINDIR;
	return windows ? join(windows, "System32", name) : name;
}

async function installPdfJs(id: ManagedToolId, staging: string): Promise<{ version: string; source: string }> {
	const version = "6.2.108";
	const source = `https://github.com/mozilla/pdf.js/releases/download/v${version}/pdfjs-${version}-dist.zip`;
	const archive = join(staging, "pdfjs.zip");
	await download(
		id,
		{
			url: source,
			sha256: "7bf642d59582b475e8c48447da9b02b0108fad9742d7c2a35cb4ed6dd45e95ba",
			fileName: basename(source),
		},
		archive,
	);
	progressById.set(id, { ...getManagedToolProgress(id), phase: "extracting", log: "正在解压 PDF.js…" });
	await execFileAsync(systemExecutable("tar.exe"), ["-xf", archive, "-C", staging], { windowsHide: true });
	return { version, source };
}

async function installSevenZip(id: ManagedToolId, staging: string): Promise<{ version: string; source: string }> {
	const version = "26.02";
	const bootstrap = join(staging, "7zr.exe");
	const installer = join(staging, "7zip-x64.exe");
	const source = "https://github.com/ip7z/7zip/releases/download/26.02/7z2602-x64.exe";
	await download(
		id,
		{
			url: "https://github.com/ip7z/7zip/releases/download/26.02/7zr.exe",
			sha256: "56b8cc9f4971cef253644fafe54063ed7fdca551d4dee0f8c6baa81b855acd72",
			fileName: "7zr.exe",
		},
		bootstrap,
	);
	await download(
		id,
		{
			url: source,
			sha256: "6745fa76dc2ea031596d8678f6f6b99c3c1b435b4164a63485adbbc7b8d82ef0",
			fileName: "7z2602-x64.exe",
		},
		installer,
	);
	progressById.set(id, { ...getManagedToolProgress(id), phase: "extracting", log: "正在解压 7-Zip 私有运行时…" });
	await execFileAsync(bootstrap, ["x", installer, `-o${staging}`, "-y"], { windowsHide: true });
	return { version, source };
}

async function ensureSevenZipForOcr(): Promise<string> {
	if (!getManagedToolStatus("sevenzip").installed) {
		if (!startManagedToolInstall("sevenzip")) throw new Error("7-Zip 正在被另一个任务安装");
		while (getManagedToolProgress("sevenzip").running) {
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
		}
		const failed = getManagedToolProgress("sevenzip").error;
		if (failed) throw new Error(`OCR 的 7-Zip 依赖安装失败：${failed}`);
	}
	return readyPath("sevenzip");
}

async function installOcr(id: ManagedToolId, staging: string): Promise<{ version: string; source: string }> {
	const sevenZip = await ensureSevenZipForOcr();
	const version = "5.5.3";
	const source =
		"https://github.com/tesseract-ocr/tesseract/releases/download/5.5.3/tesseract-ocr-w64-setup-5.5.3.20260724.exe";
	const installer = join(staging, "tesseract-installer.exe");
	await download(
		id,
		{
			url: source,
			sha256: "bee9e3434bd94fd65387d9be28cd467a41f61b1275383b55b0f59a1331270ae4",
			fileName: basename(source),
		},
		installer,
	);
	progressById.set(id, { ...getManagedToolProgress(id), phase: "extracting", log: "正在解压 OCR 引擎…" });
	await execFileAsync(sevenZip, ["x", installer, `-o${staging}`, "-y"], { windowsHide: true });
	const dataCommit = "87416418657359cb625c412a48b6e1d6d41c29bd";
	for (const language of [
		{ name: "eng", sha256: "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2" },
		{ name: "chi_sim", sha256: "a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730" },
	]) {
		const url = `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${dataCommit}/${language.name}.traineddata`;
		await download(
			id,
			{ url, sha256: language.sha256, fileName: `${language.name}.traineddata` },
			join(staging, "tessdata", `${language.name}.traineddata`),
		);
	}
	rmSync(join(staging, "$PLUGINSDIR"), { recursive: true, force: true });
	return { version, source };
}

async function installLibreOffice(id: ManagedToolId, staging: string): Promise<{ version: string; source: string }> {
	progressById.set(id, { ...getManagedToolProgress(id), phase: "downloading", log: "正在查询 LibreOffice 稳定版本…" });
	const stableResponse = await fetch("https://download.documentfoundation.org/libreoffice/stable/", {
		headers: { "User-Agent": "pi-console" },
		signal: AbortSignal.timeout(30_000),
	});
	if (!stableResponse.ok) throw new Error(`查询 LibreOffice 稳定版本失败：HTTP ${stableResponse.status}`);
	const versions = [...(await stableResponse.text()).matchAll(/href="(\d+\.\d+\.\d+)\//g)].map((match) => match[1]);
	versions.sort((left, right) => {
		const leftParts = left.split(".").map(Number);
		const rightParts = right.split(".").map(Number);
		for (let index = 0; index < 3; index++) {
			const delta = (rightParts[index] ?? 0) - (leftParts[index] ?? 0);
			if (delta !== 0) return delta;
		}
		return 0;
	});
	const version = versions[0];
	if (!version) throw new Error("LibreOffice 官方稳定目录中没有可用版本");
	const source = `https://download.documentfoundation.org/libreoffice/stable/${version}/win/x86_64/LibreOffice_${version}_Win_x86-64.msi`;
	const installer = join(dirname(staging), `LibreOffice-${version}.msi`);
	const current = getManagedToolProgress(id);
	progressById.set(id, { ...current, phase: "downloading", log: "正在从 LibreOffice 官方站点下载…" });
	const response = await fetch(source, {
		headers: { "User-Agent": "pi-console" },
		signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
	});
	if (!response.ok || !response.body) throw new Error(`下载 LibreOffice 失败：HTTP ${response.status}`);
	const writer = createWriteStream(installer);
	const reader = response.body.getReader();
	progressById.set(id, {
		...getManagedToolProgress(id),
		totalBytes: Number(response.headers.get("content-length")) || null,
	});
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) break;
		const state = getManagedToolProgress(id);
		progressById.set(id, { ...state, receivedBytes: state.receivedBytes + chunk.value.byteLength });
		if (!writer.write(chunk.value)) await new Promise<void>((done) => writer.once("drain", done));
	}
	await new Promise<void>((done, reject) => {
		writer.end(done);
		writer.on("error", reject);
	});
	progressById.set(id, {
		...getManagedToolProgress(id),
		phase: "verifying",
		log: "正在验证 LibreOffice 官方数字签名…",
	});
	const powershell = systemExecutable(join("WindowsPowerShell", "v1.0", "powershell.exe"));
	const signature = await execFileAsync(
		powershell,
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`(Get-AuthenticodeSignature -LiteralPath '${installer.replace(/'/g, "''")}').Status`,
		],
		{ windowsHide: true },
	);
	if (signature.stdout.trim() !== "Valid") throw new Error("LibreOffice 安装包数字签名无效，已停止安装");
	progressById.set(id, {
		...getManagedToolProgress(id),
		phase: "installing",
		log: "正在创建 LibreOffice 私有运行时…",
	});
	await execFileAsync(
		systemExecutable("msiexec.exe"),
		["/a", installer, "/qn", `TARGETDIR=${staging}`, "/norestart"],
		{
			windowsHide: true,
			timeout: 15 * 60 * 1000,
		},
	);
	return { version, source };
}

export function startManagedToolInstall(id: ManagedToolId): boolean {
	if (getManagedToolProgress(id).running) return false;
	if (process.platform !== "win32") throw new Error("当前版本的可选文件工具安装仅适配 Windows");
	const startedAt = Date.now();
	progressById.set(id, {
		...idleProgress(),
		running: true,
		phase: "downloading",
		startedAt,
		log: "正在准备安装…",
	});
	void (async () => {
		const target = toolDir(id);
		const staging = `${target}.installing`;
		try {
			rmSync(staging, { recursive: true, force: true });
			mkdirSync(staging, { recursive: true });
			const result =
				id === "pdfjs"
					? await installPdfJs(id, staging)
					: id === "sevenzip"
						? await installSevenZip(id, staging)
						: id === "ocr"
							? await installOcr(id, staging)
							: await installLibreOffice(id, staging);
			if (
				!existsSync(
					id === "pdfjs"
						? join(staging, "web", "viewer.html")
						: id === "sevenzip"
							? join(staging, "7z.exe")
							: id === "ocr"
								? join(staging, "tesseract.exe")
								: (findNamedFile(staging, "soffice.exe") ?? join(staging, "program", "soffice.exe")),
				)
			) {
				throw new Error("安装文件不完整，未找到程序入口");
			}
			rmSync(target, { recursive: true, force: true });
			renameSync(staging, target);
			writeRecord(id, result.version, result.source);
			progressById.set(id, {
				...getManagedToolProgress(id),
				running: false,
				phase: "complete",
				version: result.version,
				log: "安装完成",
				elapsedMs: Date.now() - startedAt,
			});
		} catch (error) {
			rmSync(staging, { recursive: true, force: true });
			progressById.set(id, {
				...getManagedToolProgress(id),
				running: false,
				phase: "failed",
				error: error instanceof Error ? error.message : String(error),
				log: "安装失败",
				elapsedMs: Date.now() - startedAt,
			});
		}
	})();
	return true;
}

export function uninstallManagedTool(id: ManagedToolId): boolean {
	if (getManagedToolProgress(id).running) throw new Error("工具正在安装，暂时不能卸载");
	const target = toolDir(id);
	const existed = existsSync(target);
	rmSync(target, { recursive: true, force: true });
	progressById.set(id, idleProgress());
	return existed;
}

export function resolvePdfJsAsset(relativePath: string): { path: string; mimeType: string } | null {
	if (!getManagedToolStatus("pdfjs").installed) return null;
	const root = resolve(toolDir("pdfjs"));
	const file = resolve(root, relativePath.replace(/^[/\\]+/, ""));
	if (file !== root && !file.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) return null;
	if (!existsSync(file) || !statSync(file).isFile()) return null;
	const mimeType: Record<string, string> = {
		".css": "text/css; charset=utf-8",
		".html": "text/html; charset=utf-8",
		".js": "text/javascript; charset=utf-8",
		".mjs": "text/javascript; charset=utf-8",
		".json": "application/json; charset=utf-8",
		".pdf": "application/pdf",
		".png": "image/png",
		".svg": "image/svg+xml",
		".wasm": "application/wasm",
		".woff2": "font/woff2",
	};
	return { path: file, mimeType: mimeType[extname(file).toLocaleLowerCase("en-US")] ?? "application/octet-stream" };
}

export async function runSevenZip(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
	if (!getManagedToolStatus("sevenzip").installed) throw new Error("7-Zip 未安装，请先在工具页安装");
	return execFileAsync(readyPath("sevenzip"), args, {
		cwd,
		windowsHide: true,
		timeout: 5 * 60 * 1000,
		maxBuffer: 16 * 1024 * 1024,
	});
}

export async function runOcr(path: string, language: string, cwd: string): Promise<string> {
	if (!getManagedToolStatus("ocr").installed) throw new Error("OCR 文字识别未安装，请先在工具页安装");
	const result = await execFileAsync(readyPath("ocr"), [path, "stdout", "-l", language, "--psm", "3"], {
		cwd,
		env: { ...process.env, TESSDATA_PREFIX: join(toolDir("ocr"), "tessdata") },
		windowsHide: true,
		timeout: 5 * 60 * 1000,
		maxBuffer: 16 * 1024 * 1024,
	});
	return result.stdout;
}

export async function convertDocument(input: string, format: string, outputDir: string, cwd: string): Promise<string> {
	if (!getManagedToolStatus("libreoffice").installed) throw new Error("LibreOffice 兼容转换未安装，请先在工具页安装");
	const profile = join(toolDir("libreoffice"), "profile").replace(/\\/g, "/");
	const result = await execFileAsync(
		readyPath("libreoffice"),
		["--headless", `-env:UserInstallation=file:///${profile}`, "--convert-to", format, "--outdir", outputDir, input],
		{ cwd, windowsHide: true, timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 },
	);
	return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n") || "转换完成";
}

export function relativePdfJsAssetPath(file: string): string {
	return relative(toolDir("pdfjs"), file).replace(/\\/g, "/");
}
