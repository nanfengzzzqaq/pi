/**
 * 能力包框架：扫描 packages/console/packs/，加载并校验每个包，
 * 管理全局启用状态，并根据各包自己的清单按本轮选择最小工具组。
 *
 * 核心只认识通用的 activation/toolGroups 字段，不判断 Office 或其他具体业务。
 * 新增能力时把触发词、文件扩展名和工具分组写进 pack.json 即可。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DATA_DIR } from "./paths.ts";

/** 注入给能力包的上下文 */
export interface PackContext {
	/** 解析“本次调用所属会话”的工作目录 */
	getWorkspaceRoot(): string;
	/** 兼容旧能力包的元工具；新能力包优先使用 pack.json 的通用激活规则。 */
	activatePack?: (packName: string) => void;
}

export type PackDefinition = (ctx: PackContext) => { tools: ToolDefinition[] };

export interface PackToolInfo {
	name: string;
	displayName: string;
}

export interface PackToolGroup {
	name: string;
	displayName: string;
	description: string;
	toolNames: string[];
	keywords: string[];
}

export interface PackActivation {
	extensions: string[];
	keywords: string[];
	minimumScore: number;
	defaultGroups: string[];
}

export interface PackInfo {
	/** 目录名（挂载接口用它） */
	name: string;
	displayName: string;
	description: string;
	version: string;
	/** 模块里实际注册的工具 */
	tools: PackToolInfo[];
	/** 通用的按本轮激活规则；不存在时沿用常驻/旧 deferred 行为。 */
	activation: PackActivation | null;
	toolGroups: PackToolGroup[];
	/** 兼容旧包：挂载后默认只启用元工具。 */
	deferred: boolean;
	metaToolName: string | null;
}

export interface CapabilityMatch {
	packName: string;
	displayName: string;
	groupNames: string[];
	groupDisplayNames: string[];
	toolNames: string[];
	reasons: string[];
}

interface LoadedPack {
	info: PackInfo;
	define: PackDefinition;
}

export const BUILTIN_TOOL_NAMES = ["read", "bash", "edit", "write"];

const BUILTIN_TOOL_LABELS: Record<string, string> = {
	read: "读取文件",
	bash: "运行命令",
	edit: "编辑文件",
	write: "写入文件",
};

const PACKS_DIR = join(import.meta.dirname, "..", "packs");
const MOUNTED_PACKS_FILE = join(DATA_DIR, "mounted-packs.json");

/** 已加载的全部能力包（服务启动时填充） */
const loadedPacks: LoadedPack[] = [];

/** 已启用的包名列表（决定哪些助手可以绑定到会话，不再直接污染全部会话） */
let mountedPackNames: string[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean);
}

function readMountedState(): string[] {
	try {
		const raw = JSON.parse(readFileSync(MOUNTED_PACKS_FILE, "utf8")) as unknown;
		return stringArray(raw);
	} catch {
		return [];
	}
}

function persistMountedState(): void {
	mkdirSync(DATA_DIR, { recursive: true });
	writeFileSync(MOUNTED_PACKS_FILE, `${JSON.stringify(mountedPackNames, null, "\t")}\n`, "utf8");
}

function findPack(name: string): LoadedPack | undefined {
	return loadedPacks.find((pack) => pack.info.name === name);
}

function readActivation(manifest: Record<string, unknown>): PackActivation | null {
	if (!isRecord(manifest.activation)) return null;
	const extensions = stringArray(manifest.activation.extensions).map((extension) => {
		const normalized = extension.toLocaleLowerCase("zh-CN");
		return normalized.startsWith(".") ? normalized : `.${normalized}`;
	});
	const keywords = stringArray(manifest.activation.keywords);
	if (extensions.length === 0 && keywords.length === 0) return null;
	const minimumScore =
		typeof manifest.activation.minimumScore === "number" && manifest.activation.minimumScore > 0
			? manifest.activation.minimumScore
			: 2;
	return {
		extensions,
		keywords,
		minimumScore,
		defaultGroups: stringArray(manifest.activation.defaultGroups),
	};
}

function readToolGroups(manifest: Record<string, unknown>, toolNames: string[]): PackToolGroup[] {
	if (!Array.isArray(manifest.toolGroups)) return [];
	const groups: PackToolGroup[] = [];
	for (const rawGroup of manifest.toolGroups) {
		if (!isRecord(rawGroup) || typeof rawGroup.name !== "string") continue;
		const names = stringArray(rawGroup.tools).filter((name) => toolNames.includes(name));
		if (names.length === 0) continue;
		groups.push({
			name: rawGroup.name,
			displayName: typeof rawGroup.displayName === "string" ? rawGroup.displayName : rawGroup.name,
			description: typeof rawGroup.description === "string" ? rawGroup.description : "",
			toolNames: names,
			keywords: stringArray(rawGroup.keywords),
		});
	}
	return groups;
}

/** 服务启动时扫描并加载所有能力包（新加的包重启服务后生效） */
export async function loadPacks(): Promise<void> {
	loadedPacks.length = 0;
	if (!existsSync(PACKS_DIR)) {
		mountedPackNames = readMountedState();
		return;
	}
	for (const entry of readdirSync(PACKS_DIR, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = join(PACKS_DIR, entry.name);
		const packJsonPath = join(dir, "pack.json");
		const indexPath = join(dir, "index.ts");
		if (!existsSync(packJsonPath) || !existsSync(indexPath)) continue;
		try {
			const manifest = JSON.parse(readFileSync(packJsonPath, "utf8")) as unknown;
			if (!isRecord(manifest) || typeof manifest.name !== "string" || typeof manifest.version !== "string") {
				console.warn(`能力包 ${entry.name}：pack.json 缺少 name/version，跳过`);
				continue;
			}
			const mod = (await import(pathToFileURL(indexPath).href)) as {
				default?: PackDefinition;
			};
			if (typeof mod.default !== "function") {
				console.warn(`能力包 ${entry.name}：index.ts 未导出 default 函数，跳过`);
				continue;
			}
			const probe = mod.default({ getWorkspaceRoot: () => DATA_DIR });
			const tools = probe.tools.map((tool) => ({ name: tool.name, displayName: tool.label || tool.name }));
			const toolNames = tools.map((tool) => tool.name);
			const deferred = manifest.deferred === true;
			const metaToolName = deferred
				? typeof manifest.metaTool === "string" && toolNames.includes(manifest.metaTool)
					? manifest.metaTool
					: (toolNames.find((name) => name.endsWith("_enable")) ?? null)
				: null;
			loadedPacks.push({
				info: {
					name: manifest.name,
					displayName: typeof manifest.displayName === "string" ? manifest.displayName : manifest.name,
					description: typeof manifest.description === "string" ? manifest.description : "",
					version: manifest.version,
					tools,
					activation: readActivation(manifest),
					toolGroups: readToolGroups(manifest, toolNames),
					deferred,
					metaToolName,
				},
				define: mod.default,
			});
			console.log(`能力包已加载：${manifest.name} v${manifest.version}（${tools.length} 个工具）`);
		} catch (error) {
			console.warn(`能力包 ${entry.name} 加载失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}
	mountedPackNames = readMountedState().filter((name) => findPack(name) !== undefined);
}

/** 接口输出：保留工具名称数组，并增加中文标签与通用激活规则。 */
export function listPacks(): Array<PackInfo & { toolNames: string[]; mounted: boolean }> {
	return loadedPacks.map((pack) => ({
		...pack.info,
		tools: pack.info.tools.map((tool) => ({ ...tool })),
		toolNames: pack.info.tools.map((tool) => tool.name),
		activation: pack.info.activation ? { ...pack.info.activation } : null,
		toolGroups: pack.info.toolGroups.map((group) => ({ ...group, toolNames: [...group.toolNames] })),
		mounted: mountedPackNames.includes(pack.info.name),
	}));
}

/** 会话基础工具：原生工具 + 未声明按本轮加载规则的旧能力包工具。 */
export function baseToolNames(enabledPackNames: Iterable<string> = []): string[] {
	const names = [...BUILTIN_TOOL_NAMES];
	for (const name of enabledPackNames) {
		const pack = findPack(name);
		if (!pack || pack.info.activation) continue;
		if (pack.info.deferred && pack.info.metaToolName) names.push(pack.info.metaToolName);
		else names.push(...pack.info.tools.map((tool) => tool.name));
	}
	return [...new Set(names)];
}

/** 某包的完整业务工具名单；默认排除兼容旧流程的元工具。 */
export function fullPackToolNames(name: string, includeMetaTool = false): string[] {
	const pack = findPack(name);
	if (!pack) return [];
	return pack.info.tools
		.map((tool) => tool.name)
		.filter((toolName) => includeMetaTool || toolName !== pack.info.metaToolName);
}

/** 根据会话绑定的助手和本轮文字，在本地选择最小工具组；不请求模型，不消耗 token。 */
export function selectCapabilities(text: string, enabledPackNames: Iterable<string>): CapabilityMatch[] {
	const normalizedText = text.toLocaleLowerCase("zh-CN");
	const matches: CapabilityMatch[] = [];
	for (const packName of enabledPackNames) {
		const pack = findPack(packName);
		const activation = pack?.info.activation;
		if (!pack || !activation) continue;
		let score = 0;
		const reasons: string[] = [];
		for (const extension of activation.extensions) {
			if (!normalizedText.includes(extension)) continue;
			score += 4;
			reasons.push(`发现文件类型 ${extension}`);
		}
		for (const keyword of activation.keywords) {
			if (!normalizedText.includes(keyword.toLocaleLowerCase("zh-CN"))) continue;
			score += 2;
			reasons.push(`匹配需求“${keyword}”`);
		}
		if (score < activation.minimumScore) continue;

		let selectedGroups = pack.info.toolGroups.filter((group) =>
			group.keywords.some((keyword) => normalizedText.includes(keyword.toLocaleLowerCase("zh-CN"))),
		);
		if (selectedGroups.length === 0) {
			selectedGroups = pack.info.toolGroups.filter((group) => activation.defaultGroups.includes(group.name));
		}
		const toolNames =
			selectedGroups.length > 0
				? [...new Set(selectedGroups.flatMap((group) => group.toolNames))]
				: fullPackToolNames(packName);
		if (toolNames.length === 0) continue;
		matches.push({
			packName,
			displayName: pack.info.displayName,
			groupNames: selectedGroups.map((group) => group.name),
			groupDisplayNames: selectedGroups.map((group) => group.displayName),
			toolNames,
			reasons,
		});
	}
	return matches;
}

export function toolDisplayName(name: string): string {
	const label =
		BUILTIN_TOOL_LABELS[name] ??
		loadedPacks.flatMap((pack) => pack.info.tools).find((tool) => tool.name === name)?.displayName;
	return label && label !== name ? `${label}（${name}）` : name;
}

export function packSummaries(names: Iterable<string>): Array<{ name: string; displayName: string }> {
	const summaries: Array<{ name: string; displayName: string }> = [];
	for (const name of names) {
		const pack = findPack(name);
		if (pack) summaries.push({ name, displayName: pack.info.displayName });
	}
	return summaries;
}

export function isMountedPack(name: string): boolean {
	return mountedPackNames.includes(name) && findPack(name) !== undefined;
}

export function mountPack(name: string): boolean {
	const pack = findPack(name);
	if (!pack || mountedPackNames.includes(name)) return false;
	mountedPackNames.push(name);
	persistMountedState();
	return true;
}

export function unmountPack(name: string): boolean {
	if (!mountedPackNames.includes(name)) return false;
	mountedPackNames = mountedPackNames.filter((value) => value !== name);
	persistMountedState();
	return true;
}

export function mountedPacks(): string[] {
	return [...mountedPackNames];
}

/** 为一个会话实例化全部已安装包；实际送给模型的工具由 setActiveToolsByName 控制。 */
export function instantiatePackTools(ctx: PackContext): ToolDefinition[] {
	const tools: ToolDefinition[] = [];
	for (const pack of loadedPacks) {
		try {
			tools.push(...pack.define(ctx).tools);
		} catch (error) {
			console.warn(`能力包 ${pack.info.name} 实例化失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return tools;
}
