import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 50 * 1024 * 1024;

/** Only this session's snapshots or files under its working uploads directory may become image input. */
export function resolveAttachmentImages(dataDir: string, sessionId: string, cwd: string, value: unknown) {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 32) throw new Error("图片附件格式无效");
	if (!/^[a-f0-9-]+$/iu.test(sessionId)) throw new Error("图片附件的会话标识无效");
	const roots = [join(dataDir, "attachment-snapshots", sessionId), join(cwd, "uploads")]
		.filter((root) => existsSync(root))
		.map((root) => realpathSync(root));
	let total = 0;
	const files = value.map((item: unknown) => {
		if (!item || typeof item !== "object") throw new Error("图片附件格式无效");
		const reference = item as { path?: unknown; mimeType?: unknown };
		if (
			typeof reference.path !== "string" ||
			typeof reference.mimeType !== "string" ||
			!IMAGE_TYPES.has(reference.mimeType)
		)
			throw new Error("图片附件格式不受支持");
		const path = realpathSync(resolve(cwd, reference.path));
		const key = process.platform === "win32" ? path.toLowerCase() : path;
		if (
			!roots.some((root) => {
				const prefix = `${resolve(root)}${sep}`;
				return key.startsWith(process.platform === "win32" ? prefix.toLowerCase() : prefix);
			})
		)
			throw new Error("图片不属于当前会话的附件");
		const stat = statSync(path);
		if (!stat.isFile()) throw new Error("图片附件不是普通文件");
		if (stat.size > MAX_IMAGE_BYTES) throw new Error("图片超过 20MB 上限");
		total += stat.size;
		if (total > MAX_TOTAL_IMAGE_BYTES) throw new Error("图片附件超过大小上限");
		return { path, mimeType: reference.mimeType };
	});
	total = 0;
	return files.map((file) => {
		const data = readFileSync(file.path);
		total += data.length;
		if (data.length > MAX_IMAGE_BYTES || total > MAX_TOTAL_IMAGE_BYTES) throw new Error("图片附件超过大小上限");
		return { type: "image" as const, data: data.toString("base64"), mimeType: file.mimeType };
	});
}
