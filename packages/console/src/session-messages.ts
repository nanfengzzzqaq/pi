const JSON_ATTACHMENT_PREFIX = "[附件文件:";

export interface ParsedUserMessage {
	text: string;
	attachments: string[];
}

/**
 * 把附件路径写进 Pi 原生用户消息，既让模型能读取文件，也让重启后的历史记录可以还原附件卡片。
 */
export function appendAttachmentAnnotation(text: string, attachments: string[]): string {
	const cleanText = text.trim();
	if (attachments.length === 0) return cleanText;
	const annotation = `${JSON_ATTACHMENT_PREFIX} ${JSON.stringify(attachments)}]`;
	return cleanText ? `${cleanText}\n${annotation}` : annotation;
}

/** 从新旧两种附件标记中恢复正文和附件路径；旧标记兼容 0.3.12 及更早版本。 */
export function parseUserMessage(text: string): ParsedUserMessage {
	const attachments: string[] = [];
	const seen = new Set<string>();
	const add = (path: string): void => {
		const value = path.trim();
		if (!value || seen.has(value)) return;
		seen.add(value);
		attachments.push(value);
	};

	let visibleText = text.replace(/^\[附件文件:\s*(\[[^\n]*\])\]\s*$/gmu, (_match, encoded: string) => {
		try {
			const paths = JSON.parse(encoded) as unknown;
			if (Array.isArray(paths)) {
				for (const path of paths) if (typeof path === "string") add(path);
			}
		} catch {
			// 标记损坏时隐藏内部数据，但不阻断其余历史消息恢复。
		}
		return "";
	});

	visibleText = visibleText.replace(/^\[附件:\s*(.*?)\]\s*$/gmu, (_match, paths: string) => {
		for (const path of paths.split(/,\s+/)) add(path);
		return "";
	});

	return { text: visibleText.replace(/\n{3,}/g, "\n\n").trim(), attachments };
}
