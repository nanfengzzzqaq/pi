/**
 * Pi Web 控制台 — 通用能力包 + 按会话/按本轮工具加载
 *
 * 默认形态仍是纯净原生 Pi；Windows 安装版额外提供私有 Bash 与系统 PowerShell，
 * 能力包只在内部注册；每轮先读取 pack.json 的通用规则，再用
 * setActiveToolsByName 只注入真正命中的最小工具组。
 *
 * 全部后端逻辑都在 src/ 下按模块拆分，HTTP 层只用 node:http 原生模块，不引入框架。
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	ModelRuntime,
	SessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	isAgentBrowserRuntimeAvailable,
	redactSensitiveText,
	vaultSensitiveUrlsInText,
} from "./agent-browser-runtime.ts";
import { extractFileReferences } from "./artifacts.ts";
import * as codeDevelopment from "./code-development.ts";
import { CodexOAuthCoordinator } from "./codex-oauth.ts";
import { instantiateCoreFileTools } from "./core-file-tools.ts";
import * as fsExplorer from "./fs.ts";
import { isAllowedLoopbackHost } from "./http-security.ts";
import * as managedFileTools from "./managed-file-tools.ts";
import { configureConsoleNetworking } from "./network.ts";
import * as officePreview from "./office-preview.ts";
import * as officecli from "./officecli.ts";
import {
	installAllOfficeCliSkills,
	installOfficeCliSkill,
	listOfficeCliSkills,
	uninstallAllOfficeCliSkills,
} from "./officecli-skills.ts";
import {
	baseToolNames,
	type CapabilityMatch,
	fullPackToolNames,
	instantiatePackTools,
	isMountedPack,
	listPacks,
	loadPacks,
	mountedPacks,
	mountPack,
	packSummaries,
	selectCapabilities,
	toolDisplayName,
	unmountPack,
} from "./packs.ts";
import { DATA_DIR } from "./paths.ts";
import * as redteam from "./redteam.ts";
import {
	abortTrackedSessionPrompt,
	disposeSessionBeforeDelete,
	type TrackedSessionPrompt,
} from "./session-lifecycle.ts";
import { appendAttachmentAnnotation, parseUserMessage } from "./session-messages.ts";
import * as storage from "./storage.ts";
import * as updates from "./updates.ts";
import { registerDetectedWhiteRabbitNeo } from "./whiterabbitneo.ts";
import { instantiateWindowsTools, seedBundledSearchRuntime, seedBundledWindowsRuntime } from "./windows-tools.ts";
import * as workspace from "./workspace.ts";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT ?? 3200);
/** 可选鉴权：设置后所有 /api/* 请求必须带 Authorization: Bearer <token>（或 ?token=），静态页面放行 */
const AUTH_TOKEN = process.env.PI_CONSOLE_TOKEN;
/** 可选模型：格式 provider/model-id，如 deepseek/deepseek-v4-flash；未设置则走 Pi 默认解析（含上次选择） */
const MODEL_SPEC = process.env.PI_CONSOLE_MODEL;

const PACKAGE_ROOT = join(import.meta.dirname, ".."); // packages/console
const WEB_DIR = join(PACKAGE_ROOT, "web");
/** 会话工作区根目录（DATA_DIR 可通过 PI_CONSOLE_DATA 外置，安装版指向用户目录） */
const WORKSPACES_DIR = join(DATA_DIR, "workspaces");
/** 会话文件目录（Pi 文件会话后端，重启可恢复） */
const SESSION_DIR = join(DATA_DIR, "sessions");
/** 会话索引：ourSessionId → { cwd, title, createdAt, updatedAt } */
const SESSION_INDEX_FILE = join(DATA_DIR, "sessions-index.json");
/**
 * 控制台专属 agentDir：模型/思考等级选择通过 Pi 的 SettingsManager 原生持久化在这里
 * （<DATA_DIR>/agent/settings.json），新会话自动沿用，且不污染用户全局 ~/.pi/agent/settings.json
 */
const CONSOLE_AGENT_DIR = join(DATA_DIR, "agent");
// Pi 官方 grep/find 会从 agent/bin 读取私有 rg/fd；网页开发模式与 Electron 安装版保持一致。
process.env.PI_CODING_AGENT_DIR ??= CONSOLE_AGENT_DIR;
/** 旧内部包名继续保留，避免历史会话失效；客户端统一显示为 OfficeCLI 工具。 */
const OFFICECLI_PACK_NAME = "office-assistant";
const AGENT_BROWSER_PACK_NAME = "agent-browser";
const CODE_DEVELOPMENT_PACK_NAME = "code-development";

const MANAGED_TOOL_PACKS: Partial<Record<managedFileTools.ManagedToolId, string>> = {
	sevenzip: "archive-files",
	ocr: "image-ocr",
	libreoffice: "legacy-documents",
};

// Electron/Node fetch does not automatically inherit the Windows WinINET proxy.
// Configure it before any model catalog, provider, or updater network request.
configureConsoleNetworking();
// 清理历史更新残留，避免 update 目录无限累积旧安装包。
updates.cleanupStaleUpdateFiles();

/** 每会话保留的最近事件数（SSE 重连补发用） */
const MAX_BUFFERED_EVENTS = 500;
/** 普通请求 body 大小上限（文件上传接口单独放宽） */
const MAX_BODY_BYTES = 1024 * 1024;
/** 文件上传上限：单文件 20MB、总量 50MB */
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 50 * 1024 * 1024;
/** 思考等级合法值（与 pi-ai ThinkingLevel 一致） */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

// ---------------------------------------------------------------------------
// 会话与事件缓冲
// ---------------------------------------------------------------------------

/** 转发给前端的精简事件：seq 为会话内单调递增序号，用于断线补发 */
interface BufferedEvent {
	seq: number;
	type: string;
	[key: string]: unknown;
}

/** createAgentSession 的 model 参数类型（包入口未直接导出 Model，这里从函数签名推导） */
type SessionModel = NonNullable<NonNullable<Parameters<typeof createAgentSession>[0]>["model"]>;

interface ConsoleSession {
	sessionId: string;
	session: AgentSession;
	events: BufferedEvent[];
	nextSeq: number;
	sseClients: Set<ServerResponse>;
	/** 这个会话绑定的助手；与全局“已启用”目录分离。 */
	enabledPacks: Set<string>;
	/** 本轮临时激活的最小工具组；agent_settled 后清空。 */
	activePackTools: Map<string, Set<string>>;
	lastCapabilityTrace: CapabilityTrace | null;
	lastUsage: unknown;
	/** DELETE 已开始后禁止再提交消息。 */
	deleting: boolean;
	/** 包含鉴权/扩展预处理阶段，避免 isStreaming 尚未置位时删除形成孤儿任务。 */
	activePrompt: TrackedSessionPrompt | null;
}

const sessions = new Map<string, ConsoleSession>();
const restoringSessions = new Map<string, Promise<ConsoleSession | null>>();

const SENSITIVE_TOOL_FIELD =
	/^(?:access_?token|provisional_?token|refresh_?token|id_?token|token|authorization|auth|api_?key|secret|session|sid)$/i;

/**
 * 工具仍接收原始参数；只在 UI/SSE/历史展示边界创建脱敏副本。
 * 除 URL 文本外也覆盖嵌套对象中直接以 token/auth/apiKey 命名的字段。
 */
function redactToolValue(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
	if (typeof value === "string") return redactSensitiveText(value);
	if (value === null || typeof value !== "object") return value;
	const existing = seen.get(value);
	if (existing !== undefined) return existing;
	if (Array.isArray(value)) {
		const copy: unknown[] = [];
		seen.set(value, copy);
		for (const item of value) copy.push(redactToolValue(item, seen));
		return copy;
	}
	const copy: Record<string, unknown> = {};
	seen.set(value, copy);
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		copy[key] = SENSITIVE_TOOL_FIELD.test(key) ? "[REDACTED]" : redactToolValue(item, seen);
	}
	return copy;
}

/** 会话当前应生效的工具名单。 */
function effectiveToolNames(enabledPacks: Set<string>, activePackTools: Map<string, Set<string>>): string[] {
	const names = baseToolNames(enabledPacks);
	for (const toolNames of activePackTools.values()) {
		for (const toolName of toolNames) {
			if (!names.includes(toolName)) names.push(toolName);
		}
	}
	return names;
}

interface ToolSnapshot {
	tools: Array<{ name: string; displayName: string }>;
	toolCount: number;
	schemaBytes: number;
	schemaFingerprint: string;
}

interface CapabilityTrace extends ToolSnapshot {
	stepId: string;
	stepName: "capability_search";
	stepDisplayName: string;
	enabledCapabilities: Array<{ name: string; displayName: string }>;
	selectedCapabilities: CapabilityMatch[];
}

// ---------------------------------------------------------------------------
// 会话索引（持久化：sessionId → cwd/title，支持列表与重启恢复）
// ---------------------------------------------------------------------------

interface SessionIndexEntry {
	cwd: string;
	/** Pi 会话文件路径（恢复消息用） */
	sessionFile?: string;
	/** 会话绑定的助手。旧索引没有该字段时，在恢复时迁移一次。 */
	enabledPacks?: string[];
	title: string;
	createdAt: number;
	updatedAt: number;
}

function readSessionIndex(): Record<string, SessionIndexEntry> {
	try {
		const raw = JSON.parse(readFileSync(SESSION_INDEX_FILE, "utf8"));
		if (typeof raw === "object" && raw !== null) return raw as Record<string, SessionIndexEntry>;
	} catch {
		/* 不存在或损坏 */
	}
	return {};
}

function writeSessionIndex(index: Record<string, SessionIndexEntry>): void {
	mkdirSync(DATA_DIR, { recursive: true });
	writeFileSync(SESSION_INDEX_FILE, `${JSON.stringify(index, null, "\t")}\n`, "utf8");
}

function touchSessionIndex(
	sessionId: string,
	cwd: string,
	sessionFile: string | undefined,
	enabledPacks: Iterable<string>,
): void {
	const index = readSessionIndex();
	const existing = index[sessionId];
	index[sessionId] = {
		cwd,
		sessionFile: sessionFile ?? existing?.sessionFile,
		enabledPacks: [...enabledPacks],
		title: existing?.title ?? "",
		createdAt: existing?.createdAt ?? Date.now(),
		updatedAt: Date.now(),
	};
	writeSessionIndex(index);
}

/**
 * “安装工具”替代旧的“给某个会话添加助手”：工具一旦可用，就绑定到全部会话；
 * 每轮仍由本地能力路由只注入命中的最小工具组。
 */
function activatePackForAllSessions(packName: string): void {
	mountPack(packName);
	for (const cs of sessions.values()) {
		cs.enabledPacks.add(packName);
		cs.session.setActiveToolsByName(effectiveToolNames(cs.enabledPacks, cs.activePackTools));
	}
	const enabled = mountedPacks();
	const index = readSessionIndex();
	for (const entry of Object.values(index)) {
		entry.enabledPacks = [...new Set([...(entry.enabledPacks ?? []), ...enabled])];
	}
	writeSessionIndex(index);
}

function activateOfficeCliForAllSessions(): void {
	activatePackForAllSessions(OFFICECLI_PACK_NAME);
}

/** 从全部内存会话和持久化索引解除工具包；不会删除工具文件。 */
function deactivatePackForAllSessions(packName: string): boolean {
	const changed = unmountPack(packName);
	for (const cs of sessions.values()) {
		cs.enabledPacks.delete(packName);
		cs.activePackTools.delete(packName);
		cs.session.setActiveToolsByName(effectiveToolNames(cs.enabledPacks, cs.activePackTools));
	}
	const index = readSessionIndex();
	for (const entry of Object.values(index)) {
		entry.enabledPacks = (entry.enabledPacks ?? mountedPacks()).filter((name) => name !== packName);
	}
	writeSessionIndex(index);
	return changed;
}

async function reloadInstalledSkillsInSessions(): Promise<number> {
	let reloaded = 0;
	for (const cs of sessions.values()) {
		if (cs.session.isStreaming) continue;
		try {
			await cs.session.reload();
			reloaded += 1;
		} catch (error) {
			console.warn(`会话 ${cs.sessionId} 刷新技能失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return reloaded;
}

/** 首条 user 消息作为会话标题 */
function updateSessionTitle(sessionId: string, text: string): void {
	const index = readSessionIndex();
	const entry = index[sessionId];
	if (!entry || entry.title) return;
	entry.title = text.replace(/\s+/g, " ").slice(0, 40);
	entry.updatedAt = Date.now();
	writeSessionIndex(index);
}

function renameSession(sessionId: string, title: string): string | null {
	const index = readSessionIndex();
	const entry = index[sessionId];
	if (!entry) return null;
	const normalized = title.replace(/\s+/g, " ").trim().slice(0, 80);
	if (!normalized) return null;
	entry.title = normalized;
	entry.updatedAt = Date.now();
	writeSessionIndex(index);
	return normalized;
}

/** 模型凭据存储文件（控制台专属，与 agent settings 同目录；同时保存 API Key 与 OAuth） */
const AUTH_FILE = join(CONSOLE_AGENT_DIR, "auth.json");

/** 全服共享一个 ModelRuntime，启动时创建；auth 指向控制台专属文件（页面添加的 Key 在此持久化） */
const modelRuntime = await ModelRuntime.create({ authPath: AUTH_FILE });
const codexOAuth = new CodexOAuthCoordinator({
	isConnected: () => modelRuntime.isUsingOAuth("openai-codex"),
	login: async (interaction) => {
		await modelRuntime.login("openai-codex", "oauth", interaction);
	},
	logout: () => modelRuntime.logout("openai-codex"),
});
if (await registerDetectedWhiteRabbitNeo(modelRuntime)) {
	console.log("本地模型：已连接 WhiteRabbitNeo V3");
}

if (seedBundledWindowsRuntime()) {
	console.log("Windows 工具：已把 Pi 私有 Bash/Git 运行时复制到数据目录");
}
if (seedBundledSearchRuntime()) {
	console.log("Windows 工具：已把 Pi 私有文件搜索运行时复制到数据目录");
}

// 加载能力包（新加的包重启服务后生效）
await loadPacks();
if (codeDevelopment.isCodeDevelopmentInstalled()) activatePackForAllSessions(CODE_DEVELOPMENT_PACK_NAME);
else deactivatePackForAllSessions(CODE_DEVELOPMENT_PACK_NAME);
// 桌面版主进程注册运行时后才挂载；纯网页模式不向模型暴露不可执行的浏览器工具。
if (isAgentBrowserRuntimeAvailable()) {
	activatePackForAllSessions(AGENT_BROWSER_PACK_NAME);
} else {
	deactivatePackForAllSessions(AGENT_BROWSER_PACK_NAME);
}
for (const [id, packName] of Object.entries(MANAGED_TOOL_PACKS) as Array<[managedFileTools.ManagedToolId, string]>) {
	if (managedFileTools.getManagedToolStatus(id).installed) activatePackForAllSessions(packName);
	else deactivatePackForAllSessions(packName);
}

// 首启引导：把安装包预置的 OfficeCLI 拷到外置数据目录（开发模式两者同路径，无操作）
if (officecli.seedBundledBinary()) {
	console.log("已把预置的 OfficeCLI 复制到数据目录");
}
officecli.ensureBinaryOnProcessPath();
if (await officecli.isBinaryReady()) activateOfficeCliForAllSessions();

// 预热：扩展注册的自定义 provider 只有在某个会话加载扩展之后才会出现在
// ModelRuntime 里。启动时先加载一次全局扩展，PI_CONSOLE_MODEL 才能引用它们。
try {
	const warmupCwd = join(DATA_DIR, "warmup");
	mkdirSync(warmupCwd, { recursive: true });
	await createAgentSession({
		cwd: warmupCwd,
		modelRuntime,
		sessionManager: SessionManager.inMemory(warmupCwd),
	});
} catch (error) {
	console.warn(`扩展预热失败（不影响内置 provider）：${error instanceof Error ? error.message : String(error)}`);
}

/** 把 AgentSessionEvent 转成精简的、可 JSON 序列化的前端事件；不在转发白名单内则返回 undefined */
function toClientEvent(ev: AgentSessionEvent): { type: string; [key: string]: unknown } | undefined {
	switch (ev.type) {
		case "message_update": {
			const inner = ev.assistantMessageEvent;
			if (inner.type === "text_delta") {
				return { type: "text_delta", delta: redactSensitiveText(inner.delta) };
			}
			if (inner.type === "thinking_delta") {
				// 思考内容随事件下发，前端在可折叠的"思考过程"区滚动显示
				return { type: "thinking_delta", delta: redactSensitiveText(inner.delta) };
			}
			return undefined;
		}
		case "tool_execution_start":
			return {
				type: "tool_execution_start",
				toolCallId: ev.toolCallId,
				toolName: ev.toolName,
				toolDisplayName: toolDisplayName(ev.toolName),
				args: redactToolValue(ev.args),
			};
		case "tool_execution_end":
			return {
				type: "tool_execution_end",
				toolCallId: ev.toolCallId,
				toolName: ev.toolName,
				toolDisplayName: toolDisplayName(ev.toolName),
				isError: ev.isError,
				result: summarizeToolResult(ev.result),
			};
		case "tool_execution_update": {
			// 流式部分结果（bash/powershell 等长命令的实时输出）。
			// 只发在线客户端，不进入重放缓冲：终值由 tool_execution_end 提供，
			// 避免高频更新把断线补发窗口挤掉触发整段 resync。
			const partial = ev.partialResult as { content?: Array<{ type?: string; text?: unknown }> } | undefined;
			const text = (partial?.content ?? [])
				.filter((block) => block.type === "text" && typeof block.text === "string")
				.map((block) => block.text)
				.join("\n");
			if (!text) return undefined;
			return {
				type: "tool_execution_update",
				toolCallId: ev.toolCallId,
				toolName: ev.toolName,
				toolDisplayName: toolDisplayName(ev.toolName),
				text: redactSensitiveText(text),
			};
		}
		case "turn_end": {
			const message = ev.message as {
				stopReason?: string;
				errorMessage?: string;
				usage?: unknown;
			};
			return {
				type: "turn_end",
				stopReason: message.stopReason,
				errorMessage: message.errorMessage ? redactSensitiveText(message.errorMessage) : undefined,
				usage: message.usage,
			};
		}
		case "agent_settled":
			return { type: "agent_settled" };
		case "auto_retry_start":
			return {
				type: "auto_retry_start",
				attempt: ev.attempt,
				maxAttempts: ev.maxAttempts,
				errorMessage: redactSensitiveText(ev.errorMessage),
			};
		case "compaction_start":
			return { type: "compaction_start" };
		case "compaction_end":
			return { type: "compaction_end" };
		case "thinking_level_changed":
			return { type: "thinking_level_changed", level: ev.level };
		default:
			return undefined;
	}
}

/** 工具结果可能很长，压成单行摘要再转发。真实结构为 { content: [{type:"text",text}...], details } */
function summarizeToolResult(result: unknown): string {
	if (result === undefined || result === null) return "";
	let text: string;
	if (typeof result === "string") {
		text = redactSensitiveText(result);
	} else if (typeof result === "object" && Array.isArray((result as { content?: unknown }).content)) {
		// AgentToolResult：拼 content 里全部 text 块
		text = (result as { content: Array<{ type?: string; text?: unknown }> }).content
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => redactSensitiveText(block.text as string))
			.join("\n");
	} else {
		try {
			text = JSON.stringify(redactToolValue(result)) ?? "";
		} catch {
			text = redactSensitiveText(String(result));
		}
	}
	text = text.replace(/\s+/g, " ").trim();
	return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** 记录一组工具定义，便于实时显示及历史恢复时核对 token 优化是否生效。 */
function toolSnapshot(session: AgentSession, names: string[]): ToolSnapshot {
	const schemas = names.map((name) => {
		const definition = session.getToolDefinition(name);
		return {
			name,
			description: definition?.description ?? "",
			parameters: definition?.parameters ?? null,
			promptSnippet: definition?.promptSnippet ?? null,
			promptGuidelines: definition?.promptGuidelines ?? [],
		};
	});
	const serialized = JSON.stringify(schemas);
	return {
		tools: names.map((name) => ({ name, displayName: toolDisplayName(name) })),
		toolCount: names.length,
		schemaBytes: Buffer.byteLength(serialized, "utf8"),
		schemaFingerprint: createHash("sha256").update(serialized).digest("hex").slice(0, 12),
	};
}

function activeToolSnapshot(session: AgentSession): ToolSnapshot {
	return toolSnapshot(session, session.getActiveToolNames());
}

/**
 * capability_search 是本地确定性路由，不属于 Pi 原生消息；切换会话时按当时的用户消息重新生成，
 * 这样无需再次调用模型，也不会让实时执行过程在历史中消失。
 */
function historicalCapabilityTrace(
	session: AgentSession,
	text: string,
	timestamp: number,
	enabledPacks: Set<string>,
): CapabilityTrace {
	const selectedCapabilities = selectCapabilities(text, enabledPacks);
	const selectedTools = new Map<string, Set<string>>();
	for (const match of selectedCapabilities) selectedTools.set(match.packName, new Set(match.toolNames));
	const names = effectiveToolNames(enabledPacks, selectedTools);
	return {
		stepId: `history-capability-${timestamp}`,
		stepName: "capability_search",
		stepDisplayName: "查找可用能力（capability_search）",
		enabledCapabilities: packSummaries(enabledPacks),
		selectedCapabilities,
		...toolSnapshot(session, names),
	};
}

function prepareTurnCapabilities(cs: ConsoleSession, text: string): CapabilityTrace {
	cs.activePackTools.clear();
	const selectedCapabilities = selectCapabilities(text, cs.enabledPacks);
	for (const match of selectedCapabilities) {
		cs.activePackTools.set(match.packName, new Set(match.toolNames));
	}
	cs.session.setActiveToolsByName(effectiveToolNames(cs.enabledPacks, cs.activePackTools));
	const trace: CapabilityTrace = {
		stepId: `capability-${randomUUID()}`,
		stepName: "capability_search",
		stepDisplayName: "查找可用能力（capability_search）",
		enabledCapabilities: packSummaries(cs.enabledPacks),
		selectedCapabilities,
		...activeToolSnapshot(cs.session),
	};
	cs.lastCapabilityTrace = trace;
	return trace;
}

function releaseTurnCapabilities(cs: ConsoleSession): void {
	if (cs.activePackTools.size === 0) return;
	cs.activePackTools.clear();
	cs.session.setActiveToolsByName(effectiveToolNames(cs.enabledPacks, cs.activePackTools));
}

/** 只对在线连接广播、不写入重放缓冲的瞬时事件类型（终值由后续事件补全）。 */
const TRANSIENT_EVENT_TYPES = new Set(["tool_execution_update"]);

function bufferAndBroadcast(cs: ConsoleSession, clientEvent: { type: string; [key: string]: unknown }): void {
	const event: BufferedEvent = { seq: cs.nextSeq++, ...clientEvent };
	if (!TRANSIENT_EVENT_TYPES.has(clientEvent.type)) {
		cs.events.push(event);
		if (cs.events.length > MAX_BUFFERED_EVENTS) {
			cs.events.splice(0, cs.events.length - MAX_BUFFERED_EVENTS);
		}
	}
	const payload = `data: ${JSON.stringify(event)}\n\n`;
	for (const client of cs.sseClients) {
		client.write(payload);
	}
}

/**
 * 用给定 cwd 构建 AgentSession（新建或恢复共用）。
 * sessionFile 存在时用 SessionManager.open 打开该会话文件（恢复消息），否则新建。
 * 返回 { session, sessionFile, modelFallbackMessage }
 */
async function buildSession(
	cwd: string,
	enabledPackNames: Iterable<string>,
	modelOverride?: SessionModel,
	sessionFile?: string,
): Promise<{
	session: AgentSession;
	sessionFile: string | undefined;
	modelFallbackMessage?: string;
	enabledPacks: Set<string>;
	activePackTools: Map<string, Set<string>>;
}> {
	mkdirSync(cwd, { recursive: true });
	mkdirSync(CONSOLE_AGENT_DIR, { recursive: true });

	const sessionManager = sessionFile
		? SessionManager.open(sessionFile, SESSION_DIR, cwd)
		: SessionManager.create(cwd, SESSION_DIR);
	const enabledPacks = new Set([...enabledPackNames].filter(isMountedPack));
	const activePackTools = new Map<string, Set<string>>();
	// 兼容尚未迁移到 activation/toolGroups 清单的旧 deferred 包。
	let sessionRef: AgentSession | null = null;
	const options: {
		cwd: string;
		modelRuntime: ModelRuntime;
		sessionManager: SessionManager;
		agentDir: string;
		model?: SessionModel;
		customTools: ToolDefinition<any, any, any>[];
	} = {
		cwd,
		modelRuntime,
		sessionManager,
		agentDir: CONSOLE_AGENT_DIR,
		// 每会话独立实例化能力包工具，execute 时通过 getWorkspaceRoot 拿到本会话 cwd
		customTools: [
			...instantiateCoreFileTools(cwd),
			...instantiateWindowsTools({ getWorkspaceRoot: () => cwd }),
			...instantiatePackTools({
				getWorkspaceRoot: () => cwd,
				activatePack: (packName) => {
					if (!enabledPacks.has(packName)) return;
					activePackTools.set(packName, new Set(fullPackToolNames(packName)));
					sessionRef?.setActiveToolsByName(effectiveToolNames(enabledPacks, activePackTools));
				},
			}),
		],
		model: modelOverride,
	};

	if (!modelOverride && MODEL_SPEC) {
		const slash = MODEL_SPEC.indexOf("/");
		const provider = slash > 0 ? MODEL_SPEC.slice(0, slash) : "";
		const modelId = slash > 0 ? MODEL_SPEC.slice(slash + 1) : "";
		if (!provider || !modelId) {
			throw new Error(`PI_CONSOLE_MODEL 格式应为 provider/model-id，当前值："${MODEL_SPEC}"`);
		}
		const model = modelRuntime.getModel(provider, modelId);
		if (!model) {
			throw new Error(
				`模型未找到：${MODEL_SPEC}。请检查 provider 与 model id 是否正确，` +
					`并确认已配置对应厂商的 API Key（环境变量或 ~/.pi/agent/auth.json）`,
			);
		}
		options.model = model;
	}

	const { session, modelFallbackMessage } = await createAgentSession(options);
	sessionRef = session;

	// 新会话只带原生工具；声明了通用激活规则的能力包等到本轮确实命中才注入。
	session.setActiveToolsByName(effectiveToolNames(enabledPacks, activePackTools));
	return {
		session,
		sessionFile: session.sessionFile,
		modelFallbackMessage,
		enabledPacks,
		activePackTools,
	};
}

function subscribeConsoleSession(cs: ConsoleSession): void {
	cs.session.subscribe((ev) => {
		if (ev.type === "turn_end") cs.lastUsage = (ev.message as { usage?: unknown }).usage ?? null;
		if (ev.type === "agent_settled") releaseTurnCapabilities(cs);
		const clientEvent = toClientEvent(ev);
		if (clientEvent) bufferAndBroadcast(cs, clientEvent);
	});
}

async function createConsoleSession(
	enabledPackNames: string[] = mountedPacks(),
): Promise<{ sessionId: string; warning?: string }> {
	const sessionId = randomUUID();
	// 用户设置了工作区则以其为会话工作目录（多会话共享）；否则用默认 workspaces/<uuid>
	const workspacePath = workspace.getWorkspacePath();
	const cwd = workspacePath ?? join(WORKSPACES_DIR, sessionId);
	const {
		session,
		sessionFile,
		modelFallbackMessage,
		enabledPacks,
		activePackTools,
	} = await buildSession(cwd, enabledPackNames);

	const cs: ConsoleSession = {
		sessionId,
		session,
		events: [],
		nextSeq: 0,
		sseClients: new Set(),
		enabledPacks,
		activePackTools,
		lastCapabilityTrace: null,
		lastUsage: null,
		deleting: false,
		activePrompt: null,
	};
	sessions.set(sessionId, cs);
	touchSessionIndex(sessionId, cwd, sessionFile, enabledPacks);
	subscribeConsoleSession(cs);

	// 默认模型解析失败时（如未配置任何 Key），通过 SSE 告知前端
	if (modelFallbackMessage) {
		bufferAndBroadcast(cs, { type: "error", message: modelFallbackMessage });
	}

	return { sessionId, warning: modelFallbackMessage };
}

/** 按索引恢复历史会话（服务重启后内存 Map 为空时） */
async function restoreConsoleSession(sessionId: string): Promise<ConsoleSession | null> {
	const index = readSessionIndex();
	const entry = index[sessionId];
	if (!entry) return null;
	try {
		// 新工具模式下，已安装工具对所有会话可用；旧会话原有能力仍保留。
		const restoredEnabledPacks = [...new Set([...(entry.enabledPacks ?? []), ...mountedPacks()])];
		const {
			session,
			sessionFile,
			modelFallbackMessage,
			enabledPacks,
			activePackTools,
		} = await buildSession(entry.cwd, restoredEnabledPacks, undefined, entry.sessionFile);
		const cs: ConsoleSession = {
			sessionId,
			session,
			events: [],
			nextSeq: 0,
			sseClients: new Set(),
			enabledPacks,
			activePackTools,
			lastCapabilityTrace: null,
			lastUsage: null,
			deleting: false,
			activePrompt: null,
		};
		sessions.set(sessionId, cs);
		touchSessionIndex(sessionId, entry.cwd, sessionFile, enabledPacks);
		subscribeConsoleSession(cs);
		if (modelFallbackMessage) bufferAndBroadcast(cs, { type: "error", message: modelFallbackMessage });
		return cs;
	} catch (error) {
		console.warn(`会话 ${sessionId} 恢复失败：${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
}

/** 获取会话（内存 Map 优先，缺则尝试从磁盘恢复） */
async function getOrRestoreSession(sessionId: string): Promise<ConsoleSession | null> {
	const cs = sessions.get(sessionId);
	if (cs) return cs;
	const existing = restoringSessions.get(sessionId);
	if (existing) return existing;
	const pending = restoreConsoleSession(sessionId).finally(() => {
		if (restoringSessions.get(sessionId) === pending) restoringSessions.delete(sessionId);
	});
	restoringSessions.set(sessionId, pending);
	return pending;
}

// ---------------------------------------------------------------------------
// 历史快照
// ---------------------------------------------------------------------------

interface HistoryItem {
	role: "user" | "assistant" | "toolResult";
	[key: string]: unknown;
}

/** 从 session.messages 生成消息快照（user/assistant 文本 + 工具调用记录），供页面刷新恢复 */
function buildHistory(session: AgentSession, enabledPacks: Set<string>): HistoryItem[] {
	const items: HistoryItem[] = [];
	for (const message of session.messages) {
		if (message.role === "user") {
			let text: string;
			let hasImage = false;
			if (typeof message.content === "string") {
				text = message.content;
			} else {
				const parts: string[] = [];
				for (const block of message.content) {
					if (block.type === "text") parts.push(block.text);
					else if (block.type === "image") hasImage = true;
				}
				text = parts.join("\n");
			}
			const parsed = parseUserMessage(text);
			if (hasImage && parsed.attachments.length === 0) {
				parsed.text = `${parsed.text}${parsed.text ? "\n" : ""}[图片]`;
			}
			if (parsed.text || parsed.attachments.length > 0) {
				const item: HistoryItem = {
					role: "user",
					text: redactSensitiveText(parsed.text),
					attachments: parsed.attachments,
				};
				if (enabledPacks.size > 0) {
					item.capabilityTrace = historicalCapabilityTrace(session, text, message.timestamp, enabledPacks);
				}
				items.push(item);
			}
		} else if (message.role === "assistant") {
			const text = message.content
				.filter((block) => block.type === "text")
				.map((block) => (block.type === "text" ? block.text : ""))
				.join("\n");
			const toolCalls = message.content
				.filter((block) => block.type === "toolCall")
				.map((block) =>
					block.type === "toolCall"
						? {
								id: block.id,
								name: block.name,
								displayName: toolDisplayName(block.name),
								args: redactToolValue(block.arguments),
							}
						: undefined,
				)
				.filter((call) => call !== undefined);
			const item: HistoryItem = { role: "assistant", text: redactSensitiveText(text) };
			if (toolCalls.length > 0) item.toolCalls = toolCalls;
			item.usage = message.usage;
			item.timestamp = message.timestamp;
			if (message.stopReason === "error" && message.errorMessage) {
				item.errorMessage = redactSensitiveText(message.errorMessage);
			}
			if (text.trim() || toolCalls.length > 0 || item.errorMessage) items.push(item);
		} else if (message.role === "toolResult") {
			const text = message.content
				.filter((block) => block.type === "text")
				.map((block) => (block.type === "text" ? block.text : ""))
				.join("\n");
			items.push({
				role: "toolResult",
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				toolDisplayName: toolDisplayName(message.toolName),
				isError: message.isError,
				text: redactSensitiveText(text).trim(),
			});
		}
	}
	return items;
}

/** 工具/技能目录：基础文本搜索常驻；大型文件运行时由用户按需安装。 */
async function buildCapabilityCatalog() {
	const status = await officecli.getLocalStatus();
	const pack = listPacks().find((item) => item.name === OFFICECLI_PACK_NAME);
	const skills = listOfficeCliSkills(CONSOLE_AGENT_DIR);
	const redteamStatus = await redteam.getLocalStatus();
	const redteamPack = listPacks().find((item) => item.name === redteam.REDTEAM_PACK_NAME);
	const browserPack = listPacks().find((item) => item.name === AGENT_BROWSER_PACK_NAME);
	const codeDevelopmentStatus = codeDevelopment.getCodeDevelopmentStatus();
	const codeDevelopmentPack = listPacks().find((item) => item.name === CODE_DEVELOPMENT_PACK_NAME);
	const codeDevelopmentCwd = workspace.getWorkspacePath() ?? DATA_DIR;
	const githubAccount = await codeDevelopment.getGithubAccountStatus(codeDevelopmentCwd);
	const developmentComponents = codeDevelopment.getDeveloperComponents();
	const developmentProject = codeDevelopment.detectProjectEnvironment(codeDevelopmentCwd);
	const developmentSkill = codeDevelopment.codeDevelopmentSkillInfo();
	const managedStatus = Object.fromEntries(
		(["pdfjs", "sevenzip", "ocr", "libreoffice"] as const).map((id) => [
			id,
			managedFileTools.getManagedToolStatus(id),
		]),
	);
	const packByName = new Map(listPacks().map((item) => [item.name, item]));
	return {
		tools: [
			{
				id: "code-development",
				internalName: "code-development",
				displayName: "代码开发",
				description:
					"一个完整的 Windows 开发能力：编辑代码、审核差异、管理 Git/GitHub，并按项目安装 Node.js、Python、Java、Go、Rust 与 .NET 环境。",
				category: "代码开发",
				formats: ["Git", "GitHub", "JavaScript", "TypeScript", "Python", "Java", "Go", "Rust", ".NET"],
				installed: codeDevelopmentStatus.installed,
				version: codeDevelopmentStatus.version,
				installPath: codeDevelopmentStatus.path,
				platform: `${process.platform}-${process.arch}`,
				iconText: "</>",
				sourceName: "mise、GitHub CLI 与 Monaco 官方组件",
				sourceUrl: "https://mise.jdx.dev/",
				activation: "识别到代码、Git 或 GitHub 任务时按本轮加载",
				capabilities: codeDevelopmentPack?.tools ?? [],
				skillCount: 1,
				installedSkillCount: developmentSkill.installed ? 1 : 0,
				components: developmentComponents,
				github: githubAccount,
				githubProgress: codeDevelopment.getGithubLoginProgress(),
				project: developmentProject,
			},
			{
				id: "agent-browser",
				internalName: "agent-browser",
				displayName: "客户端浏览器",
				description: "在 Pi 客户端侧栏中显示独立浏览器，智能体可打开、读取和操作网页，不占用你的 Chrome 窗口。",
				category: "效率工具",
				formats: ["网页", "网站", "表单", "下载"],
				installed: isAgentBrowserRuntimeAvailable(),
				version: browserPack?.version ?? "1.0.0",
				installPath: "Pi 控制台内置",
				platform: `${process.platform}-${process.arch}`,
				iconText: "网",
				sourceName: "Electron WebContentsView",
				sourceUrl: "https://www.electronjs.org/docs/latest/api/web-contents-view",
				activation: "识别到网页任务时按本轮加载",
				capabilities: browserPack?.tools ?? [],
				skillCount: 0,
				installedSkillCount: 0,
				removable: false,
			},
			{
				id: "officecli",
				internalName: "officecli",
				displayName: "Office 文件处理",
				description: "在本地创建、读取、编辑、检查和预览 Word、Excel、PowerPoint 文件。",
				category: "文档办公",
				formats: [".docx", ".xlsx", ".pptx"],
				installed: status.installed,
				version: status.version,
				installPath: status.path,
				platform: `${process.platform}-${process.arch}`,
				icon: "/officecli.svg",
				sourceName: "OfficeCLI 官方项目",
				sourceUrl: "https://github.com/iOfficeAI/OfficeCLI",
				activation: "按本轮需求加载",
				capabilities: pack?.tools ?? [],
				skillCount: skills.length,
				installedSkillCount: skills.filter((skill) => skill.installed).length,
			},
			{
				id: "pdfjs",
				internalName: "pdfjs",
				displayName: "PDF 渲染预览",
				description:
					"在客户端内使用 PDF.js 渲染 PDF，支持缩放、分页、搜索、复制与打印。仅负责查看，不抢占文件编辑任务。",
				category: "文件处理",
				formats: [".pdf"],
				installed: managedStatus.pdfjs.installed,
				version: managedStatus.pdfjs.version,
				installPath: managedStatus.pdfjs.path,
				platform: `${process.platform}-${process.arch}`,
				iconText: "PDF",
				sourceName: "Mozilla PDF.js 官方项目",
				sourceUrl: "https://github.com/mozilla/pdf.js",
				activation: "点击 PDF 时本地使用，不注入模型",
				capabilities: [],
				skillCount: 0,
				installedSkillCount: 0,
			},
			{
				id: "sevenzip",
				internalName: "7zip",
				displayName: "压缩包处理",
				description: "私有安装 7-Zip，用于查看、校验、解压和创建 ZIP、7z、RAR、TAR 等压缩包。",
				category: "文件处理",
				formats: [".zip", ".7z", ".rar", ".tar", ".gz", ".bz2", ".xz"],
				installed: managedStatus.sevenzip.installed,
				version: managedStatus.sevenzip.version,
				installPath: managedStatus.sevenzip.path,
				platform: `${process.platform}-${process.arch}`,
				iconText: "7Z",
				sourceName: "7-Zip 官方项目",
				sourceUrl: "https://github.com/ip7z/7zip",
				activation: "识别到压缩包任务时加载",
				capabilities: packByName.get("archive-files")?.tools ?? [],
				skillCount: 0,
				installedSkillCount: 0,
			},
			{
				id: "ocr",
				internalName: "tesseract_ocr",
				displayName: "图片文字识别",
				description:
					"私有安装 Tesseract OCR 与中英文语言数据，从图片或扫描页中提取文字。安装时自动准备 7-Zip 依赖。",
				category: "文件处理",
				formats: [".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp"],
				installed: managedStatus.ocr.installed,
				version: managedStatus.ocr.version,
				installPath: managedStatus.ocr.path,
				platform: `${process.platform}-${process.arch}`,
				iconText: "OCR",
				sourceName: "Tesseract OCR 官方项目",
				sourceUrl: "https://github.com/tesseract-ocr/tesseract",
				activation: "识别到图片文字任务时加载",
				capabilities: packByName.get("image-ocr")?.tools ?? [],
				skillCount: 0,
				installedSkillCount: 0,
			},
			{
				id: "libreoffice",
				internalName: "libreoffice",
				displayName: "兼容文档转换",
				description:
					"私有安装 LibreOffice，专门转换 .doc/.xls/.ppt 与 OpenDocument 等兼容格式；现代 Office 文件仍由 OfficeCLI 负责。",
				category: "文件处理",
				formats: [".doc", ".xls", ".ppt", ".odt", ".ods", ".odp", ".rtf"],
				installed: managedStatus.libreoffice.installed,
				version: managedStatus.libreoffice.version,
				installPath: managedStatus.libreoffice.path,
				platform: `${process.platform}-${process.arch}`,
				iconText: "LO",
				sourceName: "LibreOffice 官方项目",
				sourceUrl: "https://www.libreoffice.org/",
				activation: "识别到旧版或 OpenDocument 转换任务时加载",
				capabilities: packByName.get("legacy-documents")?.tools ?? [],
				skillCount: 0,
				installedSkillCount: 0,
			},
			{
				id: "redteam",
				internalName: "redteam",
				displayName: "红队演练",
				description:
					"对你的 AI 应用做自动化红队测试：生成攻击样本、执行越狱/注入/数据泄露等扫描、运行评估与模型对比，输出漏洞报告。",
				category: "安全测试",
				formats: ["promptfoo", "越狱", "注入", "漏洞扫描", "模型评估"],
				installed: redteamStatus.installed,
				version: redteamStatus.version,
				installPath: redteamStatus.path,
				platform: `${process.platform}-${process.arch}`,
				icon: "/redteam.svg",
				sourceName: "promptfoo 官方项目",
				sourceUrl: "https://github.com/promptfoo/promptfoo",
				activation: "按本轮需求加载",
				capabilities: redteamPack?.tools ?? [],
				skillCount: 0,
				installedSkillCount: 0,
			},
		],
		skillGroups: [
			{
				toolId: "code-development",
				toolInternalName: "code-development",
				toolDisplayName: "代码开发",
				toolInstalled: codeDevelopmentStatus.installed,
				icon: "",
				iconText: "</>",
				skills: [developmentSkill],
			},
			{
				toolId: "officecli",
				toolInternalName: "officecli",
				toolDisplayName: "Office 文件处理",
				toolInstalled: status.installed,
				icon: "/officecli.svg",
				skills,
			},
		],
		download: officecli.getDownloadProgress(),
		redteamDownload: redteam.getInstallProgress(),
		codeDevelopmentDownload: codeDevelopment.getCodeDevelopmentProgress(),
		toolProgress: Object.fromEntries(
			(["pdfjs", "sevenzip", "ocr", "libreoffice"] as const).map((id) => [
				id,
				managedFileTools.getManagedToolProgress(id),
			]),
		),
	};
}

// ---------------------------------------------------------------------------
// 模型枚举 / 图片解析 / 文件命名
// ---------------------------------------------------------------------------

/** 枚举全部 provider 的模型（含是否已配置鉴权），供前端模型选择器 */
function listModels(): Array<{ provider: string; modelId: string; label: string; hasAuth: boolean }> {
	const items: Array<{ provider: string; modelId: string; label: string; hasAuth: boolean }> = [];
	for (const provider of modelRuntime.getProviders()) {
		const hasAuth = modelRuntime.hasConfiguredAuth(provider.id);
		for (const model of modelRuntime.getModels(provider.id)) {
			items.push({
				provider: provider.id,
				modelId: model.id,
				label: `${provider.name ?? provider.id} · ${model.name ?? model.id}`,
				hasAuth,
			});
		}
	}
	return items;
}

// ---------------------------------------------------------------------------
// 模型服务 Key 管理（auth.json：Record<provider, {type:"api_key",key}>）
// ---------------------------------------------------------------------------

type AuthFileEntry = { type: "api_key"; key: string } | { type: "oauth"; [key: string]: unknown };
type AuthFile = Record<string, AuthFileEntry>;

function readAuthFile(): AuthFile {
	try {
		const data = JSON.parse(readFileSync(AUTH_FILE, "utf8"));
		if (typeof data === "object" && data !== null) return data as AuthFile;
	} catch {
		/* 不存在或损坏时视为空 */
	}
	return {};
}

function writeAuthFile(data: AuthFile): void {
	mkdirSync(CONSOLE_AGENT_DIR, { recursive: true });
	writeFileSync(AUTH_FILE, `${JSON.stringify(data, null, "\t")}\n`, "utf8");
}

function writeAuthEntry(provider: string, key: string): void {
	const data = readAuthFile();
	data[provider] = { type: "api_key", key };
	writeAuthFile(data);
}

function deleteAuthEntry(provider: string): boolean {
	const data = readAuthFile();
	if (data[provider]?.type !== "api_key") return false;
	delete data[provider];
	writeAuthFile(data);
	return true;
}

/** Key 列表：文件里已存的 + 环境变量配置的（标注来源），脱敏显示 */
function listKeys(): Array<{ provider: string; displayName: string; masked: string; source: "file" | "env" }> {
	const entries: Array<{ provider: string; displayName: string; masked: string; source: "file" | "env" }> = [];
	const names = new Map(modelRuntime.getProviders().map((p) => [p.id, p.name ?? p.id]));
	const authFile = readAuthFile();
	for (const [provider, entry] of Object.entries(authFile)) {
		if (entry.type !== "api_key") continue;
		entries.push({
			provider,
			displayName: names.get(provider) ?? provider,
			masked: maskKey(entry.key),
			source: "file",
		});
	}
	for (const provider of modelRuntime.getProviders()) {
		if (provider.id in authFile) continue;
		if (modelRuntime.hasConfiguredAuth(provider.id)) {
			entries.push({
				provider: provider.id,
				displayName: provider.name ?? provider.id,
				masked: "（环境变量）",
				source: "env",
			});
		}
	}
	return entries;
}

function maskKey(key: string): string {
	if (key.length <= 8) return "****";
	return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

/** 校验并归一化 prompt 的 images 参数；格式不对返回 undefined */
function parseImages(images: unknown): Array<{ type: "image"; data: string; mimeType: string }> | undefined {
	if (!Array.isArray(images)) return [];
	const result: Array<{ type: "image"; data: string; mimeType: string }> = [];
	for (const item of images) {
		const entry = item as { data?: unknown; mimeType?: unknown };
		if (typeof entry?.data !== "string" || typeof entry?.mimeType !== "string") return undefined;
		result.push({ type: "image", data: entry.data, mimeType: entry.mimeType });
	}
	return result;
}

/** 重名文件加后缀（name → name (1).ext），返回相对 uploads 目录的文件名 */
function uniquePath(dir: string, name: string): string {
	if (!existsSync(join(dir, name))) return name;
	const dot = name.lastIndexOf(".");
	const base = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : "";
	for (let i = 1; ; i++) {
		const candidate = `${base} (${i})${ext}`;
		if (!existsSync(join(dir, candidate))) return candidate;
	}
}

// ---------------------------------------------------------------------------
// HTTP 基础设施
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

async function resolveRequestFile(path: string, sessionId?: string): Promise<fsExplorer.AllowedFileInfo> {
	let cwd = workspace.getWorkspacePath() ?? DATA_DIR;
	if (sessionId) {
		const cs = await getOrRestoreSession(sessionId);
		if (cs) cwd = cs.session.sessionManager.getCwd();
	}
	return fsExplorer.getAllowedFileInfo(resolve(cwd, path));
}

function sendFileDownload(res: ServerResponse, file: fsExplorer.AllowedFileInfo): void {
	res.writeHead(200, {
		"Content-Type": file.mimeType,
		"Content-Length": file.size,
		"Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
		"Cache-Control": "no-store",
		"X-File-Name": encodeURIComponent(file.name),
	});
	const stream = createReadStream(file.path);
	stream.on("error", () => res.destroy());
	stream.pipe(res);
}

function sendFileInline(res: ServerResponse, file: fsExplorer.AllowedFileInfo): void {
	res.writeHead(200, {
		"Content-Type": file.mimeType,
		"Content-Length": file.size,
		"Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
		"Cache-Control": "no-store",
	});
	const stream = createReadStream(file.path);
	stream.on("error", () => res.destroy());
	stream.pipe(res);
}

function readBodyJson(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > maxBytes) {
				reject(new HttpBodyError("请求体过大", 413));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				reject(new Error("请求体不是合法的 JSON"));
			}
		});
		req.on("error", reject);
	});
}

/** 携带 HTTP 状态码的 body 错误（如 413） */
class HttpBodyError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

/** 静态文件只映射三个固定路径，不读任意文件 */
const STATIC_FILES: Record<string, { file: string; contentType: string }> = {
	"/": { file: "index.html", contentType: "text/html; charset=utf-8" },
	"/index.html": { file: "index.html", contentType: "text/html; charset=utf-8" },
	"/app.js": { file: "app.js", contentType: "text/javascript; charset=utf-8" },
	"/style.css": { file: "style.css", contentType: "text/css; charset=utf-8" },
	"/officecli.svg": { file: "officecli.svg", contentType: "image/svg+xml" },
	"/redteam.svg": { file: "redteam.svg", contentType: "image/svg+xml" },
};

function serveStatic(pathname: string, res: ServerResponse): boolean {
	const entry = STATIC_FILES[pathname];
	if (!entry) return false;
	try {
		const content = readFileSync(join(WEB_DIR, entry.file));
		res.writeHead(200, { "Content-Type": entry.contentType, "Cache-Control": "no-cache" });
		res.end(content);
	} catch {
		sendJson(res, 500, { error: `静态文件读取失败：${entry.file}` });
	}
	return true;
}

function isAuthorized(req: IncomingMessage, url: URL): boolean {
	if (!AUTH_TOKEN) return true;
	// EventSource 无法设置请求头，因此 SSE 额外接受 ?token= 查询参数
	if (url.searchParams.get("token") === AUTH_TOKEN) return true;
	const header = req.headers.authorization;
	return header === `Bearer ${AUTH_TOKEN}`;
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

function handleStream(req: IncomingMessage, res: ServerResponse, cs: ConsoleSession, sinceParam: string | null): void {
	res.writeHead(200, {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
	});
	res.write(": connected\n\n");

	const since = sinceParam !== null && /^-?\d+$/.test(sinceParam) ? Number(sinceParam) : -1;
	const oldest = cs.events[0]?.seq;

	// 缓冲已裁剪、无法完整补发时，让前端改走 /history 全量重建
	if (oldest !== undefined && since < oldest - 1) {
		res.write(`data: ${JSON.stringify({ seq: -1, type: "resync" })}\n\n`);
	} else {
		for (const event of cs.events) {
			if (event.seq > since) res.write(`data: ${JSON.stringify(event)}\n\n`);
		}
	}

	cs.sseClients.add(res);
	req.on("close", () => {
		cs.sseClients.delete(res);
	});
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

const server = createServer((req, res) => {
	handleRequest(req, res).catch((error) => {
		const message = error instanceof Error ? error.message : String(error);
		const status = error instanceof HttpBodyError ? error.status : 500;
		if (!res.headersSent) sendJson(res, status, { error: message });
	});
});

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (!isAllowedLoopbackHost(req.headers.host, PORT)) {
		sendJson(res, 403, { error: "请求地址不是 Pi 控制台本机地址" });
		return;
	}
	const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
	const pathname = url.pathname;

	if (req.method === "GET" && serveStatic(pathname, res)) return;
	if (req.method === "GET" && pathname.startsWith("/code-development/monaco/")) {
		const asset = codeDevelopment.resolveMonacoAsset(
			decodeURIComponent(pathname.slice("/code-development/monaco/".length)),
		);
		if (!asset) {
			sendJson(res, 404, { error: "代码开发插件未安装或 Monaco 资源不存在" });
			return;
		}
		res.writeHead(200, { "Content-Type": asset.mimeType, "Cache-Control": "no-cache" });
		// 传输途中资源目录被卸载删除时，无 error 监听的流会击穿进程
		createReadStream(asset.path)
			.on("error", () => res.destroy())
			.pipe(res);
		return;
	}
	if (req.method === "GET" && pathname.startsWith("/pdfjs/")) {
		const asset = managedFileTools.resolvePdfJsAsset(decodeURIComponent(pathname.slice("/pdfjs/".length)));
		if (!asset) {
			sendJson(res, 404, { error: "PDF.js 未安装或资源不存在" });
			return;
		}
		res.writeHead(200, { "Content-Type": asset.mimeType, "Cache-Control": "no-cache" });
		createReadStream(asset.path)
			.on("error", () => res.destroy())
			.pipe(res);
		return;
	}

	if (pathname.startsWith("/api/")) {
		if (!isAuthorized(req, url)) {
			sendJson(res, 401, { error: "未授权：请携带 Authorization: Bearer <token>" });
			return;
		}
		await handleApi(req, res, url, pathname);
		return;
	}

	sendJson(res, 404, { error: "Not Found" });
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, pathname: string): Promise<void> {
	// GET /api/sessions — 历史会话列表（左侧"对话"栏）
	if (req.method === "GET" && pathname === "/api/sessions") {
		const index = readSessionIndex();
		const list = Object.entries(index)
			.map(([id, entry]) => ({
				id,
				title: entry.title || "新对话",
				createdAt: entry.createdAt,
				updatedAt: entry.updatedAt,
				cwd: entry.cwd,
				assistants: packSummaries(entry.enabledPacks ?? []),
				active: sessions.has(id),
				streaming: sessions.get(id)?.session.isStreaming ?? false,
			}))
			.sort((a, b) => b.updatedAt - a.updatedAt);
		sendJson(res, 200, list);
		return;
	}

	// POST /api/sessions — 创建会话
	if (req.method === "POST" && pathname === "/api/sessions") {
		const body = (await readBodyJson(req)) as { assistants?: unknown };
		if (body?.assistants !== undefined && !Array.isArray(body.assistants)) {
			sendJson(res, 400, { error: 'assistants 需为能力包代码名数组，例如 ["office-assistant"]' });
			return;
		}
		const assistantNames = Array.isArray(body?.assistants)
			? body.assistants.filter((name): name is string => typeof name === "string")
			: [];
		if (Array.isArray(body?.assistants) && assistantNames.length !== body.assistants.length) {
			sendJson(res, 400, { error: "assistants 只能包含字符串" });
			return;
		}
		const unavailable = assistantNames.filter((name) => !isMountedPack(name));
		if (unavailable.length > 0) {
			sendJson(res, 400, { error: `助手未启用或不存在：${unavailable.join("、")}` });
			return;
		}
		const result = await createConsoleSession([...new Set([...mountedPacks(), ...assistantNames])]);
		sendJson(res, 200, result);
		return;
	}

	// 工具与技能目录（当前仅 OfficeCLI）
	if (pathname === "/api/catalog" && req.method === "GET") {
		sendJson(res, 200, await buildCapabilityCatalog());
		return;
	}
	if (pathname === "/api/tools/code-development/install" && req.method === "POST") {
		const started = codeDevelopment.startCodeDevelopmentInstall();
		if (!started) {
			sendJson(res, 409, { error: "代码开发插件安装已在进行中" });
			return;
		}
		void (async () => {
			while (codeDevelopment.getCodeDevelopmentProgress().running) {
				await new Promise((resolvePromise) => setTimeout(resolvePromise, 750));
			}
			if (!codeDevelopment.getCodeDevelopmentProgress().error) {
				activatePackForAllSessions(CODE_DEVELOPMENT_PACK_NAME);
				await reloadInstalledSkillsInSessions();
			}
		})();
		sendJson(res, 202, { ok: true });
		return;
	}
	if (pathname === "/api/tools/code-development/progress" && req.method === "GET") {
		sendJson(res, 200, codeDevelopment.getCodeDevelopmentProgress());
		return;
	}
	if (pathname === "/api/tools/code-development/github" && req.method === "GET") {
		sendJson(res, 200, await codeDevelopment.getGithubAccountStatus(workspace.getWorkspacePath() ?? DATA_DIR));
		return;
	}
	if (pathname === "/api/tools/code-development/github/login" && req.method === "POST") {
		const started = codeDevelopment.startGithubLogin(workspace.getWorkspacePath() ?? DATA_DIR);
		if (!started) {
			sendJson(res, 409, { error: "GitHub 登录已在进行中" });
			return;
		}
		sendJson(res, 202, { ok: true });
		return;
	}
	if (pathname === "/api/tools/code-development/github/progress" && req.method === "GET") {
		sendJson(res, 200, codeDevelopment.getGithubLoginProgress());
		return;
	}
	if (pathname === "/api/tools/code-development/github" && req.method === "DELETE") {
		await codeDevelopment.logoutGithub(workspace.getWorkspacePath() ?? DATA_DIR);
		sendJson(res, 200, { ok: true });
		return;
	}
	const developmentComponentMatch = pathname.match(
		/^\/api\/tools\/code-development\/components\/(node|python|java|go|rust|dotnet)(?:\/(install|progress))?$/,
	);
	if (developmentComponentMatch) {
		const id = developmentComponentMatch[1] as codeDevelopment.DeveloperComponentId;
		const action = developmentComponentMatch[2];
		if (req.method === "POST" && action === "install") {
			const started = codeDevelopment.startDeveloperComponentInstall(id, workspace.getWorkspacePath() ?? DATA_DIR);
			if (!started) {
				sendJson(res, 409, { error: `${id} 安装已在进行中` });
				return;
			}
			sendJson(res, 202, { ok: true });
			return;
		}
		if (req.method === "GET" && action === "progress") {
			const component = codeDevelopment.getDeveloperComponents().find((item) => item.id === id);
			sendJson(res, 200, component?.progress ?? { error: `未知开发环境：${id}` });
			return;
		}
		if (req.method === "DELETE" && !action) {
			sendJson(res, 200, { ok: true, removed: await codeDevelopment.uninstallDeveloperComponent(id) });
			return;
		}
	}
	if (pathname === "/api/tools/code-development/repository" && req.method === "GET") {
		sendJson(res, 200, await codeDevelopment.getRepositorySummary(workspace.getWorkspacePath() ?? DATA_DIR));
		return;
	}
	const officeSkillInstallMatch = pathname.match(/^\/api\/tools\/officecli\/skills\/([a-z0-9-]+)\/install$/);
	if (officeSkillInstallMatch && req.method === "POST") {
		const installed = await installOfficeCliSkill(CONSOLE_AGENT_DIR, officeSkillInstallMatch[1]);
		activateOfficeCliForAllSessions();
		const reloadedSessions = installed.length > 0 ? await reloadInstalledSkillsInSessions() : 0;
		sendJson(res, 200, { ok: true, installed, reloadedSessions });
		return;
	}
	if (pathname === "/api/tools/officecli/skills/install-all" && req.method === "POST") {
		const installed = await installAllOfficeCliSkills(CONSOLE_AGENT_DIR);
		activateOfficeCliForAllSessions();
		const reloadedSessions = installed.length > 0 ? await reloadInstalledSkillsInSessions() : 0;
		sendJson(res, 200, { ok: true, installed, reloadedSessions });
		return;
	}

	// 能力包
	if (pathname === "/api/packs" && req.method === "GET") {
		sendJson(res, 200, listPacks());
		return;
	}
	const packMatch = pathname.match(/^\/api\/packs\/([^/]+)\/(mount|unmount)$/);
	if (packMatch && req.method === "POST") {
		const [, packName, action] = packMatch;
		const changed = action === "mount" ? mountPack(packName) : deactivatePackForAllSessions(packName);
		if (!changed) {
			sendJson(res, 404, { error: `能力包 ${packName} 不存在或状态未变化` });
			return;
		}
		sendJson(res, 200, { ok: true, mounted: action === "mount" });
		return;
	}

	// OfficeCLI 管理
	if (pathname === "/api/officecli/status" && req.method === "GET") {
		sendJson(res, 200, await officecli.getStatus());
		return;
	}
	if (
		(pathname === "/api/officecli/download" || pathname === "/api/tools/officecli/install") &&
		req.method === "POST"
	) {
		const progress = officecli.getDownloadProgress();
		if (progress.running) {
			sendJson(res, 409, { error: "下载已在进行中" });
			return;
		}
		// 异步下载，进度通过轮询 /api/officecli/progress 获取
		void officecli.downloadLatest().then(async () => {
			if (await officecli.isBinaryReady()) {
				officecli.ensureBinaryOnProcessPath();
				activateOfficeCliForAllSessions();
			}
		});
		sendJson(res, 202, { ok: true });
		return;
	}
	if (pathname === "/api/officecli/progress" && req.method === "GET") {
		sendJson(res, 200, officecli.getDownloadProgress());
		return;
	}
	if (pathname === "/api/tools/redteam/install" && req.method === "POST") {
		const progress = redteam.getInstallProgress();
		if (progress.running) {
			sendJson(res, 409, { error: "安装已在进行中" });
			return;
		}
		// 异步安装，进度通过轮询 /api/tools/redteam/progress 获取
		const started = redteam.startInstall(false);
		if (started) {
			// 安装成功后把红队包绑定到全部会话（每轮仍按需命中最小工具组）
			void (async () => {
				while (redteam.getInstallProgress().running) {
					await new Promise((resolve) => setTimeout(resolve, 1000));
				}
				if (!redteam.getInstallProgress().error) {
					activatePackForAllSessions(redteam.REDTEAM_PACK_NAME);
				}
			})();
		}
		sendJson(res, 202, { ok: started });
		return;
	}
	if (pathname === "/api/tools/redteam/progress" && req.method === "GET") {
		sendJson(res, 200, redteam.getInstallProgress());
		return;
	}
	const managedInstallMatch = pathname.match(/^\/api\/tools\/(pdfjs|sevenzip|ocr|libreoffice)\/install$/);
	if (managedInstallMatch && req.method === "POST") {
		const id = managedInstallMatch[1] as managedFileTools.ManagedToolId;
		const started = managedFileTools.startManagedToolInstall(id);
		if (!started) {
			sendJson(res, 409, { error: "安装已在进行中" });
			return;
		}
		void (async () => {
			while (managedFileTools.getManagedToolProgress(id).running) {
				await new Promise((resolvePromise) => setTimeout(resolvePromise, 750));
			}
			if (!managedFileTools.getManagedToolProgress(id).error) {
				const packName = MANAGED_TOOL_PACKS[id];
				if (packName) activatePackForAllSessions(packName);
				if (id === "ocr" && managedFileTools.getManagedToolStatus("sevenzip").installed) {
					activatePackForAllSessions("archive-files");
				}
			}
		})();
		sendJson(res, 202, { ok: true });
		return;
	}
	const managedProgressMatch = pathname.match(/^\/api\/tools\/(pdfjs|sevenzip|ocr|libreoffice)\/progress$/);
	if (managedProgressMatch && req.method === "GET") {
		sendJson(
			res,
			200,
			managedFileTools.getManagedToolProgress(managedProgressMatch[1] as managedFileTools.ManagedToolId),
		);
		return;
	}
	const toolUninstallMatch = pathname.match(
		/^\/api\/tools\/(officecli|redteam|code-development|pdfjs|sevenzip|ocr|libreoffice)$/,
	);
	if (toolUninstallMatch && req.method === "DELETE") {
		const runningSessionIds = [...sessions.values()].filter((cs) => cs.session.isStreaming).map((cs) => cs.sessionId);
		if (runningSessionIds.length > 0) {
			sendJson(res, 409, { error: "仍有会话正在运行，请等待任务完成或停止后再卸载工具" });
			return;
		}
		if (toolUninstallMatch[1] === "officecli") {
			await officePreview.stopAllOfficePreviews();
			const removedSkills = uninstallAllOfficeCliSkills(CONSOLE_AGENT_DIR);
			const result = officecli.uninstall();
			deactivatePackForAllSessions(OFFICECLI_PACK_NAME);
			const reloadedSessions = removedSkills ? await reloadInstalledSkillsInSessions() : 0;
			sendJson(res, 200, { ok: true, ...result, removedSkills, reloadedSessions });
			return;
		}
		if (toolUninstallMatch[1] === "redteam") {
			const removed = redteam.uninstall();
			deactivatePackForAllSessions(redteam.REDTEAM_PACK_NAME);
			sendJson(res, 200, { ok: true, removed });
			return;
		}
		if (toolUninstallMatch[1] === "code-development") {
			const removed = codeDevelopment.uninstallCodeDevelopment();
			deactivatePackForAllSessions(CODE_DEVELOPMENT_PACK_NAME);
			const reloadedSessions = await reloadInstalledSkillsInSessions();
			sendJson(res, 200, { ok: true, removed, reloadedSessions });
			return;
		}
		const id = toolUninstallMatch[1] as managedFileTools.ManagedToolId;
		const removed = managedFileTools.uninstallManagedTool(id);
		const packName = MANAGED_TOOL_PACKS[id];
		if (packName) deactivatePackForAllSessions(packName);
		sendJson(res, 200, { ok: true, removed });
		return;
	}
	if (pathname === "/api/office-preview/start" && req.method === "POST") {
		const body = (await readBodyJson(req)) as { path?: unknown; sessionId?: unknown };
		if (typeof body?.path !== "string" || !body.path.trim()) {
			sendJson(res, 400, { error: '请求体需为 {"path": "文档路径"}' });
			return;
		}
		try {
			const cs = typeof body.sessionId === "string" ? sessions.get(body.sessionId) : undefined;
			const cwd = cs?.session.sessionManager.getCwd() ?? workspace.getWorkspacePath() ?? DATA_DIR;
			const filePath = fsExplorer.resolveAllowedFilePath(resolve(cwd, body.path.trim()));
			sendJson(res, 200, await officePreview.startOfficePreview(filePath));
		} catch (error) {
			sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}
	const officePreviewStopMatch = pathname.match(/^\/api\/office-preview\/([a-f0-9-]+)\/stop$/);
	if (officePreviewStopMatch && req.method === "POST") {
		sendJson(res, 200, { ok: await officePreview.stopOfficePreview(officePreviewStopMatch[1]) });
		return;
	}

	// 模型枚举
	if (pathname === "/api/models" && req.method === "GET") {
		sendJson(res, 200, listModels());
		return;
	}

	// Codex 订阅登录（Pi 官方 openai-codex OAuth；使用设备码避免占用本地回调端口）
	if (pathname === "/api/oauth/openai-codex/status" && req.method === "GET") {
		sendJson(res, 200, codexOAuth.status());
		return;
	}
	if (pathname === "/api/oauth/openai-codex/start" && req.method === "POST") {
		sendJson(res, 202, await codexOAuth.start());
		return;
	}
	if (pathname === "/api/oauth/openai-codex" && req.method === "DELETE") {
		sendJson(res, 200, await codexOAuth.logout());
		return;
	}

	// 模型服务 Key 管理（auth.json 读写 + runtime 刷新）
	if (pathname === "/api/keys" && req.method === "GET") {
		sendJson(res, 200, listKeys());
		return;
	}
	if (pathname === "/api/keys" && req.method === "POST") {
		const body = (await readBodyJson(req)) as { provider?: unknown; key?: unknown };
		if (typeof body?.provider !== "string" || typeof body?.key !== "string" || !body.key.trim()) {
			sendJson(res, 400, { error: '请求体需为 {"provider": "...", "key": "..."}' });
			return;
		}
		if (!modelRuntime.getProvider(body.provider)) {
			sendJson(res, 404, { error: `未知的模型服务商：${body.provider}` });
			return;
		}
		writeAuthEntry(body.provider, body.key.trim());
		await modelRuntime.refresh();
		sendJson(res, 200, { ok: true });
		return;
	}
	const keyMatch = pathname.match(/^\/api\/keys\/([^/]+)$/);
	if (keyMatch && req.method === "DELETE") {
		const provider = decodeURIComponent(keyMatch[1]);
		if (!deleteAuthEntry(provider)) {
			sendJson(res, 404, { error: `${provider} 没有已保存的 Key` });
			return;
		}
		await modelRuntime.refresh();
		sendJson(res, 200, { ok: true });
		return;
	}

	// 工作区设置（用户可自行指定会话工作目录）
	if (pathname === "/api/workspace" && req.method === "GET") {
		sendJson(res, 200, { path: workspace.getWorkspacePath() });
		return;
	}
	if (pathname === "/api/workspace" && req.method === "POST") {
		const body = (await readBodyJson(req)) as { path?: unknown };
		if (typeof body?.path !== "string") {
			sendJson(res, 400, { error: '请求体需为 {"path": "..."}（空串表示清除工作区）' });
			return;
		}
		try {
			const result = workspace.setWorkspacePath(body.path);
			// sessionReset：工作区变了，前端应重建会话（旧会话 cwd 固化无法迁移）
			sendJson(res, 200, { ok: true, path: result.path, migrated: result.migrated, sessionReset: true });
		} catch (error) {
			sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}

	// Agent 数据目录：迁移完成后由桌面壳重启，下一次启动从新目录加载全部数据。
	if (pathname === "/api/storage" && req.method === "GET") {
		sendJson(res, 200, storage.getStorageInfo());
		return;
	}
	if (pathname === "/api/storage/migrate" && req.method === "POST") {
		const body = (await readBodyJson(req)) as { path?: unknown };
		if (typeof body?.path !== "string") {
			sendJson(res, 400, { error: '请求体需为 {"path": "..."}' });
			return;
		}
		if ([...sessions.values()].some((item) => item.session.isStreaming)) {
			sendJson(res, 409, { error: "Agent 正在执行任务，请等待本轮完成后再迁移" });
			return;
		}
		try {
			sendJson(res, 200, storage.migrateDataDirectory(body.path));
		} catch (error) {
			sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}

	// 本地资源管理器（Windows 安装版可浏览本机磁盘）
	if (pathname === "/api/fs/roots" && req.method === "GET") {
		sendJson(res, 200, fsExplorer.listRoots());
		return;
	}
	if (pathname === "/api/fs/list" && req.method === "GET") {
		const path = url.searchParams.get("path") ?? "";
		try {
			sendJson(res, 200, { ...fsExplorer.getDirectoryInfo(path), entries: fsExplorer.listDir(path) });
		} catch (error) {
			sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}
	if (pathname === "/api/fs/search" && req.method === "GET") {
		const path = url.searchParams.get("path") ?? "";
		const query = url.searchParams.get("q") ?? "";
		const mode = url.searchParams.get("mode") === "content" ? "content" : "name";
		try {
			sendJson(res, 200, await fsExplorer.searchFiles(path, query, mode));
		} catch (error) {
			sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}
	if (pathname === "/api/fs/copy" && req.method === "POST") {
		const body = (await readBodyJson(req)) as { source?: unknown; destination?: unknown };
		if (typeof body?.source !== "string" || typeof body?.destination !== "string") {
			sendJson(res, 400, { error: '请求体需为 {"source": "...", "destination": "..."}' });
			return;
		}
		try {
			sendJson(res, 200, fsExplorer.copyFileIntoDirectory(body.source, body.destination));
		} catch (error) {
			sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}
	if (pathname === "/api/fs/import" && req.method === "POST") {
		const body = (await readBodyJson(req, MAX_TOTAL_FILE_BYTES * 2)) as {
			name?: unknown;
			dataBase64?: unknown;
			destination?: unknown;
		};
		if (
			typeof body?.name !== "string" ||
			typeof body?.dataBase64 !== "string" ||
			typeof body?.destination !== "string"
		) {
			sendJson(res, 400, { error: "请求体需含 name、dataBase64 与 destination" });
			return;
		}
		try {
			sendJson(res, 200, fsExplorer.importFileIntoDirectory(body.name, body.dataBase64, body.destination));
		} catch (error) {
			sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}
	if (pathname === "/api/fs/read" && req.method === "GET") {
		const path = url.searchParams.get("path") ?? "";
		try {
			sendJson(res, 200, fsExplorer.readFileAsBase64(path));
		} catch (error) {
			sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}
	if (pathname === "/api/fs/text" && req.method === "GET") {
		try {
			sendJson(res, 200, fsExplorer.readTextFile(url.searchParams.get("path") ?? ""));
		} catch (error) {
			sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}
	if (pathname === "/api/fs/text" && req.method === "PUT") {
		const body = (await readBodyJson(req, 12 * 1024 * 1024)) as {
			path?: unknown;
			text?: unknown;
			expectedSha256?: unknown;
		};
		if (
			typeof body?.path !== "string" ||
			typeof body?.text !== "string" ||
			typeof body?.expectedSha256 !== "string"
		) {
			sendJson(res, 400, { error: '请求体需为 {"path":"...","text":"...","expectedSha256":"..."}' });
			return;
		}
		try {
			sendJson(res, 200, fsExplorer.writeTextFile(body.path, body.text, body.expectedSha256));
		} catch (error) {
			sendJson(res, 409, { error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}
	if (pathname === "/api/fs/raw" && req.method === "GET") {
		try {
			sendFileInline(res, fsExplorer.getAllowedFileInfo(url.searchParams.get("path") ?? ""));
		} catch (error) {
			sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}
	if (pathname === "/api/fs/download" && req.method === "GET") {
		const path = url.searchParams.get("path") ?? "";
		const sessionId = url.searchParams.get("sessionId") ?? undefined;
		if (!path) {
			sendJson(res, 400, { error: "缺少文件路径" });
			return;
		}
		try {
			sendFileDownload(res, await resolveRequestFile(path, sessionId));
		} catch (error) {
			sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}

	// 应用版本与自更新
	if (pathname === "/api/app/version" && req.method === "GET") {
		sendJson(res, 200, { version: updates.APP_VERSION });
		return;
	}
	if (pathname === "/api/app/github-token" && req.method === "GET") {
		sendJson(res, 200, updates.githubAuthStatus());
		return;
	}
	if (pathname === "/api/app/github-token" && req.method === "POST") {
		const body = (await readBodyJson(req)) as { token?: unknown };
		if (typeof body?.token !== "string" || !body.token.trim()) {
			sendJson(res, 400, { error: '请求体需为 {"token": "..."}' });
			return;
		}
		updates.setGithubToken(body.token.trim());
		sendJson(res, 200, { ok: true });
		return;
	}
	if (pathname === "/api/app/github-token" && req.method === "DELETE") {
		updates.clearGithubToken();
		sendJson(res, 200, { ok: true });
		return;
	}
	if (pathname === "/api/app/update-check" && req.method === "GET") {
		sendJson(res, 200, await updates.checkUpdate());
		return;
	}
	if (pathname === "/api/app/update" && req.method === "POST") {
		if (updates.getUpdateProgress().running) {
			sendJson(res, 409, { error: "更新已在进行中" });
			return;
		}
		void updates.runUpdate();
		sendJson(res, 202, { ok: true });
		return;
	}
	if (pathname === "/api/app/update-progress" && req.method === "GET") {
		sendJson(res, 200, updates.getUpdateProgress());
		return;
	}
	if (pathname === "/api/app/update-recovery" && req.method === "GET") {
		sendJson(res, 200, updates.getUpdateRecovery());
		return;
	}
	if (pathname === "/api/app/update-retry" && req.method === "POST") {
		try {
			await updates.retryPendingUpdate();
			sendJson(res, 202, { ok: true });
		} catch (error) {
			sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}

	// /api/sessions/:id/*
	const match = pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(.*))?$/);
	if (!match) {
		sendJson(res, 404, { error: "接口不存在" });
		return;
	}
	const sessionId = match[1];
	const action = match[2] ?? "";
	const cs = await getOrRestoreSession(sessionId);
	if (!cs) {
		sendJson(res, 404, { error: "会话不存在，请刷新页面重新创建" });
		return;
	}

	switch (`${req.method} ${action}`) {
		// GET /api/sessions/:id/stream?since=N — SSE 事件流
		case "GET stream": {
			handleStream(req, res, cs, url.searchParams.get("since"));
			return;
		}

		// POST /api/sessions/:id/messages — 发送用户消息（支持 images）
		case "POST messages": {
			const body = (await readBodyJson(req)) as { text?: unknown; images?: unknown; attachments?: unknown };
			const text = typeof body?.text === "string" ? body.text.trim() : "";
			const attachments = Array.isArray(body?.attachments)
				? body.attachments
						.filter((path): path is string => typeof path === "string" && path.trim().length > 0)
						.slice(0, 32)
				: [];
			if (body?.attachments !== undefined && !Array.isArray(body.attachments)) {
				sendJson(res, 400, { error: "attachments 需为文件路径数组" });
				return;
			}
			if (!text && attachments.length === 0) {
				sendJson(res, 400, { error: "消息正文和附件不能同时为空" });
				return;
			}
			if (cs.deleting) {
				sendJson(res, 409, { error: "当前会话正在删除，不能再提交消息" });
				return;
			}
			if (cs.session.isStreaming || cs.activePrompt) {
				sendJson(res, 409, { error: "当前正在运行中，请先停止或等待完成" });
				return;
			}
			const images = parseImages(body.images);
			if (Array.isArray(body.images) && !images) {
				sendJson(res, 400, { error: "images 参数格式错误，应为 [{ data: base64, mimeType }]" });
				return;
			}
			// URL 中的临时登录凭据绝不能进入 AgentSession/JSONL。模型只看到可导航的
			// 随机引用，browser_navigate 在当前进程内存中于执行前还原原始 URL。
			const safeText = vaultSensitiveUrlsInText(text);
			const promptText = appendAttachmentAnnotation(safeText, attachments);
			const capabilityTrace = prepareTurnCapabilities(cs, promptText);
			if (cs.enabledPacks.size > 0) {
				bufferAndBroadcast(cs, { type: "capability_selection", ...capabilityTrace });
			}
			// 立即回 202，错误（无模型、鉴权失败等）通过 SSE error 事件传递
			sendJson(res, 202, { ok: true });
			updateSessionTitle(
				cs.sessionId,
				redactSensitiveText(safeText) || attachments.map((path) => path.split(/[\\/]/).pop()).join("、"),
			);
			let resolvePreflight: (success: boolean) => void = () => undefined;
			const preflight = new Promise<boolean>((resolvePromise) => {
				resolvePreflight = resolvePromise;
			});
			const activePrompt: TrackedSessionPrompt = { preflight, done: Promise.resolve() };
			activePrompt.done = cs.session
				.prompt(promptText, { images, preflightResult: resolvePreflight })
				.catch((error) => {
					releaseTurnCapabilities(cs);
					bufferAndBroadcast(cs, {
						type: "error",
						message: error instanceof Error ? error.message : String(error),
					});
				})
				.finally(() => {
					if (cs.activePrompt === activePrompt) cs.activePrompt = null;
				});
			cs.activePrompt = activePrompt;
			return;
		}

		// POST /api/sessions/:id/artifacts — 解析回复中的真实本地文件，供前端展示下载卡片
		case "POST artifacts": {
			const body = (await readBodyJson(req)) as { text?: unknown; paths?: unknown };
			const text = typeof body?.text === "string" ? body.text : "";
			const explicitPaths = Array.isArray(body?.paths)
				? body.paths.filter((path): path is string => typeof path === "string").slice(0, 32)
				: [];
			const candidates = [...extractFileReferences(text), ...explicitPaths];
			const files: Array<fsExplorer.AllowedFileInfo & { officePreview: boolean }> = [];
			const seen = new Set<string>();
			for (const candidate of candidates) {
				try {
					const info = fsExplorer.getAllowedFileInfo(resolve(cs.session.sessionManager.getCwd(), candidate));
					const key = process.platform === "win32" ? info.path.toLocaleLowerCase("en-US") : info.path;
					if (seen.has(key)) continue;
					seen.add(key);
					files.push({ ...info, officePreview: officePreview.isOfficePreviewPath(info.path) });
				} catch {
					// 模型回复可能含示例路径或网页域名，只展示当前确实存在且允许访问的文件。
				}
			}
			sendJson(res, 200, { files });
			return;
		}

		// GET /api/sessions/:id/context — 上下文使用统计（本地估算，零 token 消耗）
		case "GET context": {
			const usage = cs.session.getContextUsage?.();
			const model = cs.session.model;
			const compaction = cs.session.settingsManager.getCompactionSettings();
			// 缓存统计：汇总消息 usage 的 cacheRead/cacheWrite（无法统计时为 null）
			let cacheRead = null;
			let cacheWrite = null;
			try {
				let read = 0;
				let write = 0;
				let found = false;
				for (const message of cs.session.messages) {
					const u = (message as { usage?: { cacheRead?: number; cacheWrite?: number } }).usage;
					if (u && (typeof u.cacheRead === "number" || typeof u.cacheWrite === "number")) {
						found = true;
						read += u.cacheRead ?? 0;
						write += u.cacheWrite ?? 0;
					}
				}
				if (found) {
					cacheRead = read;
					cacheWrite = write;
				}
			} catch {
				/* 保持 null */
			}
			sendJson(res, 200, {
				usage: usage ?? null,
				model: model
					? { provider: model.provider, modelId: model.id, name: model.name, contextWindow: model.contextWindow }
					: null,
				messageCount: cs.session.messages.length,
				thinkingLevel: cs.session.thinkingLevel,
				compaction,
				cacheRead,
				cacheWrite,
				enabledCapabilities: packSummaries(cs.enabledPacks),
				activeTools: activeToolSnapshot(cs.session),
				lastCapabilityTrace: cs.lastCapabilityTrace,
				lastUsage: cs.lastUsage,
			});
			return;
		}

		// POST /api/sessions/:id/attach-from-path — 把工作区/数据目录内的文件加入对话附件
		case "POST attach-from-path": {
			const body = (await readBodyJson(req)) as { path?: unknown };
			if (typeof body?.path !== "string" || !body.path) {
				sendJson(res, 400, { error: '请求体需为 {"path": "..."}' });
				return;
			}
			try {
				const file = fsExplorer.readFileAsBase64(body.path);
				sendJson(res, 200, { ...file, name: body.path.split(/[\\/]/).pop() });
			} catch (error) {
				sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}

		// POST /api/sessions/:id/files — 保存附件到会话工作目录 uploads/
		case "POST files": {
			const body = (await readBodyJson(req, MAX_TOTAL_FILE_BYTES + 4096)) as {
				files?: unknown;
			};
			if (!Array.isArray(body?.files) || body.files.length === 0) {
				sendJson(res, 400, { error: '请求体需为 {"files": [...]}' });
				return;
			}
			const uploadsDir = join(cs.session.sessionManager.getCwd(), "uploads");
			mkdirSync(uploadsDir, { recursive: true });
			const saved: string[] = [];
			let totalBytes = 0;
			for (const file of body.files as Array<{ name?: unknown; mimeType?: unknown; dataBase64?: unknown }>) {
				if (typeof file?.name !== "string" || typeof file?.dataBase64 !== "string") {
					sendJson(res, 400, { error: "files 每项需含 name 与 dataBase64" });
					return;
				}
				const data = Buffer.from(file.dataBase64, "base64");
				totalBytes += data.length;
				if (totalBytes > MAX_TOTAL_FILE_BYTES) {
					sendJson(res, 413, { error: `附件总量超过 ${MAX_TOTAL_FILE_BYTES / 1024 / 1024}MB 上限` });
					return;
				}
				if (data.length > MAX_FILE_BYTES) {
					sendJson(res, 413, { error: `单文件 ${file.name} 超过 ${MAX_FILE_BYTES / 1024 / 1024}MB 上限` });
					return;
				}
				const safeName = String(file.name)
					.replace(/[\\/:*?"<>|]/g, "_")
					.slice(0, 200);
				const relative = uniquePath(uploadsDir, safeName);
				writeFileSync(join(uploadsDir, relative), data);
				saved.push(`uploads/${relative}`);
			}
			sendJson(res, 200, { files: saved });
			return;
		}

		// POST /api/sessions/:id/abort — 中止当前运行
		case "POST abort": {
			if (cs.deleting) {
				sendJson(res, 409, { error: "当前会话正在删除" });
				return;
			}
			await abortTrackedSessionPrompt(cs.session, cs.activePrompt);
			sendJson(res, 200, { ok: true });
			return;
		}

		// POST /api/sessions/:id/model — 切换模型
		case "POST model": {
			const body = (await readBodyJson(req)) as { provider?: unknown; modelId?: unknown };
			if (typeof body?.provider !== "string" || typeof body?.modelId !== "string") {
				sendJson(res, 400, { error: '请求体需为 {"provider": "...", "modelId": "..."}' });
				return;
			}
			const model = modelRuntime.getModel(body.provider, body.modelId);
			if (!model) {
				sendJson(res, 404, { error: `模型不存在：${body.provider}/${body.modelId}` });
				return;
			}
			try {
				await cs.session.setModel(model);
			} catch (error) {
				sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
				return;
			}
			// 通过 SSE 通知前端同步（persist 由 setModel 内部写 settingsManager 完成）
			bufferAndBroadcast(cs, {
				type: "model_changed",
				provider: body.provider,
				modelId: body.modelId,
				availableThinkingLevels: cs.session.getAvailableThinkingLevels(),
				enabledCapabilities: packSummaries(cs.enabledPacks),
			});
			sendJson(res, 200, {
				ok: true,
				provider: body.provider,
				modelId: body.modelId,
				thinkingLevel: cs.session.thinkingLevel,
				availableThinkingLevels: cs.session.getAvailableThinkingLevels(),
			});
			return;
		}

		// POST /api/sessions/:id/thinking — 切换思考等级
		case "POST thinking": {
			const body = (await readBodyJson(req)) as { level?: unknown };
			if (typeof body?.level !== "string" || !(THINKING_LEVELS as readonly string[]).includes(body.level)) {
				sendJson(res, 400, { error: `level 需为：${THINKING_LEVELS.join(" / ")}` });
				return;
			}
			cs.session.setThinkingLevel(body.level as (typeof THINKING_LEVELS)[number]);
			sendJson(res, 200, { level: cs.session.thinkingLevel });
			return;
		}

		// GET /api/sessions/:id/history — 消息快照
		case "GET history": {
			const model = cs.session.model;
			sendJson(res, 200, {
				sessionId: cs.sessionId,
				streaming: cs.session.isStreaming,
				messages: buildHistory(cs.session, cs.enabledPacks),
				model: model ? { provider: model.provider, modelId: model.id, label: model.name } : null,
				thinkingLevel: cs.session.thinkingLevel,
				availableThinkingLevels: cs.session.getAvailableThinkingLevels(),
				enabledCapabilities: packSummaries(cs.enabledPacks),
				// 当前事件缓冲的最新序号：前端恢复历史后从该序号续接 SSE，避免重放重复
				lastSeq: cs.nextSeq - 1,
			});
			return;
		}

		// PATCH /api/sessions/:id — 修改左侧历史会话名称
		case "PATCH ": {
			const body = (await readBodyJson(req)) as { title?: unknown };
			if (typeof body?.title !== "string") {
				sendJson(res, 400, { error: '请求体需为 {"title": "..."}' });
				return;
			}
			const title = renameSession(sessionId, body.title);
			if (!title) {
				sendJson(res, 400, { error: "会话名称不能为空" });
				return;
			}
			sendJson(res, 200, { ok: true, title });
			return;
		}

		// DELETE /api/sessions/:id — 删除会话（记录 + 会话文件；工作区文件保留）
		case "DELETE ": {
			if (cs.deleting) {
				sendJson(res, 409, { error: "会话删除已在进行中" });
				return;
			}
			cs.deleting = true;
			try {
				await disposeSessionBeforeDelete(cs.session, cs.activePrompt);
			} catch (error) {
				cs.deleting = false;
				throw error;
			}
			for (const client of cs.sseClients) client.end();
			sessions.delete(sessionId);
			const index = readSessionIndex();
			const entry = index[sessionId];
			if (entry?.sessionFile) {
				try {
					unlinkSync(entry.sessionFile);
				} catch {
					/* 文件可能已不存在 */
				}
			}
			delete index[sessionId];
			writeSessionIndex(index);
			sendJson(res, 200, { ok: true });
			return;
		}

		default:
			sendJson(res, 404, { error: "接口不存在" });
	}
}

server.on("error", (error: NodeJS.ErrnoException) => {
	if (error.code === "EADDRINUSE") {
		console.error(`端口 ${PORT} 已被占用。请先停掉旧进程，或用 PORT 环境变量换一个端口。`);
	} else {
		console.error(`服务器错误：${error.message}`);
	}
	process.exit(1);
});

server.on("close", () => {
	codexOAuth.cancel();
	void officePreview.stopAllOfficePreviews();
});
process.once("exit", officePreview.terminateAllOfficePreviewsNow);

server.listen(PORT, HOST, () => {
	console.log(`Pi 控制台已启动：http://${HOST}:${PORT}`);
	console.log(`数据目录：${DATA_DIR}`);
	if (MODEL_SPEC) console.log(`模型（PI_CONSOLE_MODEL）：${MODEL_SPEC}`);
	else console.log("模型：Pi 默认解析（settings / 上次选择）");
	if (AUTH_TOKEN) console.log("鉴权：已启用（PI_CONSOLE_TOKEN），/api/* 需要 Bearer token");
	const packs = listPacks();
	console.log(`能力包：${packs.length} 个已安装，已挂载：${mountedPacks().join(", ") || "(无)"}`);
	void officecli.getStatus().then((status) => {
		if (status.installed) console.log(`OfficeCLI：已安装 v${status.version}`);
		else console.log("OfficeCLI：未安装（页面可一键下载）");
	});
});
