import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import asar from "@electron/asar";
import {
	CONSOLE_CRITICAL_FILES,
	ELECTRON_ASAR_CRITICAL_FILES,
	LOCAL_AGENT_CRITICAL_FILES,
	verifyInstalledAgent,
	verifyPackagedAgent,
	verifyPackagedConsole,
	verifyPackagedElectron,
	verifyStagedConsole,
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

function createConsoleFixture() {
	const directory = mkdtempSync(join(tmpdir(), "pi-console-resource-verification-"));
	temporaryDirectories.push(directory);
	const sourceConsole = join(directory, "source-console");
	const stagedElectron = join(directory, "staged-electron");
	const unpackedApp = join(directory, "app.asar.unpacked");
	for (const relativePath of CONSOLE_CRITICAL_FILES) {
		const content = `console:${relativePath}`;
		for (const root of [sourceConsole, stagedElectron, unpackedApp]) {
			const target = join(root, relativePath);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, content);
		}
	}
	return { sourceConsole, stagedElectron, unpackedApp };
}

function addElectronFixture(directory, appDirectory) {
	const sourceElectron = join(directory, "source-electron");
	for (const relativePath of ELECTRON_ASAR_CRITICAL_FILES) {
		const content = `electron:${relativePath}`;
		for (const root of [sourceElectron, appDirectory]) {
			const target = join(root, relativePath);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, content);
		}
	}
	return sourceElectron;
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

test("accepts the same critical console resources before and after packaging", () => {
	const fixture = createConsoleFixture();
	assert.equal(
		verifyStagedConsole(fixture.sourceConsole, fixture.stagedElectron).length,
		CONSOLE_CRITICAL_FILES.length,
	);
	assert.equal(
		verifyPackagedConsole(fixture.sourceConsole, fixture.unpackedApp).length,
		CONSOLE_CRITICAL_FILES.length,
	);
});

test("rejects a stale packaged travel workflow", () => {
	const fixture = createConsoleFixture();
	writeFileSync(join(fixture.unpackedApp, "packs/travel-expense/workflow.ts"), "stale workflow");

	assert.throws(
		() => verifyPackagedConsole(fixture.sourceConsole, fixture.unpackedApp),
		/控制台关键资源校验失败/u,
	);
});

test("accepts the packaged trusted browser controller and rejects a stale one", async () => {
	const fixture = createFixture();
	const sourceElectron = addElectronFixture(fixture.directory, fixture.appDirectory);
	const archivePath = join(fixture.directory, "browser-app.asar");
	await asar.createPackage(fixture.appDirectory, archivePath);
	assert.equal(verifyPackagedElectron(sourceElectron, archivePath).length, ELECTRON_ASAR_CRITICAL_FILES.length);

	writeFileSync(join(sourceElectron, "browser-controller.js"), "new trusted controller");
	assert.throws(
		() => verifyPackagedElectron(sourceElectron, archivePath),
		/Electron 关键资源校验失败/u,
	);
});
