/** Pi 智能体可调用的客户端内置浏览器工具。 */
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentBrowserTarget, getAgentBrowserRuntime } from "./agent-browser-runtime.ts";

function result(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: {} };
}

function target(params: { ref?: string; selector?: string; text?: string }): AgentBrowserTarget {
	if (!params.ref && !params.selector && !params.text) {
		throw new Error("请提供页面快照中的 ref、CSS selector 或可见文字之一");
	}
	return { ref: params.ref, selector: params.selector, text: params.text };
}

function workspaceOutput(cwd: string, requested: string | undefined): string {
	const output = resolve(cwd, requested?.trim() || `browser-screenshot-${Date.now()}.png`);
	const rel = relative(cwd, output);
	if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("截图只能保存到当前工作区内");
	return output;
}

const targetParameters = {
	ref: Type.Optional(Type.String({ description: "browser_snapshot 返回的元素编号，如 e12" })),
	selector: Type.Optional(Type.String({ description: "CSS 选择器；优先使用稳定的 ref" })),
	text: Type.Optional(Type.String({ description: "元素的可见文字；找不到 ref 时使用" })),
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
			description: "在 Pi 客户端的独立浏览器中打开网址。它与用户自己的 Chrome 窗口和账号目录隔离。",
			parameters: Type.Object({ url: Type.String({ description: "完整网址，如 https://example.com" }) }),
			execute: async (_id, params) => {
				const state = await browser().navigate(params.url);
				return result(`已打开：${state.title || state.url}\n${state.url}`);
			},
		}),
		defineTool({
			name: "browser_snapshot",
			label: "获取页面状态",
			description:
				"读取当前网页的精简语义结构和可操作元素编号。优先用它定位元素；不会把完整 HTML 或截图送入上下文。",
			parameters: Type.Object({
				maxChars: Type.Optional(
					Type.Integer({ minimum: 1000, maximum: 12000, description: "最多返回字符数，默认 6000" }),
				),
			}),
			execute: async (_id, params) => result(await browser().snapshot(params.maxChars ?? 6000)),
		}),
		defineTool({
			name: "browser_click",
			label: "点击页面元素",
			description: "点击页面快照中的元素。优先传 ref，必要时使用 CSS selector 或可见文字。",
			parameters: Type.Object(targetParameters),
			execute: async (_id, params) => result(await browser().click(target(params))),
		}),
		defineTool({
			name: "browser_type",
			label: "输入页面内容",
			description: "向输入框、文本框或可编辑元素写入内容，可在输入后按回车提交。",
			parameters: Type.Object({
				...targetParameters,
				value: Type.String({ description: "要输入的内容" }),
				submit: Type.Optional(Type.Boolean({ description: "输入后是否按回车提交，默认否" })),
			}),
			execute: async (_id, params) =>
				result(await browser().type(target(params), params.value, params.submit === true)),
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
	];
}
