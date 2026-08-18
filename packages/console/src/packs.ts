/**
 * 能力包框架：扫描 packages/console/packs/，加载并校验每个包，
 * 管理全局挂载状态（持久化到 data/mounted-packs.json）。
 *
 * 包形态：
 *   packs/<name>/pack.json  — { name, displayName, description, version }
 *   packs/<name>/index.ts   — export default function definePack(ctx): { tools: ToolDefinition[] }
 *
 * 包工具按"每会话独立实例化"：后端为每个会话调用 definePack({ getWorkspaceRoot: () => 该会话 cwd })，
 * 这样 execute 时能拿到正确的会话工作目录。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** 注入给能力包的上下文 */
export interface PackContext {
	/** 解析"本次调用所属会话"的工作目录 */
	getWorkspaceRoot(): string;
}

export type PackDefinition = (ctx: PackContext) => { tools: ToolDefinition[] };

export interface PackInfo {
	/** 目录名（挂载接口用它） */
	name: string;
	displayName: string;
	description: string;
	version: string;
	/** 模块里实际注册的工具名 */
	toolNames: string[];
}

interface LoadedPack {
	info: PackInfo;
	define: PackDefinition;
}

export const BUILTIN_TOOL_NAMES = ["read", "bash", "edit", "write"];

const PACKS_DIR = join(import.meta.dirname, "..", "packs");
const DATA_DIR = join(import.meta.dirname, "..", "data");
const MOUNTED_PACKS_FILE = join(DATA_DIR, "mounted-packs.json");

/** 已加载的全部能力包（服务启动时填充） */
const loadedPacks: LoadedPack[] = [];

/** 已挂载的包名列表（全局共享） */
let mountedPackNames: string[] = [];

// ---------------------------------------------------------------------------
// 加载
// ---------------------------------------------------------------------------

function readMountedState(): string[] {
	try {
		const raw = JSON.parse(readFileSync(MOUNTED_PACKS_FILE, "utf8"));
		if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string");
	} catch {
		/* 文件不存在或损坏时视为未挂载 */
	}
	return [];
}

function persistMountedState(): void {
	mkdirSync(DATA_DIR, { recursive: true });
	writeFileSync(MOUNTED_PACKS_FILE, `${JSON.stringify(mountedPackNames, null, "\t")}\n`, "utf8");
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
			const manifest = JSON.parse(readFileSync(packJsonPath, "utf8"));
			if (typeof manifest?.name !== "string" || typeof manifest?.version !== "string") {
				console.warn(`能力包 ${entry.name}：pack.json 缺少 name/version，跳过`);
				continue;
			}
			const mod = (await import(`file://${indexPath.replace(/\\/g, "/")}`)) as {
				default?: PackDefinition;
			};
			if (typeof mod.default !== "function") {
				console.warn(`能力包 ${entry.name}：index.ts 未导出 default 函数，跳过`);
				continue;
			}
			// 实例化一次拿工具名清单（工具定义本身每次会话重新实例化）
			const probe = mod.default({ getWorkspaceRoot: () => DATA_DIR });
			loadedPacks.push({
				info: {
					name: manifest.name,
					displayName: manifest.displayName ?? manifest.name,
					description: manifest.description ?? "",
					version: manifest.version,
					toolNames: probe.tools.map((tool) => tool.name),
				},
				define: mod.default,
			});
			console.log(`能力包已加载：${manifest.name} v${manifest.version}（${probe.tools.length} 个工具）`);
		} catch (error) {
			console.warn(`能力包 ${entry.name} 加载失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}
	// 过滤掉已从磁盘删除但仍在挂载记录里的包
	mountedPackNames = readMountedState().filter((name) => findPack(name) !== undefined);
}

function findPack(name: string): LoadedPack | undefined {
	return loadedPacks.find((pack) => pack.info.name === name);
}

// ---------------------------------------------------------------------------
// 挂载状态
// ---------------------------------------------------------------------------

/** 接口输出：tools 为工具名数组（符合 GET /api/packs 规范） */
export function listPacks(): Array<Omit<PackInfo, "toolNames"> & { tools: string[]; mounted: boolean }> {
	return loadedPacks.map((pack) => ({
		name: pack.info.name,
		displayName: pack.info.displayName,
		description: pack.info.description,
		version: pack.info.version,
		tools: pack.info.toolNames,
		mounted: mountedPackNames.includes(pack.info.name),
	}));
}

/** 挂载/卸载后应生效的完整工具名名单：内置 4 个 + 已挂载包的工具 */
export function activeToolNames(): string[] {
	const names = [...BUILTIN_TOOL_NAMES];
	for (const name of mountedPackNames) {
		const pack = findPack(name);
		if (pack) names.push(...pack.info.toolNames);
	}
	return names;
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
	mountedPackNames = mountedPackNames.filter((v) => v !== name);
	persistMountedState();
	return true;
}

export function mountedPacks(): string[] {
	return [...mountedPackNames];
}

// ---------------------------------------------------------------------------
// 实例化（每会话一次）
// ---------------------------------------------------------------------------

/**
 * 为一个会话实例化所有已安装包的工具。
 * 注意：返回的是"全部已安装包"的工具（注册进 createAgentSession 的 customTools），
 * 是否启用由 setActiveToolsByName(activeToolNames()) 决定（挂载语义）。
 */
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
