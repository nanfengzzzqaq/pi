/**
 * Electron 内置智能体浏览器与 Pi 会话之间的窄接口。
 *
 * Web 开发模式不会注册运行时，因此浏览器能力不会被挂载；Electron 主进程
 * 在启动后注册实现。这里不依赖 electron，使后端和测试仍可单独运行。
 */

import { randomUUID } from "node:crypto";

export interface AgentBrowserState {
	open: boolean;
	url: string;
	title: string;
	loading: boolean;
	canGoBack: boolean;
	canGoForward: boolean;
	status: string;
	downloadPath?: string;
}

export interface AgentBrowserTarget {
	ref?: string;
	selector?: string;
	text?: string;
}

const SENSITIVE_QUERY_PARAMETER =
	/^(?:access_?token|provisional_?token|refresh_?token|id_?token|token|authorization|auth|api_?key|secret|session|sid)$/i;
const SENSITIVE_PARAMETER_VALUE =
	/([?&#](?:access_?token|provisional_?token|refresh_?token|id_?token|token|authorization|auth|api_?key|secret|session|sid)=)(?!\[REDACTED\])([^&#\s<>"')\]}，。；！,;]+)/gi;
// `]` 终止 Markdown 链接文字，避免把 `](https://...)` 两个地址误当成一个。
const HTTP_URL = /https?:\/\/[^\s<>"'\]]+/gi;
const VAULT_REFERENCE_PREFIX = "pi-browser-secret-";
const MAX_VAULTED_VALUES = 2048;
const browserUrlSecretVault = new Map<string, string>();

function splitTrailingUrlPunctuation(value: string): { url: string; suffix: string } {
	let end = value.length;
	while (end > 0 && /[.,;!，。；！、]/.test(value[end - 1] ?? "")) end--;
	for (const [closing, opening] of [
		[")", "("],
		["]", "["],
		["}", "{"],
	] as const) {
		while (end > 0 && value[end - 1] === closing) {
			const candidate = value.slice(0, end);
			const closingCount = candidate.split(closing).length - 1;
			const openingCount = candidate.split(opening).length - 1;
			if (closingCount <= openingCount) break;
			end--;
		}
	}
	return { url: value.slice(0, end), suffix: value.slice(end) };
}

function transformSensitiveParameterValues(value: string, transform: (secret: string) => string): string {
	return value.replace(SENSITIVE_PARAMETER_VALUE, (_match, prefix: string, secret: string) => {
		return `${prefix}${transform(secret)}`;
	});
}

function transformHttpUrls(value: string, transform: (url: string) => string): string {
	return value.replace(HTTP_URL, (matched) => {
		const { url, suffix } = splitTrailingUrlPunctuation(matched);
		return `${transform(url)}${suffix}`;
	});
}

function rememberBrowserUrlSecret(secret: string): string {
	if (browserUrlSecretVault.size >= MAX_VAULTED_VALUES) {
		const oldest = browserUrlSecretVault.keys().next().value as string | undefined;
		if (oldest) browserUrlSecretVault.delete(oldest);
	}
	const reference = `${VAULT_REFERENCE_PREFIX}${randomUUID()}`;
	browserUrlSecretVault.set(reference, secret);
	return reference;
}

/**
 * 浏览器内部仍使用原始 URL 完成导航，但任何送往 UI、模型或会话日志的 URL
 * 都必须先移除登录令牌。易快报会把临时凭据直接放在查询参数里。
 */
export function redactSensitiveUrl(value: string): string {
	const input = String(value ?? "");
	try {
		const url = new URL(input);
		for (const key of [...url.searchParams.keys()]) {
			if (SENSITIVE_QUERY_PARAMETER.test(key)) url.searchParams.set(key, "[REDACTED]");
		}
		// URLSearchParams 不解析 hash 路由内部的 query；再次扫完整序列化结果。
		return transformSensitiveParameterValues(url.toString(), () => "[REDACTED]");
	} catch {
		return transformSensitiveParameterValues(input, () => "[REDACTED]");
	}
}

/** 对工具输出中的每一个 HTTP(S) URL 做同样的脱敏，作为日志边界的兜底。 */
export function redactSensitiveText(value: string): string {
	const redactedUrls = transformHttpUrls(String(value ?? ""), (url) => redactSensitiveUrl(url));
	return transformSensitiveParameterValues(redactedUrls, () => "[REDACTED]");
}

/**
 * 在用户消息写入 AgentSession 前，把 URL 凭据换成随机引用。模型和 JSONL 只会
 * 看到引用；原值仅保存在当前进程内存中，并只在真正导航的最后一刻还原。
 */
export function vaultSensitiveUrlsInText(value: string): string {
	return transformHttpUrls(String(value ?? ""), (candidate) => {
		let parsed: URL;
		try {
			parsed = new URL(candidate);
		} catch {
			return candidate;
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return candidate;
		return transformSensitiveParameterValues(candidate, rememberBrowserUrlSecret);
	});
}

/** 仅供 browser_navigate 使用：将安全引用还原成用户最初提供的原始 URL。 */
export function resolveSensitiveBrowserUrl(value: string): string {
	return transformSensitiveParameterValues(String(value ?? ""), (reference) => {
		let normalizedReference = reference;
		try {
			normalizedReference = decodeURIComponent(reference);
		} catch {
			// 非法转义不是 vault 引用，按普通 URL 值处理。
		}
		if (!normalizedReference.startsWith(VAULT_REFERENCE_PREFIX)) return reference;
		const secret = browserUrlSecretVault.get(normalizedReference);
		if (secret === undefined) {
			throw new Error("安全网址凭据已过期，请重新粘贴原始链接后再打开");
		}
		return secret;
	});
}

export interface AgentBrowserUploadFile {
	name: string;
	mimeType: string;
	dataBase64: string;
}

export interface AgentBrowserRuntime {
	setDownloadDirectory(path: string): void;
	open(url?: string): Promise<AgentBrowserState>;
	hide(): AgentBrowserState;
	state(): AgentBrowserState;
	navigate(url: string): Promise<AgentBrowserState>;
	back(): AgentBrowserState;
	forward(): AgentBrowserState;
	reload(): AgentBrowserState;
	snapshot(maxChars: number): Promise<string>;
	click(target: AgentBrowserTarget): Promise<string>;
	type(target: AgentBrowserTarget, value: string, pressEnter: boolean, commit: boolean): Promise<string>;
	scroll(direction: "up" | "down" | "left" | "right", amount: number): Promise<string>;
	extract(selector: string | undefined, maxChars: number): Promise<string>;
	screenshot(path: string): Promise<string>;
	wait(milliseconds: number, text?: string): Promise<string>;
	uploadFiles(files: AgentBrowserUploadFile[], target?: AgentBrowserTarget): Promise<string>;
}

let runtime: AgentBrowserRuntime | null = null;

export function registerAgentBrowserRuntime(value: AgentBrowserRuntime): void {
	runtime = value;
}

export function isAgentBrowserRuntimeAvailable(): boolean {
	return runtime !== null;
}

export function getAgentBrowserRuntime(): AgentBrowserRuntime {
	if (!runtime) throw new Error("客户端内置浏览器只在 Windows 桌面版中可用");
	return runtime;
}
