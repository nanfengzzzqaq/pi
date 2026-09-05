import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, get, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { needsEventResync } from "../src/event-replay.ts";

interface SessionEvents {
	events: Array<{ seq: number; type: string; text?: string }>;
	nextSeq: number;
	streamEpoch: string;
	sseClients: Set<ServerResponse>;
}

interface Heartbeat {
	callback: () => void;
	unref: () => void;
}

type StreamHandler = (res: ServerResponse, cs: SessionEvents, since: string | null, epoch: string | null) => void;

// Execute the real route function without starting provider/account initialization in server.ts.
const source = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("server.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const declaration = tree.statements.find(
	(node) => ts.isFunctionDeclaration(node) && node.name?.text === "handleStream",
);
if (!declaration) throw new Error("没有找到真实 SSE 处理函数");
const executable = ts.transpileModule(`${declaration.getText(tree)}\nhandleStream;`, {
	compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

let server: Server;
let origin: string;
let session: SessionEvents;
let heartbeats: Set<Heartbeat>;
let completedRequests: number;

beforeEach(async () => {
	session = { events: [], nextSeq: 0, streamEpoch: "epoch-current", sseClients: new Set() };
	heartbeats = new Set();
	completedRequests = 0;
	const handleStream = runInNewContext(executable, {
		needsEventResync,
		setInterval: (callback: () => void, milliseconds: number) => {
			expect(milliseconds).toBe(15_000);
			const heartbeat: Heartbeat = { callback, unref: vi.fn() };
			heartbeats.add(heartbeat);
			return heartbeat;
		},
		clearInterval: (heartbeat: Heartbeat) => heartbeats.delete(heartbeat),
	}) as StreamHandler;
	server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		req.on("end", () => completedRequests++);
		req.resume();
		handleStream(res, session, url.searchParams.get("since"), url.searchParams.get("epoch"));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("测试 SSE 服务没有绑定端口");
	origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

async function connect(path = "/") {
	const response = await new Promise<IncomingMessage>((resolve, reject) => {
		get(`${origin}${path}`, resolve).on("error", reject);
	});
	let text = "";
	response.setEncoding("utf8");
	response.on("data", (chunk: string) => {
		text += chunk;
	});
	return { response, text: () => text };
}

describe("SSE HTTP 连接生命周期", () => {
	it("请求读取完毕后仍保持 SSE 客户端注册并可继续接收事件", async () => {
		const stream = await connect("/?since=-1&epoch=epoch-current");
		await vi.waitFor(() => expect(completedRequests).toBe(1));
		expect(session.sseClients.size).toBe(1);
		expect(stream.response.headers["content-type"]).toContain("text/event-stream");
		const client = [...session.sseClients][0];
		client.write('data: {"seq":0,"type":"text_delta","text":"later"}\n\n');
		await vi.waitFor(() => expect(stream.text()).toContain('"text":"later"'));
		expect(heartbeats.size).toBe(1);
		const heartbeat = [...heartbeats][0];
		expect(heartbeat.unref).toHaveBeenCalledOnce();
		heartbeat.callback();
		await vi.waitFor(() => expect(stream.text()).toContain(": heartbeat\n\n"));
	});

	it("客户端断开响应后清除注册与心跳计时器", async () => {
		const stream = await connect();
		await vi.waitFor(() => expect(session.sseClients.size).toBe(1));
		stream.response.destroy();
		await vi.waitFor(() => {
			expect(session.sseClients.size).toBe(0);
			expect(heartbeats.size).toBe(0);
		});
	});

	it("服务器结束响应时也清除注册与心跳计时器", async () => {
		const stream = await connect();
		await vi.waitFor(() => expect(session.sseClients.size).toBe(1));
		const ended = once(stream.response, "end");
		[...session.sseClients][0].end();
		await ended;
		await vi.waitFor(() => {
			expect(session.sseClients.size).toBe(0);
			expect(heartbeats.size).toBe(0);
		});
	});

	it("有效游标只补发尚未收到的事件", async () => {
		session.events = [
			{ seq: 0, type: "text_delta", text: "already seen" },
			{ seq: 1, type: "text_delta", text: "replayed" },
		];
		session.nextSeq = 2;
		const stream = await connect("/?since=0&epoch=epoch-current");
		await vi.waitFor(() => expect(stream.text()).toContain("replayed"));
		expect(stream.text()).not.toContain("already seen");
		expect(session.sseClients.size).toBe(1);
	});

	it.each(["/?since=0&epoch=epoch-old", "/?since=500&epoch=epoch-current", "/?since=-2"])(
		"需要重建时返回完整 resync 并结束连接：%s",
		async (path) => {
			session.events = [{ seq: 0, type: "text_delta" }];
			session.nextSeq = 1;
			const stream = await connect(path);
			await once(stream.response, "end");
			expect(stream.text()).toContain('"type":"resync"');
			expect(stream.response.complete).toBe(true);
			expect(session.sseClients.size).toBe(0);
			expect(heartbeats.size).toBe(0);
		},
	);
});
