/**
 * Office 助手能力包：用 OfficeCLI 操作 Word/Excel/PowerPoint 文档。
 *
 * 工具按 officecli 的真实命令组（动词式文档树编辑）划分：
 * create / view / get / query / add / set / remove / move / swap / batch / import / merge / help。
 * 所有命令通过 execFile 数组传参执行，cwd = 当前会话工作目录（ctx.getWorkspaceRoot()），
 * 超时 120 秒，输出截断 8000 字符。不注入任何系统提示词。
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { runOfficeCli } from "../../src/officecli.ts";
import type { PackContext } from "../../src/packs.ts";

type TextResult = AgentToolResult<unknown>;

function ok(stdout: string, stderr: string): TextResult {
	const text = [stdout.trim(), stderr.trim() ? `stderr: ${stderr.trim()}` : ""].filter(Boolean).join("\n");
	return { content: [{ type: "text", text: text || "(无输出)" }], details: {} };
}

function fail(error: unknown): TextResult {
	return {
		content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
		details: {},
	};
}

/** 把 Record<string,string> 展开成重复的 --prop k=v 参数 */
function propArgs(props: Record<string, string> | undefined, flag = "--prop"): string[] {
	const args: string[] = [];
	for (const [key, value] of Object.entries(props ?? {})) {
		args.push(flag, `${key}=${value}`);
	}
	return args;
}

export default function definePack(ctx: PackContext) {
	const root = () => ctx.getWorkspaceRoot();

	const tools: ToolDefinition[] = [
		{
			// 元工具（触发式加载）：挂载后上下文里只有它，模型处理文档任务时调用一次，
			// 才激活下面 13 个完整工具——日常闲聊不付工具 schema 的 token。
			name: "office_enable",
			label: "启用 Office 文档能力",
			description:
				"当用户要求创建、查看或编辑 Word/Excel/PowerPoint 文档（docx/xlsx/pptx）时，先调用本工具一次以启用完整 Office 工具组。纯聊天或与文档无关的请求不要调用。",
			parameters: Type.Object({}),
			execute: async () => {
				ctx.activatePack?.("office-assistant");
				return {
					content: [
						{
							type: "text",
							text:
								"Office 工具组已启用，本会话现在可用：office_create（新建）、office_view（查看）、office_get/query（读取）、office_add/set/remove/move/swap（编辑）、office_batch（批量）、office_import（CSV 导入）、office_merge（模板合并）、office_help（元素与属性参考）。",
						},
					],
					details: {},
				};
			},
		},
		{
			name: "office_create",
			label: "新建 Office 文档",
			description:
				"创建空白 Office 文档（.docx / .xlsx / .pptx，按扩展名推断类型）。locale 可设 zh-CN 等以配置默认字体与 RTL。",
			parameters: Type.Object({
				file: Type.String({ description: "输出文件路径，如 report.docx" }),
				force: Type.Optional(Type.Boolean({ description: "覆盖已存在的文件" })),
				locale: Type.Optional(Type.String({ description: "区域标签，如 zh-CN、en-US" })),
			}),
			execute: async (_id, params) => {
				try {
					const args = ["create", params.file];
					if (params.force) args.push("--force");
					if (params.locale) args.push("--locale", params.locale);
					return ok(...(await runOfficeCli(args, root()).then((r) => [r.stdout, r.stderr] as const)));
				} catch (error) {
					return fail(error);
				}
			},
		},
		{
			name: "office_view",
			label: "查看文档",
			description:
				"以多种模式查看文档：text（文本）、annotated、outline（大纲）、stats（统计）、issues（问题检查）、html、screenshot（渲染截图，需 --out 保存 PNG）、pdf、forms。",
			parameters: Type.Object({
				file: Type.String({ description: "文档路径" }),
				mode: Type.String({
					description: "查看模式：text | annotated | outline | stats | issues | html | svg | screenshot | pdf | forms",
				}),
				page: Type.Optional(Type.String({ description: "页/幻灯片过滤，如 1 或 2-5" })),
				start: Type.Optional(Type.Integer({ description: "起始行/段落号" })),
				end: Type.Optional(Type.Integer({ description: "结束行/段落号" })),
				maxLines: Type.Optional(Type.Integer({ description: "最多输出行数" })),
				range: Type.Optional(
					Type.String({ description: "限定区域：xlsx 单元格范围（Sheet1!A1:C3）或元素路径" }),
				),
				out: Type.Optional(Type.String({ description: "输出文件路径（screenshot/pdf 模式保存用）" })),
			}),
			execute: async (_id, params) => {
				try {
					const args = ["view", params.file, params.mode];
					if (params.page) args.push("--page", params.page);
					if (params.start !== undefined) args.push("--start", String(params.start));
					if (params.end !== undefined) args.push("--end", String(params.end));
					if (params.maxLines !== undefined) args.push("--max-lines", String(params.maxLines));
					if (params.range) args.push("--range", params.range);
					if (params.out) args.push("--out", params.out);
					return ok(...(await runOfficeCli(args, root()).then((r) => [r.stdout, r.stderr] as const)));
				} catch (error) {
					return fail(error);
				}
			},
		},
		{
			name: "office_get",
			label: "读取文档节点",
			description: "按 DOM 路径读取文档节点（默认 / 即整棵树的浅层结构），如 /body/p[1]。--depth 控制下钻深度。",
			parameters: Type.Object({
				file: Type.String({ description: "文档路径" }),
				path: Type.Optional(Type.String({ description: "DOM 路径，默认 /" })),
				depth: Type.Optional(Type.Integer({ description: "子节点下钻深度，默认 1" })),
				asJson: Type.Optional(Type.Boolean({ description: "以 JSON 输出" })),
			}),
			execute: async (_id, params) => {
				try {
					const args = ["get", params.file, params.path ?? "/", "--depth", String(params.depth ?? 1)];
					if (params.asJson) args.push("--json");
					return ok(...(await runOfficeCli(args, root()).then((r) => [r.stdout, r.stderr] as const)));
				} catch (error) {
					return fail(error);
				}
			},
		},
		{
			name: "office_query",
			label: "查询文档元素",
			description:
				"用 CSS 风格选择器查询元素，如 paragraph[style=Normal] > run[font!=Arial]。--find 按文本过滤，--compact 每元素一行（适合全文档浏览）。",
			parameters: Type.Object({
				file: Type.String({ description: "文档路径" }),
				selector: Type.String({ description: "CSS 风格选择器，* 列出全部顶层块" }),
				find: Type.Optional(Type.String({ description: "只返回包含此文本的元素" })),
				compact: Type.Optional(Type.Boolean({ description: "紧凑单行输出" })),
				asJson: Type.Optional(Type.Boolean({ description: "以 JSON 输出" })),
			}),
			execute: async (_id, params) => {
				try {
					const args = ["query", params.file, params.selector];
					if (params.find) args.push("--find", params.find);
					if (params.compact) args.push("--compact");
					if (params.asJson) args.push("--json");
					return ok(...(await runOfficeCli(args, root()).then((r) => [r.stdout, r.stderr] as const)));
				} catch (error) {
					return fail(error);
				}
			},
		},
		{
			name: "office_add",
			label: "添加文档元素",
			description:
				"向文档添加元素。docx 父路径用 /body（或 /body/p[N]），xlsx 用 /Sheet1，pptx 幻灯片用 /、形状用 /slide[N]。元素类型与属性见 office_help，如 paragraph、table、row、cell、slide、shape、picture。文本换行：\\n 新段落，\\v 段内换行。",
			parameters: Type.Object({
				file: Type.String({ description: "文档路径" }),
				parent: Type.String({ description: "父节点 DOM 路径" }),
				type: Type.Optional(Type.String({ description: "元素类型，如 paragraph、table、sheet、row、cell、slide、shape、picture" })),
				props: Type.Optional(Type.Record(Type.String(), Type.String({ description: "属性键值对，如 text=你好 bold=true" }))),
				index: Type.Optional(Type.Integer({ description: "插入位置（0 基），缺省追加到末尾" })),
				from: Type.Optional(Type.String({ description: "从已有元素路径复制" })),
			}),
			execute: async (_id, params) => {
				try {
					const args = ["add", params.file, params.parent];
					if (params.type) args.push("--type", params.type);
					args.push(...propArgs(params.props));
					if (params.index !== undefined) args.push("--index", String(params.index));
					if (params.from) args.push("--from", params.from);
					return ok(...(await runOfficeCli(args, root()).then((r) => [r.stdout, r.stderr] as const)));
				} catch (error) {
					return fail(error);
				}
			},
		},
		{
			name: "office_set",
			label: "修改文档属性",
			description:
				"修改文档节点属性（--prop key=value），或用 find/replace 做文本替换（支持 r\"...\" 正则前缀）。",
			parameters: Type.Object({
				file: Type.String({ description: "文档路径" }),
				path: Type.String({ description: "目标元素 DOM 路径" }),
				props: Type.Optional(Type.Record(Type.String(), Type.String({ description: "属性键值对" }))),
				find: Type.Optional(Type.String({ description: "查找文本（在该节点内）" })),
				replace: Type.Optional(Type.String({ description: "替换文本，配合 find 使用" })),
			}),
			execute: async (_id, params) => {
				try {
					const args = ["set", params.file, params.path, ...propArgs(params.props)];
					if (params.find) args.push("--find", params.find);
					if (params.replace !== undefined) args.push("--replace", params.replace);
					return ok(...(await runOfficeCli(args, root()).then((r) => [r.stdout, r.stderr] as const)));
				} catch (error) {
					return fail(error);
				}
			},
		},
		{
			name: "office_remove",
			label: "删除文档元素",
			description: "删除 DOM 路径指向的元素。Excel 删单元格可选 shift=left|up 填补空隙。",
			parameters: Type.Object({
				file: Type.String({ description: "文档路径" }),
				path: Type.String({ description: "要删除的元素 DOM 路径" }),
				shift: Type.Optional(Type.String({ description: "Excel 单元格删除后填补方向：left | up" })),
			}),
			execute: async (_id, params) => {
				try {
					const args = ["remove", params.file, params.path];
					if (params.shift) args.push("--shift", params.shift);
					return ok(...(await runOfficeCli(args, root()).then((r) => [r.stdout, r.stderr] as const)));
				} catch (error) {
					return fail(error);
				}
			},
		},
		{
			name: "office_move",
			label: "移动文档元素",
			description: "把元素移动到新位置或新父节点（move 命令，参数见 office_help 对应元素）。",
			parameters: Type.Object({
				file: Type.String({ description: "文档路径" }),
				path: Type.String({ description: "要移动的元素 DOM 路径" }),
				to: Type.Optional(Type.String({ description: "目标父路径" })),
				after: Type.Optional(Type.String({ description: "移动到该兄弟元素之后" })),
				before: Type.Optional(Type.String({ description: "移动到该兄弟元素之前" })),
			}),
			execute: async (_id, params) => {
				try {
					const args = ["move", params.file, params.path];
					if (params.to) args.push("--to", params.to);
					if (params.after) args.push("--after", params.after);
					if (params.before) args.push("--before", params.before);
					return ok(...(await runOfficeCli(args, root()).then((r) => [r.stdout, r.stderr] as const)));
				} catch (error) {
					return fail(error);
				}
			},
		},
		{
			name: "office_swap",
			label: "交换文档元素",
			description: "交换两个元素的位置（swap 命令）。",
			parameters: Type.Object({
				file: Type.String({ description: "文档路径" }),
				path1: Type.String({ description: "第一个元素 DOM 路径" }),
				path2: Type.String({ description: "第二个元素 DOM 路径" }),
			}),
			execute: async (_id, params) => {
				try {
					return ok(...(await runOfficeCli(["swap", params.file, params.path1, params.path2], root()).then((r) => [r.stdout, r.stderr] as const)));
				} catch (error) {
					return fail(error);
				}
			},
		},
		{
			name: "office_batch",
			label: "批量执行文档操作",
			description:
				'一次执行多条命令（JSON 数组，走单个打开/保存周期，适合成套构建文档）。每项如 {"command":"add","parent":"/body","type":"paragraph","props":{"text":"你好"}}，动词字段与单命令一致（path/selector/type/props/to/after/before/path2）。',
			parameters: Type.Object({
				file: Type.String({ description: "文档路径" }),
				commands: Type.Array(Type.Object({}, { additionalProperties: true }), {
					description: "命令对象数组，每项含 command 动词 + 对应参数字段",
				}),
			}),
			execute: async (_id, params) => {
				try {
					const json = JSON.stringify(params.commands);
					return ok(
						...(await runOfficeCli(["batch", params.file, "--commands", json], root()).then((r) => [r.stdout, r.stderr] as const)),
					);
				} catch (error) {
					return fail(error);
				}
			},
		},
		{
			name: "office_import",
			label: "导入 CSV 到 Excel",
			description: "把 CSV/TSV 数据导入 Excel 工作表（import 命令）。",
			parameters: Type.Object({
				file: Type.String({ description: "目标 .xlsx 路径" }),
				parentPath: Type.String({ description: "目标工作表路径，如 /Sheet1" }),
				sourceFile: Type.String({ description: "CSV/TSV 源文件路径" }),
			}),
			execute: async (_id, params) => {
				try {
					return ok(
						...(await runOfficeCli(["import", params.file, params.parentPath, params.sourceFile], root()).then((r) => [r.stdout, r.stderr] as const)),
					);
				} catch (error) {
					return fail(error);
				}
			},
		},
		{
			name: "office_merge",
			label: "模板合并",
			description: "把 JSON 数据合并进含 {{key}} 占位符的模板文档，生成输出文件（merge 命令）。",
			parameters: Type.Object({
				template: Type.String({ description: "模板文件路径（.docx/.xlsx/.pptx）" }),
				output: Type.String({ description: "输出文件路径" }),
				data: Type.String({ description: "JSON 数据字符串或 .json 文件路径" }),
				force: Type.Optional(Type.Boolean({ description: "覆盖已存在的输出文件" })),
			}),
			execute: async (_id, params) => {
				try {
					const args = ["merge", params.template, params.output, "--data", params.data];
					if (params.force) args.push("--force");
					return ok(...(await runOfficeCli(args, root()).then((r) => [r.stdout, r.stderr] as const)));
				} catch (error) {
					return fail(error);
				}
			},
		},
		{
			name: "office_help",
			label: "Office 能力参考",
			description:
				"查询 officecli 的 schema 能力参考：格式（docx/xlsx/pptx）支持的元素、动词与属性。如 format=docx 列出全部元素；format=docx&verb=add 列出可添加的元素；element 给出该元素的完整属性。",
			parameters: Type.Object({
				format: Type.Optional(Type.String({ description: "docx | xlsx | pptx | all，缺省为总览" })),
				verb: Type.Optional(Type.String({ description: "add | set | get | query | remove" })),
				element: Type.Optional(Type.String({ description: "元素名，如 paragraph、table、shape" })),
			}),
			execute: async (_id, params) => {
				try {
					const args = ["help"];
					if (params.format) args.push(params.format);
					if (params.verb) args.push(params.verb);
					if (params.element) args.push(params.element);
					return ok(...(await runOfficeCli(args, root()).then((r) => [r.stdout, r.stderr] as const)));
				} catch (error) {
					return fail(error);
				}
			},
		},
	];

	return { tools };
}
