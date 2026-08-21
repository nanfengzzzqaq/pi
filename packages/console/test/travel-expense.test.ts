import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import definePack from "../packs/travel-expense/index.ts";

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

interface FakeTicket {
	invoiceNumber: string;
	trainNumber: string;
	fromStation: string;
	toStation: string;
	departTime: string;
	amount: number;
	xmlPrefix?: string;
	omitXbrl?: boolean;
}

/** 构造仿真铁路电子客票：外层 ZIP 可包含多组同名 OFD+PDF，每张票有独立 XBRL。 */
function buildFakeInvoiceZip(
	tickets: FakeTicket[] = [
		{
			invoiceNumber: "26329116804009553237",
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

describe("差旅报销能力包", () => {
	it("注册规则速查、票据解析与费用明细计划三个工具", () => {
		expect(tools.map((item) => item.name).sort()).toEqual([
			"travel_plan_details",
			"travel_read_invoices",
			"travel_reimbursement_guide",
		]);
	});

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
			expect(text).toContain("26329116804009553237");
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
			const secondOutput = await tool("travel_read_invoices").execute(
				"i1-again",
				{ paths: [zipPath] },
				undefined,
				undefined,
				undefined as never,
			);
			const secondDetails = (secondOutput.details as { invoices?: Array<Record<string, unknown>> }).invoices ?? [];
			expect(secondDetails[0].uploadFile).not.toBe(details[0].uploadFile);
			expect(readFileSync(String(secondDetails[0].uploadFile), "utf8")).toBe("%PDF-fake-26329116804009553237");
		},
		45000,
	);

	it.runIf(process.platform === "win32")(
		"同一外层 ZIP 的往返票分别解析并绑定同名 PDF",
		async () => {
			const zipPath = buildFakeInvoiceZip(
				[
					{
						invoiceNumber: "26329116804009553237",
						trainNumber: "G7575",
						fromStation: "南京南站",
						toStation: "常州站",
						departTime: "12:12",
						amount: 72,
					},
					{
						invoiceNumber: "26329116804009553238",
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
			expect(uploadFiles[0]).toContain("26329116804009553237");
			expect(uploadFiles[1]).toContain("26329116804009553238");
			expect(uploadFiles.every((file) => file.endsWith(".pdf"))).toBe(true);
			expect(readFileSync(uploadFiles[0], "utf8")).toBe("%PDF-fake-26329116804009553237");
			expect(readFileSync(uploadFiles[1], "utf8")).toBe("%PDF-fake-26329116804009553238");
		},
		45000,
	);

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
