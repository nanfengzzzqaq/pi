/**
 * “差旅报销”能力包。
 *
 * 易快报（合思）差旅费用报销单的自动填报助手：提供报销规则速查与费用明细
 * 计划工具；页面操作复用客户端内置浏览器（browser_* 工具），本包不直接接触页面。
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PackContext } from "../../src/packs.ts";

function textResult(text: string, details: Record<string, unknown> = {}): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details };
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

export default function definePack(_ctx: PackContext) {
	const tools: ToolDefinition[] = [
		{
			name: "travel_reimbursement_guide",
			label: "差旅报销规则速查",
			description: "返回当前公司差旅费用报销单（易快报/合思）的字段填写规则、固定取值和安全红线。",
			parameters: Type.Object({}),
			execute: async () => textResult(reimbursementGuideText()),
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
