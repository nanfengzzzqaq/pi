import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type AgentBrowserRuntime, registerAgentBrowserRuntime } from "../src/agent-browser-runtime.ts";
import { instantiateAgentBrowserTools } from "../src/agent-browser-tools.ts";

function fakeBrowser(calls: string[]): AgentBrowserRuntime {
	const state = {
		open: true,
		url: "https://example.com",
		title: "Example",
		loading: false,
		canGoBack: false,
		canGoForward: false,
		status: "网页已加载",
	};
	return {
		setDownloadDirectory: (path) => calls.push(`download:${path}`),
		open: async () => state,
		hide: () => ({ ...state, open: false }),
		state: () => state,
		navigate: async (url) => {
			calls.push(`navigate:${url}`);
			return { ...state, url };
		},
		back: () => state,
		forward: () => state,
		reload: () => state,
		snapshot: async (maxChars) => `snapshot:${maxChars}`,
		click: async (target) => `click:${target.ref}`,
		type: async (target, value, submit) => `type:${target.ref}:${value}:${submit}`,
		scroll: async (direction, amount) => `scroll:${direction}:${amount}`,
		extract: async (selector, maxChars) => `extract:${selector}:${maxChars}`,
		screenshot: async (path) => `screenshot:${path}`,
		wait: async (milliseconds, text) => `wait:${milliseconds}:${text}`,
		upload: async (files) => {
			calls.push(`upload:${files.map((file) => file.name).join("+")}`);
			return `已选择 ${files.length} 个文件`;
		},
	};
}

describe("客户端浏览器工具", () => {
	it("注册九个中文标注工具并把下载限制到会话工作区", async () => {
		const calls: string[] = [];
		registerAgentBrowserRuntime(fakeBrowser(calls));
		const cwd = mkdtempSync(join(tmpdir(), "pi-browser-tools-"));
		const tools = instantiateAgentBrowserTools(cwd);
		expect(tools).toHaveLength(9);
		expect(tools.map((tool) => `${tool.label}（${tool.name}）`)).toContain("打开网页（browser_navigate）");
		expect(tools.map((tool) => tool.name)).toContain("browser_upload");
		const navigate = tools.find((tool) => tool.name === "browser_navigate");
		const output = await navigate?.execute(
			"call-1",
			{ url: "https://example.com/docs" },
			undefined,
			undefined,
			undefined as never,
		);
		expect(calls).toEqual([`download:${cwd}`, "navigate:https://example.com/docs"]);
		expect(output?.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("https://example.com/docs"),
		});
	});

	it("页面快照默认限制为 6000 字符", async () => {
		registerAgentBrowserRuntime(fakeBrowser([]));
		const snapshot = instantiateAgentBrowserTools(tmpdir()).find((tool) => tool.name === "browser_snapshot");
		const output = await snapshot?.execute("call-2", {}, undefined, undefined, undefined as never);
		expect(output?.content[0]).toMatchObject({ type: "text", text: "snapshot:6000" });
	});

	it("browser_upload 读取本地文件并传给运行时", async () => {
		const calls: string[] = [];
		registerAgentBrowserRuntime(fakeBrowser(calls));
		const cwd = mkdtempSync(join(tmpdir(), "pi-browser-upload-"));
		writeFileSync(join(cwd, "ticket.png"), "fake-png-bytes");
		const upload = instantiateAgentBrowserTools(cwd).find((tool) => tool.name === "browser_upload");
		const output = await upload?.execute(
			"call-3",
			{ paths: ["ticket.png"] },
			undefined,
			undefined,
			undefined as never,
		);
		expect(calls).toEqual([`download:${cwd}`, "upload:ticket.png"]);
		expect(output?.content[0]).toMatchObject({ type: "text", text: "已选择 1 个文件" });
	});

	it("browser_upload 拒绝不存在的文件", async () => {
		registerAgentBrowserRuntime(fakeBrowser([]));
		const upload = instantiateAgentBrowserTools(tmpdir()).find((tool) => tool.name === "browser_upload");
		await expect(
			upload?.execute("call-4", { paths: ["不存在的文件.png"] }, undefined, undefined, undefined as never),
		).rejects.toThrow();
	});
});
