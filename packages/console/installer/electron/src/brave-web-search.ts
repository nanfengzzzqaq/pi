/**
 * Brave LLM Context 固定请求与响应映射。
 * 本文件只做两件事：构造 Brave /res/v1/llm/context 的固定请求体，以及把响应
 * 映射为供应商中立的证据结构。不包含 UI、DLP 或通用输出逻辑（见 web-search-tools.ts）。
 *
 * 云端只返回检索证据（按 URL 分组的网页片段）；归纳、判断和最终答复一律由
 * 本地主模型完成。绝不调用 Brave Answers、chat completions 或任何云端生成
 * 答案的接口。
 * 端点文档：https://api-dashboard.search.brave.com/api-reference/summarizer/llm_context/post
 */

/** 固定端点，不做任何配置化。 */
export const BRAVE_LLM_CONTEXT_URL = "https://api.search.brave.com/res/v1/llm/context";

/** 请求体只允许包含查询词和固定检索参数；严禁附加会话、系统提示词或本地数据。 */
export function buildBraveContextRequestBody(query: string): Record<string, unknown> {
	return {
		q: query,
		count: 10,
		maximum_number_of_urls: 8,
		maximum_number_of_tokens: 4096,
		maximum_number_of_tokens_per_url: 1024,
		maximum_number_of_snippets: 32,
		context_threshold_mode: "balanced",
		safesearch: "moderate",
		enable_source_metadata: true,
	};
}

/** Brave grounding.generic 条目映射后的已抽取证据。 */
export interface BraveGroundedItem {
	url: string;
	title: string | undefined;
	snippets: string[];
}

/** sources 对象（按 URL 键）中单个来源的元数据。 */
export interface BraveSourceMetadata {
	url: string;
	title: string | undefined;
	siteName: string | undefined;
	description: string | undefined;
	publishedAt: string | undefined;
}

export interface BraveContextEvidence {
	/** grounding.generic 中带有效 URL 的条目（已抽取证据）。 */
	grounded: BraveGroundedItem[];
	/** sources 中出现的全部来源元数据（含已抽取与仅元数据）。 */
	sourceMetadata: BraveSourceMetadata[];
}

function textOrUndefined(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function toStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

/** Brave source metadata stores page dates in age; prefer its ISO value, then its display date. */
function sourceDate(entry: Record<string, unknown>): string | undefined {
	const age = Array.isArray(entry.age) ? entry.age : [];
	return (
		textOrUndefined(age[3]) ??
		textOrUndefined(age[1]) ??
		textOrUndefined(entry.published_at) ??
		textOrUndefined(entry.publishedAt) ??
		textOrUndefined(entry.date)
	);
}

export function parseBraveContextResponse(body: unknown): BraveContextEvidence {
	const grounding = (body as { grounding?: unknown } | null)?.grounding;
	const generic =
		typeof grounding === "object" && grounding !== null ? (grounding as { generic?: unknown }).generic : undefined;
	const grounded: BraveGroundedItem[] = [];
	if (Array.isArray(generic)) {
		for (const item of generic) {
			if (typeof item !== "object" || item === null) continue;
			const entry = item as Record<string, unknown>;
			const url = textOrUndefined(entry.url);
			if (!url) continue;
			grounded.push({
				url,
				title: textOrUndefined(entry.title),
				snippets: toStringArray(entry.snippets),
			});
		}
	}

	const sources = (body as { sources?: unknown } | null)?.sources;
	const sourceMetadata: BraveSourceMetadata[] = [];
	if (typeof sources === "object" && sources !== null && !Array.isArray(sources)) {
		for (const [url, raw] of Object.entries(sources as Record<string, unknown>)) {
			const entry = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
			sourceMetadata.push({
				url,
				title: textOrUndefined(entry.title),
				siteName: textOrUndefined(entry.site_name),
				description: textOrUndefined(entry.description),
				publishedAt: sourceDate(entry),
			});
		}
	}

	return { grounded, sourceMetadata };
}
