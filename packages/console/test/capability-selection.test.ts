import { beforeAll, describe, expect, it } from "vitest";
import { baseToolNames, loadPacks, selectCapabilities, toolDisplayName } from "../src/packs.ts";

describe("按本轮选择能力", () => {
	beforeAll(async () => {
		await loadPacks();
	});

	it("普通问候不注入 Office 工具", () => {
		const tools = baseToolNames(["office-assistant"]);
		expect(tools).toEqual(expect.arrayContaining(["read", "edit", "write", "grep", "find", "ls"]));
		expect(tools).not.toContain("powershell");
		expect(selectCapabilities("你好", ["office-assistant"])).toEqual([]);
	});

	it("查看表格只加载读取分组", () => {
		const [match] = selectCapabilities("请查看 uploads/report.xlsx 的内容", ["office-assistant"]);
		expect(match?.groupNames).toEqual(["inspect"]);
		expect(match?.toolNames).toEqual(["office_view", "office_get", "office_query", "office_help"]);
		expect(match?.skillNames).toEqual(["officecli-xlsx"]);
	});

	it("修改文档只加载编辑分组", () => {
		const [match] = selectCapabilities("请修改 uploads/report.docx 的标题", ["office-assistant"]);
		expect(match?.groupNames).toEqual(["edit"]);
		expect(match?.toolNames).toContain("office_set");
		expect(match?.toolNames).not.toContain("office_create");
		expect(match?.skillNames).toEqual(["officecli-docx"]);
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

	it("代码任务只加载相应的代码开发分组", () => {
		expect(selectCapabilities("你好", ["code-development"])).toEqual([]);
		const [inspect] = selectCapabilities("检查这个 TypeScript 项目的代码差异", ["code-development"]);
		expect(inspect?.groupNames).toContain("inspect");
		expect(inspect?.toolNames).toContain("git_diff");

		const [github] = selectCapabilities("把当前分支推送到 GitHub 并创建 PR", ["code-development"]);
		expect(github?.groupNames).toEqual(expect.arrayContaining(["change", "github"]));
		expect(github?.toolNames).toContain("github_pull_request");
		expect(github?.skillNames).toEqual(["code-development-workflow"]);
	});

	it("文件搜索工具常驻基础集，Windows 系统工具只在相应任务中加载", () => {
		expect(baseToolNames([])).toEqual(expect.arrayContaining(["grep", "find", "ls"]));
		expect(selectCapabilities("请在代码里搜索 createAgentSession", [])).toEqual([]);
		expect(selectCapabilities("帮我写一封普通邮件", []).flatMap((match) => match.toolNames)).toEqual([]);

		const windowsTools = selectCapabilities("检查 Windows 系统进程和端口占用", []).flatMap(
			(match) => match.toolNames,
		);
		if (process.platform === "win32") expect(windowsTools).toContain("powershell");
		else expect(windowsTools).not.toContain("powershell");
	});

	it("复杂 Office 场景只选择匹配的 Skill 组合", () => {
		const [pitch] = selectCapabilities("请制作一份融资路演 PPT", ["office-assistant"]);
		expect(pitch?.skillNames).toEqual(["officecli-pptx", "officecli-pitch-deck"]);

		const [dashboard] = selectCapabilities("把数据做成 Excel 数据看板", ["office-assistant"]);
		expect(dashboard?.skillNames).toEqual(["officecli-xlsx", "officecli-data-dashboard"]);
	});

	it("面向用户显示中文名称和内部代码名", () => {
		expect(toolDisplayName("office_view")).toBe("查看文档（office_view）");
		expect(toolDisplayName("read")).toBe("读取文件（read）");
		expect(toolDisplayName("bash")).toBe("运行 Bash 命令（bash）");
		expect(toolDisplayName("powershell")).toBe("运行 Windows 命令（powershell）");
		expect(toolDisplayName("browser_snapshot")).toBe("获取页面状态（browser_snapshot）");
	});

	it("普通联网检索不激活客户端浏览器，明确打开或操作网址才激活", () => {
		expect(selectCapabilities("帮我联网搜索今天的最新新闻", ["agent-browser"])).toEqual([]);
		expect(selectCapabilities("上网搜索网络上的版本信息", ["agent-browser"])).toEqual([]);
		expect(selectCapabilities("搜索网页上的最新资料", ["agent-browser"])).toEqual([]);
		expect(selectCapabilities("找一下这个网站的公开资料和官网链接", ["agent-browser"])).toEqual([]);
		expect(selectCapabilities("请访问相关网页获取最新新闻", ["agent-browser"])).toEqual([]);
		expect(selectCapabilities("检查登录函数为什么报错", ["agent-browser"])).toEqual([]);
		expect(selectCapabilities("分析按钮的点击事件", ["agent-browser"])).toEqual([]);
		expect(selectCapabilities("只分析 https://example.com 字符串，不要打开", ["agent-browser"])).toEqual([]);
		const [directUrl] = selectCapabilities("请打开 https://example.com/report", ["agent-browser"]);
		expect(directUrl?.toolNames).toContain("browser_navigate");
		const [navigate] = selectCapabilities("用浏览器打开 https://example.com/report 并点击下载", ["agent-browser"]);
		expect(navigate?.toolNames).toContain("browser_navigate");
		const [interact] = selectCapabilities("在这个网页里搜索相关内容并点击第一个结果", ["agent-browser"]);
		expect(interact?.toolNames).toContain("browser_click");
	});

	it("web-search 能力包挂载后常驻提供 web_search，不依赖关键词门禁", () => {
		expect(baseToolNames(["web-search"])).toContain("web_search");
		// 无 activation 规则：按本轮选择永远为空，但工具已在会话基础集里。
		expect(selectCapabilities("帮我联网搜索最新新闻", ["web-search"])).toEqual([]);
	});
});
