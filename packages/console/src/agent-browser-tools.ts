/** Pi 智能体可调用的客户端内置浏览器工具。 */
import { readFileSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type AgentBrowserTarget,
	type AgentBrowserUploadFile,
	agentBrowserUploadOrigin,
	getAgentBrowserRuntime,
	redactSensitiveText,
	resolveSensitiveBrowserUrl,
} from "./agent-browser-runtime.ts";

const UPLOAD_MIME_TYPES: Record<string, string> = {
	".bmp": "image/bmp",
	".doc": "application/msword",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".gif": "image/gif",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".json": "application/json",
	".ofd": "application/ofd",
	".pdf": "application/pdf",
	".png": "image/png",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".txt": "text/plain",
	".webp": "image/webp",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".zip": "application/zip",
};
const MAX_UPLOAD_FILE_BYTES = 20 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES = 50 * 1024 * 1024;
const SNAPSHOT_MIN_CHARS = 1000;
const SNAPSHOT_MAX_CHARS = 12000;
const SNAPSHOT_MIN_ELEMENTS = 20;
const SNAPSHOT_MAX_ELEMENTS = 1000;

function clampSnapshotLimit(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(value ?? fallback, maximum));
}

/** 读取要上传的本地文件：支持工作区相对路径与绝对路径，限制单文件与总体积。 */
export function readAgentBrowserUploadFiles(cwd: string, paths: string[]): AgentBrowserUploadFile[] {
	const files: AgentBrowserUploadFile[] = [];
	let total = 0;
	for (const requested of paths) {
		if (typeof requested !== "string" || !requested.trim()) throw new Error("上传路径不能为空");
		const file = isAbsolute(requested) ? resolve(requested) : resolve(cwd, requested);
		const stats = statSync(file);
		if (!stats.isFile()) throw new Error(`不是可上传的文件：${file}`);
		if (stats.size > MAX_UPLOAD_FILE_BYTES) {
			throw new Error(`文件 ${basename(file)} 超过 ${MAX_UPLOAD_FILE_BYTES / 1024 / 1024}MB 上传上限`);
		}
		total += stats.size;
		if (total > MAX_UPLOAD_TOTAL_BYTES) {
			throw new Error(`上传附件总量超过 ${MAX_UPLOAD_TOTAL_BYTES / 1024 / 1024}MB 上限`);
		}
		const extension = file.slice(file.lastIndexOf(".")).toLocaleLowerCase("en-US");
		files.push({
			name: basename(file),
			mimeType: UPLOAD_MIME_TYPES[extension] ?? "application/octet-stream",
			dataBase64: readFileSync(file).toString("base64"),
		});
	}
	if (files.length === 0) throw new Error("请至少提供一个要上传的文件路径");
	return files;
}

function result(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: redactSensitiveText(text) }], details: {} };
}

function optionalTarget(params: AgentBrowserTarget): AgentBrowserTarget | undefined {
	if (!params.ref && !params.selector && !params.text && !params.scopeTexts?.length && !params.within)
		return undefined;
	return {
		ref: params.ref,
		selector: params.selector,
		text: params.text,
		occurrence: params.occurrence,
		scopeTexts: params.scopeTexts,
		within: params.within,
	};
}

function target(params: AgentBrowserTarget): AgentBrowserTarget {
	const resolved = optionalTarget(params);
	if (!resolved?.ref && !resolved?.selector && !resolved?.text) {
		throw new Error("请提供页面快照中的 ref、CSS selector 或可见文字之一");
	}
	return resolved;
}

function workspaceOutput(cwd: string, requested: string | undefined): string {
	const output = resolve(cwd, requested?.trim() || `browser-screenshot-${Date.now()}.png`);
	const rel = relative(cwd, output);
	if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("截图只能保存到当前工作区内");
	return output;
}

const locatorParameters = {
	ref: Type.Optional(Type.String({ description: "browser_snapshot 返回的元素编号，如 e12" })),
	selector: Type.Optional(Type.String({ description: "CSS 选择器；优先使用稳定的 ref" })),
	text: Type.Optional(Type.String({ description: "元素的可见文字；找不到 ref 时使用精确匹配" })),
	occurrence: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 1000, description: "匹配到多个元素时选择第几个（从 1 开始）" }),
	),
};

const targetParameters = {
	...locatorParameters,
	scopeTexts: Type.Optional(
		Type.Array(Type.String(), {
			minItems: 1,
			maxItems: 8,
			description: "目标附近同一容器内必须同时出现的文字，例如出发城市、到达城市和金额",
		}),
	),
	within: Type.Optional(
		Type.Object(locatorParameters, {
			description: "先定位一个容器，再只在该容器内查找目标",
		}),
	),
};

export function instantiateAgentBrowserTools(cwd: string): ToolDefinition[] {
	const browser = () => {
		const runtime = getAgentBrowserRuntime();
		runtime.setDownloadDirectory(cwd);
		return runtime;
	};
	return [
		defineTool({
			name: "browser_navigate",
			label: "打开网页",
			description:
				"在 Pi 客户端的独立浏览器中打开网址。它与用户自己的 Chrome 窗口和账号目录隔离；消息里的安全网址引用必须原样传入。",
			parameters: Type.Object({ url: Type.String({ description: "完整网址，如 https://example.com" }) }),
			execute: async (_id, params) => {
				try {
					const state = await browser().navigate(resolveSensitiveBrowserUrl(params.url));
					return result(`已打开：${state.title || state.url}\n${state.url}`);
				} catch (error) {
					throw new Error(redactSensitiveText(error instanceof Error ? error.message : String(error)));
				}
			},
		}),
		defineTool({
			name: "browser_snapshot",
			label: "获取页面状态",
			description:
				"读取当前网页的精简语义结构和可操作元素编号，优先返回最上层弹窗/抽屉；可用 scopeTexts 只看某条明细。隐藏的文件输入框也会带 ref。",
			parameters: Type.Object({
				maxChars: Type.Optional(
					Type.Integer({
						minimum: 100,
						maximum: 50000,
						description: "期望返回的字符数；运行时会安全限制在 1000–12000，默认 6000",
					}),
				),
				maxElements: Type.Optional(
					Type.Integer({
						minimum: 1,
						maximum: 5000,
						description: "期望返回的元素数；运行时会安全限制在 20–1000，默认 500",
					}),
				),
				scopeTexts: Type.Optional(
					Type.Array(Type.String(), {
						minItems: 1,
						maxItems: 8,
						description: "只返回同一页面区域内同时包含这些文字的元素",
					}),
				),
			}),
			execute: async (_id, params) =>
				result(
					await browser().snapshot({
						maxChars: clampSnapshotLimit(params.maxChars, 6000, SNAPSHOT_MIN_CHARS, SNAPSHOT_MAX_CHARS),
						maxElements: clampSnapshotLimit(
							params.maxElements,
							500,
							SNAPSHOT_MIN_ELEMENTS,
							SNAPSHOT_MAX_ELEMENTS,
						),
						scopeTexts: params.scopeTexts,
					}),
				),
		}),
		defineTool({
			name: "browser_click",
			label: "点击页面元素",
			description:
				"用真实鼠标事件点击页面元素。优先传 ref；重复元素用 occurrence，或用 scopeTexts/within 限定到同一条明细。",
			parameters: Type.Object(targetParameters),
			execute: async (_id, params) => result(await browser().click(target(params))),
		}),
		defineTool({
			name: "browser_hover",
			label: "悬浮页面元素",
			description: "把真实鼠标移动到页面元素上，用于显示悬浮菜单（如“添加发票”下的“智能识票”）。",
			parameters: Type.Object(targetParameters),
			execute: async (_id, params) => result(await browser().hover(target(params))),
		}),
		defineTool({
			name: "browser_type",
			label: "输入页面内容",
			description:
				"向输入框、文本框或可编辑元素写入内容，可在普通网页输入后按回车确认；易快报页面强制禁止按回车，避免意外提交整张表单。",
			parameters: Type.Object({
				...targetParameters,
				value: Type.String({ description: "要输入的内容" }),
				submit: Type.Optional(
					Type.Boolean({ description: "输入后是否按回车确认，默认否；易快报页面不允许设为 true" }),
				),
				commit: Type.Optional(
					Type.Boolean({ description: "输入后是否失焦以持久化字段，默认是；搜索下拉候选时设为否" }),
				),
			}),
			execute: async (_id, params) => {
				const runtime = browser();
				if (params.submit === true) {
					try {
						const hostname = new URL(runtime.state().url).hostname;
						if (/(^|\.)ekuaibao\.com$/i.test(hostname)) {
							throw new Error("安全策略已禁止在易快报页面通过回车确认，以免触发表单提交；请点击明确的候选项");
						}
					} catch (error) {
						if (error instanceof Error && error.message.startsWith("安全策略已禁止")) throw error;
					}
				}
				return result(
					await runtime.type(target(params), params.value, params.submit === true, params.commit !== false),
				);
			},
		}),
		defineTool({
			name: "browser_scroll",
			label: "滚动网页",
			description: "按指定方向滚动当前网页。",
			parameters: Type.Object({
				direction: Type.Union([
					Type.Literal("up"),
					Type.Literal("down"),
					Type.Literal("left"),
					Type.Literal("right"),
				]),
				amount: Type.Optional(Type.Integer({ minimum: 100, maximum: 5000, description: "滚动像素，默认 700" })),
			}),
			execute: async (_id, params) => result(await browser().scroll(params.direction, params.amount ?? 700)),
		}),
		defineTool({
			name: "browser_extract",
			label: "读取网页内容",
			description: "读取整个页面或指定 CSS selector 区域的可见文字，并限制返回长度以节省 token。",
			parameters: Type.Object({
				selector: Type.Optional(Type.String({ description: "可选 CSS selector；不填则读取页面正文" })),
				maxChars: Type.Optional(
					Type.Integer({ minimum: 500, maximum: 20000, description: "最多返回字符数，默认 8000" }),
				),
			}),
			execute: async (_id, params) => result(await browser().extract(params.selector, params.maxChars ?? 8000)),
		}),
		defineTool({
			name: "browser_screenshot",
			label: "网页截图",
			description: "仅在需要检查视觉布局时截图，并把 PNG 保存到当前工作区；普通页面读取应使用 browser_snapshot。",
			parameters: Type.Object({
				path: Type.Optional(Type.String({ description: "工作区内的输出路径，如 screenshots/page.png" })),
			}),
			execute: async (_id, params) => {
				const output = workspaceOutput(cwd, params.path);
				await mkdir(dirname(output), { recursive: true });
				return result(await browser().screenshot(output));
			},
		}),
		defineTool({
			name: "browser_wait",
			label: "等待网页",
			description: "等待网页加载、动画完成或指定文字出现。",
			parameters: Type.Object({
				milliseconds: Type.Optional(
					Type.Integer({ minimum: 100, maximum: 30000, description: "最长等待时间，默认 2000 毫秒" }),
				),
				text: Type.Optional(Type.String({ description: "可选；等待此文字在页面中出现" })),
			}),
			execute: async (_id, params) => result(await browser().wait(params.milliseconds ?? 2000, params.text)),
		}),
		defineTool({
			name: "browser_upload",
			label: "上传附件",
			description:
				"把本地文件定向上传到当前网页的文件输入框。先悬浮/点击打开上传弹窗并重新快照，优先传弹窗内隐藏 file input 的 ref；重复 selector 必须给 occurrence，也可用 scopeTexts/within 限定明细。指定目标不存在时绝不回退到全页。单文件 ≤20MB，总量 ≤50MB。",
			parameters: Type.Object({
				paths: Type.Array(Type.String(), {
					minItems: 1,
					description: '要上传的本地文件路径列表，如 ["tickets/去程票.png", "tickets/查验.png"]',
				}),
				...targetParameters,
			}),
			execute: async (_id, params) => {
				const runtime = browser();
				const allowedOrigin = agentBrowserUploadOrigin(runtime.state().url);
				const files = readAgentBrowserUploadFiles(cwd, params.paths);
				return result(await runtime.uploadFiles(files, optionalTarget(params), allowedOrigin));
			},
		}),
	];
}
