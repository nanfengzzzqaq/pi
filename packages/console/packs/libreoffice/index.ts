import { dirname, resolve } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { convertDocument } from "../../src/managed-file-tools.ts";
import type { PackContext } from "../../src/packs.ts";

export default function definePack(ctx: PackContext) {
	const tools: ToolDefinition[] = [
		{
			name: "document_convert",
			label: "转换兼容文档",
			description:
				"转换 .doc/.xls/.ppt 与 .odt/.ods/.odp/.rtf 等兼容格式。现代 .docx/.xlsx/.pptx 的创建编辑继续使用 OfficeCLI，避免工具冲突。",
			parameters: Type.Object({
				input: Type.String({ description: "输入文件路径" }),
				format: Type.String({ description: "输出格式，如 pdf、docx、xlsx、pptx、txt" }),
				outputDir: Type.Optional(Type.String({ description: "输出目录，默认输入文件所在目录" })),
			}),
			execute: async (_id, params) => {
				const cwd = ctx.getWorkspaceRoot();
				const input = resolve(cwd, params.input);
				const outputDir = params.outputDir ? resolve(cwd, params.outputDir) : dirname(input);
				return { content: [{ type: "text", text: await convertDocument(input, params.format, outputDir, cwd) }], details: {} };
			},
		},
	];
	return { tools };
}
