import { describe, expect, it } from "vitest";
import { isOfficePreviewPath, parseOfficePreviewPort } from "../src/office-preview.ts";

describe("OfficeCLI 实时预览", () => {
	it("只接收 OfficeCLI watch 支持的文件", () => {
		expect(isOfficePreviewPath("报告.DOCX")).toBe(true);
		expect(isOfficePreviewPath("数据.xlsx")).toBe(true);
		expect(isOfficePreviewPath("演示.pptx")).toBe(true);
		expect(isOfficePreviewPath("附件.pdf")).toBe(false);
	});

	it("从官方 watch 输出解析随机端口", () => {
		expect(parseOfficePreviewPort("Watch: http://localhost:14128\nWatching: C:\\报告.docx")).toBe(14128);
		expect(parseOfficePreviewPort("Watch: http://127.0.0.1:26315")).toBe(26315);
		expect(parseOfficePreviewPort("Watching: report.docx")).toBeNull();
	});
});
