import { beforeAll, describe, expect, it } from "vitest";
import {
	hasTravelDraftSaveConfirmation,
	isTravelDraftSaveClick,
	isTravelWorkflowCancellation,
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
		expect(travel?.toolNames).toEqual(
			expect.arrayContaining(["travel_read_invoices", "travel_reimbursement_guide", "travel_plan_details"]),
		);
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
		expect(isTravelWorkflowCancellation("取消这次报销")).toBe(true);
		expect(isTravelWorkflowCancellation("不用了")).toBe(true);
		for (const continuation of ["好了", "可以", "确认", "同意", "开始吧"]) {
			expect(isTravelWorkflowCancellation(continuation)).toBe(false);
		}
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
