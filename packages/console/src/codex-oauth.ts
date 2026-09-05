/** Device-code login uses the runtime's official protocol, with bounded, redacted UI state. */
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
	expiresAt?: number;
}
const IDLE_STATUS: CodexOAuthStatus = {
	provider: "openai-codex",
	internalName: "openai-codex-oauth",
	phase: "idle",
	connected: false,
};
function authorizationUrl(value: string): string {
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		!["auth.openai.com", "chatgpt.com"].includes(url.hostname) ||
		url.username ||
		url.password ||
		url.port
	)
		throw new Error("Unexpected authorization URL");
	return url.href;
}
export class CodexOAuthCoordinator {
	private readonly operations: CodexOAuthOperations;
	private state: CodexOAuthStatus = { ...IDLE_STATUS };
	private controller: AbortController | null = null;
	private loginPromise: Promise<void> | null = null;
	constructor(operations: CodexOAuthOperations) {
		this.operations = operations;
	}
	status(): CodexOAuthStatus {
		if (this.operations.isConnected())
			return { ...IDLE_STATUS, phase: "connected", connected: true, message: "Codex 订阅登录已连接" };
		return this.state.phase === "connected" ? { ...IDLE_STATUS } : { ...this.state, connected: false };
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
			expiresAt: Date.now() + 5 * 60_000,
		};
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
					prompt: async (prompt) => {
						controller.signal.throwIfAborted();
						if (prompt.type === "select") {
							const deviceCode = prompt.options.find((option) => option.id === "device_code");
							if (deviceCode) return deviceCode.id;
						}
						throw new Error("Unsupported device login flow");
					},
					notify: (event) => {
						if (controller.signal.aborted || this.controller !== controller) return;
						if (event.type === "device_code") {
							this.state = {
								...this.state,
								phase: "waiting",
								verificationUrl: authorizationUrl(event.verificationUri),
								userCode: event.userCode,
								message: "请在浏览器中输入设备码完成 ChatGPT 登录",
							};
							notifyReady();
						} else if (event.type === "auth_url") {
							this.state = {
								...this.state,
								phase: "waiting",
								verificationUrl: authorizationUrl(event.url),
								message: "请在浏览器中完成 ChatGPT 登录",
							};
							notifyReady();
						}
					},
				}),
			)
			.then(() => {
				if (this.controller === controller)
					this.state = controller.signal.aborted
						? { ...IDLE_STATUS }
						: { ...IDLE_STATUS, phase: "connected", connected: true };
			})
			.catch(() => {
				if (this.controller === controller)
					this.state =
						controller.signal.aborted && !timedOut
							? { ...IDLE_STATUS }
							: {
									...IDLE_STATUS,
									phase: "error",
									error: timedOut
										? "Codex 登录已超时，请重新登录"
										: "Codex 登录失败，请检查网络和账号授权后重试",
								};
			})
			.finally(() => {
				clearTimeout(deadline);
				if (this.controller === controller) {
					this.controller = null;
					this.loginPromise = null;
				}
				notifyReady();
			});
		let timeout: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				ready,
				new Promise<void>((resolve) => {
					timeout = setTimeout(resolve, 5_000);
				}),
			]);
		} finally {
			clearTimeout(timeout);
		}
		return this.status();
	}
	async logout(): Promise<CodexOAuthStatus> {
		this.cancel();
		await this.loginPromise;
		await this.operations.logout();
		this.state = { ...IDLE_STATUS };
		return this.status();
	}
	cancel(): void {
		this.controller?.abort();
		this.state = { ...IDLE_STATUS };
	}
}
