import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import asar from "@electron/asar";
import {
	LOCAL_AGENT_CRITICAL_FILES,
	verifyInstalledAgent,
	verifyPackagedAgent,
} from "./verify-local-agent.js";

const temporaryDirectories = [];

function createFixture() {
	const directory = mkdtempSync(join(tmpdir(), "pi-local-agent-verification-"));
	temporaryDirectories.push(directory);
	const sourceDist = join(directory, "source-dist");
	const installedDist = join(directory, "installed-dist");
	const appDirectory = join(directory, "app");
	for (const relativePath of LOCAL_AGENT_CRITICAL_FILES) {
		const content = `local:${relativePath}`;
		for (const root of [sourceDist, installedDist]) {
			const target = join(root, relativePath);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, content);
		}
		const packagedTarget = join(
			appDirectory,
			"node_modules",
			"@earendil-works",
			"pi-coding-agent",
			"dist",
			relativePath,
		);
		mkdirSync(dirname(packagedTarget), { recursive: true });
		writeFileSync(packagedTarget, content);
	}
	return { directory, sourceDist, installedDist, appDirectory };
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("accepts the same local agent before and after Electron packaging", async () => {
	const fixture = createFixture();
	assert.equal(verifyInstalledAgent(fixture.sourceDist, fixture.installedDist).length, LOCAL_AGENT_CRITICAL_FILES.length);

	const archivePath = join(fixture.directory, "app.asar");
	await asar.createPackage(fixture.appDirectory, archivePath);
	assert.equal(verifyPackagedAgent(fixture.sourceDist, archivePath).length, LOCAL_AGENT_CRITICAL_FILES.length);
});

test("rejects a registry or stale agent file with a different hash", () => {
	const fixture = createFixture();
	writeFileSync(join(fixture.installedDist, LOCAL_AGENT_CRITICAL_FILES[0]), "registry build");

	assert.throws(
		() => verifyInstalledAgent(fixture.sourceDist, fixture.installedDist),
		/本地 coding-agent 校验失败/u,
	);
});
