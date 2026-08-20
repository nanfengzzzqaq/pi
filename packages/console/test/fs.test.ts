import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { copyFileIntoDirectory, getDirectoryInfo, importFileIntoDirectory, listDir, searchFiles } from "../src/fs.ts";

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

	it.runIf(process.platform === "win32")("按文件名和文本内容递归搜索", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-fs-search-test-"));
		const child = join(root, "资料");
		mkdirSync(child);
		writeFileSync(join(child, "季度报告.md"), "第一行\n关键数据：42", "utf8");
		const byName = searchFiles(root, "季度报告", "name");
		const byContent = searchFiles(root, "关键数据", "content");
		expect(byName.results.map((entry) => entry.name)).toContain("季度报告.md");
		expect(byContent.results[0]?.line).toBe(2);
		expect(byContent.results[0]?.preview).toContain("42");
	});
});
