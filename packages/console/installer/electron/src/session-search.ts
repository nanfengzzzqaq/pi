import { open, stat } from "node:fs/promises";
import type { SessionIndex } from "./session-index.ts";
import { parseUserMessage } from "./session-messages.ts";

export interface SearchMessage {
	entryId: string;
	role: "user" | "assistant";
	timestamp: number;
	text: string;
}

export interface SessionSearchHit extends SearchMessage {
	sessionId: string;
	title: string;
	cwd: string;
}

interface SearchEntry {
	id: string;
	parentId?: string | null;
	message?: SearchMessage;
}

/** Read the active branch only; compaction does not erase the searchable original transcript. */
export function parseSearchMessages(text: string): SearchMessage[] {
	const entries = new Map<string, SearchEntry>();
	let leaf: SearchEntry | undefined;
	for (const line of text.split("\n")) {
		let value: Record<string, unknown>;
		try {
			value = JSON.parse(line);
		} catch {
			continue;
		}
		if (!value || value.type === "session" || typeof value.id !== "string") continue;
		const entry: SearchEntry = { id: value.id, parentId: typeof value.parentId === "string" ? value.parentId : null };
		const message = value.message as Record<string, unknown> | undefined;
		if (value.type === "message" && message && (message.role === "user" || message.role === "assistant")) {
			const content =
				typeof message.content === "string"
					? message.content
					: Array.isArray(message.content)
						? message.content
								.filter((block) => block?.type === "text" && typeof block.text === "string")
								.map((block) => block.text)
								.join("\n")
						: "";
			const visible = message.role === "user" ? parseUserMessage(content).text : content;
			if (visible && typeof message.timestamp === "number") {
				entry.message = { entryId: entry.id, role: message.role, timestamp: message.timestamp, text: visible };
			}
		}
		entries.set(entry.id, entry);
		leaf = entry;
	}
	const branch: SearchMessage[] = [];
	const visited = new Set<string>();
	while (leaf && !visited.has(leaf.id)) {
		visited.add(leaf.id);
		if (leaf.message) branch.push(leaf.message);
		leaf = leaf.parentId ? entries.get(leaf.parentId) : undefined;
	}
	return branch.reverse();
}

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_SESSIONS = 500;
const MAX_RESULTS = 50;
const TIME_BUDGET_MS = 4000;

export class SessionSearch {
	/** Cache only a bounded amount of transcript text; configuration files are outside the search index. */
	private readonly cache = new Map<string, { signature: string; bytes: number; messages: SearchMessage[] }>();
	private cachedBytes = 0;

	async read(path: string): Promise<{ messages: SearchMessage[]; bytes: number }> {
		const info = await stat(path);
		if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error("会话记录超过搜索大小上限");
		const signature = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
		const cached = this.cache.get(path);
		if (cached?.signature === signature) return cached;
		const file = await open(path, "r");
		let text: string;
		try {
			const buffer = Buffer.alloc(info.size + 1);
			let offset = 0;
			while (offset < buffer.length) {
				const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
				if (!bytesRead) break;
				offset += bytesRead;
			}
			text = buffer.subarray(0, offset).toString("utf8");
		} finally {
			await file.close();
		}
		const messages = parseSearchMessages(text);
		if (cached) {
			this.cachedBytes -= cached.bytes;
			this.cache.delete(path);
		}
		while (this.cachedBytes + info.size > MAX_SCAN_BYTES && this.cache.size) {
			const oldest = this.cache.keys().next().value!;
			this.cachedBytes -= this.cache.get(oldest)!.bytes;
			this.cache.delete(oldest);
		}
		this.cache.set(path, { signature, bytes: info.size, messages });
		this.cachedBytes += info.size;
		return { messages, bytes: info.size };
	}

	async search(index: SessionIndex, query: string, sessionId?: string, signal?: AbortSignal) {
		const needle = query.trim().toLocaleLowerCase("zh-CN");
		const results: SessionSearchHit[] = [];
		let truncated = false;
		let skipped = 0;
		let scanned = 0;
		let bytes = 0;
		const deadline = Date.now() + TIME_BUDGET_MS;
		if (!needle) return { results, truncated, skipped, scanned };
		const entries = Object.entries(index)
			.filter(([id, entry]) => !entry.deletionRequestedAt && (!sessionId || id === sessionId))
			.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
		for (const [id, entry] of entries) {
			if (signal?.aborted) break;
			if (
				scanned >= MAX_SESSIONS ||
				bytes >= MAX_SCAN_BYTES ||
				Date.now() >= deadline ||
				results.length >= MAX_RESULTS
			) {
				truncated = true;
				break;
			}
			scanned++;
			if (!entry.sessionFile) {
				skipped++;
				continue;
			}
			try {
				const data = await this.read(entry.sessionFile);
				bytes += data.bytes;
				for (const message of data.messages) {
					const position = message.text.toLocaleLowerCase("zh-CN").indexOf(needle);
					if (position < 0) continue;
					if (results.length === MAX_RESULTS) {
						truncated = true;
						break;
					}
					const start = Math.max(0, position - 70);
					results.push({
						...message,
						text: `${start ? "…" : ""}${message.text.slice(start, start + 240)}`,
						sessionId: id,
						title: entry.title,
						cwd: entry.cwd,
					});
				}
			} catch {
				skipped++;
			}
		}
		return { results, truncated, skipped, scanned };
	}
}
