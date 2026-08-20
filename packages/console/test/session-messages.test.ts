import { describe, expect, it } from "vitest";
import { appendAttachmentAnnotation, parseUserMessage } from "../src/session-messages.ts";

describe("会话附件历史", () => {
	it("使用 JSON 标记保存并恢复包含逗号的文件名", () => {
		const stored = appendAttachmentAnnotation("请分析这些文件", ["uploads/收入,成本.xlsx", "uploads/报告.docx"]);
		expect(parseUserMessage(stored)).toEqual({
			text: "请分析这些文件",
			attachments: ["uploads/收入,成本.xlsx", "uploads/报告.docx"],
		});
	});

	it("只有附件时仍可恢复，并兼容旧版标记", () => {
		expect(parseUserMessage(appendAttachmentAnnotation("", ["uploads/图片.png"]))).toEqual({
			text: "",
			attachments: ["uploads/图片.png"],
		});
		expect(parseUserMessage("旧消息\n[附件: uploads/a.docx, uploads/b.xlsx]")).toEqual({
			text: "旧消息",
			attachments: ["uploads/a.docx", "uploads/b.xlsx"],
		});
	});
});
