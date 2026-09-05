import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	copyFileSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export function atomicFileWrite(path: string, content: string | Buffer): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	let created = false;
	try {
		const fd = openSync(temporary, "wx", 0o600);
		created = true;
		try {
			writeFileSync(fd, content);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temporary, path);
	} finally {
		if (created && existsSync(temporary)) unlinkSync(temporary);
	}
}

export function readDurableJson<T>(path: string, parse: (value: unknown) => T, missing: () => T): T {
	if (!existsSync(path) && !existsSync(`${path}.bak`)) return missing();
	try {
		return parse(JSON.parse(readFileSync(path, "utf8")));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code !== "ENOENT") throw error;
		let recovered: T;
		try {
			recovered = parse(JSON.parse(readFileSync(`${path}.bak`, "utf8")));
		} catch {
			throw new Error(`配置无法读取，原文件已保留：${path}`);
		}
		if (existsSync(path)) copyFileSync(path, `${path}.corrupt-${randomUUID()}`, constants.COPYFILE_EXCL);
		atomicFileWrite(path, `${JSON.stringify(recovered, null, "\t")}\n`);
		return recovered;
	}
}

export function writeDurableJson<T>(path: string, value: T, parse: (value: unknown) => T, missing: () => T): void {
	const next = parse(value);
	const previous = readDurableJson(path, parse, missing);
	atomicFileWrite(`${path}.bak`, `${JSON.stringify(existsSync(path) ? previous : next, null, "\t")}\n`);
	atomicFileWrite(path, `${JSON.stringify(next, null, "\t")}\n`);
}
