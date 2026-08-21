/**
 * “差旅报销”能力包。
 *
 * 易快报（合思）差旅费用报销单的自动填报助手：提供报销规则速查、费用明细
 * 计划与铁路电子客票（OFD/压缩包）解析工具；页面操作复用客户端内置浏览器
 * （browser_* 工具），本包不直接接触页面。
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PackContext } from "../../src/packs.ts";

function textResult(text: string, details: Record<string, unknown> = {}): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details };
}

// ---------------------------------------------------------------------------
// 铁路电子客票（OFD）解析：OFD 本质是 zip，解包后读 Content.xml 里的文本
// ---------------------------------------------------------------------------

interface RailwayInvoice {
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
	error?: string;
}

interface ExtractedDocument {
	source: string;
	root: string;
	attachment?: string;
}

function systemTarExecutable(): string {
	const root = process.env.SystemRoot ?? process.env.WINDIR;
	return root ? join(root, "System32", "tar.exe") : "tar";
}

/** 递归列出目录下全部文件。 */
function listFilesRecursive(root: string): string[] {
	const output: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const full = join(root, entry.name);
		if (entry.isDirectory()) output.push(...listFilesRecursive(full));
		else output.push(full);
	}
	return output;
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

function xmlLocalValue(xml: string, localName: string): string | undefined {
	const escaped = localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = new RegExp(`<(?:[\\w.-]+:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${escaped}>`, "i").exec(xml);
	return match ? decodeXml(match[1].replace(/<[^>]+>/g, "")) : undefined;
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
	const fare = xmlLocalValue(xml, "Fare");
	const rawDate = xmlLocalValue(xml, "TravelDate");
	const rawIssueDate = xmlLocalValue(xml, "DateOfIssue");
	return {
		fromStation: xmlLocalValue(xml, "DepartureStation"),
		toStation: xmlLocalValue(xml, "DestinationStation"),
		trainNumber: xmlLocalValue(xml, "TrainNumber"),
		date: rawDate ? normalizeDate(rawDate) : undefined,
		departTime: xmlLocalValue(xml, "DepartureTime")?.match(/\d{1,2}:\d{2}/)?.[0],
		seatClass: xmlLocalValue(xml, "SeatLevel"),
		amount: fare && Number.isFinite(Number(fare.replace(/[^\d.]/g, ""))) ? Number(fare.replace(/[^\d.]/g, "")) : undefined,
		passenger: xmlLocalValue(xml, "Name"),
		invoiceNumber:
			xmlLocalValue(xml, "InvoiceNumber") ??
			xmlLocalValue(xml, "ElectronicTicketNumber") ??
			xmlLocalValue(xml, "TicketNumber"),
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

function unpackArchive(file: string, destination: string): string | undefined {
	try {
		execFileSync(systemTarExecutable(), ["-xf", file, "-C", destination], { windowsHide: true, timeout: 15000 });
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

function fileDigest(file: string): string {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function safeAttachmentStem(value: string): string {
	const cleaned = value.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "");
	return cleaned || "railway-ticket";
}

/**
 * 把解压目录里的票据复制到工作区的持久目录。每次解析都创建独立文件并校验内容，
 * 避免旧文件或同名往返票互相覆盖；失败必须显式报错，绝不回退上传整个压缩包。
 */
function durableAttachment(workspaceRoot: string, picked: string | undefined, identity: string): string {
	if (!picked) throw new Error("没有找到可上传的铁路电子客票附件");
	if (!existsSync(picked) || !statSync(picked).isFile()) throw new Error(`票据附件不存在：${picked}`);
	const extension = /\.pdf$/i.test(picked) ? ".pdf" : ".ofd";
	const stem = safeAttachmentStem(identity || basename(picked).replace(/\.(?:pdf|ofd)$/i, ""));
	const durableDir = join(workspaceRoot, ".pi", "travel-expense", "attachments");
	mkdirSync(durableDir, { recursive: true });
	const durable = join(durableDir, `${stem}-${randomUUID()}${extension}`);
	try {
		copyFileSync(picked, durable);
		if (!existsSync(durable) || statSync(durable).size !== statSync(picked).size || fileDigest(durable) !== fileDigest(picked)) {
			throw new Error("复制后的文件内容校验失败");
		}
		return durable;
	} catch (error) {
		rmSync(durable, { force: true });
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`票据附件持久化失败：${reason}`);
	}
}

function parseExtractedDocument(document: ExtractedDocument, requested: string, workspaceRoot: string): RailwayInvoice {
	const files = listFilesRecursive(document.root);
	const xbrlFile = files.find((path) => /[\\/]Doc_0[\\/]Attachs[\\/]rai_issuer_[^\\/]+\.xml$/i.test(path));
	const xbrl = xbrlFile ? parseRailwayXbrl(readFileSync(xbrlFile, "utf8")) : {};
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

/** 解析一个输入文件中的全部票据；每个 OFD 独立解析，严禁跨票拼接 XML。 */
function readRailwayInvoices(requested: string, workspaceRoot: string): RailwayInvoice[] {
	const file = isAbsolute(requested) ? resolve(requested) : resolve(workspaceRoot, requested);
	if (!existsSync(file) || !statSync(file).isFile()) {
		return [{ source: requested, uploadFile: file, error: "文件不存在" }];
	}
	const lower = file.toLocaleLowerCase("en-US");
	if (!lower.endsWith(".ofd") && !lower.endsWith(".zip")) {
		return [{
			source: requested,
			uploadFile: file,
			error: "只支持 .ofd 或含 ofd/pdf 的 .zip 压缩包；扫描件 PDF 请让用户改发电子发票（OFD）",
		}];
	}
	const workDir = mkdtempSync(join(tmpdir(), "pi-invoice-"));
	try {
		const unpackError = unpackArchive(file, workDir);
		if (unpackError) return [{ source: requested, uploadFile: file, error: `解压失败：${unpackError}` }];
		const outerFiles = listFilesRecursive(workDir).sort((a, b) => a.localeCompare(b, "en"));
		const nestedOfds = outerFiles.filter((path) => /\.ofd$/i.test(path));
		const documents: ExtractedDocument[] = [];
		const usedAttachments = new Set<string>();
		if (nestedOfds.length > 0) {
			for (const [index, ofd] of nestedOfds.entries()) {
				const inner = join(workDir, `ofd-inner-${index}`);
				mkdirSync(inner, { recursive: true });
				const error = unpackArchive(ofd, inner);
				if (error) {
					documents.push({ source: relative(workDir, ofd), root: inner, attachment: ofd });
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
		} else {
			documents.push({ source: basename(file), root: workDir, attachment: file });
		}
		const invoices = documents.map((document) => parseExtractedDocument(document, requested, workspaceRoot));
		if (invoices.every((invoice) => invoice.error)) {
			if (invoices.some((invoice) => invoice.error?.includes("票据附件"))) return invoices;
			return [{
				source: requested,
				uploadFile: file,
				error: "压缩包里没有可解析的铁路电子客票；请提供原始 OFD 或含 OFD 的压缩包，不要只发截图",
			}];
		}
		return invoices;
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
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

export default function definePack(ctx: PackContext) {
	const workspaceRoot = () => ctx.getWorkspaceRoot();
	const tools: ToolDefinition[] = [
		{
			name: "travel_reimbursement_guide",
			label: "差旅报销规则速查",
			description: "返回当前公司差旅费用报销单（易快报/合思）的字段填写规则、固定取值和安全红线。",
			parameters: Type.Object({}),
			execute: async () => textResult(reimbursementGuideText()),
		},
		{
			name: "travel_read_invoices",
			label: "解析铁路电子客票",
			description:
				"解析铁路电子客票发票（.ofd 文件或包含 ofd/pdf 的 .zip 压缩包），提取车次、起止站、日期时间、席别、票价、乘车人、发票号，并给出建议上传的发票文件。用户发来票据附件后先用本工具解析，不要手工解压。",
			parameters: Type.Object({
				paths: Type.Array(Type.String(), {
					minItems: 1,
					description: "票据文件路径（工作区相对或绝对路径），支持 .ofd / .zip",
				}),
			}),
			execute: async (_id, rawParams) => {
				const params = rawParams as { paths: string[] };
				const invoices = params.paths.flatMap((path) => readRailwayInvoices(path, workspaceRoot()));
				const seenInvoices = new Set<string>();
				for (const invoice of invoices) {
					if (invoice.error || !invoice.invoiceNumber) continue;
					if (seenInvoices.has(invoice.invoiceNumber)) invoice.error = `检测到重复票据：${invoice.invoiceNumber}`;
					else seenInvoices.add(invoice.invoiceNumber);
				}
				const lines = invoices.map((invoice) => {
					if (invoice.error) return `✗ ${invoice.source}：${invoice.error}`;
					return [
						`✓ ${invoice.invoiceNumber ?? "（发票号未识别）"}：`,
						`  ${invoice.trainNumber} ${invoice.fromStation} ${invoice.departTime}开 → ${invoice.toStation}`,
						`  计划城市：${invoice.fromCity ?? "未识别"} → ${invoice.toCity ?? "未识别"}（原始站名保留如上）`,
						`  ${invoice.date} ${invoice.seatClass} ¥${invoice.amount} 乘车人：${invoice.passenger ?? "未识别"}`,
						`  开票日期 ${invoice.issueDate ?? "未识别"}；上传附件用：${invoice.uploadFile}`,
					].join("\n");
				});
				return textResult(lines.join("\n\n"), { invoices });
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
