/**
 * “差旅报销”能力包。
 *
 * 易快报（合思）差旅费用报销单的自动填报助手：提供报销规则速查、费用明细
 * 计划与铁路电子客票（OFD/压缩包）解析工具；页面操作复用客户端内置浏览器
 * （browser_* 工具），本包不直接接触页面。
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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
	date?: string;
	departTime?: string;
	seatClass?: string;
	amount?: number;
	passenger?: string;
	invoiceNumber?: string;
	issueDate?: string;
	error?: string;
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
	const objects = [...xml.matchAll(/<ofd:TextObject([^>]*)>([\s\S]*?)<\/ofd:TextObject>/g)].map((match) => {
		const boundary = match[1].match(/Boundary="([-\d.\s]+)"/);
		const [x, y] = boundary ? boundary[1].trim().split(/\s+/).slice(0, 2).map(Number) : [0, 0];
		const codes = [...match[2].matchAll(/<ofd:TextCode[^>]*>([\s\S]*?)<\/ofd:TextCode>/g)].map((code) =>
			code[1]
				.replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
				.replace(/&amp;/g, "&")
				.replace(/&lt;/g, "<")
				.replace(/&gt;/g, ">"),
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
	const match = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
	if (!match) return undefined;
	return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
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

/** 解析单张票据：.ofd / 含 ofd+pdf 的 .zip。 */
function readRailwayInvoice(requested: string, workspaceRoot: string): RailwayInvoice {
	const file = isAbsolute(requested) ? resolve(requested) : resolve(workspaceRoot, requested);
	if (!existsSync(file) || !statSync(file).isFile()) {
		return { source: requested, uploadFile: file, error: "文件不存在" };
	}
	const lower = file.toLocaleLowerCase("en-US");
	if (!lower.endsWith(".ofd") && !lower.endsWith(".zip")) {
		return {
			source: requested,
			uploadFile: file,
			error: "只支持 .ofd 或含 ofd/pdf 的 .zip 压缩包；扫描件 PDF 请让用户改发电子发票（OFD）",
		};
	}
	let workDir: string;
	try {
		workDir = mkdtempSync(join(tmpdir(), "pi-invoice-"));
		execFileSync(systemTarExecutable(), ["-xf", file, "-C", workDir], { windowsHide: true, timeout: 15000 });
	} catch (error) {
		return {
			source: requested,
			uploadFile: file,
			error: `解压失败：${error instanceof Error ? error.message : String(error)}`,
		};
	}
	try {
		let files = listFilesRecursive(workDir);
		let contentFiles = files.filter((path) => /content\.xml$/i.test(path));
		if (contentFiles.length === 0) {
			// 真实票据常见结构：外层 zip 里直接是 .ofd 文件（OFD 本身又是压缩包），需要再解一层
			const nested = files.filter((path) => /\.ofd$/i.test(path));
			for (const [index, ofd] of nested.entries()) {
				const inner = join(workDir, `ofd-inner-${index}`);
				mkdirSync(inner, { recursive: true });
				try {
					execFileSync(systemTarExecutable(), ["-xf", ofd, "-C", inner], {
						windowsHide: true,
						timeout: 15000,
					});
					contentFiles.push(
						...listFilesRecursive(inner).filter((path) => /content\.xml$/i.test(path)),
					);
				} catch {
					/* 单个内层 OFD 解压失败不影响其余票据 */
				}
			}
			files = listFilesRecursive(workDir);
		}
		if (contentFiles.length === 0) {
			return {
				source: requested,
				uploadFile: file,
				error: "压缩包里没有铁路电子客票票面（OFD Content.xml）；请提供原始 OFD 文件或含 OFD 的压缩包，不要只发截图",
			};
		}
		const text = contentFiles.map((path) => ofdXmlText(readFileSync(path, "utf8"))).join("\n");
		const parsed = parseRailwayText(text);
		// 建议上传的发票文件：优先 pdf（页面渲染友好），其次 ofd，最后原文件；
		// 从临时目录复制回原压缩包所在目录，避免临时目录清理后上传失败
		let uploadFile: string = file;
		const pdf = files.find((path) => /\.pdf$/i.test(path));
		const ofd = files.find((path) => /\.ofd$/i.test(path));
		const picked = pdf ?? ofd;
		if (picked) {
			const durable = join(dirname(file), basename(picked));
			if (!existsSync(durable)) {
				try {
					copyFileSync(picked, durable);
				} catch {
					/* 复制失败时退回原压缩包作为上传文件 */
				}
			}
			if (existsSync(durable)) uploadFile = durable;
		}
		return { source: requested, uploadFile, ...parsed };
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
}

interface TripHotel {
	amount: number;
	checkin?: string;
	checkout?: string;
}

interface PlanParams {
	tripTitle?: string;
	startDate: string;
	endDate: string;
	legs: TripLeg[];
	hotel?: TripHotel;
	allowancePerDay?: number;
}

/** 报销规则速查：与技能文档同源的关键取值，模型可在流程中随时复核。 */
function reimbursementGuideText(): string {
	return [
		"差旅费用报销单填报规则（易快报/合思）：",
		"1. 关联申请：必须从已有出差申请中选择（点击 data-testid=field-expenseLink-select，在弹窗中按标题搜索后勾选并确认）。",
		"2. 所属公司、提交人、报销日期（默认当天）、申请人部门、费用所属部门通常已自动带出；只需核对，一般不改动。",
		"3. 报销说明：写关联出差申请的事由（如“常州业务拓展”），字段 data-testid=field-text-u_事由。",
		"4. 驻地：固定选 江苏省 → 南京市，绝不选“市辖区/市区”一类节点。",
		"5. 费用性质：与关联的出差申请保持一致（常见两种：部门费用 / 项目费用），先在关联申请的“详情”里确认再填。",
		"6. 部门（如需手填）：申请人部门与费用所属部门一致，按 赛昇信息技术研究院江苏有限公司 / 政策支撑部 / 工业信息安全组 逐级选择。",
		"7. 关联项目、核销借款、“是否为多收款人”不处理。",
		"8. 支付信息：选择收款人“苏爱健”。",
		"9. 费用明细（点击 data-testid=field-expenseDetail-add 逐条添加）：",
		"   - 当天往返：城市交通费（火车/高铁）逐程一条 + 出差补助一条；没有住宿费。",
		"   - 多天出差：城市交通费逐程一条 + 住宿费一条 + 出差补助一条。",
		"   - 城市交通费：费用类型固定选火车/高铁；起止日期、出发到达城市与出差申请一致；席别、金额与车票发票一致；附件=车票截图+车票查验截图。",
		"   - 住宿费：金额与住宿发票一致，附件=住宿发票。",
		"   - 出差补助：补助类型固定选“其他省份”；起止日期与出差申请一致；补贴标准 180 元/天，金额由系统按天数自动核算。",
		"10. 全部填完后点击 存为草稿（data-testid=flexable-button-edit）。绝对不要点击 提交送审（flexable-button-submit）或 删除单据。",
	].join("\n");
}

function planDays(start: string, end: string): number {
	const startTime = new Date(`${start}T00:00:00`).getTime();
	const endTime = new Date(`${end}T00:00:00`).getTime();
	if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) {
		throw new Error(`出差起止日期不合法：${start} ~ ${end}（格式应为 YYYY-MM-DD）`);
	}
	return Math.round((endTime - startTime) / 86400000) + 1;
}

interface DetailRow {
	kind: "城市交通费" | "住宿费" | "出差补助";
	summary: string;
	[key: string]: unknown;
}

function buildDetailPlan(params: PlanParams): { rows: DetailRow[]; notes: string[] } {
	const days = planDays(params.startDate, params.endDate);
	const sameDay = days === 1;
	const allowancePerDay = params.allowancePerDay ?? 180;
	const rows: DetailRow[] = [];

	for (const [index, leg] of params.legs.entries()) {
		rows.push({
			kind: "城市交通费",
			summary: `交通 ${leg.from} → ${leg.to}（${leg.date}，${leg.seatClass}，¥${leg.amount}）`,
			费用类型: "城市交通费（火车/高铁）",
			排序: index + 1,
			出发城市: leg.from,
			到达城市: leg.to,
			起止日期: `${leg.date} 至 ${leg.date}`,
			席别: leg.seatClass,
			报销金额: leg.amount,
			附件: "火车票截图 + 火车票查验截图",
		});
	}

	if (params.hotel && params.hotel.amount > 0) {
		rows.push({
			kind: "住宿费",
			summary: `住宿 ¥${params.hotel.amount}${params.hotel.checkin ? `（${params.hotel.checkin} ~ ${params.hotel.checkout ?? params.hotel.checkin}）` : ""}`,
			费用类型: "住宿费",
			起止日期: params.hotel.checkin
				? `${params.hotel.checkin} 至 ${params.hotel.checkout ?? params.hotel.checkin}`
				: `${params.startDate} 至 ${params.endDate}`,
			报销金额: params.hotel.amount,
			附件: "住宿发票",
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
				const invoices = params.paths.map((path) => readRailwayInvoice(path, workspaceRoot()));
				const lines = invoices.map((invoice) => {
					if (invoice.error) return `✗ ${invoice.source}：${invoice.error}`;
					return [
						`✓ ${invoice.invoiceNumber ?? "（发票号未识别）"}：`,
						`  ${invoice.trainNumber} ${invoice.fromStation} ${invoice.departTime}开 → ${invoice.toStation}`,
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
				"根据出差申请与票据信息，确定性地生成费用明细行（城市交通费/住宿费/出差补助）：当天往返不生成住宿费；补助按 180 元/天由系统自动核算。",
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
					}),
					{ minItems: 1, description: "城市间火车/高铁行程，逐程一条（往返各一条）" },
				),
				hotel: Type.Optional(
					Type.Object({
						amount: Type.Number({ description: "住宿费金额（元），与住宿发票一致" }),
						checkin: Type.Optional(Type.String({ description: "入住日期 YYYY-MM-DD" })),
						checkout: Type.Optional(Type.String({ description: "离店日期 YYYY-MM-DD" })),
					}),
				),
				allowancePerDay: Type.Optional(Type.Number({ description: "出差补贴标准（元/天），默认 180" })),
			}),
			execute: async (_id, rawParams) => {
				const params = rawParams as PlanParams;
				const plan = buildDetailPlan(params);
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
