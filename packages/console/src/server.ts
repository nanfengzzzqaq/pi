/**
 * Pi Web 控制台 — 第 1 步：后端骨架 + 最简对话页面
 *
 * 纯净原生 Pi：不注册自定义工具、不覆盖系统提示词，
 * 默认启用内置 read/bash/edit/write 工具与官方系统提示词。
 *
 * 全部后端逻辑都在这一个文件里，只用 node:http 原生模块，不引入框架。
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT ?? 3200);
/** 可选鉴权：设置后所有 /api/* 请求必须带 Authorization: Bearer <token>（或 ?token=），静态页面放行 */
const AUTH_TOKEN = process.env.PI_CONSOLE_TOKEN;
/** 可选模型：格式 provider/model-id，如 zai-coding-cn/glm-5.2；未设置则走 Pi 默认解析 */
const MODEL_SPEC = process.env.PI_CONSOLE_MODEL;

const PACKAGE_ROOT = join(import.meta.dirname, ".."); // packages/console
const WEB_DIR = join(PACKAGE_ROOT, "web");
const WORKSPACES_DIR = join(PACKAGE_ROOT, "data", "workspaces");

/** 每会话保留的最近事件数（SSE 重连补发用） */
const MAX_BUFFERED_EVENTS = 500;
/** 请求 body 大小上限 */
const MAX_BODY_BYTES = 1024 * 1024;

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

/** 全服共享一个 ModelRuntime，启动时创建 */
const modelRuntime = await ModelRuntime.create();

// 预热：扩展注册的自定义 provider 只有在某个会话加载扩展之后才会出现在
// ModelRuntime 里。启动时先加载一次全局扩展，PI_CONSOLE_MODEL 才能引用它们。
try {
	const warmupCwd = join(PACKAGE_ROOT, "data", "warmup");
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
				// 只用于前端显示"思考中"指示，不传输思考内容
				return { type: "thinking_delta" };
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
		default:
			return undefined;
	}
}

/** 工具结果可能很长，压成单行摘要再转发 */
function summarizeToolResult(result: unknown): string {
	if (result === undefined || result === null) return "";
	let text: string;
	if (typeof result === "string") {
		text = result;
	} else if (
		typeof result === "object" &&
		"text" in result &&
		typeof (result as { text: unknown }).text === "string"
	) {
		text = (result as { text: string }).text;
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
	const cwd = join(WORKSPACES_DIR, sessionId);
	mkdirSync(cwd, { recursive: true });

	const sessionManager = SessionManager.inMemory(cwd);
	const options: { cwd: string; modelRuntime: ModelRuntime; sessionManager: SessionManager; model?: SessionModel } = {
		cwd,
		modelRuntime,
		sessionManager,
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
			const text =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((block) => block.type === "text")
							.map((block) => (block.type === "text" ? block.text : ""))
							.join("\n");
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
// HTTP 基础设施
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

function readBodyJson(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error("请求体过大"));
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
		if (!res.headersSent) sendJson(res, 500, { error: message });
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

		// POST /api/sessions/:id/messages — 发送用户消息
		case "POST messages": {
			const body = await readBodyJson(req);
			const text =
				typeof (body as { text?: unknown })?.text === "string" ? (body as { text: string }).text.trim() : "";
			if (!text) {
				sendJson(res, 400, { error: '请求体需为 {"text": "..."} 且不能为空' });
				return;
			}
			if (cs.session.isStreaming) {
				sendJson(res, 409, { error: "当前正在运行中，请先停止或等待完成" });
				return;
			}
			// 立即回 202，错误（无模型、鉴权失败等）通过 SSE error 事件传递
			sendJson(res, 202, { ok: true });
			cs.session.prompt(text).catch((error) => {
				bufferAndBroadcast(cs, {
					type: "error",
					message: error instanceof Error ? error.message : String(error),
				});
			});
			return;
		}

		// POST /api/sessions/:id/abort — 中止当前运行
		case "POST abort": {
			await cs.session.abort();
			sendJson(res, 200, { ok: true });
			return;
		}

		// GET /api/sessions/:id/history — 消息快照
		case "GET history": {
			sendJson(res, 200, {
				sessionId: cs.sessionId,
				streaming: cs.session.isStreaming,
				messages: buildHistory(cs.session),
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
	if (MODEL_SPEC) console.log(`模型（PI_CONSOLE_MODEL）：${MODEL_SPEC}`);
	else console.log("模型：Pi 默认解析（settings / 可用凭据）");
	if (AUTH_TOKEN) console.log("鉴权：已启用（PI_CONSOLE_TOKEN），/api/* 需要 Bearer token");
});
