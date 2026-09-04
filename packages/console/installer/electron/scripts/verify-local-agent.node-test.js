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
	LOCAL_AI_CRITICAL_FILES,
	verifyInstalledAgent,
	verifyInstalledAi,
	verifyPackagedAgent,
	verifyPackagedAi,
	verifyPackagedConsole,
	verifyPackagedElectron,
	verifyStagedConsole,
} from "./verify-local-agent.js";

const temporaryDirectories = [];
const AGENT_RUNTIME_FIXTURE_FILES = [
	...new Set([
		...LOCAL_AGENT_CRITICAL_FILES,
		"index.js",
		"index.d.ts",
		"rpc-entry.js",
		"rpc-entry.d.ts",
		"client/index.js",
		"client/index.d.ts",
	]),
];
const AI_RUNTIME_FIXTURE_FILES = [
	...new Set([
		...LOCAL_AI_CRITICAL_FILES,
		"index.d.ts",
		"compat.js",
		"compat.d.ts",
		"oauth.js",
		"oauth.d.ts",
		"providers/all.js",
		"providers/all.d.ts",
		"api/openai-completions.d.ts",
		"bedrock-provider.js",
		"bedrock-provider.d.ts",
		"bun-oauth.js",
		"bun-oauth.d.ts",
	]),
];

function createFixture() {
	const directory = mkdtempSync(join(tmpdir(), "pi-local-agent-verification-"));
	temporaryDirectories.push(directory);
	const sourceAgentRoot = join(directory, "source-agent");
	const installedAgentRoot = join(directory, "installed-agent");
	const sourceDist = join(sourceAgentRoot, "dist");
	const installedDist = join(installedAgentRoot, "dist");
	const appDirectory = join(directory, "app");
	const packagedAgentRoot = join(
		appDirectory,
		"node_modules",
		"@earendil-works",
		"pi-coding-agent",
	);
	for (const relativePath of AGENT_RUNTIME_FIXTURE_FILES) {
		const content = `local:${relativePath}`;
		for (const root of [sourceDist, installedDist]) {
			const target = join(root, relativePath);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, content);
		}
		if (!relativePath.endsWith(".d.ts")) {
			const packagedTarget = join(packagedAgentRoot, "dist", relativePath);
			mkdirSync(dirname(packagedTarget), { recursive: true });
			writeFileSync(packagedTarget, content);
		}
	}
	for (const packageRoot of [sourceAgentRoot, installedAgentRoot, packagedAgentRoot]) {
		mkdirSync(packageRoot, { recursive: true });
		writeFileSync(join(packageRoot, "package.json"), JSON.stringify(createAgentManifest()));
	}
	return {
		directory,
		sourceAgentRoot,
		sourceDist,
		installedAgentRoot,
		installedDist,
		appDirectory,
		packagedAgentRoot,
	};
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

function createAiManifest(overrides = {}) {
	return {
		name: "@earendil-works/pi-ai",
		version: "0.84.2",
		type: "module",
		main: "./dist/index.js",
		exports: {
			".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
			"./compat": { types: "./dist/compat.d.ts", import: "./dist/compat.js" },
			"./providers/*": { types: "./dist/providers/*.d.ts", import: "./dist/providers/*.js" },
			"./api/*": { types: "./dist/api/*.d.ts", import: "./dist/api/*.js" },
			"./oauth": { types: "./dist/oauth.d.ts", import: "./dist/oauth.js" },
			"./bedrock-provider": {
				types: "./dist/bedrock-provider.d.ts",
				import: "./dist/bedrock-provider.js",
			},
			"./bun-oauth": { types: "./dist/bun-oauth.d.ts", import: "./dist/bun-oauth.js" },
		},
		dependencies: {
			"fixture-dependency-b": "2.0.0",
			"fixture-dependency-a": "1.0.0",
		},
		...overrides,
	};
}

function writeAiManifest(packageRoot, overrides) {
	writeFileSync(join(packageRoot, "package.json"), JSON.stringify(createAiManifest(overrides)));
}

function createAgentManifest(overrides = {}) {
	return {
		name: "@earendil-works/pi-coding-agent",
		version: "0.84.2",
		type: "module",
		main: "./dist/index.js",
		exports: {
			".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
			"./rpc-entry": { import: "./dist/rpc-entry.js" },
			"./client": { types: "./dist/client/index.d.ts", import: "./dist/client/index.js" },
		},
		dependencies: {
			"@earendil-works/pi-ai": "^0.84.2",
			"@earendil-works/pi-agent-core": "^0.84.2",
		},
		...overrides,
	};
}

function writeAgentManifest(packageRoot, overrides) {
	writeFileSync(join(packageRoot, "package.json"), JSON.stringify(createAgentManifest(overrides)));
}

function writeBomManifest(packageRoot, manifest) {
	writeFileSync(join(packageRoot, "package.json"), `\uFEFF${JSON.stringify(manifest)}`);
}

function createAiFixture({ nestedRegistryCopy = false, rootOnly = false, rootRegistryCopy = false } = {}) {
	const directory = mkdtempSync(join(tmpdir(), "pi-local-ai-verification-"));
	temporaryDirectories.push(directory);
	const sourceAiRoot = join(directory, "source-ai");
	const sourceAiDist = join(sourceAiRoot, "dist");
	const appDirectory = join(directory, "app");
	const installedAgentRoot = join(appDirectory, "node_modules", "@earendil-works", "pi-coding-agent");
	const nestedAiRoot = join(installedAgentRoot, "node_modules", "@earendil-works", "pi-ai");
	const installedAiRoot = nestedRegistryCopy || rootOnly
		? join(appDirectory, "node_modules", "@earendil-works", "pi-ai")
		: nestedAiRoot;
	const installedAiDist = join(installedAiRoot, "dist");
	for (const relativePath of AI_RUNTIME_FIXTURE_FILES) {
		const content =
			relativePath === "providers/data/deepseek.json"
				? JSON.stringify({
						"openai-completions": {
							"deepseek-v4-flash": {
								compat: {
									supportsToolChoiceWithThinking: false,
									requiresReasoningContentOnAssistantMessages: true,
									requiresAssistantContentOnToolCalls: true,
									thinkingFormat: "deepseek",
								},
							},
							"deepseek-v4-flash-vision-exp": { input: ["text", "image"] },
						},
					})
				: `local-ai:${relativePath}`;
		const targetRoots = rootOnly && relativePath.endsWith(".d.ts") ? [sourceAiDist] : [sourceAiDist, installedAiDist];
		for (const root of targetRoots) {
			const target = join(root, relativePath);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, content);
		}
	}
	writeAiManifest(sourceAiRoot);
	mkdirSync(join(installedAgentRoot, "dist"), { recursive: true });
	writeFileSync(
		join(installedAgentRoot, "package.json"),
		JSON.stringify(createAgentManifest()),
	);
	writeFileSync(join(installedAgentRoot, "dist", "index.js"), 'import "@earendil-works/pi-ai";');
	writeAiManifest(installedAiRoot);
	if (nestedRegistryCopy) {
		mkdirSync(join(nestedAiRoot, "dist"), { recursive: true });
		writeAiManifest(nestedAiRoot);
		writeFileSync(join(nestedAiRoot, "dist", "index.js"), "registry ai");
	}
	if (rootRegistryCopy && !nestedRegistryCopy && !rootOnly) {
		const rootAiRoot = join(appDirectory, "node_modules", "@earendil-works", "pi-ai");
		mkdirSync(join(rootAiRoot, "dist"), { recursive: true });
		writeAiManifest(rootAiRoot);
		writeFileSync(join(rootAiRoot, "dist", "index.js"), "deduped registry ai");
	}
	return { directory, sourceAiRoot, sourceAiDist, appDirectory, installedAgentRoot, installedAiDist };
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

test("rejects a stale non-critical coding-agent runtime file before and after packaging", async () => {
	const installedFixture = createFixture();
	writeFileSync(join(installedFixture.installedDist, "index.js"), "stale agent index");
	assert.throws(
		() => verifyInstalledAgent(installedFixture.sourceDist, installedFixture.installedDist),
		/完整 dist 树 文件哈希不一致：index\.js/u,
	);

	const packagedFixture = createFixture();
	writeFileSync(join(packagedFixture.packagedAgentRoot, "dist", "index.js"), "stale agent index");
	const archivePath = join(packagedFixture.directory, "stale-agent-index.asar");
	await asar.createPackage(packagedFixture.appDirectory, archivePath);
	assert.throws(
		() => verifyPackagedAgent(packagedFixture.sourceDist, archivePath),
		/完整 dist 树 文件哈希不一致：index\.js/u,
	);
});

test("rejects a missing coding-agent runtime file before and after packaging", async () => {
	const installedFixture = createFixture();
	rmSync(join(installedFixture.installedDist, "rpc-entry.js"));
	assert.throws(
		() => verifyInstalledAgent(installedFixture.sourceDist, installedFixture.installedDist),
		/完整 dist 树 缺少源码 dist 文件：rpc-entry\.js/u,
	);

	const packagedFixture = createFixture();
	rmSync(join(packagedFixture.packagedAgentRoot, "dist", "rpc-entry.js"));
	const archivePath = join(packagedFixture.directory, "missing-agent-runtime.asar");
	await asar.createPackage(packagedFixture.appDirectory, archivePath);
	assert.throws(
		() => verifyPackagedAgent(packagedFixture.sourceDist, archivePath),
		/完整 dist 树 缺少源码 dist 文件：rpc-entry\.js/u,
	);
});

test("rejects an extra coding-agent runtime file before and after packaging", async () => {
	const installedFixture = createFixture();
	writeFileSync(join(installedFixture.installedDist, "rogue-runtime.js"), "rogue agent runtime");
	assert.throws(
		() => verifyInstalledAgent(installedFixture.sourceDist, installedFixture.installedDist),
		/完整 dist 树 包含源码 dist 之外的额外文件：rogue-runtime\.js/u,
	);

	const packagedFixture = createFixture();
	writeFileSync(
		join(packagedFixture.packagedAgentRoot, "dist", "rogue-runtime.js"),
		"rogue agent runtime",
	);
	const archivePath = join(packagedFixture.directory, "extra-agent-runtime.asar");
	await asar.createPackage(packagedFixture.appDirectory, archivePath);
	assert.throws(
		() => verifyPackagedAgent(packagedFixture.sourceDist, archivePath),
		/完整 dist 树 包含源码 dist 之外的额外文件：rogue-runtime\.js/u,
	);
});

for (const [label, overrides, errorPattern] of [
	["name", { name: "@registry/pi-coding-agent" }, /name 与可信源码不一致/u],
	["version", { version: "0.84.3" }, /version 与可信源码不一致/u],
	["type", { type: "commonjs" }, /type 与可信源码不一致/u],
	[
		"exports",
		{
			exports: {
				".": {
					types: "./dist/index.d.ts",
					node: "./dist/index.js",
					import: "./dist/index.js",
				},
				"./rpc-entry": { import: "./dist/rpc-entry.js" },
				"./client": { types: "./dist/client/index.d.ts", import: "./dist/client/index.js" },
			},
		},
		/exports（含键顺序）与可信源码不一致/u,
	],
	[
		"dependencies",
		{
			dependencies: {
				"@earendil-works/pi-ai": "^0.84.3",
				"@earendil-works/pi-agent-core": "^0.84.2",
			},
		},
		/dependencies 与可信源码不一致/u,
	],
]) {
	test(`rejects installed and packaged coding-agent manifest ${label} mismatch`, async () => {
		const installedFixture = createFixture();
		writeAgentManifest(installedFixture.installedAgentRoot, overrides);
		assert.throws(
			() => verifyInstalledAgent(installedFixture.sourceDist, installedFixture.installedDist),
			errorPattern,
		);

		const packagedFixture = createFixture();
		writeAgentManifest(packagedFixture.packagedAgentRoot, overrides);
		const archivePath = join(packagedFixture.directory, `agent-${label}-mismatch.asar`);
		await asar.createPackage(packagedFixture.appDirectory, archivePath);
		assert.throws(
			() => verifyPackagedAgent(packagedFixture.sourceDist, archivePath),
			errorPattern,
		);
	});
}

test("accepts coding-agent dependency key reordering with identical values", async () => {
	const reorderedDependencies = {
		"@earendil-works/pi-agent-core": "^0.84.2",
		"@earendil-works/pi-ai": "^0.84.2",
	};
	const installedFixture = createFixture();
	writeAgentManifest(installedFixture.installedAgentRoot, {
		dependencies: reorderedDependencies,
	});
	assert.equal(
		verifyInstalledAgent(installedFixture.sourceDist, installedFixture.installedDist).length,
		LOCAL_AGENT_CRITICAL_FILES.length,
	);

	const packagedFixture = createFixture();
	writeAgentManifest(packagedFixture.packagedAgentRoot, {
		dependencies: reorderedDependencies,
	});
	const archivePath = join(packagedFixture.directory, "agent-reordered-dependencies.asar");
	await asar.createPackage(packagedFixture.appDirectory, archivePath);
	assert.equal(
		verifyPackagedAgent(packagedFixture.sourceDist, archivePath).length,
		LOCAL_AGENT_CRITICAL_FILES.length,
	);
});

test("rejects unsafe export conditions in the trusted coding-agent source manifest", () => {
	const fixture = createFixture();
	const exports = createAgentManifest().exports;
	exports["."] = {
		types: "./dist/index.d.ts",
		node: "./dist/index.js",
		import: "./dist/index.js",
	};
	writeAgentManifest(fixture.sourceAgentRoot, { exports });
	assert.throws(
		() => verifyInstalledAgent(fixture.sourceDist, fixture.installedDist),
		/可信本地 coding-agent package.json 的导出条件无效/u,
	);
});

test("rejects non-canonical targets in the trusted coding-agent source manifest", () => {
	const fixture = createFixture();
	const exports = createAgentManifest().exports;
	exports["./rpc-entry"] = { import: "./dist/../dist/rpc-entry.js" };
	writeAgentManifest(fixture.sourceAgentRoot, { exports });
	assert.throws(
		() => verifyInstalledAgent(fixture.sourceDist, fixture.installedDist),
		/可信本地 coding-agent package.json 的导出条件无效/u,
	);
});

for (const [label, importTarget] of [
	["backslash", "./dist\\rpc-entry.js"],
	["query", "./dist/rpc-entry.js?node"],
	["hash", "./dist/rpc-entry.js#node"],
	["percent escape", "./dist/%72pc-entry.js"],
	["node_modules segment", "./dist/node_modules/rpc-entry.js"],
]) {
	test(`rejects a ${label} target in the trusted coding-agent source manifest`, () => {
		const fixture = createFixture();
		const exports = createAgentManifest().exports;
		exports["./rpc-entry"] = { import: importTarget };
		writeAgentManifest(fixture.sourceAgentRoot, { exports });
		assert.throws(
			() => verifyInstalledAgent(fixture.sourceDist, fixture.installedDist),
			/可信本地 coding-agent package.json 的导出条件无效/u,
		);
	});
}

test("accepts one UTF-8 BOM on trusted, installed, and packaged coding-agent manifests", async () => {
	const installedFixture = createFixture();
	writeBomManifest(installedFixture.sourceAgentRoot, createAgentManifest());
	writeBomManifest(installedFixture.installedAgentRoot, createAgentManifest());
	assert.equal(
		verifyInstalledAgent(installedFixture.sourceDist, installedFixture.installedDist).length,
		LOCAL_AGENT_CRITICAL_FILES.length,
	);

	const packagedFixture = createFixture();
	writeBomManifest(packagedFixture.sourceAgentRoot, createAgentManifest());
	writeBomManifest(packagedFixture.packagedAgentRoot, createAgentManifest());
	const archivePath = join(packagedFixture.directory, "bom-agent-manifests.asar");
	await asar.createPackage(packagedFixture.appDirectory, archivePath);
	assert.equal(
		verifyPackagedAgent(packagedFixture.sourceDist, archivePath).length,
		LOCAL_AGENT_CRITICAL_FILES.length,
	);
});

test("accepts the same import-only local pi-ai and proves coding-agent resolves that exact installed copy", () => {
	const fixture = createAiFixture();
	assert.equal(
		verifyInstalledAi(fixture.sourceAiDist, fixture.installedAiDist, fixture.installedAgentRoot).length,
		LOCAL_AI_CRITICAL_FILES.length,
	);
});

test("accepts the activated nested local pi-ai before packaging but rejects a duplicate root copy in the archive", async () => {
	const fixture = createAiFixture({ rootRegistryCopy: true });
	assert.equal(
		verifyInstalledAi(fixture.sourceAiDist, fixture.installedAiDist, fixture.installedAgentRoot).length,
		LOCAL_AI_CRITICAL_FILES.length,
	);

	const archivePath = join(fixture.directory, "deduped-root-ai-app.asar");
	await asar.createPackage(fixture.appDirectory, archivePath);
	assert.throws(
		() => verifyPackagedAi(fixture.sourceAiDist, archivePath),
		/包含多份可解析的 pi-ai/u,
	);
});

test("rejects a root pi-ai copy when coding-agent still resolves a nested registry copy", () => {
	const fixture = createAiFixture({ nestedRegistryCopy: true });
	assert.throws(
		() => verifyInstalledAi(fixture.sourceAiDist, fixture.installedAiDist, fixture.installedAgentRoot),
		/仍会解析到 registry 或嵌套的 pi-ai/u,
	);
});

test("rejects a packaged root local pi-ai when a higher-priority nested registry copy remains", async () => {
	const fixture = createAiFixture({ nestedRegistryCopy: true });
	const archivePath = join(fixture.directory, "nested-registry-ai-app.asar");
	await asar.createPackage(fixture.appDirectory, archivePath);
	assert.throws(
		() => verifyPackagedAi(fixture.sourceAiDist, archivePath),
		/包含多份可解析的 pi-ai/u,
	);
});

test("rejects a root-only pi-ai even when its import entry matches the local build", () => {
	const fixture = createAiFixture({ rootOnly: true });
	assert.throws(
		() => verifyInstalledAi(fixture.sourceAiDist, fixture.installedAiDist, fixture.installedAgentRoot),
		/仍会解析到 registry 或嵌套的 pi-ai/u,
	);
});

test("accepts the builder-hoisted root-only local pi-ai in the packaged archive", async () => {
	const fixture = createAiFixture({ rootOnly: true });
	const archivePath = join(fixture.directory, "root-only-local-ai-app.asar");
	await asar.createPackage(fixture.appDirectory, archivePath);
	assert.equal(verifyPackagedAi(fixture.sourceAiDist, archivePath).length, LOCAL_AI_CRITICAL_FILES.length);
});

for (const relativePath of ["compat.js", "providers/all.js"]) {
	test(`rejects stale pi-ai runtime file ${relativePath} before and after packaging`, async () => {
		const installedFixture = createAiFixture();
		writeFileSync(join(installedFixture.installedAiDist, relativePath), "stale ai runtime");
		assert.throws(
			() =>
				verifyInstalledAi(
					installedFixture.sourceAiDist,
					installedFixture.installedAiDist,
					installedFixture.installedAgentRoot,
				),
			new RegExp(`完整 dist 树 文件哈希不一致：${relativePath.replace(".", "\\.")}`, "u"),
		);

		const packagedFixture = createAiFixture({ rootOnly: true });
		writeFileSync(join(packagedFixture.installedAiDist, relativePath), "stale ai runtime");
		const archivePath = join(
			packagedFixture.directory,
			`stale-ai-${relativePath.replaceAll("/", "-")}.asar`,
		);
		await asar.createPackage(packagedFixture.appDirectory, archivePath);
		assert.throws(
			() => verifyPackagedAi(packagedFixture.sourceAiDist, archivePath),
			new RegExp(`完整 dist 树 文件哈希不一致：${relativePath.replace(".", "\\.")}`, "u"),
		);
	});
}

test("rejects a missing pi-ai oauth runtime before and after packaging", async () => {
	const installedFixture = createAiFixture();
	rmSync(join(installedFixture.installedAiDist, "oauth.js"));
	assert.throws(
		() =>
			verifyInstalledAi(
				installedFixture.sourceAiDist,
				installedFixture.installedAiDist,
				installedFixture.installedAgentRoot,
			),
		/完整 dist 树 缺少源码 dist 文件：oauth\.js/u,
	);

	const packagedFixture = createAiFixture({ rootOnly: true });
	rmSync(join(packagedFixture.installedAiDist, "oauth.js"));
	const archivePath = join(packagedFixture.directory, "missing-ai-oauth.asar");
	await asar.createPackage(packagedFixture.appDirectory, archivePath);
	assert.throws(
		() => verifyPackagedAi(packagedFixture.sourceAiDist, archivePath),
		/完整 dist 树 缺少源码 dist 文件：oauth\.js/u,
	);
});

test("rejects an extra pi-ai runtime file before and after packaging", async () => {
	const installedFixture = createAiFixture();
	writeFileSync(join(installedFixture.installedAiDist, "providers", "rogue.js"), "rogue ai runtime");
	assert.throws(
		() =>
			verifyInstalledAi(
				installedFixture.sourceAiDist,
				installedFixture.installedAiDist,
				installedFixture.installedAgentRoot,
			),
		/完整 dist 树 包含源码 dist 之外的额外文件：providers\/rogue\.js/u,
	);

	const packagedFixture = createAiFixture({ rootOnly: true });
	writeFileSync(join(packagedFixture.installedAiDist, "providers", "rogue.js"), "rogue ai runtime");
	const archivePath = join(packagedFixture.directory, "extra-ai-runtime.asar");
	await asar.createPackage(packagedFixture.appDirectory, archivePath);
	assert.throws(
		() => verifyPackagedAi(packagedFixture.sourceAiDist, archivePath),
		/完整 dist 树 包含源码 dist 之外的额外文件：providers\/rogue\.js/u,
	);
});

test("accepts one UTF-8 BOM on trusted and resolved pi-ai package manifests", async () => {
	const installedFixture = createAiFixture();
	writeBomManifest(installedFixture.sourceAiRoot, createAiManifest());
	writeBomManifest(dirname(installedFixture.installedAiDist), createAiManifest());
	assert.equal(
		verifyInstalledAi(
			installedFixture.sourceAiDist,
			installedFixture.installedAiDist,
			installedFixture.installedAgentRoot,
		).length,
		LOCAL_AI_CRITICAL_FILES.length,
	);

	const packagedFixture = createAiFixture({ rootOnly: true });
	writeBomManifest(packagedFixture.sourceAiRoot, createAiManifest());
	writeBomManifest(dirname(packagedFixture.installedAiDist), createAiManifest());
	writeBomManifest(packagedFixture.installedAgentRoot, createAgentManifest());
	const archivePath = join(packagedFixture.directory, "bom-ai-manifests.asar");
	await asar.createPackage(packagedFixture.appDirectory, archivePath);
	assert.equal(
		verifyPackagedAi(packagedFixture.sourceAiDist, archivePath).length,
		LOCAL_AI_CRITICAL_FILES.length,
	);
});

test("rejects a stale pi-ai in the hidden node_modules/node_modules resolution slot", async () => {
	const fixture = createAiFixture({ rootOnly: true });
	const hiddenAiRoot = join(
		fixture.appDirectory,
		"node_modules",
		"node_modules",
		"@earendil-works",
		"pi-ai",
	);
	mkdirSync(join(hiddenAiRoot, "dist"), { recursive: true });
	writeFileSync(
		join(hiddenAiRoot, "package.json"),
		JSON.stringify({
			name: "@earendil-works/pi-ai",
			type: "module",
			exports: { ".": { import: "./dist/index.js" } },
		}),
	);
	writeFileSync(join(hiddenAiRoot, "dist", "index.js"), "hidden stale ai");
	const archivePath = join(fixture.directory, "hidden-stale-ai.asar");
	await asar.createPackage(fixture.appDirectory, archivePath);
	assert.throws(
		() => verifyPackagedAi(fixture.sourceAiDist, archivePath),
		/包含多份可解析的 pi-ai/u,
	);
});

test("rejects a manifestless higher-priority pi-ai override", async () => {
	const fixture = createAiFixture({ rootOnly: true });
	const overrideRoot = join(
		fixture.installedAgentRoot,
		"node_modules",
		"@earendil-works",
		"pi-ai",
	);
	mkdirSync(overrideRoot, { recursive: true });
	writeFileSync(join(overrideRoot, "index.js"), "manifestless stale ai");
	const archivePath = join(fixture.directory, "manifestless-stale-ai.asar");
	await asar.createPackage(fixture.appDirectory, archivePath);
	assert.throws(
		() => verifyPackagedAi(fixture.sourceAiDist, archivePath),
		/包含多份可解析的 pi-ai/u,
	);
});

test("rejects a deep manifestless pi-ai override below an importing dist directory", async () => {
	const fixture = createAiFixture({ rootOnly: true });
	const overrideRoot = join(
		fixture.installedAgentRoot,
		"dist",
		"core",
		"node_modules",
		"@earendil-works",
		"pi-ai",
	);
	mkdirSync(overrideRoot, { recursive: true });
	writeFileSync(join(overrideRoot, "index.js"), "deep manifestless stale ai");
	const archivePath = join(fixture.directory, "deep-manifestless-stale-ai.asar");
	await asar.createPackage(fixture.appDirectory, archivePath);
	assert.throws(
		() => verifyPackagedAi(fixture.sourceAiDist, archivePath),
		/包含多份可解析的 pi-ai/u,
	);
});

test("rejects a stale pi-ai nested under the root pi-agent-core consumer", async () => {
	const fixture = createAiFixture({ rootOnly: true });
	const consumerAiRoot = join(
		fixture.appDirectory,
		"node_modules",
		"@earendil-works",
		"pi-agent-core",
		"node_modules",
		"@earendil-works",
		"pi-ai",
	);
	mkdirSync(join(consumerAiRoot, "dist"), { recursive: true });
	writeAiManifest(consumerAiRoot);
	writeFileSync(join(consumerAiRoot, "dist", "index.js"), "pi-agent-core nested stale ai");
	const archivePath = join(fixture.directory, "pi-agent-core-nested-stale-ai.asar");
	await asar.createPackage(fixture.appDirectory, archivePath);
	assert.throws(
		() => verifyPackagedAi(fixture.sourceAiDist, archivePath),
		/包含多份可解析的 pi-ai/u,
	);
});

test("rejects a manifestless deep pi-ai override below another root consumer", async () => {
	const fixture = createAiFixture({ rootOnly: true });
	const consumerAiRoot = join(
		fixture.appDirectory,
		"node_modules",
		"@earendil-works",
		"pi-agent-core",
		"dist",
		"runtime",
		"node_modules",
		"@earendil-works",
		"pi-ai",
	);
	mkdirSync(consumerAiRoot, { recursive: true });
	writeFileSync(join(consumerAiRoot, "index.js"), "pi-agent-core deep manifestless stale ai");
	const archivePath = join(fixture.directory, "pi-agent-core-deep-manifestless-ai.asar");
	await asar.createPackage(fixture.appDirectory, archivePath);
	assert.throws(
		() => verifyPackagedAi(fixture.sourceAiDist, archivePath),
		/包含多份可解析的 pi-ai/u,
	);
});

test("does not mistake a similar pi-ai-extra package name for pi-ai", async () => {
	const fixture = createAiFixture({ rootOnly: true });
	const similarPackageRoot = join(
		fixture.appDirectory,
		"node_modules",
		"@earendil-works",
		"pi-agent-core",
		"node_modules",
		"@earendil-works",
		"pi-ai-extra",
	);
	mkdirSync(similarPackageRoot, { recursive: true });
	writeFileSync(
		join(similarPackageRoot, "package.json"),
		JSON.stringify({ name: "@earendil-works/pi-ai-extra" }),
	);
	writeFileSync(join(similarPackageRoot, "index.js"), "similar package");
	const archivePath = join(fixture.directory, "similar-pi-ai-extra.asar");
	await asar.createPackage(fixture.appDirectory, archivePath);
	assert.equal(verifyPackagedAi(fixture.sourceAiDist, archivePath).length, LOCAL_AI_CRITICAL_FILES.length);
});

test("does not count an ordinary file named pi-ai as a package root", async () => {
	const fixture = createAiFixture({ rootOnly: true });
	const canonicalAiRoot = dirname(fixture.installedAiDist);
	rmSync(canonicalAiRoot, { recursive: true });
	writeFileSync(canonicalAiRoot, "ordinary file, not a package directory");
	const archivePath = join(fixture.directory, "ordinary-file-named-pi-ai.asar");
	await asar.createPackage(fixture.appDirectory, archivePath);
	assert.throws(
		() => verifyPackagedAi(fixture.sourceAiDist, archivePath),
		/不存在可供运行时解析的 pi-ai/u,
	);
});

test("rejects a coding-agent manifest renamed to pi-ai", async () => {
	const fixture = createAiFixture({ rootOnly: true });
	writeFileSync(
		join(fixture.installedAgentRoot, "package.json"),
		JSON.stringify(createAgentManifest({ name: "@earendil-works/pi-ai" })),
	);
	const archivePath = join(fixture.directory, "renamed-coding-agent.asar");
	await asar.createPackage(fixture.appDirectory, archivePath);
	assert.throws(
		() => verifyPackagedAi(fixture.sourceAiDist, archivePath),
		/pi-ai 自解析清单位于非规范路径/u,
	);
});

test("rejects a BOM-prefixed non-canonical package manifest that self-identifies as pi-ai", async () => {
	const fixture = createAiFixture({ rootOnly: true });
	const disguisedPackageRoot = join(fixture.appDirectory, "node_modules", "disguised-package");
	mkdirSync(disguisedPackageRoot, { recursive: true });
	writeBomManifest(disguisedPackageRoot, createAiManifest());
	const archivePath = join(fixture.directory, "bom-self-pi-ai.asar");
	await asar.createPackage(fixture.appDirectory, archivePath);
	assert.throws(
		() => verifyPackagedAi(fixture.sourceAiDist, archivePath),
		/pi-ai 自解析清单位于非规范路径/u,
	);
});

test("rejects a dist/core package manifest that self-identifies as pi-ai", async () => {
	const fixture = createAiFixture({ rootOnly: true });
	const embeddedManifestPath = join(fixture.installedAgentRoot, "dist", "core", "package.json");
	mkdirSync(dirname(embeddedManifestPath), { recursive: true });
	writeFileSync(embeddedManifestPath, JSON.stringify(createAiManifest()));
	const archivePath = join(fixture.directory, "dist-core-self-pi-ai.asar");
	await asar.createPackage(fixture.appDirectory, archivePath);
	assert.throws(
		() => verifyPackagedAi(fixture.sourceAiDist, archivePath),
		/pi-ai 自解析清单位于非规范路径/u,
	);
});

test("rejects an invalid first-party package manifest embedded below dist", async () => {
	const fixture = createAiFixture({ rootOnly: true });
	const embeddedManifestPath = join(fixture.installedAgentRoot, "dist", "core", "package.json");
	mkdirSync(dirname(embeddedManifestPath), { recursive: true });
	writeFileSync(embeddedManifestPath, "{");
	const archivePath = join(fixture.directory, "invalid-dist-core-package.asar");
	await asar.createPackage(fixture.appDirectory, archivePath);
	assert.throws(
		() => verifyPackagedAi(fixture.sourceAiDist, archivePath),
		/第一方 dist 内嵌 package.json 无效/u,
	);
});

test("rejects a node condition in the coding-agent root export", async () => {
	const fixture = createAiFixture({ rootOnly: true });
	writeFileSync(
		join(fixture.installedAgentRoot, "package.json"),
		JSON.stringify(
			createAgentManifest({
				exports: {
					".": {
						types: "./dist/index.d.ts",
						node: "./dist/index.js",
						import: "./dist/index.js",
					},
				},
			}),
		),
	);
	const archivePath = join(fixture.directory, "coding-agent-node-condition.asar");
	await asar.createPackage(fixture.appDirectory, archivePath);
	assert.throws(
		() => verifyPackagedAi(fixture.sourceAiDist, archivePath),
		/coding-agent 自解析清单契约无效/u,
	);
});

for (const importTarget of ["dist/index.js", "./dist/../dist/index.js"]) {
	test(`rejects non-canonical installed and packaged pi-ai export target ${importTarget}`, async () => {
		const installedFixture = createAiFixture();
		const installedExports = createAiManifest().exports;
		installedExports["."].import = importTarget;
		writeAiManifest(dirname(installedFixture.installedAiDist), { exports: installedExports });
		assert.throws(
			() =>
				verifyInstalledAi(
					installedFixture.sourceAiDist,
					installedFixture.installedAiDist,
					installedFixture.installedAgentRoot,
				),
			/exports（含键顺序）与可信源码不一致/u,
		);
		const packagedFixture = createAiFixture({ rootOnly: true });
		const packagedExports = createAiManifest().exports;
		packagedExports["."].import = importTarget;
		writeAiManifest(dirname(packagedFixture.installedAiDist), { exports: packagedExports });
		const archivePath = join(
			packagedFixture.directory,
			`invalid-export-${importTarget.replaceAll("/", "-")}.asar`,
		);
		await asar.createPackage(packagedFixture.appDirectory, archivePath);
		assert.throws(
			() => verifyPackagedAi(packagedFixture.sourceAiDist, archivePath),
			/exports（含键顺序）与可信源码不一致/u,
		);
	});
}

test("rejects a root node condition inserted before import", async () => {
	const unsafeRootExport = {
		types: "./dist/index.d.ts",
		node: "./dist/index.js",
		import: "./dist/index.js",
	};
	const installedFixture = createAiFixture();
	const installedExports = createAiManifest().exports;
	installedExports["."] = unsafeRootExport;
	writeAiManifest(dirname(installedFixture.installedAiDist), { exports: installedExports });
	assert.throws(
		() =>
			verifyInstalledAi(
				installedFixture.sourceAiDist,
				installedFixture.installedAiDist,
				installedFixture.installedAgentRoot,
			),
		/exports（含键顺序）与可信源码不一致/u,
	);
	const packagedFixture = createAiFixture({ rootOnly: true });
	const packagedExports = createAiManifest().exports;
	packagedExports["."] = unsafeRootExport;
	writeAiManifest(dirname(packagedFixture.installedAiDist), { exports: packagedExports });
	const archivePath = join(packagedFixture.directory, "root-node-condition.asar");
	await asar.createPackage(packagedFixture.appDirectory, archivePath);
	assert.throws(
		() => verifyPackagedAi(packagedFixture.sourceAiDist, archivePath),
		/exports（含键顺序）与可信源码不一致/u,
	);
});

for (const type of [undefined, "commonjs"]) {
	test(`rejects pi-ai manifest type ${type ?? "missing"}`, async () => {
		const installedFixture = createAiFixture();
		writeAiManifest(dirname(installedFixture.installedAiDist), { type });
		assert.throws(
			() =>
				verifyInstalledAi(
					installedFixture.sourceAiDist,
					installedFixture.installedAiDist,
					installedFixture.installedAgentRoot,
				),
			/type 与可信源码不一致/u,
		);
		const packagedFixture = createAiFixture({ rootOnly: true });
		writeAiManifest(dirname(packagedFixture.installedAiDist), { type });
		const archivePath = join(packagedFixture.directory, `invalid-type-${type ?? "missing"}.asar`);
		await asar.createPackage(packagedFixture.appDirectory, archivePath);
		assert.throws(
			() => verifyPackagedAi(packagedFixture.sourceAiDist, archivePath),
			/type 与可信源码不一致/u,
		);
	});
}

test("rejects a node override on a pi-ai subpath export", async () => {
	const unsafeCompatExport = {
		types: "./dist/compat.d.ts",
		node: "./dist/compat.js",
		import: "./dist/compat.js",
	};
	const installedFixture = createAiFixture();
	const installedExports = createAiManifest().exports;
	installedExports["./compat"] = unsafeCompatExport;
	writeAiManifest(dirname(installedFixture.installedAiDist), { exports: installedExports });
	assert.throws(
		() =>
			verifyInstalledAi(
				installedFixture.sourceAiDist,
				installedFixture.installedAiDist,
				installedFixture.installedAgentRoot,
			),
		/exports（含键顺序）与可信源码不一致/u,
	);
	const packagedFixture = createAiFixture({ rootOnly: true });
	const packagedExports = createAiManifest().exports;
	packagedExports["./compat"] = unsafeCompatExport;
	writeAiManifest(dirname(packagedFixture.installedAiDist), { exports: packagedExports });
	const archivePath = join(packagedFixture.directory, "subpath-node-condition.asar");
	await asar.createPackage(packagedFixture.appDirectory, archivePath);
	assert.throws(
		() => verifyPackagedAi(packagedFixture.sourceAiDist, archivePath),
		/exports（含键顺序）与可信源码不一致/u,
	);
});

for (const [label, overrides, errorPattern] of [
	["name", { name: "@registry/pi-ai" }, /name 与可信源码不一致/u],
	["version", { version: "0.84.3" }, /version 与可信源码不一致/u],
	["main", { main: "./dist/compat.js" }, /main 与可信源码不一致/u],
	[
		"dependencies",
		{ dependencies: { "fixture-dependency-a": "9.0.0", "fixture-dependency-b": "2.0.0" } },
		/dependencies 与可信源码不一致/u,
	],
	["exports", { exports: { ".": createAiManifest().exports["."] } }, /exports（含键顺序）与可信源码不一致/u],
]) {
	test(`rejects pi-ai manifest ${label} mismatch`, async () => {
		const installedFixture = createAiFixture();
		writeAiManifest(dirname(installedFixture.installedAiDist), overrides);
		assert.throws(
			() =>
				verifyInstalledAi(
					installedFixture.sourceAiDist,
					installedFixture.installedAiDist,
					installedFixture.installedAgentRoot,
				),
			errorPattern,
		);
		const packagedFixture = createAiFixture({ rootOnly: true });
		writeAiManifest(dirname(packagedFixture.installedAiDist), overrides);
		const archivePath = join(packagedFixture.directory, `mismatched-${label}.asar`);
		await asar.createPackage(packagedFixture.appDirectory, archivePath);
		assert.throws(() => verifyPackagedAi(packagedFixture.sourceAiDist, archivePath), errorPattern);
	});
}

test("accepts dependency key reordering while preserving identical values", async () => {
	const reorderedDependencies = {
		"fixture-dependency-a": "1.0.0",
		"fixture-dependency-b": "2.0.0",
	};
	const installedFixture = createAiFixture();
	writeAiManifest(dirname(installedFixture.installedAiDist), {
		dependencies: reorderedDependencies,
	});
	assert.equal(
		verifyInstalledAi(
			installedFixture.sourceAiDist,
			installedFixture.installedAiDist,
			installedFixture.installedAgentRoot,
		).length,
		LOCAL_AI_CRITICAL_FILES.length,
	);
	const packagedFixture = createAiFixture({ rootOnly: true });
	writeAiManifest(dirname(packagedFixture.installedAiDist), {
		dependencies: {
			"fixture-dependency-a": "1.0.0",
			"fixture-dependency-b": "2.0.0",
		},
	});
	const archivePath = join(packagedFixture.directory, "reordered-dependencies.asar");
	await asar.createPackage(packagedFixture.appDirectory, archivePath);
	assert.equal(
		verifyPackagedAi(packagedFixture.sourceAiDist, archivePath).length,
		LOCAL_AI_CRITICAL_FILES.length,
	);
});

test("rejects an unsafe export condition in the trusted source manifest", () => {
	const fixture = createAiFixture();
	const exports = createAiManifest().exports;
	exports["."] = {
		types: "./dist/index.d.ts",
		node: "./dist/index.js",
		import: "./dist/index.js",
	};
	writeAiManifest(fixture.sourceAiRoot, { exports });
	assert.throws(
		() => verifyInstalledAi(fixture.sourceAiDist, fixture.installedAiDist, fixture.installedAgentRoot),
		/可信本地 pi-ai package.json 的导出条件无效/u,
	);
});

test("rejects a non-index root export in the trusted pi-ai source manifest", () => {
	const fixture = createAiFixture();
	const exports = createAiManifest().exports;
	exports["."] = {
		types: "./dist/compat.d.ts",
		import: "./dist/compat.js",
	};
	writeAiManifest(fixture.sourceAiRoot, { exports });
	assert.throws(
		() => verifyInstalledAi(fixture.sourceAiDist, fixture.installedAiDist, fixture.installedAgentRoot),
		/可信本地 pi-ai package.json 的根导出契约无效/u,
	);
});

test("rejects a trusted pi-ai compat export whose exact source target is missing", () => {
	const fixture = createAiFixture();
	rmSync(join(fixture.sourceAiDist, "compat.js"));
	assert.throws(
		() => verifyInstalledAi(fixture.sourceAiDist, fixture.installedAiDist, fixture.installedAgentRoot),
		/指向的源码普通文件不存在：\.\/dist\/compat\.js/u,
	);
});

test("rejects installed and packaged pi-ai compat exports that point to a missing target", async () => {
	const missingCompatExports = createAiManifest().exports;
	missingCompatExports["./compat"] = {
		types: "./dist/compat.d.ts",
		import: "./dist/missing-compat.js",
	};
	const installedFixture = createAiFixture();
	writeAiManifest(dirname(installedFixture.installedAiDist), { exports: missingCompatExports });
	assert.throws(
		() =>
			verifyInstalledAi(
				installedFixture.sourceAiDist,
				installedFixture.installedAiDist,
				installedFixture.installedAgentRoot,
			),
		/exports（含键顺序）与可信源码不一致/u,
	);

	const packagedFixture = createAiFixture({ rootOnly: true });
	writeAiManifest(dirname(packagedFixture.installedAiDist), { exports: missingCompatExports });
	const archivePath = join(packagedFixture.directory, "missing-compat-export.asar");
	await asar.createPackage(packagedFixture.appDirectory, archivePath);
	assert.throws(
		() => verifyPackagedAi(packagedFixture.sourceAiDist, archivePath),
		/exports（含键顺序）与可信源码不一致/u,
	);
});

test("rejects a trusted pi-ai compat export redirected to the existing oauth runtime", () => {
	const fixture = createAiFixture();
	const wrongExistingExports = createAiManifest().exports;
	wrongExistingExports["./compat"] = {
		types: "./dist/oauth.d.ts",
		import: "./dist/oauth.js",
	};
	writeAiManifest(fixture.sourceAiRoot, { exports: wrongExistingExports });
	assert.throws(
		() => verifyInstalledAi(fixture.sourceAiDist, fixture.installedAiDist, fixture.installedAgentRoot),
		/固定 exports 映射契约无效/u,
	);
});

test("rejects installed and packaged compat exports redirected to the existing oauth runtime", async () => {
	const wrongExistingExports = createAiManifest().exports;
	wrongExistingExports["./compat"] = {
		types: "./dist/oauth.d.ts",
		import: "./dist/oauth.js",
	};
	const installedFixture = createAiFixture();
	writeAiManifest(dirname(installedFixture.installedAiDist), { exports: wrongExistingExports });
	assert.throws(
		() =>
			verifyInstalledAi(
				installedFixture.sourceAiDist,
				installedFixture.installedAiDist,
				installedFixture.installedAgentRoot,
			),
		/exports（含键顺序）与可信源码不一致/u,
	);

	const packagedFixture = createAiFixture({ rootOnly: true });
	writeAiManifest(dirname(packagedFixture.installedAiDist), { exports: wrongExistingExports });
	const archivePath = join(packagedFixture.directory, "compat-to-oauth.asar");
	await asar.createPackage(packagedFixture.appDirectory, archivePath);
	assert.throws(
		() => verifyPackagedAi(packagedFixture.sourceAiDist, archivePath),
		/exports（含键顺序）与可信源码不一致/u,
	);
});

test("rejects a trusted pi-ai provider pattern with no source import match", () => {
	const fixture = createAiFixture();
	rmSync(join(fixture.sourceAiDist, "providers", "all.js"));
	assert.throws(
		() => verifyInstalledAi(fixture.sourceAiDist, fixture.installedAiDist, fixture.installedAgentRoot),
		/通配符 import 在源码 dist 中没有匹配：\.\/dist\/providers\/\*\.js/u,
	);
});

test("rejects a trusted coding-agent export redirected to a different existing runtime", () => {
	const fixture = createFixture();
	const wrongExistingExports = createAgentManifest().exports;
	wrongExistingExports["./rpc-entry"] = { import: "./dist/index.js" };
	writeAgentManifest(fixture.sourceAgentRoot, { exports: wrongExistingExports });
	assert.throws(
		() => verifyInstalledAgent(fixture.sourceDist, fixture.installedDist),
		/固定 exports 映射契约无效/u,
	);
});

for (const residue of [".pi-ai-local-deadbeef", ".pi-ai-registry-backup-deadbeef", ".b0123456789abcdef"]) {
	test(`rejects packaged pi-ai staging residue ${residue}`, async () => {
		const fixture = createAiFixture({ rootOnly: true });
		const residueRoot = join(fixture.appDirectory, "node_modules", "@earendil-works", residue);
		mkdirSync(residueRoot, { recursive: true });
		writeFileSync(join(residueRoot, "marker.txt"), "staging residue");
		const archivePath = join(fixture.directory, `residue-${residue}.asar`);
		await asar.createPackage(fixture.appDirectory, archivePath);
		assert.throws(
			() => verifyPackagedAi(fixture.sourceAiDist, archivePath),
			/包含 pi-ai 替换或回滚残留/u,
		);
	});
}

test("does not mistake an unrelated backup-looking directory for pi-ai residue", async () => {
	const fixture = createAiFixture({ rootOnly: true });
	const unrelatedBackup = join(
		fixture.appDirectory,
		"node_modules",
		"third-party-package",
		".b0123456789abcdef",
	);
	mkdirSync(unrelatedBackup, { recursive: true });
	writeFileSync(join(unrelatedBackup, "marker.txt"), "unrelated backup");
	const archivePath = join(fixture.directory, "unrelated-backup-name.asar");
	await asar.createPackage(fixture.appDirectory, archivePath);
	assert.equal(verifyPackagedAi(fixture.sourceAiDist, archivePath).length, LOCAL_AI_CRITICAL_FILES.length);
});

test("rejects stale DeepSeek model data in the installed pi-ai", () => {
	const fixture = createAiFixture();
	writeFileSync(join(fixture.installedAiDist, "providers/data/deepseek.json"), "registry model data");
	assert.throws(
		() => verifyInstalledAi(fixture.sourceAiDist, fixture.installedAiDist, fixture.installedAgentRoot),
		/本地 pi-ai 校验失败/u,
	);
});

test("rejects a local pi-ai build without the required DeepSeek compatibility catalog", () => {
	const fixture = createAiFixture();
	writeFileSync(join(fixture.sourceAiDist, "providers/data/deepseek.json"), JSON.stringify({}));
	assert.throws(
		() => verifyInstalledAi(fixture.sourceAiDist, fixture.installedAiDist, fixture.installedAgentRoot),
		/DeepSeek V4 工具调用兼容字段或视觉模型数据/u,
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

test("keeps Qwen and web-search resources in the critical console verification list", () => {
	for (const relativePath of [
		"src/custom-models.ts",
		"src/brave-web-search.ts",
		"src/web-search-tools.ts",
		"web/app.js",
		"packs/web-search/index.ts",
		"packs/web-search/pack.json",
	]) {
		assert.ok(CONSOLE_CRITICAL_FILES.includes(relativePath), `missing critical resource: ${relativePath}`);
	}
});

test("rejects stale staged and unpacked web-search resources", () => {
	const fixture = createConsoleFixture();
	writeFileSync(join(fixture.stagedElectron, "src/web-search-tools.ts"), "stale staged search tool");
	assert.throws(
		() => verifyStagedConsole(fixture.sourceConsole, fixture.stagedElectron),
		/控制台关键资源校验失败/u,
	);

	writeFileSync(join(fixture.unpackedApp, "packs/web-search/pack.json"), "stale unpacked search pack");
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
