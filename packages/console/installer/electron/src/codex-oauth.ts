/** Codex 订阅登录协调器：复用 Pi 官方 openai-codex OAuth，不自行实现认证协议。 */
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

type LoginInteraction = Parameters<ModelRuntime["login"]>[2];

export interface CodexOAuthOperations {
	isConnected(): boolean;
	login(interaction: LoginInteraction): Promise<void>;
	logout(): Promise<void>;
}

export type CodexOAuthPhase = "idle" | "starting" | "waiting" | "connected" | "error";

export interface CodexOAuthStatus {
	provider: "openai-codex";
	internalName: "openai-codex-oauth";
	phase: CodexOAuthPhase;
	connected: boolean;
	verificationUrl?: string;
	userCode?: string;
	message?: string;
	error?: string;
}

const IDLE_STATUS: CodexOAuthStatus = {
	provider: "openai-codex",
	internalName: "openai-codex-oauth",
	phase: "idle",
	connected: false,
};

export class CodexOAuthCoordinator {
	private readonly operations: CodexOAuthOperations;
	private state: CodexOAuthStatus = { ...IDLE_STATUS };
	private controller: AbortController | null = null;
	private loginPromise: Promise<void> | null = null;

	constructor(operations: CodexOAuthOperations) {
		this.operations = operations;
	}

	status(): CodexOAuthStatus {
		if (this.operations.isConnected()) {
			return {
				provider: "openai-codex",
				internalName: "openai-codex-oauth",
				phase: "connected",
				connected: true,
				message: "Codex 订阅登录已连接",
			};
		}
		return { ...this.state, connected: false };
	}

	async start(): Promise<CodexOAuthStatus> {
		const current = this.status();
		if (current.connected || this.loginPromise) return current;

		const controller = new AbortController();
		this.controller = controller;
		this.state = {
			...IDLE_STATUS,
			phase: "starting",
			message: "正在申请 Codex 设备登录码",
		};

		let notifyReady: (() => void) | null = null;
		const ready = new Promise<void>((resolve) => {
			notifyReady = resolve;
		});

		this.loginPromise = this.operations
			.login({
				signal: controller.signal,
				prompt: async (prompt) => {
					if (prompt.type === "select") {
						const deviceCode = prompt.options.find((option) => option.id === "device_code");
						if (deviceCode) return deviceCode.id;
					}
					throw new Error("当前 Pi 版本不支持客户端需要的 Codex 设备登录流程");
				},
				notify: (event) => {
					if (event.type === "device_code") {
						this.state = {
							...IDLE_STATUS,
							phase: "waiting",
							verificationUrl: event.verificationUri,
							userCode: event.userCode,
							message: "请在浏览器中输入设备码完成 ChatGPT 登录",
						};
						notifyReady?.();
					} else if (event.type === "auth_url") {
						this.state = {
							...IDLE_STATUS,
							phase: "waiting",
							verificationUrl: event.url,
							message: event.instructions ?? "请在浏览器中完成 ChatGPT 登录",
						};
						notifyReady?.();
					} else if (event.type === "progress" || event.type === "info") {
						this.state = { ...this.state, message: event.message };
					}
				},
			})
			.then(() => {
				this.state = {
					...IDLE_STATUS,
					phase: "connected",
					connected: true,
					message: "Codex 订阅登录已连接",
				};
				notifyReady?.();
			})
			.catch((error: unknown) => {
				this.state = controller.signal.aborted
					? { ...IDLE_STATUS }
					: {
							...IDLE_STATUS,
							phase: "error",
							error: error instanceof Error ? error.message : String(error),
						};
				notifyReady?.();
			})
			.finally(() => {
				if (this.controller === controller) this.controller = null;
				this.loginPromise = null;
			});

		let timeout: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				ready,
				this.loginPromise,
				new Promise<void>((resolve) => {
					timeout = setTimeout(resolve, 5_000);
				}),
			]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
		return this.status();
	}

	async logout(): Promise<CodexOAuthStatus> {
		this.controller?.abort();
		await this.loginPromise;
		await this.operations.logout();
		this.state = { ...IDLE_STATUS };
		return this.status();
	}

	cancel(): void {
		this.controller?.abort();
	}
}
