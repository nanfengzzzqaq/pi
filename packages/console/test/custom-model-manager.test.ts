import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConsoleCredentials } from "../src/credentials.ts";
import { createCustomModelManager } from "../src/custom-model-manager.ts";
import * as customModels from "../src/custom-models.ts";

vi.mock("../src/custom-models.ts", async (importOriginal) => {
	const original = await importOriginal<typeof customModels>();
	return { ...original, writeCustomModels: vi.fn(original.writeCustomModels) };
});
const directories: string[] = [];
afterEach(() => {
	vi.clearAllMocks();
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
async function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "pi-model-transaction-"));
	directories.push(directory);
	const file = join(directory, "custom-models.json"),
		authFile = join(directory, "auth.json");
	const credentials = createConsoleCredentials(authFile);
	const runtime = await ModelRuntime.create({
		credentials: credentials.store,
		modelsPath: null,
		refreshOnCreate: false,
	});
	const manager = createCustomModelManager(file, credentials, runtime);
	const definition = customModels.normalizeCustomModel("pi-console-custom-fixture", {
		name: "Fixture",
		baseUrl: "http://127.0.0.1:12345/v1",
		modelId: "fixture",
	});
	return { directory, file, authFile, credentials, runtime, manager, definition };
}
describe("custom model transactions", () => {
	it("serializes model/key edits and deletion without losing another provider", async () => {
		const { manager, definition, file, credentials } = await fixture();
		const other = { ...definition, providerId: "pi-console-custom-other" };
		await Promise.all([
			manager.save(definition, "first-fixture"),
			manager.save(other, "other-fixture"),
			manager.save({ ...definition, name: "Updated" }, "second-fixture"),
		]);
		expect(
			customModels.loadCustomModels(file).find((model) => model.providerId === definition.providerId)?.name,
		).toBe("Updated");
		expect(await credentials.apiKeys()).toMatchObject({
			[definition.providerId]: "second-fixture",
			[other.providerId]: "other-fixture",
		});
		await manager.clearApiKey(definition.providerId);
		expect(customModels.loadCustomModels(file)).toHaveLength(2);
		expect(await credentials.apiKeys()).not.toHaveProperty(definition.providerId);
		await manager.remove(definition.providerId);
		expect(customModels.loadCustomModels(file)).toHaveLength(1);
		expect(await credentials.apiKeys()).toEqual({ [other.providerId]: "other-fixture" });
	}, 15000);
	it("rolls back credentials when the configuration commit fails, then safely discards the uncommitted journal", async () => {
		const { manager, definition, file, credentials, authFile } = await fixture();
		await manager.save(definition, "first-fixture");
		const before = readFileSync(authFile, "utf8");
		vi.mocked(customModels.writeCustomModels).mockImplementationOnce(() => {
			throw new Error("disk failure");
		});
		await expect(manager.save({ ...definition, name: "Uncommitted" }, "replacement-fixture")).rejects.toThrow(
			"disk failure",
		);
		expect(readFileSync(authFile, "utf8")).toBe(before);
		expect(customModels.loadCustomModels(file)[0].name).toBe("Fixture");
		expect(existsSync(`${file}.pending.json`)).toBe(true);
		expect(readFileSync(`${file}.pending.json`, "utf8")).not.toContain("replacement-fixture");
		await manager.recover();
		expect(existsSync(`${file}.pending.json`)).toBe(false);
		expect(await credentials.apiKeys()).toEqual({ [definition.providerId]: "first-fixture" });
	}, 15000);
	it("replays a journal after credentials were committed but model configuration was interrupted", async () => {
		const { manager, definition, file, credentials } = await fixture();
		await credentials.store.modify(definition.providerId, async () => ({
			type: "api_key",
			key: "fixture",
			consoleModelRevision: "revision-fixture",
		}));
		writeFileSync(
			`${file}.pending.json`,
			JSON.stringify({
				providerId: definition.providerId,
				revision: "revision-fixture",
				kind: "save",
				models: [definition],
			}),
		);
		await manager.recover();
		expect(customModels.loadCustomModels(file)).toEqual([definition]);
		expect(existsSync(`${file}.pending.json`)).toBe(false);
	});
	it("retains malformed recovery records and reports runtime activation failures without lying about persistence", async () => {
		const { manager, definition, file, runtime } = await fixture();
		writeFileSync(`${file}.pending.json`, "damaged");
		await expect(manager.recover()).rejects.toThrow();
		expect(readFileSync(`${file}.pending.json`, "utf8")).toBe("damaged");
		rmSync(`${file}.pending.json`);
		vi.spyOn(runtime, "refresh").mockResolvedValue({
			aborted: false,
			errors: new Map([[definition.providerId, new Error("activation")]]),
		});
		expect((await manager.save(definition, "fixture")).runtimePending).toBe(true);
		expect(customModels.loadCustomModels(file)).toEqual([definition]);
	});
	it("requires explicit no-auth mode and sends no Authorization header to a local model endpoint", async () => {
		const { manager, definition, runtime } = await fixture();
		await expect(manager.save(definition)).rejects.toThrow("明确选择无需鉴权");
		let authorization: string | undefined;
		const server = createServer((req, res) => {
			authorization = req.headers.authorization;
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(
				'data: {"id":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
			);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Missing test port");
			await manager.save({ ...definition, baseUrl: `http://127.0.0.1:${address.port}/v1`, authMode: "none" });
			const model = runtime.getModels(definition.providerId)[0];
			const result = await runtime.completeSimple(
				model,
				{ messages: [{ role: "user", content: "fixture", timestamp: 0 }] },
				{ maxTokens: 16 },
			);
			expect(result.stopReason).toBe("stop");
			expect(authorization).toBeUndefined();
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	}, 15000);
});
