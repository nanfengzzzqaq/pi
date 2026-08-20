import { resolve } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runSevenZip } from "../../src/managed-file-tools.ts";
import type { PackContext } from "../../src/packs.ts";

function result(stdout: string, stderr: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n") || "（无输出）" }], details: {} };
}

export default function definePack(ctx: PackContext) {
	const root = () => ctx.getWorkspaceRoot();
	const tools: ToolDefinition[] = [
		{
			name: "archive_list",
			label: "查看压缩包内容",
			description: "列出 ZIP、7z、RAR、TAR、GZ 等压缩包内的文件，不解压。",
			parameters: Type.Object({ path: Type.String({ description: "压缩包路径" }) }),
			execute: async (_id, params) => {
				const output = await runSevenZip(["l", resolve(root(), params.path)], root());
				return result(output.stdout, output.stderr);
			},
		},
		{
			name: "archive_test",
			label: "校验压缩包",
			description: "测试压缩包能否完整读取，并报告损坏或校验错误。",
			parameters: Type.Object({ path: Type.String({ description: "压缩包路径" }) }),
			execute: async (_id, params) => {
				const output = await runSevenZip(["t", resolve(root(), params.path)], root());
				return result(output.stdout, output.stderr);
			},
		},
		{
			name: "archive_extract",
			label: "解压文件",
			description: "把压缩包解压到指定目录，保留内部目录结构。",
			parameters: Type.Object({
				path: Type.String({ description: "压缩包路径" }),
				outputDir: Type.String({ description: "输出目录" }),
				overwrite: Type.Optional(Type.Boolean({ description: "是否覆盖同名文件，默认否" })),
			}),
			execute: async (_id, params) => {
				const args = ["x", resolve(root(), params.path), `-o${resolve(root(), params.outputDir)}`, params.overwrite ? "-aoa" : "-aos"];
				const output = await runSevenZip(args, root());
				return result(output.stdout, output.stderr);
			},
		},
		{
			name: "archive_create",
			label: "创建压缩包",
			description: "把一个或多个文件、文件夹创建为 ZIP 或 7z 压缩包。",
			parameters: Type.Object({
				output: Type.String({ description: "输出压缩包路径，以 .zip 或 .7z 结尾" }),
				inputs: Type.Array(Type.String(), { minItems: 1, description: "要压缩的文件或文件夹路径" }),
			}),
			execute: async (_id, params) => {
				const args = ["a", resolve(root(), params.output), ...params.inputs.map((path) => resolve(root(), path))];
				const output = await runSevenZip(args, root());
				return result(output.stdout, output.stderr);
			},
		},
	];
	return { tools };
}
