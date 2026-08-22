/**
 * “差旅报销”能力包。
 *
 * 易快报（合思）差旅费用报销单的自动填报助手：提供报销规则速查、费用明细
 * 计划与铁路电子客票（PDF/OFD/压缩包）、查验 PDF/图片配对，以及由固定状态机
 * 驱动客户端内置浏览器完成草稿填报。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	constants as fsConstants,
	closeSync,
	copyFileSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { redactSensitiveText } from "../../src/agent-browser-runtime.ts";
import type { PackContext } from "../../src/packs.ts";
import {
	extractRailwayEmbeddedXml,
	matchVerificationFiles,
	parseVerificationFingerprint,
	resolveLodgingInvoiceCandidate,
	type LodgingInvoiceResolution,
	type TravelOcrDocument,
	type VerificationCandidate,
} from "./pdf-embedded.ts";
import { TravelDraftBrowserDriver, type TravelDraftBrowserDriverOptions } from "./workflow-browser-driver.ts";
import {
	runTravelDraft,
	TRAVEL_DRAFT_CURRENT_USER,
	travelDraftSaveIdentity,
	type TravelDraftIssue,
	type TravelDraftPlan,
	type TravelDraftRunResult,
} from "./workflow.ts";
export type { LodgingInvoiceCandidate, LodgingInvoiceResolution, TravelOcrDocument } from "./pdf-embedded.ts";

function textResult(text: string, details: Record<string, unknown> = {}): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: redactSensitiveText(text) }], details };
}

// ---------------------------------------------------------------------------
// 铁路电子客票（OFD）解析：OFD 本质是 zip，解包后读 Content.xml 里的文本
// ---------------------------------------------------------------------------

export interface RailwayInvoice {
	source: string;
	uploadFile: string;
	trainNumber?: string;
	fromStation?: string;
	toStation?: string;
	fromCity?: string;
	toCity?: string;
	date?: string;
	departTime?: string;
	seatClass?: string;
	amount?: number;
	passenger?: string;
	invoiceNumber?: string;
	issueDate?: string;
	verificationFiles?: string[];
	verificationStatus?: "ready" | "missing";
	error?: string;
}

export interface InvoiceAttachmentResult {
	invoices: RailwayInvoice[];
	pairingStatus: "ready" | "missing" | "ambiguous";
	lodging: LodgingInvoiceResolution;
	/** Bounded OCR text for deterministic callers such as travel_fill_draft. */
	ocrDocuments: TravelOcrDocument[];
	missing: Array<{ invoiceIndex: number; invoiceNumber?: string; source: string }>;
	ambiguous: Array<{ file: string; candidateInvoiceIndexes: number[]; candidateInvoiceNumbers: string[]; signals: string[] }>;
	unmatched: Array<{ file: string; reason: string }>;
}

const MAX_OCR_DOCUMENT_BYTES = 20 * 1024 * 1024;
const MAX_TICKET_PDF_BYTES = 32 * 1024 * 1024;
const OCR_TIMEOUT_MS = 45_000;
const OCR_MAX_PAGES = 4;
const MAX_TRAVEL_INPUT_FILES = 20;
const MAX_TRAVEL_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 200;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_ARCHIVE_DEPTH = 8;
const MAX_OCR_DOCUMENTS = 8;
const MAX_OCR_WALL_MS = 150_000;

interface ExtractedDocument {
	source: string;
	root: string;
	attachment?: string;
	error?: string;
}

function systemTarExecutable(): string {
	const root = process.env.SystemRoot ?? process.env.WINDIR;
	return root ? join(root, "System32", "tar.exe") : "tar";
}

/** 递归列出受限解包目录；拒绝符号链接、深层目录和超大解压结果。 */
function listFilesRecursive(root: string, current = root, depth = 0, state = { entries: 0, bytes: 0 }): string[] {
	if (depth > MAX_ARCHIVE_DEPTH) throw new Error(`压缩包目录深度超过 ${MAX_ARCHIVE_DEPTH} 层安全上限`);
	const output: string[] = [];
	for (const entry of readdirSync(current, { withFileTypes: true })) {
		state.entries += 1;
		if (state.entries > MAX_ARCHIVE_ENTRIES) throw new Error(`压缩包条目超过 ${MAX_ARCHIVE_ENTRIES} 个安全上限`);
		const full = join(current, entry.name);
		const stats = lstatSync(full);
		if (stats.isSymbolicLink()) throw new Error("压缩包包含符号链接，已拒绝解包");
		if (stats.isDirectory()) output.push(...listFilesRecursive(root, full, depth + 1, state));
		else if (stats.isFile()) {
			state.bytes += stats.size;
			if (state.bytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
				throw new Error(`压缩包解压后超过 ${MAX_ARCHIVE_UNCOMPRESSED_BYTES / 1024 / 1024}MB 安全上限`);
			}
			output.push(full);
		} else {
			throw new Error("压缩包包含不支持的特殊文件");
		}
	}
	return output;
}

interface ZipArchiveSummary {
	entries: number;
	uncompressedBytes: number;
}

interface ExtractionBudget {
	entries: number;
	bytes: number;
}

function assertSafeArchivePath(rawName: string): void {
	const normalized = rawName.replaceAll("\\", "/");
	const parts = normalized.split("/");
	const pathParts = normalized.endsWith("/") ? parts.slice(0, -1) : parts;
	if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.includes("\0")) {
		throw new Error(`压缩包包含不安全路径：${rawName.slice(0, 120)}`);
	}
	if (pathParts.length === 0 || pathParts.length > MAX_ARCHIVE_DEPTH + 1) {
		throw new Error(`压缩包路径深度超过 ${MAX_ARCHIVE_DEPTH} 层安全上限`);
	}
	for (const component of pathParts) {
		const trimmed = component.replace(/[ .]+$/g, "");
		const base = trimmed.split(".")[0]?.toLocaleUpperCase("en-US") ?? "";
		if (
			!component ||
			component === "." ||
			component === ".." ||
			trimmed !== component ||
			component.includes(":") ||
			/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(base)
		) {
			throw new Error(`压缩包包含 Windows 不安全路径：${rawName.slice(0, 120)}`);
		}
	}
}

/** Read ZIP central-directory metadata before extraction to reject traversal and bombs. */
function inspectZipArchive(file: string): ZipArchiveSummary {
	const data = readFileSync(file);
	const minimum = Math.max(0, data.length - 65_557);
	let eocd = -1;
	for (let offset = data.length - 22; offset >= minimum; offset--) {
		if (
			data.readUInt32LE(offset) === 0x06054b50 &&
			offset + 22 <= data.length &&
			offset + 22 + data.readUInt16LE(offset + 20) === data.length
		) {
			eocd = offset;
			break;
		}
	}
	if (eocd < 0) throw new Error("压缩包缺少有效 ZIP 中央目录");
	const diskNumber = data.readUInt16LE(eocd + 4);
	const directoryDisk = data.readUInt16LE(eocd + 6);
	const diskEntries = data.readUInt16LE(eocd + 8);
	const entries = data.readUInt16LE(eocd + 10);
	const directorySize = data.readUInt32LE(eocd + 12);
	const directoryOffset = data.readUInt32LE(eocd + 16);
	const commentLength = data.readUInt16LE(eocd + 20);
	if (diskNumber !== 0 || directoryDisk !== 0 || diskEntries !== entries) {
		throw new Error("不支持跨卷 ZIP 压缩包");
	}
	if (eocd + 22 + commentLength !== data.length) throw new Error("ZIP 末尾边界或注释长度无效");
	if (entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
		throw new Error("不支持 ZIP64 压缩包；请拆分为普通 PDF/OFD 附件");
	}
	if (entries === 0 || entries > MAX_ARCHIVE_ENTRIES) {
		throw new Error(`压缩包条目数 ${entries} 超出 1-${MAX_ARCHIVE_ENTRIES} 安全范围`);
	}
	if (directoryOffset + directorySize !== eocd || directoryOffset < 0) throw new Error("ZIP 中央目录边界无效");
	let offset = directoryOffset;
	let uncompressedBytes = 0;
	const paths = new Set<string>();
	for (let index = 0; index < entries; index++) {
		if (offset + 46 > data.length || data.readUInt32LE(offset) !== 0x02014b50) {
			throw new Error("ZIP 中央目录条目损坏");
		}
		const flags = data.readUInt16LE(offset + 8);
		const compressionMethod = data.readUInt16LE(offset + 10);
		const compressedSize = data.readUInt32LE(offset + 20);
		const size = data.readUInt32LE(offset + 24);
		const nameLength = data.readUInt16LE(offset + 28);
		const extraLength = data.readUInt16LE(offset + 30);
		const commentLength = data.readUInt16LE(offset + 32);
		const externalAttributes = data.readUInt32LE(offset + 38);
		const localHeaderOffset = data.readUInt32LE(offset + 42);
		const end = offset + 46 + nameLength + extraLength + commentLength;
		if (end > data.length) throw new Error("ZIP 中央目录文件名边界无效");
		if ((flags & 0x0001) !== 0) throw new Error("不支持加密 ZIP 压缩包");
		if (compressionMethod !== 0 && compressionMethod !== 8) throw new Error(`不支持 ZIP 压缩算法 ${compressionMethod}`);
		const encoding = (flags & 0x0800) !== 0 ? "utf8" : "latin1";
		const centralNameBytes = data.subarray(offset + 46, offset + 46 + nameLength);
		const rawName = centralNameBytes.toString(encoding);
		assertSafeArchivePath(rawName);
		const normalizedIdentity = rawName.replaceAll("\\", "/").toLocaleLowerCase("en-US");
		if (paths.has(normalizedIdentity)) throw new Error(`压缩包包含重复路径：${rawName.slice(0, 120)}`);
		paths.add(normalizedIdentity);
		if (localHeaderOffset + 30 > directoryOffset || data.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
			throw new Error(`ZIP 本地文件头无效：${rawName.slice(0, 120)}`);
		}
		const localNameLength = data.readUInt16LE(localHeaderOffset + 26);
		const localExtraLength = data.readUInt16LE(localHeaderOffset + 28);
		const localNameEnd = localHeaderOffset + 30 + localNameLength;
		if (localNameEnd + localExtraLength > directoryOffset) throw new Error("ZIP 本地文件头边界无效");
		if (data.readUInt16LE(localHeaderOffset + 6) !== flags || data.readUInt16LE(localHeaderOffset + 8) !== compressionMethod) {
			throw new Error("ZIP 中央目录与本地文件头参数不一致");
		}
		const localNameBytes = data.subarray(localHeaderOffset + 30, localNameEnd);
		if (!localNameBytes.equals(centralNameBytes)) throw new Error("ZIP 中央目录与本地文件名不一致");
		const compressedDataStart = localNameEnd + localExtraLength;
		if (compressedDataStart + compressedSize > directoryOffset) throw new Error("ZIP 压缩数据边界无效");
		const unixType = (externalAttributes >>> 16) & 0xf000;
		if (unixType === 0xa000) throw new Error("压缩包包含符号链接，已拒绝解包");
		uncompressedBytes += size;
		if (uncompressedBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
			throw new Error(`压缩包解压后超过 ${MAX_ARCHIVE_UNCOMPRESSED_BYTES / 1024 / 1024}MB 安全上限`);
		}
		offset = end;
	}
	if (offset !== eocd) throw new Error("ZIP 中央目录长度与条目不一致");
	return { entries, uncompressedBytes };
}

/**
 * 提取 OFD 页面文本并按坐标重建阅读顺序：
 * 每个 TextObject 带 Boundary="x y w h"，按 Y 分行（容差 3）、行内按 X 排序，
 * 避免 XML 文档顺序与视觉顺序不一致导致站名、金额错乱。
 */
function ofdXmlText(xml: string): string {
	const objects = [...xml.matchAll(/<(?:[\w.-]+:)?TextObject\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?TextObject\s*>/gi)].map((match) => {
		const boundary = match[1].match(/Boundary="([-\d.\s]+)"/);
		const [x, y] = boundary ? boundary[1].trim().split(/\s+/).slice(0, 2).map(Number) : [0, 0];
		const codes = [...match[2].matchAll(/<(?:[\w.-]+:)?TextCode\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?TextCode\s*>/gi)].map((code) =>
			decodeXml(code[1].replace(/<[^>]+>/g, "")),
		);
		return { x: x ?? 0, y: y ?? 0, text: codes.join("") };
	});
	objects.sort((a, b) => a.y - b.y || a.x - b.x);
	const lines: Array<{ y: number; parts: Array<{ x: number; text: string }> }> = [];
	for (const object of objects) {
		if (!object.text) continue;
		const line = lines.find((candidate) => Math.abs(candidate.y - object.y) < 3);
		if (line) line.parts.push(object);
		else lines.push({ y: object.y, parts: [object] });
	}
	return lines
		.map((line) => {
			line.parts.sort((a, b) => a.x - b.x);
			return line.parts.map((part) => part.text).join("");
		})
		.filter(Boolean)
		.join("\n");
}

function normalizeDate(text: string): string | undefined {
	const match = text.match(/(\d{4})(?:\s*年|[-/])\s*(\d{1,2})(?:\s*月|[-/])\s*(\d{1,2})(?:\s*日)?/);
	if (!match) return undefined;
	const value = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
	return isStrictDate(value) ? value : undefined;
}

function isStrictDate(value: string): boolean {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const date = new Date(Date.UTC(year, month - 1, day));
	return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function decodeXml(value: string): string {
	return value
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
		.replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number(decimal)))
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.trim();
}

function xmlLocalValues(xml: string, localName: string): string[] {
	const escaped = localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const expression = new RegExp(
		`<(?:[\\w.-]+:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${escaped}>`,
		"gi",
	);
	const values = [...xml.matchAll(expression)]
		.map((match) => decodeXml(match[1].replace(/<[^>]+>/g, "")))
		.filter(Boolean);
	return [...new Set(values)];
}

function uniqueXmlLocalValue(xml: string, localNames: string[], label: string): string | undefined {
	const values = [...new Set(localNames.flatMap((localName) => xmlLocalValues(xml, localName)))];
	if (values.length > 1) throw new Error(`铁路票据 XBRL 字段“${label}”存在多个冲突值，已拒绝自动选取`);
	return values[0];
}

const STATION_CITY_ALIASES: Record<string, string> = {
	上海虹桥: "上海",
	上海南: "上海",
	上海西: "上海",
	北京朝阳: "北京",
	北京北: "北京",
	北京南: "北京",
	北京西: "北京",
	天津西: "天津",
	重庆北: "重庆",
	重庆西: "重庆",
	南京南: "南京",
	常州北: "常州",
	苏州北: "苏州",
};

function stationToCity(station: string | undefined): string | undefined {
	if (!station) return undefined;
	const base = station.trim().replace(/站$/, "");
	const alias = STATION_CITY_ALIASES[base];
	if (alias) return alias;
	return base.length >= 3 && /[东南西北]$/.test(base) ? base.slice(0, -1) : base;
}

function parseRailwayXbrl(xml: string): Partial<RailwayInvoice> {
	const value = (localName: string, label: string) => uniqueXmlLocalValue(xml, [localName], label);
	const fare = value("Fare", "票价");
	const rawDate = value("TravelDate", "乘车日期");
	const rawIssueDate = value("DateOfIssue", "开票日期");
	return {
		fromStation: value("DepartureStation", "出发站"),
		toStation: value("DestinationStation", "到达站"),
		trainNumber: value("TrainNumber", "车次"),
		date: rawDate ? normalizeDate(rawDate) : undefined,
		departTime: value("DepartureTime", "出发时间")?.match(/\d{1,2}:\d{2}/)?.[0],
		seatClass: value("SeatLevel", "席别"),
		amount: fare && Number.isFinite(Number(fare.replace(/[^\d.]/g, ""))) ? Number(fare.replace(/[^\d.]/g, "")) : undefined,
		passenger: value("Name", "乘车人"),
		invoiceNumber: uniqueXmlLocalValue(
			xml,
			["InvoiceNumber", "ElectronicInvoiceRailwayETicketNumber", "ElectronicTicketNumber", "TicketNumber"],
			"票号",
		),
		issueDate: rawIssueDate ? normalizeDate(rawIssueDate) : undefined,
	};
}

function parseRailwayText(text: string): Partial<RailwayInvoice> {
	const result: Partial<RailwayInvoice> = {};
	const lines = text.split("\n").map((line) => line.trim());

	// 典型票面行：“南京南站G7575常州站”——出发站、车次、到达站同行
	const routeLine = /([\u4e00-\u9fa5]{2,8}站)\s*([GDC]\d{1,5})\s*([\u4e00-\u9fa5]{2,8}站)/.exec(text);
	if (routeLine) {
		result.fromStation = routeLine[1];
		result.trainNumber = routeLine[2];
		result.toStation = routeLine[3];
	} else {
		const train = text.match(/\b([GDC]\d{1,5})\b/);
		if (train) result.trainNumber = train[1];
		const depart = text.match(/([\u4e00-\u9fa5]{2,8}站)\s*(\d{1,2}:\d{2})\s*开/);
		if (depart) {
			result.fromStation = depart[1];
			const after = text.slice((depart.index ?? 0) + depart[0].length);
			const arrival = after.match(/([\u4e00-\u9fa5]{2,8}站)/);
			if (arrival) result.toStation = arrival[1];
		} else {
			const stations = [...new Set([...text.matchAll(/([\u4e00-\u9fa5]{2,8}站)/g)].map((m) => m[1]))];
			if (stations.length >= 2) {
				result.fromStation = stations[0];
				result.toStation = stations[1];
			}
		}
	}
	const departTime = text.match(/(\d{1,2}:\d{2})\s*开/);
	if (departTime) result.departTime = departTime[1];
	result.date = normalizeDate(text);
	const seat = text.match(/(商务座|特等座|一等座|二等座|硬卧|软卧|硬座|无座)/);
	if (seat) result.seatClass = seat[1];
	// 优先“票价:￥72.00”，退化为全文最大的 ￥ 金额
	const fare = text.match(/票价[：:]?\s*[¥￥]?\s*(\d+(?:\.\d+)?)/);
	if (fare) result.amount = Number(fare[1]);
	else {
		const amounts = [...text.matchAll(/[¥￥]\s*(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
		if (amounts.length > 0) result.amount = Math.max(...amounts);
	}
	const passengerLabel = text.match(/乘车人[：:]?\s*([\u4e00-\u9fa5]{2,4})/);
	if (passengerLabel) result.passenger = passengerLabel[1];
	else {
		// 真实票面：姓名独立一行，紧挨着下一行的脱敏身份证号
		for (let i = 0; i + 1 < lines.length; i++) {
			if (/^[\u4e00-\u9fa5]{2,4}$/.test(lines[i]) && /^\d{6}[\d*]{8,16}$/.test(lines[i + 1])) {
				result.passenger = lines[i];
				break;
			}
		}
	}
	const invoiceNumber = text.match(/发票号码[：:]?(\d{8,26})/) ?? text.match(/\b(\d{20})\b/);
	if (invoiceNumber) result.invoiceNumber = invoiceNumber[1];
	const issue = text.match(/开票日期[：:]?\s*(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)/);
	if (issue) result.issueDate = normalizeDate(issue[1]);
	return result;
}

function unpackArchive(file: string, destination: string, budget: ExtractionBudget): string | undefined {
	let reserved: ZipArchiveSummary | undefined;
	let chargedEntries = 0;
	let chargedBytes = 0;
	try {
		reserved = inspectZipArchive(file);
		if (budget.entries + reserved.entries > MAX_ARCHIVE_ENTRIES) {
			throw new Error(`本批压缩包累计条目超过 ${MAX_ARCHIVE_ENTRIES} 个安全上限`);
		}
		if (budget.bytes + reserved.uncompressedBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
			throw new Error(`本批压缩包累计解压量超过 ${MAX_ARCHIVE_UNCOMPRESSED_BYTES / 1024 / 1024}MB 安全上限`);
		}
		budget.entries += reserved.entries;
		budget.bytes += reserved.uncompressedBytes;
		chargedEntries = reserved.entries;
		chargedBytes = reserved.uncompressedBytes;
		execFileSync(systemTarExecutable(), ["-xf", file, "-C", destination], { windowsHide: true, timeout: 15000 });
		const actual = { entries: 0, bytes: 0 };
		listFilesRecursive(destination, destination, 0, actual);
		const extraEntries = Math.max(0, actual.entries - reserved.entries);
		const extraBytes = Math.max(0, actual.bytes - reserved.uncompressedBytes);
		if (budget.entries + extraEntries > MAX_ARCHIVE_ENTRIES || budget.bytes + extraBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
			throw new Error("压缩包实际解压结果超过本批共享安全预算");
		}
		budget.entries += extraEntries;
		budget.bytes += extraBytes;
		chargedEntries += extraEntries;
		chargedBytes += extraBytes;
		return undefined;
	} catch (error) {
		budget.entries -= chargedEntries;
		budget.bytes -= chargedBytes;
		rmSync(destination, { recursive: true, force: true });
		mkdirSync(destination, { recursive: true });
		return error instanceof Error ? error.message : String(error);
	}
}

function fileDigest(file: string): string {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * 把解压目录里的票据复制到工作区的持久目录。文件名同时包含票号与内容摘要：
 * 同一附件重试时复用稳定路径，不同内容即使同名也绝不会互相覆盖。
 */
export function durableAttachment(workspaceRoot: string, picked: string | undefined, identity: string): string {
	if (!picked) throw new Error("没有找到可上传的铁路电子客票附件");
	if (!existsSync(picked) || !statSync(picked).isFile()) throw new Error(`票据附件不存在：${picked}`);
	const pickedExtension = extname(picked).toLocaleLowerCase("en-US");
	const extension = [".pdf", ".ofd", ".png", ".jpg", ".jpeg"].includes(pickedExtension) ? pickedExtension : ".bin";
	// 智能识票明确要求文件名为不超过 20 个字符的字母/数字；票号仍保留在结构化计划中，
	// 上传显示名只使用稳定内容摘要，避免中文名、长票号或 UUID 导致无法预览。
	void identity;
	const durableDir = join(workspaceRoot, ".pi", "travel-expense", "attachments");
	mkdirSync(durableDir, { recursive: true });
	const sourceDigest = fileDigest(picked);
	const durable = join(durableDir, `T${sourceDigest.slice(0, 12)}${extension}`);
	const matchesSource = () =>
		existsSync(durable) &&
		lstatSync(durable).isFile() &&
		statSync(durable).size === statSync(picked).size &&
		fileDigest(durable) === sourceDigest;
	if (existsSync(durable)) {
		if (matchesSource()) return durable;
		throw new Error("票据附件持久化失败：短摘要目标已存在但完整内容不同，已拒绝覆盖");
	}
	let created = false;
	try {
		copyFileSync(picked, durable, fsConstants.COPYFILE_EXCL);
		created = true;
		if (!existsSync(durable) || statSync(durable).size !== statSync(picked).size || fileDigest(durable) !== sourceDigest) {
			throw new Error("复制后的文件内容校验失败");
		}
		return durable;
	} catch (error) {
		if (created) rmSync(durable, { force: true });
		else if (matchesSource()) return durable;
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`票据附件持久化失败：${reason}`);
	}
}

function parseExtractedDocument(document: ExtractedDocument, requested: string, workspaceRoot: string): RailwayInvoice {
	if (document.error) {
		return { source: `${requested}#${document.source}`, uploadFile: document.attachment ?? "", error: document.error };
	}
	const files = listFilesRecursive(document.root);
	const xbrlFiles = files.filter((path) => /[\\/]Doc_0[\\/]Attachs[\\/]rai_issuer_[^\\/]+\.xml$/i.test(path));
	if (xbrlFiles.length > 1) {
		return {
			source: `${requested}#${document.source}`,
			uploadFile: document.attachment ?? "",
			error: `OFD 内含 ${xbrlFiles.length} 份铁路票据 XBRL，无法确定该 OFD 应绑定哪一程`,
		};
	}
	const xbrlFile = xbrlFiles[0];
	let xbrl: Partial<RailwayInvoice> = {};
	if (xbrlFile) {
		try {
			xbrl = parseRailwayXbrl(readFileSync(xbrlFile, "utf8"));
		} catch (error) {
			return {
				source: `${requested}#${document.source}`,
				uploadFile: document.attachment ?? "",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}
	const content = files
		.filter((path) => /content\.xml$/i.test(path))
		.map((path) => ofdXmlText(readFileSync(path, "utf8")))
		.join("\n");
	if (!xbrlFile && !content) {
		return { source: document.source, uploadFile: "", error: "OFD 中没有铁路电子客票 XBRL 或 Content.xml" };
	}
	const fallback = content ? parseRailwayText(content) : {};
	const parsed = { ...fallback, ...Object.fromEntries(Object.entries(xbrl).filter(([, value]) => value !== undefined && value !== "")) };
	const fromStation = parsed.fromStation;
	const toStation = parsed.toStation;
	let uploadFile = "";
	try {
		uploadFile = durableAttachment(workspaceRoot, document.attachment, parsed.invoiceNumber ?? document.source);
	} catch (error) {
		return {
			source: `${requested}#${document.source}`,
			uploadFile,
			...parsed,
			fromStation,
			toStation,
			fromCity: stationToCity(fromStation),
			toCity: stationToCity(toStation),
			error: error instanceof Error ? error.message : String(error),
		};
	}
	return {
		source: `${requested}#${document.source}`,
		uploadFile,
		...parsed,
		fromStation,
		toStation,
		fromCity: stationToCity(fromStation),
		toCity: stationToCity(toStation),
	};
}

interface RailwayArchiveResult {
	invoices: RailwayInvoice[];
	ocrDocuments: TravelOcrDocument[];
}

/** 解析压缩输入中的 OFD、铁路电子客票 PDF 和待 OCR 查验/住宿附件。 */
function readRailwayInvoices(
	requested: string,
	workspaceRoot: string,
	extractionBudget: ExtractionBudget,
	readOcrDocument: (file: string) => TravelOcrDocument,
): RailwayArchiveResult {
	const file = isAbsolute(requested) ? resolve(requested) : resolve(workspaceRoot, requested);
	if (!existsSync(file) || !statSync(file).isFile()) {
		return { invoices: [{ source: requested, uploadFile: file, error: "文件不存在" }], ocrDocuments: [] };
	}
	const lower = file.toLocaleLowerCase("en-US");
	if (!lower.endsWith(".ofd") && !lower.endsWith(".zip")) {
		return {
			invoices: [{ source: requested, uploadFile: file, error: "只支持 .ofd 或含 OFD/PDF 的 .zip 压缩包" }],
			ocrDocuments: [],
		};
	}
	const workDir = mkdtempSync(join(tmpdir(), "pi-invoice-"));
	try {
		const unpackError = unpackArchive(file, workDir, extractionBudget);
		if (unpackError) {
			return {
				invoices: [{ source: requested, uploadFile: file, error: `解压失败：${unpackError}` }],
				ocrDocuments: [],
			};
		}
		const outerFiles = listFilesRecursive(workDir).sort((a, b) => a.localeCompare(b, "en"));
		const nestedOfds = outerFiles.filter((path) => /\.ofd$/i.test(path));
		const documents: ExtractedDocument[] = [];
		const usedAttachments = new Set<string>();
		if (nestedOfds.length > 0) {
			for (const [index, ofd] of nestedOfds.entries()) {
				const inner = join(workDir, `ofd-inner-${index}`);
				mkdirSync(inner, { recursive: true });
				const error = unpackArchive(ofd, inner, extractionBudget);
				if (error) {
					documents.push({ source: relative(workDir, ofd), root: inner, attachment: ofd, error: `解压失败：${error}` });
					continue;
				}
				const stem = basename(ofd).replace(/\.ofd$/i, "");
				const pdfCandidates = outerFiles.filter(
					(path) =>
						/\.pdf$/i.test(path) &&
						basename(path).replace(/\.pdf$/i, "").toLocaleLowerCase("en-US") === stem.toLocaleLowerCase("en-US") &&
						!usedAttachments.has(resolve(path).toLocaleLowerCase("en-US")),
				);
				const sameDirectory = pdfCandidates.filter(
					(path) => resolve(dirname(path)).toLocaleLowerCase("en-US") === resolve(dirname(ofd)).toLocaleLowerCase("en-US"),
				);
				const matchingPdf = sameDirectory[0] ?? (pdfCandidates.length === 1 ? pdfCandidates[0] : undefined);
				const attachment = matchingPdf ?? ofd;
				usedAttachments.add(resolve(attachment).toLocaleLowerCase("en-US"));
				documents.push({ source: relative(workDir, ofd), root: inner, attachment });
			}
		} else if (
			lower.endsWith(".ofd") ||
			outerFiles.some((path) =>
				/[\\/]Doc_0[\\/](?:Attachs[\\/]rai_issuer_[^\\/]+\.xml|Pages[\\/].*[\\/]Content\.xml)$/i.test(path),
			)
		) {
			documents.push({ source: basename(file), root: workDir, attachment: file });
		}
		const invoices = documents.map((document) => parseExtractedDocument(document, requested, workspaceRoot));
		const ocrDocuments: TravelOcrDocument[] = [];
		const remainingPdfs = outerFiles.filter(
			(path) => /\.pdf$/i.test(path) && !usedAttachments.has(resolve(path).toLocaleLowerCase("en-US")),
		);
		for (const pdf of remainingPdfs) {
			const archiveSource = `${requested}#${relative(workDir, pdf).replaceAll("\\", "/")}`;
			try {
				const pdfInvoices = readRailwayPdfFile(pdf, archiveSource, workspaceRoot);
				if (pdfInvoices) {
					invoices.push(...pdfInvoices);
					continue;
				}
				try {
					const durable = durableAttachment(workspaceRoot, pdf, basename(pdf, ".pdf"));
					ocrDocuments.push(readOcrDocument(durable));
				} catch (error) {
					ocrDocuments.push({
						file: archiveSource,
						text: "",
						fingerprint: { invoiceNumbers: [], trainNumbers: [], amounts: [] },
						error: error instanceof Error ? error.message : String(error),
					});
				}
			} catch (error) {
				invoices.push({
					source: archiveSource,
					uploadFile: pdf,
					error: `PDF 票据解析失败：${error instanceof Error ? error.message : String(error)}`,
				});
			}
		}
		if (invoices.length === 0 && ocrDocuments.length === 0) {
			invoices.push({ source: requested, uploadFile: file, error: "压缩包里没有可解析的 OFD 或 PDF 差旅附件" });
		}
		return { invoices, ocrDocuments };
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
}

function resolveAttachmentPath(requested: string, workspaceRoot: string): string {
	return isAbsolute(requested) ? resolve(requested) : resolve(workspaceRoot, requested);
}

/** Parse the authoritative rai_issuer XBRL embedded in a railway e-ticket PDF. */
function readRailwayPdfFile(file: string, source: string, workspaceRoot: string): RailwayInvoice[] | undefined {
	const size = statSync(file).size;
	if (size > MAX_TICKET_PDF_BYTES) {
		throw new Error(`电子客票 PDF 超过 ${MAX_TICKET_PDF_BYTES / 1024 / 1024}MB 安全上限`);
	}
	const embedded = extractRailwayEmbeddedXml(readFileSync(file), { maxPdfBytes: MAX_TICKET_PDF_BYTES });
	if (embedded.length === 0) return undefined;
	if (embedded.length > 1) {
		return [{
			source,
			uploadFile: file,
			error: `PDF 内含 ${embedded.length} 份铁路票据 XBRL，无法确定该 PDF 应绑定哪一程；请分别提供单张电子客票 PDF`,
		}];
	}
	const item = embedded[0];
	const parsed = parseRailwayXbrl(item.xml);
	const fromStation = parsed.fromStation;
	const toStation = parsed.toStation;
	let uploadFile = "";
	try {
		uploadFile = durableAttachment(workspaceRoot, file, parsed.invoiceNumber ?? basename(file, ".pdf"));
	} catch (error) {
		return [{
			source: `${source}#${item.name}`,
			uploadFile,
			...parsed,
			fromStation,
			toStation,
			fromCity: stationToCity(fromStation),
			toCity: stationToCity(toStation),
			error: error instanceof Error ? error.message : String(error),
		}];
	}
	return [{
		source: `${source}#${item.name}`,
		uploadFile,
		...parsed,
		fromStation,
		toStation,
		fromCity: stationToCity(fromStation),
		toCity: stationToCity(toStation),
	}];
}

function readRailwayPdf(requested: string, workspaceRoot: string): RailwayInvoice[] | undefined {
	return readRailwayPdfFile(resolveAttachmentPath(requested, workspaceRoot), requested, workspaceRoot);
}

interface OcrScriptOutput {
	ok: boolean;
	pageCount?: number;
	processedPages?: number;
	truncated?: boolean;
	text?: string;
	error?: string;
}

function parseOcrScriptOutput(value: string): OcrScriptOutput | undefined {
	const lines = value.replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	for (let index = lines.length - 1; index >= 0; index--) {
		try {
			const parsed = JSON.parse(lines[index]) as OcrScriptOutput;
			if (typeof parsed.ok === "boolean") return parsed;
		} catch {
			// PowerShell may emit a localized prelude; only the final JSON object is authoritative.
		}
	}
	return undefined;
}

/** External PowerShell cannot read Electron's virtual app.asar path. */
export function travelExpenseResourceCandidates(
	moduleFile = fileURLToPath(import.meta.url),
	resourceName = "pdf-ocr.ps1",
): string[] {
	const direct = join(dirname(moduleFile), resourceName);
	const unpacked = direct.replace(/([\\/])app\.asar([\\/])/i, "$1app.asar.unpacked$2");
	return unpacked !== direct ? [unpacked, direct] : [direct];
}

function travelExpenseResourcePath(resourceName: string): string {
	const candidates = travelExpenseResourceCandidates(fileURLToPath(import.meta.url), resourceName);
	const resource = candidates.find((candidate) => existsSync(candidate));
	if (!resource) throw new Error(`安装包缺少差旅资源：${resourceName}`);
	return resource;
}

/** Windows-only bounded OCR for scanned verification PDFs and screenshots. */
export function ocrTravelDocument(file: string, timeoutMs = OCR_TIMEOUT_MS): TravelOcrDocument {
	const empty = { invoiceNumbers: [], trainNumbers: [], amounts: [] };
	if (process.platform !== "win32") {
		return { file, text: "", fingerprint: empty, error: "扫描 PDF/图片需要 Windows OCR；当前平台无法识别" };
	}
	if (!/\.(?:pdf|png|jpe?g)$/i.test(file)) {
		return { file, text: "", fingerprint: empty, error: "OCR 只支持 PDF、PNG 或 JPEG" };
	}
	const size = statSync(file).size;
	if (size > MAX_OCR_DOCUMENT_BYTES) {
		return {
			file,
			text: "",
			fingerprint: empty,
			error: `扫描 PDF/图片超过 ${MAX_OCR_DOCUMENT_BYTES / 1024 / 1024}MB 安全上限`,
		};
	}
	const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
	const bundled = systemRoot ? join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "";
	const executable = bundled && existsSync(bundled) ? bundled : "powershell.exe";
	const script = travelExpenseResourcePath("pdf-ocr.ps1");
	try {
		const output = execFileSync(
			executable,
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				script,
				"-Path",
				file,
				"-MaxPages",
				String(OCR_MAX_PAGES),
				"-MaxDimension",
				"2200",
			],
			{
				encoding: "utf8",
				shell: false,
				windowsHide: true,
				timeout: Math.max(1_000, Math.min(OCR_TIMEOUT_MS, Math.floor(timeoutMs))),
				maxBuffer: 512 * 1024,
			},
		);
		const parsed = parseOcrScriptOutput(output);
		if (!parsed?.ok) {
			return { file, text: "", fingerprint: empty, error: `Windows OCR 失败：${parsed?.error ?? "没有返回结果"}` };
		}
		const text = (parsed.text ?? "").slice(0, 120_000);
		const fingerprint = parseVerificationFingerprint(text);
		if (parsed.truncated && fingerprint.invoiceNumbers.length + fingerprint.trainNumbers.length + fingerprint.amounts.length === 0) {
			return { file, text, fingerprint, error: `PDF 超过 ${OCR_MAX_PAGES} 页，前 ${OCR_MAX_PAGES} 页未识别到配对标识` };
		}
		return { file, text, fingerprint };
	} catch (error) {
		const output = parseOcrScriptOutput(String((error as { stdout?: string | Buffer }).stdout ?? ""));
		const reason = output?.error ?? (error instanceof Error ? error.message : String(error));
		return { file, text: "", fingerprint: empty, error: `Windows OCR 失败：${reason.slice(0, 300)}` };
	}
}

/** Kept for read-only diagnostics and older callers. */
export function ocrTravelPdf(file: string): TravelOcrDocument {
	return ocrTravelDocument(file);
}

/**
 * Deterministic attachment precheck for high-level workflows such as travel_fill_draft.
 * Call once with all travel attachments and stop before browser mutation unless the
 * railway pairing (and, for multi-day travel, lodging resolution) is ready.
 */
export function readAndPairRailwayAttachments(
	paths: string[],
	workspaceRoot: string,
	options: { ocrTravelDocument?: (file: string, timeoutMs: number) => TravelOcrDocument } = {},
): InvoiceAttachmentResult {
	if (!Array.isArray(paths) || paths.length === 0) throw new Error("请至少提供一个差旅附件");
	if (paths.length > MAX_TRAVEL_INPUT_FILES) {
		throw new Error(`差旅附件一次最多 ${MAX_TRAVEL_INPUT_FILES} 个，请移除无关文件后重试`);
	}
	let totalInputBytes = 0;
	for (const requested of paths) {
		const file = resolveAttachmentPath(requested, workspaceRoot);
		if (!existsSync(file) || !statSync(file).isFile()) continue;
		totalInputBytes += statSync(file).size;
		if (totalInputBytes > MAX_TRAVEL_INPUT_BYTES) {
			throw new Error(`差旅附件总量超过 ${MAX_TRAVEL_INPUT_BYTES / 1024 / 1024}MB 安全上限`);
		}
	}
	const invoices: RailwayInvoice[] = [];
	const ocrDocuments: TravelOcrDocument[] = [];
	const extractionBudget: ExtractionBudget = { entries: 0, bytes: 0 };
	const ocrStartedAt = Date.now();
	let ocrCount = 0;
	const readOcrDocument = (file: string): TravelOcrDocument => {
		ocrCount += 1;
		if (ocrCount > MAX_OCR_DOCUMENTS) {
			return {
				file,
				text: "",
				fingerprint: { invoiceNumbers: [], trainNumbers: [], amounts: [] },
				error: `需要 OCR 的 PDF/图片超过 ${MAX_OCR_DOCUMENTS} 个安全上限`,
			};
		}
		const remainingMs = MAX_OCR_WALL_MS - (Date.now() - ocrStartedAt);
		if (remainingMs < 1_000) {
			return {
				file,
				text: "",
				fingerprint: { invoiceNumbers: [], trainNumbers: [], amounts: [] },
				error: `本批 OCR 已超过 ${Math.round(MAX_OCR_WALL_MS / 1000)} 秒总时限`,
			};
		}
		return (options.ocrTravelDocument ?? ocrTravelDocument)(file, remainingMs);
	};
	for (const requested of paths) {
		const file = resolveAttachmentPath(requested, workspaceRoot);
		if (!existsSync(file) || !statSync(file).isFile()) {
			invoices.push({ source: requested, uploadFile: file, error: "文件不存在" });
			continue;
		}
		if (/\.pdf$/i.test(file)) {
			try {
				const pdfInvoices = readRailwayPdf(requested, workspaceRoot);
				if (pdfInvoices) invoices.push(...pdfInvoices);
				else ocrDocuments.push(readOcrDocument(file));
			} catch (error) {
				invoices.push({
					source: requested,
					uploadFile: file,
					error: `PDF 票据解析失败：${error instanceof Error ? error.message : String(error)}`,
				});
			}
			continue;
		}
		if (/\.(?:png|jpe?g)$/i.test(file)) {
			ocrDocuments.push(readOcrDocument(file));
			continue;
		}
		const archive = readRailwayInvoices(requested, workspaceRoot, extractionBudget, readOcrDocument);
		invoices.push(...archive.invoices);
		ocrDocuments.push(...archive.ocrDocuments);
	}

	const seenInvoices = new Set<string>();
	for (const invoice of invoices) {
		if (invoice.error || !invoice.invoiceNumber) continue;
		if (seenInvoices.has(invoice.invoiceNumber)) invoice.error = `检测到重复票据：${invoice.invoiceNumber}`;
		else seenInvoices.add(invoice.invoiceNumber);
	}
	const validInvoiceIndexes = invoices
		.map((invoice, index) => ({ invoice, index }))
		.filter(({ invoice }) => !invoice.error)
		.map(({ index }) => index);
	let lodging = resolveLodgingInvoiceCandidate(ocrDocuments);
	if (lodging.status === "ready" && lodging.invoice) {
		const sourceInvoice = lodging.invoice;
		let activeFile = sourceInvoice.uploadFile;
		try {
			const durableFiles = new Set<string>();
			const persistUnique = (file: string, identity: string): string => {
				activeFile = file;
				const durable = durableAttachment(workspaceRoot, file, identity);
				const durableIdentity = resolve(durable).toLocaleLowerCase("en-US");
				if (durableFiles.has(durableIdentity)) {
					throw new Error("住宿主发票与查验附件或多个查验附件内容相同，不能重复绑定");
				}
				durableFiles.add(durableIdentity);
				return durable;
			};
			const uploadFile = persistUnique(sourceInvoice.uploadFile, sourceInvoice.invoiceNumber);
			const verificationFiles = sourceInvoice.verificationFiles.map((file, index) =>
				persistUnique(file, `${sourceInvoice.invoiceNumber}-verification-${index + 1}`),
			);
			const durableInvoice = { ...sourceInvoice, uploadFile, verificationFiles };
			lodging = { ...lodging, invoice: durableInvoice, candidates: [durableInvoice] };
		} catch (error) {
			lodging = {
				...lodging,
				status: "missing",
				invoice: undefined,
				issues: [
					...lodging.issues,
					{
						file: activeFile,
						kind: "missing",
						reason: error instanceof Error ? error.message : String(error),
						invoiceNumbers: [sourceInvoice.invoiceNumber],
						amounts: [sourceInvoice.amount],
					},
				],
			};
		}
	}
	const lodgingFiles = new Set(lodging.classifiedFiles);
	const verificationCandidates: VerificationCandidate[] = ocrDocuments
		.filter((document) => !lodgingFiles.has(document.file))
		.map(({ file, fingerprint, error }) => ({ file, fingerprint, error }));
	const pairing = matchVerificationFiles(
		validInvoiceIndexes.map((index) => invoices[index]),
		verificationCandidates,
	);
	const claimedDurableVerificationFiles = new Map<string, string>();
	for (const [validIndex, files] of pairing.verificationFilesByInvoice.entries()) {
		const invoice = invoices[validInvoiceIndexes[validIndex]];
		const durableFiles: string[] = [];
		for (const file of files) {
			try {
				const durable = durableAttachment(workspaceRoot, file, basename(file));
				const durableIdentity = resolve(durable).toLocaleLowerCase("en-US");
				const previous = claimedDurableVerificationFiles.get(durableIdentity);
				if (previous) {
					pairing.unmatched.push({
						file,
						reason: `查验附件内容与 ${basename(previous)} 重复，不能重复或跨行绑定`,
						fingerprint: { invoiceNumbers: [], trainNumbers: [], amounts: [] },
					});
					continue;
				}
				claimedDurableVerificationFiles.set(durableIdentity, file);
				durableFiles.push(durable);
			} catch (error) {
				pairing.unmatched.push({
					file,
					reason: `查验附件持久化失败：${error instanceof Error ? error.message : String(error)}`,
					fingerprint: { invoiceNumbers: [], trainNumbers: [], amounts: [] },
				});
			}
		}
		invoice.verificationFiles = durableFiles;
		invoice.verificationStatus = durableFiles.length > 0 ? "ready" : "missing";
	}
	const missing = validInvoiceIndexes
		.map((invoiceIndex) => ({ invoiceIndex, invoice: invoices[invoiceIndex] }))
		.filter(({ invoice }) => !invoice.verificationFiles?.length)
		.map(({ invoiceIndex, invoice }) => {
			return { invoiceIndex, invoiceNumber: invoice.invoiceNumber, source: invoice.source };
		});
	const ambiguous = pairing.ambiguous.map((item) => ({
		...item,
		candidateInvoiceIndexes: item.candidateInvoiceIndexes.map((validIndex) => validInvoiceIndexes[validIndex]),
		candidateInvoiceNumbers: item.candidateInvoiceIndexes.map(
			(validIndex) => invoices[validInvoiceIndexes[validIndex]].invoiceNumber ?? "未识别发票号",
		),
	}));
	return {
		invoices,
		pairingStatus:
			ambiguous.length > 0 || pairing.unmatched.length > 0
				? "ambiguous"
				: validInvoiceIndexes.length === 0 || missing.length > 0
					? "missing"
					: "ready",
		lodging,
		ocrDocuments,
		missing,
		ambiguous,
		unmatched: pairing.unmatched.map(({ file, reason }) => ({ file, reason })),
	};
}

interface TripLeg {
	from: string;
	to: string;
	date: string;
	seatClass: string;
	amount: number;
	passenger: string;
	invoiceNumber: string;
	uploadFile: string;
	verificationFiles: string[];
}

interface TripHotel {
	amount: number;
	checkin?: string;
	checkout?: string;
	uploadFile: string;
	verificationFiles: string[];
}

interface PlanParams {
	tripTitle?: string;
	startDate: string;
	endDate: string;
	legs: TripLeg[];
	hotel?: TripHotel;
}

/** 当前部署的报销人固定值；不暴露为工具参数，避免模型或提示词绕过。 */
const EXPECTED_PASSENGER = "苏爱健";

/** 报销规则速查：与技能文档同源的关键取值，模型可在流程中随时复核。 */
function reimbursementGuideText(): string {
	return [
		"差旅费用报销单填报规则（易快报/合思）：",
		"0. 票据预检：把全部电子客票 PDF/OFD/ZIP、查验 PDF 与多日行程的住宿发票 PDF 一次传给 travel_read_invoices；铁路须 pairingStatus=ready，多日住宿还须 lodging.status=ready，missing/ambiguous 必须一次性补齐且绝不猜测。",
		"1. 关联申请：必须从已有出差申请中选择（点击 data-testid=field-expenseLink-select，在弹窗中按标题搜索后勾选并确认）。",
		"2. 所属公司、提交人、报销日期（默认当天）、申请人部门、费用所属部门通常已自动带出；只需核对，一般不改动。",
		"3. 报销说明：写关联出差申请的事由（如“常州业务拓展”），字段 data-testid=field-text-u_事由。",
		"4. 驻地：在选择框直接输入“江苏省南京”并选择匹配结果，绝不选“市辖区/市区”一类节点。",
		"5. 费用性质：与关联的出差申请保持一致（常见两种：部门费用 / 项目费用），先在关联申请的“详情”里确认再填。",
		"6. 部门（如需手填）：申请人部门与费用所属部门一致，按 赛昇信息技术研究院江苏有限公司 / 政策支撑部 / 工业信息安全组 逐级选择。",
		"7. 关联项目、核销借款、“是否为多收款人”不处理。",
		"8. 支付信息：选择收款人“苏爱健”。",
		"9. 费用明细（点击 data-testid=field-expenseDetail-add 逐条添加）：",
		"   - 当天往返：城市交通费（火车/高铁）逐程一条 + 出差补助一条；没有住宿费。",
		"   - 多天出差：城市交通费逐程一条 + 住宿费一条 + 出差补助一条。",
		"   - 费用类型候选使用 data-testid=template-feeType-item 精确选择；每条明细填完用 feetype-footer-save 保存，并回读明细数。",
		"   - 城市交通费：费用类型固定选火车/高铁；乘车人必须为当前用户苏爱健；在必填“上传发票”绑定该程电子客票；起止日期、出发到达城市与出差申请一致；席别、金额与车票一致；该行附件定向上传车票文件+对应查验截图。",
		"   - 住宿费：金额与住宿发票一致，必须提供独立住宿发票文件；已有查验附件一并绑定，且不得复用交通行附件。",
		"   - 出差补助：补助类型固定选“其他省份”；起止日期与出差申请一致；补贴标准 180 元/天，金额由系统按天数自动核算。",
		"10. 全部填完后点击 存为草稿（data-testid=flexable-button-edit）。绝对不要点击 提交送审（flexable-button-submit）或 删除单据。",
	].join("\n");
}

function planDays(start: string, end: string): number {
	if (!isStrictDate(start) || !isStrictDate(end)) {
		throw new Error(`出差起止日期不合法：${start} ~ ${end}（格式应为 YYYY-MM-DD）`);
	}
	const startTime = Date.parse(`${start}T00:00:00Z`);
	const endTime = Date.parse(`${end}T00:00:00Z`);
	if (endTime < startTime) throw new Error(`出差起止日期不合法：${start} ~ ${end}（结束日期不得早于开始日期）`);
	return Math.round((endTime - startTime) / 86400000) + 1;
}

function assertDateInTrip(label: string, value: string, start: string, end: string): void {
	if (!isStrictDate(value)) throw new Error(`${label}日期不合法：${value}（格式应为 YYYY-MM-DD 且必须是真实日期）`);
	if (value < start || value > end) throw new Error(`${label}日期 ${value} 不在出差申请范围 ${start} ~ ${end} 内`);
}

interface DetailRow {
	kind: "城市交通费" | "住宿费" | "出差补助";
	summary: string;
	[key: string]: unknown;
}

function resolveRequiredAttachment(
	label: string,
	path: string,
	workspaceRoot: string,
	seen: Set<string>,
): string {
	if (typeof path !== "string" || !path.trim()) throw new Error(`${label}缺少文件路径`);
	const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(workspaceRoot, path);
	if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) throw new Error(`${label}文件不存在：${path}`);
	const identity = resolvedPath.toLocaleLowerCase("en-US");
	if (seen.has(identity)) throw new Error(`${label}与其他行程重复绑定：${path}`);
	seen.add(identity);
	return resolvedPath;
}

function buildDetailPlan(params: PlanParams, workspaceRoot: string): { rows: DetailRow[]; notes: string[] } {
	const days = planDays(params.startDate, params.endDate);
	const sameDay = days === 1;
	const allowancePerDay = 180;
	const rows: DetailRow[] = [];
	const seenInvoices = new Set<string>();
	const seenAttachmentFiles = new Set<string>();

	for (const [index, leg] of params.legs.entries()) {
		if (!leg.from.trim() || !leg.to.trim() || leg.from.trim() === leg.to.trim()) {
			throw new Error(`第 ${index + 1} 程出发/到达城市不合法`);
		}
		assertDateInTrip(`第 ${index + 1} 程乘车`, leg.date, params.startDate, params.endDate);
		if (!Number.isFinite(leg.amount) || leg.amount <= 0) throw new Error(`第 ${index + 1} 程票价必须大于 0`);
		if (!leg.seatClass.trim()) throw new Error(`第 ${index + 1} 程缺少火车席别`);
		if (!leg.passenger.trim()) throw new Error(`第 ${index + 1} 程缺少乘车人`);
		if (leg.passenger.trim() !== EXPECTED_PASSENGER) {
			throw new Error(`第 ${index + 1} 程乘车人必须为当前用户${EXPECTED_PASSENGER}，实际为${leg.passenger.trim()}`);
		}
		if (!leg.invoiceNumber.trim()) throw new Error(`第 ${index + 1} 程缺少发票号码，不能排除重复报销`);
		if (seenInvoices.has(leg.invoiceNumber.trim())) throw new Error(`检测到重复票据：${leg.invoiceNumber}`);
		seenInvoices.add(leg.invoiceNumber.trim());
		const uploadFile = resolveRequiredAttachment(`第 ${index + 1} 程电子客票`, leg.uploadFile, workspaceRoot, seenAttachmentFiles);
		if (!Array.isArray(leg.verificationFiles) || leg.verificationFiles.length === 0) {
			throw new Error(`第 ${index + 1} 程缺少对应的火车票查验附件`);
		}
		const verificationFiles = leg.verificationFiles.map((path, attachmentIndex) =>
			resolveRequiredAttachment(
				`第 ${index + 1} 程第 ${attachmentIndex + 1} 个查验附件`,
				path,
				workspaceRoot,
				seenAttachmentFiles,
			),
		);
		rows.push({
			kind: "城市交通费",
			summary: `交通 ${leg.from} → ${leg.to}（${leg.date}，${leg.seatClass}，¥${leg.amount}）`,
			费用类型: "城市交通费（火车/高铁）",
			排序: index + 1,
			出发城市: leg.from,
			到达城市: leg.to,
			起止日期: `${params.startDate} 至 ${params.endDate}`,
			乘车日期: leg.date,
			席别: leg.seatClass,
			报销金额: leg.amount,
			passenger: leg.passenger.trim(),
			invoiceNumber: leg.invoiceNumber.trim(),
			uploadFile,
			verificationFiles,
			乘车人: leg.passenger.trim(),
			发票号码: leg.invoiceNumber.trim(),
			电子客票附件: uploadFile,
			查验附件: verificationFiles,
		});
	}

	if (params.hotel) {
		if (!Number.isFinite(params.hotel.amount) || params.hotel.amount <= 0) {
			throw new Error("住宿费金额必须是大于 0 的有效数字");
		}
		if (sameDay) throw new Error("当天往返不应添加住宿费；请核对关联申请或住宿发票");
		const uploadFile = resolveRequiredAttachment("住宿发票", params.hotel.uploadFile, workspaceRoot, seenAttachmentFiles);
		if (!Array.isArray(params.hotel.verificationFiles)) throw new Error("住宿查验附件字段缺失（没有查验件时请传空数组）");
		const verificationFiles = params.hotel.verificationFiles.map((path, attachmentIndex) =>
			resolveRequiredAttachment(`第 ${attachmentIndex + 1} 个住宿查验附件`, path, workspaceRoot, seenAttachmentFiles),
		);
		const checkin = params.hotel.checkin ?? params.startDate;
		const checkout = params.hotel.checkout ?? params.hotel.checkin ?? params.endDate;
		assertDateInTrip("入住", checkin, params.startDate, params.endDate);
		assertDateInTrip("离店", checkout, params.startDate, params.endDate);
		if (checkout < checkin) throw new Error(`住宿日期不合法：${checkin} ~ ${checkout}`);
		rows.push({
			kind: "住宿费",
			summary: `住宿 ¥${params.hotel.amount}${params.hotel.checkin ? `（${params.hotel.checkin} ~ ${params.hotel.checkout ?? params.hotel.checkin}）` : ""}`,
			费用类型: "住宿费",
			起止日期: params.hotel.checkin
				? `${params.hotel.checkin} 至 ${params.hotel.checkout ?? params.hotel.checkin}`
				: `${params.startDate} 至 ${params.endDate}`,
			报销金额: params.hotel.amount,
			uploadFile,
			verificationFiles,
			住宿发票附件: uploadFile,
			住宿查验附件: verificationFiles,
		});
	} else if (!sameDay) {
		throw new Error("多天出差必须提供住宿费金额（或明确说明此行住宿费单独报销的原因）");
	}

	rows.push({
		kind: "出差补助",
		summary: `出差补助 ${days} 天 × ¥${allowancePerDay}（其他省份）`,
		费用类型: "出差补助",
		补助类型: "其他省份",
		起止日期: `${params.startDate} 至 ${params.endDate}`,
		天数: days,
		备注: `金额 ${days * allowancePerDay} 元由系统按天数自动核算，无需手填`,
	});

	const notes = [
		sameDay
			? "当天往返：不添加住宿费明细。"
			: `多天出差：住宿费一条，补助 ${days} 天。`,
		"金额、支付总额以系统自动核算为准；如与计划不一致，以票据实际金额复核。",
	];
	if (params.tripTitle) notes.push(`关联申请：${params.tripTitle}`);
	return { rows, notes };
}

export interface FillTravelDraftParams {
	url?: string;
	paths?: string[];
	applicationHint?: string;
}

export interface FillTravelDraftDependencies {
	readAttachments?: (paths: string[], cwd: string) => InvoiceAttachmentResult;
	createDriver?: (options: TravelDraftBrowserDriverOptions) => TravelDraftBrowserDriver;
}

const TRAVEL_SAVE_INTENT_VERSION = 1;

function travelSaveIntentPath(cwd: string, plan: TravelDraftPlan): string {
	return join(cwd, ".pi", "travel-expense", `save-intent-${travelDraftSaveIdentity(plan)}.json`);
}

function travelSaveIntentExists(cwd: string, plan: TravelDraftPlan): boolean {
	try {
		lstatSync(travelSaveIntentPath(cwd, plan));
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function persistTravelSaveIntent(cwd: string, plan: TravelDraftPlan): void {
	const identity = travelDraftSaveIdentity(plan);
	const directory = join(cwd, ".pi", "travel-expense");
	const target = join(directory, `save-intent-${identity}.json`);
	mkdirSync(directory, { recursive: true });
	let descriptor: number;
	try {
		descriptor = openSync(target, "wx", 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
		throw error;
	}
	try {
		writeFileSync(
			descriptor,
			`${JSON.stringify({ version: TRAVEL_SAVE_INTENT_VERSION, saveIdentity: identity, state: "save_requested" })}\n`,
			"utf8",
		);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

interface CompleteRailwayInvoice extends RailwayInvoice {
	trainNumber: string;
	fromStation: string;
	toStation: string;
	fromCity: string;
	toCity: string;
	date: string;
	seatClass: string;
	amount: number;
	passenger: string;
	invoiceNumber: string;
	uploadFile: string;
	verificationFiles: string[];
}

function workflowIssue(code: string, field: string, message: string): TravelDraftIssue {
	return { code, field, message };
}

function completeRailwayInvoiceIssues(result: InvoiceAttachmentResult): {
	ready: CompleteRailwayInvoice[];
	missing: TravelDraftIssue[];
	ambiguous: TravelDraftIssue[];
} {
	const missing: TravelDraftIssue[] = [];
	const ambiguous: TravelDraftIssue[] = [];
	const ready: CompleteRailwayInvoice[] = [];
	if (result.invoices.length === 0) {
		missing.push(workflowIssue("missing_railway_ticket", "paths", "没有解析出铁路电子客票"));
	}
	for (const [index, invoice] of result.invoices.entries()) {
		if (invoice.error) {
			ambiguous.push(workflowIssue("invalid_railway_ticket", `invoices[${index}]`, invoice.error));
			continue;
		}
		const required = [
			["trainNumber", invoice.trainNumber, "车次"],
			["fromStation", invoice.fromStation, "原始出发站"],
			["toStation", invoice.toStation, "原始到达站"],
			["fromCity", invoice.fromCity, "出发城市"],
			["toCity", invoice.toCity, "到达城市"],
			["date", invoice.date, "乘车日期"],
			["seatClass", invoice.seatClass, "席别"],
			["passenger", invoice.passenger, "乘车人"],
			["invoiceNumber", invoice.invoiceNumber, "发票号码"],
			["uploadFile", invoice.uploadFile, "电子客票附件"],
		] as const;
		for (const [field, value, label] of required) {
			if (typeof value !== "string" || !value.trim()) {
				missing.push(workflowIssue("missing_ticket_field", `invoices[${index}].${field}`, `第 ${index + 1} 张票缺少${label}`));
			}
		}
		if (!Number.isFinite(invoice.amount) || (invoice.amount ?? 0) <= 0) {
			missing.push(workflowIssue("missing_ticket_amount", `invoices[${index}].amount`, `第 ${index + 1} 张票缺少有效票价`));
		}
		if (!invoice.verificationFiles?.length) {
			missing.push(workflowIssue("missing_verification", `invoices[${index}].verificationFiles`, `第 ${index + 1} 张票缺少唯一匹配的查验附件`));
		}
		if (
			required.every(([, value]) => typeof value === "string" && value.trim()) &&
			Number.isFinite(invoice.amount) &&
			(invoice.amount ?? 0) > 0 &&
			Boolean(invoice.verificationFiles?.length)
		) {
			ready.push(invoice as CompleteRailwayInvoice);
		}
	}
	for (const item of result.ambiguous) {
		ambiguous.push(
			workflowIssue(
				"ambiguous_verification",
				"paths",
				`查验附件无法唯一匹配：同时匹配 ${item.candidateInvoiceNumbers.join("、")}`,
			),
		);
	}
	for (const item of result.missing) {
		missing.push(
			workflowIssue(
				"missing_verification",
				`invoices[${item.invoiceIndex}].verificationFiles`,
				`发票 ${item.invoiceNumber ?? item.source} 缺少唯一匹配的查验附件`,
			),
		);
	}
	for (const item of result.unmatched) {
		ambiguous.push(
			workflowIssue(
				"unmatched_attachment",
				"paths",
				`附件 ${basename(item.file)} 未能归属到任一车票或住宿发票：${item.reason}`,
			),
		);
	}
	if (result.pairingStatus !== "ready" && result.missing.length === 0 && result.ambiguous.length === 0) {
		missing.push(workflowIssue("railway_pairing_not_ready", "paths", "铁路电子票与查验附件尚未全部唯一配对"));
	}
	return { ready, missing, ambiguous };
}

function certainPreDiscoveryLodgingIssues(lodging: LodgingInvoiceResolution): {
	missing: TravelDraftIssue[];
	ambiguous: TravelDraftIssue[];
} {
	const missing: TravelDraftIssue[] = [];
	const ambiguous: TravelDraftIssue[] = [];
	if (lodging.status !== "ambiguous" && !(lodging.status === "missing" && lodging.classifiedFiles.length > 0)) {
		return { missing, ambiguous };
	}
	const target = lodging.status === "ambiguous" ? ambiguous : missing;
	target.push(
		workflowIssue(
			lodging.status === "ambiguous" ? "ambiguous_lodging" : "unresolved_lodging_attachment",
			"hotel",
			lodging.status === "ambiguous"
				? "住宿发票存在多个候选或字段冲突，需先核对附件"
				: "已识别到住宿相关附件，但未能唯一确定住宿主发票，需先补齐或替换附件",
		),
	);
	for (const item of lodging.issues) {
		target.push(workflowIssue(`lodging_${item.kind}`, "hotel", item.reason));
	}
	return { missing, ambiguous };
}

function localIsoDate(now = new Date()): string {
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function inclusiveDateCount(startDate: string, endDate: string): number {
	return Math.floor((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000) + 1;
}

function conciseIssues(missing: TravelDraftIssue[], ambiguous: TravelDraftIssue[], errors: string[] = []): string {
	const messages = [...missing, ...ambiguous].map((item) => item.message);
	for (const error of errors) if (error.trim()) messages.push(error.trim());
	return [...new Set(messages)].map((message) => `- ${redactSensitiveText(message)}`).join("\n");
}

function stoppedWorkflowResult(
	status: "needs_input" | "blocked" | "interrupted",
	stage: string,
	missing: TravelDraftIssue[],
	ambiguous: TravelDraftIssue[],
	errors: string[] = [],
	draftSaveStateUncertain = false,
	draftSaveRequested = false,
): AgentToolResult<unknown> {
	const label = status === "needs_input" ? "开始自动填报前还缺少以下信息" : status === "interrupted" ? "自动填报已中断" : "自动填报已安全停止";
	const disposition = draftSaveStateUncertain ? "已进入保存阶段，草稿状态未确认，未提交" : "未保存、未提交";
	return textResult(`${label}（${disposition}）：\n${conciseIssues(missing, ambiguous, errors) || "- 页面状态未通过确定性核验"}`, {
		status,
		stage,
		draftSaved: false,
		draftSaveStateUncertain,
		draftSaveRequested,
		missing,
		ambiguous,
		errors: errors.map(redactSensitiveText),
	});
}

export async function fillTravelDraft(
	params: FillTravelDraftParams,
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate: ((result: AgentToolResult<unknown>) => void) | undefined,
	dependencies: FillTravelDraftDependencies = {},
): Promise<AgentToolResult<unknown>> {
	const progress = (message: string, stage: string) =>
		onUpdate?.(textResult(message, { status: "running", stage, draftSaved: false }));
	if (signal?.aborted) return stoppedWorkflowResult("interrupted", "PRECHECK", [], [], ["用户已停止任务"]);
	const url = typeof params.url === "string" ? params.url.trim() : "";
	const paths = Array.isArray(params.paths) ? params.paths : [];
	const missingInputs: TravelDraftIssue[] = [];
	if (!url) missingInputs.push(workflowIssue("missing_url", "url", "缺少易快报差旅费用报销链接"));
	if (paths.length === 0) {
		missingInputs.push(workflowIssue("missing_attachments", "paths", "缺少本次行程的火车票和对应查验附件"));
	}
	if (missingInputs.length > 0) {
		return stoppedWorkflowResult("needs_input", "PRECHECK", missingInputs, []);
	}
	progress("正在一次性核对全部车票、查验件和住宿附件…", "PRECHECK");
	let attachments: InvoiceAttachmentResult;
	try {
		attachments = (dependencies.readAttachments ?? readAndPairRailwayAttachments)(paths, cwd);
	} catch (error) {
		return stoppedWorkflowResult("needs_input", "PRECHECK", [], [], [error instanceof Error ? error.message : String(error)]);
	}
	const invoiceCheck = completeRailwayInvoiceIssues(attachments);
	if (invoiceCheck.missing.length > 0 || invoiceCheck.ambiguous.length > 0 || attachments.pairingStatus !== "ready") {
		return stoppedWorkflowResult("needs_input", "PRECHECK", invoiceCheck.missing, invoiceCheck.ambiguous);
	}
	const lodgingPrecheck = certainPreDiscoveryLodgingIssues(attachments.lodging);
	if (lodgingPrecheck.missing.length > 0 || lodgingPrecheck.ambiguous.length > 0) {
		return stoppedWorkflowResult("needs_input", "PRECHECK", lodgingPrecheck.missing, lodgingPrecheck.ambiguous);
	}
	const tickets = [...invoiceCheck.ready].sort(
		(left, right) =>
			left.date.localeCompare(right.date, "en") ||
			(left.departTime ?? "").localeCompare(right.departTime ?? "", "en") ||
			left.invoiceNumber.localeCompare(right.invoiceNumber, "en"),
	);
	progress("票据已唯一配对，正在匹配已有出差申请…", "APPLICATION");
	let driver: TravelDraftBrowserDriver;
	let discovery;
	try {
		driver = (dependencies.createDriver ?? ((options) => new TravelDraftBrowserDriver(options)))({
			cwd,
			signal,
			maxBrowserActions: 400,
			onBrowserAction: ({ index, kind, operation }) => {
				if (index === 1 || index % 10 === 0) progress(`页面操作 ${index}/400：${operation}（${kind}）`, "BROWSER");
			},
		});
		discovery = await driver.discoverApplication({
			url,
			hint: params.applicationHint,
			invoiceFacts: {
				travelDates: [...new Set(tickets.map((ticket) => ticket.date))],
				cities: [...new Set(tickets.flatMap((ticket) => [ticket.fromCity, ticket.toCity]))],
			},
		});
	} catch (error) {
		return stoppedWorkflowResult("blocked", "APPLICATION", [], [], [error instanceof Error ? error.message : String(error)]);
	}
	if (discovery.status !== "selected") {
		return stoppedWorkflowResult("needs_input", "APPLICATION", discovery.missing, discovery.ambiguous);
	}
	const days = inclusiveDateCount(discovery.application.startDate, discovery.application.endDate);
	const lodgingMissing: TravelDraftIssue[] = [];
	const lodgingAmbiguous: TravelDraftIssue[] = [];
	if (days > 1 && attachments.lodging.status !== "ready") {
		const target = attachments.lodging.status === "ambiguous" ? lodgingAmbiguous : lodgingMissing;
		target.push(
			workflowIssue(
				attachments.lodging.status === "ambiguous" ? "ambiguous_lodging" : "missing_lodging",
				"hotel",
				attachments.lodging.status === "ambiguous"
					? "多日出差的住宿发票存在多个候选或字段冲突"
					: "多日出差缺少可唯一识别的住宿发票 PDF",
			),
		);
		for (const item of attachments.lodging.issues) {
			target.push(workflowIssue(`lodging_${item.kind}`, "hotel", item.reason));
		}
	}
	if (days === 1 && attachments.lodging.status === "ready") {
		lodgingAmbiguous.push(
			workflowIssue("unexpected_lodging", "hotel", "关联申请为当天往返，但附件中识别到住宿发票，请核对行程或移除住宿附件"),
		);
	}
	if (lodgingMissing.length > 0 || lodgingAmbiguous.length > 0) {
		return stoppedWorkflowResult("needs_input", "PRECHECK", lodgingMissing, lodgingAmbiguous);
	}
	const transport = tickets.map((ticket) => ({
		fromCity: ticket.fromCity,
		toCity: ticket.toCity,
		fromStation: ticket.fromStation,
		toStation: ticket.toStation,
		trainNumber: ticket.trainNumber,
		travelDate: ticket.date,
		departTime: ticket.departTime,
		seatClass: ticket.seatClass,
		amount: ticket.amount,
		passenger: ticket.passenger,
		invoiceNumber: ticket.invoiceNumber,
		uploadFile: ticket.uploadFile,
		verificationFiles: [...ticket.verificationFiles],
	}));
	const lodging = attachments.lodging.invoice;
	const plan: TravelDraftPlan = {
		url,
		reimbursementDate: localIsoDate(),
		application: discovery.application,
		transport,
		hotel:
			days > 1 && lodging
				? {
						checkinDate: discovery.application.startDate,
						checkoutDate: discovery.application.endDate,
						amount: lodging.amount,
						invoiceNumber: lodging.invoiceNumber,
						uploadFile: lodging.uploadFile,
						verificationFiles: [...lodging.verificationFiles],
					}
				: undefined,
	};
	try {
		if (travelSaveIntentExists(cwd, plan)) {
			return stoppedWorkflowResult(
				"blocked",
				"CONFIRM",
				[],
				[],
				["检测到同一行程已经发起过草稿保存；请在易快报中人工确认草稿状态，不会再次点击保存"],
				true,
				true,
			);
		}
	} catch {
		return stoppedWorkflowResult(
			"blocked",
			"CONFIRM",
			[],
			[],
			["无法安全核对同一行程的保存意图记录；为防止重复保存已停止，请人工确认草稿状态"],
			true,
			true,
		);
	}
	progress(`已锁定申请 ${discovery.application.id}，正在按固定流程填写并逐项回读…`, "HEADER");
	let run: TravelDraftRunResult;
	let saveIntentPersisted = false;
	try {
		run = await runTravelDraft(driver, plan, {
			signal,
			maxActions: 60,
			maxStageRetries: 2,
			maxNoProgress: 2,
			onCheckpoint: (checkpoint) => {
				if (checkpoint.saveRequested && !saveIntentPersisted) {
					persistTravelSaveIntent(cwd, plan);
					saveIntentPersisted = true;
				}
				progress(`自动填报进行中：${checkpoint.stage}（${checkpoint.actionsUsed}/60）`, checkpoint.stage);
			},
		});
	} catch (error) {
		return stoppedWorkflowResult("blocked", "PRECHECK", [], [], [error instanceof Error ? error.message : String(error)]);
	}
	if (run.status !== "done" || run.stage !== "DONE") {
		const draftSaveRequested = run.checkpoint.saveRequested || run.observation?.draft?.saveRequested === true;
		return stoppedWorkflowResult(
			run.status === "done" ? "blocked" : run.status,
			run.stage,
			run.missing,
			run.ambiguous,
			run.errors,
			draftSaveRequested || ["SAVE_DRAFT", "CONFIRM", "DONE"].includes(run.stage),
			draftSaveRequested,
		);
	}
	return textResult(
		`草稿保存成功：已关联 ${discovery.application.title}（${discovery.application.id}），填写 ${tickets.length} 条火车/高铁、${days > 1 ? "1 条住宿、" : "无住宿、"}1 条其他省份补助，系统核验合计 ¥${run.expectedTotal.toFixed(2)}。未提交送审。`,
		{
			status: "done",
			stage: "DONE",
			draftSaved: true,
			submitted: false,
			actionsUsed: run.actionsUsed,
			expectedTotal: run.expectedTotal,
			application: discovery.application,
			transportCount: tickets.length,
			attachmentAssignments: tickets.map((ticket) => ({
				invoiceNumber: ticket.invoiceNumber,
				trainNumber: ticket.trainNumber,
				ticket: basename(ticket.uploadFile),
				verification: ticket.verificationFiles.map((file) => basename(file)),
			})),
			hotelCount: days > 1 ? 1 : 0,
			allowanceDays: days,
			allowanceAmount: days * 180,
		},
	);
}

export default function definePack(ctx: PackContext) {
	const workspaceRoot = () => ctx.getWorkspaceRoot();
	const tools: ToolDefinition[] = [
		{
			name: "travel_fill_draft",
			label: "自动填写差旅报销草稿",
			description:
				"一次调用完成易快报差旅草稿：先解析并唯一配对全部附件，再从已有出差申请中唯一匹配，按固定状态机填写表头、逐程火车/高铁、住宿（仅多日）和 180 元/天补助，逐项回读后只存草稿。缺项一次性返回；绝不提交、删除单据或猜测页面。普通流程只用本工具，不再自行调用 browser_*、shell、OCR 或旧的分步差旅工具。",
			promptSnippet: "使用单个确定性工具一次完成易快报差旅报销草稿，只保存草稿，绝不提交",
			promptGuidelines: [
				"收到报销链接和附件后只调用一次 travel_fill_draft；不要先调用 browser_*、travel_read_invoices、travel_plan_details、shell 或 OCR。",
				"如果工具返回 needs_input，把 missing/ambiguous 合并成一条消息向用户索要；不要绕过检查或猜测。",
				"只有 details.status=done、stage=DONE、draftSaved=true 才能告诉用户草稿保存成功；其他状态都明确说明未保存、未提交。",
			],
			parameters: Type.Object({
				url: Type.Optional(
					Type.String({ minLength: 1, description: "用户提供的易快报差旅费用报销链接；安全凭据引用必须原样传入" }),
				),
				paths: Type.Optional(
					Type.Array(Type.String({ minLength: 1 }), {
						maxItems: MAX_TRAVEL_INPUT_FILES,
						description: "本次行程全部附件路径：每程铁路电子票及对应查验 PDF/PNG/JPG；多日再含住宿发票 PDF",
					}),
				),
				applicationHint: Type.Optional(Type.String({ description: "可选的已有出差申请标题、城市或申请编号线索，如 常州" })),
			}),
			execute: async (_id, rawParams, signal, onUpdate) => {
				const params = rawParams as FillTravelDraftParams;
				return fillTravelDraft(params, workspaceRoot(), signal, onUpdate);
			},
		},
		{
			name: "travel_reimbursement_guide",
			label: "差旅报销规则速查",
			description: "返回当前公司差旅费用报销单（易快报/合思）的字段填写规则、固定取值和安全红线。",
			parameters: Type.Object({}),
			execute: async () => textResult(reimbursementGuideText()),
		},
		{
			name: "travel_read_invoices",
			label: "解析差旅票据",
			description:
				"一次解析差旅票据：支持直接传铁路电子客票 PDF、OFD、含 OFD/PDF 的 ZIP、扫描版查验 PDF 和住宿发票 PDF。提取铁路字段并保守配对查验附件；住宿票据仅在 OCR 明确含住宿类目且发票号、价税合计各自唯一时返回候选。绝不按文件名、顺序或单独金额猜测。用户发来全部附件后集中调用一次，不要手工解压或 OCR。",
			parameters: Type.Object({
				paths: Type.Array(Type.String(), {
					minItems: 1,
					maxItems: MAX_TRAVEL_INPUT_FILES,
					description: "本次行程的全部票据路径（工作区相对或绝对路径），支持 .pdf / .ofd / .zip",
				}),
			}),
			execute: async (_id, rawParams) => {
				const params = rawParams as { paths: string[] };
				const result = readAndPairRailwayAttachments(params.paths, workspaceRoot());
				const lines = result.invoices.map((invoice) => {
					if (invoice.error) return `✗ ${invoice.source}：${invoice.error}`;
					return [
						`✓ ${invoice.invoiceNumber ?? "（发票号未识别）"}：`,
						`  ${invoice.trainNumber} ${invoice.fromStation} ${invoice.departTime}开 → ${invoice.toStation}`,
						`  计划城市：${invoice.fromCity ?? "未识别"} → ${invoice.toCity ?? "未识别"}（原始站名保留如上）`,
						`  ${invoice.date} ${invoice.seatClass} ¥${invoice.amount} 乘车人：${invoice.passenger ?? "未识别"}`,
						`  开票日期 ${invoice.issueDate ?? "未识别"}；上传附件用：${invoice.uploadFile}`,
						invoice.verificationFiles?.length
							? `  查验附件（已唯一配对）：${invoice.verificationFiles.join("、")}`
							: "  查验附件：MISSING（尚未唯一配对）",
					].join("\n");
				});
				const summary = [`附件配对状态：${result.pairingStatus.toUpperCase()}`];
				if (result.invoices.every((invoice) => invoice.error)) {
					summary.push("MISSING：没有解析出可用的铁路电子客票 PDF/OFD。");
				}
				for (const item of result.missing) {
					summary.push(`MISSING：发票 ${item.invoiceNumber ?? item.source} 缺少能唯一匹配的查验 PDF。`);
				}
				for (const item of result.ambiguous) {
					summary.push(
						`AMBIGUOUS：查验 PDF ${item.file} 同时匹配 ${item.candidateInvoiceNumbers.join("、")}（依据 ${item.signals.join("+")}），已停止自动配对。`,
					);
				}
				for (const item of result.unmatched) summary.push(`UNMATCHED：查验 PDF ${item.file}：${item.reason}。`);
				if (result.lodging.status === "ready" && result.lodging.invoice) {
					summary.push(
						`LODGING READY：住宿发票 ${result.lodging.invoice.invoiceNumber}，价税合计 ¥${result.lodging.invoice.amount}；上传附件用：${result.lodging.invoice.uploadFile}；查验附件可为空数组。`,
					);
				} else if (result.lodging.status === "ambiguous") {
					summary.push("LODGING AMBIGUOUS：识别到多份住宿候选或住宿票据字段冲突；多日行程必须一次性核对，不能猜测。");
				} else {
					summary.push("LODGING MISSING：未唯一识别住宿发票；当天往返可忽略，多日行程必须补齐。");
				}
				if (result.pairingStatus !== "ready") {
					summary.push("请一次补齐或替换上面列出的附件后重新调用；不要猜测，也不要开始填写费用明细。");
				}
				const details = {
					...result,
					ocrDocuments: result.ocrDocuments.map(({ text, ...document }) => ({
						...document,
						textLength: text.length,
					})),
				};
				return textResult([...lines, "", ...summary].join("\n\n"), details);
			},
		},
		{
			name: "travel_plan_details",
			label: "生成费用明细计划",
			description:
				"根据出差申请与票据信息，确定性地绑定每程电子客票和查验附件并生成费用明细行（城市交通费/住宿费/出差补助）：当天往返不生成住宿费；补助按 180 元/天由系统自动核算。",
			parameters: Type.Object({
				tripTitle: Type.Optional(Type.String({ description: "关联的出差申请标题，如“出差申请：常州业务拓展”" })),
				startDate: Type.String({ description: "出差开始日期 YYYY-MM-DD（与申请一致）" }),
				endDate: Type.String({ description: "出差结束日期 YYYY-MM-DD（与申请一致）" }),
				legs: Type.Array(
					Type.Object({
						from: Type.String({ description: "出发城市，如 南京" }),
						to: Type.String({ description: "到达城市，如 常州" }),
						date: Type.String({ description: "乘车日期 YYYY-MM-DD" }),
						seatClass: Type.String({ description: "火车席别，与车票一致，如 二等座" }),
						amount: Type.Number({ description: "票价（元），与车票一致" }),
						passenger: Type.Literal(EXPECTED_PASSENGER, { description: "乘车人，与票据一致且必须为当前用户苏爱健" }),
						invoiceNumber: Type.String({ description: "发票号码，用于阻止重复票据" }),
						uploadFile: Type.String({ minLength: 1, description: "该程电子客票的持久化 PDF/OFD 路径，由 travel_read_invoices 返回" }),
						verificationFiles: Type.Array(Type.String({ minLength: 1, description: "该程对应的一份查验附件路径" }), {
							minItems: 1,
							description: "只属于该程的火车票查验图片/PDF，至少一份",
						}),
					}),
					{ minItems: 1, description: "城市间火车/高铁行程，逐程一条（往返各一条）" },
				),
				hotel: Type.Optional(
					Type.Object({
						amount: Type.Number({ description: "住宿费金额（元），与住宿发票一致" }),
						checkin: Type.Optional(Type.String({ description: "入住日期 YYYY-MM-DD" })),
						checkout: Type.Optional(Type.String({ description: "离店日期 YYYY-MM-DD" })),
						uploadFile: Type.String({ minLength: 1, description: "住宿发票文件路径" }),
						verificationFiles: Type.Array(Type.String({ minLength: 1, description: "住宿发票查验附件路径" }), {
							description: "住宿发票对应的查验附件；没有查验件时传空数组",
						}),
					}),
				),
			}),
			execute: async (_id, rawParams) => {
				const params = rawParams as PlanParams;
				const plan = buildDetailPlan(params, workspaceRoot());
				const lines = [
					`出差日期：${params.startDate} 至 ${params.endDate}（${planDays(params.startDate, params.endDate)} 天）`,
					"",
					"费用明细（按顺序逐条添加）：",
					...plan.rows.map((row, index) => `${index + 1}. ${row.summary}\n   ${JSON.stringify(row)}`),
					"",
					...plan.notes,
				];
				return textResult(lines.join("\n"), { rows: plan.rows, notes: plan.notes });
			},
		},
	];
	return { tools };
}
