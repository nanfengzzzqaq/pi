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
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Type } from "typebox";
import type { PackContext } from "../../src/packs.ts";
import { DATA_DIR } from "../../src/paths.ts";
import { createConsoleCredentials } from "../../src/credentials.ts";
import { awaitInstall, getLocalStatus, promptfooBin, startInstall } from "../../src/redteam.ts";
import { runToolProcess, ToolProcessError } from "../../src/tool-process.ts";

type TextResult = AgentToolResult<unknown>;

const MAX_OUTPUT = 8000;

function ok(text: string): TextResult {
	return { content: [{ type: "text", text: text || "(无输出)" }], details: {} };
}

function fail(error: unknown): never {
	throw error instanceof Error ? error : new Error(String(error));
}

function truncate(s: string): string {
	if (s.length <= MAX_OUTPUT) return s;
	return `...(前面已截断)...\n${s.slice(-MAX_OUTPUT)}`;
}


interface ExecResult {
	stdout: string;
	stderr: string;
	code: number | string | null;
	errorMessage: string;
}

function commandFailure(command: string, result: ExecResult): TextResult | null {
	if (result.code === 0) return null;
	const detail = truncate(result.stderr || result.stdout || result.errorMessage || "没有返回错误详情");
	return fail(new Error(`${command} 失败（exit ${result.code ?? "未知"}）：\n${detail}`));
}

/** promptfoo 0.122 从 generate --help 展示策略，不再提供 redteam strategies 子命令。 */
export function parseStrategyIds(help: string): string[] {
	const block = help.match(/--strategies <strategies>([\s\S]*?)(?=\n\s+-n, --num-tests)/u)?.[1] ?? "";
	const defaults = block.match(/Defaults to:\s*-\s*default \(includes:\s*([^)]+)\)/u)?.[1] ?? "";
	const optional = block.match(/Optional:\s*-\s*([\s\S]*)/u)?.[1] ?? "";
	const ids = ["default", ...defaults.split(","), ...optional.split(",")]
		.map((value) => value.trim().replace(/\s+/gu, ""))
		.filter((value) => /^[a-z][a-z0-9:-]*$/u.test(value));
	return [...new Set(ids)];
}

function workspaceOutputPath(workspaceRoot: string, filename: string): string {
	const output = resolve(workspaceRoot, filename);
	const relativePath = relative(resolve(workspaceRoot), output);
	if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
		throw new Error("配置文件必须位于当前工作区内");
	}
	return output;
}

function yamlScalar(value: string): string {
	return JSON.stringify(value);
}

export async function resolveRedteamCredentials(refs: Record<string, string> = {}, authPath = join(DATA_DIR, "agent", "auth.json")): Promise<Record<string, string>> {
  const keys = await createConsoleCredentials(authPath).apiKeys();
  const env: Record<string, string> = {};
  for (const [name, provider] of Object.entries(refs)) {
    if (!/^[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)$/.test(name) || !/^[a-z0-9][a-z0-9._-]{0,100}$/i.test(provider)) throw new Error("凭据引用格式无效：请填写环境变量名与设置中的服务名");
    const key = keys[provider];
    if (!key) throw new Error("请先在设置中配置服务 " + provider + " 的 API Key");
    env[name] = key;
  }
  return env;
}

async function runPromptfoo(args: string[], opts: { cwd: string; timeoutMs: number; credentialRefs?: Record<string, string>; env?: Record<string, string>; signal?: AbortSignal }): Promise<ExecResult | null> {
  opts.signal?.throwIfAborted();
  const bin = promptfooBin();
  if (!bin) return null;
  const credentialEnv = await resolveRedteamCredentials(opts.credentialRefs);
  const secrets = Object.values(credentialEnv).filter(Boolean);
  const redact = (text: string) => secrets.reduce((value, secret) => value.split(secret).join("[REDACTED]"), text);
  try {
    const output = await runToolProcess(process.execPath, [bin, ...args], { cwd: opts.cwd, timeoutMs: opts.timeoutMs, signal: opts.signal, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...opts.env, ...credentialEnv } });
    return { stdout: redact(output.stdout), stderr: redact(output.stderr), code: 0, errorMessage: "" };
  } catch (error) {
    if (opts.signal?.aborted) throw new Error("红队操作已取消");
    if (error instanceof ToolProcessError) return { stdout: redact(error.stdout), stderr: redact(error.stderr), code: error.code, errorMessage: redact(error.message) };
    throw new Error(redact(error instanceof Error ? error.message : String(error)));
  }
}

const CREDENTIAL_REFS_PARAM = Type.Optional(
	Type.Record(Type.String(), Type.String(), {
		description:
			"凭据引用：环境变量名映射到设置中已配置的服务名，例如 {OPENAI_API_KEY: openai}。只填写服务名，不填写密钥。",
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
			execute: async (_toolCallId, { action, version }, signal) => {
        signal?.throwIfAborted();
        if (action === "status") {
          const status = await getLocalStatus();
          return ok("promptfoo：" + (status.installed ? "已安装" : "未安装") + "（" + (status.version ?? "未知") + "）\n安装目录：" + status.path + "\nnpm：" + (status.npmAvailable ? "可用" : "不可用"));
        }
        if (!startInstall(action === "update", { signal, version })) throw new Error("红队引擎安装已在进行中，请等待当前任务完成");
        const progress = await awaitInstall();
        return ok("promptfoo 安装完成：" + progress.version);
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
			execute: async (_toolCallId, { kind }, signal) => {
				const want = kind ?? "all";
				const sections: string[] = [];
				if (want === "plugins" || want === "all") {
					const r = await runPromptfoo(["redteam", "plugins", "--ids-only"], { cwd: root(), timeoutMs: 60_000, signal });
					if (!r) return fail(new Error("promptfoo 未安装，请先 redteam_setup install"));
					const failure = commandFailure("读取攻击插件", r);
					if (failure) return failure;
					sections.push(`【攻击插件】\n${r.stdout.trim()}`);
				}
				if (want === "strategies" || want === "all") {
					const r = await runPromptfoo(["redteam", "generate", "--help"], { cwd: root(), timeoutMs: 60_000, signal });
					if (!r) return fail(new Error("promptfoo 未安装，请先 redteam_setup install"));
					const failure = commandFailure("读取投递策略", r);
					if (failure) return failure;
					const strategies = parseStrategyIds(r.stdout);
					if (strategies.length === 0) return fail(new Error("未能从 promptfoo 帮助信息解析投递策略"));
					sections.push(`【投递策略】\n${strategies.join("\n")}`);
				}
				return ok(truncate(sections.join("\n\n")));
			},
		},
		{
			name: "redteam_init",
			label: "生成红队配置",
			description:
				"在工作区生成 promptfooconfig.yaml 红队配置。需要描述被测系统（purpose）、指定攻击模型、插件和策略。被测目标可以是任意 HTTP API 或模型 provider。默认策略与 promptfoo 0.122 保持一致。",
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
					Type.Array(Type.String(), {
						description: "投递策略，默认 ['basic','jailbreak:composite','jailbreak:meta']",
					}),
				),
				attackModel: Type.Optional(
					Type.String({ description: "攻击生成+评分模型，默认 deepseek:deepseek-v4-flash" }),
				),
				numTests: Type.Optional(Type.Number({ description: "每个插件生成几条攻击，默认 4" })),
				language: Type.Optional(Type.String({ description: "攻击样本语言，默认 Chinese" })),
				filename: Type.Optional(Type.String({ description: "配置文件名，默认 promptfooconfig.yaml" })),
			}),
			execute: async (
				_toolCallId,
				{ target, purpose, plugins, strategies, attackModel, numTests, language, filename },
			) => {
				const name = filename || "promptfooconfig.yaml";
				const list = (arr: string[], indent: string) => arr.map((value) => `${indent}- ${yamlScalar(value)}`).join("\n");
				const selectedStrategies = strategies ?? ["basic", "jailbreak:composite", "jailbreak:meta"];
				const yaml = `description: Pi 控制台红队演练

targets:
  - id: ${yamlScalar(target)}

redteam:
  provider:
    id: ${yamlScalar(attackModel || "deepseek:deepseek-v4-flash")}
  purpose: |
${purpose.split("\n").map((line: string) => `    ${line}`).join("\n")}
  language: ${yamlScalar(language || "Chinese")}
  numTests: ${numTests ?? 4}
  plugins:
${list(plugins, "    ")}
  strategies:
${list(selectedStrategies, "    ")}
`;
				try {
					const outputPath = workspaceOutputPath(root(), name);
					mkdirSync(dirname(outputPath), { recursive: true });
					writeFileSync(outputPath, yaml, "utf8");
					return ok(`配置已写入 ${outputPath}\n\n${yaml}`);
				} catch (e) {
					return fail(e);
				}
			},
		},
		{
			name: "redteam_generate",
			label: "生成攻击样本",
			description: "只生成攻击样本（redteam generate），不执行。适合先人工审查样本质量。需要攻击模型的 API key（在设置保存，通过 credentialRefs 引用）。",
			parameters: Type.Object({
				config: Type.Optional(Type.String({ description: "配置文件名，默认 promptfooconfig.yaml" })),
				disableRemoteGeneration: Type.Optional(
					Type.Boolean({ description: "禁用 promptfoo 托管生成，改用配置的攻击模型，默认 true；若该模型是云服务，仍会向其发送请求" }),
				),
				credentialRefs: CREDENTIAL_REFS_PARAM,
			}),
			execute: async (_toolCallId, { config, disableRemoteGeneration, credentialRefs }, signal) => {
				const envVars: Record<string, string> = {};
				if (disableRemoteGeneration ?? true) envVars.PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION = "true";
				const args = ["redteam", "generate"];
				if (config) args.push("-c", config);
				const r = await runPromptfoo(args, { cwd: root(), timeoutMs: 20 * 60 * 1000, env: envVars, credentialRefs, signal });
				if (!r) return fail(new Error("promptfoo 未安装，请先 redteam_setup install"));
				const failure = commandFailure("生成攻击样本", r);
				if (failure) return failure;
				return ok(truncate([r.stdout, r.stderr].filter(Boolean).join("\n")) || `exit ${r.code}`);
			},
		},
		{
			name: "redteam_run",
			label: "执行红队扫描",
			description:
				"完整红队扫描（redteam run）：生成攻击样本并对目标执行，输出通过率摘要。耗时较长（几十分钟级），期间目标系统会收到真实攻击请求。需要攻击模型 key，target 若是云端模型也需对应 key（通过 credentialRefs 引用）。",
			parameters: Type.Object({
				config: Type.Optional(Type.String({ description: "配置文件名，默认 promptfooconfig.yaml" })),
				maxConcurrency: Type.Optional(Type.Number({ description: "并发数，默认 4；目标较弱时调低" })),
				disableRemoteGeneration: Type.Optional(
					Type.Boolean({ description: "禁用 promptfoo 托管生成，使用配置的攻击模型；云模型仍会收到请求，默认 true" }),
				),
				timeoutMinutes: Type.Optional(Type.Number({ description: "超时分钟数，默认 60" })),
				credentialRefs: CREDENTIAL_REFS_PARAM,
			}),
			execute: async (
				_toolCallId,
				{ config, maxConcurrency, disableRemoteGeneration, timeoutMinutes, credentialRefs },
				signal,
			) => {
				const envVars: Record<string, string> = {};
				if (disableRemoteGeneration ?? true) envVars.PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION = "true";
				const args = ["redteam", "run"];
				if (config) args.push("-c", config);
				if (maxConcurrency) args.push("--max-concurrency", String(maxConcurrency));
				const r = await runPromptfoo(args, {
					cwd: root(),
					timeoutMs: (timeoutMinutes ?? 60) * 60 * 1000,
					env: envVars, credentialRefs, signal,
				});
				if (!r) return fail(new Error("promptfoo 未安装，请先 redteam_setup install"));
				const failure = commandFailure("执行红队扫描", r);
				if (failure) return failure;
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
				credentialRefs: CREDENTIAL_REFS_PARAM,
			}),
			execute: async (_toolCallId, { limit, credentialRefs }, signal) => {
				const r = await runPromptfoo(["list", "evals", "-n", String(limit ?? 10)], {
					cwd: root(),
					timeoutMs: 60_000,
					credentialRefs, signal,
				});
				if (!r) return fail(new Error("promptfoo 未安装，请先 redteam_setup install"));
				const failure = commandFailure("读取历史评估结果", r);
				if (failure) return failure;
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
				credentialRefs: CREDENTIAL_REFS_PARAM,
			}),
			execute: async (_toolCallId, { config, output, noCache, maxConcurrency, timeoutMinutes, credentialRefs }, signal) => {
				const args = ["eval", "-c", config];
				if (output) args.push("-o", output);
				if (noCache) args.push("--no-cache");
				if (maxConcurrency) args.push("--max-concurrency", String(maxConcurrency));
				const r = await runPromptfoo(args, {
					cwd: root(),
					timeoutMs: (timeoutMinutes ?? 30) * 60 * 1000,
					credentialRefs, signal,
				});
				if (!r) return fail(new Error("promptfoo 未安装，请先 redteam_setup install"));
				const failure = commandFailure("运行模型评估", r);
				if (failure) return failure;
				const note = output ? `\n\n结果已写入 ${join(root(), output)}（可用 read 工具读取分析）` : "";
				return ok(`${truncate([r.stdout, r.stderr].filter(Boolean).join("\n"))}${note}`);
			},
		},
	];

	return { tools };
}
