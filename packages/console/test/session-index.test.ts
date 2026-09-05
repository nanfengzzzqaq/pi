import * as crypto from "node:crypto";
import * as fileSystem from "node:fs";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSessionIndexFile, type SessionIndex, writeSessionIndexFile } from "../src/session-index.ts";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fileSystem>();
	return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

vi.mock("node:crypto", async (importOriginal) => {
	const actual = await importOriginal<typeof crypto>();
	return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

afterEach(() => {
	vi.clearAllMocks();
});

const first: SessionIndex = { one: { cwd: "C:/fixture", title: "One", createdAt: 1, updatedAt: 2 } };
const second: SessionIndex = { ...first, two: { cwd: "C:/fixture", title: "Two", createdAt: 3, updatedAt: 4 } };

describe("durable session index", () => {
	it("leaves an existing temporary file intact when exclusive creation fails", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-index-collision-"));
		const path = join(directory, "index.json");
		writeSessionIndexFile(path, first);
		const id = "01234567-89ab-cdef-0123-456789abcdef";
		const temporary = `${path}.bak.${id}.tmp`;
		writeFileSync(temporary, "other writer");
		vi.mocked(crypto.randomUUID).mockReturnValueOnce(id);
		expect(() => writeSessionIndexFile(path, second)).toThrow();
		expect(readFileSync(temporary, "utf8")).toBe("other writer");
		expect(readSessionIndexFile(path)).toEqual(first);
	});

	it("keeps the damaged main file available when backup restoration cannot replace it", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-index-restore-failure-"));
		const path = join(directory, "index.json");
		writeSessionIndexFile(path, first);
		writeFileSync(path, "damaged");
		vi.mocked(fileSystem.renameSync).mockImplementationOnce(() => {
			throw new Error("index is locked");
		});
		expect(() => readSessionIndexFile(path)).toThrow("index is locked");
		expect(readFileSync(path, "utf8")).toBe("damaged");
		const preserved = readdirSync(directory).find((name) => name.startsWith("index.json.corrupt-"));
		expect(preserved).toBeTruthy();
		expect(readFileSync(join(directory, preserved!), "utf8")).toBe("damaged");
		expect(readdirSync(directory).some((name) => name.endsWith(".tmp"))).toBe(false);
		expect(readSessionIndexFile(path)).toEqual(first);
	});

	it("recovers a missing main file using its valid backup", () => {
		const path = join(mkdtempSync(join(tmpdir(), "pi-index-missing-")), "index.json");
		writeSessionIndexFile(path, first);
		rmSync(path);
		expect(readSessionIndexFile(path)).toEqual(first);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(first);
	});

	it("keeps a valid backup and recovers a damaged index without discarding it", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-index-"));
		const path = join(dir, "index.json");
		writeSessionIndexFile(path, first);
		writeSessionIndexFile(path, second);
		expect(readSessionIndexFile(path)).toEqual(second);
		writeFileSync(path, '{"truncated":');
		expect(readSessionIndexFile(path)).toEqual(first);
		const damaged = readdirSync(dir).find((name) => name.startsWith("index.json.corrupt-"));
		expect(damaged).toBeTruthy();
		expect(readFileSync(join(dir, damaged!), "utf8")).toBe('{"truncated":');
		expect(readdirSync(dir).some((name) => name.endsWith(".tmp"))).toBe(false);
	});
	it("refuses to overwrite corruption when no valid backup exists", () => {
		const path = join(mkdtempSync(join(tmpdir(), "pi-index-")), "index.json");
		writeFileSync(path, "[]");
		expect(() => writeSessionIndexFile(path, first)).toThrow("已保留原文件");
		expect(readFileSync(path, "utf8")).toBe("[]");
	});
	it("rejects invalid new entries before replacing a valid index", () => {
		const path = join(mkdtempSync(join(tmpdir(), "pi-index-")), "index.json");
		writeSessionIndexFile(path, first);
		expect(() => writeSessionIndexFile(path, { one: { ...first.one, updatedAt: Number.NaN } })).toThrow();
		expect(readSessionIndexFile(path)).toEqual(first);
	});
});
