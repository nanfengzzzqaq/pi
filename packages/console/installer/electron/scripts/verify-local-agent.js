import { createHash } from "node:crypto";
import { findPackageJSON } from "node:module";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import asar from "@electron/asar";

export const LOCAL_AGENT_CRITICAL_FILES = [
	"core/http-dispatcher.js",
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
	"src/agent-browser-runtime.ts",
	"src/agent-browser-tools.ts",
	"packs/agent-browser/pack.json",
];

export const ELECTRON_ASAR_CRITICAL_FILES = ["browser-controller.js"];

const PACKAGED_AGENT_ROOT = "node_modules/@earendil-works/pi-coding-agent";
const PACKAGED_AI_PACKAGE_PATH = "@earendil-works/pi-ai";
const PACKAGED_HOISTED_AI_ROOT = `node_modules/${PACKAGED_AI_PACKAGE_PATH}`;

function packageResolutionRoots(importerDirectory, packagePath) {
	const roots = [];
	let ancestor = normalizeArchivePath(importerDirectory) || ".";
	while (true) {
		roots.push(normalizeArchivePath(posix.join(ancestor, "node_modules", packagePath)));
		if (ancestor === ".") break;
		ancestor = posix.dirname(ancestor);
	}
	return [...new Set(roots)];
}

const PACKAGED_AI_RESOLUTION_ROOTS = packageResolutionRoots(
	`${PACKAGED_AGENT_ROOT}/dist`,
	PACKAGED_AI_PACKAGE_PATH,
);
const PACKAGED_AI_RESIDUE_PATTERNS = [
	/^\.pi-ai-local-/u,
	/^\.pi-ai-registry-backup-/u,
	/^\.b[0-9a-f]{16}$/u,
];
const EXPECTED_AGENT_EXPORTS = {
	".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
	"./rpc-entry": { import: "./dist/rpc-entry.js" },
	"./client": { types: "./dist/client/index.d.ts", import: "./dist/client/index.js" },
};
const EXPECTED_AI_EXPORTS = {
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
};

function sha256(content) {
	return createHash("sha256").update(content).digest("hex");
}

function parsePackageJson(content) {
	const text = Buffer.isBuffer(content) ? content.toString("utf8") : content;
	return JSON.parse(text.startsWith("\uFEFF") ? text.slice(1) : text);
}

function listFilesystemFiles(root, label) {
	const files = [];
	function visit(directory, prefix) {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				visit(resolve(directory, entry.name), relativePath);
			} else if (entry.isFile()) {
				files.push(relativePath);
			} else {
				throw new Error(`${label} 包含不受支持的非普通文件：${relativePath}`);
			}
		}
	}
	visit(root, "");
	return files.sort();
}

function listArchiveFiles(archivePath, archiveRoot, label) {
	const normalizedRoot = normalizeArchivePath(archiveRoot);
	const prefix = `${normalizedRoot}/`;
	const files = [];
	for (const entry of asar.listPackage(archivePath).map(normalizeArchivePath)) {
		if (!entry.startsWith(prefix)) continue;
		const stat = asar.statFile(archivePath, join(...entry.split("/")), false);
		if ("files" in stat) continue;
		if ("link" in stat) {
			throw new Error(`${label} 包含不受支持的链接：${entry.slice(prefix.length)}`);
		}
		files.push(entry.slice(prefix.length));
	}
	return files.sort();
}

function verifyCompleteDistTree(
	sourceDist,
	targetFiles,
	readTarget,
	{ label, allowMissingDeclarations = false },
) {
	const sourceFiles = listFilesystemFiles(sourceDist, "可信源码 dist");
	const sourceFileSet = new Set(sourceFiles);
	const targetFileSet = new Set(targetFiles);
	const missing = sourceFiles.filter(
		(relativePath) =>
			!targetFileSet.has(relativePath) &&
			!(allowMissingDeclarations && relativePath.endsWith(".d.ts")),
	);
	if (missing.length > 0) {
		throw new Error(`${label} 缺少源码 dist 文件：${missing[0]}`);
	}
	const extra = targetFiles.filter((relativePath) => !sourceFileSet.has(relativePath));
	if (extra.length > 0) {
		throw new Error(`${label} 包含源码 dist 之外的额外文件：${extra[0]}`);
	}
	for (const relativePath of sourceFiles) {
		if (!targetFileSet.has(relativePath)) continue;
		const expected = sha256(readFileSync(resolve(sourceDist, relativePath)));
		const actual = sha256(readTarget(relativePath));
		if (actual !== expected) {
			throw new Error(`${label} 文件哈希不一致：${relativePath}\n期望 ${expected}\n实际 ${actual}`);
		}
	}
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

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJsonValue(value) {
	if (Array.isArray(value)) return value.map(canonicalJsonValue);
	if (!isPlainObject(value)) return value;
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, canonicalJsonValue(value[key])]),
	);
}

function isCanonicalDistTarget(target, suffix) {
	if (
		typeof target !== "string" ||
		/[\\%?#]/u.test(target) ||
		!target.startsWith("./")
	) {
		return false;
	}
	const segments = target.slice(2).split("/");
	if (
		segments.some(
			(segment) =>
				segment === "" ||
				segment === "." ||
				segment === ".." ||
				segment.toLowerCase() === "node_modules",
		)
	) {
		return false;
	}
	return (
		segments[0] === "dist" &&
		segments.length > 1 &&
		target.endsWith(suffix) &&
		`./${posix.normalize(target)}` === target
	);
}

function countAsterisks(value) {
	return [...value].filter((character) => character === "*").length;
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function singleAsteriskMatcher(pattern) {
	const [prefix, suffix] = pattern.split("*");
	return new RegExp(`^${escapeRegExp(prefix)}(.+)${escapeRegExp(suffix)}$`, "u");
}

function sourceRelativeExportTarget(target) {
	return target.slice("./dist/".length);
}

function assertOrdinarySourceTarget(sourceFileSet, target, label) {
	const relativePath = sourceRelativeExportTarget(target);
	if (!sourceFileSet.has(relativePath)) {
		throw new Error(`${label} 指向的源码普通文件不存在：${target}`);
	}
}

function assertSourceExportTargets(manifest, sourceDist, label) {
	const sourceFiles = listFilesystemFiles(sourceDist, `${label} 的源码 dist`);
	const sourceFileSet = new Set(sourceFiles);
	for (const [exportPath, conditions] of Object.entries(manifest.exports)) {
		const exportAsterisks = countAsterisks(exportPath);
		const conditionTargets = Object.values(conditions);
		if (
			exportAsterisks > 1 ||
			conditionTargets.some((target) => countAsterisks(target) !== exportAsterisks)
		) {
			throw new Error(`${label} 的通配符导出映射无效：${exportPath}`);
		}
		if (exportAsterisks === 0) {
			for (const target of conditionTargets) {
				assertOrdinarySourceTarget(sourceFileSet, target, label);
			}
			continue;
		}

		const importPattern = sourceRelativeExportTarget(conditions.import);
		const importMatcher = singleAsteriskMatcher(importPattern);
		const matchingImports = sourceFiles
			.map((relativePath) => ({ relativePath, match: importMatcher.exec(relativePath) }))
			.filter(({ match }) => Boolean(match));
		if (matchingImports.length === 0) {
			throw new Error(`${label} 的通配符 import 在源码 dist 中没有匹配：${conditions.import}`);
		}
		for (const { match } of matchingImports) {
			const replacement = match[1];
			const specifier = exportPath.replace("*", replacement);
			const specifierMatch = singleAsteriskMatcher(exportPath).exec(specifier);
			if (specifierMatch?.[1] !== replacement) {
				throw new Error(`${label} 的通配符 specifier 映射无效：${exportPath}`);
			}
			for (const target of conditionTargets) {
				assertOrdinarySourceTarget(sourceFileSet, target.replace("*", replacement), label);
			}
		}
	}
	return sourceFileSet;
}

function resolveSourceExportTarget(exports, specifier, condition) {
	const literal = exports[specifier];
	if (isPlainObject(literal)) return literal[condition];
	for (const [exportPath, conditions] of Object.entries(exports)) {
		if (countAsterisks(exportPath) !== 1) continue;
		const match = singleAsteriskMatcher(exportPath).exec(specifier);
		if (match) return conditions[condition]?.replace("*", match[1]);
	}
	return undefined;
}

function assertSourceAiManifestContract(manifest, sourceDist) {
	if (
		manifest?.name !== "@earendil-works/pi-ai" ||
		typeof manifest.version !== "string" ||
		manifest.version.length === 0 ||
		manifest.type !== "module" ||
		manifest.main !== "./dist/index.js" ||
		!isPlainObject(manifest.dependencies) ||
		Object.values(manifest.dependencies).some((value) => typeof value !== "string") ||
		!isPlainObject(manifest.exports)
	) {
		throw new Error("可信本地 pi-ai package.json 的 name/version/type/main/dependencies/exports 契约无效");
	}
	const exportPaths = Object.keys(manifest.exports);
	if (
		exportPaths.length === 0 ||
		exportPaths[0] !== "." ||
		exportPaths.some((exportPath) => exportPath !== "." && !exportPath.startsWith("./"))
	) {
		throw new Error("可信本地 pi-ai package.json 的 exports 子路径契约无效");
	}
	for (const exportPath of exportPaths) {
		const conditions = manifest.exports[exportPath];
		if (
			!isPlainObject(conditions) ||
			JSON.stringify(Object.keys(conditions)) !== JSON.stringify(["types", "import"]) ||
			!isCanonicalDistTarget(conditions.types, ".d.ts") ||
			!isCanonicalDistTarget(conditions.import, ".js")
		) {
			throw new Error(`可信本地 pi-ai package.json 的导出条件无效：${exportPath}`);
		}
	}
	const rootExport = manifest.exports["."];
	if (
		rootExport.types !== "./dist/index.d.ts" ||
		rootExport.import !== "./dist/index.js"
	) {
		throw new Error("可信本地 pi-ai package.json 的根导出契约无效");
	}
	if (JSON.stringify(manifest.exports) !== JSON.stringify(EXPECTED_AI_EXPORTS)) {
		throw new Error("可信本地 pi-ai package.json 的固定 exports 映射契约无效");
	}
	const sourceFileSet = assertSourceExportTargets(manifest, sourceDist, "可信本地 pi-ai package.json");
	const providersAllTarget = resolveSourceExportTarget(manifest.exports, "./providers/all", "import");
	if (providersAllTarget !== "./dist/providers/all.js") {
		throw new Error("可信本地 pi-ai package.json 无法规范解析运行时导出 ./providers/all");
	}
	assertOrdinarySourceTarget(sourceFileSet, providersAllTarget, "可信本地 pi-ai package.json");
}

function readSourceAiManifest(sourceDist) {
	const manifestPath = resolve(sourceDist, "..", "package.json");
	let manifest;
	try {
		manifest = parsePackageJson(readFileSync(manifestPath, "utf8"));
	} catch (error) {
		throw new Error("无法读取可信本地 pi-ai package.json", { cause: error });
	}
	assertSourceAiManifestContract(manifest, sourceDist);
	return manifest;
}

function assertAiManifestMatchesSource(manifest, sourceManifest, label) {
	for (const field of ["name", "version", "type", "main"]) {
		if (manifest?.[field] !== sourceManifest[field]) {
			throw new Error(`${label} 的 ${field} 与可信源码不一致`);
		}
	}
	if (JSON.stringify(manifest.exports) !== JSON.stringify(sourceManifest.exports)) {
		throw new Error(`${label} 的 exports（含键顺序）与可信源码不一致`);
	}
	if (
		JSON.stringify(canonicalJsonValue(manifest.dependencies)) !==
		JSON.stringify(canonicalJsonValue(sourceManifest.dependencies))
	) {
		throw new Error(`${label} 的 dependencies 与可信源码不一致`);
	}
}

function assertSourceAgentManifestContract(manifest, sourceDist) {
	if (
		manifest?.name !== "@earendil-works/pi-coding-agent" ||
		typeof manifest.version !== "string" ||
		manifest.version.length === 0 ||
		manifest.type !== "module" ||
		manifest.main !== "./dist/index.js" ||
		!isPlainObject(manifest.dependencies) ||
		Object.values(manifest.dependencies).some((value) => typeof value !== "string") ||
		!isPlainObject(manifest.exports)
	) {
		throw new Error("可信本地 coding-agent package.json 的基础契约无效");
	}
	const exportPaths = Object.keys(manifest.exports);
	if (
		exportPaths.length === 0 ||
		exportPaths[0] !== "." ||
		exportPaths.some((exportPath) => exportPath !== "." && !exportPath.startsWith("./"))
	) {
		throw new Error("可信本地 coding-agent package.json 的 exports 子路径契约无效");
	}
	for (const exportPath of exportPaths) {
		const conditions = manifest.exports[exportPath];
		const conditionKeys = isPlainObject(conditions) ? Object.keys(conditions) : [];
		const isImportOnly = JSON.stringify(conditionKeys) === JSON.stringify(["import"]);
		const isTypesAndImport = JSON.stringify(conditionKeys) === JSON.stringify(["types", "import"]);
		if (
			(!isImportOnly && !isTypesAndImport) ||
			!isCanonicalDistTarget(conditions?.import, ".js") ||
			(isTypesAndImport && !isCanonicalDistTarget(conditions.types, ".d.ts"))
		) {
			throw new Error(`可信本地 coding-agent package.json 的导出条件无效：${exportPath}`);
		}
	}
	const rootExport = manifest.exports["."];
	if (
		JSON.stringify(Object.keys(rootExport)) !== JSON.stringify(["types", "import"]) ||
		rootExport.types !== "./dist/index.d.ts" ||
		rootExport.import !== "./dist/index.js"
	) {
		throw new Error("可信本地 coding-agent package.json 的根导出契约无效");
	}
	if (JSON.stringify(manifest.exports) !== JSON.stringify(EXPECTED_AGENT_EXPORTS)) {
		throw new Error("可信本地 coding-agent package.json 的固定 exports 映射契约无效");
	}
	assertSourceExportTargets(manifest, sourceDist, "可信本地 coding-agent package.json");
}

function readSourceAgentManifest(sourceDist) {
	const manifestPath = resolve(sourceDist, "..", "package.json");
	let manifest;
	try {
		manifest = parsePackageJson(readFileSync(manifestPath, "utf8"));
	} catch (error) {
		throw new Error("无法读取可信本地 coding-agent package.json", { cause: error });
	}
	assertSourceAgentManifestContract(manifest, sourceDist);
	return manifest;
}

function assertAgentManifestMatchesSource(manifest, sourceManifest, label) {
	for (const field of ["name", "version", "type", "main"]) {
		if (manifest?.[field] !== sourceManifest[field]) {
			throw new Error(`${label} 的 ${field} 与可信源码不一致`);
		}
	}
	if (JSON.stringify(manifest.exports) !== JSON.stringify(sourceManifest.exports)) {
		throw new Error(`${label} 的 exports（含键顺序）与可信源码不一致`);
	}
	if (
		JSON.stringify(canonicalJsonValue(manifest.dependencies)) !==
		JSON.stringify(canonicalJsonValue(sourceManifest.dependencies))
	) {
		throw new Error(`${label} 的 dependencies 与可信源码不一致`);
	}
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

function normalizeArchivePath(archivePath) {
	return archivePath.replaceAll("\\", "/").replace(/^\/+/, "");
}

function readArchiveFile(archivePath, relativePath) {
	return asar.extractFile(archivePath, join(...normalizeArchivePath(relativePath).split("/")));
}

function collectPackagedAiRoots(archivePath, entries) {
	const roots = new Set();
	const packageMarker = `node_modules/${PACKAGED_AI_PACKAGE_PATH}`;
	for (const entry of entries) {
		let markerIndex = entry.indexOf(packageMarker);
		while (markerIndex !== -1) {
			const packageRootEnd = markerIndex + packageMarker.length;
			const hasExactStartBoundary = markerIndex === 0 || entry[markerIndex - 1] === "/";
			const hasExactEndBoundary = entry.length === packageRootEnd || entry[packageRootEnd] === "/";
			if (hasExactStartBoundary && hasExactEndBoundary) {
				const packageRoot = entry.slice(0, packageRootEnd);
				if (entry.length > packageRootEnd) {
					roots.add(packageRoot);
				} else {
					const stat = asar.statFile(archivePath, join(...packageRoot.split("/")), false);
					if ("files" in stat) {
						roots.add(packageRoot);
					} else if ("link" in stat) {
						const followed = asar.statFile(archivePath, join(...packageRoot.split("/")), true);
						if ("files" in followed) roots.add(packageRoot);
					}
				}
			}
			markerIndex = entry.indexOf(packageMarker, packageRootEnd);
		}
	}
	return roots;
}

function findPackagedAiResidue(entries) {
	for (const entry of entries) {
		const segments = entry.split("/");
		for (let index = 0; index <= segments.length - 3; index += 1) {
			if (
				segments[index] === "node_modules" &&
				segments[index + 1] === "@earendil-works" &&
				PACKAGED_AI_RESIDUE_PATTERNS.some((pattern) => pattern.test(segments[index + 2]))
			) {
				return entry;
			}
		}
	}
	return undefined;
}

function isFirstPartyDistManifest(manifestPath) {
	const segments = manifestPath.split("/");
	if (segments.at(-1) !== "package.json") return false;
	for (let index = 0; index <= segments.length - 5; index += 1) {
		if (
			segments[index] === "node_modules" &&
			segments[index + 1] === "@earendil-works" &&
			segments[index + 3] === "dist"
		) {
			return true;
		}
	}
	return false;
}

function auditArchivedAiSelfReferences(archivePath, entries) {
	const canonicalManifestPath = `${PACKAGED_HOISTED_AI_ROOT}/package.json`;
	for (const manifestPath of entries) {
		if (manifestPath !== "package.json" && !manifestPath.endsWith("/package.json")) continue;
		let manifest;
		try {
			manifest = parsePackageJson(readArchiveFile(archivePath, manifestPath));
		} catch (error) {
			if (isFirstPartyDistManifest(manifestPath)) {
				throw new Error(`第一方 dist 内嵌 package.json 无效：${manifestPath}`, { cause: error });
			}
			continue;
		}
		if (manifest?.name === "@earendil-works/pi-ai" && manifestPath !== canonicalManifestPath) {
			throw new Error(`pi-ai 自解析清单位于非规范路径：${manifestPath}`);
		}
	}
}

function assertPackagedAgentRuntimeManifest(agentManifest) {
	const rootExport = agentManifest?.exports?.["."];
	if (
		agentManifest?.name !== "@earendil-works/pi-coding-agent" ||
		agentManifest.type !== "module" ||
		!isPlainObject(rootExport) ||
		JSON.stringify(Object.keys(rootExport)) !== JSON.stringify(["types", "import"]) ||
		rootExport.types !== "./dist/index.d.ts" ||
		rootExport.import !== "./dist/index.js"
	) {
		throw new Error("打包后的 coding-agent 自解析清单契约无效");
	}
}

function resolvePackagedAiRoot(archivePath, sourceManifest) {
	const entries = new Set(asar.listPackage(archivePath).map(normalizeArchivePath));
	const archivedResidue = findPackagedAiResidue(entries);
	if (archivedResidue) {
		throw new Error(`打包产物包含 pi-ai 替换或回滚残留：${archivedResidue}`);
	}
	const packagedAiRoots = [...collectPackagedAiRoots(archivePath, entries)];
	if (packagedAiRoots.length === 0) {
		throw new Error("打包产物中不存在可供运行时解析的 pi-ai");
	}
	if (packagedAiRoots.length > 1) {
		throw new Error(`打包产物包含多份可解析的 pi-ai：${packagedAiRoots.join("、")}`);
	}
	const [packagedAiRoot] = packagedAiRoots;
	if (packagedAiRoot !== PACKAGED_HOISTED_AI_ROOT) {
		throw new Error(`打包产物中的唯一 pi-ai 未位于确定的根级提升路径：${packagedAiRoot}`);
	}
	auditArchivedAiSelfReferences(archivePath, entries);

	const agentManifestPath = `${PACKAGED_AGENT_ROOT}/package.json`;
	if (!entries.has(agentManifestPath)) {
		throw new Error("打包产物缺少 coding-agent package.json，无法证明 pi-ai 运行时解析路径");
	}
	let agentManifest;
	try {
		agentManifest = parsePackageJson(readArchiveFile(archivePath, agentManifestPath));
	} catch (error) {
		throw new Error("打包后的 coding-agent package.json 无效", { cause: error });
	}
	assertPackagedAgentRuntimeManifest(agentManifest);
	if (typeof agentManifest?.dependencies?.["@earendil-works/pi-ai"] !== "string") {
		throw new Error("打包后的 coding-agent 未声明 pi-ai 运行时依赖");
	}

	const resolvedAiRoots = PACKAGED_AI_RESOLUTION_ROOTS.filter((root) =>
		[...entries].some((entry) => entry === root || entry.startsWith(`${root}/`)),
	);
	if (resolvedAiRoots.length === 0) {
		throw new Error("打包产物中 coding-agent 无法解析 pi-ai");
	}
	if (resolvedAiRoots.length > 1) {
		throw new Error(`打包产物包含多份可解析的 pi-ai：${resolvedAiRoots.join("、")}`);
	}
	const [resolvedAiRoot] = resolvedAiRoots;
	if (resolvedAiRoot !== packagedAiRoot) {
		throw new Error("coding-agent 未解析到打包产物中唯一的根级 pi-ai");
	}
	if (!entries.has(`${resolvedAiRoot}/package.json`)) {
		throw new Error(`打包后最高优先级 pi-ai 候选缺少 package.json：${resolvedAiRoot}`);
	}
	let aiManifest;
	try {
		aiManifest = parsePackageJson(readArchiveFile(archivePath, `${resolvedAiRoot}/package.json`));
	} catch (error) {
		throw new Error("打包后实际解析到的 pi-ai package.json 无效", { cause: error });
	}
	assertAiManifestMatchesSource(aiManifest, sourceManifest, "打包后实际解析到的 pi-ai package.json");
	const expectedImportEntry = `${resolvedAiRoot}/dist/index.js`;
	if (!entries.has(expectedImportEntry)) {
		throw new Error("打包后实际解析到的 pi-ai ESM 入口不是已校验的 dist/index.js");
	}
	return resolvedAiRoot;
}

export function verifyInstalledAgent(sourceDist, installedDist) {
	const sourceManifest = readSourceAgentManifest(sourceDist);
	const results = verifyAgentFiles(sourceDist, (relativePath) => readFileSync(resolve(installedDist, relativePath)));
	verifyCompleteDistTree(
		sourceDist,
		listFilesystemFiles(installedDist, "已安装 coding-agent dist"),
		(relativePath) => readFileSync(resolve(installedDist, relativePath)),
		{ label: "已安装 coding-agent 完整 dist 树" },
	);
	let installedManifest;
	try {
		installedManifest = parsePackageJson(
			readFileSync(resolve(installedDist, "..", "package.json"), "utf8"),
		);
	} catch (error) {
		throw new Error("无法读取已安装 coding-agent package.json", { cause: error });
	}
	assertAgentManifestMatchesSource(installedManifest, sourceManifest, "已安装 coding-agent package.json");
	return results;
}

export function verifyPackagedAgent(sourceDist, archivePath) {
	const sourceManifest = readSourceAgentManifest(sourceDist);
	const packagedDistRoot = `${PACKAGED_AGENT_ROOT}/dist`;
	const results = verifyAgentFiles(sourceDist, (relativePath) =>
		readArchiveFile(archivePath, `${packagedDistRoot}/${relativePath}`),
	);
	verifyCompleteDistTree(
		sourceDist,
		listArchiveFiles(archivePath, packagedDistRoot, "打包后的 coding-agent dist"),
		(relativePath) => readArchiveFile(archivePath, `${packagedDistRoot}/${relativePath}`),
		{
			label: "打包后的 coding-agent 完整 dist 树",
			allowMissingDeclarations: true,
		},
	);
	let packagedManifest;
	try {
		packagedManifest = parsePackageJson(
			readArchiveFile(archivePath, `${PACKAGED_AGENT_ROOT}/package.json`),
		);
	} catch (error) {
		throw new Error("无法读取打包后的 coding-agent package.json", { cause: error });
	}
	assertAgentManifestMatchesSource(packagedManifest, sourceManifest, "打包后的 coding-agent package.json");
	return results;
}

export function verifyInstalledAi(sourceDist, installedDist, installedAgentRoot) {
	const sourceManifest = readSourceAiManifest(sourceDist);
	const results = verifyAiFiles(sourceDist, (relativePath) => readFileSync(resolve(installedDist, relativePath)));
	const agentEntryUrl = pathToFileURL(resolve(installedAgentRoot, "dist/index.js"));
	let aiManifestPath;
	try {
		aiManifestPath = findPackageJSON("@earendil-works/pi-ai", agentEntryUrl);
	} catch (error) {
		throw new Error("本地 coding-agent 无法解析自身内嵌的 pi-ai", { cause: error });
	}
	if (!aiManifestPath) {
		throw new Error("本地 coding-agent 无法解析自身内嵌的 pi-ai");
	}

	const expectedAiRoot = resolve(installedAgentRoot, "node_modules", "@earendil-works", "pi-ai");
	let resolvedAiRoot;
	try {
		resolvedAiRoot = realpathSync(dirname(aiManifestPath));
		if (resolvedAiRoot !== realpathSync(expectedAiRoot)) {
			throw new Error("unexpected package root");
		}
	} catch (error) {
		throw new Error("本地 coding-agent 仍会解析到 registry 或嵌套的 pi-ai", { cause: error });
	}

	let aiManifest;
	try {
		aiManifest = parsePackageJson(readFileSync(aiManifestPath, "utf8"));
	} catch (error) {
		throw new Error("本地 coding-agent 解析到的 pi-ai package.json 无效", { cause: error });
	}
	assertAiManifestMatchesSource(aiManifest, sourceManifest, "本地 coding-agent 解析到的 pi-ai package.json");
	const importTarget = sourceManifest.exports["."].import;
	const resolvedAiEntry = realpathSync(resolve(resolvedAiRoot, importTarget));
	const expectedAiEntry = realpathSync(resolve(installedDist, "index.js"));
	if (resolvedAiEntry !== expectedAiEntry) {
		throw new Error("本地 coding-agent 仍会解析到 registry 或嵌套的 pi-ai");
	}
	verifyCompleteDistTree(
		sourceDist,
		listFilesystemFiles(installedDist, "已安装 pi-ai dist"),
		(relativePath) => readFileSync(resolve(installedDist, relativePath)),
		{ label: "已安装 pi-ai 完整 dist 树" },
	);
	return results;
}

export function verifyPackagedAi(sourceDist, archivePath) {
	const sourceManifest = readSourceAiManifest(sourceDist);
	const resolvedAiRoot = resolvePackagedAiRoot(archivePath, sourceManifest);
	const resolvedDistRoot = `${resolvedAiRoot}/dist`;
	const results = verifyAiFiles(sourceDist, (relativePath) =>
		readArchiveFile(archivePath, `${resolvedAiRoot}/dist/${relativePath}`),
	);
	verifyCompleteDistTree(
		sourceDist,
		listArchiveFiles(archivePath, resolvedDistRoot, "打包后的 pi-ai dist"),
		(relativePath) => readArchiveFile(archivePath, `${resolvedDistRoot}/${relativePath}`),
		{
			label: "打包后的 pi-ai 完整 dist 树",
			allowMissingDeclarations: true,
		},
	);
	return results;
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
