import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import asar from "@electron/asar";

export const LOCAL_AGENT_CRITICAL_FILES = [
	"core/http-dispatcher.js",
	"core/whiterabbitneo-provider.js",
	"core/sdk.js",
	"core/agent-session-services.js",
];

export const LOCAL_AI_CRITICAL_FILES = [
	"index.js",
	"api/openai-completions.js",
	"providers/data/deepseek.json",
];

export const CONSOLE_CRITICAL_FILES = [
	"src/server.ts",
	"src/packs.ts",
	"src/session-messages.ts",
	"src/capability-workflow.ts",
	"src/agent-browser-runtime.ts",
	"src/agent-browser-safety.ts",
	"src/agent-browser-tools.ts",
	"packs/agent-browser/pack.json",
	"packs/travel-expense/index.ts",
	"packs/travel-expense/pack.json",
	"packs/travel-expense/pdf-embedded.ts",
	"packs/travel-expense/pdf-ocr.ps1",
	"packs/travel-expense/workflow.ts",
	"packs/travel-expense/workflow-browser-driver.ts",
	"skills/travel-expense/SKILL.md",
];

export const ELECTRON_ASAR_CRITICAL_FILES = ["browser-controller.js"];

function sha256(content) {
	return createHash("sha256").update(content).digest("hex");
}

function verifyAgentFiles(sourceDist, readTarget) {
	return LOCAL_AGENT_CRITICAL_FILES.map((relativePath) => {
		const expected = sha256(readFileSync(resolve(sourceDist, relativePath)));
		const actual = sha256(readTarget(relativePath));
		if (actual !== expected) {
			throw new Error(
				`本地 coding-agent 校验失败：${relativePath}\n期望 ${expected}\n实际 ${actual}`,
			);
		}
		return { relativePath, sha256: expected };
	});
}

function assertLocalDeepSeekCatalog(sourceDist) {
	const catalog = JSON.parse(readFileSync(resolve(sourceDist, "providers/data/deepseek.json"), "utf8"));
	const models = catalog["openai-completions"];
	const flash = models?.["deepseek-v4-flash"];
	const vision = models?.["deepseek-v4-flash-vision-exp"];
	if (
		flash?.compat?.supportsToolChoiceWithThinking !== false ||
		flash?.compat?.requiresReasoningContentOnAssistantMessages !== true ||
		flash?.compat?.requiresAssistantContentOnToolCalls !== true ||
		flash?.compat?.thinkingFormat !== "deepseek" ||
		!Array.isArray(vision?.input) ||
		!vision.input.includes("image")
	) {
		throw new Error("本地 pi-ai 缺少本版要求的 DeepSeek V4 工具调用兼容字段或视觉模型数据");
	}
}

function verifyAiFiles(sourceDist, readTarget) {
	assertLocalDeepSeekCatalog(sourceDist);
	return LOCAL_AI_CRITICAL_FILES.map((relativePath) => {
		const expected = sha256(readFileSync(resolve(sourceDist, relativePath)));
		const actual = sha256(readTarget(relativePath));
		if (actual !== expected) {
			throw new Error(`本地 pi-ai 校验失败：${relativePath}\n期望 ${expected}\n实际 ${actual}`);
		}
		return { relativePath, sha256: expected };
	});
}

function verifyConsoleFiles(sourceConsole, readTarget) {
	return CONSOLE_CRITICAL_FILES.map((relativePath) => {
		const expected = sha256(readFileSync(resolve(sourceConsole, relativePath)));
		const actual = sha256(readTarget(relativePath));
		if (actual !== expected) {
			throw new Error(
				`控制台关键资源校验失败：${relativePath}\n期望 ${expected}\n实际 ${actual}`,
			);
		}
		return { relativePath, sha256: expected };
	});
}

export function verifyInstalledAgent(sourceDist, installedDist) {
	return verifyAgentFiles(sourceDist, (relativePath) => readFileSync(resolve(installedDist, relativePath)));
}

export function verifyPackagedAgent(sourceDist, archivePath) {
	return verifyAgentFiles(sourceDist, (relativePath) =>
		asar.extractFile(
			archivePath,
			join("node_modules", "@earendil-works", "pi-coding-agent", "dist", relativePath),
		),
	);
}

export function verifyInstalledAi(sourceDist, installedDist, installedAgentRoot) {
	const results = verifyAiFiles(sourceDist, (relativePath) => readFileSync(resolve(installedDist, relativePath)));
	const requireFromAgent = createRequire(resolve(installedAgentRoot, "package.json"));
	const resolvedAiEntry = realpathSync(requireFromAgent.resolve("@earendil-works/pi-ai"));
	const expectedAiEntry = realpathSync(resolve(installedDist, "index.js"));
	if (resolvedAiEntry !== expectedAiEntry) {
		throw new Error("本地 coding-agent 仍会解析到 registry 或嵌套的 pi-ai");
	}
	return results;
}

export function verifyPackagedAi(sourceDist, archivePath) {
	return verifyAiFiles(sourceDist, (relativePath) =>
		asar.extractFile(
			archivePath,
			join(
				"node_modules",
				"@earendil-works",
				"pi-coding-agent",
				"node_modules",
				"@earendil-works",
				"pi-ai",
				"dist",
				relativePath,
			),
		),
	);
}

export function verifyStagedConsole(sourceConsole, stagedElectron) {
	return verifyConsoleFiles(sourceConsole, (relativePath) =>
		readFileSync(resolve(stagedElectron, relativePath)),
	);
}

export function verifyPackagedConsole(sourceConsole, unpackedApp) {
	return verifyConsoleFiles(sourceConsole, (relativePath) =>
		readFileSync(resolve(unpackedApp, relativePath)),
	);
}

export function verifyPackagedElectron(sourceElectron, archivePath) {
	return ELECTRON_ASAR_CRITICAL_FILES.map((relativePath) => {
		const expected = sha256(readFileSync(resolve(sourceElectron, relativePath)));
		const actual = sha256(asar.extractFile(archivePath, relativePath));
		if (actual !== expected) {
			throw new Error(
				`Electron 关键资源校验失败：${relativePath}\n期望 ${expected}\n实际 ${actual}`,
			);
		}
		return { relativePath, sha256: expected };
	});
}

function optionValue(name) {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

function main() {
	const sourceDist = optionValue("--source-dist");
	const sourceAiDist = optionValue("--source-ai-dist");
	const installedDist = optionValue("--installed-dist");
	const installedAiDist = optionValue("--installed-ai-dist");
	const installedAgentRoot = optionValue("--installed-agent-root");
	const archivePath = optionValue("--asar");
	const sourceConsole = optionValue("--source-console");
	const stagedElectron = optionValue("--staged-electron");
	const unpackedApp = optionValue("--unpacked-app");
	const sourceElectron = optionValue("--source-electron");
	const agentMode = Boolean(sourceDist);
	const aiMode = Boolean(sourceAiDist);
	const consoleMode = Boolean(sourceConsole);
	const electronMode = Boolean(sourceElectron);
	if (
		Number(agentMode) + Number(aiMode) + Number(consoleMode) + Number(electronMode) !== 1 ||
		(agentMode &&
			(Boolean(installedDist) === Boolean(archivePath) ||
				Boolean(installedAiDist) ||
				Boolean(installedAgentRoot) ||
				Boolean(stagedElectron) ||
				Boolean(unpackedApp))) ||
		(aiMode &&
			(Boolean(installedAiDist) === Boolean(archivePath) ||
				Boolean(installedDist) ||
				Boolean(stagedElectron) ||
				Boolean(unpackedApp) ||
				(Boolean(installedAiDist) !== Boolean(installedAgentRoot)))) ||
		(consoleMode &&
			(Boolean(stagedElectron) === Boolean(unpackedApp) ||
				Boolean(installedDist) ||
				Boolean(installedAiDist) ||
				Boolean(installedAgentRoot) ||
				Boolean(archivePath))) ||
		(electronMode &&
			(!archivePath ||
				Boolean(installedDist) ||
				Boolean(installedAiDist) ||
				Boolean(installedAgentRoot) ||
				Boolean(stagedElectron) ||
				Boolean(unpackedApp)))
	) {
		throw new Error(
			"用法：--source-dist <dist> (--installed-dist <dist> | --asar <app.asar>)；或 --source-ai-dist <dist> (--installed-ai-dist <dist> --installed-agent-root <dir> | --asar <app.asar>)；或 --source-console <dir> (--staged-electron <dir> | --unpacked-app <dir>)；或 --source-electron <dir> --asar <app.asar>",
		);
	}

	const results = agentMode
		? installedDist
			? verifyInstalledAgent(sourceDist, installedDist)
			: verifyPackagedAgent(sourceDist, archivePath)
		: aiMode
			? installedAiDist
				? verifyInstalledAi(sourceAiDist, installedAiDist, installedAgentRoot)
				: verifyPackagedAi(sourceAiDist, archivePath)
			: consoleMode
				? stagedElectron
					? verifyStagedConsole(sourceConsole, stagedElectron)
					: verifyPackagedConsole(sourceConsole, unpackedApp)
				: verifyPackagedElectron(sourceElectron, archivePath);
	for (const result of results) {
		console.log(`${result.sha256}  ${result.relativePath}`);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main();
}
