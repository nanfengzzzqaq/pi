/** 本地文本文件识别与编码解码。只处理文本，不猜测 Office、PDF 等二进制格式。 */
import { extname } from "node:path";

const TEXT_EXTENSIONS = new Set([
	".bat",
	".c",
	".cc",
	".cfg",
	".cmd",
	".conf",
	".cpp",
	".cs",
	".css",
	".csv",
	".env",
	".go",
	".gql",
	".graphql",
	".h",
	".hpp",
	".htm",
	".html",
	".ini",
	".java",
	".js",
	".json",
	".json5",
	".jsonl",
	".jsx",
	".kt",
	".kts",
	".less",
	".log",
	".lua",
	".md",
	".mdx",
	".mjs",
	".php",
	".properties",
	".ps1",
	".psm1",
	".py",
	".pyw",
	".rb",
	".rs",
	".rst",
	".scss",
	".sh",
	".sql",
	".svelte",
	".swift",
	".tex",
	".toml",
	".ts",
	".tsv",
	".tsx",
	".txt",
	".vue",
	".xml",
	".yaml",
	".yml",
	".zsh",
]);

const TEXT_FILE_NAMES = new Set([
	"agents.md",
	"changelog",
	"dockerfile",
	"license",
	"makefile",
	"readme",
	".dockerignore",
	".editorconfig",
	".gitattributes",
	".gitignore",
]);

export interface DecodedText {
	text: string;
	encoding: "utf-8" | "utf-16le" | "utf-16be" | "gb18030" | "windows-1252";
}

export function isTextFilePath(path: string): boolean {
	const normalized = path.replace(/\\/g, "/");
	const name = normalized.slice(normalized.lastIndexOf("/") + 1).toLocaleLowerCase("en-US");
	return TEXT_FILE_NAMES.has(name) || TEXT_EXTENSIONS.has(extname(name));
}

function decodeUtf16Be(buffer: Buffer): string {
	const swapped = Buffer.allocUnsafe(buffer.length);
	for (let index = 0; index < buffer.length; index += 2) {
		swapped[index] = buffer[index + 1] ?? 0;
		swapped[index + 1] = buffer[index] ?? 0;
	}
	return swapped.toString("utf16le");
}

function looksLikeUtf16(buffer: Buffer, evenBytesAreNull: boolean): boolean {
	const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
	if (sample.length < 4) return false;
	let expectedNulls = 0;
	let positions = 0;
	for (let index = 0; index < sample.length; index++) {
		if ((index % 2 === 0) === evenBytesAreNull) {
			positions++;
			if (sample[index] === 0) expectedNulls++;
		}
	}
	return expectedNulls / positions > 0.35;
}

function decodeWith(label: string, buffer: Buffer, fatal: boolean): string {
	return new TextDecoder(label, { fatal }).decode(buffer);
}

/** 优先 BOM 和严格 UTF-8，再兼容常见 Windows 中文编码。 */
export function decodeTextBuffer(buffer: Buffer): DecodedText {
	if (buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
		return { text: buffer.subarray(3).toString("utf8"), encoding: "utf-8" };
	}
	if (buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) {
		return { text: buffer.subarray(2).toString("utf16le"), encoding: "utf-16le" };
	}
	if (buffer.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
		return { text: decodeUtf16Be(buffer.subarray(2)), encoding: "utf-16be" };
	}
	if (looksLikeUtf16(buffer, false)) return { text: buffer.toString("utf16le"), encoding: "utf-16le" };
	if (looksLikeUtf16(buffer, true)) return { text: decodeUtf16Be(buffer), encoding: "utf-16be" };
	try {
		return { text: decodeWith("utf-8", buffer, true), encoding: "utf-8" };
	} catch {
		try {
			return { text: decodeWith("gb18030", buffer, true), encoding: "gb18030" };
		} catch {
			return { text: decodeWith("windows-1252", buffer, false), encoding: "windows-1252" };
		}
	}
}
