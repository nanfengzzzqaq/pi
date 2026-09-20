import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionIndex } from "../src/session-index.ts";
import { readSessionLibrary, updateSessionLibrary } from "../src/session-library.ts";

const directories: string[] = [];
afterEach(() => {
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "pi-library-"));
	directories.push(dir);
	const file = join(dir, "session-library.json");
	const index: SessionIndex = Object.fromEntries(
		["a", "b", "c"].map((id) => [id, { cwd: dir, title: id, createdAt: 1, updatedAt: 1 }]),
	);
	return { file, index, change: (body: unknown) => updateSessionLibrary(file, index, body) };
}
describe("persistent conversation categories", () => {
	it("moves and archives selected conversations atomically, preserving unselected ones and transcripts", () => {
		const { file, index, change } = fixture();
		const original = JSON.stringify(index);
		const id = change({ action: "create", name: "研究" }).categories[0].id;
		change({ action: "move", ids: ["a", "b"], categoryId: id });
		change({ action: "archive", ids: ["a"], archived: true });
		expect(readSessionLibrary(file).placements).toEqual({
			a: { categoryId: id, archived: true },
			b: { categoryId: id },
		});
		change({ action: "archive", ids: ["a"], archived: false });
		change({ action: "rename", id, name: "写作" });
		expect(readSessionLibrary(file).categories).toEqual([{ id, name: "写作" }]);
		change({ action: "remove", id });
		expect(readSessionLibrary(file)).toEqual({ categories: [], placements: { a: { archived: false }, b: {} } });
		expect(JSON.stringify(index)).toBe(original);
	});
	it("validates the complete batch before writing and rejects stale or deleting sessions", () => {
		const { file, index, change } = fixture();
		change({ action: "create", name: "Work" });
		const before = readFileSync(file, "utf8");
		expect(() => change({ action: "archive", ids: ["a", "missing"], archived: true })).toThrow("已变化");
		index.b.deletionRequestedAt = 2;
		expect(() => change({ action: "archive", ids: ["a", "b"], archived: true })).toThrow("已变化");
		expect(() => change({ action: "create", name: "work" })).toThrow("已存在");
		expect(() => change({ action: "move", ids: ["a"], categoryId: "missing" })).toThrow("不存在");
		expect(readFileSync(file, "utf8")).toBe(before);
	});
});
