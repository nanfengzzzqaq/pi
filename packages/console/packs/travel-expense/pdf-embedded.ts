import { inflateSync } from "node:zlib";

const DEFAULT_MAX_PDF_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_EMBEDDED_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_EMBEDDED_FILES = 8;
const DEFAULT_MAX_TOTAL_EMBEDDED_BYTES = 8 * 1024 * 1024;
const MAX_PDF_OBJECTS = 20_000;
const MAX_NAME_TREE_NODES = 256;
const MAX_NAME_TREE_DEPTH = 16;
const MAX_NAME_TREE_ENTRIES = 64;

interface PdfObject {
	key: string;
	raw: Buffer;
	dictionary: string;
}

type PdfValueKind = "dictionary" | "array" | "literal" | "hex" | "name" | "reference" | "token";

interface PdfValue {
	raw: string;
	kind: PdfValueKind;
	end: number;
	reference?: string;
}

export interface EmbeddedRailwayXml {
	name: string;
	xml: string;
	objectRef: string;
}

export interface VerificationFingerprint {
	invoiceNumbers: string[];
	trainNumbers: string[];
	amounts: number[];
	/** Positive visible proof that this is a verification result, not another copy of the invoice. */
	verificationEvidence?: string[];
}

export interface MatchableRailwayInvoice {
	invoiceNumber?: string;
	trainNumber?: string;
	amount?: number;
}

export interface VerificationCandidate {
	file: string;
	fingerprint: VerificationFingerprint;
	error?: string;
}

export interface TravelOcrDocument extends VerificationCandidate {
	/** Bounded OCR text retained for deterministic high-level classification. */
	text: string;
}

export interface LodgingInvoiceCandidate {
	invoiceNumber: string;
	amount: number;
	uploadFile: string;
	verificationFiles: string[];
	checkinDate?: string;
	checkoutDate?: string;
}

export interface LodgingOcrIssue {
	file: string;
	kind: "missing" | "ambiguous";
	reason: string;
	invoiceNumbers: string[];
	amounts: number[];
}

export interface LodgingInvoiceResolution {
	status: "ready" | "missing" | "ambiguous";
	invoice?: LodgingInvoiceCandidate;
	candidates: LodgingInvoiceCandidate[];
	issues: LodgingOcrIssue[];
	/** OCR documents classified as lodging-related and therefore not railway verification files. */
	classifiedFiles: string[];
}

export interface VerificationPairing {
	verificationFilesByInvoice: string[][];
	missingInvoiceIndexes: number[];
	ambiguous: Array<{
		file: string;
		candidateInvoiceIndexes: number[];
		signals: string[];
	}>;
	unmatched: Array<{
		file: string;
		reason: string;
		fingerprint: VerificationFingerprint;
	}>;
}

function unique<T>(values: T[]): T[] {
	return [...new Set(values)];
}

function parsePdfObjects(pdf: Buffer): Map<string, PdfObject> {
	const source = pdf.toString("latin1");
	const header = /(?:^|[\r\n])(\d+)\s+(\d+)\s+obj\b/g;
	const matches = [...source.matchAll(header)];
	if (matches.length > MAX_PDF_OBJECTS) throw new Error(`PDF 对象数超过安全上限 ${MAX_PDF_OBJECTS}`);
	const objects = new Map<string, PdfObject>();
	for (const [index, match] of matches.entries()) {
		const bodyStart = (match.index ?? 0) + match[0].length;
		const nextOffset = index + 1 < matches.length ? (matches[index + 1].index ?? source.length) : source.length;
		const endObject = source.indexOf("endobj", bodyStart);
		const bodyEnd = endObject >= 0 && endObject < nextOffset ? endObject : nextOffset;
		const raw = pdf.subarray(bodyStart, bodyEnd);
		const streamOffset = raw.indexOf(Buffer.from("stream", "ascii"));
		const dictionaryBytes = streamOffset >= 0 ? raw.subarray(0, streamOffset) : raw;
		objects.set(`${match[1]} ${match[2]}`, {
			key: `${match[1]} ${match[2]}`,
			raw,
			dictionary: dictionaryBytes.toString("latin1"),
		});
	}
	return objects;
}

function skipPdfTrivia(source: string, start: number): number {
	let cursor = start;
	while (cursor < source.length) {
		if (/^[\x00\x09\x0a\x0c\x0d\x20]$/.test(source[cursor])) {
			cursor++;
			continue;
		}
		if (source[cursor] === "%") {
			while (cursor < source.length && source[cursor] !== "\r" && source[cursor] !== "\n") cursor++;
			continue;
		}
		break;
	}
	return cursor;
}

function literalStringEnd(source: string, start: number): number {
	let depth = 1;
	let cursor = start + 1;
	while (cursor < source.length && depth > 0) {
		const value = source[cursor++];
		if (value === "\\") {
			if (source[cursor] === "\r" && source[cursor + 1] === "\n") cursor += 2;
			else if (cursor < source.length) cursor++;
			continue;
		}
		if (value === "(") depth++;
		else if (value === ")") depth--;
	}
	if (depth !== 0) throw new Error("PDF 字符串未闭合");
	return cursor;
}

function compositeEnd(source: string, start: number): number {
	const dictionary = source.startsWith("<<", start);
	if (!dictionary && source[start] !== "[") throw new Error("PDF 复合值起始符无效");
	const stack: Array<">>" | "]"> = [dictionary ? ">>" : "]"];
	let cursor = start + (dictionary ? 2 : 1);
	while (cursor < source.length && stack.length > 0) {
		if (source[cursor] === "%") {
			cursor = skipPdfTrivia(source, cursor);
			continue;
		}
		if (source[cursor] === "(") {
			cursor = literalStringEnd(source, cursor);
			continue;
		}
		if (source.startsWith("<<", cursor)) {
			stack.push(">>");
			cursor += 2;
			continue;
		}
		if (source[cursor] === "<") {
			const end = source.indexOf(">", cursor + 1);
			if (end < 0) throw new Error("PDF 十六进制字符串未闭合");
			cursor = end + 1;
			continue;
		}
		if (source[cursor] === "[") {
			stack.push("]");
			cursor++;
			continue;
		}
		const expected = stack.at(-1);
		if (expected === ">>" && source.startsWith(">>", cursor)) {
			stack.pop();
			cursor += 2;
			continue;
		}
		if (expected === "]" && source[cursor] === "]") {
			stack.pop();
			cursor++;
			continue;
		}
		cursor++;
	}
	if (stack.length > 0) throw new Error("PDF 复合值未闭合");
	return cursor;
}

function readPdfValue(source: string, start: number): PdfValue {
	const cursor = skipPdfTrivia(source, start);
	if (cursor >= source.length) throw new Error("PDF 键缺少值");
	if (source.startsWith("<<", cursor)) {
		const end = compositeEnd(source, cursor);
		return { raw: source.slice(cursor, end), kind: "dictionary", end };
	}
	if (source[cursor] === "[") {
		const end = compositeEnd(source, cursor);
		return { raw: source.slice(cursor, end), kind: "array", end };
	}
	if (source[cursor] === "(") {
		const end = literalStringEnd(source, cursor);
		return { raw: source.slice(cursor, end), kind: "literal", end };
	}
	if (source[cursor] === "<") {
		const end = source.indexOf(">", cursor + 1);
		if (end < 0) throw new Error("PDF 十六进制字符串未闭合");
		return { raw: source.slice(cursor, end + 1), kind: "hex", end: end + 1 };
	}
	if (source[cursor] === "/") {
		let end = cursor + 1;
		while (end < source.length && !/[\x00\x09\x0a\x0c\x0d\x20()[\]<>\/{%}]/.test(source[end])) end++;
		return { raw: source.slice(cursor, end), kind: "name", end };
	}
	const reference = /^(\d+)\s+(\d+)\s+R\b/.exec(source.slice(cursor));
	if (reference) {
		return {
			raw: reference[0],
			kind: "reference",
			end: cursor + reference[0].length,
			reference: `${reference[1]} ${reference[2]}`,
		};
	}
	let end = cursor;
	while (end < source.length && !/[\x00\x09\x0a\x0c\x0d\x20()[\]<>\/{%}]/.test(source[end])) end++;
	if (end === cursor) throw new Error("PDF 值无法解析");
	return { raw: source.slice(cursor, end), kind: "token", end };
}

function decodePdfName(value: string): string {
	return value
		.replace(/^\//, "")
		.replace(/#([0-9a-f]{2})/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function topLevelDictionaryValue(dictionary: string, key: string): PdfValue | undefined {
	const start = skipPdfTrivia(dictionary, 0);
	if (!dictionary.startsWith("<<", start)) return undefined;
	let cursor = start + 2;
	while (cursor < dictionary.length) {
		cursor = skipPdfTrivia(dictionary, cursor);
		if (dictionary.startsWith(">>", cursor)) return undefined;
		if (dictionary[cursor] !== "/") throw new Error("PDF 字典键无法解析");
		const name = readPdfValue(dictionary, cursor);
		if (name.kind !== "name") throw new Error("PDF 字典键类型无效");
		const value = readPdfValue(dictionary, name.end);
		if (decodePdfName(name.raw) === key) return value;
		cursor = value.end;
	}
	throw new Error("PDF 字典未闭合");
}

function arrayValues(array: PdfValue): PdfValue[] {
	if (array.kind !== "array") throw new Error("PDF 名称树值不是数组");
	const values: PdfValue[] = [];
	let cursor = 1;
	while (cursor < array.raw.length) {
		cursor = skipPdfTrivia(array.raw, cursor);
		if (array.raw[cursor] === "]") return values;
		const value = readPdfValue(array.raw, cursor);
		values.push(value);
		cursor = value.end;
	}
	throw new Error("PDF 名称树数组未闭合");
}

function resolveDictionary(
	value: PdfValue,
	objects: Map<string, PdfObject>,
	context: string,
): { dictionary: string; reference?: string } {
	if (value.kind === "dictionary") return { dictionary: value.raw };
	if (value.kind !== "reference" || !value.reference) throw new Error(`${context} 必须是字典或间接引用`);
	const object = objects.get(value.reference);
	if (!object || !object.dictionary.trimStart().startsWith("<<")) {
		throw new Error(`${context} 引用了不存在或非字典对象 ${value.reference}`);
	}
	return { dictionary: object.dictionary, reference: value.reference };
}

function uniqueCatalog(objects: Map<string, PdfObject>): PdfObject {
	const catalogs = [...objects.values()].filter((object) => {
		if (!/\/Type\b/.test(object.dictionary)) return false;
		const type = topLevelDictionaryValue(object.dictionary, "Type");
		return type?.kind === "name" && decodePdfName(type.raw) === "Catalog";
	});
	if (catalogs.length !== 1) throw new Error(`PDF 必须有唯一 Catalog，当前为 ${catalogs.length} 个`);
	return catalogs[0];
}

function reachableFilespecReferences(objects: Map<string, PdfObject>): string[] {
	const catalog = uniqueCatalog(objects);
	const namesValue = topLevelDictionaryValue(catalog.dictionary, "Names");
	if (!namesValue) return [];
	const names = resolveDictionary(namesValue, objects, "Catalog /Names");
	const embeddedFilesValue = topLevelDictionaryValue(names.dictionary, "EmbeddedFiles");
	if (!embeddedFilesValue) return [];

	const root = resolveDictionary(embeddedFilesValue, objects, "Catalog /Names /EmbeddedFiles");
	const queue: Array<{ dictionary: string; reference?: string; depth: number }> = [{ ...root, depth: 0 }];
	const visited = new Set<string>();
	const filespecs: string[] = [];
	let nodes = 0;
	let entries = 0;
	while (queue.length > 0) {
		const node = queue.shift()!;
		if (node.depth > MAX_NAME_TREE_DEPTH) throw new Error(`PDF EmbeddedFiles 名称树深度超过 ${MAX_NAME_TREE_DEPTH}`);
		if (node.reference) {
			if (visited.has(node.reference)) throw new Error(`PDF EmbeddedFiles 名称树存在循环引用 ${node.reference}`);
			visited.add(node.reference);
		}
		nodes++;
		if (nodes > MAX_NAME_TREE_NODES) throw new Error(`PDF EmbeddedFiles 名称树节点超过 ${MAX_NAME_TREE_NODES}`);
		const namesArray = topLevelDictionaryValue(node.dictionary, "Names");
		const kidsArray = topLevelDictionaryValue(node.dictionary, "Kids");
		if (namesArray && kidsArray) throw new Error("PDF EmbeddedFiles 名称树节点不能同时包含 Names 和 Kids");
		if (!namesArray && !kidsArray) throw new Error("PDF EmbeddedFiles 名称树节点缺少 Names 或 Kids");
		if (namesArray) {
			const values = arrayValues(namesArray);
			if (values.length % 2 !== 0) throw new Error("PDF EmbeddedFiles Names 必须为名称与 Filespec 成对数组");
			for (let index = 0; index < values.length; index += 2) {
				const name = values[index];
				const filespec = values[index + 1];
				if (!["literal", "hex"].includes(name.kind) || filespec.kind !== "reference" || !filespec.reference) {
					throw new Error("PDF EmbeddedFiles Names 条目必须是字符串到 Filespec 引用");
				}
				entries++;
				if (entries > MAX_NAME_TREE_ENTRIES) {
					throw new Error(`PDF EmbeddedFiles 名称树条目超过 ${MAX_NAME_TREE_ENTRIES}`);
				}
				filespecs.push(filespec.reference);
			}
		}
		if (kidsArray) {
			for (const child of arrayValues(kidsArray)) {
				if (child.kind !== "reference" || !child.reference) {
					throw new Error("PDF EmbeddedFiles Kids 只能包含间接引用");
				}
				const resolved = resolveDictionary(child, objects, "PDF EmbeddedFiles Kids");
				queue.push({ ...resolved, depth: node.depth + 1 });
			}
		}
	}
	if (new Set(filespecs).size !== filespecs.length) throw new Error("PDF EmbeddedFiles 名称树重复引用同一 Filespec");
	return filespecs;
}

function pdfStringBytes(dictionary: string, key: "F" | "UF"): Buffer | undefined {
	const marker = new RegExp(`/${key}\\b`, "g");
	let match: RegExpExecArray | null;
	while ((match = marker.exec(dictionary))) {
		let cursor = (match.index ?? 0) + match[0].length;
		while (/\s/.test(dictionary[cursor] ?? "")) cursor++;
		if (dictionary[cursor] === "(") {
			cursor++;
			let depth = 1;
			const bytes: number[] = [];
			while (cursor < dictionary.length && depth > 0) {
				const value = dictionary[cursor++];
				if (value === "\\") {
					const escaped = dictionary[cursor++] ?? "";
					if (/[0-7]/.test(escaped)) {
						let octal = escaped;
						while (octal.length < 3 && /[0-7]/.test(dictionary[cursor] ?? "")) octal += dictionary[cursor++];
						bytes.push(Number.parseInt(octal, 8));
					} else if (escaped === "n") bytes.push(0x0a);
					else if (escaped === "r") bytes.push(0x0d);
					else if (escaped === "t") bytes.push(0x09);
					else if (escaped === "b") bytes.push(0x08);
					else if (escaped === "f") bytes.push(0x0c);
					else if (escaped === "\r" && dictionary[cursor] === "\n") cursor++;
					else if (escaped !== "\r" && escaped !== "\n") bytes.push(escaped.charCodeAt(0));
					continue;
				}
				if (value === "(") {
					depth++;
					bytes.push(value.charCodeAt(0));
					continue;
				}
				if (value === ")") {
					depth--;
					if (depth > 0) bytes.push(value.charCodeAt(0));
					continue;
				}
				bytes.push(value.charCodeAt(0) & 0xff);
			}
			return Buffer.from(bytes);
		}
		if (dictionary[cursor] === "<" && dictionary[cursor + 1] !== "<") {
			const end = dictionary.indexOf(">", cursor + 1);
			if (end < 0) continue;
			let hex = dictionary.slice(cursor + 1, end).replace(/\s+/g, "");
			if (hex.length % 2) hex += "0";
			if (/^[0-9a-f]+$/i.test(hex)) return Buffer.from(hex, "hex");
		}
	}
	return undefined;
}

function decodePdfString(bytes: Buffer | undefined): string | undefined {
	if (!bytes || bytes.length === 0) return undefined;
	if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
		const swapped = Buffer.allocUnsafe(bytes.length - 2);
		for (let index = 2; index + 1 < bytes.length; index += 2) {
			swapped[index - 2] = bytes[index + 1];
			swapped[index - 1] = bytes[index];
		}
		return swapped.toString("utf16le");
	}
	if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
	return bytes.toString("utf8");
}

function embeddedFileReference(dictionary: string): string | undefined {
	const efValue = topLevelDictionaryValue(dictionary, "EF");
	if (!efValue || efValue.kind !== "dictionary") return undefined;
	const references = ["UF", "F"]
		.map((key) => topLevelDictionaryValue(efValue.raw, key))
		.filter((value): value is PdfValue => Boolean(value))
		.map((value) => (value.kind === "reference" ? value.reference : undefined));
	if (references.some((reference) => !reference)) throw new Error("Filespec /EF 只能包含 EmbeddedFile 间接引用");
	const uniqueReferences = unique(references as string[]);
	if (uniqueReferences.length !== 1) throw new Error("Filespec /EF 的 F 与 UF 引用了不同对象");
	return uniqueReferences[0];
}

function streamBytes(object: PdfObject, objects: Map<string, PdfObject>, maxEmbeddedBytes: number): Buffer {
	const marker = object.raw.indexOf(Buffer.from("stream", "ascii"));
	if (marker < 0) throw new Error("EmbeddedFile 对象没有 stream");
	let start = marker + "stream".length;
	if (object.raw[start] === 0x0d && object.raw[start + 1] === 0x0a) start += 2;
	else if (object.raw[start] === 0x0a || object.raw[start] === 0x0d) start++;
	const directLength = /\/Length\s+(\d+)\b(?!\s+\d+\s+R)/i.exec(object.dictionary);
	const indirectLength = /\/Length\s+(\d+)\s+(\d+)\s+R\b/i.exec(object.dictionary);
	let length = directLength ? Number(directLength[1]) : undefined;
	if (length === undefined && indirectLength) {
		const lengthObject = objects.get(`${indirectLength[1]} ${indirectLength[2]}`);
		const value = lengthObject?.raw.toString("ascii").match(/^\s*(\d+)/)?.[1];
		if (value) length = Number(value);
	}
	let encoded: Buffer;
	if (length !== undefined && Number.isSafeInteger(length) && length >= 0 && start + length <= object.raw.length) {
		encoded = object.raw.subarray(start, start + length);
	} else {
		const end = object.raw.lastIndexOf(Buffer.from("endstream", "ascii"));
		if (end < start) throw new Error("EmbeddedFile stream 长度无效");
		encoded = object.raw.subarray(start, end);
		while (encoded.length > 0 && (encoded.at(-1) === 0x0a || encoded.at(-1) === 0x0d)) encoded = encoded.subarray(0, -1);
	}
	if (encoded.length > maxEmbeddedBytes) throw new Error(`EmbeddedFile 压缩数据超过 ${maxEmbeddedBytes} 字节`);
	const filterValue = /\/Filter\s*(\[[^\]]*\]|\/[\w]+)/i.exec(object.dictionary)?.[1] ?? "";
	const filters = [...filterValue.matchAll(/\/([\w]+)/g)].map((item) => item[1]);
	if (filters.length > 1 || (filters.length === 1 && filters[0] !== "FlateDecode")) {
		throw new Error(`EmbeddedFile 使用不支持的过滤器：${filters.join(", ")}`);
	}
	const decoded = filters[0] === "FlateDecode" ? inflateSync(encoded, { maxOutputLength: maxEmbeddedBytes }) : encoded;
	if (decoded.length > maxEmbeddedBytes) throw new Error(`EmbeddedFile 解压后超过 ${maxEmbeddedBytes} 字节`);
	return decoded;
}

function decodeXmlBuffer(value: Buffer): string {
	if (value.length >= 2 && value[0] === 0xff && value[1] === 0xfe) return value.subarray(2).toString("utf16le");
	if (value.length >= 2 && value[0] === 0xfe && value[1] === 0xff) {
		const swapped = Buffer.allocUnsafe(value.length - 2);
		for (let index = 2; index + 1 < value.length; index += 2) {
			swapped[index - 2] = value[index + 1];
			swapped[index - 1] = value[index];
		}
		return swapped.toString("utf16le");
	}
	return value.toString("utf8");
}

/**
 * Read only railway XBRL files embedded in a PDF's EmbeddedFiles name tree.
 * No page rendering or OCR is needed for ordinary railway e-ticket PDFs.
 */
export function extractRailwayEmbeddedXml(
	pdf: Buffer,
	options: {
		maxPdfBytes?: number;
		maxEmbeddedBytes?: number;
		maxEmbeddedFiles?: number;
		maxTotalEmbeddedBytes?: number;
	} = {},
): EmbeddedRailwayXml[] {
	const maxPdfBytes = options.maxPdfBytes ?? DEFAULT_MAX_PDF_BYTES;
	const maxEmbeddedBytes = options.maxEmbeddedBytes ?? DEFAULT_MAX_EMBEDDED_BYTES;
	const maxEmbeddedFiles = options.maxEmbeddedFiles ?? DEFAULT_MAX_EMBEDDED_FILES;
	const maxTotalEmbeddedBytes = options.maxTotalEmbeddedBytes ?? DEFAULT_MAX_TOTAL_EMBEDDED_BYTES;
	if (pdf.length > maxPdfBytes) throw new Error(`PDF 超过安全上限 ${maxPdfBytes} 字节`);
	const objects = parsePdfObjects(pdf);
	if (![...objects.values()].some((object) => /\/EmbeddedFiles\b/.test(object.dictionary))) return [];
	const filespecReferences = reachableFilespecReferences(objects);
	const output: EmbeddedRailwayXml[] = [];
	let totalEmbeddedBytes = 0;
	for (const filespecReference of filespecReferences) {
		const object = objects.get(filespecReference);
		if (!object) throw new Error(`EmbeddedFiles 名称树引用了不存在的 Filespec ${filespecReference}`);
		const filespecType = topLevelDictionaryValue(object.dictionary, "Type");
		if (filespecType?.kind !== "name" || decodePdfName(filespecType.raw) !== "Filespec") {
			throw new Error(`EmbeddedFiles 名称树对象 ${filespecReference} 不是 /Type /Filespec`);
		}
		const name = decodePdfString(pdfStringBytes(object.dictionary, "UF")) ?? decodePdfString(pdfStringBytes(object.dictionary, "F"));
		if (!name || !/(?:^|[\\/])rai_issuer_[^\\/]+\.xml$/i.test(name)) continue;
		const reference = embeddedFileReference(object.dictionary);
		if (!reference) throw new Error(`嵌入文件 ${name} 缺少 EmbeddedFile 引用`);
		const embedded = objects.get(reference);
		if (!embedded) throw new Error(`嵌入文件 ${name} 引用了不存在的对象 ${reference}`);
		const embeddedType = topLevelDictionaryValue(embedded.dictionary, "Type");
		if (embeddedType?.kind !== "name" || decodePdfName(embeddedType.raw) !== "EmbeddedFile") {
			throw new Error(`嵌入文件 ${name} 引用的对象 ${reference} 不是 /Type /EmbeddedFile`);
		}
		if (output.length >= maxEmbeddedFiles) throw new Error(`铁路 EmbeddedFile 超过 ${maxEmbeddedFiles} 个安全上限`);
		const bytes = streamBytes(embedded, objects, maxEmbeddedBytes);
		totalEmbeddedBytes += bytes.length;
		if (totalEmbeddedBytes > maxTotalEmbeddedBytes) {
			throw new Error(`铁路 EmbeddedFile 累计解压后超过 ${maxTotalEmbeddedBytes} 字节安全上限`);
		}
		const xml = decodeXmlBuffer(bytes).replace(/^\uFEFF/, "");
		if (!/^\s*<\?xml\b|^\s*<[\w.-]+:/i.test(xml)) throw new Error(`嵌入文件 ${name} 不是可识别的 XML`);
		output.push({ name, xml, objectRef: reference });
	}
	return output;
}

function normalizedDigits(value: string): string {
	return value.replace(/[^\d]/g, "");
}

function collectLabelledNumbers(text: string, label: RegExp): string[] {
	const output: string[] = [];
	for (const match of text.matchAll(new RegExp(`${label.source}[\\s：:]*(?<number>(?:\\d[\\s-]*){8,26})`, "giu"))) {
		const value = normalizedDigits(match.groups?.number ?? "");
		if (value.length >= 8 && value.length <= 26) output.push(value);
	}
	return output;
}

function compactOcrText(text: string): string {
	return text
		.replace(/[，,]/g, "")
		.replace(/\u00a5/g, "¥")
		.replace(/([\p{Script=Han}])[\t \u3000]+(?=[\p{Script=Han}])/gu, "$1")
		.replace(/(\d)[\t \u3000]+(?=\d)/g, "$1");
}

function collectVerificationEvidence(text: string): string[] {
	const evidence: string[] = [];
	const patterns: Array<[string, RegExp]> = [
		["nationalTaxAuthority", /国家税务总局[\s\S]{0,40}(?:发票)?查验/u],
		["vatVerificationPlatform", /全国增值税发票查验平台/u],
		["invoiceVerificationPlatform", /发票查验平台/u],
		["verificationResult", /(?:发票)?查验结果/u],
		["verificationTime", /查验时间/u],
		["verificationCount", /查验次数/u],
		["currentVerification", /本次查验/u],
		["railwayTicketVerification", /铁路电子客票查验/u],
	];
	for (const [name, pattern] of patterns) if (pattern.test(text)) evidence.push(name);
	return evidence;
}

/** Extract only the identifiers needed to pair a verification PDF with a ticket. */
export function parseVerificationFingerprint(text: string): VerificationFingerprint {
	const compact = compactOcrText(text);
	const invoiceNumbers = [
		...collectLabelledNumbers(compact, /(?:发票(?:号码|号)|电子票号|票据号码)/u),
		...[...compact.matchAll(/(?<!\d)(\d{20})(?!\d)/g)].map((match) => match[1]),
	];
	const trainNumbers = [...compact.matchAll(/(?<![A-Z0-9])([GDC]\s*\d{1,5})(?!\d)/gi)].map((match) =>
		match[1].replace(/\s+/g, "").toUpperCase(),
	);
	const amountPatterns = [
		/(?:价税合计|票价|发票金额|开具金额|合计金额|金额)[\s：:]*[¥￥]?\s*(\d+(?:\.\d{1,2})?)/gi,
		/[¥￥]\s*(\d+(?:\.\d{1,2})?)/g,
	];
	const amounts = amountPatterns.flatMap((pattern) =>
		[...compact.matchAll(pattern)].map((match) => Number(match[1])).filter((value) => Number.isFinite(value) && value > 0),
	);
	return {
		invoiceNumbers: unique(invoiceNumbers),
		trainNumbers: unique(trainNumbers),
		amounts: unique(amounts.map((value) => Math.round(value * 100) / 100)),
		verificationEvidence: collectVerificationEvidence(compact),
	};
}

interface ParsedLodgingOcr {
	kind: "none" | "invoice" | "related" | "missing" | "ambiguous";
	invoiceNumbers: string[];
	amounts: number[];
	candidate?: LodgingInvoiceCandidate;
	issue?: LodgingOcrIssue;
}

interface LodgingDateResolution {
	checkinDate?: string;
	checkoutDate?: string;
	ambiguous: boolean;
}

const LODGING_DATE_TOKEN_SOURCE = String.raw`\d{4}(?:-\d{1,2}-\d{1,2}|\/\d{1,2}\/\d{1,2}|年\d{1,2}月\d{1,2}日)`;
const LODGING_DATE_LABEL_GAP = String.raw`[\s：:（）()【】]{0,16}`;

function normalizeLodgingDate(value: string): string | undefined {
	const match = /^(\d{4})(?:-(\d{1,2})-(\d{1,2})|\/(\d{1,2})\/(\d{1,2})|年(\d{1,2})月(\d{1,2})日)$/u.exec(
		value.replace(/\s+/g, ""),
	);
	if (!match) return undefined;
	const year = Number(match[1]);
	const month = Number(match[2] ?? match[4] ?? match[6]);
	const day = Number(match[3] ?? match[5] ?? match[7]);
	const date = new Date(Date.UTC(year, month - 1, day));
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
		return undefined;
	}
	return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function collectLodgingLabelledDates(text: string, labelSource: string): string[] {
	const pattern = new RegExp(`${labelSource}${LODGING_DATE_LABEL_GAP}(${LODGING_DATE_TOKEN_SOURCE})`, "gu");
	return unique(
		[...text.matchAll(pattern)]
			.map((match) => normalizeLodgingDate(match[1]))
			.filter((value): value is string => Boolean(value)),
	);
}

/**
 * Extract dates only when the OCR places them directly beside lodging-specific
 * labels. Invoice dates, verification dates, and other unlabelled dates are
 * deliberately ignored. Multiple distinct endpoints or a reversed range are
 * treated as conflicting evidence instead of being guessed.
 */
function resolveLodgingDates(text: string): LodgingDateResolution {
	const checkinDates = collectLodgingLabelledDates(
		text,
		String.raw`(?:入住(?:日期|时间)?|住宿(?:开始|起始|起)日期)`,
	);
	const checkoutDates = collectLodgingLabelledDates(
		text,
		String.raw`(?:离店(?:日期|时间)?|退房(?:日期|时间)?|住宿(?:结束|截止|止)日期)`,
	);
	const rangePattern = new RegExp(
		String.raw`(?:住宿(?:起止日期|日期范围|期间|日期|时间)|入住(?:日期|时间)?(?:至|到|\/|—|–|-)离店(?:日期|时间)?)${LODGING_DATE_LABEL_GAP}(${LODGING_DATE_TOKEN_SOURCE})[\s~～至到—–－-]{1,16}(${LODGING_DATE_TOKEN_SOURCE})`,
		"gu",
	);
	let invalidRange = false;
	for (const match of text.matchAll(rangePattern)) {
		const checkinDate = normalizeLodgingDate(match[1]);
		const checkoutDate = normalizeLodgingDate(match[2]);
		if (!checkinDate || !checkoutDate || checkoutDate < checkinDate) {
			invalidRange = true;
			continue;
		}
		checkinDates.push(checkinDate);
		checkoutDates.push(checkoutDate);
	}
	const uniqueCheckinDates = unique(checkinDates);
	const uniqueCheckoutDates = unique(checkoutDates);
	const ambiguous = invalidRange || uniqueCheckinDates.length > 1 || uniqueCheckoutDates.length > 1;
	return {
		...(uniqueCheckinDates.length === 1 ? { checkinDate: uniqueCheckinDates[0] } : {}),
		...(uniqueCheckoutDates.length === 1 ? { checkoutDate: uniqueCheckoutDates[0] } : {}),
		ambiguous,
	};
}

/**
 * Classify a lodging OCR document conservatively. An authoritative invoice must
 * look like an invoice rather than a verification result: it needs the invoice
 * title and the normal buyer, seller, item, tax, and issue-date/issuer fields.
 */
function parseLodgingOcrDocument(document: Pick<TravelOcrDocument, "file" | "text">): ParsedLodgingOcr {
	const compact = compactOcrText(document.text);
	const empty = { invoiceNumbers: [], amounts: [] };
	if (!/(?:住宿(?:费|服务)|酒店|宾馆)/u.test(compact)) return { kind: "none", ...empty };
	// A railway verification may contain generic invoice vocabulary. Never let
	// that vocabulary (or an incidental hotel name/address) turn it into lodging.
	if (
		/(?:铁路电子客票|铁路客票|火车票|中国铁路|12306|车次[\s：:]*[GDCZTK]\s*\d|出发站|到达站|席别|旅客信息)/iu.test(
			compact,
		)
	) {
		return { kind: "none", ...empty };
	}
	const invoiceNumbers = unique(
		collectLabelledNumbers(compact, /(?:发票(?:号码|号)|电子发票号码|数电票号码)/u),
	);
	const amounts = unique(
		[...compact.matchAll(/价税合计(?:\s*[（(]小写[）)])?[\s：:]*[¥￥]?\s*(\d+(?:\.\d{1,2})?)/giu)]
			.map((match) => Number(match[1]))
			.filter((value) => Number.isFinite(value) && value > 0)
			.map((value) => Math.round(value * 100) / 100),
	);
	const isVerification = collectVerificationEvidence(compact).length > 0;
	const hasAuthoritativeLayout =
		!isVerification &&
		/(?:电子发票(?:[（(](?:普通发票|增值税专用发票)[）)])?|增值税(?:电子)?(?:普通|专用)发票|数电发票|全面数字化的电子发票)/u.test(
			compact,
		) &&
		/(?:购买方|购方)(?:信息|名称)/u.test(compact) &&
		/(?:销售方|销方)(?:信息|名称)/u.test(compact) &&
		/(?:项目名称|货物或应税劳务、服务名称)/u.test(compact) &&
		/(?:税率|税额)/u.test(compact) &&
		/(?:开票日期|开票人)/u.test(compact);
	const lodgingDates = resolveLodgingDates(compact);
	if (hasAuthoritativeLayout && invoiceNumbers.length === 1 && amounts.length === 1 && lodgingDates.ambiguous) {
		return {
			kind: "ambiguous",
			invoiceNumbers,
			amounts,
			issue: {
				file: document.file,
				kind: "ambiguous",
				reason: "住宿 PDF 中识别到相互冲突或倒置的住宿日期范围",
				invoiceNumbers,
				amounts,
			},
		};
	}
	if (hasAuthoritativeLayout && invoiceNumbers.length === 1 && amounts.length === 1) {
		return {
			kind: "invoice",
			invoiceNumbers,
			amounts,
			candidate: {
				invoiceNumber: invoiceNumbers[0],
				amount: amounts[0],
				uploadFile: document.file,
				verificationFiles: [],
				...(lodgingDates.checkinDate ? { checkinDate: lodgingDates.checkinDate } : {}),
				...(lodgingDates.checkoutDate ? { checkoutDate: lodgingDates.checkoutDate } : {}),
			},
		};
	}
	if (isVerification && !hasAuthoritativeLayout && invoiceNumbers.length === 1) {
		return { kind: "related", invoiceNumbers, amounts };
	}
	const kind = invoiceNumbers.length > 1 || (hasAuthoritativeLayout && amounts.length > 1) ? "ambiguous" : "missing";
	const missingFields = [
		!hasAuthoritativeLayout ? "明确的主发票版式" : undefined,
		invoiceNumbers.length === 0 ? "唯一发票号" : undefined,
		hasAuthoritativeLayout && amounts.length === 0 ? "唯一价税合计" : undefined,
	].filter(Boolean);
	return {
		kind,
		invoiceNumbers,
		amounts,
		issue: {
			file: document.file,
			kind,
			reason:
				kind === "ambiguous"
					? "住宿 PDF 中识别到多个发票号或主发票价税合计"
					: `住宿 PDF 缺少${missingFields.join("和")}`,
			invoiceNumbers,
			amounts,
		},
	};
}

/** Resolve zero or exactly one lodging invoice; multiple possible documents are never guessed. */
export function resolveLodgingInvoiceCandidate(
	documents: Array<Pick<TravelOcrDocument, "file" | "text">>,
): LodgingInvoiceResolution {
	const candidates: LodgingInvoiceCandidate[] = [];
	const relatedDocuments: Array<{ file: string; invoiceNumber: string }> = [];
	const issues: LodgingOcrIssue[] = [];
	const classifiedFiles: string[] = [];
	for (const document of documents) {
		const parsed = parseLodgingOcrDocument(document);
		if (parsed.kind === "none") continue;
		classifiedFiles.push(document.file);
		if (parsed.candidate) candidates.push(parsed.candidate);
		if (parsed.kind === "related") {
			relatedDocuments.push({ file: document.file, invoiceNumber: parsed.invoiceNumbers[0] });
		}
		if (parsed.issue) issues.push(parsed.issue);
	}
	if (candidates.length === 0 && classifiedFiles.length > 0) {
		const relatedInvoiceNumbers = unique(relatedDocuments.map((item) => item.invoiceNumber));
		if (relatedInvoiceNumbers.length > 1 || issues.length === 0) {
			issues.push({
				file: relatedDocuments[0]?.file ?? classifiedFiles[0],
				kind: relatedInvoiceNumbers.length > 1 ? "ambiguous" : "missing",
				reason:
					relatedInvoiceNumbers.length > 1
						? "住宿相关 PDF 中存在多个票号，且没有唯一主发票"
						: "住宿相关 PDF 中未识别到唯一主发票",
				invoiceNumbers: relatedInvoiceNumbers,
				amounts: [],
			});
		}
	}
	if (candidates.length > 1) {
		issues.push({
			file: candidates[1].uploadFile,
			kind: "ambiguous",
			reason: "识别到多个住宿主发票，无法自动选择",
			invoiceNumbers: unique(candidates.map((item) => item.invoiceNumber)),
			amounts: unique(candidates.map((item) => item.amount)),
		});
	}
	if (candidates.length === 1) {
		const invoice = candidates[0];
		for (const related of relatedDocuments) {
			if (related.invoiceNumber === invoice.invoiceNumber) continue;
			issues.push({
				file: related.file,
				kind: "ambiguous",
				reason: `住宿相关 PDF 票号 ${related.invoiceNumber} 与主发票票号 ${invoice.invoiceNumber} 不一致`,
				invoiceNumbers: [related.invoiceNumber],
				amounts: [],
			});
		}
		if (issues.length === 0) {
			const resolved = {
				...invoice,
				verificationFiles: relatedDocuments.map((item) => item.file),
			};
			return { status: "ready", invoice: resolved, candidates: [resolved], issues, classifiedFiles };
		}
	}
	const status =
		candidates.length > 1 || issues.some((item) => item.kind === "ambiguous") || candidates.length === 1
			? "ambiguous"
			: "missing";
	return { status, candidates, issues, classifiedFiles };
}

function amountMatches(values: number[], expected: number | undefined): boolean {
	return expected !== undefined && values.some((value) => Math.abs(value - expected) < 0.005);
}

/**
 * Pair verification files conservatively: invoice number wins; otherwise both
 * train number and amount must agree. Amount-only and filename-based guesses
 * are deliberately rejected.
 */
export function matchVerificationFiles(
	invoices: MatchableRailwayInvoice[],
	candidates: VerificationCandidate[],
): VerificationPairing {
	const verificationFilesByInvoice = invoices.map(() => [] as string[]);
	const ambiguous: VerificationPairing["ambiguous"] = [];
	const unmatched: VerificationPairing["unmatched"] = [];
	for (const candidate of candidates) {
		if (candidate.error) {
			unmatched.push({ file: candidate.file, reason: candidate.error, fingerprint: candidate.fingerprint });
			continue;
		}
		const fingerprint = candidate.fingerprint;
		if (!fingerprint.verificationEvidence?.length) {
			unmatched.push({
				file: candidate.file,
				reason: "OCR 未识别到国家税务机关、发票查验平台、查验结果或查验时间等明确查验证据",
				fingerprint,
			});
			continue;
		}
		const invoiceMatches = invoices
			.map((invoice, index) => ({ invoice, index }))
			.filter(({ invoice }) => Boolean(invoice.invoiceNumber && fingerprint.invoiceNumbers.includes(invoice.invoiceNumber)))
			.map(({ index }) => index);
		let matches = invoiceMatches;
		const signals: string[] = [];
		if (fingerprint.invoiceNumbers.length > 1) {
			// 一个查验文件出现多个不同票号时，即使其中只有一个属于本批行程，
			// 也不能静默把整份多票文件绑定到单条费用明细。
			ambiguous.push({
				file: candidate.file,
				candidateInvoiceIndexes: invoiceMatches,
				signals: ["multipleInvoiceNumbers"],
			});
			continue;
		}
		if (invoiceMatches.length > 0) {
			signals.push("invoiceNumber");
		} else if (fingerprint.invoiceNumbers.length === 0) {
			matches = invoices
				.map((invoice, index) => ({ invoice, index }))
				.filter(
					({ invoice }) =>
						Boolean(invoice.trainNumber && fingerprint.trainNumbers.includes(invoice.trainNumber.toUpperCase())) &&
						amountMatches(fingerprint.amounts, invoice.amount),
				)
				.map(({ index }) => index);
			if (matches.length > 0) signals.push("trainNumber", "amount");
		}
		if (matches.length === 1) {
			verificationFilesByInvoice[matches[0]].push(candidate.file);
		} else if (matches.length > 1) {
			ambiguous.push({ file: candidate.file, candidateInvoiceIndexes: matches, signals });
		} else {
			const reason = fingerprint.invoiceNumbers.length
				? "OCR 发票号与任何一张车票都不一致"
				: fingerprint.trainNumbers.length || fingerprint.amounts.length
					? "没有同时匹配到同一张车票的车次与金额"
					: "OCR 未识别到可用于配对的发票号，或车次与金额组合";
			unmatched.push({
				file: candidate.file,
				reason,
				fingerprint,
			});
		}
	}
	return {
		verificationFilesByInvoice,
		missingInvoiceIndexes: verificationFilesByInvoice
			.map((files, index) => ({ files, index }))
			.filter(({ files }) => files.length === 0)
			.map(({ index }) => index),
		ambiguous,
		unmatched,
	};
}
