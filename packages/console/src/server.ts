/**
 * Pi Web 控制台 — 第 2 步：能力包框架 + Office 助手包 + 前端增强
 *
 * 默认形态仍是纯净原生 Pi（read/bash/edit/write + 官方系统提示词）；
 * 能力包通过 customTools 注册、setActiveToolsByName 挂载/卸载。
 *
 * 全部后端逻辑都在 src/ 下按模块拆分，HTTP 层只用 node:http 原生模块，不引入框架。
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import * as fsExplorer from "./fs.ts";
import * as officecli from "./officecli.ts";
import {
	activeToolNames,
	instantiatePackTools,
	listPacks,
	loadPacks,
	mountedPacks,
	mountPack,
	unmountPack,
} from "./packs.ts";
import { DATA_DIR } from "./paths.ts";
import * as updates from "./updates.ts";
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
/**
 * 控制台专属 agentDir：模型/思考等级选择通过 Pi 的 SettingsManager 原生持久化在这里
 * （<DATA_DIR>/agent/settings.json），新会话自动沿用，且不污染用户全局 ~/.pi/agent/settings.json
 */
const CONSOLE_AGENT_DIR = join(DATA_DIR, "agent");

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
}

const sessions = new Map<string, ConsoleSession>();

/** API Key 存储文件（控制台专属，与 agent settings 同目录；格式 Record<provider, {type:"api_key",key}>） */
const AUTH_FILE = join(CONSOLE_AGENT_DIR, "auth.json");

/** 全服共享一个 ModelRuntime，启动时创建；auth 指向控制台专属文件（页面添加的 Key 在此持久化） */
const modelRuntime = await ModelRuntime.create({ authPath: AUTH_FILE });

// 加载能力包（新加的包重启服务后生效）
await loadPacks();

// 首启引导：把安装包预置的 OfficeCLI 拷到外置数据目录（开发模式两者同路径，无操作）
if (officecli.seedBundledBinary()) {
	console.log("已把预置的 OfficeCLI 复制到数据目录");
}

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
				return { type: "text_delta", delta: inner.delta };
			}
			if (inner.type === "thinking_delta") {
				// 思考内容随事件下发，前端在可折叠的"思考过程"区滚动显示
				return { type: "thinking_delta", delta: inner.delta };
			}
			return undefined;
		}
		case "tool_execution_start":
			return {
				type: "tool_execution_start",
				toolCallId: ev.toolCallId,
				toolName: ev.toolName,
				args: ev.args,
			};
		case "tool_execution_end":
			return {
				type: "tool_execution_end",
				toolCallId: ev.toolCallId,
				toolName: ev.toolName,
				isError: ev.isError,
				result: summarizeToolResult(ev.result),
			};
		case "turn_end": {
			const message = ev.message as {
				stopReason?: string;
				errorMessage?: string;
				usage?: unknown;
			};
			return {
				type: "turn_end",
				stopReason: message.stopReason,
				errorMessage: message.errorMessage,
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
				errorMessage: ev.errorMessage,
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
		text = result;
	} else if (typeof result === "object" && Array.isArray((result as { content?: unknown }).content)) {
		// AgentToolResult：拼 content 里全部 text 块
		text = (result as { content: Array<{ type?: string; text?: unknown }> }).content
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text as string)
			.join("\n");
	} else {
		try {
			text = JSON.stringify(result) ?? "";
		} catch {
			text = String(result);
		}
	}
	text = text.replace(/\s+/g, " ").trim();
	return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function bufferAndBroadcast(cs: ConsoleSession, clientEvent: { type: string; [key: string]: unknown }): void {
	const event: BufferedEvent = { seq: cs.nextSeq++, ...clientEvent };
	cs.events.push(event);
	if (cs.events.length > MAX_BUFFERED_EVENTS) {
		cs.events.splice(0, cs.events.length - MAX_BUFFERED_EVENTS);
	}
	const payload = `data: ${JSON.stringify(event)}\n\n`;
	for (const client of cs.sseClients) {
		client.write(payload);
	}
}

async function createConsoleSession(): Promise<{ sessionId: string; warning?: string }> {
	const sessionId = randomUUID();
	// 用户设置了工作区则以其为会话工作目录（多会话共享）；否则用默认 workspaces/<uuid>
	const workspacePath = workspace.getWorkspacePath();
	const cwd = workspacePath ?? join(WORKSPACES_DIR, sessionId);
	mkdirSync(cwd, { recursive: true });
	mkdirSync(CONSOLE_AGENT_DIR, { recursive: true });

	const sessionManager = SessionManager.inMemory(cwd);
	const options: {
		cwd: string;
		modelRuntime: ModelRuntime;
		sessionManager: SessionManager;
		agentDir: string;
		model?: SessionModel;
		customTools: ReturnType<typeof instantiatePackTools>;
	} = {
		cwd,
		modelRuntime,
		sessionManager,
		agentDir: CONSOLE_AGENT_DIR,
		// 每会话独立实例化能力包工具，execute 时通过 getWorkspaceRoot 拿到本会话 cwd
		customTools: instantiatePackTools({ getWorkspaceRoot: () => cwd }),
	};

	if (MODEL_SPEC) {
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

	// 挂载语义：内置 4 个工具 + 已挂载包的工具；未挂载任何包 = 纯净原生 Pi
	session.setActiveToolsByName(activeToolNames());

	const cs: ConsoleSession = {
		sessionId,
		session,
		events: [],
		nextSeq: 0,
		sseClients: new Set(),
	};
	sessions.set(sessionId, cs);

	session.subscribe((ev) => {
		const clientEvent = toClientEvent(ev);
		if (clientEvent) bufferAndBroadcast(cs, clientEvent);
	});

	// 默认模型解析失败时（如未配置任何 Key），通过 SSE 告知前端
	if (modelFallbackMessage) {
		bufferAndBroadcast(cs, { type: "error", message: modelFallbackMessage });
	}

	return { sessionId, warning: modelFallbackMessage };
}

// ---------------------------------------------------------------------------
// 历史快照
// ---------------------------------------------------------------------------

interface HistoryItem {
	role: "user" | "assistant" | "toolResult";
	[key: string]: unknown;
}

/** 从 session.messages 生成消息快照（user/assistant 文本 + 工具调用记录），供页面刷新恢复 */
function buildHistory(session: AgentSession): HistoryItem[] {
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
				if (hasImage) text = `${text}${text ? "\n" : ""}[图片]`;
			}
			if (text.trim()) items.push({ role: "user", text });
		} else if (message.role === "assistant") {
			const text = message.content
				.filter((block) => block.type === "text")
				.map((block) => (block.type === "text" ? block.text : ""))
				.join("\n");
			const toolCalls = message.content
				.filter((block) => block.type === "toolCall")
				.map((block) =>
					block.type === "toolCall" ? { id: block.id, name: block.name, args: block.arguments } : undefined,
				)
				.filter((call) => call !== undefined);
			const item: HistoryItem = { role: "assistant", text };
			if (toolCalls.length > 0) item.toolCalls = toolCalls;
			if (message.stopReason === "error" && message.errorMessage) item.errorMessage = message.errorMessage;
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
				isError: message.isError,
				text: text.trim(),
			});
		}
	}
	return items;
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

type AuthFile = Record<string, { type: "api_key"; key: string }>;

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
	if (!(provider in data)) return false;
	delete data[provider];
	writeAuthFile(data);
	return true;
}

/** Key 列表：文件里已存的 + 环境变量配置的（标注来源），脱敏显示 */
function listKeys(): Array<{ provider: string; displayName: string; masked: string; source: "file" | "env" }> {
	const entries: Array<{ provider: string; displayName: string; masked: string; source: "file" | "env" }> = [];
	const names = new Map(modelRuntime.getProviders().map((p) => [p.id, p.name ?? p.id]));
	for (const [provider, entry] of Object.entries(readAuthFile())) {
		entries.push({
			provider,
			displayName: names.get(provider) ?? provider,
			masked: maskKey(entry.key),
			source: "file",
		});
	}
	for (const provider of modelRuntime.getProviders()) {
		if (provider.id in readAuthFile()) continue;
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
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? HOST}`);
	const pathname = url.pathname;

	if (req.method === "GET" && serveStatic(pathname, res)) return;

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
	// POST /api/sessions — 创建会话
	if (req.method === "POST" && pathname === "/api/sessions") {
		const result = await createConsoleSession();
		sendJson(res, 200, result);
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
		const changed = action === "mount" ? mountPack(packName) : unmountPack(packName);
		if (!changed) {
			sendJson(res, 404, { error: `能力包 ${packName} 不存在或状态未变化` });
			return;
		}
		// 对全部存活会话立即生效（下一轮起用，不丢历史）
		const names = activeToolNames();
		for (const cs of sessions.values()) {
			cs.session.setActiveToolsByName(names);
		}
		sendJson(res, 200, { ok: true, mounted: action === "mount" });
		return;
	}

	// OfficeCLI 管理
	if (pathname === "/api/officecli/status" && req.method === "GET") {
		sendJson(res, 200, await officecli.getStatus());
		return;
	}
	if (pathname === "/api/officecli/download" && req.method === "POST") {
		const progress = officecli.getDownloadProgress();
		if (progress.running) {
			sendJson(res, 409, { error: "下载已在进行中" });
			return;
		}
		// 异步下载，进度通过轮询 /api/officecli/progress 获取
		void officecli.downloadLatest();
		sendJson(res, 202, { ok: true });
		return;
	}
	if (pathname === "/api/officecli/progress" && req.method === "GET") {
		sendJson(res, 200, officecli.getDownloadProgress());
		return;
	}

	// 模型枚举
	if (pathname === "/api/models" && req.method === "GET") {
		sendJson(res, 200, listModels());
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
			const path = workspace.setWorkspacePath(body.path);
			sendJson(res, 200, { ok: true, path });
		} catch (error) {
			sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}

	// 本地资源管理器（受限浏览）
	if (pathname === "/api/fs/roots" && req.method === "GET") {
		sendJson(res, 200, fsExplorer.listRoots());
		return;
	}
	if (pathname === "/api/fs/list" && req.method === "GET") {
		const path = url.searchParams.get("path") ?? "";
		try {
			sendJson(res, 200, { entries: fsExplorer.listDir(path) });
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

	// 应用版本与自更新
	if (pathname === "/api/app/version" && req.method === "GET") {
		sendJson(res, 200, { version: updates.APP_VERSION });
		return;
	}
	if (pathname === "/api/app/github-token" && req.method === "GET") {
		sendJson(res, 200, { configured: updates.githubToken() !== null });
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

	// /api/sessions/:id/*
	const match = pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(.*))?$/);
	if (!match) {
		sendJson(res, 404, { error: "接口不存在" });
		return;
	}
	const sessionId = match[1];
	const action = match[2] ?? "";
	const cs = sessions.get(sessionId);
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
			const body = (await readBodyJson(req)) as { text?: unknown; images?: unknown };
			const text = typeof body?.text === "string" ? body.text.trim() : "";
			if (!text) {
				sendJson(res, 400, { error: '请求体需为 {"text": "..."} 且不能为空' });
				return;
			}
			if (cs.session.isStreaming) {
				sendJson(res, 409, { error: "当前正在运行中，请先停止或等待完成" });
				return;
			}
			const images = parseImages(body.images);
			if (Array.isArray(body.images) && !images) {
				sendJson(res, 400, { error: "images 参数格式错误，应为 [{ data: base64, mimeType }]" });
				return;
			}
			// 立即回 202，错误（无模型、鉴权失败等）通过 SSE error 事件传递
			sendJson(res, 202, { ok: true });
			cs.session.prompt(text, { images }).catch((error) => {
				bufferAndBroadcast(cs, {
					type: "error",
					message: error instanceof Error ? error.message : String(error),
				});
			});
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
			await cs.session.abort();
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
			});
			sendJson(res, 200, { ok: true, provider: body.provider, modelId: body.modelId });
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
				messages: buildHistory(cs.session),
				model: model ? { provider: model.provider, modelId: model.id, label: model.name } : null,
				thinkingLevel: cs.session.thinkingLevel,
				// 当前事件缓冲的最新序号：前端恢复历史后从该序号续接 SSE，避免重放重复
				lastSeq: cs.nextSeq - 1,
			});
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
