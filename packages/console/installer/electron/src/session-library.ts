import { randomUUID } from "node:crypto";
import { readDurableJson, writeDurableJson } from "./durable-json.ts";
import type { SessionIndex } from "./session-index.ts";

interface SessionPlacement {
	categoryId?: string;
	archived?: boolean;
}

export interface SessionLibrary {
	categories: Array<{ id: string; name: string }>;
	placements: Record<string, SessionPlacement>;
}

const emptyLibrary = (): SessionLibrary => ({ categories: [], placements: {} });

function parseLibrary(value: unknown): SessionLibrary {
	if (!value || typeof value !== "object") throw new Error("对话分类配置无效");
	const library = value as SessionLibrary;
	if (
		!Array.isArray(library.categories) ||
		!library.placements ||
		typeof library.placements !== "object" ||
		Array.isArray(library.placements)
	)
		throw new Error("对话分类配置无效");
	const ids = new Set<string>();
	for (const category of library.categories) {
		if (
			!category ||
			typeof category.id !== "string" ||
			typeof category.name !== "string" ||
			!category.name.trim() ||
			ids.has(category.id)
		)
			throw new Error("对话分类配置无效");
		ids.add(category.id);
	}
	for (const placement of Object.values(library.placements)) {
		if (
			!placement ||
			typeof placement !== "object" ||
			(placement.categoryId !== undefined && !ids.has(placement.categoryId)) ||
			(placement.archived !== undefined && typeof placement.archived !== "boolean")
		)
			throw new Error("对话归类配置无效");
	}
	return library;
}

export function readSessionLibrary(path: string): SessionLibrary {
	return readDurableJson(path, parseLibrary, emptyLibrary);
}

/** One durable write changes every selected session; transcripts and workspaces are untouched. */
export function updateSessionLibrary(path: string, index: SessionIndex, value: unknown): SessionLibrary {
	if (!value || typeof value !== "object") throw new Error("分类操作无效");
	const body = value as Record<string, unknown>;
	const library = readSessionLibrary(path);
	if (body.action === "create" || body.action === "rename") {
		if (typeof body.name !== "string") throw new Error("请输入分类名称");
		const name = body.name.replace(/\s+/gu, " ").trim();
		if (!name || name.length > 60) throw new Error("分类名称需为 1–60 个字符");
		if (
			library.categories.some(
				(entry) =>
					entry.name.toLocaleLowerCase() === name.toLocaleLowerCase() &&
					(body.action === "create" || entry.id !== body.id),
			)
		)
			throw new Error("此分类名称已存在");
		if (body.action === "create") library.categories.push({ id: randomUUID(), name });
		else {
			const category = library.categories.find((entry) => entry.id === body.id);
			if (!category) throw new Error("此分类已不存在，请刷新后重试");
			category.name = name;
		}
	} else if (body.action === "remove") {
		if (!library.categories.some((entry) => entry.id === body.id)) throw new Error("此分类已不存在");
		library.categories = library.categories.filter((entry) => entry.id !== body.id);
		for (const placement of Object.values(library.placements))
			if (placement.categoryId === body.id) delete placement.categoryId;
	} else if (body.action === "move" || body.action === "archive") {
		if (
			!Array.isArray(body.ids) ||
			body.ids.length === 0 ||
			body.ids.length > 1000 ||
			body.ids.some((id) => typeof id !== "string" || !Object.hasOwn(index, id) || index[id].deletionRequestedAt)
		)
			throw new Error("所选对话已变化，请刷新后重试（每次最多 1000 条）");
		if (
			body.action === "move" &&
			body.categoryId !== null &&
			!library.categories.some((entry) => entry.id === body.categoryId)
		)
			throw new Error("目标分类不存在");
		if (body.action === "archive" && typeof body.archived !== "boolean") throw new Error("归档状态无效");
		for (const id of body.ids as string[]) {
			const placement = library.placements[id] ?? {};
			if (body.action === "archive") placement.archived = body.archived as boolean;
			else if (body.categoryId === null) delete placement.categoryId;
			else placement.categoryId = body.categoryId as string;
			Object.defineProperty(library.placements, id, {
				value: placement,
				enumerable: true,
				configurable: true,
				writable: true,
			});
		}
	} else throw new Error("分类操作无效");
	for (const id of Object.keys(library.placements))
		if (!Object.hasOwn(index, id) || index[id].deletionRequestedAt) delete library.placements[id];
	writeDurableJson(path, library, parseLibrary, emptyLibrary);
	return library;
}
