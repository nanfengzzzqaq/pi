import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import asar from "@electron/asar";

export const LOCAL_AGENT_CRITICAL_FILES = [
	"core/http-dispatcher.js",
	"core/whiterabbitneo-provider.js",
	"core/sdk.js",
	"core/agent-session-services.js",
];

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

function optionValue(name) {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

function main() {
	const sourceDist = optionValue("--source-dist");
	const installedDist = optionValue("--installed-dist");
	const archivePath = optionValue("--asar");
	if (!sourceDist || Boolean(installedDist) === Boolean(archivePath)) {
		throw new Error(
			"用法：node verify-local-agent.js --source-dist <dist> (--installed-dist <dist> | --asar <app.asar>)",
		);
	}

	const results = installedDist
		? verifyInstalledAgent(sourceDist, installedDist)
		: verifyPackagedAgent(sourceDist, archivePath);
	for (const result of results) {
		console.log(`${result.sha256}  ${result.relativePath}`);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main();
}
