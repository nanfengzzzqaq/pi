import { resolve } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runOcr } from "../../src/managed-file-tools.ts";
import type { PackContext } from "../../src/packs.ts";

export default function definePack(ctx: PackContext) {
	const tools: ToolDefinition[] = [
		{
			name: "ocr_extract_text",
			label: "识别图片文字",
			description: "从 PNG、JPG、BMP、TIFF 或 WebP 图片中识别中文和英文。扫描 PDF 应先渲染为图片。",
			parameters: Type.Object({
				path: Type.String({ description: "图片路径" }),
				language: Type.Optional(Type.String({ description: "语言，默认 chi_sim+eng" })),
			}),
			execute: async (_id, params) => ({
				content: [{ type: "text", text: await runOcr(resolve(ctx.getWorkspaceRoot(), params.path), params.language ?? "chi_sim+eng", ctx.getWorkspaceRoot()) }],
				details: {},
			}),
		},
	];
	return { tools };
}
