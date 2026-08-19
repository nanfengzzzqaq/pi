import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrateDataDirectory } from "../src/storage.ts";

describe("Agent 数据目录迁移", () => {
	it("复制数据并改写会话中的旧绝对路径", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-storage-test-"));
		const source = join(root, "old-data");
		const destination = join(root, "new-data");
		const config = join(root, "storage-location.json");
		mkdirSync(join(source, "sessions"), { recursive: true });
		writeFileSync(join(source, "sessions", "one.jsonl"), "session\n", "utf8");
		writeFileSync(
			join(source, "sessions-index.json"),
			JSON.stringify({
				one: { cwd: join(source, "workspaces", "one"), sessionFile: join(source, "sessions", "one.jsonl") },
			}),
			"utf8",
		);

		const result = migrateDataDirectory(destination, source, config);
		const index = JSON.parse(readFileSync(join(destination, "sessions-index.json"), "utf8"));
		expect(result.restartRequired).toBe(true);
		expect(result.copiedFiles).toBe(2);
		expect(index.one.cwd).toBe(join(destination, "workspaces", "one"));
		expect(index.one.sessionFile).toBe(join(destination, "sessions", "one.jsonl"));
		expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ dataDir: destination });
	});

	it("拒绝把新目录放进旧目录内部", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-storage-test-"));
		const source = join(root, "data");
		mkdirSync(source, { recursive: true });
		expect(() => migrateDataDirectory(join(source, "nested"), source, join(root, "config.json"))).toThrow(
			"不能互相包含",
		);
	});
});
