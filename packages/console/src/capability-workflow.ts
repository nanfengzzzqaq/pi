const TRAVEL_CANCEL_PATTERN =
	/^(?:取消|停止|结束|不用了|别填了|放弃)(?:这次|当前)?(?:差旅|出差|报销|填报|操作)?[。！!]?$/;
const DRAFT_SAVE_PATTERN = /(?:存为草稿|保存草稿|flexable-button-edit)/;
const DRAFT_SAVE_CONFIRMATION_PATTERN = /(?:保存成功|草稿保存成功|已存为草稿|已保存为草稿)/;

export function isTravelWorkflowCancellation(text: string): boolean {
	return TRAVEL_CANCEL_PATTERN.test(text.replace(/\s+/g, "").trim());
}

export function isTravelDraftSaveClick(toolName: string, args: unknown): boolean {
	if (toolName !== "browser_click") return false;
	let serialized = "";
	try {
		serialized = JSON.stringify(args) ?? "";
	} catch {
		return false;
	}
	return DRAFT_SAVE_PATTERN.test(serialized);
}

export function hasTravelDraftSaveConfirmation(result: unknown): boolean {
	let serialized = "";
	try {
		serialized = typeof result === "string" ? result : (JSON.stringify(result) ?? "");
	} catch {
		return false;
	}
	return DRAFT_SAVE_CONFIRMATION_PATTERN.test(serialized);
}
