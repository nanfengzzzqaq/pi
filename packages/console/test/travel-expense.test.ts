import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import definePack from "../packs/travel-expense/index.ts";

const tools = definePack({ getWorkspaceRoot: () => process.cwd() }).tools;

function tool(name: string) {
	const found = tools.find((item) => item.name === name);
	if (!found) throw new Error(`工具不存在：${name}`);
	return found;
}

/** 构造一张仿真铁路电子客票 OFD（zip）用于解析测试。 */
function buildFakeInvoiceZip(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-invoice-test-"));
	const ticketRoot = join(dir, "26329116804009553237");
	mkdirSync(join(ticketRoot, "Doc_0", "Pages", "Page_0"), { recursive: true });
	const xml = `<?xml version="1.0" encoding="utf-8"?>
<ofd:Page xmlns:ofd="http://www.ofdspec.org/2016"><ofd:Content>
<ofd:TextObject ID="1"><ofd:TextCode>铁路电子客票</ofd:TextCode></ofd:TextObject>
<ofd:TextObject ID="2"><ofd:TextCode>发票号码 26329116804009553237 开票日期 2026年8月21日</ofd:TextCode></ofd:TextObject>
<ofd:TextObject ID="3"><ofd:TextCode>G7575 南京南站 12:12开 → 常州站</ofd:TextCode></ofd:TextObject>
<ofd:TextObject ID="4"><ofd:TextCode>2026年8月21日 04车08D号 二等座</ofd:TextCode></ofd:TextObject>
<ofd:TextObject ID="5"><ofd:TextCode>票价 ￥72.00 乘车人 苏爱健</ofd:TextCode></ofd:TextObject>
</ofd:Content></ofd:Page>`;
	writeFileSync(join(ticketRoot, "Doc_0", "Pages", "Page_0", "Content.xml"), xml, "utf8");
	writeFileSync(join(ticketRoot, "26329116804009553237.pdf"), "%PDF-fake", "utf8");
	writeFileSync(join(ticketRoot, "26329116804009553237.ofd"), "PK-fake", "utf8");
	const zipPath = join(dir, "26329116804009553237.zip");
	// PowerShell Compress-Archive 生成标准 zip（GNU tar 不支持写 zip）
	const powershell = join(
		process.env.SystemRoot ?? process.env.WINDIR ?? "",
		"System32",
		"WindowsPowerShell",
		"v1.0",
		"powershell.exe",
	);
	execFileSync(
		powershell,
		[
			"-NoProfile",
			"-Command",
			"Compress-Archive -Path '26329116804009553237' -DestinationPath '26329116804009553237.zip' -Force",
		],
		{ cwd: dir, windowsHide: true, timeout: 30000 },
	);
	return zipPath;
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
		expect(text).toContain("江苏省 → 南京市");
		expect(text).toContain("180 元/天");
		expect(text).toContain("其他省份");
		expect(text).toContain("苏爱健");
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
					{ from: "南京", to: "常州", date: "2026-08-21", seatClass: "二等座", amount: 63 },
					{ from: "常州", to: "南京", date: "2026-08-21", seatClass: "二等座", amount: 63 },
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
	});

	it("多天出差：交通 + 住宿 + 按天补贴", async () => {
		const output = await tool("travel_plan_details").execute(
			"p2",
			{
				startDate: "2026-08-20",
				endDate: "2026-08-22",
				legs: [
					{ from: "南京", to: "苏州", date: "2026-08-20", seatClass: "二等座", amount: 100 },
					{ from: "苏州", to: "南京", date: "2026-08-22", seatClass: "二等座", amount: 100 },
				],
				hotel: { amount: 320, checkin: "2026-08-20", checkout: "2026-08-22" },
			},
			undefined,
			undefined,
			undefined as never,
		);
		const text = (output.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("");
		expect(text).toContain("3 天");
		expect(text).toContain("住宿费");
		expect(text).toContain("其他省份");
	});

	it("多天出差缺住宿费时报错提醒", async () => {
		await expect(
			tool("travel_plan_details").execute(
				"p3",
				{
					startDate: "2026-08-20",
					endDate: "2026-08-22",
					legs: [{ from: "南京", to: "苏州", date: "2026-08-20", seatClass: "二等座", amount: 100 }],
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
					legs: [{ from: "南京", to: "苏州", date: "2026-08-22", seatClass: "二等座", amount: 100 }],
				},
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow(/日期不合法/);
	});

	it.runIf(process.platform === "win32")("解析铁路电子客票 OFD 压缩包", async () => {
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
		expect(String(details[0].uploadFile)).toContain(".pdf");
	});

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
