import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createConsoleCredentials } from "../src/credentials.ts";

describe("Console credentials", () => {
	it.each(["", " ", "[]", "null", "42", "false", '"credential"'])(
		"refuses all edits of structurally invalid persisted credentials: %j",
		async (damaged) => {
			const path = join(mkdtempSync(join(tmpdir(), "pi-credentials-shape-")), "auth.json");
			writeFileSync(path, "{}");
			const credentials = createConsoleCredentials(path);
			// Damage after construction: writes must validate the current bytes under the shared lock.
			writeFileSync(path, damaged);
			await expect(credentials.setApiKey("brave", "fixture")).rejects.toThrow("已保留原文件");
			await expect(credentials.deleteApiKey("brave")).rejects.toThrow("已保留原文件");
			await expect(credentials.apiKeys()).rejects.toThrow("已保留原文件");
			await expect(
				credentials.store.modify("google", async () => ({
					type: "oauth",
					access: "fixture",
					refresh: "fixture",
					expires: 123,
				})),
			).rejects.toThrow("已保留原文件");
			await expect(credentials.store.delete("google")).rejects.toThrow("已保留原文件");
			expect(readFileSync(path, "utf8")).toBe(damaged);
		},
	);

	it("preserves BOM-compatible account files across all Console credential operations", async () => {
		const path = join(mkdtempSync(join(tmpdir(), "pi-credentials-bom-")), "auth.json");
		writeFileSync(path, `\uFEFF${JSON.stringify({ brave: { type: "api_key", key: "first" } })}`);
		const credentials = createConsoleCredentials(path);
		expect(await credentials.apiKeys()).toEqual({ brave: "first" });
		await credentials.setApiKey("other", "second");
		expect(await credentials.deleteApiKey("brave")).toBe(true);
		expect(await credentials.apiKeys()).toEqual({ other: "second" });
	});

	it("preserves API-key writes queued during an OAuth credential refresh", async () => {
		const path = join(mkdtempSync(join(tmpdir(), "pi-credentials-")), "auth.json");
		const credentials = createConsoleCredentials(path);
		let entered = () => {};
		let finish = () => {};
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const refresh = credentials.store.modify("google", async () => {
			entered();
			await gate;
			return { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: 123 };
		});
		await started;
		const write = credentials.setApiKey("brave", "fixture-key");
		finish();
		await Promise.all([refresh, write]);
		expect(await credentials.apiKeys()).toEqual({ brave: "fixture-key" });
		expect((await credentials.store.list()).map((entry) => entry.providerId).sort()).toEqual(["brave", "google"]);
	});
	it("API-key deletion never deletes an OAuth credential", async () => {
		const path = join(mkdtempSync(join(tmpdir(), "pi-credentials-")), "auth.json");
		const credentials = createConsoleCredentials(path);
		await credentials.store.modify("google", async () => ({
			type: "oauth",
			access: "fixture",
			refresh: "fixture",
			expires: 123,
		}));
		expect(await credentials.deleteApiKey("google")).toBe(false);
		await credentials.setApiKey("brave", "fixture");
		expect(await credentials.deleteApiKey("brave")).toBe(true);
		expect((await credentials.store.list()).map((entry) => entry.providerId)).toEqual(["google"]);
	});
	it("does not erase a malformed credential file on edit", async () => {
		const path = join(mkdtempSync(join(tmpdir(), "pi-credentials-")), "auth.json");
		writeFileSync(path, '{"broken":');
		const credentials = createConsoleCredentials(path);
		await expect(credentials.setApiKey("brave", "fixture")).rejects.toThrow();
		expect(readFileSync(path, "utf8")).toBe('{"broken":');
	});
});
