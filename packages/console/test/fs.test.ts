import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	copyFileIntoDirectory,
	getDirectoryInfo,
	importFileIntoDirectory,
	listDir,
	readTextFile,
	searchFiles,
	writeTextFile,
} from "../src/fs.ts";

describe("Windows 本地资源管理器", () => {
	it.runIf(process.platform === "win32")("浏览任意本地目录并标记父目录", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-fs-test-"));
		writeFileSync(join(directory, "示例.txt"), "hello", "utf8");
		const info = getDirectoryInfo(directory);
		const entries = listDir(directory);
		expect(info.path).toBe(directory);
		expect(info.parent).toBeTruthy();
		expect(entries.find((entry) => entry.name === "示例.txt")?.size).toBe(5);
	});

	it.runIf(process.platform === "win32")("拖入文件时复制且不覆盖同名文件", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-fs-test-"));
		const source = join(root, "source");
		const destination = join(root, "destination");
		mkdirSync(source);
		mkdirSync(destination);
		const sourceFile = join(source, "报告.txt");
		writeFileSync(sourceFile, "first", "utf8");
		const first = copyFileIntoDirectory(sourceFile, destination);
		const second = importFileIntoDirectory("报告.txt", Buffer.from("second").toString("base64"), destination);
		expect(first.name).toBe("报告.txt");
		expect(second.name).toBe("报告 (1).txt");
		expect(readFileSync(second.path, "utf8")).toBe("second");
	});

	it.runIf(process.platform === "win32")("按文件名和文本内容递归搜索", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-fs-search-test-"));
		const child = join(root, "资料");
		mkdirSync(child);
		writeFileSync(join(child, "季度报告.md"), "第一行\n关键数据：42", "utf8");
		const byName = await searchFiles(root, "季度报告", "name");
		const byContent = await searchFiles(root, "关键数据", "content");
		expect(byName.results.map((entry) => entry.name)).toContain("季度报告.md");
		expect(byContent.results[0]?.line).toBe(2);
		expect(byContent.results[0]?.preview).toContain("42");
	});

	it.runIf(process.platform === "win32")("保存代码时校验并更新文件指纹", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-fs-edit-test-"));
		const file = join(root, "app.ts");
		writeFileSync(file, "const value = 1;\n", "utf8");
		const opened = readTextFile(file);
		const saved = writeTextFile(file, "const value = 2;\n", opened.sha256);
		expect(readFileSync(file, "utf8")).toBe("const value = 2;\n");
		expect(saved.sha256).not.toBe(opened.sha256);
		expect(() => writeTextFile(file, "const value = 3;\n", opened.sha256)).toThrow("其他程序修改");
	});

	it.runIf(process.platform === "win32")("保存 UTF-16LE 代码时保留原编码", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-fs-encoding-test-"));
		const file = join(root, "script.ps1");
		writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Write-Host 1", "utf16le")]));
		const opened = readTextFile(file);
		writeTextFile(file, "Write-Host 2", opened.sha256);
		const saved = readFileSync(file);
		expect(saved.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
		expect(saved.subarray(2).toString("utf16le")).toBe("Write-Host 2");
	});

	it.runIf(process.platform === "win32")("保存 UTF-8 代码时保留 BOM", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-fs-utf8-bom-test-"));
		const file = join(root, "app.ts");
		writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("const a = 1;", "utf8")]));
		const opened = readTextFile(file);
		writeTextFile(file, "const a = 2;", opened.sha256);
		const saved = readFileSync(file);
		expect(saved.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
		expect(saved.subarray(3).toString("utf8")).toBe("const a = 2;");
	});
});
