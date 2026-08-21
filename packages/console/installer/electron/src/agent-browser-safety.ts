export const EKUAIBAO_DANGEROUS_ATTRIBUTE_PATTERN =
	"flexable-button-(?:submit|delete|destroy)|(?:^|[^a-z0-9])(?:submit|delete|remove|destroy|discard|invalidate|void|revoke)(?:$|[^a-z0-9])";

export const EKUAIBAO_DANGEROUS_LABEL_PATTERN = "提交(?!人|日期|时间|状态)|送审|删除|作废|撤销";
export const EKUAIBAO_DRAFT_ATTRIBUTE_PATTERN = "(?:^|[\\s_-])flexable-button-edit(?:$|[\\s_-])";
export const EKUAIBAO_DRAFT_LABEL_PATTERN = "^(?:存为草稿|保存草稿)$";

export interface BrowserClickSafetySignal {
	hostname: string;
	label: string;
	attributeSignal: string;
	tagName?: string;
	inputType?: string;
}

export interface BrowserClickSafetyDecision {
	allowed: boolean;
	kind: "external" | "neutral" | "draft" | "blocked";
	reason?: string;
}

/**
 * This is the source-of-truth policy used by the Electron page bridge. Keep it
 * data-only so the exact regex sources can also be injected into the renderer.
 */
export function classifyBrowserClick(signal: BrowserClickSafetySignal): BrowserClickSafetyDecision {
	if (!/(^|\.)ekuaibao\.com$/i.test(signal.hostname.trim())) return { allowed: true, kind: "external" };

	const label = signal.label.replace(/\s+/g, " ").trim();
	const attributes = signal.attributeSignal.replace(/\s+/g, " ").trim();
	const dangerousAttribute = new RegExp(EKUAIBAO_DANGEROUS_ATTRIBUTE_PATTERN, "i").test(attributes);
	const dangerousControl =
		/^(?:INPUT|BUTTON)$/i.test(signal.tagName ?? "") && /^submit$/i.test(signal.inputType ?? "");
	const dangerousLabel = new RegExp(EKUAIBAO_DANGEROUS_LABEL_PATTERN).test(label);
	if (dangerousAttribute || dangerousControl || dangerousLabel) {
		return {
			allowed: false,
			kind: "blocked",
			reason: "安全策略已阻止易快报的提交、删除、作废或撤销操作；差旅插件只允许保存草稿",
		};
	}

	const draftAttribute = new RegExp(EKUAIBAO_DRAFT_ATTRIBUTE_PATTERN, "i").test(` ${attributes} `);
	const draftLabel = new RegExp(EKUAIBAO_DRAFT_LABEL_PATTERN).test(label);
	return { allowed: true, kind: draftAttribute || draftLabel ? "draft" : "neutral" };
}
