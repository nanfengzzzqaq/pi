import { randomUUID } from "node:crypto";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

type LoginInteraction = Parameters<ModelRuntime["login"]>[2];

export interface AntigravityOAuthOperations {
	isAvailable(): boolean;
	isConnected(): boolean;
	login(interaction: LoginInteraction): Promise<void>;
	logout(): Promise<void>;
}

export interface AntigravityOAuthStatus {
	provider: "antigravity";
	phase: "idle" | "starting" | "waiting" | "connected" | "error";
	available: boolean;
	connected: boolean;
	verificationUrl?: string;
	promptId?: string;
	message?: string;
	error?: string;
	expiresAt?: number;
}

const IDLE: AntigravityOAuthStatus = {
	provider: "antigravity",
	phase: "idle",
	available: true,
	connected: false,
};

/** Browser OAuth and a manual callback fallback share one cancellable login attempt. */
export class AntigravityOAuthCoordinator {
	private state: AntigravityOAuthStatus = { ...IDLE };
	private controller: AbortController | undefined;
	private loginPromise: Promise<void> | undefined;
	private pendingPrompt: { id: string; resolve(value: string): void; reject(error: Error): void } | undefined;

	private readonly operations: AntigravityOAuthOperations;

	constructor(operations: AntigravityOAuthOperations) {
		this.operations = operations;
	}

	status(): AntigravityOAuthStatus {
		if (!this.operations.isAvailable()) {
			return { ...IDLE, available: false, phase: "error", error: "Antigravity 模块未加载，请更新依赖并重启 Pi" };
		}
		if (this.operations.isConnected()) {
			return { ...IDLE, phase: "connected", connected: true, message: "Google Antigravity 已连接" };
		}
		return this.state.phase === "connected" ? { ...IDLE } : { ...this.state };
	}

	async start(): Promise<AntigravityOAuthStatus> {
		const current = this.status();
		if (!current.available || current.connected || this.loginPromise) return current;
		const controller = new AbortController();
		this.controller = controller;
		this.state = { ...IDLE, phase: "starting", message: "正在准备 Google 登录", expiresAt: Date.now() + 5 * 60_000 };
		let notifyReady = () => {};
		const ready = new Promise<void>((resolve) => {
			notifyReady = resolve;
		});
		let timedOut = false;
		const deadline = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, 5 * 60_000);
		this.loginPromise = Promise.resolve()
			.then(() =>
				this.operations.login({
					signal: controller.signal,
					notify: (event) => {
						if (controller.signal.aborted) return;
						if (event.type === "auth_url") {
							const url = new URL(event.url);
							if (
								url.protocol !== "https:" ||
								url.hostname !== "accounts.google.com" ||
								url.username ||
								url.password ||
								url.port
							) {
								throw new Error("Unexpected Google authorization URL");
							}
							this.state = {
								...this.state,
								phase: "waiting",
								verificationUrl: url.href,
								message: "请在浏览器中完成 Google 登录",
							};
							notifyReady();
						}
					},
					prompt: (prompt) => {
						if (controller.signal.aborted || prompt.signal?.aborted)
							return Promise.reject(new Error("Login cancelled"));
						if (prompt.type !== "text" && prompt.type !== "manual_code" && prompt.type !== "secret") {
							return Promise.reject(new Error("Unsupported Google login prompt"));
						}
						this.pendingPrompt?.reject(new Error("Prompt replaced"));
						const id = randomUUID();
						this.state = { ...this.state, phase: "waiting", promptId: id };
						notifyReady();
						return new Promise<string>((resolve, reject) => {
							const finish = (value?: string) => {
								controller.signal.removeEventListener("abort", abort);
								prompt.signal?.removeEventListener("abort", abort);
								if (this.pendingPrompt?.id === id) {
									this.pendingPrompt = undefined;
									delete this.state.promptId;
								}
								if (value === undefined) reject(new Error("Login cancelled"));
								else resolve(value);
							};
							const abort = () => finish();
							this.pendingPrompt = { id, resolve: (value) => finish(value), reject: () => finish() };
							controller.signal.addEventListener("abort", abort, { once: true });
							prompt.signal?.addEventListener("abort", abort, { once: true });
						});
					},
				}),
			)
			.then(() => {
				this.state = controller.signal.aborted ? { ...IDLE } : { ...IDLE, phase: "connected", connected: true };
			})
			.catch(() => {
				// Provider errors can contain authorization codes or tokens; never send them to the browser.
				this.state =
					controller.signal.aborted && !timedOut
						? { ...IDLE }
						: {
								...IDLE,
								phase: "error",
								error: timedOut
									? "Google 登录已超时，请重新登录"
									: "Google 登录失败，请检查网络、账号授权和完整回调地址后重试",
							};
			})
			.finally(() => {
				clearTimeout(deadline);
				this.pendingPrompt?.reject(new Error("Login finished"));
				this.controller = undefined;
				this.loginPromise = undefined;
				notifyReady();
			});
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				ready,
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, 5_000);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
		return this.status();
	}

	respond(promptId: unknown, value: unknown): AntigravityOAuthStatus {
		if (!this.pendingPrompt || promptId !== this.pendingPrompt.id) throw new Error("登录输入已过期，请刷新登录状态");
		if (typeof value !== "string" || !value.trim() || value.length > 8192)
			throw new Error("请粘贴浏览器中的完整回调地址");
		this.pendingPrompt.resolve(value.trim());
		this.state.message = "正在验证授权；若未完成，请重新粘贴完整回调地址";
		return this.status();
	}

	cancel(): void {
		this.controller?.abort();
		this.state = { ...IDLE };
	}

	async stop(): Promise<AntigravityOAuthStatus> {
		this.cancel();
		await this.loginPromise;
		this.state = { ...IDLE };
		return this.status();
	}

	async logout(): Promise<AntigravityOAuthStatus> {
		await this.stop();
		await this.operations.logout();
		return this.status();
	}
}
