export const EKUAIBAO_DANGEROUS_ATTRIBUTE_PATTERN =
	"flexable[\\s_-]*button[\\s_-]*(?:submit|delete|destroy)|(?:^|[^a-z0-9])(?:submit|send[\\s_-]?review|delete[\\s_-]?(?:bill|document|application|expense|detail|row)|destroy[\\s_-]?(?:bill|document|application|expense|detail|row)|invalidate|void|revoke)(?:$|[^a-z0-9])";

export const EKUAIBAO_DANGEROUS_LABEL_PATTERN =
	"提交(?!人|日期|时间|状态)|送审|删除(?:单据|报销单|申请|费用明细|明细(?:行)?|行)|(?:单据|报销单|申请|费用明细|明细(?:行)?).{0,8}删除|作废|撤销(?:申请|单据|报销单)?";
export const EKUAIBAO_DESTRUCTIVE_ATTRIBUTE_PATTERN =
	"(?:^|[^a-z0-9])(?:delete|remove|clear|trash|discard|destroy|unlink)(?:$|[^a-z0-9])";
export const EKUAIBAO_DESTRUCTIVE_LABEL_PATTERN = "删除|移除|清除|清空|移出|解绑";
export const EKUAIBAO_ATTACHMENT_ACTION_PATTERN =
	"附件|发票|(?:^|[^a-z0-9])(?:attachment|invoice|upload(?:ed)?|file)s?(?:$|[^a-z0-9])";
export const EKUAIBAO_ATTACHMENT_CONTEXT_PATTERN =
	"附件|上传(?:文件)?|已选文件|\\.(?:pdf|png|jpe?g|ofd|docx?|xlsx?)(?:$|[^a-z0-9])|(?:^|[^a-z0-9])(?:attachment|upload(?:ed)?|file)s?(?:$|[^a-z0-9])";
export const EKUAIBAO_ROW_CONTEXT_PATTERN =
	"费用明细|明细行|(?:^|[^a-z0-9])(?:(?:expense|detail)[\\s_-]*row|row[\\s_-]*(?:expense|detail))(?:$|[^a-z0-9])";
export const EKUAIBAO_DRAFT_ATTRIBUTE_PATTERN = "(?:^|\\s)flexable-button-edit(?:$|\\s)";
export const EKUAIBAO_DRAFT_LABEL_PATTERN = "^(?:存为草稿|保存草稿)$";

export interface BrowserClickSafetySignal {
	hostname: string;
	label: string;
	attributeSignal: string;
	/** Nearby, attachment-specific container attributes/text; never use the whole page as context. */
	contextSignal?: string;
	tagName?: string;
	inputType?: string;
}

export interface BrowserClickSafetyDecision {
	allowed: boolean;
	kind: "external" | "neutral" | "draft" | "blocked";
	reason?: string;
}

function tokenizeAttributeSignal(value: string): string {
	return value
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
		.replace(/[^a-z0-9\u4e00-\u9fff]+/gi, " ")
		.trim();
}

/**
 * This is the source-of-truth policy used by the Electron page bridge. Keep it
 * data-only so the exact regex sources can also be injected into the renderer.
 */
export function classifyBrowserClick(signal: BrowserClickSafetySignal): BrowserClickSafetyDecision {
	if (!/(^|\.)ekuaibao\.com$/i.test(signal.hostname.trim())) return { allowed: true, kind: "external" };

	const label = signal.label.replace(/\s+/g, " ").trim();
	const attributes = signal.attributeSignal.replace(/\s+/g, " ").trim();
	const context = signal.contextSignal?.replace(/\s+/g, " ").trim() ?? "";
	const attributeTokens = tokenizeAttributeSignal(attributes);
	const dangerousAttributePattern = new RegExp(EKUAIBAO_DANGEROUS_ATTRIBUTE_PATTERN, "i");
	const dangerousAttribute =
		dangerousAttributePattern.test(attributes) || dangerousAttributePattern.test(attributeTokens);
	const dangerousLabel = new RegExp(EKUAIBAO_DANGEROUS_LABEL_PATTERN).test(label);
	if (dangerousAttribute || dangerousLabel) {
		return {
			allowed: false,
			kind: "blocked",
			reason: "安全策略已阻止易快报的提交、送审、删除单据、作废或撤销操作；差旅插件只允许保存草稿",
		};
	}

	const draftAttribute = new RegExp(EKUAIBAO_DRAFT_ATTRIBUTE_PATTERN, "i").test(` ${attributes} `);
	const draftLabel = new RegExp(EKUAIBAO_DRAFT_LABEL_PATTERN).test(label);
	const draft = draftAttribute || draftLabel;
	const submitControl =
		/^(?:INPUT|BUTTON)$/i.test(signal.tagName ?? "") && /^(?:submit|image)$/i.test(signal.inputType ?? "");
	if (submitControl && !draft) {
		return {
			allowed: false,
			kind: "blocked",
			reason: "安全策略已阻止易快报的非草稿提交控件；差旅插件只允许精确的保存草稿按钮",
		};
	}

	const destructive =
		new RegExp(EKUAIBAO_DESTRUCTIVE_ATTRIBUTE_PATTERN, "i").test(attributeTokens) ||
		new RegExp(EKUAIBAO_DESTRUCTIVE_LABEL_PATTERN).test(label);
	if (destructive) {
		const attachmentActionSignal = `${label} ${attributes}`;
		const attachmentActionPattern = new RegExp(EKUAIBAO_ATTACHMENT_ACTION_PATTERN, "i");
		const explicitAttachmentAction =
			attachmentActionPattern.test(attachmentActionSignal) ||
			attachmentActionPattern.test(tokenizeAttributeSignal(attachmentActionSignal));
		const attachmentContextPattern = new RegExp(EKUAIBAO_ATTACHMENT_CONTEXT_PATTERN, "i");
		const attachmentContainer =
			attachmentContextPattern.test(context) || attachmentContextPattern.test(tokenizeAttributeSignal(context));
		const rowContextPattern = new RegExp(EKUAIBAO_ROW_CONTEXT_PATTERN, "i");
		const destructiveRow =
			rowContextPattern.test(context) || rowContextPattern.test(tokenizeAttributeSignal(context));
		if (destructiveRow && !explicitAttachmentAction) {
			return {
				allowed: false,
				kind: "blocked",
				reason: "安全策略已阻止易快报费用明细行的删除操作",
			};
		}
		if (!explicitAttachmentAction && !attachmentContainer) {
			return {
				allowed: false,
				kind: "blocked",
				reason: "安全策略已阻止易快报中没有明确附件上下文的删除或移除操作",
			};
		}
	}

	return { allowed: true, kind: draft ? "draft" : "neutral" };
}
