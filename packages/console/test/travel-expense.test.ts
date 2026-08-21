import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/** 构造一张仿真铁路电子客票：外层 zip 内是 .ofd（本身又是 zip，含带坐标的 TextObject）+ .pdf。 */
function buildFakeInvoiceZip(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-invoice-test-"));
	const powershell = join(
		process.env.SystemRoot ?? process.env.WINDIR ?? "",
		"System32",
		"WindowsPowerShell",
		"v1.0",
		"powershell.exe",
	);
	const compress = (cwd: string, dest: string, sources: string[]) => {
		// Compress-Archive 只支持 .zip 扩展名；目标不是 .zip 时先压成 zip 再改名
		const direct = dest.toLocaleLowerCase("en-US").endsWith(".zip");
		const zipName = direct ? dest : "pi-tmp-archive.zip";
		execFileSync(
			powershell,
			[
				"-NoProfile",
				"-Command",
				`Compress-Archive -Path ${sources.map((s) => `'${s}'`).join(",")} -DestinationPath '${zipName}' -Force`,
			],
			{ cwd, windowsHide: true, timeout: 30000 },
		);
		if (!direct) {
			copyFileSync(join(cwd, zipName), join(cwd, dest));
			rmSync(join(cwd, zipName), { force: true });
		}
	};

	// 内层：OFD 文档（TextObject 故意按乱序书写，Boundary 坐标才是阅读顺序）
	const ofdDir = join(dir, "ofd-doc");
	mkdirSync(join(ofdDir, "Doc_0", "Pages", "Page_0"), { recursive: true });
	const xml = `<?xml version="1.0" encoding="utf-8"?>
<ofd:Page xmlns:ofd="http://www.ofdspec.org/2016"><ofd:Content>
<ofd:TextObject ID="11" Boundary="40 40 14 8"><ofd:TextCode>南京南</ofd:TextCode></ofd:TextObject>
<ofd:TextObject ID="14" Boundary="54 40 8 8"><ofd:TextCode>站</ofd:TextCode></ofd:TextObject>
<ofd:TextObject ID="12" Boundary="64 40 12 8"><ofd:TextCode>G7575</ofd:TextCode></ofd:TextObject>
<ofd:TextObject ID="10" Boundary="78 40 10 8"><ofd:TextCode>常州</ofd:TextCode></ofd:TextObject>
<ofd:TextObject ID="13" Boundary="88 40 8 8"><ofd:TextCode>站</ofd:TextCode></ofd:TextObject>
<ofd:TextObject ID="20" Boundary="10 50 60 8"><ofd:TextCode>2026年08月21日</ofd:TextCode></ofd:TextObject>
<ofd:TextObject ID="21" Boundary="70 50 30 8"><ofd:TextCode>12:12开</ofd:TextCode></ofd:TextObject>
<ofd:TextObject ID="22" Boundary="100 50 40 8"><ofd:TextCode>二等座</ofd:TextCode></ofd:TextObject>
<ofd:TextObject ID="30" Boundary="10 60 50 8"><ofd:TextCode>票价:</ofd:TextCode></ofd:TextObject>
<ofd:TextObject ID="31" Boundary="35 60 10 8"><ofd:TextCode>￥</ofd:TextCode></ofd:TextObject>
<ofd:TextObject ID="32" Boundary="45 60 20 8"><ofd:TextCode>72.00</ofd:TextCode></ofd:TextObject>
<ofd:TextObject ID="40" Boundary="10 70 30 8"><ofd:TextCode>苏爱健</ofd:TextCode></ofd:TextObject>
<ofd:TextObject ID="41" Boundary="10 75 60 8"><ofd:TextCode>3212811997****4234</ofd:TextCode></ofd:TextObject>
<ofd:TextObject ID="50" Boundary="10 20 80 8"><ofd:TextCode>发票号码:26329116804009553237开票日期:2026年08月21日</ofd:TextCode></ofd:TextObject>
</ofd:Content></ofd:Page>`;
	writeFileSync(join(ofdDir, "Doc_0", "Pages", "Page_0", "Content.xml"), xml, "utf8");
	compress(ofdDir, "26329116804009553237.ofd", ["Doc_0"]);

	// 外层：zip 内放原始 .ofd 与 .pdf（真实票据的下载结构）
	const outerDir = join(dir, "outer");
	mkdirSync(outerDir, { recursive: true });
	copyFileSync(join(ofdDir, "26329116804009553237.ofd"), join(outerDir, "26329116804009553237.ofd"));
	writeFileSync(join(outerDir, "26329116804009553237.pdf"), "%PDF-fake", "utf8");
	compress(outerDir, "26329116804009553237.zip", ["26329116804009553237.ofd", "26329116804009553237.pdf"]);
	return join(outerDir, "26329116804009553237.zip");
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
		expect(details[0].fromStation).toBe("南京南站");
		expect(details[0].toStation).toBe("常州站");
		expect(details[0].departTime).toBe("12:12");
		expect(details[0].passenger).toBe("苏爱健");
		expect(details[0].trainNumber).toBe("G7575");
		expect(details[0].issueDate).toBe("2026-08-21");
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
