import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, describe, expect, it, vi } from "vitest";
import definePack, {
	bindTravelDraftParams,
	durableAttachment,
	fillTravelDraft,
	type InvoiceAttachmentResult,
	readAndPairRailwayAttachments,
	travelExpenseResourceCandidates,
} from "../packs/travel-expense/index.ts";
import {
	extractRailwayEmbeddedXml,
	matchVerificationFiles,
	parseVerificationFingerprint,
	resolveLodgingInvoiceCandidate,
} from "../packs/travel-expense/pdf-embedded.ts";
import type {
	TravelDraftApplication,
	TravelDraftExpected,
	TravelDraftHeaderExpected,
	TravelDraftHotelExpected,
	TravelDraftObservation,
	TravelDraftPlan,
	TravelDraftTransportExpected,
} from "../packs/travel-expense/workflow.ts";
import type { TravelDraftBrowserDriver } from "../packs/travel-expense/workflow-browser-driver.ts";

const packWorkspace = mkdtempSync(join(tmpdir(), "pi-travel-pack-test-"));
const attachmentFixtures = join(packWorkspace, "input-attachments");
mkdirSync(attachmentFixtures, { recursive: true });
const tools = definePack({ getWorkspaceRoot: () => packWorkspace }).tools;

afterAll(() => rmSync(packWorkspace, { recursive: true, force: true }));

function attachmentsFor(id: string) {
	const uploadFile = join(attachmentFixtures, `${id}-ticket.pdf`);
	const verificationFile = join(attachmentFixtures, `${id}-verification.png`);
	writeFileSync(uploadFile, `%PDF-ticket-${id}`, "utf8");
	writeFileSync(verificationFile, `verification-${id}`, "utf8");
	return { uploadFile, verificationFiles: [verificationFile] };
}

function hotelAttachmentsFor(id: string) {
	const uploadFile = join(attachmentFixtures, `${id}-hotel-invoice.pdf`);
	const verificationFile = join(attachmentFixtures, `${id}-hotel-verification.png`);
	writeFileSync(uploadFile, `%PDF-hotel-${id}`, "utf8");
	writeFileSync(verificationFile, `hotel-verification-${id}`, "utf8");
	return { uploadFile, verificationFiles: [verificationFile] };
}

function tool(name: string) {
	const found = tools.find((item) => item.name === name);
	if (!found) throw new Error(`工具不存在：${name}`);
	return found;
}

class SentinelWorkflowDriver {
	private readonly application: TravelDraftApplication;
	private readonly onSave: () => void;
	private readonly beforeSaveIntent: (() => void) | undefined;
	private state: TravelDraftObservation = {
		page: "closed",
		details: [],
		draft: { saveRequested: false, saved: false },
	};

	constructor(application: TravelDraftApplication, onSave: () => void, beforeSaveIntent?: () => void) {
		this.application = structuredClone(application);
		this.onSave = onSave;
		this.beforeSaveIntent = beforeSaveIntent;
	}

	private output(): TravelDraftObservation {
		return { ...structuredClone(this.state), detailCount: this.state.details.length };
	}

	private upsert(row: TravelDraftObservation["details"][number]): void {
		const index = this.state.details.findIndex((item) => item.key === row.key);
		if (index >= 0) this.state.details[index] = structuredClone(row);
		else this.state.details.push(structuredClone(row));
	}

	async discoverApplication() {
		this.state.page = "form";
		this.state.application = structuredClone(this.application);
		return {
			status: "selected" as const,
			application: structuredClone(this.application),
			missing: [],
			ambiguous: [],
			candidates: [],
		};
	}

	async precheck(_plan: TravelDraftPlan, _expected: TravelDraftExpected) {
		return { observation: this.output(), missing: [], ambiguous: [] };
	}

	async observe(_expected: TravelDraftExpected): Promise<TravelDraftObservation> {
		return this.output();
	}

	async open(_url: string): Promise<TravelDraftObservation> {
		this.state.page = "form";
		return this.output();
	}

	async ensureApplication(application: TravelDraftApplication): Promise<TravelDraftObservation> {
		this.state.application = structuredClone(application);
		return this.output();
	}

	async ensureHeader(header: TravelDraftHeaderExpected): Promise<TravelDraftObservation> {
		this.state.header = structuredClone(header);
		return this.output();
	}

	async ensureTransport(row: TravelDraftTransportExpected): Promise<TravelDraftObservation> {
		this.upsert(row);
		return this.output();
	}

	async ensureHotel(row: TravelDraftHotelExpected): Promise<TravelDraftObservation> {
		this.upsert(row);
		return this.output();
	}

	async ensureAllowance(row: TravelDraftExpected["allowance"]): Promise<TravelDraftObservation> {
		this.upsert(row);
		return this.output();
	}

	async verify(expected: TravelDraftExpected): Promise<TravelDraftObservation> {
		this.state.calculatedTotal = expected.totalAmount;
		this.state.verification = { valid: true, errors: [] };
		return this.output();
	}

	async saveDraft(
		_expected: TravelDraftExpected,
		onDispatch?: () => void | Promise<void>,
	): Promise<TravelDraftObservation> {
		this.beforeSaveIntent?.();
		await onDispatch?.();
		this.onSave();
		this.state.draft = { saveRequested: true, saved: false };
		return this.output();
	}

	async confirmDraftSaved(): Promise<TravelDraftObservation> {
		this.state.draft = { saveRequested: true, saved: true, confirmationText: "草稿保存成功" };
		return this.output();
	}
}

interface FakeTicket {
	invoiceNumber: string;
	trainNumber: string;
	fromStation: string;
	toStation: string;
	departTime: string;
	amount: number;
	xmlPrefix?: string;
	omitXbrl?: boolean;
	extraXbrl?: string;
}

/** 构造仿真铁路电子客票：外层 ZIP 可包含多组同名 OFD+PDF，每张票有独立 XBRL。 */
function buildFakeInvoiceZip(
	tickets: FakeTicket[] = [
		{
			invoiceNumber: "10000000000000000001",
			trainNumber: "G7575",
			fromStation: "南京南站",
			toStation: "常州站",
			departTime: "12:12",
			amount: 72,
		},
	],
	layout: "flat" | "same-basename-directories" = "flat",
): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-invoice-test-"));
	const tar = join(process.env.SystemRoot ?? process.env.WINDIR ?? "", "System32", "tar.exe");
	const compress = (cwd: string, dest: string, sources: string[]) => {
		// bsdtar 按 .zip 后缀生成 ZIP；OFD 用同一 ZIP 内容改名即可。
		const direct = dest.toLocaleLowerCase("en-US").endsWith(".zip");
		const zipName = direct ? dest : "pi-tmp-archive.zip";
		execFileSync(tar, ["-a", "-cf", zipName, ...sources], { cwd, windowsHide: true, timeout: 30000 });
		if (!direct) {
			copyFileSync(join(cwd, zipName), join(cwd, dest));
			rmSync(join(cwd, zipName), { force: true });
		}
	};

	const outerDir = join(dir, "outer");
	mkdirSync(outerDir, { recursive: true });
	const outerSources: string[] = [];
	for (const [index, ticket] of tickets.entries()) {
		const ofdDir = join(dir, `ofd-doc-${index}`);
		mkdirSync(join(ofdDir, "Doc_0", "Pages", "Page_0"), { recursive: true });
		mkdirSync(join(ofdDir, "Doc_0", "Attachs"), { recursive: true });
		const prefix = ticket.xmlPrefix ?? "ofd";
		const tag = (name: string) => (prefix ? `${prefix}:${name}` : name);
		const namespace = prefix ? ` xmlns:${prefix}="http://www.ofdspec.org/2016"` : "";
		const xml = `<?xml version="1.0" encoding="utf-8"?>
<${tag("Page")}${namespace}><${tag("Content")}>
<${tag("TextObject")} ID="11" Boundary="40 40 14 8"><${tag("TextCode")}>${ticket.fromStation.replace(/站$/, "")}</${tag("TextCode")}></${tag("TextObject")}>
<${tag("TextObject")} ID="14" Boundary="54 40 8 8"><${tag("TextCode")}>站</${tag("TextCode")}></${tag("TextObject")}>
<${tag("TextObject")} ID="12" Boundary="64 40 12 8"><${tag("TextCode")}>${ticket.trainNumber}</${tag("TextCode")}></${tag("TextObject")}>
<${tag("TextObject")} ID="10" Boundary="78 40 10 8"><${tag("TextCode")}>${ticket.toStation.replace(/站$/, "")}</${tag("TextCode")}></${tag("TextObject")}>
<${tag("TextObject")} ID="13" Boundary="88 40 8 8"><${tag("TextCode")}>站</${tag("TextCode")}></${tag("TextObject")}>
<${tag("TextObject")} ID="20" Boundary="10 50 60 8"><${tag("TextCode")}>2026年08月21日</${tag("TextCode")}></${tag("TextObject")}>
<${tag("TextObject")} ID="21" Boundary="70 50 30 8"><${tag("TextCode")}>${ticket.departTime}开</${tag("TextCode")}></${tag("TextObject")}>
<${tag("TextObject")} ID="22" Boundary="100 50 40 8"><${tag("TextCode")}>二等座</${tag("TextCode")}></${tag("TextObject")}>
<${tag("TextObject")} ID="30" Boundary="10 60 50 8"><${tag("TextCode")}>票价:</${tag("TextCode")}></${tag("TextObject")}>
<${tag("TextObject")} ID="31" Boundary="35 60 10 8"><${tag("TextCode")}>￥</${tag("TextCode")}></${tag("TextObject")}>
<${tag("TextObject")} ID="32" Boundary="45 60 20 8"><${tag("TextCode")}>${ticket.amount.toFixed(2)}</${tag("TextCode")}></${tag("TextObject")}>
<${tag("TextObject")} ID="40" Boundary="10 70 30 8"><${tag("TextCode")}>苏爱健</${tag("TextCode")}></${tag("TextObject")}>
<${tag("TextObject")} ID="41" Boundary="10 75 60 8"><${tag("TextCode")}>3212811997****4234</${tag("TextCode")}></${tag("TextObject")}>
<${tag("TextObject")} ID="50" Boundary="10 20 80 8"><${tag("TextCode")}>发票号码:${ticket.invoiceNumber}开票日期:2026年08月21日</${tag("TextCode")}></${tag("TextObject")}>
</${tag("Content")}></${tag("Page")}>`;
		const xbrl = `<?xml version="1.0" encoding="utf-8"?>
<rail:Invoice xmlns:rail="urn:railway:invoice">
<rail:DepartureStation>${ticket.fromStation}</rail:DepartureStation>
<rail:DestinationStation>${ticket.toStation}</rail:DestinationStation>
<rail:TrainNumber>${ticket.trainNumber}</rail:TrainNumber>
<rail:TravelDate>2026-08-21</rail:TravelDate>
<rail:DepartureTime>${ticket.departTime}</rail:DepartureTime>
<rail:SeatLevel>二等座</rail:SeatLevel>
<rail:Fare>${ticket.amount.toFixed(2)}</rail:Fare>
<rail:Name>苏爱健</rail:Name>
<rail:InvoiceNumber>${ticket.invoiceNumber}</rail:InvoiceNumber>
<rail:DateOfIssue>2026-08-21</rail:DateOfIssue>
</rail:Invoice>`;
		writeFileSync(join(ofdDir, "Doc_0", "Pages", "Page_0", "Content.xml"), xml, "utf8");
		if (!ticket.omitXbrl) {
			writeFileSync(join(ofdDir, "Doc_0", "Attachs", `rai_issuer_${ticket.invoiceNumber}.xml`), xbrl, "utf8");
			if (ticket.extraXbrl) {
				writeFileSync(
					join(ofdDir, "Doc_0", "Attachs", `rai_issuer_${ticket.invoiceNumber}_extra.xml`),
					ticket.extraXbrl,
					"utf8",
				);
			}
		}
		const archiveStem = layout === "same-basename-directories" ? "ticket" : ticket.invoiceNumber;
		const relativeDir = layout === "same-basename-directories" ? `leg-${index + 1}` : "";
		const ticketOuterDir = relativeDir ? join(outerDir, relativeDir) : outerDir;
		mkdirSync(ticketOuterDir, { recursive: true });
		compress(ofdDir, `${archiveStem}.ofd`, ["Doc_0"]);
		copyFileSync(join(ofdDir, `${archiveStem}.ofd`), join(ticketOuterDir, `${archiveStem}.ofd`));
		writeFileSync(join(ticketOuterDir, `${archiveStem}.pdf`), `%PDF-fake-${ticket.invoiceNumber}`, "utf8");
		if (relativeDir) outerSources.push(relativeDir);
		else outerSources.push(`${archiveStem}.ofd`, `${archiveStem}.pdf`);
	}
	const outerName = "railway-invoices.zip";
	compress(outerDir, outerName, [...new Set(outerSources)]);
	return join(outerDir, outerName);
}

function fakeRailwayXbrl(invoiceNumber = "10000000000000000001", trainNumber = "G7575", amount = 72): string {
	return `<?xml version="1.0" encoding="utf-8"?>
<rail:Invoice xmlns:rail="urn:railway:invoice">
<rail:DepartureStation>南京南站</rail:DepartureStation>
<rail:DestinationStation>常州站</rail:DestinationStation>
<rail:TrainNumber>${trainNumber}</rail:TrainNumber>
<rail:TravelDate>2026-08-21</rail:TravelDate>
<rail:DepartureTime>12:12</rail:DepartureTime>
<rail:SeatLevel>二等座</rail:SeatLevel>
<rail:Fare>${amount.toFixed(2)}</rail:Fare>
<rail:Name>苏爱健</rail:Name>
<rail:ElectronicInvoiceRailwayETicketNumber>${invoiceNumber}</rail:ElectronicInvoiceRailwayETicketNumber>
<rail:DateOfIssue>2026-08-21</rail:DateOfIssue>
</rail:Invoice>`;
}

/** Minimal PDF sufficient to exercise an EmbeddedFiles name tree and FlateDecode stream. */
function buildEmbeddedRailwayPdf(xml = fakeRailwayXbrl()): Buffer {
	const compressed = deflateSync(Buffer.from(xml, "utf8"));
	return Buffer.concat([
		Buffer.from("%PDF-1.7\n"),
		Buffer.from("1 0 obj\n<< /Type /Catalog /Names << /EmbeddedFiles 2 0 R >> >>\nendobj\n"),
		Buffer.from("2 0 obj\n<< /Names [(rai_issuer_10000000000000000001.xml) 3 0 R] >>\nendobj\n"),
		Buffer.from(
			"3 0 obj\n<< /Type /Filespec /F (rai_issuer_10000000000000000001.xml) /UF (rai_issuer_10000000000000000001.xml) /EF << /F 4 0 R >> >>\nendobj\n",
		),
		Buffer.from(
			`4 0 obj\n<< /Type /EmbeddedFile /Subtype /text#2Fxml /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`,
		),
		compressed,
		Buffer.from("\nendstream\nendobj\n%%EOF\n"),
	]);
}

function buildTestPdf(objects: Array<[number, string | Buffer]>): Buffer {
	return Buffer.concat([
		Buffer.from("%PDF-1.7\n"),
		...objects.flatMap(([id, body]) => [
			Buffer.from(`${id} 0 obj\n`),
			typeof body === "string" ? Buffer.from(`${body}\n`) : body,
			Buffer.from("endobj\n"),
		]),
		Buffer.from("%%EOF\n"),
	]);
}

function buildPdfOnlyZip(entries: Array<{ name: string; content: string | Buffer }>): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-pdf-archive-test-"));
	const tar = join(process.env.SystemRoot ?? process.env.WINDIR ?? "", "System32", "tar.exe");
	for (const entry of entries) writeFileSync(join(dir, entry.name), entry.content);
	const archive = join(dir, "pdf-attachments.zip");
	execFileSync(tar, ["-a", "-cf", basename(archive), ...entries.map((entry) => entry.name)], {
		cwd: dir,
		windowsHide: true,
		timeout: 30000,
	});
	return archive;
}

function embeddedXmlStream(xml = fakeRailwayXbrl(), type = "EmbeddedFile"): Buffer {
	const compressed = deflateSync(Buffer.from(xml, "utf8"));
	return Buffer.concat([
		Buffer.from(`<< /Type /${type} /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`),
		compressed,
		Buffer.from("\nendstream\n"),
	]);
}

describe("差旅报销能力包", () => {
	it("注册单入口自动草稿与三个只读诊断工具", () => {
		expect(tools.map((item) => item.name).sort()).toEqual([
			"travel_fill_draft",
			"travel_plan_details",
			"travel_read_invoices",
			"travel_reimbursement_guide",
		]);
	});

	it("控制台直绑的 URL 和附件覆盖弱模型转抄出的错误参数", () => {
		expect(
			bindTravelDraftParams(
				{
					url: "https://app.ekuaibao.com/帮我报销",
					paths: ["模型猜测.pdf"],
					applicationHint: "常州",
				},
				{
					text: "请填常州 8月21日的出差报销并保存草稿",
					attachments: ["uploads/火车票.pdf", "uploads/查验件.pdf"],
					ekuaibaoTravelUrl:
						"https://app.ekuaibao.com/web/app.html?accessToken=pi-browser-secret-fixture#/billEntryDetail",
				},
			),
		).toEqual({
			url: "https://app.ekuaibao.com/web/app.html?accessToken=pi-browser-secret-fixture#/billEntryDetail",
			paths: ["uploads/火车票.pdf", "uploads/查验件.pdf"],
			applicationHint: "常州",
		});
	});

	it("当前轮次没有 URL 或附件时不采用弱模型猜测的旧输入", () => {
		expect(
			bindTravelDraftParams(
				{
					url: "https://app.ekuaibao.com/web/app.html?accessToken=stale#/billEntryDetail",
					paths: ["上一次行程.pdf"],
					applicationHint: "常州",
				},
				{ text: "继续", attachments: [] },
			),
		).toEqual({ url: undefined, paths: undefined, applicationHint: undefined });
	});

	it("当前轮次原文没有模型给出的申请线索时将其视为幻觉并丢弃", () => {
		expect(
			bindTravelDraftParams(
				{ applicationHint: "苏州 8月22日" },
				{ text: "请填常州 8月21日的出差报销", attachments: [] },
			),
		).toEqual({ url: undefined, paths: undefined, applicationHint: undefined });
	});

	it("安装版 OCR 脚本优先使用 app.asar.unpacked 物理路径", () => {
		const modulePath =
			process.platform === "win32"
				? "C:\\Program Files\\Pi\\resources\\app.asar\\packs\\travel-expense\\index.ts"
				: "/opt/Pi/resources/app.asar/packs/travel-expense/index.ts";
		const candidates = travelExpenseResourceCandidates(modulePath);
		expect(candidates[0]).toContain("app.asar.unpacked");
		expect(candidates[0]).toMatch(/pdf-ocr\.ps1$/);
	});

	it("同名但内容不同的查验附件持久化为不同短文件名", () => {
		const leftDir = join(packWorkspace, "same-name-left");
		const rightDir = join(packWorkspace, "same-name-right");
		mkdirSync(leftDir, { recursive: true });
		mkdirSync(rightDir, { recursive: true });
		const left = join(leftDir, "查验结果.pdf");
		const right = join(rightDir, "查验结果.pdf");
		writeFileSync(left, "verification-left");
		writeFileSync(right, "verification-right");
		const persisted = [
			durableAttachment(packWorkspace, left, "left"),
			durableAttachment(packWorkspace, right, "right"),
		];
		expect(new Set(persisted.map((file) => basename(file))).size).toBe(2);
		expect(persisted.every((file) => /^T[a-f0-9]{12}\.pdf$/.test(basename(file)))).toBe(true);
	});

	it("短摘要目标已存在但完整内容不同时拒绝覆盖或删除旧文件", () => {
		const source = join(attachmentFixtures, "durable-collision-source.pdf");
		writeFileSync(source, "original-source-content");
		const durable = durableAttachment(packWorkspace, source, "collision");
		writeFileSync(durable, "pre-existing-different-content");

		expect(() => durableAttachment(packWorkspace, source, "collision")).toThrow("拒绝覆盖");
		expect(readFileSync(durable, "utf8")).toBe("pre-existing-different-content");
	});

	it("内容相同的查验附件在浏览器操作前直接 fail closed", () => {
		const ticket = join(attachmentFixtures, "duplicate-verification-ticket.pdf");
		writeFileSync(ticket, buildEmbeddedRailwayPdf());
		const verificationText =
			"国家税务总局全国增值税发票查验平台 查验结果一致 查验时间 2026-08-22 发票号码 10000000000000000001";
		const first = join(attachmentFixtures, "duplicate-verification-a.pdf");
		const second = join(attachmentFixtures, "duplicate-verification-b.pdf");
		writeFileSync(first, verificationText);
		writeFileSync(second, verificationText);
		const result = readAndPairRailwayAttachments([ticket, first, second], packWorkspace, {
			ocrTravelDocument: (file) => {
				const text = readFileSync(file, "utf8");
				return { file, text, fingerprint: parseVerificationFingerprint(text) };
			},
		});

		expect(result.pairingStatus).toBe("ambiguous");
		expect(result.invoices[0].verificationFiles).toHaveLength(1);
		expect(result.unmatched).toHaveLength(1);
		expect(result.unmatched[0].reason).toContain("内容");
		expect(result.unmatched[0].reason).toContain("重复");
	});

	it("PNG/JPG 查验截图进入受限 OCR 配对而不被误当成铁路票据", () => {
		const screenshot = join(attachmentFixtures, "verification-screenshot.png");
		writeFileSync(
			screenshot,
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
				"base64",
			),
		);
		let observedTimeoutMs = 0;
		const result = readAndPairRailwayAttachments([screenshot], packWorkspace, {
			ocrTravelDocument: (file, timeoutMs) => {
				observedTimeoutMs = timeoutMs;
				return {
					file,
					text: "",
					fingerprint: { invoiceNumbers: [], trainNumbers: [], amounts: [] },
					error: "测试 OCR 未识别到配对标识",
				};
			},
		});
		expect(result.invoices).toEqual([]);
		expect(observedTimeoutMs).toBeGreaterThan(0);
		expect(observedTimeoutMs).toBeLessThanOrEqual(150_000);
		expect(result.ocrDocuments).toHaveLength(1);
		expect(result.ocrDocuments[0].file).toBe(screenshot);
		expect(result.unmatched).toHaveLength(1);
		expect(result.unmatched[0].reason).not.toContain("只支持 .ofd");
	});

	it("高层草稿工具在附件缺失时一次性停止且不打开浏览器", async () => {
		const output = await tool("travel_fill_draft").execute(
			"draft-missing",
			{
				url: "https://app.ekuaibao.com/web/app.html#/billEntryDetail",
				paths: [join(packWorkspace, "missing-ticket.pdf")],
				applicationHint: "常州8月21",
			},
			undefined,
			undefined,
			undefined as never,
		);
		const details = output.details as { status?: string; stage?: string; draftSaved?: boolean };
		expect(details).toMatchObject({ status: "needs_input", stage: "PRECHECK", draftSaved: false });
		expect((output.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("")).toContain(
			"未保存、未提交",
		);
	});

	it("住宿票据歧义或已有住宿件却缺少唯一主票时，在创建浏览器前停止", async () => {
		const readyRailway: InvoiceAttachmentResult = {
			invoices: [
				{
					source: "railway-ticket.pdf",
					uploadFile: "railway-ticket.pdf",
					trainNumber: "G7001",
					fromStation: "南京站",
					toStation: "常州站",
					fromCity: "南京",
					toCity: "常州",
					date: "2026-08-21",
					seatClass: "二等座",
					amount: 72,
					passenger: "苏爱健",
					invoiceNumber: "TEST-PRECHECK-RAIL-001",
					verificationFiles: ["railway-verification.pdf"],
					verificationStatus: "ready",
				},
			],
			pairingStatus: "ready",
			lodging: { status: "missing", candidates: [], issues: [], classifiedFiles: [] },
			ocrDocuments: [],
			missing: [],
			ambiguous: [],
			unmatched: [],
		};
		const cases: InvoiceAttachmentResult["lodging"][] = [
			{
				status: "ambiguous",
				candidates: [],
				issues: [
					{
						file: "hotel-conflict.pdf",
						kind: "ambiguous",
						reason: "住宿主发票字段冲突",
						invoiceNumbers: [],
						amounts: [],
					},
				],
				classifiedFiles: ["hotel-conflict.pdf"],
			},
			{
				status: "missing",
				candidates: [],
				issues: [
					{
						file: "hotel-related.pdf",
						kind: "missing",
						reason: "住宿相关附件缺少唯一票号或金额",
						invoiceNumbers: [],
						amounts: [],
					},
				],
				classifiedFiles: ["hotel-related.pdf"],
			},
		];

		for (const lodging of cases) {
			let driverCreations = 0;
			const output = await fillTravelDraft(
				{
					url: "https://app.ekuaibao.com/web/app.html#/billEntryDetail",
					paths: ["railway-ticket.pdf", "railway-verification.pdf", ...lodging.classifiedFiles],
				},
				packWorkspace,
				undefined,
				undefined,
				{
					readAttachments: () => ({ ...structuredClone(readyRailway), lodging: structuredClone(lodging) }),
					createDriver: () => {
						driverCreations += 1;
						throw new Error("browser driver must not be created");
					},
				},
			);
			const details = output.details as { status?: string; stage?: string; draftSaved?: boolean };
			expect(details).toMatchObject({ status: "needs_input", stage: "PRECHECK", draftSaved: false });
			expect(driverCreations).toBe(0);
		}
	});

	it("多日行程优先使用住宿发票明确的入住离店日期，而不是整段出差日期", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-travel-hotel-date-plan-test-"));
		const application: TravelDraftApplication = {
			id: "TEST-HOTEL-DATES-APPLICATION",
			title: "出差申请：常州多日支撑",
			reason: "常州多日支撑",
			startDate: "2026-08-20",
			endDate: "2026-08-23",
			expenseNature: "部门费用",
		};
		const ticket = (invoiceNumber: string, fromCity: string, toCity: string, date: string) => ({
			source: `${invoiceNumber}.pdf`,
			uploadFile: `${invoiceNumber}.pdf`,
			trainNumber: invoiceNumber.endsWith("1") ? "G7001" : "G7002",
			fromStation: `${fromCity}站`,
			toStation: `${toCity}站`,
			fromCity,
			toCity,
			date,
			seatClass: "二等座",
			amount: 72,
			passenger: "苏爱健",
			invoiceNumber,
			verificationFiles: [`${invoiceNumber}-verification.png`],
			verificationStatus: "ready" as const,
		});
		const attachments: InvoiceAttachmentResult = {
			invoices: [
				ticket("TEST-HOTEL-DATES-1", "南京", "常州", "2026-08-20"),
				ticket("TEST-HOTEL-DATES-2", "常州", "南京", "2026-08-23"),
			],
			pairingStatus: "ready",
			lodging: {
				status: "ready",
				invoice: {
					uploadFile: "hotel.pdf",
					invoiceNumber: "TEST-HOTEL-INVOICE-DATES",
					amount: 488,
					verificationFiles: [],
					checkinDate: "2026-08-21",
					checkoutDate: "2026-08-22",
				},
				candidates: [],
				issues: [],
				classifiedFiles: ["hotel.pdf"],
			},
			ocrDocuments: [],
			missing: [],
			ambiguous: [],
			unmatched: [],
		};
		let capturedPlan: TravelDraftPlan | undefined;
		try {
			const result = await fillTravelDraft(
				{ url: "https://app.ekuaibao.com/web/app.html#/billEntryDetail", paths: ["all-attachments.zip"] },
				cwd,
				undefined,
				undefined,
				{
					readAttachments: () => structuredClone(attachments),
					createDriver: () => {
						const driver = new SentinelWorkflowDriver(application, () => undefined);
						const precheck = driver.precheck.bind(driver);
						driver.precheck = async (plan, expected) => {
							capturedPlan = structuredClone(plan);
							return precheck(plan, expected);
						};
						return driver as unknown as TravelDraftBrowserDriver;
					},
				},
			);
			expect(result.details).toMatchObject({ status: "done", stage: "DONE", draftSaved: true });
			expect(capturedPlan?.hotel).toMatchObject({
				checkinDate: "2026-08-21",
				checkoutDate: "2026-08-22",
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("同一行程跨调用和进程重建命中持久化保存意图，新行程不受影响且记录不含敏感值", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-travel-save-intent-test-"));
		const application: TravelDraftApplication = {
			id: "TEST-APPLICATION-001",
			title: "测试出差申请",
			reason: "测试业务事由",
			startDate: "2026-08-21",
			endDate: "2026-08-21",
			expenseNature: "部门费用",
		};
		const attachments: InvoiceAttachmentResult = {
			invoices: [
				{
					source: "C:\\private\\original-secret-ticket.pdf",
					uploadFile: "C:\\private\\original-secret-ticket.pdf",
					trainNumber: "G7001",
					fromStation: "南京站",
					toStation: "常州站",
					fromCity: "南京",
					toCity: "常州",
					date: "2026-08-21",
					seatClass: "二等座",
					amount: 72,
					passenger: "苏爱健",
					invoiceNumber: "TEST-SAVE-INTENT-INVOICE-001",
					verificationFiles: ["C:\\private\\original-secret-verification.png"],
					verificationStatus: "ready",
				},
			],
			pairingStatus: "ready",
			lodging: { status: "missing", candidates: [], issues: [], classifiedFiles: [] },
			ocrDocuments: [],
			missing: [],
			ambiguous: [],
			unmatched: [],
		};
		let saveClicks = 0;
		const dependencies = (selectedApplication: TravelDraftApplication, parsed = attachments) => ({
			readAttachments: () => structuredClone(parsed),
			createDriver: () =>
				new SentinelWorkflowDriver(selectedApplication, () => {
					saveClicks += 1;
				}) as unknown as TravelDraftBrowserDriver,
		});

		try {
			const first = await fillTravelDraft(
				{
					url: "https://app.ekuaibao.com/web/app.html?accessToken=first-secret#/billEntryDetail",
					paths: ["C:\\private\\original-secret-ticket.pdf"],
				},
				cwd,
				undefined,
				undefined,
				dependencies(application),
			);
			expect(first.details).toMatchObject({ status: "done", stage: "DONE", draftSaved: true });
			expect(saveClicks).toBe(1);

			const intentDirectory = join(cwd, ".pi", "travel-expense");
			const intentFiles = readdirSync(intentDirectory);
			expect(intentFiles).toHaveLength(2);
			const intentFile = intentFiles.find((file) => /^save-intent-[a-f0-9]{64}\.json$/.test(file));
			const checkpointFile = intentFiles.find((file) => /^checkpoint-[a-f0-9]{64}\.json$/.test(file));
			expect(intentFile).toBeDefined();
			expect(checkpointFile).toBeDefined();
			const intentContent = readFileSync(join(intentDirectory, intentFile!), "utf8");
			const checkpointContent = readFileSync(join(intentDirectory, checkpointFile!), "utf8");
			expect(intentContent).not.toContain("accessToken");
			expect(intentContent).not.toContain("original-secret");
			expect(intentContent).not.toContain(application.id);
			expect(intentContent).not.toContain("TEST-SAVE-INTENT-INVOICE-001");
			expect(checkpointContent).not.toContain("accessToken");
			expect(checkpointContent).not.toContain("original-secret");
			expect(checkpointContent).not.toContain(application.id);
			expect(checkpointContent).not.toContain("TEST-SAVE-INTENT-INVOICE-001");

			const renamedAttachments = structuredClone(attachments);
			renamedAttachments.invoices[0].source = "D:\\renamed\\second-private-ticket.pdf";
			renamedAttachments.invoices[0].uploadFile = "D:\\renamed\\second-private-ticket.pdf";
			renamedAttachments.invoices[0].verificationFiles = ["D:\\renamed\\second-private-check.png"];
			const rebuiltProcessCall = await fillTravelDraft(
				{
					url: "https://app.ekuaibao.com/web/app.html?accessToken=second-secret#/billEntryDetail",
					paths: ["D:\\renamed\\second-private-ticket.pdf"],
				},
				cwd,
				undefined,
				undefined,
				dependencies(structuredClone(application), renamedAttachments),
			);
			expect(rebuiltProcessCall.details).toMatchObject({
				status: "done",
				stage: "DONE",
				draftSaved: true,
				alreadySaved: true,
			});
			expect(saveClicks).toBe(1);

			const newApplication = { ...application, id: "TEST-APPLICATION-002" };
			const newTrip = await fillTravelDraft(
				{
					url: "https://app.ekuaibao.com/web/app.html?accessToken=third-secret#/billEntryDetail",
					paths: ["D:\\renamed\\second-private-ticket.pdf"],
				},
				cwd,
				undefined,
				undefined,
				dependencies(newApplication, renamedAttachments),
			);
			expect(newTrip.details).toMatchObject({ status: "done", stage: "DONE", draftSaved: true });
			expect(saveClicks).toBe(2);
			expect(readdirSync(intentDirectory)).toHaveLength(4);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("草稿点击前失败会从持久化 prepared 断点恢复，且最终只派发一次保存", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-travel-prepared-checkpoint-test-"));
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-23T08:00:00+08:00"));
		const application: TravelDraftApplication = {
			id: "TEST-PREPARED-CHECKPOINT-APPLICATION",
			title: "出差申请：常州断点恢复",
			reason: "常州断点恢复",
			startDate: "2026-08-21",
			endDate: "2026-08-21",
			expenseNature: "部门费用",
		};
		const attachments: InvoiceAttachmentResult = {
			invoices: [
				{
					source: "checkpoint-ticket.pdf",
					uploadFile: "checkpoint-ticket.pdf",
					trainNumber: "G7001",
					fromStation: "南京站",
					toStation: "常州站",
					fromCity: "南京",
					toCity: "常州",
					date: "2026-08-21",
					seatClass: "二等座",
					amount: 72,
					passenger: "苏爱健",
					invoiceNumber: "TEST-PREPARED-CHECKPOINT-INVOICE",
					verificationFiles: ["checkpoint-verification.png"],
					verificationStatus: "ready",
				},
			],
			pairingStatus: "ready",
			lodging: { status: "missing", candidates: [], issues: [], classifiedFiles: [] },
			ocrDocuments: [],
			missing: [],
			ambiguous: [],
			unmatched: [],
		};
		let saveClicks = 0;
		class RetryableSentinelDriver extends SentinelWorkflowDriver {
			private failBeforeDispatch = true;

			override async saveDraft(
				expected: TravelDraftExpected,
				onDispatch?: () => void | Promise<void>,
			): Promise<TravelDraftObservation> {
				if (this.failBeforeDispatch) {
					this.failBeforeDispatch = false;
					throw new Error("保存按钮尚未派发前页面短暂失效");
				}
				return super.saveDraft(expected, onDispatch);
			}
		}
		const driver = new RetryableSentinelDriver(application, () => {
			saveClicks += 1;
		});
		const dependencies = {
			readAttachments: () => structuredClone(attachments),
			createDriver: () => driver as unknown as TravelDraftBrowserDriver,
		};
		try {
			const first = await fillTravelDraft(
				{ url: "https://app.ekuaibao.com/web/app.html#/billEntryDetail", paths: ["checkpoint-ticket.pdf"] },
				cwd,
				undefined,
				undefined,
				dependencies,
			);
			expect(first.details).toMatchObject({
				status: "blocked",
				stage: "SAVE_DRAFT",
				draftSaveRequested: false,
				draftSaveStateUncertain: false,
			});
			expect(saveClicks).toBe(0);
			const recoveryDirectory = join(cwd, ".pi", "travel-expense");
			expect(readdirSync(recoveryDirectory)).toEqual([expect.stringMatching(/^checkpoint-[a-f0-9]{64}\.json$/)]);

			vi.setSystemTime(new Date("2026-08-24T08:00:00+08:00"));
			const resumed = await fillTravelDraft(
				// Recovery occurs after local midnight. The persisted reimbursement
				// date must remain part of the original plan instead of invalidating it.
				{ url: "https://app.ekuaibao.com/web/app.html#/billEntryDetail", paths: ["checkpoint-ticket.pdf"] },
				cwd,
				undefined,
				undefined,
				dependencies,
			);
			expect(resumed.details).toMatchObject({ status: "done", stage: "DONE", draftSaved: true });
			expect(saveClicks).toBe(1);
			expect(readdirSync(recoveryDirectory)).toEqual([
				expect.stringMatching(/^checkpoint-[a-f0-9]{64}\.json$/),
				expect.stringMatching(/^save-intent-[a-f0-9]{64}\.json$/),
			]);
		} finally {
			vi.useRealTimers();
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("同一行程并发调用只有一个流程可运行，且进度监听异常不影响唯一保存", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-travel-concurrency-test-"));
		const application: TravelDraftApplication = {
			id: "TEST-CONCURRENT-APPLICATION",
			title: "出差申请：常州并发保护",
			reason: "常州并发保护",
			startDate: "2026-08-21",
			endDate: "2026-08-21",
			expenseNature: "部门费用",
		};
		const attachments: InvoiceAttachmentResult = {
			invoices: [
				{
					source: "concurrent-ticket.pdf",
					uploadFile: "concurrent-ticket.pdf",
					trainNumber: "G7001",
					fromStation: "南京站",
					toStation: "常州站",
					fromCity: "南京",
					toCity: "常州",
					date: "2026-08-21",
					seatClass: "二等座",
					amount: 72,
					passenger: "苏爱健",
					invoiceNumber: "TEST-CONCURRENT-INVOICE",
					verificationFiles: ["concurrent-verification.png"],
					verificationStatus: "ready",
				},
			],
			pairingStatus: "ready",
			lodging: { status: "missing", candidates: [], issues: [], classifiedFiles: [] },
			ocrDocuments: [],
			missing: [],
			ambiguous: [],
			unmatched: [],
		};
		let signalFirstEntered: (() => void) | undefined;
		let releaseBlockedDriver: (() => void) | undefined;
		const firstEntered = new Promise<void>((resolve) => {
			signalFirstEntered = resolve;
		});
		const releaseFirst = new Promise<void>((resolve) => {
			releaseBlockedDriver = resolve;
		});
		let driverIndex = 0;
		let saveClicks = 0;
		class BlockingDriver extends SentinelWorkflowDriver {
			private readonly shouldBlock: boolean;

			constructor(shouldBlock: boolean) {
				super(application, () => {
					saveClicks += 1;
				});
				this.shouldBlock = shouldBlock;
			}

			override async precheck(plan: TravelDraftPlan, expected: TravelDraftExpected) {
				if (this.shouldBlock) {
					signalFirstEntered?.();
					await releaseFirst;
				}
				return super.precheck(plan, expected);
			}
		}
		const dependencies = {
			readAttachments: () => structuredClone(attachments),
			createDriver: () => new BlockingDriver(driverIndex++ === 0) as unknown as TravelDraftBrowserDriver,
		};
		try {
			const first = fillTravelDraft(
				{ url: "https://app.ekuaibao.com/web/app.html#/billEntryDetail", paths: ["concurrent-ticket.pdf"] },
				cwd,
				undefined,
				() => {
					throw new Error("UI progress listener failed");
				},
				dependencies,
			);
			await firstEntered;
			const second = await fillTravelDraft(
				{ url: "https://app.ekuaibao.com/web/app.html#/billEntryDetail", paths: ["concurrent-ticket.pdf"] },
				cwd,
				undefined,
				undefined,
				dependencies,
			);
			expect(second.details).toMatchObject({ status: "blocked", stage: "PRECHECK", draftSaved: false });
			expect(saveClicks).toBe(0);
			releaseBlockedDriver?.();
			const firstResult = await first;
			expect(firstResult.details).toMatchObject({ status: "done", stage: "DONE", draftSaved: true });
			expect(saveClicks).toBe(1);
		} finally {
			releaseBlockedDriver?.();
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("保存意图写入失败时在调用保存驱动前 fail closed", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-travel-save-intent-failure-test-"));
		const application: TravelDraftApplication = {
			id: "TEST-APPLICATION-WRITE-FAILURE",
			title: "测试出差申请",
			reason: "测试业务事由",
			startDate: "2026-08-21",
			endDate: "2026-08-21",
			expenseNature: "部门费用",
		};
		const attachments: InvoiceAttachmentResult = {
			invoices: [
				{
					source: "ticket.pdf",
					uploadFile: "ticket.pdf",
					trainNumber: "G7001",
					fromStation: "南京站",
					toStation: "常州站",
					fromCity: "南京",
					toCity: "常州",
					date: "2026-08-21",
					seatClass: "二等座",
					amount: 72,
					passenger: "苏爱健",
					invoiceNumber: "TEST-SAVE-INTENT-WRITE-FAILURE",
					verificationFiles: ["verification.png"],
					verificationStatus: "ready",
				},
			],
			pairingStatus: "ready",
			lodging: { status: "missing", candidates: [], issues: [], classifiedFiles: [] },
			ocrDocuments: [],
			missing: [],
			ambiguous: [],
			unmatched: [],
		};
		let saveClicks = 0;
		let sabotaged = false;

		try {
			const output = await fillTravelDraft(
				{ url: "https://app.ekuaibao.com/example", paths: ["ticket.pdf"] },
				cwd,
				undefined,
				undefined,
				{
					readAttachments: () => structuredClone(attachments),
					createDriver: () =>
						new SentinelWorkflowDriver(
							application,
							() => {
								saveClicks += 1;
							},
							() => {
								if (sabotaged) return;
								sabotaged = true;
								const recoveryDirectory = join(cwd, ".pi", "travel-expense");
								rmSync(recoveryDirectory, { recursive: true, force: true });
								writeFileSync(recoveryDirectory, "not-a-directory", "utf8");
							},
						) as unknown as TravelDraftBrowserDriver,
				},
			);
			expect(output.details).toMatchObject({
				status: "blocked",
				stage: "SAVE_DRAFT",
				draftSaved: false,
				draftSaveStateUncertain: false,
				draftSaveRequested: false,
			});
			expect(saveClicks).toBe(0);
			expect((output.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("\n")).toContain(
				"保存派发状态无法持久化",
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("高层草稿工具缺少链接和附件时一次性 needs_input 且零浏览器动作", async () => {
		const output = await tool("travel_fill_draft").execute(
			"draft-missing-inputs",
			{},
			undefined,
			undefined,
			undefined as never,
		);
		const details = output.details as {
			status?: string;
			stage?: string;
			missing?: Array<{ code?: string }>;
			draftSaved?: boolean;
		};
		expect(details).toMatchObject({ status: "needs_input", stage: "PRECHECK", draftSaved: false });
		expect(details.missing?.map((issue) => issue.code)).toEqual(["missing_url", "missing_attachments"]);
	});

	it("拒绝超过单批上限的附件，避免弱模型触发无界 OCR", () => {
		expect(() =>
			readAndPairRailwayAttachments(
				Array.from({ length: 21 }, (_, index) => join(packWorkspace, `missing-${index}.pdf`)),
				packWorkspace,
			),
		).toThrow("一次最多 20 个");
	});

	it.runIf(process.platform === "win32")(
		"跨多个压缩包共享 50MB 解压预算",
		() => {
			const tar = join(process.env.SystemRoot ?? process.env.WINDIR ?? "", "System32", "tar.exe");
			const archives: string[] = [];
			for (let index = 0; index < 2; index++) {
				const source = join(packWorkspace, `large-archive-${index}`);
				mkdirSync(source, { recursive: true });
				writeFileSync(join(source, "payload.bin"), Buffer.alloc(26 * 1024 * 1024));
				const archive = join(packWorkspace, `large-archive-${index}.zip`);
				execFileSync(tar, ["-a", "-cf", archive, "payload.bin"], {
					cwd: source,
					windowsHide: true,
					timeout: 30_000,
				});
				rmSync(source, { recursive: true, force: true });
				archives.push(archive);
			}
			const result = readAndPairRailwayAttachments(archives, packWorkspace);
			expect(result.invoices.some((invoice) => invoice.error?.includes("累计解压量超过 50MB"))).toBe(true);
		},
		60_000,
	);

	it("规则速查包含固定取值与安全红线", async () => {
		const output = await tool("travel_reimbursement_guide").execute(
			"g1",
			{},
			undefined,
			undefined,
			undefined as never,
		);
		const text = (output.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("");
		expect(text).toContain("江苏省南京");
		expect(text).toContain("180 元/天");
		expect(text).toContain("其他省份");
		expect(text).toContain("苏爱健");
		expect(text).toContain("template-feeType-item");
		expect(text).toContain("feetype-footer-save");
		expect(text).toContain("对应查验截图");
		expect(text).toContain("存为草稿");
		expect(text).toContain("不要点击 提交送审");
	});

	it("当天往返：交通逐程 + 补贴，不生成住宿费", async () => {
		const output = await tool("travel_plan_details").execute(
			"p1",
			{
				tripTitle: "出差申请：常州业务拓展",
				startDate: "2026-08-21",
				endDate: "2026-08-21",
				legs: [
					{
						from: "南京",
						to: "常州",
						date: "2026-08-21",
						seatClass: "二等座",
						amount: 72,
						passenger: "苏爱健",
						invoiceNumber: "A1",
						...attachmentsFor("A1"),
					},
					{
						from: "常州",
						to: "南京",
						date: "2026-08-21",
						seatClass: "二等座",
						amount: 75,
						passenger: "苏爱健",
						invoiceNumber: "A2",
						...attachmentsFor("A2"),
					},
				],
			},
			undefined,
			undefined,
			undefined as never,
		);
		const text = (output.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("");
		expect(text).toContain("1 天");
		expect(text).toContain("不添加住宿费");
		expect((text.match(/城市交通费/g) ?? []).length).toBeGreaterThanOrEqual(2);
		expect(text).toContain("出差补助");
		expect(text).toContain("180");
		const rows = (output.details as { rows?: Array<Record<string, unknown>> }).rows ?? [];
		expect(rows[0]).toMatchObject({
			invoiceNumber: "A1",
			passenger: "苏爱健",
			乘车日期: "2026-08-21",
			起止日期: "2026-08-21 至 2026-08-21",
		});
		expect(String(rows[0].uploadFile)).toContain("A1-ticket.pdf");
		expect((rows[0].verificationFiles as string[])[0]).toContain("A1-verification.png");
	});

	it("反序输入往返票时仍逐程保留发票号、乘车人与对应附件", async () => {
		const output = await tool("travel_plan_details").execute(
			"p-reversed",
			{
				startDate: "2026-08-21",
				endDate: "2026-08-21",
				legs: [
					{
						from: "常州",
						to: "南京",
						date: "2026-08-21",
						seatClass: "二等座",
						amount: 75,
						passenger: "苏爱健",
						invoiceNumber: "REV-RETURN",
						...attachmentsFor("REV-RETURN"),
					},
					{
						from: "南京",
						to: "常州",
						date: "2026-08-21",
						seatClass: "二等座",
						amount: 72,
						passenger: "苏爱健",
						invoiceNumber: "REV-OUTBOUND",
						...attachmentsFor("REV-OUTBOUND"),
					},
				],
			},
			undefined,
			undefined,
			undefined as never,
		);
		const rows = (output.details as { rows?: Array<Record<string, unknown>> }).rows ?? [];
		expect(rows.slice(0, 2).map((row) => row.invoiceNumber)).toEqual(["REV-RETURN", "REV-OUTBOUND"]);
		expect(rows.slice(0, 2).map((row) => row.乘车人)).toEqual(["苏爱健", "苏爱健"]);
		expect(String(rows[0].uploadFile)).toContain("REV-RETURN-ticket.pdf");
		expect(String(rows[1].uploadFile)).toContain("REV-OUTBOUND-ticket.pdf");
		expect((rows[0].verificationFiles as string[])[0]).toContain("REV-RETURN-verification.png");
		expect((rows[1].verificationFiles as string[])[0]).toContain("REV-OUTBOUND-verification.png");
	});

	it("多天出差：交通 + 住宿 + 按天补贴", async () => {
		const output = await tool("travel_plan_details").execute(
			"p2",
			{
				startDate: "2026-08-20",
				endDate: "2026-08-22",
				legs: [
					{
						from: "南京",
						to: "苏州",
						date: "2026-08-20",
						seatClass: "二等座",
						amount: 100,
						passenger: "苏爱健",
						invoiceNumber: "B1",
						...attachmentsFor("B1"),
					},
					{
						from: "苏州",
						to: "南京",
						date: "2026-08-22",
						seatClass: "二等座",
						amount: 100,
						passenger: "苏爱健",
						invoiceNumber: "B2",
						...attachmentsFor("B2"),
					},
				],
				hotel: {
					amount: 320,
					checkin: "2026-08-20",
					checkout: "2026-08-22",
					...hotelAttachmentsFor("B-HOTEL"),
				},
			},
			undefined,
			undefined,
			undefined as never,
		);
		const text = (output.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("");
		expect(text).toContain("3 天");
		expect(text).toContain("住宿费");
		expect(text).toContain("其他省份");
		const rows = (output.details as { rows?: Array<Record<string, unknown>> }).rows ?? [];
		expect(rows.slice(0, 2).map((row) => row.起止日期)).toEqual([
			"2026-08-20 至 2026-08-22",
			"2026-08-20 至 2026-08-22",
		]);
		expect(rows.slice(0, 2).map((row) => row.乘车日期)).toEqual(["2026-08-20", "2026-08-22"]);
		const hotelRow = rows.find((row) => row.kind === "住宿费");
		expect(String(hotelRow?.uploadFile)).toContain("B-HOTEL-hotel-invoice.pdf");
		expect((hotelRow?.verificationFiles as string[])[0]).toContain("B-HOTEL-hotel-verification.png");
	});

	it("多天住宿费强制绑定独立住宿发票并保留可选查验附件", async () => {
		const legAttachments = attachmentsFor("HOTEL-LEG");
		const base = {
			startDate: "2026-08-20",
			endDate: "2026-08-22",
			legs: [
				{
					from: "南京",
					to: "苏州",
					date: "2026-08-20",
					seatClass: "二等座",
					amount: 100,
					passenger: "苏爱健",
					invoiceNumber: "HOTEL-LEG",
					...legAttachments,
				},
			],
		};
		const plan = (hotel: Record<string, unknown>) =>
			tool("travel_plan_details").execute(
				"hotel-attachments",
				{ ...base, hotel },
				undefined,
				undefined,
				undefined as never,
			);
		await expect(
			plan({ amount: 320, checkin: "2026-08-20", checkout: "2026-08-22", uploadFile: "", verificationFiles: [] }),
		).rejects.toThrow(/住宿发票.*缺少文件路径/);
		await expect(
			plan({
				amount: 320,
				checkin: "2026-08-20",
				checkout: "2026-08-22",
				uploadFile: hotelAttachmentsFor("MISSING-FIELD").uploadFile,
			}),
		).rejects.toThrow(/住宿查验附件字段缺失/);
		await expect(
			plan({
				amount: 320,
				checkin: "2026-08-20",
				checkout: "2026-08-22",
				uploadFile: legAttachments.uploadFile,
				verificationFiles: [],
			}),
		).rejects.toThrow(/住宿发票.*重复绑定/);
		await expect(
			plan({
				amount: 320,
				checkin: "2026-08-20",
				checkout: "2026-08-22",
				...hotelAttachmentsFor("REUSED-VERIFY"),
				verificationFiles: [legAttachments.verificationFiles[0]],
			}),
		).rejects.toThrow(/住宿查验附件.*重复绑定/);
		const hotelWithoutVerification = hotelAttachmentsFor("NO-HOTEL-VERIFY");
		const output = await plan({
			amount: 320,
			checkin: "2026-08-20",
			checkout: "2026-08-22",
			uploadFile: hotelWithoutVerification.uploadFile,
			verificationFiles: [],
		});
		const rows = (output.details as { rows?: Array<Record<string, unknown>> }).rows ?? [];
		const hotelRow = rows.find((row) => row.kind === "住宿费");
		expect(hotelRow?.verificationFiles).toEqual([]);
	});

	it("多天出差缺住宿费时报错提醒", async () => {
		await expect(
			tool("travel_plan_details").execute(
				"p3",
				{
					startDate: "2026-08-20",
					endDate: "2026-08-22",
					legs: [
						{
							from: "南京",
							to: "苏州",
							date: "2026-08-20",
							seatClass: "二等座",
							amount: 100,
							passenger: "苏爱健",
							invoiceNumber: "C1",
							...attachmentsFor("C1"),
						},
					],
				},
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow(/住宿费/);
	});

	it("非法日期区间报错", async () => {
		await expect(
			tool("travel_plan_details").execute(
				"p4",
				{
					startDate: "2026-08-22",
					endDate: "2026-08-20",
					legs: [
						{
							from: "南京",
							to: "苏州",
							date: "2026-08-22",
							seatClass: "二等座",
							amount: 100,
							passenger: "苏爱健",
							invoiceNumber: "D1",
							...attachmentsFor("D1"),
						},
					],
				},
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow(/日期不合法/);
	});

	it("拒绝不存在的日期、范围外行程和非正金额", async () => {
		const base = {
			startDate: "2026-08-21",
			endDate: "2026-08-21",
			legs: [
				{
					from: "南京",
					to: "常州",
					date: "2026-08-21",
					seatClass: "二等座",
					amount: 72,
					passenger: "苏爱健",
					invoiceNumber: "E1",
					...attachmentsFor("E1"),
				},
			],
		};
		await expect(
			tool("travel_plan_details").execute(
				"v1",
				{ ...base, startDate: "2026-02-30" },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow(/日期不合法/);
		await expect(
			tool("travel_plan_details").execute(
				"v2",
				{ ...base, legs: [{ ...base.legs[0], date: "2026-08-20" }] },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow(/不在出差申请范围/);
		await expect(
			tool("travel_plan_details").execute(
				"v3",
				{ ...base, legs: [{ ...base.legs[0], amount: 0 }] },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow(/大于 0/);
	});

	it("拒绝重复发票与非当前用户乘车票，补助标准不可覆盖", async () => {
		const first = {
			from: "南京",
			to: "常州",
			date: "2026-08-21",
			seatClass: "二等座",
			amount: 72,
			passenger: "苏爱健",
			invoiceNumber: "F1",
			...attachmentsFor("F1"),
		};
		await expect(
			tool("travel_plan_details").execute(
				"v4",
				{ startDate: "2026-08-21", endDate: "2026-08-21", legs: [first, { ...first, from: "常州", to: "南京" }] },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow(/重复票据/);
		await expect(
			tool("travel_plan_details").execute(
				"v5",
				{
					startDate: "2026-08-21",
					endDate: "2026-08-21",
					legs: [first, { ...first, from: "常州", to: "南京", passenger: "其他人", invoiceNumber: "F2" }],
				},
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow(/乘车人必须为当前用户苏爱健/);
		await expect(
			tool("travel_plan_details").execute(
				"v5-same-other",
				{
					startDate: "2026-08-21",
					endDate: "2026-08-21",
					legs: [
						{ ...first, passenger: "其他人", invoiceNumber: "OTHER-1", ...attachmentsFor("OTHER-1") },
						{
							...first,
							from: "常州",
							to: "南京",
							passenger: "其他人",
							invoiceNumber: "OTHER-2",
							...attachmentsFor("OTHER-2"),
						},
					],
				},
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow(/乘车人必须为当前用户苏爱健/);
		const output = await tool("travel_plan_details").execute(
			"v6",
			{ startDate: "2026-08-21", endDate: "2026-08-21", legs: [first], allowancePerDay: 999 },
			undefined,
			undefined,
			undefined as never,
		);
		const text = (output.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("");
		expect(text).toContain("1 天 × ¥180");
		expect(text).not.toContain("999");
	});

	it("缺少、丢失或跨行重复绑定票据附件时拒绝生成计划", async () => {
		const baseLeg = {
			from: "南京",
			to: "常州",
			date: "2026-08-21",
			seatClass: "二等座",
			amount: 72,
			passenger: "苏爱健",
			invoiceNumber: "ATT-1",
			...attachmentsFor("ATT-1"),
		};
		const plan = (legs: Array<Record<string, unknown>>) =>
			tool("travel_plan_details").execute(
				"attachments",
				{ startDate: "2026-08-21", endDate: "2026-08-21", legs },
				undefined,
				undefined,
				undefined as never,
			);
		await expect(plan([{ ...baseLeg, uploadFile: "" }])).rejects.toThrow(/电子客票.*缺少文件路径/);
		await expect(plan([{ ...baseLeg, verificationFiles: [] }])).rejects.toThrow(/缺少对应的火车票查验附件/);
		await expect(plan([{ ...baseLeg, uploadFile: join(packWorkspace, "missing.pdf") }])).rejects.toThrow(
			/文件不存在/,
		);
		await expect(
			plan([
				baseLeg,
				{
					...baseLeg,
					from: "常州",
					to: "南京",
					invoiceNumber: "ATT-2",
					verificationFiles: attachmentsFor("ATT-2").verificationFiles,
				},
			]),
		).rejects.toThrow(/电子客票.*重复绑定/);
	});

	it("直接从铁路电子客票 PDF 的 FlateDecode EmbeddedFiles 提取 XBRL", async () => {
		const pdf = buildEmbeddedRailwayPdf();
		const embedded = extractRailwayEmbeddedXml(pdf);
		expect(embedded).toHaveLength(1);
		expect(embedded[0].name).toBe("rai_issuer_10000000000000000001.xml");
		expect(embedded[0].xml).toContain("<rail:TrainNumber>G7575</rail:TrainNumber>");
		expect(() => extractRailwayEmbeddedXml(pdf, { maxTotalEmbeddedBytes: 32 })).toThrow("累计解压后超过");

		const ticketPath = join(attachmentFixtures, "direct-railway-ticket.pdf");
		writeFileSync(ticketPath, pdf);
		const output = await tool("travel_read_invoices").execute(
			"pdf-ticket",
			{ paths: [ticketPath] },
			undefined,
			undefined,
			undefined as never,
		);
		const details = output.details as {
			pairingStatus?: string;
			invoices?: Array<Record<string, unknown>>;
			missing?: Array<Record<string, unknown>>;
		};
		expect(details.pairingStatus).toBe("missing");
		expect(details.invoices).toHaveLength(1);
		expect(details.invoices?.[0]).toMatchObject({
			invoiceNumber: "10000000000000000001",
			trainNumber: "G7575",
			fromStation: "南京南站",
			toStation: "常州站",
			fromCity: "南京",
			toCity: "常州",
			amount: 72,
			passenger: "苏爱健",
			verificationFiles: [],
			verificationStatus: "missing",
		});
		expect(details.missing).toHaveLength(1);
		expect(String(details.invoices?.[0].uploadFile)).toMatch(/\.pdf$/);
		expect(readFileSync(String(details.invoices?.[0].uploadFile))).toEqual(pdf);

		const direct = readAndPairRailwayAttachments([ticketPath], packWorkspace);
		expect(direct.pairingStatus).toBe("missing");
		expect(direct.invoices[0]).toMatchObject({
			invoiceNumber: "10000000000000000001",
			trainNumber: "G7575",
			verificationStatus: "missing",
		});
	});

	it("只沿唯一 Catalog 的 EmbeddedFiles 名称树读取 Filespec，支持有界 Kids 节点", () => {
		const pdf = buildTestPdf([
			[1, "<< /Type /Catalog /Names 2 0 R >>"],
			[2, "<< /EmbeddedFiles 3 0 R >>"],
			[3, "<< /Kids [4 0 R] >>"],
			[4, "<< /Names [(rai_issuer_10000000000000000001.xml) 5 0 R] >>"],
			[
				5,
				"<< /Type /Filespec /F (rai_issuer_10000000000000000001.xml) /UF (rai_issuer_10000000000000000001.xml) /EF << /F 6 0 R /UF 6 0 R >> >>",
			],
			[6, embeddedXmlStream()],
		]);
		const embedded = extractRailwayEmbeddedXml(pdf);
		expect(embedded).toHaveLength(1);
		expect(embedded[0]).toMatchObject({
			name: "rai_issuer_10000000000000000001.xml",
			objectRef: "6 0",
		});
	});

	it("忽略不在 Catalog 名称树中的孤立 Filespec，不读取旧增量对象", () => {
		const pdf = buildTestPdf([
			[1, "<< /Type /Catalog >>"],
			[2, "<< /EmbeddedFiles 3 0 R >>"],
			[3, "<< /Type /Filespec /F (rai_issuer_10000000000000000001.xml) /EF << /F 4 0 R >> >>"],
			[4, embeddedXmlStream()],
		]);
		expect(extractRailwayEmbeddedXml(pdf)).toEqual([]);
	});

	it("多 Catalog、名称树循环或非 Filespec→EmbeddedFile 链路均 fail closed", () => {
		const multipleCatalogs = buildTestPdf([
			[1, "<< /Type /Catalog /Names << /EmbeddedFiles << /Names [] >> >> >>"],
			[2, "<< /Type /Catalog >>"],
		]);
		expect(() => extractRailwayEmbeddedXml(multipleCatalogs)).toThrow("唯一 Catalog");

		const cycle = buildTestPdf([
			[1, "<< /Type /Catalog /Names << /EmbeddedFiles 2 0 R >> >>"],
			[2, "<< /Kids [2 0 R] >>"],
		]);
		expect(() => extractRailwayEmbeddedXml(cycle)).toThrow("循环引用");

		const unresolvedTree = buildTestPdf([[1, "<< /Type /Catalog /Names << /EmbeddedFiles 99 0 R >> >>"]]);
		expect(() => extractRailwayEmbeddedXml(unresolvedTree)).toThrow("不存在或非字典对象");

		const wrongFilespecType = buildTestPdf([
			[1, "<< /Type /Catalog /Names << /EmbeddedFiles 2 0 R >> >>"],
			[2, "<< /Names [(rai_issuer_10000000000000000001.xml) 3 0 R] >>"],
			[3, "<< /Type /NotFilespec /F (rai_issuer_10000000000000000001.xml) /EF << /F 4 0 R >> >>"],
			[4, embeddedXmlStream()],
		]);
		expect(() => extractRailwayEmbeddedXml(wrongFilespecType)).toThrow("不是 /Type /Filespec");

		const wrongEmbeddedType = buildTestPdf([
			[1, "<< /Type /Catalog /Names << /EmbeddedFiles 2 0 R >> >>"],
			[2, "<< /Names [(rai_issuer_10000000000000000001.xml) 3 0 R] >>"],
			[3, "<< /Type /Filespec /F (rai_issuer_10000000000000000001.xml) /EF << /F 4 0 R >> >>"],
			[4, embeddedXmlStream(fakeRailwayXbrl(), "NotEmbeddedFile")],
		]);
		expect(() => extractRailwayEmbeddedXml(wrongEmbeddedType)).toThrow("不是 /Type /EmbeddedFile");
	});

	it("OCR 文本须有明确查验证据，再按发票号或车次加金额唯一配对", () => {
		const invoices = [
			{ invoiceNumber: "10000000000000000001", trainNumber: "G7575", amount: 72 },
			{ invoiceNumber: "10000000000000000002", trainNumber: "G7018", amount: 75 },
		];
		const outbound = parseVerificationFingerprint(
			"全国增值税发票查验平台 发 票 号 码：1000 0000 0000 0000 0001 车次 G 7575 价税合计 ¥72.00",
		);
		const returnTrip = parseVerificationFingerprint("铁路电子客票查验 车次 G7018 发票金额 75.00 元");
		expect(outbound).toMatchObject({
			invoiceNumbers: ["10000000000000000001"],
			trainNumbers: ["G7575"],
			amounts: [72],
		});
		const pairing = matchVerificationFiles(invoices, [
			{ file: "查验-去程.pdf", fingerprint: outbound },
			{ file: "查验-回程.pdf", fingerprint: returnTrip },
		]);
		expect(pairing.verificationFilesByInvoice).toEqual([["查验-去程.pdf"], ["查验-回程.pdf"]]);
		expect(pairing.missingInvoiceIndexes).toEqual([]);
		expect(pairing.ambiguous).toEqual([]);
		expect(pairing.unmatched).toEqual([]);

		const amountOnly = matchVerificationFiles(invoices, [
			{
				file: "G7575-看似匹配但不可猜.pdf",
				fingerprint: parseVerificationFingerprint("发票查验结果 金额 ¥72.00"),
			},
		]);
		expect(amountOnly.verificationFilesByInvoice).toEqual([[], []]);
		expect(amountOnly.missingInvoiceIndexes).toEqual([0, 1]);
		expect(amountOnly.unmatched[0].reason).toContain("车次与金额");
	});

	it("查验 OCR 同时匹配多张票时返回 AMBIGUOUS，不自动绑定", () => {
		const pairing = matchVerificationFiles(
			[
				{ invoiceNumber: "TICKET-A", trainNumber: "G7001", amount: 70 },
				{ invoiceNumber: "TICKET-B", trainNumber: "G7001", amount: 70 },
			],
			[
				{
					file: "multi.pdf",
					fingerprint: parseVerificationFingerprint("全国增值税发票查验平台 车次 G7001 票价 70.00"),
				},
			],
		);
		expect(pairing.verificationFilesByInvoice).toEqual([[], []]);
		expect(pairing.missingInvoiceIndexes).toEqual([0, 1]);
		expect(pairing.ambiguous).toEqual([
			{
				file: "multi.pdf",
				candidateInvoiceIndexes: [0, 1],
				signals: ["trainNumber", "amount"],
			},
		]);
	});

	it("一个查验 PDF 含目标票号和额外票号时不静默绑定", () => {
		const invoices = [
			{ invoiceNumber: "10000000000000000001", trainNumber: "G7575", amount: 72 },
			{ invoiceNumber: "10000000000000000002", trainNumber: "G7018", amount: 75 },
		];
		for (const invoiceNumbers of [
			["10000000000000000001", "99999999999999999999"],
			["10000000000000000001", "10000000000000000002"],
		]) {
			const pairing = matchVerificationFiles(invoices, [
				{
					file: "multi-invoice.pdf",
					fingerprint: {
						invoiceNumbers,
						trainNumbers: [],
						amounts: [],
						verificationEvidence: ["verificationResult"],
					},
				},
			]);
			expect(pairing.verificationFilesByInvoice).toEqual([[], []]);
			expect(pairing.ambiguous[0]?.signals).toEqual(["multipleInvoiceNumbers"]);
		}
	});

	it("票面副本即使票号、车次和金额一致也不能冒充铁路查验件", () => {
		const invoices = [{ invoiceNumber: "10000000000000000001", trainNumber: "G7575", amount: 72 }];
		const duplicateTicket = parseVerificationFingerprint(
			"铁路电子客票 发票号码：10000000000000000001 南京南站 G7575 常州站 二等座 票价 ¥72.00",
		);
		const pairing = matchVerificationFiles(invoices, [{ file: "ticket-copy.png", fingerprint: duplicateTicket }]);

		expect(duplicateTicket.verificationEvidence).toEqual([]);
		expect(pairing.verificationFilesByInvoice).toEqual([[]]);
		expect(pairing.missingInvoiceIndexes).toEqual([0]);
		expect(pairing.unmatched[0]?.reason).toContain("明确查验证据");
	});

	describe("住宿 OCR 主发票与查验件分类", () => {
		const invoiceNumber = "25320119000012345678";
		const otherInvoiceNumber = "25320119000087654321";
		const lodgingInvoiceText = (number = invoiceNumber, amount = 488) =>
			[
				"电子发票（普通发票）",
				`发票号码：${number}`,
				"开票日期：2026年08月21日",
				"购买方信息 名称：赛昇",
				"销售方信息 名称：常州酒店",
				"项目名称：*住宿服务*住宿费",
				"税率：6% 税额：27.62",
				`价税合计（小写）：¥${amount.toFixed(2)}`,
				"开票人：张三",
			].join(" ");
		const lodgingVerificationText = (numbers: string[]) =>
			[
				"全国增值税发票查验平台 发票查验结果",
				...numbers.map((number) => `发票号码：${number}`),
				"项目名称：*住宿服务*住宿费",
				"价税合计：488.00 查验时间：2026-08-22",
			].join(" ");

		it("单张明确版式的住宿主发票可直接使用", () => {
			const result = resolveLodgingInvoiceCandidate([{ file: "hotel-invoice.pdf", text: lodgingInvoiceText() }]);
			expect(result).toMatchObject({
				status: "ready",
				invoice: {
					invoiceNumber,
					amount: 488,
					uploadFile: "hotel-invoice.pdf",
					verificationFiles: [],
				},
				classifiedFiles: ["hotel-invoice.pdf"],
			});
			expect(result.invoice).not.toHaveProperty("checkinDate");
			expect(result.invoice).not.toHaveProperty("checkoutDate");
		});

		it.each([
			["入住日期：2026-8-20 离店日期：2026-08-22", "2026-08-20", "2026-08-22"],
			["入住时间：2026年8月20日 退房时间：2026年8月22日", "2026-08-20", "2026-08-22"],
			["住宿起止日期：2026/8/20 至 2026/8/22", "2026-08-20", "2026-08-22"],
		])("只从住宿邻近标签保守提取入住离店日期：%s", (dateText, checkinDate, checkoutDate) => {
			const result = resolveLodgingInvoiceCandidate([
				{ file: "hotel-invoice.pdf", text: `${lodgingInvoiceText()} ${dateText}` },
			]);
			expect(result).toMatchObject({
				status: "ready",
				invoice: { checkinDate, checkoutDate },
			});
		});

		it.each([
			"住宿起止日期：2026-08-20 至 2026-08-22 入住日期：2026-08-21 离店日期：2026-08-22",
			"住宿日期：2026年8月22日 至 2026年8月20日",
		])("住宿日期范围冲突或倒置时返回 ambiguous：%s", (dateText) => {
			const result = resolveLodgingInvoiceCandidate([
				{ file: "hotel-invoice.pdf", text: `${lodgingInvoiceText()} ${dateText}` },
			]);
			expect(result.status).toBe("ambiguous");
			expect(result.invoice).toBeUndefined();
			expect(result.issues).toContainEqual(
				expect.objectContaining({ kind: "ambiguous", reason: expect.stringContaining("住宿日期范围") }),
			);
		});

		it("同票号住宿查验件绑定到主发票而不成为第二张候选", () => {
			const result = resolveLodgingInvoiceCandidate([
				{ file: "hotel-invoice.pdf", text: lodgingInvoiceText() },
				{ file: "hotel-verification.pdf", text: lodgingVerificationText([invoiceNumber]) },
			]);
			expect(result).toMatchObject({
				status: "ready",
				invoice: {
					uploadFile: "hotel-invoice.pdf",
					verificationFiles: ["hotel-verification.pdf"],
				},
				candidates: [{ verificationFiles: ["hotel-verification.pdf"] }],
				classifiedFiles: ["hotel-invoice.pdf", "hotel-verification.pdf"],
			});
		});

		it("长文件名住宿主发票和查验件都会持久化为互不覆盖的短稳定名", () => {
			const invoiceFile = join(attachmentFixtures, "常州住宿电子发票-这是一个非常长的原始文件名-20260821.png");
			const verificationFile = join(
				attachmentFixtures,
				"国家税务总局发票查验平台-住宿发票查验结果-这是一个非常长的原始文件名.png",
			);
			writeFileSync(invoiceFile, "lodging-invoice-content", "utf8");
			writeFileSync(verificationFile, "lodging-verification-content", "utf8");

			const result = readAndPairRailwayAttachments([invoiceFile, verificationFile], packWorkspace, {
				ocrTravelDocument: (file) => ({
					file,
					text: file === invoiceFile ? lodgingInvoiceText() : lodgingVerificationText([invoiceNumber]),
					fingerprint: parseVerificationFingerprint(
						file === invoiceFile ? lodgingInvoiceText() : lodgingVerificationText([invoiceNumber]),
					),
				}),
			});

			expect(result.lodging.status).toBe("ready");
			const durableInvoice = result.lodging.invoice;
			expect(durableInvoice).toBeDefined();
			expect(basename(durableInvoice!.uploadFile)).toMatch(/^T[a-f0-9]{12}\.png$/);
			expect(durableInvoice!.verificationFiles).toHaveLength(1);
			expect(basename(durableInvoice!.verificationFiles[0])).toMatch(/^T[a-f0-9]{12}\.png$/);
			expect(durableInvoice!.verificationFiles[0]).not.toBe(durableInvoice!.uploadFile);
			expect(readFileSync(durableInvoice!.uploadFile, "utf8")).toBe("lodging-invoice-content");
			expect(readFileSync(durableInvoice!.verificationFiles[0], "utf8")).toBe("lodging-verification-content");
		});

		it("裁剪的住宿票面副本不能冒充住宿查验件", () => {
			const croppedInvoiceCopy = `常州酒店 住宿费 发票号码：${invoiceNumber} 价税合计：488.00`;
			const result = resolveLodgingInvoiceCandidate([
				{ file: "hotel-invoice.pdf", text: lodgingInvoiceText() },
				{ file: "hotel-invoice-copy.png", text: croppedInvoiceCopy },
			]);

			expect(result.status).not.toBe("ready");
			expect(result.invoice).toBeUndefined();
			expect(result.issues).toContainEqual(
				expect.objectContaining({ file: "hotel-invoice-copy.png", kind: "missing" }),
			);
		});

		it("住宿查验件票号与主发票不同时拒绝绑定", () => {
			const result = resolveLodgingInvoiceCandidate([
				{ file: "hotel-invoice.pdf", text: lodgingInvoiceText() },
				{ file: "hotel-verification.pdf", text: lodgingVerificationText([otherInvoiceNumber]) },
			]);
			expect(result.status).toBe("ambiguous");
			expect(result.invoice).toBeUndefined();
			expect(result.issues).toEqual([
				expect.objectContaining({
					file: "hotel-verification.pdf",
					kind: "ambiguous",
					reason: expect.stringContaining("不一致"),
				}),
			]);
		});

		it("即使票号相同，两个住宿主发票版式也拒绝自动选择", () => {
			const result = resolveLodgingInvoiceCandidate([
				{ file: "hotel-invoice-a.pdf", text: lodgingInvoiceText() },
				{ file: "hotel-invoice-b.pdf", text: lodgingInvoiceText() },
			]);
			expect(result.status).toBe("ambiguous");
			expect(result.invoice).toBeUndefined();
			expect(result.candidates).toHaveLength(2);
			expect(result.issues).toContainEqual(
				expect.objectContaining({ kind: "ambiguous", reason: expect.stringContaining("多个住宿主发票") }),
			);
		});

		it("一个住宿查验件含多个票号时拒绝自动绑定", () => {
			const result = resolveLodgingInvoiceCandidate([
				{ file: "hotel-invoice.pdf", text: lodgingInvoiceText() },
				{
					file: "hotel-multi-verification.pdf",
					text: lodgingVerificationText([invoiceNumber, otherInvoiceNumber]),
				},
			]);
			expect(result.status).toBe("ambiguous");
			expect(result.invoice).toBeUndefined();
			expect(result.issues).toContainEqual(
				expect.objectContaining({ file: "hotel-multi-verification.pdf", kind: "ambiguous" }),
			);
		});

		it("只有住宿查验件而没有明确主发票时停止处理", () => {
			const result = resolveLodgingInvoiceCandidate([
				{ file: "hotel-verification.pdf", text: lodgingVerificationText([invoiceNumber]) },
			]);
			expect(result.status).toBe("missing");
			expect(result.invoice).toBeUndefined();
			expect(result.candidates).toEqual([]);
			expect(result.issues).toContainEqual(
				expect.objectContaining({ reason: expect.stringContaining("唯一主发票") }),
			);
		});

		it("铁路查验件即使含宾馆字样也不进入住宿分类", () => {
			const railwayVerification = {
				file: "railway-verification.pdf",
				text: "中国铁路 12306 铁路电子客票 发票号码 10000000000000000001 车次 G7575 出发站 南京南 到达站 常州 销售方地址 南京铁路宾馆路",
			};
			const railOnly = resolveLodgingInvoiceCandidate([railwayVerification]);
			expect(railOnly).toMatchObject({ status: "missing", candidates: [], classifiedFiles: [] });

			const withInvoice = resolveLodgingInvoiceCandidate([
				{ file: "hotel-invoice.pdf", text: lodgingInvoiceText() },
				railwayVerification,
			]);
			expect(withInvoice).toMatchObject({
				status: "ready",
				invoice: { verificationFiles: [] },
				classifiedFiles: ["hotel-invoice.pdf"],
			});
		});
	});

	it.runIf(process.platform === "win32")(
		"解析铁路电子客票 OFD 压缩包",
		async () => {
			const zipPath = buildFakeInvoiceZip();
			const output = await tool("travel_read_invoices").execute(
				"i1",
				{ paths: [zipPath] },
				undefined,
				undefined,
				undefined as never,
			);
			const text = (output.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("");
			expect(text).toContain("G7575");
			expect(text).toContain("南京南站");
			expect(text).toContain("常州站");
			expect(text).toContain("二等座");
			expect(text).toContain("72");
			expect(text).toContain("苏爱健");
			expect(text).toContain("10000000000000000001");
			const details = (output.details as { invoices?: Array<Record<string, unknown>> }).invoices ?? [];
			expect(details[0].date).toBe("2026-08-21");
			expect(details[0].amount).toBe(72);
			expect(details[0].fromStation).toBe("南京南站");
			expect(details[0].fromCity).toBe("南京");
			expect(details[0].toStation).toBe("常州站");
			expect(details[0].toCity).toBe("常州");
			expect(details[0].departTime).toBe("12:12");
			expect(details[0].passenger).toBe("苏爱健");
			expect(details[0].trainNumber).toBe("G7575");
			expect(details[0].issueDate).toBe("2026-08-21");
			expect(String(details[0].uploadFile)).toContain(".pdf");
			expect(basename(String(details[0].uploadFile))).toMatch(/^T[a-f0-9]{12}\.pdf$/);
			expect(basename(String(details[0].uploadFile)).length).toBeLessThanOrEqual(20);
			const secondOutput = await tool("travel_read_invoices").execute(
				"i1-again",
				{ paths: [zipPath] },
				undefined,
				undefined,
				undefined as never,
			);
			const secondDetails = (secondOutput.details as { invoices?: Array<Record<string, unknown>> }).invoices ?? [];
			expect(secondDetails[0].uploadFile).toBe(details[0].uploadFile);
			expect(readFileSync(String(secondDetails[0].uploadFile), "utf8")).toBe("%PDF-fake-10000000000000000001");
		},
		45000,
	);

	it.runIf(process.platform === "win32")(
		"同一外层 ZIP 的往返票分别解析并绑定同名 PDF",
		async () => {
			const zipPath = buildFakeInvoiceZip(
				[
					{
						invoiceNumber: "10000000000000000001",
						trainNumber: "G7575",
						fromStation: "南京南站",
						toStation: "常州站",
						departTime: "12:12",
						amount: 72,
					},
					{
						invoiceNumber: "10000000000000000002",
						trainNumber: "G7018",
						fromStation: "常州站",
						toStation: "南京站",
						departTime: "18:20",
						amount: 75,
					},
				],
				"same-basename-directories",
			);
			const output = await tool("travel_read_invoices").execute(
				"i-multi",
				{ paths: [zipPath] },
				undefined,
				undefined,
				undefined as never,
			);
			const details = (output.details as { invoices?: Array<Record<string, unknown>> }).invoices ?? [];
			expect(details).toHaveLength(2);
			expect(details.map((invoice) => invoice.trainNumber)).toEqual(["G7575", "G7018"]);
			expect(details.map((invoice) => invoice.amount)).toEqual([72, 75]);
			expect(details.map((invoice) => invoice.fromCity)).toEqual(["南京", "常州"]);
			expect(details.map((invoice) => invoice.toCity)).toEqual(["常州", "南京"]);
			const uploadFiles = details.map((invoice) => String(invoice.uploadFile));
			expect(new Set(uploadFiles).size).toBe(2);
			expect(uploadFiles.every((file) => /^T[a-f0-9]{12}\.pdf$/.test(basename(file)))).toBe(true);
			expect(uploadFiles.every((file) => file.endsWith(".pdf"))).toBe(true);
			expect(readFileSync(uploadFiles[0], "utf8")).toBe("%PDF-fake-10000000000000000001");
			expect(readFileSync(uploadFiles[1], "utf8")).toBe("%PDF-fake-10000000000000000002");
		},
		45000,
	);

	it.runIf(process.platform === "win32")(
		"同一 OFD 含多份铁路 XBRL 时拒绝任选第一份",
		async () => {
			const zipPath = buildFakeInvoiceZip([
				{
					invoiceNumber: "10000000000000000001",
					trainNumber: "G7575",
					fromStation: "南京南站",
					toStation: "常州站",
					departTime: "12:12",
					amount: 72,
					extraXbrl: fakeRailwayXbrl("10000000000000000002", "G7018", 75),
				},
			]);
			const result = readAndPairRailwayAttachments([zipPath], packWorkspace);
			expect(result.invoices).toHaveLength(1);
			expect(result.invoices[0].error).toContain("2 份铁路票据 XBRL");
			expect(result.invoices[0].invoiceNumber).toBeUndefined();
		},
		45000,
	);

	it.runIf(process.platform === "win32")("纯 PDF 压缩包会逐份识别电子客票并把普通 PDF 留给查验配对", () => {
		const outboundXml = fakeRailwayXbrl("10000000000000000001", "G7575", 72);
		const returnXml = fakeRailwayXbrl("10000000000000000002", "G7018", 75)
			.replace(
				"<rail:DepartureStation>南京南站</rail:DepartureStation>",
				"<rail:DepartureStation>常州站</rail:DepartureStation>",
			)
			.replace(
				"<rail:DestinationStation>常州站</rail:DestinationStation>",
				"<rail:DestinationStation>南京站</rail:DestinationStation>",
			);
		const zipPath = buildPdfOnlyZip([
			{ name: "ticket-out.pdf", content: buildEmbeddedRailwayPdf(outboundXml) },
			{ name: "ticket-return.pdf", content: buildEmbeddedRailwayPdf(returnXml) },
			{
				name: "verification-out.pdf",
				content: "%PDF-1.7\n铁路电子客票查验 发票号码 10000000000000000001 车次 G7575 票价 72.00\n%%EOF",
			},
			{
				name: "verification-return.pdf",
				content: "%PDF-1.7\n铁路电子客票查验 发票号码 10000000000000000002 车次 G7018 票价 75.00\n%%EOF",
			},
		]);
		const result = readAndPairRailwayAttachments([zipPath], packWorkspace, {
			ocrTravelDocument: (file) => {
				const text = readFileSync(file, "utf8");
				return { file, text, fingerprint: parseVerificationFingerprint(text) };
			},
		});

		expect(result.pairingStatus).toBe("ready");
		expect(result.invoices).toHaveLength(2);
		expect(result.invoices.map((invoice) => invoice.invoiceNumber).sort()).toEqual([
			"10000000000000000001",
			"10000000000000000002",
		]);
		expect(result.invoices.every((invoice) => invoice.verificationFiles?.length === 1)).toBe(true);
		expect(result.unmatched).toEqual([]);
	});

	it.runIf(process.platform === "win32")("压缩包内单张电子客票可配对查验，普通查验 PDF 不会伪造铁路票据", () => {
		const zipPath = buildPdfOnlyZip([
			{ name: "ticket.pdf", content: buildEmbeddedRailwayPdf() },
			{
				name: "verification.pdf",
				content: "%PDF-1.7\n铁路电子客票查验 发票号码 10000000000000000001 车次 G7575 票价 72.00\n%%EOF",
			},
		]);
		const result = readAndPairRailwayAttachments([zipPath], packWorkspace, {
			ocrTravelDocument: (file) => {
				const text = readFileSync(file, "utf8");
				return { file, text, fingerprint: parseVerificationFingerprint(text) };
			},
		});

		expect(result.pairingStatus).toBe("ready");
		expect(result.invoices).toHaveLength(1);
		expect(result.invoices[0]).toMatchObject({
			invoiceNumber: "10000000000000000001",
			verificationStatus: "ready",
		});
		expect(result.ocrDocuments).toHaveLength(1);
	});

	it.runIf(process.platform === "win32")("压缩包内 PDF 含多份铁路 XBRL 时 fail closed", () => {
		const pdf = buildTestPdf([
			[1, "<< /Type /Catalog /Names << /EmbeddedFiles 2 0 R >> >>"],
			[2, "<< /Names [(rai_issuer_1.xml) 3 0 R (rai_issuer_2.xml) 5 0 R] >>"],
			[3, "<< /Type /Filespec /F (rai_issuer_1.xml) /EF << /F 4 0 R >> >>"],
			[4, embeddedXmlStream(fakeRailwayXbrl("10000000000000000001"))],
			[5, "<< /Type /Filespec /F (rai_issuer_2.xml) /EF << /F 6 0 R >> >>"],
			[6, embeddedXmlStream(fakeRailwayXbrl("10000000000000000002"))],
		]);
		const zipPath = buildPdfOnlyZip([{ name: "ambiguous-ticket.pdf", content: pdf }]);
		const result = readAndPairRailwayAttachments([zipPath], packWorkspace);

		expect(result.invoices).toHaveLength(1);
		expect(result.invoices[0].error).toContain("2 份铁路票据 XBRL");
		expect(result.invoices[0].invoiceNumber).toBeUndefined();
	});

	it("铁路 XBRL 的关键字段或票号别名冲突时 fail closed，一致重复值仍兼容", () => {
		const cases = [
			["出发站", "<rail:DepartureStation>上海虹桥站</rail:DepartureStation>"],
			["乘车日期", "<rail:TravelDate>2026-08-22</rail:TravelDate>"],
			["票价", "<rail:Fare>99.00</rail:Fare>"],
			["乘车人", "<rail:Name>其他乘车人</rail:Name>"],
			["票号", "<rail:InvoiceNumber>10000000000000000002</rail:InvoiceNumber>"],
		] as const;
		for (const [label, conflict] of cases) {
			const file = join(attachmentFixtures, `conflicting-${label}.pdf`);
			const xml = fakeRailwayXbrl().replace("</rail:Invoice>", `${conflict}</rail:Invoice>`);
			writeFileSync(file, buildEmbeddedRailwayPdf(xml));
			const result = readAndPairRailwayAttachments([file], packWorkspace);
			expect(result.invoices[0].error, label).toContain(`字段“${label}”存在多个冲突值`);
			expect(result.invoices[0].invoiceNumber, label).toBeUndefined();
		}

		const duplicate = join(attachmentFixtures, "duplicate-consistent-fare.pdf");
		const xml = fakeRailwayXbrl().replace(
			"<rail:Fare>72.00</rail:Fare>",
			"<rail:Fare>72.00</rail:Fare><rail:Fare>72.00</rail:Fare>",
		);
		writeFileSync(duplicate, buildEmbeddedRailwayPdf(xml));
		const result = readAndPairRailwayAttachments([duplicate], packWorkspace);
		expect(result.invoices[0]).toMatchObject({ invoiceNumber: "10000000000000000001", amount: 72 });
		expect(result.invoices[0].error).toBeUndefined();
	});

	it.runIf(process.platform === "win32")(
		"Content.xml fallback 兼容无前缀和其他 XML 前缀",
		async () => {
			const zipPath = buildFakeInvoiceZip([
				{
					invoiceNumber: "26329116804009553239",
					trainNumber: "G7001",
					fromStation: "南京站",
					toStation: "常州站",
					departTime: "08:20",
					amount: 70,
					xmlPrefix: "",
					omitXbrl: true,
				},
				{
					invoiceNumber: "26329116804009553240",
					trainNumber: "G7002",
					fromStation: "常州站",
					toStation: "南京站",
					departTime: "19:20",
					amount: 71,
					xmlPrefix: "custom",
					omitXbrl: true,
				},
			]);
			const output = await tool("travel_read_invoices").execute(
				"i-prefix-fallback",
				{ paths: [zipPath] },
				undefined,
				undefined,
				undefined as never,
			);
			const details = (output.details as { invoices?: Array<Record<string, unknown>> }).invoices ?? [];
			expect(details).toHaveLength(2);
			expect(details.map((invoice) => invoice.invoiceNumber)).toEqual([
				"26329116804009553239",
				"26329116804009553240",
			]);
			expect(details.map((invoice) => invoice.trainNumber)).toEqual(["G7001", "G7002"]);
			expect(details.map((invoice) => invoice.amount)).toEqual([70, 71]);
			expect(details.map((invoice) => invoice.passenger)).toEqual(["苏爱健", "苏爱健"]);
		},
		45000,
	);

	it("票据解析对不支持的类型给出明确提示", async () => {
		const output = await tool("travel_read_invoices").execute(
			"i2",
			{ paths: ["C:/not-exist/of-course.png"] },
			undefined,
			undefined,
			undefined as never,
		);
		const text = (output.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("");
		expect(text).toContain("文件不存在");
	});
});
