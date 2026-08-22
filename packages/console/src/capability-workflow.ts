const TRAVEL_CANCEL_PATTERN =
	/^(?:(?:取消|结束|放弃)(?:这次|当前)?(?:差旅|出差|报销|填报|操作)?(?:吧|了)?|(?:先)?(?:停|停止)(?:一下)?(?:这次|当前)?(?:差旅|出差|报销|填报|操作)?(?:流程)?(?:吧|了)?|算了(?:吧)?|不用了|(?:不要|不用|别)(?:再)?(?:(?:继续)(?:填|填报|报销|报|做)?|填|填报|报销|报|做)(?:这次|当前)?(?:差旅|出差|报销)?(?:了|啦|吧)?)[。！!]?$/;
const TRAVEL_NEGATED_DRAFT_PATTERN =
	/(?:不想|不需要|无需|不用|不要|别|暂不|先不|先不要)(?:再)?(?:(?:继续|开始|做|办理|进行|帮我|替我|自动(?:化)?|填|填写|填报)){0,2}(?:这次|当前)?(?:差旅|出差|费用)?报销/;
const DRAFT_SAVE_PATTERN = /(?:存为草稿|保存草稿|flexable-button-edit)/;
const DRAFT_SAVE_CONFIRMATION_PATTERN = /(?:保存成功|草稿保存成功|已存为草稿|已保存为草稿)/;
const DRAFT_SAVE_NEGATION_PATTERN =
	/(?:未|没有|尚未|无法|不能|失败|缺少|等待|找不到).{0,16}(?:保存成功|草稿保存成功|已存为草稿|已保存为草稿)/;
const DRAFT_SAVE_POST_NEGATION_PATTERN =
	/(?:保存成功|草稿保存成功|已存为草稿|已保存为草稿)(?:的)?(?:提示|文案|标志|状态|消息)?(?:未出现|没有出现|未找到|没有找到|未看到|没有看到|未检测到|没有检测到)/;
const TRAVEL_DRAFT_INTENT_PATTERN =
	/(?:自动(?:化)?(?:填报|报销)|(?:填写|填报|办理|创建|生成|完成|帮我做|帮我)(?:这次|当前|一份|一下)?(?:差旅|出差|费用)?报销|(?:差旅|出差|费用)?报销(?:单)?(?:自动填写|自动填报|填写|填报|办理|创建|生成)|继续填|接着填|继续报销|接着报销|存为草稿|保存草稿)/;
const TRAVEL_DRAFT_BOUNDED_INTENT_PATTERN =
	/(?:(?:填写|填报|填完|填好|办理|处理|做完|完成|自动).{0,24}(?:差旅|出差|费用)?报销(?:单)?|(?:差旅|出差|费用)?报销(?:单)?.{0,24}(?:填写|填报|填完|填好|办理|处理|做完|完成|自动))/;
const TRAVEL_DRAFT_DIRECT_REQUEST_PATTERN =
	/(?:(?:帮我|替我|请|我要|给我|开始|现在).{0,24}(?:报销|存为草稿|保存草稿)|(?:用这些票|把.{0,24}(?:报销|票)).{0,24}(?:填|做|办|报销)|(?:按|根据).{0,12}(?:流程|要求|规则).{0,12}(?:填写|填报|办理|报销)|(?:报销|填报)(?:这趟出差|这些票|一下|吧|了))/;
const TRAVEL_QUERY_INTENT_PATTERN =
	/(?:怎么|如何|怎样|为什么|什么|啥|作用|功能|含义|能否|可以吗|是否|有没有问题|说明|介绍|解释|告诉|教我|需要什么|有哪些|看看|查看|查询|检查|核对|确认|分析|解析|读取|已完成)/;
const TRAVEL_INFORMATION_NOUN_PATTERN = /(?:规则|教程|流程|步骤|方法|示例|要求)/;
const TRAVEL_STATUS_QUERY_PATTERN = /(?:吗|没|没有|情况|状态|进度)(?:啊|呀|呢)?[？?]?$/;
const TRAVEL_COMPLETED_STATEMENT_PATTERN =
	/(?:(?:^我(?:刚|刚刚|已经|已)|刚|刚刚|已经|已).{0,12}(?:完成|填好|填完|填写完成|办理完成).{0,12}(?:差旅|出差|报销)|(?:^我(?:刚|刚刚|已经|已)|刚|刚刚|已经|已).{0,16}(?:差旅|出差|报销).{0,12}(?:完成|填好|填完|填写完成|办理完成)|(?:我的)?(?:差旅|出差|报销).{0,12}(?:刚|刚刚|已经|已).{0,8}(?:完成|填好|填完|填写完成|办理完成))/;
const TRAVEL_FORM_EXECUTION_PATTERN =
	/(?:易快报|合思|差旅单|出差费用|差旅费用).{0,24}(?:填单|填一下|填写|填报|填完|填好|办理|做完|完成)/;
const TRAVEL_EXPENSE_CONTEXT_PATTERN =
	/(?:差旅|出差|报销|易快报|合思|火车票|高铁票|铁路电子客票|住宿费|出差补助|差旅补助)/;
const TRAVEL_MIXED_EXECUTION_PATTERN =
	/(?:然后|再|随后|并且|没问题就)(?!.{0,36}(?:告诉|说明|解释|教|怎么|如何)).{0,36}(?:填好|填完|填报|办理|做完|完成|开始报销|帮我报销|替我报销|(?:直接)?报销(?:一下|吧)?|保存草稿|存为草稿)/;
export const TRAVEL_DRAFT_WORKFLOW_TOOL = "travel_fill_draft";

/**
 * APIs for which SimpleStreamOptions.toolChoice="required" is mapped to a
 * provider-native request field. DeepSeek and local OpenAI-compatible models
 * use openai-completions. Other APIs stay on their default behavior rather
 * than receiving an invalid value.
 */
const REQUIRED_TOOL_CHOICE_APIS = new Set(["openai-completions"]);

export function requiredTravelWorkflowToolChoice(
	api: string | undefined,
	activeToolNames: readonly string[],
): "required" | undefined {
	return api &&
		REQUIRED_TOOL_CHOICE_APIS.has(api) &&
		activeToolNames.length === 1 &&
		activeToolNames[0] === TRAVEL_DRAFT_WORKFLOW_TOOL
		? "required"
		: undefined;
}

export function travelWorkflowPromptToolChoice(
	api: string | undefined,
	activeToolNames: readonly string[],
):
	| {
			toolChoice: "required";
			toolChoiceAfterToolResult: { success: "none"; error: "required" };
	  }
	| Record<string, never> {
	if (!requiredTravelWorkflowToolChoice(api, activeToolNames)) return {};
	return {
		toolChoice: "required",
		toolChoiceAfterToolResult: { success: "none", error: "required" },
	};
}

export function isTravelWorkflowCancellation(text: string): boolean {
	const normalized = text.replace(/\s+/g, "").trim();
	return TRAVEL_CANCEL_PATTERN.test(normalized) || TRAVEL_NEGATED_DRAFT_PATTERN.test(normalized);
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
	return (
		!DRAFT_SAVE_NEGATION_PATTERN.test(serialized) &&
		!DRAFT_SAVE_POST_NEGATION_PATTERN.test(serialized) &&
		DRAFT_SAVE_CONFIRMATION_PATTERN.test(serialized)
	);
}

/** Only explicit form-filling intent may activate the mutating reimbursement workflow. */
export function isTravelDraftWorkflowIntent(text: string): boolean {
	const normalized = text.replace(/\s+/g, "").trim();
	if (!/(?:差旅|出差|报销|易快报|合思)/.test(normalized)) return false;
	// 否定执行优先级高于历史工作流 pin 和任何“自动报销”关键词。宁可保持只读，
	// 也不能在已有链接/附件的会话里复用旧参数继续修改页面。
	if (TRAVEL_CANCEL_PATTERN.test(normalized) || TRAVEL_NEGATED_DRAFT_PATTERN.test(normalized)) return false;
	const directRequest = TRAVEL_DRAFT_DIRECT_REQUEST_PATTERN.test(normalized);
	// 明确的查询/讲解/检查保持只读；只有“检查后再填好”这种独立执行子句才放行，
	// 避免一句“请告诉我如何填写”因礼貌词“请”误触发网页变更。
	const mixedExecution = TRAVEL_MIXED_EXECUTION_PATTERN.test(normalized);
	if (TRAVEL_STATUS_QUERY_PATTERN.test(normalized) || TRAVEL_COMPLETED_STATEMENT_PATTERN.test(normalized))
		return false;
	if (TRAVEL_QUERY_INTENT_PATTERN.test(normalized) && !mixedExecution) return false;
	if (TRAVEL_INFORMATION_NOUN_PATTERN.test(normalized) && !directRequest && !mixedExecution) return false;
	return (
		mixedExecution ||
		directRequest ||
		TRAVEL_FORM_EXECUTION_PATTERN.test(normalized) ||
		TRAVEL_DRAFT_INTENT_PATTERN.test(normalized) ||
		TRAVEL_DRAFT_BOUNDED_INTENT_PATTERN.test(normalized)
	);
}

export function isTravelExpenseContext(text: string): boolean {
	return TRAVEL_EXPENSE_CONTEXT_PATTERN.test(text.replace(/\s+/g, "").trim());
}

/**
 * The deterministic workflow replaces hundreds of model-directed browser calls.
 * When it is installed, expose only that one business action for reimbursement
 * turns; legacy helpers remain available for explicit diagnostics outside the
 * active workflow.
 */
export function prioritizeTravelWorkflowTools(toolNames: string[]): string[] {
	return toolNames.includes(TRAVEL_DRAFT_WORKFLOW_TOOL) ? [TRAVEL_DRAFT_WORKFLOW_TOOL] : [...toolNames];
}

/**
 * A matched travel pack owns the whole reimbursement turn. Read-only requests
 * keep its inspect tools; mutating or pinned turns expose only the deterministic
 * workflow and never generic browser mutation tools.
 */
export function routeTravelCapabilityMatches<T extends { packName: string; toolNames: string[] }>(
	matches: T[],
	text: string,
	forceWorkflow = false,
): T[] {
	const travelMatched = matches.some((match) => match.packName === "travel-expense");
	if (!forceWorkflow && (!travelMatched || !isTravelExpenseContext(text))) return matches;
	const owned = matches.filter((match) => match.packName !== "agent-browser");
	if (!forceWorkflow && !isTravelDraftWorkflowIntent(text)) return owned;
	return owned.map((match) =>
		match.packName === "travel-expense"
			? { ...match, toolNames: prioritizeTravelWorkflowTools([...match.toolNames, TRAVEL_DRAFT_WORKFLOW_TOOL]) }
			: match,
	);
}

export function isTravelDraftWorkflowCompletion(toolName: string, result: unknown): boolean {
	if (toolName !== TRAVEL_DRAFT_WORKFLOW_TOOL || !result || typeof result !== "object") return false;
	const details = (result as { details?: unknown }).details;
	if (!details || typeof details !== "object") return false;
	const completion = details as { status?: unknown; stage?: unknown; draftSaved?: unknown };
	return completion.status === "done" && completion.stage === "DONE" && completion.draftSaved === true;
}
