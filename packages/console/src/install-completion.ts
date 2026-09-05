interface InstallProgress {
	running: boolean;
	error: string | null;
	phase: string;
}

/** Keep an install busy until activation and persistence have also succeeded. */
export class InstallCompletion {
	private readonly states = new Map<string, { running: boolean; error: string | null }>();
	get busy(): boolean {
		return [...this.states.values()].some((state) => state.running);
	}
	progress<T extends InstallProgress>(id: string, progress: T): T {
		const state = this.states.get(id);
		if (state?.error) return { ...progress, running: false, phase: "failed", error: state.error };
		if (state?.running && !progress.running) return { ...progress, running: true, phase: "activating" };
		return progress;
	}
	start(id: string, progress: () => InstallProgress, activate: () => Promise<void>): void {
		if (this.states.get(id)?.running) throw new Error("安装收尾仍在进行中");
		const state = { running: true, error: null as string | null };
		this.states.set(id, state);
		void (async () => {
			try {
				while (progress().running) await new Promise<void>((resolve) => setTimeout(resolve, 100));
				if (!progress().error) await activate();
			} catch {
				state.error = "工具已下载，但启用未完成，请检查数据目录权限后重新安装";
			} finally {
				state.running = false;
			}
		})();
	}
}
