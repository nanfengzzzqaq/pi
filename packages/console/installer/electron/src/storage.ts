/** Agent 数据目录迁移：复制全部持久数据、修正内部绝对路径，并写入下次启动位置。 */
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { DATA_DIR, STORAGE_CONFIG_FILE } from "./paths.ts";

export interface StorageMigrationResult {
	path: string;
	previousPath: string;
	copiedFiles: number;
	restartRequired: boolean;
}

function comparable(path: string): string {
	const value = resolve(path);
	return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}

function containsPath(parent: string, child: string): boolean {
	const root = comparable(parent);
	const candidate = comparable(child);
	return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

function copyDirectory(source: string, destination: string): number {
	mkdirSync(destination, { recursive: true });
	let copied = 0;
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		// 更新下载目录属于一次性缓存，迁移后会按需重新创建。
		if (entry.name === "update") continue;
		const from = join(source, entry.name);
		const to = join(destination, entry.name);
		if (entry.isDirectory()) copied += copyDirectory(from, to);
		else if (entry.isFile()) {
			copyFileSync(from, to);
			copied++;
		}
	}
	return copied;
}

function rewritePath(value: unknown, source: string, destination: string): unknown {
	if (typeof value === "string" && containsPath(source, value)) {
		return resolve(destination, value.slice(resolve(source).length).replace(/^[\\/]+/, ""));
	}
	if (Array.isArray(value)) return value.map((item) => rewritePath(item, source, destination));
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([key, item]) => [
				key,
				rewritePath(item, source, destination),
			]),
		);
	}
	return value;
}

function rewriteJsonFile(path: string, source: string, destination: string): void {
	if (!existsSync(path)) return;
	const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	writeFileSync(path, `${JSON.stringify(rewritePath(parsed, source, destination), null, "\t")}\n`, "utf8");
}

function writeLocationConfig(configFile: string, path: string): void {
	mkdirSync(dirname(configFile), { recursive: true });
	const temporary = `${configFile}.tmp`;
	writeFileSync(temporary, `${JSON.stringify({ dataDir: path }, null, "\t")}\n`, "utf8");
	renameSync(temporary, configFile);
}

export function getStorageInfo(): { path: string; configFile: string } {
	return { path: resolve(DATA_DIR), configFile: resolve(STORAGE_CONFIG_FILE) };
}

export function migrateDataDirectory(
	targetPath: string,
	sourcePath = DATA_DIR,
	configFile = STORAGE_CONFIG_FILE,
): StorageMigrationResult {
	const source = resolve(sourcePath);
	const destination = resolve(targetPath.trim());
	if (!targetPath.trim()) throw new Error("请选择新的 Agent 数据目录");
	if (comparable(source) === comparable(destination)) {
		return { path: destination, previousPath: source, copiedFiles: 0, restartRequired: false };
	}
	if (containsPath(source, destination) || containsPath(destination, source)) {
		throw new Error("新旧数据目录不能互相包含，请选择另一个独立目录");
	}
	if (existsSync(destination) && !statSync(destination).isDirectory()) throw new Error("目标路径不是目录");

	const copiedFiles = copyDirectory(source, destination);
	// 会话索引与工作区设置可能保存了旧数据目录内的绝对路径，迁移后同步改写。
	rewriteJsonFile(join(destination, "sessions-index.json"), source, destination);
	rewriteJsonFile(join(destination, "workspace.json"), source, destination);
	writeLocationConfig(resolve(configFile), destination);
	return { path: destination, previousPath: source, copiedFiles, restartRequired: true };
}
