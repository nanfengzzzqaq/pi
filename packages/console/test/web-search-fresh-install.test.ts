/**
 * fresh install 集成测试：用子进程启动真实 Console 服务，验证联网检索的
 * 完整启用链路——加载能力包 → 保存 Key → 启用 → 当前会话与持久化会话均获得
 * web_search → 停用后同步移除。全部走 HTTP 接口，不 mock 内部函数。
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const TSX_CLI = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SERVER_ENTRY = join(REPO_ROOT, "packages", "console", "src", "server.ts");
const CONSOLE_DIR = join(REPO_ROOT, "packages", "console");

const children: ChildProcess[] = [];
let dataDir: string;

afterAll(async () => {
	await Promise.all(children.map((child) => stopServer(child)));
	children.length = 0;
	if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const listener = createServer();
		listener.listen(0, "127.0.0.1", () => {
			const port = (listener.address() as AddressInfo).port;
			listener.close(() => resolve(port));
		});
		listener.on("error", reject);
	});
}

async function startServer(port: number): Promise<void> {
	const child = spawn(process.execPath, [TSX_CLI, SERVER_ENTRY], {
		cwd: CONSOLE_DIR,
		env: {
			...process.env,
			PORT: String(port),
			PI_CONSOLE_DATA: dataDir,
			// 独立于开发机环境：确保“未配置 Key”与挂载状态只由本测试驱动。
			BRAVE_SEARCH_API_KEY: "",
			PI_CONSOLE_TOKEN: "",
			PI_CONSOLE_MODEL: "",
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	children.push(child);
	const stderr: string[] = [];
	child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
	const deadline = Date.now() + 90_000;
	for (;;) {
		if (child.exitCode !== null) {
			throw new Error(`console server exited early:\n${stderr.join("")}`);
		}
		if (Date.now() > deadline) {
			await stopServer(child);
			throw new Error("console server did not become ready in time");
		}
		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/packs`);
			if (response.ok) return;
		} catch {
			/* 启动中，继续等待 */
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

function stopServer(child: ChildProcess): Promise<void> {
	return new Promise((resolve) => {
		if (child.exitCode !== null) {
			resolve();
			return;
		}
		const finish = () => resolve();
		child.once("exit", finish);
		child.kill();
		setTimeout(() => {
			if (child.exitCode === null) child.kill("SIGKILL");
			resolve();
		}, 5_000);
	});
}

async function api<T>(port: number, path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(`http://127.0.0.1:${port}${path}`, {
		...init,
		headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
	});
	const body = (await response.json().catch(() => ({}))) as T & { error?: string };
	if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}: ${body.error ?? ""}`);
	return body;
}

async function postMessageWhenIdle(port: number, sessionId: string, text: string): Promise<void> {
	const deadline = Date.now() + 15_000;
	for (;;) {
		const response = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text }),
		});
		if (response.status === 409 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			continue;
		}
		const body = (await response.json().catch(() => ({}))) as { error?: string };
		if (!response.ok) throw new Error(`messages -> HTTP ${response.status}: ${body.error ?? ""}`);
		return;
	}
}

/** 只订阅未来事件，返回本次消息而非历史回放的 capability_selection。 */
async function messageToolNames(port: number, sessionId: string, text: string): Promise<string[]> {
	const controller = new AbortController();
	const response = await fetch(
		`http://127.0.0.1:${port}/api/sessions/${sessionId}/stream?since=${Number.MAX_SAFE_INTEGER}`,
		{ signal: controller.signal },
	);
	const reader = response.body?.getReader();
	if (!reader) throw new Error("SSE stream has no body");
	const decoder = new TextDecoder();
	let buffer = "";
	const watchdog = setTimeout(() => controller.abort(), 15_000);
	const nextCapability = (async () => {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) throw new Error("SSE stream ended before capability_selection");
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.startsWith("data: ")) continue;
				const event = JSON.parse(line.slice(6)) as {
					seq?: number;
					type?: string;
					tools?: Array<{ name: string }>;
				};
				if (event.type === "capability_selection" && Array.isArray(event.tools)) {
					return event.tools.map((tool) => tool.name);
				}
			}
		}
	})();
	try {
		await postMessageWhenIdle(port, sessionId, text);
		return await nextCapability;
	} finally {
		clearTimeout(watchdog);
		controller.abort();
	}
}

describe("联网检索 fresh install 启用链路", () => {
	it("从全新数据目录完成：保存 Key → 启用 → 会话同步 → 重启持久化 → 停用", async () => {
		dataDir = mkdtempSync(join(tmpdir(), "pi-console-fresh-install-"));
		let port = await freePort();
		await startServer(port);

		// 1. 全新安装：能力包已扫描，未挂载；目录里显示 web-search。
		const packsBefore = await api<Array<{ name: string; mounted: boolean; tools: Array<{ name: string }> }>>(
			port,
			"/api/packs",
		);
		const webSearchPack = packsBefore.find((pack) => pack.name === "web-search");
		expect(webSearchPack).toMatchObject({ name: "web-search", mounted: false });
		expect(webSearchPack?.tools.map((tool) => tool.name)).toEqual(["web_search"]);
		const catalogBefore = await api<{ tools: Array<{ id: string; installed: boolean; keyConfigured: boolean }> }>(
			port,
			"/api/catalog",
		);
		const catalogEntry = catalogBefore.tools.find((tool) => tool.id === "web-search");
		expect(catalogEntry).toMatchObject({ installed: false, keyConfigured: false });

		// 2. 首次保存 Key（fresh install，之前从未保存过）。
		const integrationKey = ["BSTA", "integration", "test", "key"].join("-");
		await api(port, "/api/keys", {
			method: "POST",
			body: JSON.stringify({ provider: "brave-web-search", key: integrationKey }),
		});
		const keys = await api<Array<{ provider: string; displayName: string; masked: string; source: string }>>(
			port,
			"/api/keys",
		);
		const braveKey = keys.find((entry) => entry.provider === "brave-web-search");
		expect(braveKey).toMatchObject({ displayName: "Brave 联网检索", masked: "****", source: "file" });
		expect(JSON.stringify(keys)).not.toContain("BSTA");
		expect(JSON.stringify(keys)).not.toContain("-key");

		// 3. 启用前创建会话：此时没有 web_search。
		const { sessionId } = await api<{ sessionId: string }>(port, "/api/sessions", { method: "POST", body: "{}" });
		expect(await messageToolNames(port, sessionId, "帮我联网搜索今天的新闻")).not.toContain("web_search");
		const unknownMount = await fetch(`http://127.0.0.1:${port}/api/packs/not-a-real-pack/mount`, { method: "POST" });
		expect(unknownMount.status).toBe(404);
		const indexAfterUnknownMount = JSON.parse(readFileSync(join(dataDir, "sessions-index.json"), "utf8")) as Record<
			string,
			{ enabledPacks?: string[] }
		>;
		expect(indexAfterUnknownMount[sessionId]?.enabledPacks).not.toContain("not-a-real-pack");

		// 4. 启用：mount 接口立即同步当前内存会话，不要求重启或新建会话。
		await api(port, "/api/packs/web-search/mount", { method: "POST" });
		expect(await messageToolNames(port, sessionId, "再搜一次最新版本")).toContain("web_search");
		const catalogAfter = await api<{ tools: Array<{ id: string; installed: boolean; keyConfigured: boolean }> }>(
			port,
			"/api/catalog",
		);
		expect(catalogAfter.tools.find((tool) => tool.id === "web-search")).toMatchObject({
			installed: true,
			keyConfigured: true,
		});

		// 5. 持久化：挂载状态与会话索引落盘。
		const mountedPacksFile = JSON.parse(readFileSync(join(dataDir, "mounted-packs.json"), "utf8")) as string[];
		expect(mountedPacksFile).toContain("web-search");
		const sessionIndex = JSON.parse(readFileSync(join(dataDir, "sessions-index.json"), "utf8")) as Record<
			string,
			{ enabledPacks?: string[] }
		>;
		expect(sessionIndex[sessionId]?.enabledPacks).toContain("web-search");

		// 6. 重启（同一数据目录）：持久化会话恢复后仍有 web_search。
		await stopServer(children[0]!);
		port = await freePort();
		await startServer(port);
		const packsAfterRestart = await api<Array<{ name: string; mounted: boolean }>>(port, "/api/packs");
		expect(packsAfterRestart.find((pack) => pack.name === "web-search")?.mounted).toBe(true);
		expect(await messageToolNames(port, sessionId, "重启后再搜索一次")).toContain("web_search");

		// 7. 停用：立即从当前会话移除；挂载状态清除。
		await api(port, "/api/packs/web-search/unmount", { method: "POST" });
		expect(await messageToolNames(port, sessionId, "最后再搜一次")).not.toContain("web_search");
		const mountedAfterUnmount = JSON.parse(readFileSync(join(dataDir, "mounted-packs.json"), "utf8")) as string[];
		expect(mountedAfterUnmount).not.toContain("web-search");
		const catalogUnmounted = await api<{ tools: Array<{ id: string; installed: boolean }> }>(port, "/api/catalog");
		expect(catalogUnmounted.tools.find((tool) => tool.id === "web-search")?.installed).toBe(false);
		// 停用不删除已保存的 Key。
		const keysAfter = await api<Array<{ provider: string }>>(port, "/api/keys");
		expect(keysAfter.some((entry) => entry.provider === "brave-web-search")).toBe(true);
	}, 240_000);
});
