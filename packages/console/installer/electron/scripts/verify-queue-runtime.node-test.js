import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import asar from "@electron/asar";
import { verifyQueueRuntime } from "./verify-queue-runtime.js";

test("verifies installed and packaged queue implementation and rejects an older nested agent-core", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-queue-package-"));
	try {
		const source = join(root, "source");
		const app = join(root, "app");
		const core = join(app, "node_modules/@earendil-works/pi-agent-core");
		const agent = join(app, "node_modules/@earendil-works/pi-coding-agent");
		const manifest = { name: "@earendil-works/pi-agent-core", version: "1.0.0", type: "module", main: "./dist/index.js", exports: { ".": { import: "./dist/index.js" } } };
		for (const directory of [source, core]) {
			mkdirSync(join(directory, "dist"), { recursive: true });
			writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
			writeFileSync(join(directory, "dist/index.js"), 'export { Agent } from "./agent.js";');
			writeFileSync(join(directory, "dist/agent.js"), "export class Agent { removeQueuedMessage() {} }");
		}
		mkdirSync(join(agent, "dist"), { recursive: true });
		writeFileSync(join(agent, "dist/index.js"), "");
		verifyQueueRuntime(join(source, "dist"), { installedAgentRoot: agent });
		const archive = join(root, "app.asar");
		await asar.createPackage(app, archive);
		verifyQueueRuntime(join(source, "dist"), { archivePath: archive });
		const nested = join(agent, "node_modules/@earendil-works/pi-agent-core");
		mkdirSync(join(nested, "dist"), { recursive: true });
		writeFileSync(join(nested, "package.json"), JSON.stringify(manifest));
		writeFileSync(join(nested, "dist/index.js"), 'export { Agent } from "./agent.js";');
		writeFileSync(join(nested, "dist/agent.js"), "export class Agent {}");
		const stale = join(root, "stale.asar");
		await asar.createPackage(app, stale);
		assert.throws(() => verifyQueueRuntime(join(source, "dist"), { archivePath: stale }), /哈希不一致/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
