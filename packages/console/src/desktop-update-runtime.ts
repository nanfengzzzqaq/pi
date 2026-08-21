/**
 * Electron 主进程与控制台后端之间的更新安装桥接。
 *
 * 后端负责下载和校验安装包；Electron 主进程负责直接启动 NSIS 并优雅退出。
 * 纯网页开发模式不会注册 launcher，因此不会误关开发服务器。
 */
import { spawn } from "node:child_process";

export interface DesktopUpdateInstallRequest {
	setupPath: string;
	args: string[];
	targetVersion: string;
}

export type DesktopUpdateInstaller = (request: DesktopUpdateInstallRequest) => Promise<void>;

interface DetachedInstallerProcess {
	once(event: "spawn", listener: () => void): this;
	once(event: "error", listener: (error: Error) => void): this;
	once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	unref(): void;
}

export interface DetachedInstallerOptions {
	observationMs?: number;
	onHandedOff: () => void;
	spawnInstaller?: (path: string, args: string[]) => DetachedInstallerProcess;
}

let installer: DesktopUpdateInstaller | null = null;

export function registerDesktopUpdateInstaller(value: DesktopUpdateInstaller): void {
	installer = value;
}

export function isDesktopUpdateInstallerAvailable(): boolean {
	return installer !== null;
}

export async function launchDesktopUpdateInstaller(request: DesktopUpdateInstallRequest): Promise<void> {
	if (!installer) throw new Error("当前不是 Windows 桌面客户端，无法自动安装更新");
	await installer(request);
}

/**
 * 启动 NSIS 后观察短暂窗口，避免把 CreateProcess 成功误当作安装器正常运行。
 * 安装器被信号终止或返回非零码时保留当前客户端，并把具体原因交给恢复界面。
 */
export async function handOffToDetachedInstaller(
	request: DesktopUpdateInstallRequest,
	options: DetachedInstallerOptions,
): Promise<void> {
	const spawnInstaller =
		options.spawnInstaller ??
		((path: string, args: string[]) =>
			spawn(path, args, {
				detached: true,
				stdio: "ignore",
				windowsHide: true,
			}));
	const observationMs = options.observationMs ?? 500;

	await new Promise<void>((resolveLaunch, rejectLaunch) => {
		let child: DetachedInstallerProcess;
		try {
			child = spawnInstaller(request.setupPath, request.args);
		} catch (error) {
			rejectLaunch(error);
			return;
		}
		let settled = false;
		let observationTimer: ReturnType<typeof setTimeout> | null = null;
		const reject = (error: Error) => {
			if (settled) return;
			settled = true;
			if (observationTimer) clearTimeout(observationTimer);
			rejectLaunch(error);
		};
		const handOff = () => {
			if (settled) return;
			settled = true;
			if (observationTimer) clearTimeout(observationTimer);
			try {
				child.unref();
				options.onHandedOff();
				resolveLaunch();
			} catch (error) {
				rejectLaunch(error);
			}
		};
		child.once("spawn", () => {
			observationTimer = setTimeout(handOff, observationMs);
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) {
				handOff();
				return;
			}
			const detail = signal ? `被信号 ${signal} 终止` : `退出码 ${code ?? "未知"}`;
			reject(new Error(`更新安装器启动失败（${detail}）`));
		});
	});
}
