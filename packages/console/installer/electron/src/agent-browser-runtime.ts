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

export interface AgentBrowserLocator {
	ref?: string;
	selector?: string;
	text?: string;
	/** 1-based match index when a locator intentionally matches more than one element. */
	occurrence?: number;
}

export interface AgentBrowserTarget extends AgentBrowserLocator {
	/** All strings must occur in a nearby ancestor of the target. */
	scopeTexts?: string[];
	/** Restrict target lookup to the element resolved by this locator. */
	within?: AgentBrowserLocator;
}

export interface AgentBrowserSnapshotOptions {
	maxChars: number;
	maxElements?: number;
	scopeTexts?: string[];
}

export interface AgentBrowserSnapshotCandidate {
	text: string;
	dedupeText?: string;
	x: number;
	y: number;
	width: number;
	height: number;
	dedupeDepth?: number;
	dedupeActivationKey?: string;
}

/**
 * Collapse DOM wrappers/clones that describe the same visible control row.
 * Geometry alone is insufficient: distinct activation roots are never merged,
 * even when a framework temporarily stacks them during an animation.
 */
export function deduplicateAgentBrowserSnapshotCandidates<T extends AgentBrowserSnapshotCandidate>(
	candidates: readonly T[],
	maxElements = Number.MAX_SAFE_INTEGER,
): T[] {
	const normalize = (value: string) => value.replace(/[\s/：:（）()_-]+/g, "").toLocaleLowerCase("zh-CN");
	const entries = candidates.map((candidate, index) => ({
		candidate,
		index,
		text: normalize(candidate.dedupeText ?? candidate.text),
		activationKey: candidate.dedupeActivationKey?.trim() ?? "",
	}));
	const parent = entries.map((_entry, index) => index);
	const activationKeys = entries.map((entry) => entry.activationKey);
	const find = (index: number): number => {
		let root = index;
		while (parent[root] !== root) root = parent[root] as number;
		while (parent[index] !== index) {
			const next = parent[index] as number;
			parent[index] = root;
			index = next;
		}
		return root;
	};
	const overlap = (left: T, right: T): boolean => {
		const overlapWidth = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x);
		const overlapHeight = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);
		return (
			overlapWidth > 0 &&
			overlapHeight > 0 &&
			overlapWidth >= Math.min(left.width, right.width) * 0.5 &&
			overlapHeight >= Math.min(left.height, right.height) * 0.5
		);
	};
	const groups = new Map<string, number[]>();
	for (const entry of entries) {
		if (!entry.text || entry.candidate.width <= 0 || entry.candidate.height <= 0) continue;
		const group = groups.get(entry.text) ?? [];
		group.push(entry.index);
		groups.set(entry.text, group);
	}
	for (const group of groups.values()) {
		for (let leftIndex = 0; leftIndex < group.length; leftIndex++) {
			for (let rightIndex = leftIndex + 1; rightIndex < group.length; rightIndex++) {
				const left = group[leftIndex] as number;
				const right = group[rightIndex] as number;
				if (!overlap(entries[left]!.candidate, entries[right]!.candidate)) continue;
				const leftRoot = find(left);
				const rightRoot = find(right);
				if (leftRoot === rightRoot) continue;
				const leftKey = activationKeys[leftRoot] ?? "";
				const rightKey = activationKeys[rightRoot] ?? "";
				if (leftKey && rightKey && leftKey !== rightKey) continue;
				parent[rightRoot] = leftRoot;
				activationKeys[leftRoot] = leftKey || rightKey;
			}
		}
	}
	const clusters = new Map<number, Array<(typeof entries)[number]>>();
	for (const entry of entries) {
		const root = find(entry.index);
		const cluster = clusters.get(root) ?? [];
		cluster.push(entry);
		clusters.set(root, cluster);
	}
	return [...clusters.values()]
		.map(
			(cluster) =>
				cluster.sort((left, right) => {
					const depth = (right.candidate.dedupeDepth ?? 0) - (left.candidate.dedupeDepth ?? 0);
					if (depth !== 0) return depth;
					const area =
						left.candidate.width * left.candidate.height - right.candidate.width * right.candidate.height;
					return area || left.index - right.index;
				})[0]!,
		)
		.sort((left, right) => left.index - right.index)
		.slice(0, Math.max(0, maxElements))
		.map((entry) => entry.candidate);
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

function decodedUrlCredential(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function transformedSearchParams(params: URLSearchParams, transform: (secret: string) => string): URLSearchParams {
	const rewritten = new URLSearchParams();
	for (const [key, value] of params) {
		rewritten.append(key, SENSITIVE_QUERY_PARAMETER.test(key) ? transform(value) : value);
	}
	return rewritten;
}

/**
 * Rewrite credentials through parsed URL components so encoded parameter names
 * cannot bypass the vault. Hash-router query strings and URL userinfo need
 * explicit handling because URL.searchParams covers neither.
 */
function transformParsedUrlCredentials(input: string, transform: (secret: string) => string): string | undefined {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return input;
	if (url.username) url.username = transform(decodedUrlCredential(url.username));
	if (url.password) url.password = transform(decodedUrlCredential(url.password));
	const query = transformedSearchParams(url.searchParams, transform);
	url.search = query.size > 0 ? `?${query.toString()}` : "";

	const rawHash = url.hash.slice(1);
	if (rawHash) {
		const queryIndex = rawHash.indexOf("?");
		const hashIsOnlyQuery = queryIndex === -1 && rawHash.includes("=") && !rawHash.includes("/");
		if (queryIndex >= 0 || hashIsOnlyQuery) {
			const prefix = queryIndex >= 0 ? rawHash.slice(0, queryIndex + 1) : "";
			const rawQuery = queryIndex >= 0 ? rawHash.slice(queryIndex + 1) : rawHash;
			const hashQuery = transformedSearchParams(new URLSearchParams(rawQuery), transform);
			url.hash = `${prefix}${hashQuery.toString()}`;
		}
	}
	return url.toString();
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
	const parsed = transformParsedUrlCredentials(input, () => "[REDACTED]");
	const redacted = transformSensitiveParameterValues(parsed ?? input, () => "[REDACTED]");
	// Keep the established human-readable marker in UI text after URL serialization.
	return redacted.replaceAll("%5BREDACTED%5D", "[REDACTED]");
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
		const vault = (secret: string) =>
			secret.startsWith(VAULT_REFERENCE_PREFIX) ? secret : rememberBrowserUrlSecret(secret);
		const parsed = transformParsedUrlCredentials(candidate, vault);
		return transformSensitiveParameterValues(parsed ?? candidate, vault);
	});
}

/** 仅供 browser_navigate 使用：将安全引用还原成用户最初提供的原始 URL。 */
export function resolveSensitiveBrowserUrl(value: string): string {
	const input = String(value ?? "");
	const resolveReference = (reference: string) => {
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
	};
	const parsed = transformParsedUrlCredentials(input, resolveReference);
	return transformSensitiveParameterValues(parsed ?? input, resolveReference);
}

export interface AgentBrowserUploadFile {
	name: string;
	mimeType: string;
	dataBase64: string;
}

/**
 * The travel pack may use this contract inside the Electron main process. It is
 * deliberately not an Agent tool: the model never receives a selector, a DOM
 * ref, JavaScript source, or a generic "evaluate" primitive.
 */
export const EKUAIBAO_TRUSTED_CONTRACT_VERSION = 1 as const;
export const EKUAIBAO_TRUSTED_ORIGIN = "https://app.ekuaibao.com";
export const EKUAIBAO_TRUSTED_PAGE_FINGERPRINT = "https://app.ekuaibao.com/web/app.html#/billEntryDetail";

export type EkuaibaoTrustedDetailKind = "transport" | "hotel" | "allowance";

export type EkuaibaoTrustedScope =
	| { kind: "main" }
	| { kind: "application-dialog" }
	| { kind: "application-details" }
	| { kind: "detail-picker" }
	| { kind: "detail-drawer"; detailKind: EkuaibaoTrustedDetailKind }
	| { kind: "invoice-menu"; detailKind: "transport" | "hotel" }
	| { kind: "invoice-dialog"; detailKind: "transport" | "hotel" }
	| { kind: "invoice-results"; detailKind: "transport" | "hotel" };

export type EkuaibaoTrustedField =
	| "application-search"
	| "company"
	| "description"
	| "submitter"
	| "station"
	| "reimbursement-date"
	| "expense-nature"
	| "applicant-department"
	| "expense-department"
	| "main-payment-recipient"
	| "fee-type-search"
	| "detail-start-date"
	| "detail-end-date"
	| "departure-city"
	| "arrival-city"
	| "seat-class"
	| "reimbursement-amount"
	| "expense-reporter"
	| "payment-recipient"
	| "allowance-type";

/** Safe controls only. Save-draft has a separate command and submit/delete are absent. */
export type EkuaibaoTrustedControl =
	| "open-application"
	| "confirm-application"
	| "open-application-details"
	| "close-application-details"
	| "open-main-payment-recipient"
	| "open-payment-recipient"
	| "open-expense-reporter"
	| "add-detail"
	| "open-detail"
	| "show-invoice-menu"
	| "open-smart-invoice"
	| "confirm-invoice-upload"
	| "bind-recognized-invoice"
	| "save-detail"
	| "close-detail";

export type EkuaibaoTrustedOptionKind =
	| "application"
	| "station"
	| "expense-nature"
	| "department"
	| "fee-type"
	| "city"
	| "seat-class"
	| "expense-reporter"
	| "payment-recipient"
	| "allowance-type"
	| "recognized-invoice";

export type EkuaibaoTrustedUploadSlot = "smart-invoice" | "detail-attachments";

interface EkuaibaoTrustedMutationBase {
	contractVersion: typeof EKUAIBAO_TRUSTED_CONTRACT_VERSION;
	/** Opaque document capability issued by inspect. Invalidated by main-frame navigation. */
	pageToken: string;
	/** Digest returned by the immediately preceding inspect/result. */
	expectedDigest: string;
}

export type EkuaibaoTrustedCommand =
	| {
			op: "inspect";
			contractVersion: typeof EKUAIBAO_TRUSTED_CONTRACT_VERSION;
	  }
	| (EkuaibaoTrustedMutationBase & {
			op: "click";
			control: EkuaibaoTrustedControl;
			scope: EkuaibaoTrustedScope;
			/** Required only by open-detail; fixed business facts that must identify one folded row. */
			detailKind?: EkuaibaoTrustedDetailKind;
			evidence?: string[];
	  })
	| (EkuaibaoTrustedMutationBase & {
			op: "hover";
			control: "show-invoice-menu";
			scope: Extract<EkuaibaoTrustedScope, { kind: "detail-drawer" }>;
	  })
	| (EkuaibaoTrustedMutationBase & {
			op: "type";
			field: EkuaibaoTrustedField;
			scope: EkuaibaoTrustedScope;
			value: string;
			commit?: boolean;
	  })
	| (EkuaibaoTrustedMutationBase & {
			op: "select-exact";
			optionKind: EkuaibaoTrustedOptionKind;
			scope: EkuaibaoTrustedScope;
			/** Human-visible option text or the strongest unique identity fragment. */
			value: string;
			/** Additional exact business facts which must occur in the same local option row. */
			evidence?: string[];
	  })
	| (EkuaibaoTrustedMutationBase & {
			op: "upload";
			slot: EkuaibaoTrustedUploadSlot;
			scope: Extract<EkuaibaoTrustedScope, { kind: "invoice-dialog" | "detail-drawer" }>;
			files: AgentBrowserUploadFile[];
	  })
	| (EkuaibaoTrustedMutationBase & {
			op: "save-draft";
	  });

export interface EkuaibaoTrustedFieldState {
	present: boolean;
	ambiguous: boolean;
	required: boolean;
	disabled: boolean;
	value?: string;
}

export interface EkuaibaoTrustedMultipleRecipientsState {
	present: boolean;
	checked?: boolean;
	source: "native-input" | "role-switch" | "aria-checked" | "missing" | "ambiguous";
}

export interface EkuaibaoTrustedLinkedApplicationState {
	id?: string;
	title?: string;
	startDate?: string;
	endDate?: string;
}

export interface EkuaibaoTrustedApplicationSourceState {
	id: string;
	title: string;
	reason: string;
	expenseNature: "部门费用" | "项目费用";
}

export interface EkuaibaoTrustedFoldedDetailState {
	feeType: "transport" | "hotel" | "allowance";
	summary: string;
	startDate?: string;
	endDate?: string;
	amount?: string;
	invoiceCount?: number;
}

export interface EkuaibaoTrustedPageState {
	contractVersion: typeof EKUAIBAO_TRUSTED_CONTRACT_VERSION;
	pageToken: string;
	pageFingerprint: typeof EKUAIBAO_TRUSTED_PAGE_FINGERPRINT;
	route: "bill-entry-detail";
	overlay:
		| "none"
		| "application-dialog"
		| "application-details"
		| "detail-picker"
		| "detail-drawer"
		| "invoice-menu"
		| "invoice-dialog"
		| "invoice-results";
	digest: string;
	fields: Partial<Record<EkuaibaoTrustedField, EkuaibaoTrustedFieldState>>;
	controls: Partial<
		Record<EkuaibaoTrustedControl | "save-draft", { present: boolean; ambiguous: boolean; disabled: boolean }>
	>;
	multipleRecipients: EkuaibaoTrustedMultipleRecipientsState;
	applicationSource?: EkuaibaoTrustedApplicationSourceState;
	linkedApplication?: EkuaibaoTrustedLinkedApplicationState;
	detailCount?: number;
	calculatedTotal?: string;
	validationErrors: string[];
	foldedDetails: EkuaibaoTrustedFoldedDetailState[];
	draftConfirmationVisible: boolean;
}

export type EkuaibaoTrustedFailureCode =
	| "invalid_command"
	| "wrong_page"
	| "contract_mismatch"
	| "stale_page"
	| "stale_state"
	| "missing_anchor"
	| "ambiguous_anchor"
	| "unsafe_target"
	| "unverified_state";

export type EkuaibaoTrustedResult =
	| {
			ok: true;
			message: string;
			beforeDigest: string;
			afterDigest: string;
			state: EkuaibaoTrustedPageState;
	  }
	| {
			ok: false;
			code: EkuaibaoTrustedFailureCode;
			message: string;
	  };

/** Exact page allow-list; query credentials are allowed but never become part of the fingerprint. */
export function isEkuaibaoTrustedPageUrl(value: string): boolean {
	try {
		const url = new URL(String(value ?? "").trim());
		return (
			url.origin === EKUAIBAO_TRUSTED_ORIGIN &&
			!url.username &&
			!url.password &&
			url.pathname === "/web/app.html" &&
			/^#\/billEntryDetail(?:[/?]|$)/.test(url.hash)
		);
	} catch {
		return false;
	}
}

/**
 * Capture the exact HTTP(S) origin before local attachment bytes are read.
 * The controller compares this lock with its live WebContents URL before any
 * bytes are injected, closing the state-check/upload redirect race.
 */
export function agentBrowserUploadOrigin(value: string): string {
	try {
		const url = new URL(String(value ?? "").trim());
		if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
		if (url.username || url.password || url.origin === "null") throw new Error("unsafe origin");
		return url.origin;
	} catch {
		throw new Error("附件只能上传到当前已打开的 HTTP(S) 页面");
	}
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
	snapshot(options: AgentBrowserSnapshotOptions): Promise<string>;
	click(target: AgentBrowserTarget): Promise<string>;
	hover(target: AgentBrowserTarget): Promise<string>;
	type(target: AgentBrowserTarget, value: string, pressEnter: boolean, commit: boolean): Promise<string>;
	scroll(direction: "up" | "down" | "left" | "right", amount: number): Promise<string>;
	extract(selector: string | undefined, maxChars: number): Promise<string>;
	screenshot(path: string): Promise<string>;
	wait(milliseconds: number, text?: string): Promise<string>;
	/** allowedOrigin is mandatory and must have been captured before reading local file bytes. */
	uploadFiles(
		files: AgentBrowserUploadFile[],
		target: AgentBrowserTarget | undefined,
		allowedOrigin: string,
	): Promise<string>;
	/** Main-process-only typed EasyBao page contract. Never add this method to public Agent tools or preload IPC. */
	runEkuaibaoTrustedCommand?(command: EkuaibaoTrustedCommand): Promise<EkuaibaoTrustedResult>;
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
