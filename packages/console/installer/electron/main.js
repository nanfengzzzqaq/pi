/**
 * Pi 控制台 Electron 主进程。
 *
 * 直接加载现有 TypeScript 后端（Node ≥22.18 原生 type-stripping），
 * 数据目录与旧版一致（%APPDATA%\pi-console\data），所有数据无缝继承。
 */
import { app, BrowserWindow, dialog } from "electron";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer as createProbeServer } from "node:net";

// 数据目录与旧版（vbs + Edge 模式）保持一致，升级不丢任何数据
process.env.PI_CONSOLE_DATA = process.env.PI_CONSOLE_DATA ?? join(app.getPath("appData"), "pi-console", "data");
process.env.PORT = process.env.PORT ?? "3200";

const APP_URL = "http://127.0.0.1:3200/";

let win = null;

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
		minWidth: 960,
		minHeight: 600,
		title: "Pi 控制台",
		icon: join(import.meta.dirname, "icon.png"),
		autoHideMenuBar: true,
		backgroundColor: "#0b1220",
	});
	win.loadURL(APP_URL);
	win.on("closed", () => {
		win = null;
	});
}

app.whenReady().then(async () => {
	// 升级衔接：改写旧版启动器为 Electron 优先（需在旧服务可能启动前完成）
	upgradeLegacyLauncher();
	if (await portInUse(3200)) {
		dialog.showErrorBox(
			"Pi 控制台",
			"端口 3200 已被占用——可能有旧版本正在后台运行。\n\n请先关闭旧版本（或重启电脑）后再启动。",
		);
		app.quit();
		return;
	}
	try {
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
