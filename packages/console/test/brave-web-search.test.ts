import { describe, expect, it } from "vitest";
import { buildBraveContextRequestBody, parseBraveContextResponse } from "../src/brave-web-search.ts";

describe("Brave LLM Context 请求与响应映射", () => {
	it("构造只含查询词与固定检索参数的请求体", () => {
		expect(buildBraveContextRequestBody("qwen3 最新版本")).toEqual({
			q: "qwen3 最新版本",
			count: 10,
			maximum_number_of_urls: 8,
			maximum_number_of_tokens: 4096,
			maximum_number_of_tokens_per_url: 1024,
			maximum_number_of_snippets: 32,
			context_threshold_mode: "balanced",
			safesearch: "moderate",
			enable_source_metadata: true,
		});
		// 不包含会话、系统提示词、本地文件或 reasoning 字段。
		const serialized = JSON.stringify(buildBraveContextRequestBody("测试"));
		expect(serialized).not.toContain("messages");
		expect(serialized).not.toContain("systemPrompt");
		expect(serialized).not.toContain("reasoning");
	});

	it("解析 grounding.generic 与 sources，保留标题、片段、日期和 URL", () => {
		const evidence = parseBraveContextResponse({
			grounding: {
				generic: [
					{
						name: "Example",
						url: "https://example.com/a",
						title: "文章 A",
						snippets: ["片段一", "片段二", "", "片段三"],
					},
					{ url: "https://example.com/b", snippets: ["片段 B"] },
					{ title: "缺 URL 的条目被忽略", snippets: ["x"] },
				],
			},
			sources: {
				"https://example.com/a": {
					title: "文章 A 元数据",
					site_name: "Example",
					age: ["3 days ago", "2026-09-01", "September 1, 2026", "2026-09-01T08:30:00Z"],
				},
				"https://example.com/c": { site_name: "站点 C" },
			},
		});
		expect(evidence.grounded).toEqual([
			{ url: "https://example.com/a", title: "文章 A", snippets: ["片段一", "片段二", "片段三"] },
			{ url: "https://example.com/b", title: undefined, snippets: ["片段 B"] },
		]);
		expect(evidence.sourceMetadata).toEqual([
			{
				url: "https://example.com/a",
				title: "文章 A 元数据",
				siteName: "Example",
				description: undefined,
				publishedAt: "2026-09-01T08:30:00Z",
			},
			{
				url: "https://example.com/c",
				title: undefined,
				siteName: "站点 C",
				description: undefined,
				publishedAt: undefined,
			},
		]);
	});

	it("容忍缺失 grounding/sources 与非对象响应", () => {
		expect(parseBraveContextResponse({})).toEqual({ grounded: [], sourceMetadata: [] });
		expect(parseBraveContextResponse({ grounding: { generic: [] } })).toEqual({ grounded: [], sourceMetadata: [] });
		expect(parseBraveContextResponse(null)).toEqual({ grounded: [], sourceMetadata: [] });
		expect(parseBraveContextResponse({ sources: ["not-an-object"] })).toEqual({ grounded: [], sourceMetadata: [] });
	});
});
