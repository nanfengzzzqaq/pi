import { describe, expect, it } from "vitest";
import { extractFileReferences } from "../src/artifacts.ts";

describe("对话文件引用", () => {
	it("提取 Markdown、Windows、相对路径和单文件名", () => {
		const text = [
			"[下载报告](reports/季度报告.docx)",
			"文件位于 C:\\工作区\\输出\\数据表.xlsx。",
			"也可以查看 ./exports/slides.pptx 或 result.pdf。",
		].join("\n");
		expect(extractFileReferences(text)).toEqual([
			"reports/季度报告.docx",
			"C:\\工作区\\输出\\数据表.xlsx",
			"./exports/slides.pptx",
			"result.pdf",
		]);
	});

	it("忽略网页链接并去重", () => {
		const text = "[官网](https://example.com/docs) https://example.com/a.pdf report.pdf report.pdf";
		expect(extractFileReferences(text)).toEqual(["report.pdf"]);
	});
});
