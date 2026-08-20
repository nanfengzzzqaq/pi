/**
 * Pi 控制台 Electron 主进程。
 *
 * 直接加载现有 TypeScript 后端（Node ≥22.18 原生 type-stripping），
 * 数据目录与旧版一致（%APPDATA%\pi-console\data），所有数据无缝继承。
 */
import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from "electron";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer as createProbeServer } from "node:net";
import { AgentBrowserController } from "./browser-controller.js";
import { registerAgentBrowserRuntime } from "./src/agent-browser-runtime.ts";

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

const APP_PORT = Number(process.env.PORT);
const APP_URL = `http://127.0.0.1:${APP_PORT}/`;

let win = null;
let agentBrowser = null;

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
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
		return { action: "deny" };
	});
	win.webContents.on("will-navigate", (event, url) => {
		if (url.startsWith(APP_URL)) return;
		event.preventDefault();
		if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
	});
	win.loadURL(APP_URL);
	win.on("closed", () => {
		win = null;
	});
}

ipcMain.on("pi:file-drag-start", (event, path) => {
	try {
		const file = resolve(String(path));
		if (!existsSync(file) || !statSync(file).isFile()) return;
		const icon = nativeImage.createFromPath(join(import.meta.dirname, "icon.png")).resize({ width: 32, height: 32 });
		event.sender.startDrag({ file, files: [file], icon });
	} catch {
		/* 文件在拖动开始前被移动时忽略。 */
	}
});

ipcMain.handle("pi:browser-open", (_event, url) => agentBrowser?.open(typeof url === "string" ? url : undefined));
ipcMain.handle("pi:browser-hide", () => agentBrowser?.hide());
ipcMain.handle("pi:browser-state", () => agentBrowser?.state());
ipcMain.handle("pi:browser-navigate", (_event, url) => agentBrowser?.navigate(String(url ?? "")));
ipcMain.handle("pi:browser-back", () => agentBrowser?.back());
ipcMain.handle("pi:browser-forward", () => agentBrowser?.forward());
ipcMain.handle("pi:browser-reload", () => agentBrowser?.reload());
ipcMain.on("pi:browser-bounds", (_event, bounds) => agentBrowser?.setBounds(bounds));

ipcMain.handle("pi:choose-directory", async () => {
	const options = {
		properties: ["openDirectory", "createDirectory"],
		title: "选择保存位置",
	};
	const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
	return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("pi:open-external", async (_event, url) => {
	const target = String(url);
	if (!/^https?:\/\//i.test(target)) return false;
	await shell.openExternal(target);
	return true;
});

ipcMain.on("pi:relaunch", () => {
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
