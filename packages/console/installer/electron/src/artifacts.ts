/** 从智能体回复中提取可能的本地文件引用；实际存在性与访问范围由 fs 模块校验。 */

const MAX_REFERENCES = 32;

function normalizeReference(raw: string): string | null {
	let value = raw.trim().replace(/^<|>$/g, "");
	value = value.replace(/[，。；：！？,;:!?]+$/u, "");
	if (/^https?:\/\//i.test(value)) return null;
	if (/^file:\/\//i.test(value)) {
		try {
			const url = new URL(value);
			value = decodeURIComponent(url.pathname);
			if (/^\/[A-Za-z]:\//.test(value)) value = value.slice(1);
		} catch {
			return null;
		}
	}
	return value || null;
}

export function extractFileReferences(text: string): string[] {
	const references: string[] = [];
	const seen = new Set<string>();
	const collect = (raw: string): void => {
		if (references.length >= MAX_REFERENCES) return;
		const value = normalizeReference(raw);
		if (!value) return;
		const key = process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
		if (seen.has(key)) return;
		seen.add(key);
		references.push(value);
	};

	const mask = (value: string): string => " ".repeat(value.length);
	let scan = text.replace(/\[[^\]]*\]\(([^)\n]+)\)/g, (match, target: string) => {
		collect(target);
		return mask(match);
	});
	// 网页地址中可能以 .pdf 等结尾，但它不是本地文件。
	scan = scan.replace(/https?:\/\/[^\s)]+/gi, (match) => mask(match));
	scan = scan.replace(/file:\/\/\/[^\s)]+/gi, (match) => {
		collect(match);
		return mask(match);
	});
	scan = scan.replace(
		/[A-Za-z]:[\\/][^<>\n\r|?*"]+?\.[A-Za-z0-9]{1,16}(?=$|[\s，。；：！？,;:!?)\]】}])/g,
		(match) => {
			collect(match);
			return mask(match);
		},
	);
	scan = scan.replace(
		/(?:\.{0,2}[\\/])?(?:[\p{L}\p{N}_()（）【】[\].-]+[\\/])+[\p{L}\p{N}_()（）【】[\].-]+\.[A-Za-z0-9]{1,16}/gu,
		(match) => {
			collect(match);
			return mask(match);
		},
	);
	for (const match of scan.matchAll(/[\p{L}\p{N}_()（）【】[\]-]+\.[A-Za-z0-9]{1,16}/gu)) collect(match[0]);

	return references;
}
