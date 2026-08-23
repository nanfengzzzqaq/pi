import { describe, expect, it } from "vitest";
import { appendAttachmentAnnotation, extractEkuaibaoTravelUrl, parseUserMessage } from "../src/session-messages.ts";

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

	it("从 Markdown 文本绑定合思 URL，并清理常见转义", () => {
		const text =
			"[打开](https://app.ekuaibao.com/web/app.html?accessToken=pi-browser-secret-fixture\\&sdkName=jsbridge\\_feishu#/billEntryDetail)";
		const extracted = extractEkuaibaoTravelUrl(text);
		expect(extracted).toBe(
			"https://app.ekuaibao.com/web/app.html?accessToken=pi-browser-secret-fixture&sdkName=jsbridge_feishu#/billEntryDetail",
		);
	});

	it("不把相似域名或带账号信息的 URL 绑定给差旅工具", () => {
		expect(extractEkuaibaoTravelUrl("https://app.ekuaibao.com.evil.example/web/app.html")).toBeUndefined();
		expect(extractEkuaibaoTravelUrl("https://user@app.ekuaibao.com/web/app.html")).toBeUndefined();
	});
});
