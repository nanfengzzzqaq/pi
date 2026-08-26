/**
 * “代码开发”聚合插件。
 *
 * 对外只呈现一个插件；内部用 mise 管理可继续扩展的语言环境，并提供 GitHub CLI、
 * Monaco 编辑器和结构化 Git/GitHub 操作。全部文件保存在 Pi 数据目录，不修改系统 PATH。
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
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
import { dirname, extname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { DATA_DIR, PACKAGE_ROOT } from "./paths.ts";

const execFileAsync = promisify(execFile);
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const PLUGIN_VERSION = "1.0.0";
const PLUGIN_DIR = join(DATA_DIR, "tools", "code-development");
const PLUGIN_BIN_DIR = join(PLUGIN_DIR, "bin");
const PLUGIN_RECORD = join(PLUGIN_DIR, "pi-tool.json");
const COMPONENT_RECORDS_DIR = join(PLUGIN_DIR, "components");
const INSTALLED_SKILL_DIR = join(DATA_DIR, "agent", "skills", "code-development");
const SOURCE_SKILL = join(PACKAGE_ROOT, "skills", "code-development", "SKILL.md");
const PRIVATE_GIT = join(DATA_DIR, "runtime", "mingit", "cmd", "git.exe");
const PRIVATE_BUSYBOX = join(DATA_DIR, "runtime", "mingit", "mingw64", "bin", "busybox.exe");
const MAX_OUTPUT_CHARS = 40_000;

interface ArchiveSpec {
	name: string;
	url: string;
	algorithm: "sha256" | "sha512";
	digest: string;
}

interface PluginRecord {
	version: string;
	installedAt: string;
	sources: string[];
}

interface ComponentRecord {
	id: DeveloperComponentId;
	request: string;
	installedAt: string;
	path: string;
}

export interface DevelopmentProgress {
	running: boolean;
	phase: "idle" | "downloading" | "verifying" | "extracting" | "installing" | "complete" | "failed";
	receivedBytes: number;
	totalBytes: number | null;
	error: string | null;
	log: string;
	startedAt: number | null;
	elapsedMs: number;
}

export type DeveloperComponentId = "node" | "python" | "java" | "go" | "rust" | "dotnet";

export interface DeveloperComponentStatus {
	id: DeveloperComponentId;
	displayName: string;
	description: string;
	request: string;
	markers: string[];
	installed: boolean;
	path: string | null;
	progress: DevelopmentProgress;
}

export interface ProjectEnvironmentDetection {
	componentIds: DeveloperComponentId[];
	reasons: string[];
}

export interface GitHubAccountStatus {
	installed: boolean;
	loggedIn: boolean;
	login: string | null;
	name: string | null;
	error: string | null;
}

export interface RepositorySummary {
	isRepository: boolean;
	root: string | null;
	branch: string | null;
	upstream: string | null;
	files: Array<{ path: string; index: string; worktree: string }>;
	diff: string;
	stagedDiff: string;
}

const CORE_ARCHIVES: ArchiveSpec[] = [
	{
		name: "mise-v2026.8.9-windows-x64.zip",
		url: "https://github.com/jdx/mise/releases/download/v2026.8.9/mise-v2026.8.9-windows-x64.zip",
		algorithm: "sha256",
		digest: "20a7314c3919402ecfe57dab11f85233457fc2738b319f8b26f5fce24daa5109",
	},
	{
		name: "gh_2.97.0_windows_amd64.zip",
		url: "https://github.com/cli/cli/releases/download/v2.97.0/gh_2.97.0_windows_amd64.zip",
		algorithm: "sha256",
		digest: "35d7fe05c4dd1411ffda1e73dfc7c6f44b75c936ca51fa6595c657fdc0350cec",
	},
	{
		name: "monaco-editor-0.56.0.tgz",
		url: "https://registry.npmjs.org/monaco-editor/-/monaco-editor-0.56.0.tgz",
		algorithm: "sha512",
		digest: "sXboRm3BeBeLm938eaiyLMe0OxzfXIlZvbv4ir/jVgQy1zDhWjgmny0WoN45fuDKhCCQsYMbBJrv/A6jd8aCUg==",
	},
];

const COMPONENTS: Record<
	DeveloperComponentId,
	{ displayName: string; description: string; request: string; markers: string[] }
> = {
	node: {
		displayName: "Node.js",
		description: "JavaScript/TypeScript 项目的 Node.js 长期支持版运行环境。",
		request: "node@lts",
		markers: ["package.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"],
	},
	python: {
		displayName: "Python",
		description: "Python 3 运行环境，用于脚本、数据处理和后端项目。",
		request: "python@3",
		markers: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"],
	},
	java: {
		displayName: "Java",
		description: "Java 长期支持版开发环境，兼容 Maven 与 Gradle 项目。",
		request: "java@lts",
		markers: ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"],
	},
	go: {
		displayName: "Go",
		description: "Go 稳定版编译与测试环境。",
		request: "go@latest",
		markers: ["go.mod", "go.work"],
	},
	rust: {
		displayName: "Rust",
		description: "Rust 稳定版工具链，包含 cargo。",
		request: "rust@stable",
		markers: ["Cargo.toml"],
	},
	dotnet: {
		displayName: ".NET",
		description: ".NET 长期支持版 SDK，用于 C#、ASP.NET、WPF 与 WinForms 项目。",
		request: "dotnet@10",
		markers: ["global.json", "Directory.Build.props", "*.sln", "*.csproj", "*.fsproj"],
	},
};

let pluginProgress: DevelopmentProgress = idleProgress();
let githubLoginProgress: DevelopmentProgress = idleProgress();
const componentProgress = new Map<DeveloperComponentId, DevelopmentProgress>();

function idleProgress(): DevelopmentProgress {
	return {
		running: false,
		phase: "idle",
		receivedBytes: 0,
		totalBytes: null,
		error: null,
		log: "",
		startedAt: null,
		elapsedMs: 0,
	};
}

function currentProgress(progress: DevelopmentProgress): DevelopmentProgress {
	return {
		...progress,
		elapsedMs: progress.running && progress.startedAt ? Date.now() - progress.startedAt : progress.elapsedMs,
	};
}

function appendLog(progress: DevelopmentProgress, text: string): DevelopmentProgress {
	const next = `${progress.log}${progress.log ? "\n" : ""}${text}`;
	return { ...progress, log: next.slice(-12_000) };
}

function systemExecutable(name: string): string {
	const windows = process.env.SystemRoot ?? process.env.WINDIR;
	return windows ? join(windows, "System32", name) : name;
}

function findNamedFile(root: string, name: string, depth = 8): string | null {
	if (depth < 0 || !existsSync(root)) return null;
	let entries: Dirent[];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return null;
	}
	for (const entry of entries) {
		if (entry.isFile() && entry.name.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US")) {
			return join(root, entry.name);
		}
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const found = findNamedFile(join(root, entry.name), name, depth - 1);
		if (found) return found;
	}
	return null;
}

async function digestOfFile(path: string, algorithm: "sha256" | "sha512"): Promise<string> {
	const hash = createHash(algorithm);
	await new Promise<void>((resolvePromise, reject) => {
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("end", resolvePromise);
		stream.on("error", reject);
	});
	return algorithm === "sha512" ? hash.digest("base64") : hash.digest("hex");
}

async function downloadArchive(
	spec: ArchiveSpec,
	destination: string,
	onProgress: (progress: DevelopmentProgress) => void,
): Promise<void> {
	let progress = currentProgress(pluginProgress);
	progress = appendLog({ ...progress, phase: "downloading" }, `正在下载 ${spec.name}…`);
	onProgress(progress);
	const response = await fetch(spec.url, {
		headers: { "User-Agent": "pi-console" },
		signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
	});
	if (!response.ok || !response.body) throw new Error(`下载 ${spec.name} 失败：HTTP ${response.status}`);
	const total = Number(response.headers.get("content-length")) || null;
	onProgress({ ...progress, receivedBytes: 0, totalBytes: total });
	mkdirSync(dirname(destination), { recursive: true });
	const writer = createWriteStream(destination);
	// 立即挂 error 监听：磁盘满/文件被占用时若无人监听，未捕获的 'error' 事件会击穿整个进程
	let writeError: Error | null = null;
	writer.on("error", (error) => {
		writeError = error;
	});
	const reader = response.body.getReader();
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) break;
		const state = currentProgress(pluginProgress);
		onProgress({ ...state, receivedBytes: state.receivedBytes + chunk.value.byteLength, totalBytes: total });
		if (!writer.write(chunk.value)) await new Promise<void>((done) => writer.once("drain", done));
		if (writeError) throw writeError;
	}
	await new Promise<void>((done, reject) => {
		writer.end(done);
		writer.on("error", reject);
	});
	progress = appendLog({ ...currentProgress(pluginProgress), phase: "verifying" }, `正在校验 ${spec.name}…`);
	onProgress(progress);
	const actual = await digestOfFile(destination, spec.algorithm);
	if (actual !== spec.digest) throw new Error(`${spec.name} ${spec.algorithm.toUpperCase()} 校验失败`);
}

async function extractArchive(archive: string, destination: string): Promise<void> {
	mkdirSync(destination, { recursive: true });
	await execFileAsync(systemExecutable("tar.exe"), ["-xf", archive, "-C", destination], {
		windowsHide: true,
		timeout: COMMAND_TIMEOUT_MS,
	});
}

function installSkill(): void {
	if (!existsSync(SOURCE_SKILL)) throw new Error("代码开发技能文件缺失");
	mkdirSync(INSTALLED_SKILL_DIR, { recursive: true });
	copyFileSync(SOURCE_SKILL, join(INSTALLED_SKILL_DIR, "SKILL.md"));
}

function readPluginRecord(): PluginRecord | null {
	try {
		return JSON.parse(readFileSync(PLUGIN_RECORD, "utf8")) as PluginRecord;
	} catch {
		return null;
	}
}

function miseExecutable(): string {
	return join(PLUGIN_BIN_DIR, "mise.exe");
}

function ghExecutable(): string {
	return join(PLUGIN_BIN_DIR, "gh.exe");
}

export function isCodeDevelopmentInstalled(): boolean {
	return (
		existsSync(miseExecutable()) &&
		existsSync(ghExecutable()) &&
		existsSync(join(PLUGIN_DIR, "monaco", "package", "min", "vs", "loader.js")) &&
		existsSync(join(INSTALLED_SKILL_DIR, "SKILL.md"))
	);
}

export function getCodeDevelopmentStatus(): { installed: boolean; version: string | null; path: string } {
	return { installed: isCodeDevelopmentInstalled(), version: readPluginRecord()?.version ?? null, path: PLUGIN_DIR };
}

export function getCodeDevelopmentProgress(): DevelopmentProgress {
	return currentProgress(pluginProgress);
}

export function startCodeDevelopmentInstall(): boolean {
	if (pluginProgress.running) return false;
	if (process.platform !== "win32" || process.arch !== "x64") {
		throw new Error("当前代码开发插件安装包适配 Windows x64");
	}
	const startedAt = Date.now();
	pluginProgress = { ...idleProgress(), running: true, phase: "downloading", startedAt, log: "正在准备代码开发插件…" };
	void (async () => {
		const staging = `${PLUGIN_DIR}.installing`;
		try {
			rmSync(staging, { recursive: true, force: true });
			mkdirSync(join(staging, "downloads"), { recursive: true });
			for (const spec of CORE_ARCHIVES) {
				await downloadArchive(spec, join(staging, "downloads", spec.name), (value) => {
					pluginProgress = value;
				});
			}
			pluginProgress = appendLog(
				{ ...currentProgress(pluginProgress), phase: "extracting", receivedBytes: 0, totalBytes: null },
				"正在解压代码开发组件…",
			);
			const expanded = join(staging, "expanded");
			for (const spec of CORE_ARCHIVES) {
				await extractArchive(join(staging, "downloads", spec.name), join(expanded, spec.name));
			}
			const mise = findNamedFile(join(expanded, CORE_ARCHIVES[0].name), "mise.exe");
			const gh = findNamedFile(join(expanded, CORE_ARCHIVES[1].name), "gh.exe");
			const monacoPackage = join(expanded, CORE_ARCHIVES[2].name, "package");
			if (!mise || !gh || !existsSync(join(monacoPackage, "min", "vs", "loader.js"))) {
				throw new Error("代码开发组件解压不完整");
			}
			mkdirSync(join(staging, "bin"), { recursive: true });
			copyFileSync(mise, join(staging, "bin", "mise.exe"));
			copyFileSync(gh, join(staging, "bin", "gh.exe"));
			mkdirSync(join(staging, "monaco"), { recursive: true });
			renameSync(monacoPackage, join(staging, "monaco", "package"));
			rmSync(join(staging, "downloads"), { recursive: true, force: true });
			rmSync(join(staging, "expanded"), { recursive: true, force: true });
			writeFileSync(
				join(staging, "pi-tool.json"),
				`${JSON.stringify(
					{
						version: PLUGIN_VERSION,
						installedAt: new Date().toISOString(),
						sources: CORE_ARCHIVES.map((item) => item.url),
					} satisfies PluginRecord,
					null,
					"\t",
				)}\n`,
				"utf8",
			);
			rmSync(PLUGIN_DIR, { recursive: true, force: true });
			renameSync(staging, PLUGIN_DIR);
			installSkill();
			pluginProgress = {
				...currentProgress(pluginProgress),
				running: false,
				phase: "complete",
				log: "代码开发插件安装完成",
				elapsedMs: Date.now() - startedAt,
			};
		} catch (error) {
			rmSync(staging, { recursive: true, force: true });
			pluginProgress = {
				...currentProgress(pluginProgress),
				running: false,
				phase: "failed",
				error: error instanceof Error ? error.message : String(error),
				elapsedMs: Date.now() - startedAt,
			};
		}
	})();
	return true;
}

export function uninstallCodeDevelopment(): boolean {
	if (
		pluginProgress.running ||
		githubLoginProgress.running ||
		[...componentProgress.values()].some((item) => item.running)
	) {
		throw new Error("代码开发插件仍有安装或登录任务，暂时不能卸载");
	}
	const existed = existsSync(PLUGIN_DIR) || existsSync(INSTALLED_SKILL_DIR);
	rmSync(PLUGIN_DIR, { recursive: true, force: true });
	rmSync(INSTALLED_SKILL_DIR, { recursive: true, force: true });
	pluginProgress = idleProgress();
	componentProgress.clear();
	return existed;
}

export function codeDevelopmentEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env = { ...source };
	const pathKey = Object.keys(env).find((key) => key.toLocaleLowerCase("en-US") === "path") ?? "PATH";
	env[pathKey] = [PLUGIN_BIN_DIR, env[pathKey] ?? ""].filter(Boolean).join(sep === "\\" ? ";" : ":");
	env.MISE_DATA_DIR = join(PLUGIN_DIR, "mise", "data");
	env.MISE_CONFIG_DIR = join(PLUGIN_DIR, "mise", "config");
	env.MISE_CACHE_DIR = join(PLUGIN_DIR, "mise", "cache");
	env.MISE_STATE_DIR = join(PLUGIN_DIR, "mise", "state");
	env.MISE_YES = "1";
	// 登录状态和 Git 全局配置都留在插件目录，避免与电脑上原有 Git/GitHub 环境互相覆盖。
	env.GH_CONFIG_DIR = join(PLUGIN_DIR, "github");
	env.GIT_CONFIG_GLOBAL = join(PLUGIN_DIR, "gitconfig");
	return env;
}

function componentRecordPath(id: DeveloperComponentId): string {
	return join(COMPONENT_RECORDS_DIR, `${id}.json`);
}

function readComponentRecord(id: DeveloperComponentId): ComponentRecord | null {
	try {
		return JSON.parse(readFileSync(componentRecordPath(id), "utf8")) as ComponentRecord;
	} catch {
		return null;
	}
}

export function getDeveloperComponents(): DeveloperComponentStatus[] {
	return (Object.keys(COMPONENTS) as DeveloperComponentId[]).map((id) => {
		const definition = COMPONENTS[id];
		const record = readComponentRecord(id);
		return {
			id,
			...definition,
			installed: Boolean(record?.path && existsSync(record.path)),
			path: record?.path ?? null,
			progress: currentProgress(componentProgress.get(id) ?? idleProgress()),
		};
	});
}

function runWithProgress(
	executable: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	current: () => DevelopmentProgress,
	onProgress: (progress: DevelopmentProgress) => void,
	startedAt: number,
): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		const onData = (data: Buffer): void => {
			const text = data.toString("utf8").trim();
			if (!text) return;
			onProgress(appendLog(currentProgress(current()), text));
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code === 0) resolvePromise();
			else
				reject(
					new Error(
						`命令执行失败（exit ${code ?? "未知"}，已用时 ${Math.floor((Date.now() - startedAt) / 1000)} 秒）`,
					),
				);
		});
	});
}

export function startDeveloperComponentInstall(id: DeveloperComponentId, cwd: string): boolean {
	if (!isCodeDevelopmentInstalled()) throw new Error("请先安装代码开发插件");
	const current = componentProgress.get(id) ?? idleProgress();
	if (current.running) return false;
	const definition = COMPONENTS[id];
	if (!definition) throw new Error(`未知开发环境：${id}`);
	const startedAt = Date.now();
	componentProgress.set(id, {
		...idleProgress(),
		running: true,
		phase: "installing",
		startedAt,
		log: `正在安装 ${definition.displayName}（${definition.request}）…`,
	});
	void (async () => {
		try {
			await runWithProgress(
				miseExecutable(),
				["install", definition.request],
				cwd,
				codeDevelopmentEnvironment(),
				() => componentProgress.get(id) ?? idleProgress(),
				(value) => componentProgress.set(id, value),
				startedAt,
			);
			const where = await execFileAsync(miseExecutable(), ["where", definition.request], {
				cwd,
				env: codeDevelopmentEnvironment(),
				windowsHide: true,
				timeout: COMMAND_TIMEOUT_MS,
			});
			const path = where.stdout.trim();
			if (!path || !existsSync(path)) throw new Error(`${definition.displayName} 安装后未找到运行目录`);
			mkdirSync(COMPONENT_RECORDS_DIR, { recursive: true });
			writeFileSync(
				componentRecordPath(id),
				`${JSON.stringify(
					{
						id,
						request: definition.request,
						installedAt: new Date().toISOString(),
						path,
					} satisfies ComponentRecord,
					null,
					"\t",
				)}\n`,
				"utf8",
			);
			componentProgress.set(id, {
				...currentProgress(componentProgress.get(id) ?? idleProgress()),
				running: false,
				phase: "complete",
				log: `${definition.displayName} 安装完成`,
				elapsedMs: Date.now() - startedAt,
			});
		} catch (error) {
			componentProgress.set(id, {
				...currentProgress(componentProgress.get(id) ?? idleProgress()),
				running: false,
				phase: "failed",
				error: error instanceof Error ? error.message : String(error),
				elapsedMs: Date.now() - startedAt,
			});
		}
	})();
	return true;
}

export async function uninstallDeveloperComponent(id: DeveloperComponentId): Promise<boolean> {
	const progress = componentProgress.get(id);
	if (progress?.running) throw new Error("开发环境正在安装，暂时不能卸载");
	const record = readComponentRecord(id);
	if (!record) return false;
	try {
		await execFileAsync(miseExecutable(), ["uninstall", "--yes", record.request], {
			env: codeDevelopmentEnvironment(),
			windowsHide: true,
			timeout: COMMAND_TIMEOUT_MS,
		});
	} catch {
		/* 记录仍会移除；mise 后续可自行清理失效版本。 */
	}
	rmSync(componentRecordPath(id), { force: true });
	componentProgress.delete(id);
	return true;
}

function matchesWildcard(name: string, marker: string): boolean {
	if (!marker.startsWith("*.")) return name === marker;
	return name.toLocaleLowerCase("en-US").endsWith(marker.slice(1).toLocaleLowerCase("en-US"));
}

export function detectProjectEnvironment(cwd: string): ProjectEnvironmentDetection {
	let names: string[] = [];
	try {
		names = readdirSync(cwd);
	} catch {
		return { componentIds: [], reasons: [] };
	}
	const componentIds: DeveloperComponentId[] = [];
	const reasons: string[] = [];
	for (const [id, definition] of Object.entries(COMPONENTS) as Array<
		[DeveloperComponentId, (typeof COMPONENTS)[DeveloperComponentId]]
	>) {
		const matched = definition.markers.filter((marker) => names.some((name) => matchesWildcard(name, marker)));
		if (matched.length === 0) continue;
		componentIds.push(id);
		reasons.push(`${definition.displayName}：${matched.join("、")}`);
	}
	return { componentIds, reasons };
}

export function getGithubLoginProgress(): DevelopmentProgress {
	return currentProgress(githubLoginProgress);
}

async function runGh(
	args: string[],
	cwd: string,
	timeout = COMMAND_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
	if (!isCodeDevelopmentInstalled()) throw new Error("请先安装代码开发插件");
	return execFileAsync(ghExecutable(), args, {
		cwd,
		env: codeDevelopmentEnvironment(),
		windowsHide: true,
		timeout,
		maxBuffer: 8 * 1024 * 1024,
	});
}

export async function getGithubAccountStatus(_cwd = DATA_DIR): Promise<GitHubAccountStatus> {
	if (!isCodeDevelopmentInstalled())
		return { installed: false, loggedIn: false, login: null, name: null, error: null };
	try {
		const hosts = readFileSync(join(PLUGIN_DIR, "github", "hosts.yml"), "utf8");
		const login = hosts
			.match(/^ {4}user:\s*(.+?)\s*$/m)?.[1]
			?.replace(/^['"]|['"]$/g, "")
			.trim();
		return {
			installed: true,
			loggedIn: Boolean(login && /oauth_token:/m.test(hosts)),
			login: login || null,
			name: null,
			error: null,
		};
	} catch (error) {
		return {
			installed: true,
			loggedIn: false,
			login: null,
			name: null,
			error: existsSync(join(PLUGIN_DIR, "github", "hosts.yml"))
				? error instanceof Error
					? error.message
					: String(error)
				: null,
		};
	}
}

export function startGithubLogin(cwd = DATA_DIR): boolean {
	if (!isCodeDevelopmentInstalled()) throw new Error("请先安装代码开发插件");
	if (githubLoginProgress.running) return false;
	const startedAt = Date.now();
	githubLoginProgress = {
		...idleProgress(),
		running: true,
		phase: "installing",
		startedAt,
		log: "正在打开 GitHub 浏览器登录；如出现设备码，请在浏览器中确认…",
	};
	void (async () => {
		try {
			await new Promise<void>((resolvePromise, reject) => {
				const child = spawn(
					ghExecutable(),
					[
						"auth",
						"login",
						"--hostname",
						"github.com",
						"--git-protocol",
						"https",
						"--web",
						"--clipboard",
						"--insecure-storage",
					],
					{ cwd, env: codeDevelopmentEnvironment(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
				);
				const onData = (data: Buffer): void => {
					const text = data.toString("utf8").trim();
					if (text) githubLoginProgress = appendLog(currentProgress(githubLoginProgress), text);
				};
				child.stdout.on("data", onData);
				child.stderr.on("data", onData);
				child.on("error", reject);
				child.on("exit", (code) =>
					code === 0 ? resolvePromise() : reject(new Error(`GitHub 登录失败（exit ${code}）`)),
				);
			});
			await runGh(["auth", "setup-git"], cwd);
			githubLoginProgress = {
				...currentProgress(githubLoginProgress),
				running: false,
				phase: "complete",
				log: "GitHub 登录完成，Git 推送凭据已连接",
				elapsedMs: Date.now() - startedAt,
			};
		} catch (error) {
			githubLoginProgress = {
				...currentProgress(githubLoginProgress),
				running: false,
				phase: "failed",
				error: error instanceof Error ? error.message : String(error),
				elapsedMs: Date.now() - startedAt,
			};
		}
	})();
	return true;
}

export async function logoutGithub(cwd = DATA_DIR): Promise<void> {
	const account = await getGithubAccountStatus(cwd);
	await runGh(
		["auth", "logout", "--hostname", "github.com", ...(account.login ? ["--user", account.login] : [])],
		cwd,
	);
	githubLoginProgress = idleProgress();
}

function privateGitExecutable(): string {
	if (existsSync(PRIVATE_GIT)) return PRIVATE_GIT;
	return "git";
}

export async function runGit(args: string[], cwd: string, timeout = COMMAND_TIMEOUT_MS): Promise<string> {
	const result = await execFileAsync(privateGitExecutable(), args, {
		cwd,
		env: codeDevelopmentEnvironment(),
		windowsHide: true,
		timeout,
		maxBuffer: 16 * 1024 * 1024,
	});
	const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
	return output.length > MAX_OUTPUT_CHARS
		? `（前面内容已截断）\n${output.slice(-MAX_OUTPUT_CHARS)}`
		: output || "（无输出）";
}

async function optionalGit(args: string[], cwd: string): Promise<string | null> {
	try {
		const output = await runGit(args, cwd, 10_000);
		return output === "（无输出）" ? "" : output;
	} catch {
		return null;
	}
}

async function optionalRawGit(args: string[], cwd: string): Promise<string | null> {
	try {
		const result = await execFileAsync(privateGitExecutable(), args, {
			cwd,
			env: codeDevelopmentEnvironment(),
			windowsHide: true,
			timeout: 10_000,
			maxBuffer: 16 * 1024 * 1024,
		});
		return result.stdout;
	} catch {
		return null;
	}
}

export async function getRepositorySummary(cwd: string): Promise<RepositorySummary> {
	const root = await optionalGit(["rev-parse", "--show-toplevel"], cwd);
	if (!root)
		return { isRepository: false, root: null, branch: null, upstream: null, files: [], diff: "", stagedDiff: "" };
	const branch = await optionalGit(["branch", "--show-current"], cwd);
	const upstream = await optionalGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], cwd);
	// porcelain 的第一个字符可能是空格，不能经过 trim，否则会破坏首个文件的 XY 状态位。
	const porcelain = (await optionalRawGit(["status", "--porcelain=v1", "-z"], cwd)) ?? "";
	const files = porcelain
		.split("\0")
		.filter(Boolean)
		.map((line) => ({ index: line[0] ?? " ", worktree: line[1] ?? " ", path: line.slice(3) }));
	const diff = (await optionalGit(["diff", "--no-ext-diff", "--unified=3"], cwd)) ?? "";
	const stagedDiff = (await optionalGit(["diff", "--cached", "--no-ext-diff", "--unified=3"], cwd)) ?? "";
	return {
		isRepository: true,
		root: root.trim(),
		branch: branch?.trim() || null,
		upstream: upstream?.trim() || null,
		files,
		diff,
		stagedDiff,
	};
}

export async function ensureRepositoryIdentity(cwd: string): Promise<void> {
	const currentName = await optionalGit(["config", "--get", "user.name"], cwd);
	const currentEmail = await optionalGit(["config", "--get", "user.email"], cwd);
	if (currentName && currentEmail) return;
	const result = await runGh(["api", "user", "--jq", "[.id, .login, (.name // .login)] | @tsv"], cwd, 10_000);
	const [id, login, name] = result.stdout.trim().split("\t");
	if (!id || !login) throw new Error("无法读取 GitHub 提交身份");
	if (!currentName) await runGit(["config", "user.name", name || login], cwd);
	if (!currentEmail) await runGit(["config", "user.email", `${id}+${login}@users.noreply.github.com`], cwd);
}

export async function runGithub(args: string[], cwd: string): Promise<string> {
	const result = await runGh(args, cwd);
	const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
	return output.length > MAX_OUTPUT_CHARS
		? `（前面内容已截断）\n${output.slice(-MAX_OUTPUT_CHARS)}`
		: output || "（无输出）";
}

export async function runInDeveloperEnvironment(
	componentId: DeveloperComponentId,
	command: string,
	cwd: string,
): Promise<string> {
	const definition = COMPONENTS[componentId];
	if (!definition) throw new Error(`未知开发环境：${componentId}`);
	if (!readComponentRecord(componentId)) throw new Error(`${definition.displayName} 尚未安装`);
	if (!existsSync(PRIVATE_BUSYBOX)) throw new Error("Pi 私有 Bash 运行时不可用");
	const result = await execFileAsync(
		miseExecutable(),
		["exec", definition.request, "--", PRIVATE_BUSYBOX, "sh", "-lc", command],
		{
			cwd,
			env: codeDevelopmentEnvironment(),
			windowsHide: true,
			timeout: COMMAND_TIMEOUT_MS,
			maxBuffer: 16 * 1024 * 1024,
		},
	);
	const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
	return output.length > MAX_OUTPUT_CHARS
		? `（前面内容已截断）\n${output.slice(-MAX_OUTPUT_CHARS)}`
		: output || "（无输出）";
}

export function resolveMonacoAsset(relativePath: string): { path: string; mimeType: string } | null {
	if (!isCodeDevelopmentInstalled()) return null;
	const root = resolve(PLUGIN_DIR, "monaco", "package", "min");
	const file = resolve(root, relativePath.replace(/^[/\\]+/, ""));
	if (file !== root && !file.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) return null;
	if (!existsSync(file) || !statSync(file).isFile()) return null;
	const mimeTypes: Record<string, string> = {
		".css": "text/css; charset=utf-8",
		".html": "text/html; charset=utf-8",
		".js": "text/javascript; charset=utf-8",
		".json": "application/json; charset=utf-8",
		".svg": "image/svg+xml",
		".ttf": "font/ttf",
		".wasm": "application/wasm",
	};
	return { path: file, mimeType: mimeTypes[extname(file).toLocaleLowerCase("en-US")] ?? "application/octet-stream" };
}

export function codeDevelopmentSkillInfo(): {
	id: string;
	internalName: string;
	displayName: string;
	description: string;
	category: string;
	formats: string[];
	installed: boolean;
	installPath: string;
	requires: string[];
} {
	return {
		id: "code-development-workflow",
		internalName: "code-development-workflow",
		displayName: "代码开发工作流",
		description: "检查项目、建立分支、修改代码、运行验证、审核差异，再按授权提交和推送。",
		category: "代码开发",
		formats: ["Git", "GitHub", "Node.js", "Python", "Java", "Go", "Rust", ".NET"],
		installed: existsSync(join(INSTALLED_SKILL_DIR, "SKILL.md")),
		installPath: INSTALLED_SKILL_DIR,
		requires: [],
	};
}

export function pluginMetadata(): {
	version: string;
	components: DeveloperComponentStatus[];
	project: ProjectEnvironmentDetection;
} {
	return {
		version: PLUGIN_VERSION,
		components: getDeveloperComponents(),
		project: detectProjectEnvironment(DATA_DIR),
	};
}
