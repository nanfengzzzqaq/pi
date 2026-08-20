import { beforeAll, describe, expect, it } from "vitest";
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

	it("面向用户显示中文名称和内部代码名", () => {
		expect(toolDisplayName("office_view")).toBe("查看文档（office_view）");
		expect(toolDisplayName("read")).toBe("读取文件（read）");
		expect(toolDisplayName("bash")).toBe("运行 Bash 命令（bash）");
		expect(toolDisplayName("powershell")).toBe("运行 Windows 命令（powershell）");
	});
});
