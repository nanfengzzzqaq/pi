import { appendFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionIndex } from "../src/session-index.ts";
import { appendAttachmentAnnotation } from "../src/session-messages.ts";
import { parseSearchMessages, SessionSearch } from "../src/session-search.ts";

const directories: string[] = [];
afterEach(() => {
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function message(id: string, parentId: string | null, text: string, role = "user") {
	return JSON.stringify({
		type: "message",
		id,
		parentId,
		message: {
			role,
			timestamp: 100,
			content: [
				{ type: "text", text },
				{ type: "thinking", thinking: "PRIVATE_THINKING" },
			],
		},
	});
}
function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "pi-search-"));
	directories.push(directory);
	const path = join(directory, "session.jsonl");
	const index: SessionIndex = {
		first: { title: "Test", cwd: directory, sessionFile: path, createdAt: 1, updatedAt: 1 },
	};
	return { path, index, search: new SessionSearch() };
}
describe("bounded transcript search", () => {
	it("searches only the active branch, retaining originals before compaction and ignoring a partial trailing write", () => {
		const lines = [
			message("a", null, appendAttachmentAnnotation("预算问题", ["uploads/secret-name.txt"])),
			message("old", "a", "abandoned"),
			message("new", "a", "预算答复", "assistant"),
			JSON.stringify({ type: "compaction", id: "compact", parentId: "new", summary: "summary" }),
			message("last", "compact", "new turn"),
			'{"type":',
		];
		const parsed = parseSearchMessages(lines.join("\n"));
		expect(parsed.map((item) => item.entryId)).toEqual(["a", "new", "last"]);
		expect(parsed[0].text).toBe("预算问题");
		expect(JSON.stringify(parsed)).not.toContain("PRIVATE_THINKING");
	});
	it("searches old user and assistant messages, refreshes cached transcripts, and respects session/deletion scope", async () => {
		const { path, index, search } = fixture();
		writeFileSync(path, `${message("a", null, "预算问题")}\n${message("b", "a", "预算答复", "assistant")}\n`);
		expect((await search.search(index, "预算")).results.map((item) => item.role)).toEqual(["user", "assistant"]);
		appendFileSync(path, `${message("c", "b", "NEW answer", "assistant")}\n`);
		expect((await search.search(index, "new")).results[0].entryId).toBe("c");
		expect((await search.search(index, "预算", "absent")).scanned).toBe(0);
		index.first.deletionRequestedAt = 1;
		expect((await search.search(index, "预算")).results).toEqual([]);
	});
	it("bounds results, rejects oversized files and stops cancelled work", async () => {
		const { path, index, search } = fixture();
		writeFileSync(
			path,
			Array.from({ length: 80 }, (_, i) => message(String(i), i ? String(i - 1) : null, "match")).join("\n"),
		);
		const result = await search.search(index, "match");
		expect(result.results).toHaveLength(50);
		expect(result.truncated).toBe(true);
		truncateSync(path, 17 * 1024 * 1024);
		expect((await search.search(index, "match")).skipped).toBe(1);
		expect((await search.search(index, "match", undefined, AbortSignal.abort())).scanned).toBe(0);
	});
	it("terminates on a corrupt parent cycle", () => {
		expect(parseSearchMessages([message("a", "b", "A"), message("b", "a", "B")].join("\n"))).toHaveLength(2);
	});
});
