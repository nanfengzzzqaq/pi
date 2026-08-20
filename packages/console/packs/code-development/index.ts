import { resolve } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	detectProjectEnvironment,
	ensureRepositoryIdentity,
	getDeveloperComponents,
	getRepositorySummary,
	runGit,
	runGithub,
	runInDeveloperEnvironment,
	startDeveloperComponentInstall,
	type DeveloperComponentId,
} from "../../src/code-development.ts";
import type { PackContext } from "../../src/packs.ts";

function textResult(text: string, details: Record<string, unknown> = {}): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details };
}

function componentId(value: string): DeveloperComponentId {
	if (["node", "python", "java", "go", "rust", "dotnet"].includes(value)) return value as DeveloperComponentId;
	throw new Error(`不支持的开发环境：${value}`);
}

export default function definePack(ctx: PackContext) {
	const cwd = () => ctx.getWorkspaceRoot();
	const tools: ToolDefinition[] = [
		{
			name: "git_status",
			label: "查看仓库状态",
			description: "查看当前工作区是否为 Git 仓库、所在分支、远端跟踪分支和已修改文件。",
			parameters: Type.Object({}),
			execute: async () => {
				const summary = await getRepositorySummary(cwd());
				if (!summary.isRepository) return textResult("当前工作区不是 Git 仓库", summary);
				const files = summary.files.length
					? summary.files.map((file) => `${file.index}${file.worktree} ${file.path}`).join("\n")
					: "工作区干净";
				return textResult(
					`仓库：${summary.root}\n分支：${summary.branch ?? "（未命名）"}\n跟踪：${summary.upstream ?? "（未设置）"}\n\n${files}`,
					summary,
				);
			},
		},
		{
			name: "git_diff",
			label: "查看代码差异",
			description: "查看尚未暂存或已经暂存的代码差异；提交前必须使用。",
			parameters: Type.Object({
				staged: Type.Optional(Type.Boolean({ description: "是否查看已暂存差异，默认否" })),
				path: Type.Optional(Type.String({ description: "可选的单个文件路径" })),
			}),
			execute: async (_id, params) => {
				const args = ["diff", ...(params.staged ? ["--cached"] : []), "--no-ext-diff", "--unified=3"];
				if (params.path) args.push("--", params.path);
				return textResult(await runGit(args, cwd()));
			},
		},
		{
			name: "git_branch",
			label: "管理代码分支",
			description: "列出、创建或切换 Git 分支。",
			parameters: Type.Object({
				action: Type.Union([Type.Literal("list"), Type.Literal("create"), Type.Literal("switch")]),
				name: Type.Optional(Type.String({ description: "创建或切换时的分支名" })),
			}),
			execute: async (_id, params) => {
				if (params.action === "list") return textResult(await runGit(["branch", "--all", "--verbose"], cwd()));
				if (!params.name?.trim()) throw new Error("创建或切换分支时必须提供分支名");
				return textResult(
					await runGit(params.action === "create" ? ["switch", "-c", params.name] : ["switch", params.name], cwd()),
				);
			},
		},
		{
			name: "git_log",
			label: "查看提交历史",
			description: "查看提交历史：默认最近 20 条，可指定分支、作者、文件路径或关键词搜索。",
			parameters: Type.Object({
				limit: Type.Optional(Type.Number({ description: "返回的提交数量，默认 20，最大 200" })),
				branch: Type.Optional(Type.String({ description: "可选的分支、标签或修订范围" })),
				path: Type.Optional(Type.String({ description: "可选：只看某个文件的提交" })),
				grep: Type.Optional(Type.String({ description: "可选：按提交说明关键词过滤" })),
				author: Type.Optional(Type.String({ description: "可选：按作者过滤" })),
			}),
			execute: async (_id, params) => {
				const limit = Math.max(1, Math.min(Math.round(params.limit ?? 20), 200));
				const args = [
					"log",
					`--max-count=${limit}`,
					"--date=format-local:%Y-%m-%d %H:%M",
					"--pretty=format:%h %ad %an%d%n%s%n",
				];
				if (params.branch?.trim()) args.push(params.branch.trim());
				if (params.grep?.trim()) args.push(`--grep=${params.grep.trim()}`, "-i");
				if (params.author?.trim()) args.push(`--author=${params.author.trim()}`);
				args.push("--");
				if (params.path?.trim()) args.push(params.path.trim());
				const output = await runGit(args, cwd());
				return textResult(output === "（无输出）" ? "没有匹配的提交" : output);
			},
		},
		{
			name: "git_commit",
			label: "提交代码",
			description: "只暂存指定文件并创建 Git 提交；不会自动推送。只有用户明确要求提交时使用。",
			parameters: Type.Object({
				message: Type.String({ minLength: 1, description: "提交说明" }),
				paths: Type.Array(Type.String(), { minItems: 1, description: "本次要提交的明确文件路径" }),
			}),
			execute: async (_id, params) => {
				await ensureRepositoryIdentity(cwd());
				await runGit(["add", "--", ...params.paths], cwd());
				return textResult(await runGit(["commit", "-m", params.message], cwd()));
			},
		},
		{
			name: "git_sync",
			label: "同步代码仓库",
			description: "获取、快进拉取或推送 Git 分支。只有用户明确要求推送时才执行 push。",
			parameters: Type.Object({
				action: Type.Union([Type.Literal("fetch"), Type.Literal("pull"), Type.Literal("push")]),
				remote: Type.Optional(Type.String({ description: "远端名称，默认 origin" })),
				branch: Type.Optional(Type.String({ description: "推送时可设置的远端分支" })),
			}),
			execute: async (_id, params) => {
				const remote = params.remote || "origin";
				if (params.action === "fetch") return textResult(await runGit(["fetch", "--prune", remote], cwd()));
				if (params.action === "pull") return textResult(await runGit(["pull", "--ff-only", remote], cwd()));
				const args = params.branch ? ["push", "--set-upstream", remote, params.branch] : ["push", remote];
				return textResult(await runGit(args, cwd()));
			},
		},
		{
			name: "github_repository",
			label: "管理 GitHub 仓库",
			description: "列出、查看、克隆或创建 GitHub 仓库。创建仓库属于外部操作，只在用户明确要求时使用。",
			parameters: Type.Object({
				action: Type.Union([Type.Literal("list"), Type.Literal("view"), Type.Literal("clone"), Type.Literal("create")]),
				repository: Type.Optional(Type.String({ description: "owner/repo 或新仓库名" })),
				directory: Type.Optional(Type.String({ description: "克隆目标目录" })),
				private: Type.Optional(Type.Boolean({ description: "创建时是否为私有仓库，默认是" })),
				push: Type.Optional(Type.Boolean({ description: "创建仓库后是否推送当前工作区，默认否" })),
			}),
			execute: async (_id, params) => {
				if (params.action === "list") {
					return textResult(await runGithub(["repo", "list", "--limit", "100", "--json", "nameWithOwner,visibility,url"], cwd()));
				}
				if (!params.repository?.trim()) throw new Error("此操作必须提供仓库名称");
				if (params.action === "view") {
					return textResult(await runGithub(["repo", "view", params.repository, "--json", "nameWithOwner,visibility,url,defaultBranchRef"], cwd()));
				}
				if (params.action === "clone") {
					const target = params.directory ? resolve(cwd(), params.directory) : undefined;
					return textResult(await runGithub(["repo", "clone", params.repository, ...(target ? [target] : [])], cwd()));
				}
				const args = [
					"repo",
					"create",
					params.repository,
					params.private === false ? "--public" : "--private",
					"--source",
					cwd(),
					"--remote",
					"origin",
					...(params.push ? ["--push"] : []),
				];
				return textResult(await runGithub(args, cwd()));
			},
		},
		{
			name: "github_pull_request",
			label: "管理拉取请求",
			description:
				"列出、查看、创建、评论、关闭或合并拉取请求；创建时默认草稿，合并属于不可逆操作，只在用户明确要求时执行。",
			parameters: Type.Object({
				action: Type.Union([
					Type.Literal("list"),
					Type.Literal("view"),
					Type.Literal("create"),
					Type.Literal("comment"),
					Type.Literal("close"),
					Type.Literal("merge"),
					Type.Literal("checks"),
				]),
				number: Type.Optional(Type.Number({ description: "查看、评论、关闭或合并时的拉取请求编号" })),
				title: Type.Optional(Type.String({ description: "创建拉取请求时的标题" })),
				body: Type.Optional(Type.String({ description: "创建时的说明或评论内容" })),
				base: Type.Optional(Type.String({ description: "目标分支" })),
				head: Type.Optional(Type.String({ description: "创建时指定的来源分支，默认当前分支" })),
				draft: Type.Optional(Type.Boolean({ description: "是否创建草稿，默认是" })),
				mergeMethod: Type.Optional(
					Type.Union([
						Type.Literal("merge"),
						Type.Literal("squash"),
						Type.Literal("rebase"),
					]),
				),
			}),
			execute: async (_id, params) => {
				if (params.action === "list")
					return textResult(
						await runGithub(["pr", "list", "--json", "number,title,state,url,headRefName,baseRefName"], cwd()),
					);
				if (params.action === "checks") return textResult(await runGithub(["pr", "checks"], cwd()));
				if (params.action === "create") {
					// 未提供标题时用当前分支最新提交的说明，减少来回确认。
					let title = params.title?.trim() || "";
					if (!title) {
						const lastCommit = await runGit(["log", "-1", "--pretty=%s"], cwd());
						if (lastCommit !== "（无输出）") title = lastCommit.trim();
					}
					if (!title) throw new Error("创建拉取请求时必须提供标题（或先在分支上产生提交）");
					const args = [
						"pr",
						"create",
						"--title",
						title,
						"--body",
						params.body || "",
						...(params.base ? ["--base", params.base] : []),
						...(params.head ? ["--head", params.head] : []),
						...(params.draft === false ? [] : ["--draft"]),
					];
					return textResult(await runGithub(args, cwd()));
				}
				if (!params.number || params.number <= 0) throw new Error("此操作必须提供拉取请求编号（number）");
				if (params.action === "view")
					return textResult(
						await runGithub(["pr", "view", String(params.number), "--json", "number,title,state,url,body,headRefName,baseRefName"], cwd()),
					);
				if (params.action === "comment") {
					if (!params.body?.trim()) throw new Error("评论时必须提供内容（body）");
					return textResult(await runGithub(["pr", "comment", String(params.number), "--body", params.body], cwd()));
				}
				if (params.action === "close")
					return textResult(await runGithub(["pr", "close", String(params.number)], cwd()));
				const method = params.mergeMethod ?? "squash";
				return textResult(
					await runGithub(["pr", "merge", String(params.number), `--${method}`], cwd()),
				);
			},
		},
		{
			name: "github_issue",
			label: "管理仓库议题",
			description:
				"列出、查看、创建或评论 GitHub 议题（issue）。议题标题支持 [bug]/[feat] 前缀标记类型。",
			parameters: Type.Object({
				action: Type.Union([Type.Literal("list"), Type.Literal("view"), Type.Literal("create"), Type.Literal("comment")]),
				repository: Type.Optional(Type.String({ description: "可选的 owner/repo；默认当前仓库" })),
				number: Type.Optional(Type.Number({ description: "查看或评论时的议题编号" })),
				title: Type.Optional(Type.String({ description: "创建议题时的标题" })),
				body: Type.Optional(Type.String({ description: "创建时的说明或评论内容" })),
				labels: Type.Optional(Type.Array(Type.String()), { description: "创建时附加的标签" }),
			}),
			execute: async (_id, params) => {
				const repoArgs = params.repository?.trim() ? ["--repo", params.repository.trim()] : [];
				if (params.action === "list") {
					return textResult(
						await runGithub(
							["issue", "list", "--limit", "50", "--json", "number,title,state,url,labels", ...repoArgs],
							cwd(),
						),
					);
				}
				if (params.action === "create") {
					if (!params.title?.trim()) throw new Error("创建议题时必须提供标题");
					const args = [
						"issue",
						"create",
						"--title",
						params.title,
						"--body",
						params.body || "",
						...repoArgs,
					];
					for (const label of params.labels ?? []) {
						if (label.trim()) args.push("--label", label.trim());
					}
					return textResult(await runGithub(args, cwd()));
				}
				if (!params.number || params.number <= 0) throw new Error("查看或评论议题时必须提供编号（number）");
				if (params.action === "view") {
					return textResult(
						await runGithub(["issue", "view", String(params.number), "--json", "number,title,state,url,body,labels", ...repoArgs], cwd()),
					);
				}
				if (!params.body?.trim()) throw new Error("评论议题时必须提供内容（body）");
				return textResult(
					await runGithub(["issue", "comment", String(params.number), "--body", params.body, ...repoArgs], cwd()),
				);
			},
		},
		{
			name: "development_environment",
			label: "管理开发环境",
			description: "识别、查看、安装或运行代码开发插件中的 Node.js、Python、Java、Go、Rust 和 .NET 环境。",
			parameters: Type.Object({
				action: Type.Union([Type.Literal("detect"), Type.Literal("list"), Type.Literal("install"), Type.Literal("run")]),
				component: Type.Optional(Type.String({ description: "node、python、java、go、rust 或 dotnet" })),
				command: Type.Optional(Type.String({ description: "run 时执行的命令" })),
			}),
			execute: async (_id, params) => {
				if (params.action === "detect") {
					const detected = detectProjectEnvironment(cwd());
					return textResult(
						detected.componentIds.length > 0
							? `识别到：${detected.componentIds.join("、")}\n${detected.reasons.join("\n")}`
							: "未从工作区根目录识别出明确的语言环境",
						detected,
					);
				}
				if (params.action === "list") {
					const components = getDeveloperComponents();
					return textResult(
						components.map((item) => `${item.installed ? "已安装" : "未安装"} ${item.displayName}（${item.id}）`).join("\n"),
						{ components },
					);
				}
				if (!params.component) throw new Error("install 或 run 必须指定开发环境");
				const id = componentId(params.component);
				if (params.action === "install") {
					const started = startDeveloperComponentInstall(id, cwd());
					return textResult(started ? `已开始安装 ${id}，可稍后再次查看环境状态` : `${id} 已在安装中`);
				}
				if (!params.command?.trim()) throw new Error("run 必须提供要执行的命令");
				return textResult(await runInDeveloperEnvironment(id, params.command, cwd()));
			},
		},
	];
	return { tools };
}
