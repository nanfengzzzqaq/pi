import { beforeAll, describe, expect, it } from "vitest";
import {
	hasTravelDraftSaveConfirmation,
	isTravelDraftSaveClick,
	isTravelDraftWorkflowCompletion,
	isTravelDraftWorkflowIntent,
	isTravelExpenseContext,
	isTravelWorkflowCancellation,
	prioritizeTravelWorkflowTools,
	requiredTravelWorkflowToolChoice,
	routeTravelCapabilityMatches,
	travelWorkflowPromptToolChoice,
} from "../src/capability-workflow.ts";
import { baseToolNames, loadPacks, selectCapabilities, toolDisplayName } from "../src/packs.ts";

describe("按本轮选择能力", () => {
	beforeAll(async () => {
		await loadPacks();
	});

	it("普通问候不注入 Office 工具", () => {
		const tools = baseToolNames(["office-assistant"]);
		expect(tools).toEqual(expect.arrayContaining(["read", "edit", "write"]));
		if (process.platform === "win32") expect(tools).toContain("powershell");
		expect(selectCapabilities("你好", ["office-assistant"])).toEqual([]);
	});

	it("查看表格只加载读取分组", () => {
		const [match] = selectCapabilities("请查看 uploads/report.xlsx 的内容", ["office-assistant"]);
		expect(match?.groupNames).toEqual(["inspect"]);
		expect(match?.toolNames).toEqual(["office_view", "office_get", "office_query", "office_help"]);
	});

	it("修改文档只加载编辑分组", () => {
		const [match] = selectCapabilities("请修改 uploads/report.docx 的标题", ["office-assistant"]);
		expect(match?.groupNames).toEqual(["edit"]);
		expect(match?.toolNames).toContain("office_set");
		expect(match?.toolNames).not.toContain("office_create");
	});

	it("网页任务只加载客户端浏览器所需分组", () => {
		expect(baseToolNames(["agent-browser"])).not.toContain("browser_navigate");
		const [navigate] = selectCapabilities("请打开 https://example.com", ["agent-browser"]);
		expect(navigate?.groupNames).toEqual(["navigate"]);
		expect(navigate?.toolNames).toEqual(["browser_navigate", "browser_snapshot", "browser_wait"]);

		const [interact] = selectCapabilities("请在这个网站登录并填写表单", ["agent-browser"]);
		expect(interact?.groupNames).toEqual(["navigate", "interact"]);
		expect(interact?.toolNames).toContain("browser_type");
		expect(interact?.toolNames).toContain("browser_click");
		expect(interact?.toolNames).toContain("browser_hover");
	});

	it("差旅续作和纯附件消息仍保留完整浏览器交互工具", () => {
		const [continuation] = selectCapabilities("继续填，最后保存草稿", ["agent-browser"]);
		expect(continuation?.groupNames).toContain("interact");
		expect(continuation?.toolNames).toEqual(
			expect.arrayContaining(["browser_click", "browser_type", "browser_upload"]),
		);

		const [attachment] = selectCapabilities("C:/tickets/常州往返.ofd", ["agent-browser"]);
		expect(attachment?.groupNames).toEqual(["interact"]);
		expect(attachment?.toolNames).toContain("browser_upload");

		const [travel] = selectCapabilities("接着保存草稿", ["travel-expense"]);
		expect(travel?.groupNames).toEqual(["reimburse"]);
		expect(travel?.toolNames).toEqual(["travel_fill_draft"]);

		const [rules] = selectCapabilities("差旅报销规则是什么", ["travel-expense"]);
		expect(rules?.groupNames).toEqual(["inspect"]);
		expect(rules?.toolNames).toEqual(
			expect.arrayContaining(["travel_read_invoices", "travel_reimbursement_guide", "travel_plan_details"]),
		);

		const [screenshot] = selectCapabilities("C:/tickets/火车票查验.png", ["travel-expense"]);
		expect(screenshot?.groupNames).toEqual(["inspect"]);
		expect(screenshot?.toolNames).toContain("travel_read_invoices");
	});

	it("差旅工作流仅在草稿保存成功或用户明确取消时解除", () => {
		expect(isTravelDraftSaveClick("browser_click", { text: "存为草稿" })).toBe(true);
		expect(isTravelDraftSaveClick("browser_click", { selector: '[data-testid="flexable-button-edit"]' })).toBe(true);
		expect(isTravelDraftSaveClick("browser_click", { text: "提交送审" })).toBe(false);
		expect(isTravelDraftSaveClick("browser_type", { text: "保存草稿" })).toBe(false);
		expect(
			hasTravelDraftSaveConfirmation({ content: [{ type: "text", text: "已点击草稿保存按钮：存为草稿" }] }),
		).toBe(false);
		expect(hasTravelDraftSaveConfirmation({ content: [{ type: "text", text: "保存成功" }] })).toBe(true);
		expect(hasTravelDraftSaveConfirmation("校验失败，尚未保存")).toBe(false);
		expect(hasTravelDraftSaveConfirmation("草稿保存成功提示未出现")).toBe(false);
		expect(
			prioritizeTravelWorkflowTools(["travel_read_invoices", "travel_fill_draft", "travel_plan_details"]),
		).toEqual(["travel_fill_draft"]);
		expect(
			isTravelDraftWorkflowCompletion("travel_fill_draft", {
				content: [{ type: "text", text: "草稿保存成功" }],
				details: { status: "done", stage: "DONE", draftSaved: true },
			}),
		).toBe(true);
		expect(
			isTravelDraftWorkflowCompletion("travel_fill_draft", {
				content: [{ type: "text", text: "未出现草稿保存成功文案" }],
				details: { status: "blocked", stage: "CONFIRM", draftSaved: false },
			}),
		).toBe(false);
		expect(isTravelDraftWorkflowCompletion("browser_wait", "草稿保存成功")).toBe(false);
		expect(isTravelDraftWorkflowIntent("请自动填报这次差旅报销，只保存草稿")).toBe(true);
		for (const instruction of [
			"帮我把常州这趟差旅报销填完",
			"把8月21日常州的报销做完",
			"用这些票把报销单填好",
			"我要报销这趟出差",
			"请报销这些票",
			"替我报销这些票",
			"开始报销",
			"报销一下",
			"检查这些票据，然后把差旅报销填好",
			"先解析发票，再帮我报销",
			"按流程帮我报销",
			"根据要求填写差旅报销",
			"先检查报销单，没问题就报销",
			"把易快报的单子填完",
			"帮我自动完成易快报填单",
			"在合思里把差旅单填完",
			"帮我把这次出差费用填一下",
			"我要把这次差旅报销填完",
			"我要完成差旅报销",
			"我想把差旅报销填好",
			"我需要把报销单填完",
		]) {
			expect(isTravelDraftWorkflowIntent(instruction)).toBe(true);
		}
		for (const query of [
			"差旅报销规则是什么",
			"自动报销是什么？",
			"自动报销有啥作用",
			"差旅自动报销功能介绍",
			"自动报销的含义",
			"差旅报销单怎么填写",
			"如何办理差旅报销",
			"查询已完成的差旅报销",
			"报销填写规则",
			"请告诉我如何填写差旅报销",
			"帮我说明一下差旅报销流程",
			"请检查报销单",
			"帮我查看已完成的报销",
			"帮我看看这个报销单有没有问题",
			"帮我核对一下报销金额",
			"请确认报销单是否正确",
			"请介绍差旅报销步骤",
			"告诉我报销方法和示例",
			"检查票据，然后告诉我如何填好差旅报销",
			"报销单填好了吗",
			"这个报销单填完没有",
			"报销单完成情况",
			"我刚完成差旅报销",
			"报销单已经填写完成了吗",
			"我刚把差旅报销填完",
			"我已经把报销单填好了",
			"我的报销单刚填完",
			"报销单刚办理完成",
			"报销单填完没",
			"报销单填好了没有啊",
			"只解析这些火车票 PDF",
			"检查一下这些报销发票",
		]) {
			expect(isTravelDraftWorkflowIntent(query)).toBe(false);
		}
		for (const unrelatedContinuation of ["保存草稿", "存为草稿", "继续填", "接着填"]) {
			expect(isTravelDraftWorkflowIntent(unrelatedContinuation)).toBe(false);
		}
		for (const cancellation of [
			"取消这次报销",
			"取消这次报销吧",
			"取消吧",
			"算了",
			"不用了",
			"不要继续了",
			"别报了",
			"不用继续填了",
			"别再继续填了",
			"停止报销流程",
			"先停一下",
			"我不想自动报销了",
			"我不需要自动报销",
			"无需再自动报销",
			"先不要帮我报销",
			"暂不进行差旅报销",
		]) {
			expect(isTravelWorkflowCancellation(cancellation)).toBe(true);
			expect(isTravelDraftWorkflowIntent(cancellation)).toBe(false);
		}
		for (const continuation of ["好了", "可以", "确认", "同意", "开始吧"]) {
			expect(isTravelWorkflowCancellation(continuation)).toBe(false);
		}
	});

	it("差旅能力独占报销轮次并按读写意图收敛工具", () => {
		expect(isTravelExpenseContext("火车票查验截图")).toBe(true);
		expect(isTravelExpenseContext("普通网页截图")).toBe(false);
		const readOnly = routeTravelCapabilityMatches(
			selectCapabilities("差旅报销规则是什么", ["travel-expense", "agent-browser"]),
			"差旅报销规则是什么",
		);
		expect(readOnly.map((match) => match.packName)).toEqual(["travel-expense"]);
		expect(readOnly[0].toolNames).toContain("travel_reimbursement_guide");
		expect(readOnly[0].toolNames).not.toContain("travel_fill_draft");

		const fill = routeTravelCapabilityMatches(
			selectCapabilities("帮我把常州这趟差旅报销填完", ["travel-expense", "agent-browser"]),
			"帮我把常州这趟差旅报销填完",
		);
		expect(fill.map((match) => match.packName)).toEqual(["travel-expense"]);
		expect(fill[0].toolNames).toEqual(["travel_fill_draft"]);

		const pinnedAttachment = routeTravelCapabilityMatches(
			selectCapabilities("C:/tickets/查验截图.jpg", ["travel-expense", "agent-browser"]),
			"C:/tickets/查验截图.jpg",
			true,
		);
		expect(pinnedAttachment.map((match) => match.packName)).toEqual(["travel-expense"]);
		expect(pinnedAttachment[0].toolNames).toEqual(["travel_fill_draft"]);

		const ordinaryImage = routeTravelCapabilityMatches(
			selectCapabilities("请在网页上传 C:/images/photo.png", ["travel-expense", "agent-browser"]),
			"请在网页上传 C:/images/photo.png",
		);
		expect(ordinaryImage.map((match) => match.packName)).toContain("agent-browser");
	});

	it("仅为 DeepSeek/OpenAI-compatible 的唯一差旅工具请求 required", () => {
		expect(requiredTravelWorkflowToolChoice("openai-completions", ["travel_fill_draft"])).toBe("required");
		expect(requiredTravelWorkflowToolChoice("anthropic-messages", ["travel_fill_draft"])).toBeUndefined();
		expect(requiredTravelWorkflowToolChoice("openai-completions", ["travel_read_invoices"])).toBeUndefined();
		expect(
			requiredTravelWorkflowToolChoice("openai-completions", ["travel_fill_draft", "browser_click"]),
		).toBeUndefined();
		expect(travelWorkflowPromptToolChoice("openai-completions", ["travel_fill_draft"])).toEqual({
			toolChoice: "required",
			toolChoiceAfterToolResult: { success: "none", error: "required" },
		});
		expect(travelWorkflowPromptToolChoice("anthropic-messages", ["travel_fill_draft"])).toEqual({});
	});

	it("代码任务只加载相应的代码开发分组", () => {
		expect(selectCapabilities("你好", ["code-development"])).toEqual([]);
		const [inspect] = selectCapabilities("检查这个 TypeScript 项目的代码差异", ["code-development"]);
		expect(inspect?.groupNames).toContain("inspect");
		expect(inspect?.toolNames).toContain("git_diff");

		const [github] = selectCapabilities("把当前分支推送到 GitHub 并创建 PR", ["code-development"]);
		expect(github?.groupNames).toEqual(expect.arrayContaining(["change", "github"]));
		expect(github?.toolNames).toContain("github_pull_request");
	});

	it("面向用户显示中文名称和内部代码名", () => {
		expect(toolDisplayName("office_view")).toBe("查看文档（office_view）");
		expect(toolDisplayName("read")).toBe("读取文件（read）");
		expect(toolDisplayName("bash")).toBe("运行 Bash 命令（bash）");
		expect(toolDisplayName("powershell")).toBe("运行 Windows 命令（powershell）");
		expect(toolDisplayName("browser_snapshot")).toBe("获取页面状态（browser_snapshot）");
	});
});
