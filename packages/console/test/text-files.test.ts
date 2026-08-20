import { describe, expect, it } from "vitest";
import { decodeTextBuffer, isTextFilePath } from "../src/text-files.ts";

describe("文本编码识别", () => {
	it("识别 UTF-8 与 UTF-16 BOM", () => {
		expect(decodeTextBuffer(Buffer.from("你好", "utf8"))).toEqual({ text: "你好", encoding: "utf-8" });
		expect(decodeTextBuffer(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("你好", "utf16le")]))).toEqual({
			text: "你好",
			encoding: "utf-16le",
		});
	});

	it("兼容 Windows 中文 GB18030", () => {
		const decoded = decodeTextBuffer(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
		expect(decoded).toEqual({ text: "中文", encoding: "gb18030" });
	});

	it("只把明确的文本扩展名交给文本解码器", () => {
		expect(isTextFilePath("D:/work/readme.md")).toBe(true);
		expect(isTextFilePath("D:/work/data.jsonl")).toBe(true);
		expect(isTextFilePath("D:/work/report.docx")).toBe(false);
		expect(isTextFilePath("D:/work/archive.zip")).toBe(false);
	});
});
