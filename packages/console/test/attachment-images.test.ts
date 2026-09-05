import {
	closeSync,
	ftruncateSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAttachmentImages } from "../src/attachment-images.ts";

const SESSION_ID = "01234567-89ab-cdef-0123-456789abcdef";
const OTHER_SESSION_ID = "fedcba98-7654-3210-fedc-ba9876543210";
const MIB = 1024 * 1024;
let temporaryDirectory: string;
let dataDir: string;
let cwd: string;

beforeEach(() => {
	temporaryDirectory = mkdtempSync(join(tmpdir(), "pi-attachment-images-"));
	dataDir = join(temporaryDirectory, "data");
	cwd = join(temporaryDirectory, "workspace");
	mkdirSync(join(cwd, "uploads"), { recursive: true });
});

afterEach(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

function sparseImage(name: string, size: number) {
	const path = join(cwd, "uploads", name);
	const descriptor = openSync(path, "w");
	try {
		ftruncateSync(descriptor, size);
	} finally {
		closeSync(descriptor);
	}
	return { path, mimeType: "image/png" };
}

describe("图片附件引用", () => {
	it("没有图片附件时返回空列表", () => {
		expect(resolveAttachmentImages(dataDir, SESSION_ID, cwd, undefined)).toEqual([]);
		expect(resolveAttachmentImages(dataDir, SESSION_ID, cwd, [])).toEqual([]);
	});

	it("从工作附件和当前会话的原始快照读取图片，保留顺序与类型", () => {
		const snapshot = join(dataDir, "attachment-snapshots", SESSION_ID, "original", "图片.webp");
		mkdirSync(dirname(snapshot), { recursive: true });
		writeFileSync(snapshot, "original");
		writeFileSync(join(cwd, "uploads", "图片.png"), "working");
		expect(
			resolveAttachmentImages(dataDir, SESSION_ID, cwd, [
				{ path: "uploads/图片.png", mimeType: "image/png" },
				{ path: snapshot, mimeType: "image/webp" },
			]),
		).toEqual([
			{ type: "image", data: Buffer.from("working").toString("base64"), mimeType: "image/png" },
			{ type: "image", data: Buffer.from("original").toString("base64"), mimeType: "image/webp" },
		]);
	});

	it.each([null, {}, "uploads/image.png", [null], [{}], [{ path: 1, mimeType: "image/png" }]])(
		"拒绝无效的引用结构 %j",
		(value) => expect(() => resolveAttachmentImages(dataDir, SESSION_ID, cwd, value)).toThrow(/格式/),
	);

	it("拒绝超过 32 个引用以及不支持的图片类型", () => {
		const reference = { path: "uploads/a.png", mimeType: "image/png" };
		expect(() => resolveAttachmentImages(dataDir, SESSION_ID, cwd, Array(33).fill(reference))).toThrow(/格式/);
		for (const mimeType of ["image/svg+xml", "text/html", "image/avif", ""]) {
			expect(() => resolveAttachmentImages(dataDir, SESSION_ID, cwd, [{ ...reference, mimeType }])).toThrow(
				/不受支持/,
			);
		}
	});

	it("拒绝其他会话快照、目录穿越以及 uploads 同前缀的相邻目录", () => {
		const paths = [
			join(dataDir, "attachment-snapshots", OTHER_SESSION_ID, "a.png"),
			join(cwd, "private.png"),
			join(cwd, "uploads-elsewhere", "a.png"),
		];
		for (const path of paths) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, "outside");
		}
		for (const path of [paths[0], "uploads/../private.png", paths[2]]) {
			expect(() => resolveAttachmentImages(dataDir, SESSION_ID, cwd, [{ path, mimeType: "image/png" }])).toThrow(
				/不属于当前会话/,
			);
		}
		expect(() => resolveAttachmentImages(dataDir, "../outside", cwd, [])).toThrow(/会话标识/);
	});

	it("拒绝指向附件目录外部的目录链接", () => {
		const outside = join(temporaryDirectory, "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "a.png"), "outside");
		symlinkSync(outside, join(cwd, "uploads", "linked"), process.platform === "win32" ? "junction" : "dir");
		expect(() =>
			resolveAttachmentImages(dataDir, SESSION_ID, cwd, [{ path: "uploads/linked/a.png", mimeType: "image/png" }]),
		).toThrow(/不属于当前会话/);
	});

	it("允许数据目录和工作目录本身位于目录链接内", () => {
		const snapshot = join(dataDir, "attachment-snapshots", SESSION_ID, "original", "a.png");
		mkdirSync(dirname(snapshot), { recursive: true });
		writeFileSync(snapshot, "snapshot");
		writeFileSync(join(cwd, "uploads", "a.png"), "working");
		const dataAlias = join(temporaryDirectory, "data-alias");
		const workspaceAlias = join(temporaryDirectory, "workspace-alias");
		const type = process.platform === "win32" ? "junction" : "dir";
		symlinkSync(dataDir, dataAlias, type);
		symlinkSync(cwd, workspaceAlias, type);
		expect(
			resolveAttachmentImages(dataAlias, SESSION_ID, workspaceAlias, [
				{ path: "uploads/a.png", mimeType: "image/png" },
				{ path: join(dataAlias, "attachment-snapshots", SESSION_ID, "original", "a.png"), mimeType: "image/png" },
			]).map((image) => Buffer.from(image.data, "base64").toString()),
		).toEqual(["working", "snapshot"]);
	});

	it("拒绝目录和已丢失的附件", () => {
		mkdirSync(join(cwd, "uploads", "directory"));
		expect(() =>
			resolveAttachmentImages(dataDir, SESSION_ID, cwd, [{ path: "uploads/directory", mimeType: "image/png" }]),
		).toThrow(/普通文件/);
		expect(() =>
			resolveAttachmentImages(dataDir, SESSION_ID, cwd, [{ path: "uploads/missing.png", mimeType: "image/png" }]),
		).toThrow();
	});

	it("允许超过旧消息正文上限的 1MiB 图片，并允许单文件恰好 20MiB", () => {
		for (const size of [MIB, 20 * MIB]) {
			const [image] = resolveAttachmentImages(dataDir, SESSION_ID, cwd, [sparseImage(`${size}.png`, size)]);
			expect(image.data.length).toBe(Math.ceil(size / 3) * 4);
			expect(image.mimeType).toBe("image/png");
		}
		expect(() =>
			resolveAttachmentImages(dataDir, SESSION_ID, cwd, [sparseImage("too-large.png", 20 * MIB + 1)]),
		).toThrow(/20MB/);
	});

	it("允许总计 50MiB，超过一字节或重复引用导致超量时拒绝", () => {
		const first = sparseImage("first.png", 20 * MIB);
		const second = sparseImage("second.png", 20 * MIB);
		const third = sparseImage("third.png", 10 * MIB);
		expect(resolveAttachmentImages(dataDir, SESSION_ID, cwd, [first, second, third])).toHaveLength(3);
		const extra = sparseImage("extra.png", 1);
		expect(() => resolveAttachmentImages(dataDir, SESSION_ID, cwd, [first, second, third, extra])).toThrow(
			/大小上限/,
		);
		expect(() => resolveAttachmentImages(dataDir, SESSION_ID, cwd, [first, first, first])).toThrow(/大小上限/);
	});
});
