import { describe, expect, it } from "vitest";
import definePack from "../packs/travel-expense/index.ts";

const tools = definePack({ getWorkspaceRoot: () => process.cwd() }).tools;

function tool(name: string) {
	const found = tools.find((item) => item.name === name);
	if (!found) throw new Error(`工具不存在：${name}`);
	return found;
}

describe("差旅报销能力包", () => {
	it("注册规则速查与费用明细计划两个工具", () => {
		expect(tools.map((item) => item.name).sort()).toEqual(["travel_plan_details", "travel_reimbursement_guide"]);
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
});
