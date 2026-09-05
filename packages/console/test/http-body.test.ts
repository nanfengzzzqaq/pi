import { once } from "node:events";
import { createServer, request, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpBodyError, readBodyJson } from "../src/http-body.ts";

const MIB = 1024 * 1024;
let server: Server;
let origin: string;

beforeEach(async () => {
	server = createServer((req, res) => {
		const maxBytes = req.url === "/upload" ? Math.ceil((50 * MIB) / 3) * 4 + 65536 : undefined;
		void readBodyJson(req, maxBytes).then(
			(value) => {
				const body = value as Record<string, unknown>;
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						keys: Object.keys(body),
						textLength: typeof body.text === "string" ? body.text.length : 0,
						textStart: typeof body.text === "string" ? body.text.slice(0, 10) : "",
						dataLength: typeof body.dataBase64 === "string" ? Buffer.from(body.dataBase64, "base64").length : 0,
					}),
				);
			},
			(error: unknown) => {
				const status = error instanceof HttpBodyError ? error.status : 500;
				if (status === 413) res.setHeader("Connection", "close");
				res.writeHead(status, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
			},
		);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("测试 HTTP 服务没有绑定端口");
	origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

interface HttpResult {
	status: number | undefined;
	complete: boolean;
	body: Record<string, unknown>;
}

function post(chunks: string | Buffer[], path = "/"): Promise<HttpResult> {
	return new Promise((resolve, reject) => {
		const req = request(`${origin}${path}`, { method: "POST", headers: { "Content-Type": "application/json" } });
		req.on("error", reject);
		req.on("response", (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => {
				text += chunk;
			});
			res.on("error", reject);
			res.on("end", () => resolve({ status: res.statusCode, complete: res.complete, body: JSON.parse(text) }));
		});
		if (typeof chunks === "string") req.end(chunks);
		else {
			for (const chunk of chunks) req.write(chunk);
			req.end();
		}
	});
}

describe("HTTP JSON 请求体", () => {
	it("接受 JSON 对象，并在分块边界保留多字节中文", async () => {
		const encoded = Buffer.from(JSON.stringify({ text: "中文输入" }));
		const result = await post([encoded.subarray(0, 10), encoded.subarray(10, 11), encoded.subarray(11)]);
		expect(result).toMatchObject({ status: 200, complete: true, body: { textLength: 4, textStart: "中文输入" } });
	});

	it.each(["", "{", '{"text":}', '{"text":"ok"} trailing'])("畸形 JSON 返回可读的 400 响应：%j", async (body) => {
		expect(await post(body)).toMatchObject({ status: 400, complete: true, body: { error: "请求体不是合法的 JSON" } });
	});

	it.each(["null", "[]", '"string"', "42", "false"])("JSON 非对象值返回 400：%s", async (body) => {
		expect(await post(body)).toMatchObject({
			status: 400,
			complete: true,
			body: { error: "请求体必须是 JSON 对象" },
		});
	});

	it("默认允许恰好 1MiB，超出一字节返回完整 413 而不重置 socket", async () => {
		const overhead = Buffer.byteLength(JSON.stringify({ text: "" }));
		const allowed = JSON.stringify({ text: "x".repeat(MIB - overhead) });
		expect(Buffer.byteLength(allowed)).toBe(MIB);
		expect(await post(allowed)).toMatchObject({ status: 200, complete: true });
		expect(await post(JSON.stringify({ text: "x".repeat(MIB - overhead + 1) }))).toMatchObject({
			status: 413,
			complete: true,
			body: { error: "请求体过大" },
		});
		expect(await post('{"text":"next request"}')).toMatchObject({ status: 200, complete: true });
	});

	it("按原始字节而不是字符数实施上限", async () => {
		const text = "中".repeat(Math.floor(MIB / 3));
		expect(text.length).toBeLessThan(MIB);
		expect(await post(JSON.stringify({ text }))).toMatchObject({ status: 413, complete: true });
	});

	it("超限后继续接收分块数据，客户端仍能取得完整错误", async () => {
		const chunks = [
			Buffer.from('{"text":"'),
			...Array.from({ length: 18 }, () => Buffer.alloc(65536, "x")),
			Buffer.from('"}'),
		];
		expect(await post(chunks)).toMatchObject({ status: 413, complete: true, body: { error: "请求体过大" } });
	});

	it("上传接口允许 20MiB 图片的完整 Base64 JSON", async () => {
		const body = JSON.stringify({ name: "图片.png", dataBase64: Buffer.alloc(20 * MIB).toString("base64") });
		expect(await post(body, "/upload")).toMatchObject({
			status: 200,
			complete: true,
			body: { dataLength: 20 * MIB },
		});
	});
});
