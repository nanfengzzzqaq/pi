import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createContext, runInContext, runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { isTrustedConsoleUrl } from "../src/http-security.ts";

const source = readFileSync(new URL("../installer/electron/main.js", import.meta.url), "utf8");
const tree = ts.createSourceFile("main.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const preloadSource = readFileSync(new URL("../installer/electron/preload.cjs", import.meta.url), "utf8");
const appUrl = "http://127.0.0.1:3200/";
const tokenInitialization = tree.statements.find(
	(node) => ts.isIfStatement(node) && node.expression.getText(tree).includes("process.env.PI_CONSOLE_TOKEN"),
);
if (!tokenInitialization) throw new Error("没有找到桌面连接令牌初始化");
const guards = ["isTrustedSender", "handleTrusted", "listenTrusted"].map((name) => {
	const node = tree.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
	if (!node) throw new Error(`没有找到桌面权限守卫 ${name}`);
	return node.getText(tree);
});
const registrations = tree.statements.filter(
	(node) =>
		ts.isExpressionStatement(node) &&
		ts.isCallExpression(node.expression) &&
		ts.isIdentifier(node.expression.expression) &&
		["handleTrusted", "listenTrusted"].includes(node.expression.expression.text),
);

function fixture(token) {
	const handlers = new Map();
	const listeners = new Map();
	const browser = Object.fromEntries(
		["open", "hide", "state", "navigate", "back", "forward", "reload", "toggleDevtools", "pickElement", "screenshot", "setBounds"].map(
			(name) => [name, vi.fn(() => (name === "state" ? { title: "fixture" } : undefined))],
		),
	);
	const app = { relaunch: vi.fn(), exit: vi.fn(), getPath: vi.fn(() => "fixture-pictures") };
	const dialog = {
		showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
		showSaveDialog: vi.fn(async () => ({ canceled: true })),
	};
	const shell = { openExternal: vi.fn(async () => undefined) };
	const window = {
		isDestroyed: vi.fn(() => false),
		webContents: { mainFrame: { url: appUrl }, startDrag: vi.fn() },
	};
	const context = createContext({
		win: window,
		agentBrowser: browser,
		APP_URL: appUrl,
		ELECTRON_DIRECTORY: "fixture-electron",
		process: { env: token === undefined ? {} : { PI_CONSOLE_TOKEN: token } },
		randomBytes,
		isTrustedConsoleUrl,
		ipcMain: {
			handle: (channel, handler) => handlers.set(channel, handler),
			on: (channel, handler) => listeners.set(channel, handler),
		},
		app,
		dialog,
		shell,
		resolve,
		join,
		existsSync: () => true,
		statSync: () => ({ isFile: () => true }),
		nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
	});
	runInContext(
		[tokenInitialization.getText(tree), ...guards, ...registrations.map((node) => node.getText(tree))]
			.join("\n")
			.replaceAll("import.meta.dirname", "ELECTRON_DIRECTORY"),
		context,
	);
	return {
		context,
		window,
		browser,
		app,
		shell,
		handlers,
		listeners,
		event: { sender: window.webContents, senderFrame: window.webContents.mainFrame },
		effects: [...Object.values(browser), ...Object.values(app), ...Object.values(dialog), shell.openExternal, window.webContents.startDrag],
	};
}

describe("Electron 桌面连接与权限边界", () => {
	it("为每次启动生成独立的随机连接令牌，同时保留显式配置", () => {
		const first = fixture();
		const second = fixture();
		const firstToken = first.handlers.get("pi:api-token")(first.event);
		const secondToken = second.handlers.get("pi:api-token")(second.event);
		expect(firstToken).toMatch(/^[0-9a-f]{64}$/);
		expect(secondToken).toMatch(/^[0-9a-f]{64}$/);
		expect(firstToken).not.toBe(secondToken);
		const configured = fixture("fixture-explicit-token");
		expect(configured.handlers.get("pi:api-token")(configured.event)).toBe("fixture-explicit-token");
	});

	it.each(["", " \t "])("空白配置不会禁用桌面连接令牌：%j", (token) => {
		const desktop = fixture(token);
		expect(desktop.handlers.get("pi:api-token")(desktop.event)).toMatch(/^[0-9a-f]{64}$/);
	});

	it("主界面的请求可取得令牌并调用原有浏览器与重启能力", () => {
		const desktop = fixture("fixture-token");
		expect(desktop.handlers.get("pi:api-token")(desktop.event)).toBe("fixture-token");
		desktop.handlers.get("pi:browser-navigate")(desktop.event, "https://example.test/");
		expect(desktop.browser.navigate).toHaveBeenCalledWith("https://example.test/");
		const bounds = { x: 0, y: 10, width: 500, height: 300 };
		desktop.listeners.get("pi:browser-bounds")(desktop.event, bounds);
		expect(desktop.browser.setBounds).toHaveBeenCalledWith(bounds);
		desktop.listeners.get("pi:relaunch")(desktop.event);
		expect(desktop.app.relaunch).toHaveBeenCalledOnce();
		expect(desktop.app.exit).toHaveBeenCalledWith(0);
	});

	it.each([
		["其他 WebContents", (desktop) => ({ ...desktop.event, sender: { mainFrame: desktop.event.senderFrame } })],
		["同源 iframe", (desktop) => ({ ...desktop.event, senderFrame: { url: appUrl } })],
		["缺失 frame", (desktop) => ({ ...desktop.event, senderFrame: null })],
		["主窗口被关闭", (desktop) => { desktop.context.win = null; return desktop.event; }],
		["主窗口已销毁", (desktop) => { desktop.window.isDestroyed.mockReturnValue(true); return desktop.event; }],
		["同源原始文件", (desktop) => { desktop.event.senderFrame.url = `${appUrl}api/fs/raw?path=fixture.html`; return desktop.event; }],
		["外部网站", (desktop) => { desktop.event.senderFrame.url = "https://example.test/"; return desktop.event; }],
		["空白文档", (desktop) => { desktop.event.senderFrame.url = "about:blank"; return desktop.event; }],
	])("%s 无法取得令牌或执行任何已注册桌面能力", (_name, makeEvent) => {
		const desktop = fixture("fixture-token");
		const event = makeEvent(desktop);
		for (const handler of desktop.handlers.values()) {
			expect(() => handler(event, "https://example.test/")).toThrow("请求不是来自 Pi 主界面");
		}
		for (const listener of desktop.listeners.values()) listener(event, "fixture.txt");
		for (const effect of desktop.effects) expect(effect).not.toHaveBeenCalled();
	});

	it("重新导航到原始文件后，同一 WebContents 不再继承先前授权", () => {
		const desktop = fixture("fixture-token");
		const getToken = desktop.handlers.get("pi:api-token");
		expect(getToken(desktop.event)).toBe("fixture-token");
		desktop.event.senderFrame.url = `${appUrl}api/fs/raw?path=fixture.svg`;
		expect(() => getToken(desktop.event)).toThrow("请求不是来自 Pi 主界面");
	});

	it("实际 preload 通过受保护 IPC 取得令牌，不能选择其他令牌来源", async () => {
		const desktop = fixture("fixture-token");
		let bridge;
		const invoke = vi.fn((channel, ...args) => Promise.resolve().then(() => desktop.handlers.get(channel)(desktop.event, ...args)));
		runInNewContext(preloadSource, {
			require: (name) => {
				if (name !== "electron") throw new Error(`测试不允许加载 ${name}`);
				return {
					contextBridge: { exposeInMainWorld: (name, exposed) => { expect(name).toBe("piDesktop"); bridge = exposed; } },
					ipcRenderer: { invoke },
					webUtils: {},
				};
			},
		});
		expect(await bridge.getApiToken("untrusted-channel")).toBe("fixture-token");
		expect(invoke).toHaveBeenCalledWith("pi:api-token");
		expect(Object.values(bridge).every((value) => typeof value === "function")).toBe(true);
		desktop.event.senderFrame = { url: appUrl };
		await expect(bridge.getApiToken()).rejects.toThrow("请求不是来自 Pi 主界面");
	});

	it("实际文件下载等待桌面令牌，401 后提示重启且不请求或保存手动令牌", async () => {
		const appSource = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
		const appTree = ts.createSourceFile("app.js", appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
		const functions = ["apiToken", "ensureApiAuth", "authHeaders", "downloadPathLink"].map((name) => {
			const node = appTree.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
			if (!node) throw new Error(`没有找到真实前端函数 ${name}`);
			return node.getText(appTree);
		});
		const desktop = fixture("fixture-download-token");
		let finishBootstrap;
		const bootstrap = new Promise((resolve) => { finishBootstrap = resolve; });
		const getApiToken = vi.fn(() => bootstrap);
		const prompt = vi.fn();
		const setItem = vi.fn();
		const fetch = vi.fn(async () => ({ status: 401, ok: false }));
		const showError = vi.fn();
		const context = createContext({
			sessionId: "fixture-session",
			TOKEN_KEY: "fixture-token-key",
			desktopApiToken: null,
			desktopAuthRequest: null,
			window: { piDesktop: { getApiToken }, prompt },
			localStorage: { getItem: () => "stale-browser-token", setItem },
			URLSearchParams,
			fetch,
			showError,
		});
		runInContext(functions.join("\n"), context);
		const downloading = context.downloadPathLink("uploads/fixture.txt", "fixture.txt");
		expect(getApiToken).toHaveBeenCalledOnce();
		expect(fetch).not.toHaveBeenCalled();
		finishBootstrap(desktop.handlers.get("pi:api-token")(desktop.event));
		await downloading;
		expect(fetch).toHaveBeenCalledOnce();
		expect(fetch).toHaveBeenCalledWith(
			"/api/fs/download?path=uploads%2Ffixture.txt&sessionId=fixture-session",
			{ headers: { Authorization: "Bearer fixture-download-token" } },
		);
		expect(showError).toHaveBeenCalledWith("下载文件失败：连接授权已失效，请重新启动 Pi");
		expect(prompt).not.toHaveBeenCalled();
		expect(setItem).not.toHaveBeenCalled();
	});

	it("所有实际桌面消息注册都经过同一权限守卫", () => {
		const desktop = fixture();
		expect(desktop.handlers.has("pi:api-token")).toBe(true);
		expect(desktop.handlers.has("pi:choose-directory")).toBe(true);
		expect(desktop.handlers.has("pi:open-external")).toBe(true);
		expect(desktop.listeners.has("pi:file-drag-start")).toBe(true);
		expect(desktop.listeners.has("pi:relaunch")).toBe(true);
		const directRegistrations = [];
		function inspect(node) {
			if (
				ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
				node.expression.expression.getText(tree) === "ipcMain" &&
				["handle", "on"].includes(node.expression.name.text)
			) directRegistrations.push(node);
			ts.forEachChild(node, inspect);
		}
		inspect(tree);
		expect(directRegistrations).toHaveLength(2);
		for (const registration of directRegistrations) expect(registration.arguments[0].getText(tree)).toBe("channel");
	});
});
