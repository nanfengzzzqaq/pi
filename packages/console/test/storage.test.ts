import * as fileSystem from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateDataDirectory } from "../src/storage.ts";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fileSystem>();
	return {
		...actual,
		copyFileSync: vi.fn(actual.copyFileSync),
		readSync: vi.fn(actual.readSync),
		renameSync: vi.fn(actual.renameSync),
	};
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("Agent 数据目录迁移", () => {
	it("仅忽略顶层更新缓存，完整保留工作区中名为 update 的内容", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-storage-update-folder-"));
		const source = join(root, "source");
		const destination = join(root, "destination");
		mkdirSync(join(source, "update"), { recursive: true });
		mkdirSync(join(source, "workspaces", "project", "update"), { recursive: true });
		writeFileSync(join(source, "update", "installer.exe"), "cache");
		writeFileSync(join(source, "workspaces", "project", "update", "index.ts"), "user code");
		const result = migrateDataDirectory(destination, source, join(root, "location.json"));
		expect(result.copiedFiles).toBe(1);
		expect(existsSync(join(destination, "update"))).toBe(false);
		expect(readFileSync(join(destination, "workspaces", "project", "update", "index.ts"), "utf8")).toBe("user code");
	});

	it("逐块校验大文件及最后一个不完整块，保留旧的临时文件", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-storage-chunks-"));
		const source = join(root, "source");
		const destination = join(root, "destination");
		const config = join(root, "location.json");
		mkdirSync(source);
		mkdirSync(destination);
		const content = Buffer.alloc(4 * 1024 * 1024 + 17, 7);
		content[content.length - 1] = 42;
		writeFileSync(join(source, "large.dat"), content);
		writeFileSync(`${config}.tmp`, "earlier attempt");
		const result = migrateDataDirectory(destination, source, config);
		expect(result.copiedFiles).toBe(1);
		expect(readFileSync(join(destination, "large.dat")).equals(content)).toBe(true);
		expect(readFileSync(`${config}.tmp`, "utf8")).toBe("earlier attempt");
		expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ dataDir: destination });
		const reads = vi.mocked(fileSystem.readSync).mock.calls;
		expect(reads.length).toBeGreaterThan(2);
		for (const call of reads) {
			expect(call[1].byteLength).toBeLessThanOrEqual(64 * 1024);
		}
		expect(
			readdirSync(root).filter((name) => name.startsWith("location.json.") && name !== "location.json.tmp"),
		).toEqual([]);
	});

	it("发现后续块损坏时清理暂存数据，保留原数据、空目标和指针", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-storage-verify-"));
		const source = join(root, "source");
		const destination = join(root, "destination");
		const config = join(root, "location.json");
		mkdirSync(source);
		mkdirSync(destination);
		const content = Buffer.alloc(3 * 64 * 1024 + 11, 7);
		writeFileSync(join(source, "data.dat"), content);
		writeFileSync(config, JSON.stringify({ dataDir: source }));
		vi.mocked(fileSystem.copyFileSync).mockImplementationOnce((from, to) => {
			const damaged = readFileSync(from);
			damaged[damaged.length - 1] = 8;
			writeFileSync(to, damaged);
		});
		expect(() => migrateDataDirectory(destination, source, config)).toThrow("迁移文件校验失败");
		expect(readFileSync(join(source, "data.dat")).equals(content)).toBe(true);
		expect(readdirSync(destination)).toEqual([]);
		expect(JSON.parse(readFileSync(config, "utf8")).dataDir).toBe(source);
		expect(readdirSync(root).some((name) => name.startsWith(".pi-migration-"))).toBe(false);
	});

	it("指针替换失败时清理本次临时文件，并保留旧指针与可恢复的副本", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-storage-pointer-"));
		const source = join(root, "source");
		const destination = join(root, "destination");
		const config = join(root, "location.json");
		mkdirSync(source);
		writeFileSync(join(source, "data.dat"), "original");
		writeFileSync(config, JSON.stringify({ dataDir: source }));
		const rename = vi.mocked(fileSystem.renameSync).getMockImplementation()!;
		vi.mocked(fileSystem.renameSync)
			.mockImplementationOnce(rename)
			.mockImplementationOnce(() => {
				throw new Error("pointer is locked");
			});
		expect(() => migrateDataDirectory(destination, source, config)).toThrow("原数据仍可使用");
		expect(readFileSync(join(source, "data.dat"), "utf8")).toBe("original");
		expect(readFileSync(join(destination, "data.dat"), "utf8")).toBe("original");
		expect(JSON.parse(readFileSync(config, "utf8")).dataDir).toBe(source);
		expect(
			readdirSync(root).filter((name) => name.startsWith("location.json.") || name.startsWith(".pi-migration-")),
		).toEqual([]);
	});

	it("原目录不存在时不创建目标或位置指针", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-storage-missing-"));
		const source = join(root, "source");
		const destination = join(root, "destination");
		const config = join(root, "location.json");
		expect(() => migrateDataDirectory(destination, source, config)).toThrow("原数据目录不存在");
		expect(existsSync(destination)).toBe(false);
		expect(existsSync(config)).toBe(false);
	});

	it("拒绝覆盖非空目标，保留双方数据与位置指针", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-storage-conflict-"));
		const source = join(root, "source");
		const destination = join(root, "destination");
		const config = join(root, "location.json");
		mkdirSync(source);
		mkdirSync(destination);
		writeFileSync(join(source, "auth.json"), "source");
		writeFileSync(join(destination, "auth.json"), "destination");
		writeFileSync(config, JSON.stringify({ dataDir: source }));
		expect(() => migrateDataDirectory(destination, source, config)).toThrow("必须为空");
		expect(readFileSync(join(source, "auth.json"), "utf8")).toBe("source");
		expect(readFileSync(join(destination, "auth.json"), "utf8")).toBe("destination");
		expect(JSON.parse(readFileSync(config, "utf8")).dataDir).toBe(source);
	});

	it("元数据损坏时不会更新位置指针", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-storage-invalid-"));
		const source = join(root, "source");
		const config = join(root, "location.json");
		mkdirSync(source);
		writeFileSync(join(source, "sessions-index.json"), "broken");
		writeFileSync(config, JSON.stringify({ dataDir: source }));
		expect(() => migrateDataDirectory(join(root, "target"), source, config)).toThrow();
		expect(JSON.parse(readFileSync(config, "utf8")).dataDir).toBe(source);
	});
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
