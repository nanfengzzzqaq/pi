/**
 * Pi 控制台 Electron 主进程。
 *
 * 直接加载现有 TypeScript 后端（Node ≥22.18 原生 type-stripping），
 * 数据目录与旧版一致（%APPDATA%\pi-console\data），所有数据无缝继承。
 */
import { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage, shell } from "electron";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createServer as createProbeServer } from "node:net";
import { AgentBrowserController } from "./browser-controller.js";
import { registerAgentBrowserRuntime } from "./src/agent-browser-runtime.ts";
import { handOffToDetachedInstaller, registerDesktopUpdateInstaller } from "./src/desktop-update-runtime.ts";
import { isTrustedConsoleUrl } from "./src/http-security.ts";

// 数据位置指针固定留在 AppData；实际数据目录可由用户在设置中整体迁移到其他磁盘。
const storageConfigPath = join(app.getPath("appData"), "pi-console", "storage-location.json");
const defaultDataPath = join(app.getPath("appData"), "pi-console", "data");

function configuredDataPath() {
	try {
		const config = JSON.parse(readFileSync(storageConfigPath, "utf8"));
		if (typeof config?.dataDir === "string" && config.dataDir.trim()) return resolve(config.dataDir);
	} catch {
		/* 首次启动或配置损坏时回到兼容旧版的默认目录。 */
	}
	return defaultDataPath;
}

process.env.PI_CONSOLE_STORAGE_CONFIG = storageConfigPath;
process.env.PI_CONSOLE_DATA = process.env.PI_CONSOLE_DATA ?? configuredDataPath();
process.env.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(process.env.PI_CONSOLE_DATA, "agent");
process.env.PORT = process.env.PORT ?? "3200";
if (!process.env.PI_CONSOLE_TOKEN?.trim()) process.env.PI_CONSOLE_TOKEN = randomBytes(32).toString("hex");

/**
 * 直接把已校验的安装包交给 electron-builder 的 NSIS 更新流程。
 * 不再派生 PowerShell/VBS 辅助脚本，避免脚本被执行策略或安全软件静默终止。
 */
registerDesktopUpdateInstaller(async ({ setupPath, args, targetVersion }) => {
	if (win && !win.isDestroyed() && isTrustedConsoleUrl(win.webContents.getURL(), APP_URL)) {
		const unsaved = await win.webContents.executeJavaScript("Boolean(codeEditorDirty || codeEditorFile?.saving)");
		if (unsaved) throw new Error("文件有未保存修改，请保存后在设置中重新安装更新");
	}
	const updateRoot = resolve(process.env.PI_CONSOLE_DATA, "update");
	const setup = resolve(setupPath);
	const prefix = updateRoot.endsWith(sep) ? updateRoot : updateRoot + sep;
	if (!setup.toLocaleLowerCase("en-US").startsWith(prefix.toLocaleLowerCase("en-US"))) {
		throw new Error("更新安装包不在客户端更新目录内");
	}
	if (!existsSync(setup) || !statSync(setup).isFile() || !setup.toLocaleLowerCase("en-US").endsWith(".exe")) {
		throw new Error("更新安装包不存在或格式不正确");
	}

	await handOffToDetachedInstaller(
		{ setupPath: setup, args, targetVersion },
		{
			onHandedOff: () => {
				console.log(`更新安装器：已交接 v${targetVersion}，客户端将退出并由 NSIS 重启`);
				setTimeout(() => {
					// 优雅退出先释放窗口、后端端口和文件句柄；极端情况下 5 秒后强制退出。
					setTimeout(() => app.exit(0), 5_000);
					app.quit();
				}, 350);
			},
		},
	);
});

const APP_PORT = Number(process.env.PORT);
const APP_URL = `http://127.0.0.1:${APP_PORT}/`;

let win = null;
let agentBrowser = null;

function isTrustedSender(event) {
	return Boolean(win && !win.isDestroyed() && event.sender === win.webContents &&
		event.senderFrame === win.webContents.mainFrame && isTrustedConsoleUrl(event.senderFrame.url, APP_URL));
}

function handleTrusted(channel, handler) {
	ipcMain.handle(channel, (event, ...args) => {
		if (!isTrustedSender(event)) throw new Error("请求不是来自 Pi 主界面");
		return handler(event, ...args);
	});
}

function listenTrusted(channel, handler) {
	ipcMain.on(channel, (event, ...args) => {
		if (isTrustedSender(event)) handler(event, ...args);
	});
}

/** 检测端口是否被占用（旧版服务仍在跑） */
function portInUse(port) {
	return new Promise((resolve) => {
		const server = createProbeServer();
		server.once("error", () => resolve(true));
		server.once("listening", () => server.close(() => resolve(false)));
		server.listen(port, "127.0.0.1");
	});
}

// 单实例：双击第二次聚焦已有窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
	app.quit();
} else {
	app.on("second-instance", () => {
		if (win) {
			if (win.isMinimized()) win.restore();
			win.focus();
		}
	});
}

/**
 * 升级衔接：把旧版（vbs + Edge 模式）安装目录的 launcher.vbs 改写为
 * "Electron 优先"版本——旧版点击更新后，重启逻辑会直接拉起 Electron。
 * 幂等：已改写则跳过。
 */
function upgradeLegacyLauncher() {
	try {
		const out = execFileSync(
			"reg",
			["query", "HKCU\\Software\\pi-console", "/v", "InstallDir"],
			{ encoding: "utf8", windowsHide: true },
		);
		const match = out.match(/InstallDir\s+REG_SZ\s+(.+)/);
		if (!match) return;
		const legacyDir = match[1].trim();
		const launcher = join(legacyDir, "launcher.vbs");
		if (!existsSync(launcher)) return;
		if (readFileSync(launcher, "utf8").includes("PiConsole.exe")) return; // 已升级

		// 升级模板随包分发（resources/app.asar.unpacked/extra/）
		const template = join(app.getAppPath(), "..", "app.asar.unpacked", "extra", "launcher-upgrade.vbs");
		if (existsSync(template)) {
			copyFileSync(template, launcher);
			console.log(`旧版启动器已升级为 Electron 优先：${launcher}`);
		}
	} catch {
		/* 无旧版安装或读取失败，忽略 */
	}
}

/**
 * 全局右键菜单：聊天正文、工具输出、终端、地址栏等任何地方都能复制粘贴，
 * 与主流桌面应用保持一致。Electron 默认不提供菜单，必须显式注册。
 */
function registerContextMenu(targetWindow) {
	targetWindow.webContents.on("context-menu", (_event, params) => {
		const editable = Boolean(params.editFlags?.canEdit);
		const hasSelection = Boolean(params.editFlags?.canCopy);
		const template = [];
		if (hasSelection) template.push({ role: "copy", label: "复制" });
		if (editable) {
			if (hasSelection) template.push({ role: "cut", label: "剪切" });
			template.push({ role: "paste", label: "粘贴" });
		}
		if (hasSelection || editable) template.push({ type: "separator" });
		template.push({ role: "selectAll", label: "全选" });
		Menu.buildFromTemplate(template).popup({ window: targetWindow });
	});
}

function createWindow() {
	win = new BrowserWindow({
		width: 1280,
		height: 860,
		show: process.env.PI_CONSOLE_HEADLESS !== "1",
		minWidth: 960,
		minHeight: 600,
		title: "Pi 控制台",
		icon: join(import.meta.dirname, "icon.png"),
		autoHideMenuBar: true,
		backgroundColor: "#0b1220",
		webPreferences: {
			preload: join(import.meta.dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	registerContextMenu(win);
	win.webContents.on("will-prevent-unload", (event) => {
		const choice = dialog.showMessageBoxSync(win, {
			type: "warning", buttons: ["继续编辑", "关闭并放弃修改"], defaultId: 0, cancelId: 0,
			message: "文件还有未保存的修改", detail: "关闭客户端会丢失这些文件修改。未发送的文字草稿已保留。",
		});
		if (choice === 1) event.preventDefault();
	});
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
		return { action: "deny" };
	});
	win.webContents.on("will-navigate", (event, url) => {
		if (isTrustedConsoleUrl(url, APP_URL)) return;
		event.preventDefault();
		if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
	});
	win.loadURL(APP_URL);
	win.on("closed", () => {
		win = null;
	});
}

listenTrusted("pi:file-drag-start", (event, path) => {
	try {
		const file = resolve(String(path));
		if (!existsSync(file) || !statSync(file).isFile()) return;
		const icon = nativeImage.createFromPath(join(import.meta.dirname, "icon.png")).resize({ width: 32, height: 32 });
		event.sender.startDrag({ file, files: [file], icon });
	} catch {
		/* 文件在拖动开始前被移动时忽略。 */
	}
});

handleTrusted("pi:api-token", () => process.env.PI_CONSOLE_TOKEN);
handleTrusted("pi:browser-open", (_event, url) => {
	if (typeof url === "string" && url) agentBrowser?.takeUserControl();
	return agentBrowser?.open(typeof url === "string" ? url : undefined);
});
handleTrusted("pi:browser-hide", () => agentBrowser?.hide());
handleTrusted("pi:browser-state", () => agentBrowser?.state());
handleTrusted("pi:browser-navigate", (_event, url) => { agentBrowser?.takeUserControl(); return agentBrowser?.navigate(String(url ?? "")); });
handleTrusted("pi:browser-back", () => { agentBrowser?.takeUserControl(); return agentBrowser?.back(); });
handleTrusted("pi:browser-forward", () => { agentBrowser?.takeUserControl(); return agentBrowser?.forward(); });
handleTrusted("pi:browser-reload", () => { agentBrowser?.takeUserControl(); return agentBrowser?.reload(); });
handleTrusted("pi:browser-devtools", () => agentBrowser?.toggleDevtools());
handleTrusted("pi:browser-pick-element", () => agentBrowser?.pickElement());
handleTrusted("pi:browser-screenshot", async () => {
	if (!agentBrowser) return null;
	const title = String(agentBrowser.state().title || "网页截图").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
	const options = {
		title: "保存网页截图",
		defaultPath: join(app.getPath("pictures"), `${title || "网页截图"}.png`),
		filters: [{ name: "PNG 图片", extensions: ["png"] }],
	};
	const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
	if (result.canceled || !result.filePath) return null;
	await agentBrowser.screenshot(result.filePath);
	return { path: result.filePath };
});
listenTrusted("pi:browser-bounds", (_event, bounds) => agentBrowser?.setBounds(bounds));

handleTrusted("pi:choose-directory", async () => {
	const options = {
		properties: ["openDirectory", "createDirectory"],
		title: "选择保存位置",
	};
	const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
	return result.canceled ? null : result.filePaths[0];
});

handleTrusted("pi:open-external", async (_event, url) => {
	const target = String(url);
	if (!/^https?:\/\//i.test(target)) return false;
	await shell.openExternal(target);
	return true;
});

listenTrusted("pi:relaunch", () => {
	app.relaunch();
	app.exit(0);
});

app.whenReady().then(async () => {
	// 升级衔接：改写旧版启动器为 Electron 优先（需在旧服务可能启动前完成）
	upgradeLegacyLauncher();
	if (await portInUse(APP_PORT)) {
		dialog.showErrorBox(
			"Pi 控制台",
			`端口 ${APP_PORT} 已被占用——可能有旧版本正在后台运行。\n\n请先关闭旧版本（或重启电脑）后再启动。`,
		);
		app.quit();
		return;
	}
	try {
		agentBrowser = new AgentBrowserController({
			getWindow: () => win,
			dataDir: process.env.PI_CONSOLE_DATA,
			onState: (state) => {
				if (win && !win.isDestroyed()) win.webContents.send("pi:browser-state-changed", state);
			},
		});
		registerAgentBrowserRuntime(agentBrowser);
		// 启动内嵌后端（server.ts 顶层 listen；同一进程，窗口关闭即整体退出）
		await import("./src/server.ts");
	} catch (error) {
		dialog.showErrorBox("Pi 控制台", `后端启动失败：\n${error?.stack ?? error}`);
		app.quit();
		return;
	}
	createWindow();
});

app.on("window-all-closed", () => {
	app.quit();
});
