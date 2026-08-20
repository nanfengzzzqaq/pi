/**
 * 红队演练能力包：把 promptfoo（开源 LLM 红队/评估框架）装进 Pi 控制台。
 *
 * 加载方式：按本轮需求加载（pack.json 的 activation + toolGroups）——
 * 本地关键词路由命中"红队/扫描/评估"类需求时才把对应最小工具组注入当轮上下文，
 * 日常闲聊零 token 成本。
 *
 * 引擎管理对齐 OfficeCLI 模式：
 * - promptfoo 按需安装到 data/redteam/（npm --prefix），只检查、不自动安装；
 *   安装/更新由用户通过目录页"安装"按钮或 redteam_setup 工具触发，默认锁定官方版本
 * - 执行时定位 data/redteam/node_modules/promptfoo 的 bin，用当前 Node 直接跑，
 *   Electron 环境下自动补 ELECTRON_RUN_AS_NODE=1
 * - cwd = 当前会话工作目录（ctx.getWorkspaceRoot()），攻击样本与报告都落在工作区
 * - API key 不落盘：通过各 run 工具的 env 参数传入，仅注入子进程
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import type { PackContext } from "../../src/packs.ts";
import { DATA_DIR } from "../../src/paths.ts";

type TextResult = AgentToolResult<unknown>;

const INSTALL_DIR = join(DATA_DIR, "redteam");
const VERSION_RECORD = join(INSTALL_DIR, "promptfoo-version.json");
const DEFAULT_VERSION = "0.122.0";
const MAX_OUTPUT = 8000;

function ok(text: string): TextResult {
	return { content: [{ type: "text", text: text || "(无输出)" }], details: {} };
}

function fail(error: unknown): TextResult {
	return {
		content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
		details: {},
	};
}

function truncate(s: string): string {
	if (s.length <= MAX_OUTPUT) return s;
	return `...(前面已截断)...\n${s.slice(-MAX_OUTPUT)}`;
}

/** 校验版本号/包名类字符串，防注入（仅允许安全字符） */
const SAFE_SPEC = /^[@\w.\-/]+$/;

interface ExecResult {
	stdout: string;
	stderr: string;
	code: number | null;
}

function exec(
	file: string,
	args: string[],
	options: { cwd: string; timeoutMs: number; env?: Record<string, string>; shell?: boolean },
): Promise<ExecResult> {
	// shell 模式（win32 调 npm.cmd）下参数经 cmd.exe 解析，含空格/特殊字符的参数必须加引号
	const finalArgs = options.shell
		? args.map((a) => (/[\s&|<>^"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
		: args;
	return new Promise((resolve) => {
		execFile(
			file,
			finalArgs,
			{
				cwd: options.cwd,
				timeout: options.timeoutMs,
				shell: options.shell ?? false,
				env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...options.env },
				windowsHide: true,
				maxBuffer: 16 * 1024 * 1024,
			},
			(error, stdout, stderr) => {
				resolve({
					stdout: String(stdout ?? ""),
					stderr: String(stderr ?? ""),
					code: error ? ((error as { code?: number | null }).code ?? null) : 0,
				});
			},
		);
	});
}

function npmCommand(): string {
	return process.platform === "win32" ? "npm.cmd" : "npm";
}

/** 定位已安装的 promptfoo CLI 入口（bin 指向的 js 文件） */
function promptfooBin(): string | null {
	const pkgPath = join(INSTALL_DIR, "node_modules", "promptfoo", "package.json");
	if (!existsSync(pkgPath)) return null;
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
		const bin = typeof pkg.bin === "string" ? pkg.bin : Object.values(pkg.bin ?? {})[0];
		if (typeof bin !== "string") return null;
		const abs = join(INSTALL_DIR, "node_modules", "promptfoo", bin);
		return existsSync(abs) ? abs : null;
	} catch {
		return null;
	}
}

function installedVersion(): string | null {
	try {
		const rec = JSON.parse(readFileSync(VERSION_RECORD, "utf8"));
		return typeof rec.version === "string" ? rec.version : null;
	} catch {
		return null;
	}
}

/** 跑 promptfoo CLI；未安装返回 null */
async function runPromptfoo(
	args: string[],
	opts: { cwd: string; timeoutMs: number; env?: Record<string, string> },
): Promise<ExecResult | null> {
	const bin = promptfooBin();
	if (!bin) return null;
	return exec(process.execPath, [bin, ...args], opts);
}

const ENV_PARAM = Type.Optional(
	Type.Record(Type.String(), Type.String(), {
		description:
			"注入子进程的环境变量（如 DEEPSEEK_API_KEY、OPENAI_API_KEY、目标系统的 key）。不会写入磁盘。",
	}),
);

export default function definePack(ctx: PackContext) {
	const root = () => ctx.getWorkspaceRoot();

	const tools: ToolDefinition[] = [
		{
			name: "redteam_setup",
			label: "红队环境管理",
			description:
				"检查/安装/更新 promptfoo。status 查看状态；install 安装指定版本（默认官方 0.122.0）；update 升级到最新版。安装与更新由用户决定，不会自动进行。",
			parameters: Type.Object({
				action: Type.Union([Type.Literal("status"), Type.Literal("install"), Type.Literal("update")], {
					description: "status=检查；install=安装；update=升级到最新",
				}),
				version: Type.Optional(
					Type.String({ description: "install 时指定版本号，默认 0.122.0；update 忽略此参数" }),
				),
			}),
			execute: async ({ action, version }) => {
				if (action === "status") {
					const bin = promptfooBin();
					const ver = installedVersion();
					const npmCheck = await exec(npmCommand(), ["--version"], {
						cwd: root(),
						timeoutMs: 15_000,
						shell: process.platform === "win32",
					});
					const lines = [
						`promptfoo：${bin ? `已安装（版本记录 ${ver ?? "未知"}）` : "未安装"}`,
						`安装目录：${INSTALL_DIR}`,
						`npm：${npmCheck.code === 0 ? `可用（v${npmCheck.stdout.trim()}）` : "不可用，安装需要本机有 Node.js 环境"}`,
					];
					return ok(lines.join("\n"));
				}
				const spec = action === "update" ? "promptfoo@latest" : `promptfoo@${version || DEFAULT_VERSION}`;
				if (!SAFE_SPEC.test(spec)) return fail(new Error("版本号包含非法字符"));
				mkdirSync(INSTALL_DIR, { recursive: true });
				const r = await exec(npmCommand(), ["install", "--prefix", INSTALL_DIR, spec, "--no-fund", "--no-audit"], {
					cwd: root(),
					timeoutMs: 15 * 60 * 1000,
					shell: process.platform === "win32",
				});
				if (r.code !== 0 || !promptfooBin()) {
					return fail(new Error(`安装失败（exit ${r.code}）：\n${truncate(r.stderr || r.stdout)}`));
				}
				// 记录实际安装版本
				const verProbe = await runPromptfoo(["--version"], { cwd: root(), timeoutMs: 30_000 });
				const actual = verProbe?.stdout.trim().split("\n").pop() || "unknown";
				writeFileSync(VERSION_RECORD, JSON.stringify({ version: actual, spec, installedAt: new Date().toISOString() }));
				return ok(`promptfoo 安装完成：${actual}\n位置：${INSTALL_DIR}`);
			},
		},
		{
			name: "redteam_plugins",
			label: "列出攻击插件与策略",
			description: "列出 promptfoo 全部可用的红队攻击插件（plugins）和投递策略（strategies），用于规划测试范围。",
			parameters: Type.Object({
				kind: Type.Optional(
					Type.Union([Type.Literal("plugins"), Type.Literal("strategies"), Type.Literal("all")], {
						description: "默认 all",
					}),
				),
			}),
			execute: async ({ kind }) => {
				const want = kind ?? "all";
				const sections: string[] = [];
				if (want === "plugins" || want === "all") {
					const r = await runPromptfoo(["redteam", "plugins"], { cwd: root(), timeoutMs: 60_000 });
					if (!r) return fail(new Error("promptfoo 未安装，请先 redteam_setup install"));
					sections.push(`【攻击插件】\n${r.stdout.trim()}`);
				}
				if (want === "strategies" || want === "all") {
					const r = await runPromptfoo(["redteam", "strategies"], { cwd: root(), timeoutMs: 60_000 });
					if (!r) return fail(new Error("promptfoo 未安装，请先 redteam_setup install"));
					sections.push(`【投递策略】\n${r.stdout.trim()}`);
				}
				return ok(truncate(sections.join("\n\n")));
			},
		},
		{
			name: "redteam_init",
			label: "生成红队配置",
			description:
				"在工作区生成 promptfooconfig.yaml 红队配置。需要描述被测系统（purpose）、指定攻击模型、插件和策略。被测目标可以是任意 HTTP API 或模型 provider。",
			parameters: Type.Object({
				target: Type.String({
					description:
						"被测目标：promptfoo provider id（如 openai:gpt-4o、deepseek:deepseek-v4-flash、http 自定义端点 https://...）或 file:// 自定义 provider",
				}),
				purpose: Type.String({
					description: "被测系统的详细描述（能力、数据、安全边界），越具体攻击越贴合",
				}),
				plugins: Type.Array(Type.String(), {
					description: "攻击插件 id 列表，如 ['harmful:hate','shell-injection','prompt-extraction']",
				}),
				strategies: Type.Optional(
					Type.Array(Type.String(), { description: "投递策略，默认 ['basic','jailbreak']" }),
				),
				attackModel: Type.Optional(
					Type.String({ description: "攻击生成+评分模型，默认 deepseek:deepseek-v4-flash" }),
				),
				numTests: Type.Optional(Type.Number({ description: "每个插件生成几条攻击，默认 4" })),
				language: Type.Optional(Type.String({ description: "攻击样本语言，默认 Chinese" })),
				filename: Type.Optional(Type.String({ description: "配置文件名，默认 promptfooconfig.yaml" })),
			}),
			execute: async ({ target, purpose, plugins, strategies, attackModel, numTests, language, filename }) => {
				if (!SAFE_SPEC.test(target) && !target.startsWith("http") && !target.startsWith("file://")) {
					return fail(new Error("target 格式不支持"));
				}
				const name = filename || "promptfooconfig.yaml";
				const list = (arr: string[], indent: string) => arr.map((p) => `${indent}- ${p}`).join("\n");
				const yaml = `description: Pi 控制台红队演练

targets:
  - id: ${target}

redteam:
  provider:
    id: ${attackModel || "deepseek:deepseek-v4-flash"}
  purpose: |
${purpose.split("\n").map((l) => `    ${l}`).join("\n")}
  language: ${language || "Chinese"}
  numTests: ${numTests ?? 4}
  plugins:
${list(plugins, "    ")}
  strategies:
${list(strategies ?? ["basic", "jailbreak"], "    ")}
`;
				try {
					writeFileSync(join(root(), name), yaml, "utf8");
					return ok(`配置已写入 ${join(root(), name)}\n\n${yaml}`);
				} catch (e) {
					return fail(e);
				}
			},
		},
		{
			name: "redteam_generate",
			label: "生成攻击样本",
			description: "只生成攻击样本（redteam generate），不执行。适合先人工审查样本质量。需要攻击模型的 API key（通过 env 参数传入）。",
			parameters: Type.Object({
				config: Type.Optional(Type.String({ description: "配置文件名，默认 promptfooconfig.yaml" })),
				disableRemoteGeneration: Type.Optional(
					Type.Boolean({ description: "强制攻击生成走本地攻击模型而非 promptfoo 云端，默认 true（数据不出本机）" }),
				),
				env: ENV_PARAM,
			}),
			execute: async ({ config, disableRemoteGeneration, env }) => {
				const envVars = { ...env };
				if (disableRemoteGeneration ?? true) envVars.PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION = "true";
				const args = ["redteam", "generate"];
				if (config) args.push("-c", config);
				const r = await runPromptfoo(args, { cwd: root(), timeoutMs: 20 * 60 * 1000, env: envVars });
				if (!r) return fail(new Error("promptfoo 未安装，请先 redteam_setup install"));
				return ok(truncate([r.stdout, r.stderr].filter(Boolean).join("\n")) || `exit ${r.code}`);
			},
		},
		{
			name: "redteam_run",
			label: "执行红队扫描",
			description:
				"完整红队扫描（redteam run）：生成攻击样本并对目标执行，输出通过率摘要。耗时较长（几十分钟级），期间目标系统会收到真实攻击请求。需要攻击模型 key，target 若是云端模型也需对应 key（env 参数传入）。",
			parameters: Type.Object({
				config: Type.Optional(Type.String({ description: "配置文件名，默认 promptfooconfig.yaml" })),
				maxConcurrency: Type.Optional(Type.Number({ description: "并发数，默认 4；目标较弱时调低" })),
				disableRemoteGeneration: Type.Optional(
					Type.Boolean({ description: "强制攻击生成走本地攻击模型，默认 true" }),
				),
				timeoutMinutes: Type.Optional(Type.Number({ description: "超时分钟数，默认 60" })),
				env: ENV_PARAM,
			}),
			execute: async ({ config, maxConcurrency, disableRemoteGeneration, timeoutMinutes, env }) => {
				const envVars = { ...env };
				if (disableRemoteGeneration ?? true) envVars.PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION = "true";
				const args = ["redteam", "run"];
				if (config) args.push("-c", config);
				if (maxConcurrency) args.push("--max-concurrency", String(maxConcurrency));
				const r = await runPromptfoo(args, {
					cwd: root(),
					timeoutMs: (timeoutMinutes ?? 60) * 60 * 1000,
					env: envVars,
				});
				if (!r) return fail(new Error("promptfoo 未安装，请先 redteam_setup install"));
				const out = truncate([r.stdout, r.stderr].filter(Boolean).join("\n"));
				return ok(`${out}\n\n（完整报告：在工作区运行 promptfoo redteam report 可打开可视化报告；历史结果用 redteam_results 查看）`);
			},
		},
		{
			name: "redteam_results",
			label: "查看历史评估结果",
			description: "列出最近的评估/红队运行记录（promptfoo list evals），含时间、通过率和结果 ID。",
			parameters: Type.Object({
				limit: Type.Optional(Type.Number({ description: "显示最近几条，默认 10" })),
				env: ENV_PARAM,
			}),
			execute: async ({ limit, env }) => {
				const r = await runPromptfoo(["list", "evals", "--limit", String(limit ?? 10)], {
					cwd: root(),
					timeoutMs: 60_000,
					env,
				});
				if (!r) return fail(new Error("promptfoo 未安装，请先 redteam_setup install"));
				return ok(truncate(r.stdout || r.stderr));
			},
		},
		{
			name: "eval_run",
			label: "通用评估/模型对比",
			description:
				"运行 promptfoo eval：标准评估、提示词回归测试、多模型横向对比。需要一个 eval 配置（可用 write 工具自行编写 yaml，含 providers/prompts/tests）。",
			parameters: Type.Object({
				config: Type.String({ description: "eval 配置文件名（相对工作区），如 eval.yaml" }),
				output: Type.Optional(Type.String({ description: "结果输出文件名（json），如 results.json" })),
				noCache: Type.Optional(Type.Boolean({ description: "禁用缓存，默认 false" })),
				maxConcurrency: Type.Optional(Type.Number({ description: "并发数" })),
				timeoutMinutes: Type.Optional(Type.Number({ description: "超时分钟数，默认 30" })),
				env: ENV_PARAM,
			}),
			execute: async ({ config, output, noCache, maxConcurrency, timeoutMinutes, env }) => {
				const args = ["eval", "-c", config];
				if (output) args.push("-o", output);
				if (noCache) args.push("--no-cache");
				if (maxConcurrency) args.push("--max-concurrency", String(maxConcurrency));
				const r = await runPromptfoo(args, {
					cwd: root(),
					timeoutMs: (timeoutMinutes ?? 30) * 60 * 1000,
					env,
				});
				if (!r) return fail(new Error("promptfoo 未安装，请先 redteam_setup install"));
				const note = output ? `\n\n结果已写入 ${join(root(), output)}（可用 read 工具读取分析）` : "";
				return ok(`${truncate([r.stdout, r.stderr].filter(Boolean).join("\n"))}${note}`);
			},
		},
	];

	return { tools };
}
