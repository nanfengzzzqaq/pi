import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import asar from "@electron/asar";

/** The single-message queue API must resolve to the same agent-core in the installer. */
export function verifyQueueRuntime(sourceDist, { installedAgentRoot, archivePath }) {
	let readTarget;
	if (archivePath) {
		const entries = new Set(asar.listPackage(archivePath).map(path => path.replaceAll("\\", "/").replace(/^\//, "")));
		let ancestor = "node_modules/@earendil-works/pi-coding-agent/dist";
		let coreRoot;
		while (true) {
			const candidate = posix.join(ancestor, "node_modules/@earendil-works/pi-agent-core");
			if (entries.has(`${candidate}/package.json`)) { coreRoot = candidate; break; }
			if (ancestor === ".") break;
			ancestor = posix.dirname(ancestor);
		}
		if (!coreRoot) throw new Error("打包后的 coding-agent 无法解析 pi-agent-core");
		readTarget = path => asar.extractFile(archivePath, join(...`${coreRoot}/${path}`.split("/")));
	} else {
		const manifest = findPackageJSON("@earendil-works/pi-agent-core", pathToFileURL(join(installedAgentRoot, "dist/index.js")));
		if (!manifest) throw new Error("已安装 coding-agent 无法解析 pi-agent-core");
		readTarget = path => readFileSync(join(dirname(manifest), path));
	}
	const sourceManifest = JSON.parse(readFileSync(join(sourceDist, "../package.json"), "utf8"));
	const targetManifest = JSON.parse(readTarget("package.json").toString("utf8"));
	for (const field of ["name", "version", "type", "main", "exports"]) {
		if (JSON.stringify(sourceManifest[field]) !== JSON.stringify(targetManifest[field])) throw new Error(`pi-agent-core ${field} 与源码不一致`);
	}
	for (const file of ["agent.js", "index.js"]) {
		const expected = createHash("sha256").update(readFileSync(join(sourceDist, file))).digest("hex");
		const actual = createHash("sha256").update(readTarget(`dist/${file}`)).digest("hex");
		if (expected !== actual) throw new Error(`pi-agent-core 文件哈希不一致：${file}`);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const [sourceDist, mode, target] = process.argv.slice(2);
	if (!sourceDist || !target || !["--installed-agent-root", "--asar"].includes(mode)) throw new Error("用法：verify-queue-runtime.js <source-dist> (--installed-agent-root <root> | --asar <archive>)");
	verifyQueueRuntime(sourceDist, mode === "--asar" ? { archivePath: target } : { installedAgentRoot: target });
	console.log("已校验实际解析到的 pi-agent-core 与排队消息实现");
}
