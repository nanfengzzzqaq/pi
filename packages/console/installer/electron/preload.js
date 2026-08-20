import { contextBridge, ipcRenderer, webUtils } from "electron";

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
