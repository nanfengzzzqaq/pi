import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverConsoleCatalog } from "../src/antigravity-catalog-adapter.mjs";
import { createAntigravityModelRefresher } from "../src/bundled-providers.ts";

vi.mock("../src/antigravity-catalog-adapter.mjs", () => ({
	discoverConsoleCatalog: vi.fn(),
	applyConsoleCatalog: vi.fn(),
	consoleAntigravityStream: vi.fn(),
}));
const directories: string[] = [];
afterEach(() => {
	vi.resetAllMocks();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const catalog = {
	models: [
		{
			id: "claude-fixture",
			name: "Claude fixture",
			reasoning: false,
			input: ["text" as const],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		},
	],
	routing: { "claude-fixture": { defaultRequestId: "claude-fixture" } },
};
function fixture() {
	let provider: Provider | undefined = {
		id: "antigravity",
		name: "Fixture",
		auth: { apiKey: { name: "Fixture API key", resolve: async () => undefined } },
		getModels: () => [],
		stream: () => {
			throw new Error("No model calls");
		},
		streamSimple: () => {
			throw new Error("No model calls");
		},
	};
	return {
		isUsingOAuth: vi.fn(() => true),
		getModels: vi.fn(() => provider?.getModels() ?? []),
		getAuth: vi.fn(async () => ({ auth: { apiKey: "fixture" }, source: "fixture" })),
		getProvider: vi.fn(() => provider),
		registerNativeProvider: vi.fn((next: Provider) => {
			provider = next;
		}),
		refresh: vi.fn(async () => ({ aborted: false, errors: new Map<string, Error>() })),
		unload() {
			provider = undefined;
		},
		reload(next: Provider) {
			provider = next;
		},
	};
}
describe("truthful Antigravity catalog refresh", () => {
	it("requires login and coalesces concurrent metadata discovery", async () => {
		const runtime = fixture();
		runtime.isUsingOAuth.mockReturnValue(false);
		const refresh = createAntigravityModelRefresher(runtime);
		await expect(refresh()).rejects.toThrow("请先登录");
		runtime.isUsingOAuth.mockReturnValue(true);
		let done = () => {};
		const gate = new Promise<void>((resolve) => {
			done = resolve;
		});
		vi.mocked(discoverConsoleCatalog).mockImplementation(async () => {
			await gate;
			return catalog;
		});
		const first = refresh(),
			second = refresh();
		await vi.waitFor(() => expect(discoverConsoleCatalog).toHaveBeenCalledTimes(1));
		expect(refresh.status().refreshStatus).toBe("refreshing");
		done();
		expect(await Promise.all([first, second])).toEqual([1, 1]);
		expect(refresh.status()).toMatchObject({
			source: "discovered",
			refreshStatus: "success",
			discoveredModelIds: ["claude-fixture"],
		});
		expect(runtime.refresh).toHaveBeenCalledWith(
			expect.objectContaining({ allowNetwork: false, providers: ["antigravity"] }),
		);
	});
	it("retains a successful catalog and checked time after a redacted failure", async () => {
		const runtime = fixture();
		vi.mocked(discoverConsoleCatalog).mockResolvedValue(catalog);
		const refresh = createAntigravityModelRefresher(runtime);
		await refresh();
		const previous = refresh.status();
		vi.mocked(discoverConsoleCatalog).mockRejectedValue(new Error("refresh_token=private-fixture"));
		await expect(refresh()).rejects.not.toThrow("private-fixture");
		expect(refresh.status()).toMatchObject({
			source: "discovered",
			refreshStatus: "failed",
			checkedAt: previous.checkedAt,
		});
		expect(runtime.getModels()).toHaveLength(1);
	});
	it("restores cache after deferred adapter registration and after another session reloads the extension", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-catalog-"));
		directories.push(dir);
		const path = join(dir, "catalog.json");
		const runtime = fixture();
		vi.mocked(discoverConsoleCatalog).mockResolvedValue(catalog);
		await createAntigravityModelRefresher(runtime, path)();
		const original = runtime.getProvider()!;
		runtime.unload();
		const next = createAntigravityModelRefresher(runtime, path);
		expect(next.status().source).toBe("cache");
		runtime.reload({ ...original, getModels: () => [] });
		next.initialize();
		expect(runtime.getModels()).toHaveLength(1);
		runtime.reload({ ...original, getModels: () => [] });
		next.initialize();
		expect(runtime.getModels()).toHaveLength(1);
	});
	it("does not report success when activation returns errors instead of throwing", async () => {
		const runtime = fixture();
		vi.mocked(discoverConsoleCatalog).mockResolvedValue(catalog);
		runtime.refresh.mockResolvedValue({ aborted: false, errors: new Map([["antigravity", new Error("private")]]) });
		const refresh = createAntigravityModelRefresher(runtime);
		await expect(refresh()).rejects.toThrow("刷新未完成");
		expect(refresh.status().refreshStatus).toBe("failed");
	});
});
