const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("piDesktop", {
	/** 取得从 Windows 资源管理器拖入的 File 对象所对应的本地路径。 */
	getFilePath(file) {
		try {
			return webUtils.getPathForFile(file);
		} catch {
			return "";
		}
	},
	/** 把客户端内的真实文件交给 Windows 原生拖放，可直接拖到桌面或资源管理器。 */
	startFileDrag(path) {
		ipcRenderer.send("pi:file-drag-start", path);
		return true;
	},
	openBrowser(url) {
		return ipcRenderer.invoke("pi:browser-open", url);
	},
	hideBrowser() {
		return ipcRenderer.invoke("pi:browser-hide");
	},
	browserState() {
		return ipcRenderer.invoke("pi:browser-state");
	},
	navigateBrowser(url) {
		return ipcRenderer.invoke("pi:browser-navigate", url);
	},
	browserBack() {
		return ipcRenderer.invoke("pi:browser-back");
	},
	browserForward() {
		return ipcRenderer.invoke("pi:browser-forward");
	},
	browserReload() {
		return ipcRenderer.invoke("pi:browser-reload");
	},
	setBrowserBounds(bounds) {
		ipcRenderer.send("pi:browser-bounds", bounds);
	},
	onBrowserState(listener) {
		const handler = (_event, state) => listener(state);
		ipcRenderer.on("pi:browser-state-changed", handler);
		return () => ipcRenderer.removeListener("pi:browser-state-changed", handler);
	},
	chooseDirectory() {
		return ipcRenderer.invoke("pi:choose-directory");
	},
	openExternal(url) {
		return ipcRenderer.invoke("pi:open-external", url);
	},
	relaunch() {
		ipcRenderer.send("pi:relaunch");
	},
});
