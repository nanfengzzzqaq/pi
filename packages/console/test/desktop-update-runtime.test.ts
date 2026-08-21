import { describe, expect, it, vi } from "vitest";
import {
	handOffToDetachedInstaller,
	isDesktopUpdateInstallerAvailable,
	launchDesktopUpdateInstaller,
	registerDesktopUpdateInstaller,
} from "../src/desktop-update-runtime.ts";

const request = {
	setupPath: "D:\\更新缓存\\PiConsole-Setup-0.3.27.exe",
	args: ["--updated", "/S", "--force-run", "/currentuser"],
	targetVersion: "0.3.27",
};

function fakeDetachedProcess() {
	const listeners = new Map<string, (...args: never[]) => void>();
	const child = {
		once: vi.fn((event: string, listener: (...args: never[]) => void) => {
			listeners.set(event, listener);
			return child;
		}),
		unref: vi.fn(),
	};
	return {
		child,
		emit(event: string, ...args: never[]) {
			listeners.get(event)?.(...args);
		},
	};
}

describe("Electron 更新安装桥接", () => {
	it("passes the verified installer request to the desktop main process", async () => {
		const installer = vi.fn().mockResolvedValue(undefined);
		registerDesktopUpdateInstaller(installer);

		expect(isDesktopUpdateInstallerAvailable()).toBe(true);
		await launchDesktopUpdateInstaller(request);
		expect(installer).toHaveBeenCalledOnce();
		expect(installer).toHaveBeenCalledWith(request);
	});

	it("hands off only after the installer survives the observation window", async () => {
		const process = fakeDetachedProcess();
		const onHandedOff = vi.fn();
		const pending = handOffToDetachedInstaller(request, {
			observationMs: 1,
			onHandedOff,
			spawnInstaller: () => process.child as never,
		});
		process.emit("spawn");

		await pending;
		expect(process.child.unref).toHaveBeenCalledOnce();
		expect(onHandedOff).toHaveBeenCalledOnce();
	});

	it("does not close the client when the installer is terminated before handoff", async () => {
		const process = fakeDetachedProcess();
		const onHandedOff = vi.fn();
		const pending = handOffToDetachedInstaller(request, {
			observationMs: 10_000,
			onHandedOff,
			spawnInstaller: () => process.child as never,
		});
		process.emit("spawn");
		process.emit("exit", null as never, "SIGTERM" as never);

		await expect(pending).rejects.toThrow("SIGTERM");
		expect(process.child.unref).not.toHaveBeenCalled();
		expect(onHandedOff).not.toHaveBeenCalled();
	});

	it("reports a non-zero installer exit without handing off", async () => {
		const process = fakeDetachedProcess();
		const onHandedOff = vi.fn();
		const pending = handOffToDetachedInstaller(request, {
			onHandedOff,
			spawnInstaller: () => process.child as never,
		});
		process.emit("exit", 5 as never, null as never);

		await expect(pending).rejects.toThrow("退出码 5");
		expect(onHandedOff).not.toHaveBeenCalled();
	});

	it("preserves the client when CreateProcess throws synchronously", async () => {
		const onHandedOff = vi.fn();
		await expect(
			handOffToDetachedInstaller(request, {
				onHandedOff,
				spawnInstaller: () => {
					throw new Error("CreateProcess failed");
				},
			}),
		).rejects.toThrow("CreateProcess failed");
		expect(onHandedOff).not.toHaveBeenCalled();
	});
});
