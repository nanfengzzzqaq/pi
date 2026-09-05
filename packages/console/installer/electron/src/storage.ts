/** Agent 数据目录迁移：复制全部持久数据、修正内部绝对路径，并写入下次启动位置。 */

import { randomUUID } from "node:crypto";
import {
	closeSync,
	copyFileSync,
	existsSync,
	fstatSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	unlinkSync,
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

/** File verification uses a fixed amount of memory even for large archives and session files. */
function verifyCopiedFile(source: string, destination: string): void {
	const sourceDescriptor = openSync(source, "r");
	try {
		const destinationDescriptor = openSync(destination, "r");
		try {
			const sourceStat = fstatSync(sourceDescriptor);
			if (sourceStat.size !== fstatSync(destinationDescriptor).size) throw new Error("文件大小不一致");
			const sourceBuffer = Buffer.allocUnsafe(64 * 1024);
			const destinationBuffer = Buffer.allocUnsafe(sourceBuffer.length);
			for (let position = 0; position < sourceStat.size; position += sourceBuffer.length) {
				const length = Math.min(sourceBuffer.length, sourceStat.size - position);
				if (
					readSync(sourceDescriptor, sourceBuffer, 0, length, position) !== length ||
					readSync(destinationDescriptor, destinationBuffer, 0, length, position) !== length ||
					!sourceBuffer.subarray(0, length).equals(destinationBuffer.subarray(0, length))
				) {
					throw new Error("文件内容不一致");
				}
			}
			const sourceAfter = fstatSync(sourceDescriptor);
			if (
				sourceAfter.size !== sourceStat.size ||
				sourceAfter.mtimeMs !== sourceStat.mtimeMs ||
				sourceAfter.ctimeMs !== sourceStat.ctimeMs
			) {
				throw new Error("校验期间原文件发生变化");
			}
		} finally {
			closeSync(destinationDescriptor);
		}
	} catch (error) {
		throw new Error(`迁移文件校验失败：${source}：${error instanceof Error ? error.message : String(error)}`);
	} finally {
		closeSync(sourceDescriptor);
	}
}

function copyDirectory(source: string, destination: string, skipUpdateCache = false): number {
	mkdirSync(destination, { recursive: true });
	let copied = 0;
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		// 更新下载目录属于一次性缓存，迁移后会按需重新创建。
		if (skipUpdateCache && entry.name === "update") continue;
		const from = join(source, entry.name);
		const to = join(destination, entry.name);
		if (entry.isDirectory()) copied += copyDirectory(from, to);
		else if (entry.isFile()) {
			copyFileSync(from, to);
			verifyCopiedFile(from, to);
			copied++;
		} else throw new Error(`数据目录包含不支持迁移的链接或特殊文件：${entry.name}`);
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
	const temporary = `${configFile}.${randomUUID()}.tmp`;
	let created = false;
	try {
		const descriptor = openSync(temporary, "wx", 0o600);
		created = true;
		try {
			writeFileSync(descriptor, `${JSON.stringify({ dataDir: path }, null, "\t")}\n`, "utf8");
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		renameSync(temporary, configFile);
	} finally {
		if (created && existsSync(temporary)) unlinkSync(temporary);
	}
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
	if (!existsSync(source) || !statSync(source).isDirectory()) throw new Error("原数据目录不存在或不是目录");
	if (existsSync(destination) && readdirSync(destination).length > 0)
		throw new Error("新数据目录必须为空，已有文件不会被覆盖");
	const config = resolve(configFile);
	if (containsPath(source, config) || containsPath(destination, config))
		throw new Error("数据位置配置必须保存在新旧数据目录之外");
	for (const name of ["sessions-index.json", "workspace.json"]) {
		const path = join(source, name);
		if (existsSync(path)) JSON.parse(readFileSync(path, "utf8"));
	}
	mkdirSync(dirname(destination), { recursive: true });
	const stage = join(dirname(destination), `.pi-migration-${randomUUID()}`);
	let installed = false;
	try {
		const copiedFiles = copyDirectory(source, stage, true);
		// Rewrite to the final destination, not the temporary staging directory.
		rewriteJsonFile(join(stage, "sessions-index.json"), source, destination);
		rewriteJsonFile(join(stage, "sessions-index.json.bak"), source, destination);
		rewriteJsonFile(join(stage, "workspace.json"), source, destination);
		// rmdir is intentionally non-recursive: files created during copying prevent the switch.
		if (existsSync(destination)) rmdirSync(destination);
		renameSync(stage, destination);
		installed = true;
		writeLocationConfig(config, destination);
		return { path: destination, previousPath: source, copiedFiles, restartRequired: true };
	} catch (error) {
		if (installed) {
			// Keep the verified copy for recovery if switching the location pointer fails.
			throw new Error(
				`数据位置切换失败，原数据仍可使用，已复制的数据保留在 ${destination}：${error instanceof Error ? error.message : String(error)}`,
			);
		}
		throw error;
	} finally {
		if (!installed && existsSync(stage)) rmSync(stage, { recursive: true });
	}
}
