/** 在不改变 Pi 原生 read 行为的前提下，补充 Windows 常见文本编码识别。 */
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { extname } from "node:path";
import { createReadToolDefinition, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { decodeTextBuffer, isTextFilePath } from "./text-files.ts";

const IMAGE_MIME: Record<string, string> = {
	".bmp": "image/bmp",
	".gif": "image/gif",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
};

export function instantiateCoreFileTools(cwd: string): ToolDefinition[] {
	const readDefinition = createReadToolDefinition(cwd, {
		operations: {
			access: (path) => access(path, constants.R_OK),
			async readFile(path) {
				const data = await readFile(path);
				return isTextFilePath(path) ? Buffer.from(decodeTextBuffer(data).text, "utf8") : data;
			},
			detectImageMimeType: async (path) => IMAGE_MIME[extname(path).toLocaleLowerCase("en-US")] ?? null,
		},
	});
	return [
		defineTool({
			...readDefinition,
			label: "读取文件",
			description:
				"读取文本或图片文件。文本自动识别 UTF-8、UTF-16、GB18030 和常见 Windows 编码，并保留 Pi 原生的分页与截断规则。",
		}),
	];
}
