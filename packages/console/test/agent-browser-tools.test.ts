import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type AgentBrowserRuntime,
	redactSensitiveText,
	registerAgentBrowserRuntime,
	vaultSensitiveUrlsInText,
} from "../src/agent-browser-runtime.ts";
import { classifyBrowserClick } from "../src/agent-browser-safety.ts";
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
		type: async (target, value, pressEnter, commit) => `type:${target.ref}:${value}:${pressEnter}:${commit}`,
		scroll: async (direction, amount) => `scroll:${direction}:${amount}`,
		extract: async (selector, maxChars) => `extract:${selector}:${maxChars}`,
		screenshot: async (path) => `screenshot:${path}`,
		wait: async (milliseconds, text) => `wait:${milliseconds}:${text}`,
		uploadFiles: async (files, target) => {
			calls.push(`upload:${files.map((file) => file.name).join("+")}:${target?.selector ?? target?.ref ?? "auto"}`);
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

	it("浏览器工具输出会脱敏 URL 中的登录令牌，但导航仍收到原始 URL", async () => {
		const calls: string[] = [];
		registerAgentBrowserRuntime(fakeBrowser(calls));
		const navigate = instantiateAgentBrowserTools(tmpdir()).find((item) => item.name === "browser_navigate");
		const raw = "https://app.ekuaibao.com/web/app.html?accessToken=secret-value&provisionalToken=second-secret#/bill";
		const output = await navigate?.execute("call-token", { url: raw }, undefined, undefined, undefined as never);
		const text = output?.content[0]?.type === "text" ? output.content[0].text : "";
		expect(calls).toContain(`navigate:${raw}`);
		expect(text).not.toContain("secret-value");
		expect(text).not.toContain("second-secret");
		expect(text).toContain("[REDACTED]");
	});

	it("用户消息和工具参数只保存内存引用，导航时还原 query 与 hash 中的原始凭据", async () => {
		const calls: string[] = [];
		registerAgentBrowserRuntime(fakeBrowser(calls));
		const navigate = instantiateAgentBrowserTools(tmpdir()).find((item) => item.name === "browser_navigate");
		const raw = "https://app.ekuaibao.com/web/app.html?accessToken=query-secret#/bill?provisionalToken=hash-secret";
		const persistedUrl = vaultSensitiveUrlsInText(raw);
		expect(persistedUrl).not.toContain("query-secret");
		expect(persistedUrl).not.toContain("hash-secret");
		expect(JSON.stringify({ url: persistedUrl })).not.toContain("query-secret");
		expect(JSON.stringify({ url: persistedUrl })).not.toContain("hash-secret");

		const output = await navigate?.execute(
			"call-vaulted-token",
			{ url: persistedUrl },
			undefined,
			undefined,
			undefined as never,
		);
		expect(calls).toContain(`navigate:${raw}`);
		const text = output?.content[0]?.type === "text" ? output.content[0].text : "";
		expect(text).not.toContain("query-secret");
		expect(text).not.toContain("hash-secret");
	});

	it("hash 路由内的敏感查询参数会在所有展示文本中脱敏", () => {
		const raw = "打开 https://example.com/#/bill?accessToken=hash-only-secret&name=visible";
		const redacted = redactSensitiveText(raw);
		expect(redacted).not.toContain("hash-only-secret");
		expect(redacted).toContain("accessToken=[REDACTED]");
		expect(redacted).toContain("name=visible");
	});

	it("Markdown 链接文字和目标中的凭据都会在持久化前移除", () => {
		const rawUrl = "https://example.com/app?accessToken=markdown-secret#/bill";
		const persisted = vaultSensitiveUrlsInText(`[审批链接](${rawUrl})，备用地址：[${rawUrl}](${rawUrl})`);
		expect(persisted).not.toContain("markdown-secret");
		expect(persisted).toContain("](https://example.com/app?accessToken=pi-browser-secret-");
	});

	it("browser_upload 读取本地文件并传给运行时", async () => {
		const calls: string[] = [];
		registerAgentBrowserRuntime(fakeBrowser(calls));
		const cwd = mkdtempSync(join(tmpdir(), "pi-browser-upload-"));
		writeFileSync(join(cwd, "ticket.png"), "fake-png-bytes");
		const upload = instantiateAgentBrowserTools(cwd).find((tool) => tool.name === "browser_upload");
		const output = await upload?.execute(
			"call-3",
			{ paths: ["ticket.png"], selector: '[data-testid="outbound-ticket-upload"]' },
			undefined,
			undefined,
			undefined as never,
		);
		expect(calls).toEqual([`download:${cwd}`, 'upload:ticket.png:[data-testid="outbound-ticket-upload"]']);
		expect(output?.content[0]).toMatchObject({ type: "text", text: "已选择 1 个文件" });
	});

	it("易快报点击策略先阻止所有提交和删除信号，仅精确放行草稿", () => {
		const decide = (label: string, attributeSignal = "", inputType = "button") =>
			classifyBrowserClick({
				hostname: "app.ekuaibao.com",
				label,
				attributeSignal,
				tagName: "BUTTON",
				inputType,
			});
		for (const label of ["提交", "提交报销单", "送审", "确定并提交", "删除单据", "作废单据", "撤销申请"]) {
			expect(decide(label)).toMatchObject({ allowed: false, kind: "blocked" });
		}
		expect(decide("存为草稿", "flexable-button-submit 草稿")).toMatchObject({ allowed: false });
		expect(decide("存为草稿", "flexable-button-edit", "submit")).toMatchObject({ allowed: false });
		expect(decide("存为草稿", "flexable-button-edit")).toEqual({ allowed: true, kind: "draft" });
		for (const label of [
			"提交人：苏爱健",
			"选择提交人：苏爱健",
			"关联申请 提交人：苏爱健 常州业务拓展",
			"本单据由提交人苏爱健创建",
		]) {
			expect(decide(label)).toEqual({ allowed: true, kind: "neutral" });
		}
		expect(decide("删除单据（提交人：苏爱健）")).toMatchObject({ allowed: false, kind: "blocked" });
		expect(classifyBrowserClick({ hostname: "example.com", label: "提交", attributeSignal: "submit" })).toEqual({
			allowed: true,
			kind: "external",
		});
	});

	it("Electron 控制器禁止猜测多个上传框且不调用 form.requestSubmit", () => {
		const controller = readFileSync(
			join(import.meta.dirname, "..", "installer", "electron", "browser-controller.js"),
			"utf8",
		);
		expect(controller).toContain("只允许保存草稿");
		expect(controller).toContain("页面有 ' + inputs.length + ' 个上传入口");
		expect(controller).toContain("Boolean(clickable.form)");
		expect(controller).toContain("clickable.type || ''");
		expect(controller).not.toContain("clickable.getAttribute('type') || ''");
		expect(controller).not.toContain("requestSubmit");
	});

	it("聊天界面发送前只显示敏感链接的脱敏副本", () => {
		const source = readFileSync(join(import.meta.dirname, "..", "web", "app.js"), "utf8");
		const packaged = readFileSync(join(import.meta.dirname, "..", "installer", "electron", "web", "app.js"), "utf8");
		expect(source).toBe(packaged);
		expect(source).toContain("function redactSensitiveDisplayText(value)");
		expect(source).toContain("redactSensitiveDisplayText(text ||");
		expect(source).toContain("attachmentsToSend.length");
		expect(source).toContain("redactSensitiveDisplayText(\n\t\t\t\t\titem.text");
	});

	it("browser_upload 拒绝不存在的文件", async () => {
		registerAgentBrowserRuntime(fakeBrowser([]));
		const upload = instantiateAgentBrowserTools(tmpdir()).find((tool) => tool.name === "browser_upload");
		await expect(
			upload?.execute("call-4", { paths: ["不存在的文件.png"] }, undefined, undefined, undefined as never),
		).rejects.toThrow();
	});
});
