import { describe, expect, it } from "vitest";
import {
	buildTravelDraftExpected,
	runTravelDraft,
	TRAVEL_DRAFT_CURRENT_USER,
	TRAVEL_DRAFT_DEPARTMENT,
	TRAVEL_DRAFT_STATION,
	type TravelDraftApplication,
	type TravelDraftDriver,
	type TravelDraftExpected,
	type TravelDraftHeaderExpected,
	type TravelDraftHotelExpected,
	TravelDraftInterruptedError,
	type TravelDraftIssue,
	type TravelDraftObservation,
	type TravelDraftPlan,
	type TravelDraftTransportExpected,
	travelDraftSaveIdentity,
} from "../packs/travel-expense/workflow.ts";

function changzhouPlan(): TravelDraftPlan {
	return {
		url: "https://app.ekuaibao.com/example-draft",
		reimbursementDate: "2026-08-22",
		application: {
			id: "S26002261",
			title: "出差申请：常州业务拓展",
			reason: "常州业务拓展",
			startDate: "2026-08-21",
			endDate: "2026-08-21",
			expenseNature: "部门费用",
		},
		transport: [
			{
				fromCity: "南京",
				toCity: "常州",
				travelDate: "2026-08-21",
				seatClass: "二等座",
				amount: 72,
				passenger: "苏爱健",
				invoiceNumber: "TEST-RAIL-OUT-001",
				uploadFile: "C:\\tickets\\TEST-RAIL-OUT-001.pdf",
				verificationFiles: ["C:\\tickets\\TEST-RAIL-OUT-001-check.pdf"],
			},
			{
				fromCity: "常州",
				toCity: "南京",
				travelDate: "2026-08-21",
				seatClass: "二等座",
				amount: 75,
				passenger: "苏爱健",
				invoiceNumber: "TEST-RAIL-RETURN-002",
				uploadFile: "C:\\tickets\\TEST-RAIL-RETURN-002.pdf",
				verificationFiles: ["C:\\tickets\\TEST-RAIL-RETURN-002-check.pdf"],
			},
		],
	};
}

function cloneObservation(value: TravelDraftObservation): TravelDraftObservation {
	return structuredClone(value);
}

class FakeTravelDraftDriver implements TravelDraftDriver {
	readonly calls: string[] = [];
	readonly noProgress = new Set<string>();
	readonly precheckMissing: TravelDraftIssue[] = [];
	readonly precheckAmbiguous: TravelDraftIssue[] = [];
	interruptAfterMutation: string | undefined;
	confirmationText = "草稿保存成功";
	dynamicMainPaymentSummary = false;
	state: TravelDraftObservation = {
		page: "closed",
		details: [],
		draft: { saveRequested: false, saved: false },
	};

	private output(): TravelDraftObservation {
		const observation = cloneObservation(this.state);
		observation.detailCount = observation.details.length;
		if (this.dynamicMainPaymentSummary && observation.details.length > 0 && observation.header) {
			// 易快报在首条明细后会把主表支付摘要显示为“多收款人”。
			// 这不代表独立的“是否为多收款人” checkbox 已勾选。
			observation.header.paymentRecipient = undefined;
		}
		return observation;
	}

	private complete(operation: string, mutate: () => void): TravelDraftObservation {
		this.calls.push(operation);
		if (!this.noProgress.has(operation)) mutate();
		if (this.interruptAfterMutation === operation) {
			this.interruptAfterMutation = undefined;
			throw new TravelDraftInterruptedError(`interrupt:${operation}`);
		}
		return this.output();
	}

	private upsert(row: TravelDraftObservation["details"][number]): void {
		const index = this.state.details.findIndex((item) => item.key === row.key);
		if (index >= 0) this.state.details[index] = structuredClone(row);
		else this.state.details.push(structuredClone(row));
	}

	async precheck(_plan: TravelDraftPlan, _expected: TravelDraftExpected) {
		this.calls.push("precheck");
		return {
			observation: this.output(),
			missing: [...this.precheckMissing],
			ambiguous: [...this.precheckAmbiguous],
		};
	}

	async observe(_expected: TravelDraftExpected): Promise<TravelDraftObservation> {
		this.calls.push("observe");
		return this.output();
	}

	async open(_url: string): Promise<TravelDraftObservation> {
		return this.complete("open", () => {
			this.state.page = "form";
		});
	}

	async ensureApplication(application: TravelDraftApplication): Promise<TravelDraftObservation> {
		return this.complete("application", () => {
			this.state.application = structuredClone(application);
		});
	}

	async ensureHeader(header: TravelDraftHeaderExpected): Promise<TravelDraftObservation> {
		return this.complete("header", () => {
			this.state.header = structuredClone(header);
		});
	}

	async ensureTransport(row: TravelDraftTransportExpected, index: number): Promise<TravelDraftObservation> {
		return this.complete(`transport:${index}`, () => this.upsert(row));
	}

	async ensureHotel(row: TravelDraftHotelExpected): Promise<TravelDraftObservation> {
		return this.complete("hotel", () => this.upsert(row));
	}

	async ensureAllowance(row: TravelDraftExpected["allowance"]): Promise<TravelDraftObservation> {
		return this.complete("allowance", () => this.upsert(row));
	}

	async verify(expected: TravelDraftExpected): Promise<TravelDraftObservation> {
		return this.complete("verify", () => {
			this.state.calculatedTotal = expected.totalAmount;
			this.state.verification = { valid: true, errors: [] };
		});
	}

	async saveDraft(_expected: TravelDraftExpected): Promise<TravelDraftObservation> {
		return this.complete("save_draft", () => {
			this.state.draft = { saveRequested: true, saved: false };
		});
	}

	async confirmDraftSaved(): Promise<TravelDraftObservation> {
		return this.complete("confirm", () => {
			this.state.draft = { saveRequested: true, saved: true, confirmationText: this.confirmationText };
		});
	}
}

describe("差旅草稿确定性状态机", () => {
	it("跨重启保存身份仅由稳定业务事实构成，不受 URL、附件路径和行顺序影响", () => {
		const first = changzhouPlan();
		const second = structuredClone(first);
		second.url = "https://app.ekuaibao.com/web/app.html?accessToken=must-not-enter-sentinel";
		second.reimbursementDate = "2026-08-23";
		second.application.title = "不同的自由文本标题";
		second.application.reason = "不同的自由文本事由";
		second.transport.reverse();
		for (const [index, row] of second.transport.entries()) {
			row.uploadFile = `D:\\private\\renamed-${index}.pdf`;
			row.verificationFiles = [`D:\\private\\verification-${index}.png`];
		}

		const identity = travelDraftSaveIdentity(first);
		expect(identity).toMatch(/^[a-f0-9]{64}$/);
		expect(travelDraftSaveIdentity(second)).toBe(identity);

		second.transport[0].invoiceNumber = "TEST-NEW-TRIP-INVOICE";
		expect(travelDraftSaveIdentity(second)).not.toBe(identity);
	});

	it("一次完成常州当天往返，两张车票加补助合计 327 元", async () => {
		const driver = new FakeTravelDraftDriver();
		const output = await runTravelDraft(driver, changzhouPlan());

		expect(output.status).toBe("done");
		expect(output.stage).toBe("DONE");
		expect(output.expectedTotal).toBe(327);
		expect(driver.calls).toEqual([
			"precheck",
			"open",
			"application",
			"header",
			"transport:0",
			"transport:1",
			"allowance",
			"verify",
			"save_draft",
			"confirm",
		]);
		expect(driver.calls.join(" ")).not.toMatch(/submit|delete-bill/);
		expect(output.observation?.header).toMatchObject({
			submitter: TRAVEL_DRAFT_CURRENT_USER,
			station: TRAVEL_DRAFT_STATION,
			company: "赛昇信息技术研究院江苏有限公司",
			applicantDepartment: TRAVEL_DRAFT_DEPARTMENT,
			expenseDepartment: TRAVEL_DRAFT_DEPARTMENT,
			multipleRecipients: false,
		});
		expect(output.observation?.details).toHaveLength(3);
		expect(output.observation?.details.every((row) => row.paymentRecipient === TRAVEL_DRAFT_CURRENT_USER)).toBe(true);
		expect(output.observation?.draft?.confirmationText).toBe("草稿保存成功");
	});

	it("新增明细后主表支付摘要变为多收款人时不回退表头，仍逐行核验苏爱健", async () => {
		const driver = new FakeTravelDraftDriver();
		driver.dynamicMainPaymentSummary = true;

		const output = await runTravelDraft(driver, changzhouPlan());

		expect(output.status).toBe("done");
		expect(driver.calls.filter((call) => call === "header")).toHaveLength(1);
		expect(output.observation?.header?.multipleRecipients).toBe(false);
		expect(output.observation?.header?.paymentRecipient).toBeUndefined();
		expect(output.observation?.details.every((row) => row.paymentRecipient === TRAVEL_DRAFT_CURRENT_USER)).toBe(true);
	});

	it("在任何页面动作前一次性报告多人票据和全部缺失附件", async () => {
		const plan = changzhouPlan();
		plan.transport[1].passenger = "张三";
		plan.transport[0].verificationFiles = [];
		plan.transport[1].uploadFile = "";
		const driver = new FakeTravelDraftDriver();

		const output = await runTravelDraft(driver, plan);

		expect(output.status).toBe("needs_input");
		expect(driver.calls).toEqual([]);
		expect(output.missing.map((item) => item.code)).toEqual(
			expect.arrayContaining(["missing_verification", "missing_value"]),
		);
		expect(output.ambiguous.map((item) => item.code)).toEqual(
			expect.arrayContaining(["multiple_passengers", "passenger_mismatch"]),
		);
	});

	it("多日行程必须加入住宿，并按每天 180 元生成补助", async () => {
		const plan = changzhouPlan();
		plan.application.startDate = "2026-08-21";
		plan.application.endDate = "2026-08-23";
		plan.transport[1].travelDate = "2026-08-23";
		plan.hotel = {
			checkinDate: "2026-08-21",
			checkoutDate: "2026-08-23",
			amount: 480,
			invoiceNumber: "HOTEL-20260821",
			uploadFile: "C:\\tickets\\hotel.pdf",
			verificationFiles: [],
		};
		const driver = new FakeTravelDraftDriver();

		const output = await runTravelDraft(driver, plan);

		expect(output.status).toBe("done");
		expect(output.expectedTotal).toBe(1167);
		expect(driver.calls).toContain("hotel");
		expect(output.observation?.details.find((row) => row.kind === "allowance")).toMatchObject({
			allowanceType: "其他省份",
			days: 3,
			amount: 540,
			paymentRecipient: TRAVEL_DRAFT_CURRENT_USER,
		});
	});

	it("住宿起止日期必须完整包含在关联申请范围内", async () => {
		const plan = changzhouPlan();
		plan.application.startDate = "2026-08-21";
		plan.application.endDate = "2026-08-23";
		plan.hotel = {
			checkinDate: "2026-08-20",
			checkoutDate: "2026-08-23",
			amount: 480,
			invoiceNumber: "TEST-HOTEL-OUTSIDE-001",
			uploadFile: "C:\\tickets\\TEST-HOTEL-OUTSIDE-001.pdf",
			verificationFiles: [],
		};
		const driver = new FakeTravelDraftDriver();

		const output = await runTravelDraft(driver, plan);

		expect(output.status).toBe("needs_input");
		expect(output.ambiguous.map((item) => item.code)).toContain("hotel_dates_outside_application");
		expect(driver.calls).toEqual([]);
	});

	it("动作完成后中断时，恢复会先观察页面并跳过已完成的明细", async () => {
		const plan = changzhouPlan();
		const driver = new FakeTravelDraftDriver();
		driver.interruptAfterMutation = "transport:1";

		const interrupted = await runTravelDraft(driver, plan);
		expect(interrupted.status).toBe("interrupted");
		expect(interrupted.stage).toBe("TRANSPORT");
		expect(interrupted.checkpoint.transportIndex).toBe(1);

		const resumed = await runTravelDraft(driver, plan, { checkpoint: interrupted.checkpoint });
		expect(resumed.status).toBe("done");
		expect(driver.calls.filter((call) => call === "transport:1")).toHaveLength(1);
		expect(driver.calls).toContain("observe");
	});

	it("同一阶段连续两次指纹无变化时熔断，不进入后续填报", async () => {
		const driver = new FakeTravelDraftDriver();
		driver.noProgress.add("header");

		const output = await runTravelDraft(driver, changzhouPlan());

		expect(output.status).toBe("blocked");
		expect(output.stage).toBe("HEADER");
		expect(driver.calls.filter((call) => call === "header")).toHaveLength(2);
		expect(driver.calls).not.toContain("transport:0");
		expect(output.errors.join("\n")).toContain("没有页面进展");
	});

	it("驱动 hard blocker 首次抛出后立即终止，不重放已部分变更的明细阶段", async () => {
		class HardBlockDriver extends FakeTravelDraftDriver {
			attempts = 0;

			override async ensureTransport(
				_row: TravelDraftTransportExpected,
				index: number,
			): Promise<TravelDraftObservation> {
				this.attempts += 1;
				this.calls.push(`transport-hard:${index}`);
				const error = new Error("上传后的逐行回读失败");
				error.name = "TravelDraftBrowserBlocker";
				throw error;
			}
		}
		const driver = new HardBlockDriver();

		const output = await runTravelDraft(driver, changzhouPlan());

		expect(output.status).toBe("blocked");
		expect(output.stage).toBe("TRANSPORT");
		expect(driver.attempts).toBe(1);
		expect(driver.calls.filter((call) => call === "transport-hard:0")).toHaveLength(1);
		expect(driver.calls).not.toContain("transport-hard:1");
		expect(driver.calls).not.toContain("allowance");
		expect(driver.calls).not.toContain("save_draft");
		expect(output.errors.join("\n")).toContain("上传后的逐行回读失败");
	});

	it("达到全局动作预算后立即停止且不继续填写", async () => {
		const driver = new FakeTravelDraftDriver();

		const output = await runTravelDraft(driver, changzhouPlan(), { maxActions: 3 });

		expect(output.status).toBe("blocked");
		expect(output.stage).toBe("HEADER");
		expect(output.actionsUsed).toBe(3);
		expect(driver.calls).toEqual(["precheck", "open", "application"]);
		expect(output.errors.join("\n")).toContain("全局动作预算");
	});

	it("只有明确出现草稿保存成功文案才允许进入 DONE", async () => {
		const driver = new FakeTravelDraftDriver();
		driver.confirmationText = "操作完成";

		const output = await runTravelDraft(driver, changzhouPlan());

		expect(output.status).toBe("blocked");
		expect(output.stage).toBe("CONFIRM");
		expect(driver.calls.filter((call) => call === "save_draft")).toHaveLength(1);
		// 首次确认把“保存中”推进为“已保存但文案不可信”，随后最多重试两次。
		expect(driver.calls.filter((call) => call === "confirm")).toHaveLength(3);
	});

	it("明细保存遗留的成功提示不能跳过主表存为草稿按钮", async () => {
		const driver = new FakeTravelDraftDriver();
		driver.state.draft = { saveRequested: false, saved: true, confirmationText: "保存成功" };

		const output = await runTravelDraft(driver, changzhouPlan());

		expect(output.status).toBe("done");
		expect(driver.calls.filter((call) => call === "save_draft")).toHaveLength(1);
		expect(driver.calls.indexOf("save_draft")).toBeLessThan(driver.calls.indexOf("confirm"));
	});

	it("草稿保存请求后页面完整性漂移立即阻断，绝不回退业务阶段或再次保存", async () => {
		class DriftAfterSaveDriver extends FakeTravelDraftDriver {
			override async saveDraft(expected: TravelDraftExpected): Promise<TravelDraftObservation> {
				await super.saveDraft(expected);
				this.state.details = [];
				return cloneObservation(this.state);
			}
		}
		class DriftAfterConfirmDriver extends FakeTravelDraftDriver {
			override async confirmDraftSaved(): Promise<TravelDraftObservation> {
				await super.confirmDraftSaved();
				this.state.header = undefined;
				return cloneObservation(this.state);
			}
		}

		for (const driver of [new DriftAfterSaveDriver(), new DriftAfterConfirmDriver()]) {
			const output = await runTravelDraft(driver, changzhouPlan());
			const saveIndex = driver.calls.indexOf("save_draft");

			expect(output.status).toBe("blocked");
			expect(driver.calls.filter((call) => call === "save_draft")).toHaveLength(1);
			expect(
				driver.calls
					.slice(saveIndex + 1)
					.some((call) =>
						["header", "transport:0", "transport:1", "hotel", "allowance", "save_draft"].includes(call),
					),
			).toBe(false);
			expect(output.errors.join("\n")).toContain("保存请求后");
		}
	});

	it("草稿保存后异步多出一条明细时立即阻断，绝不继续修改或再次保存", async () => {
		class ExtraDetailAfterSaveDriver extends FakeTravelDraftDriver {
			override async saveDraft(expected: TravelDraftExpected): Promise<TravelDraftObservation> {
				const observation = await super.saveDraft(expected);
				return { ...observation, detailCount: observation.details.length + 1 };
			}
		}
		const driver = new ExtraDetailAfterSaveDriver();
		const output = await runTravelDraft(driver, changzhouPlan());
		const saveIndex = driver.calls.indexOf("save_draft");

		expect(output.status).toBe("blocked");
		expect(output.stage).toBe("SAVE_DRAFT");
		expect(driver.calls.filter((call) => call === "save_draft")).toHaveLength(1);
		expect(driver.calls.slice(saveIndex + 1)).toEqual([]);
		expect(output.errors.join("\n")).toContain("保存请求后");
	});

	it("调用保存驱动前先持久化不可逆标记，保存后中断恢复也不重放保存", async () => {
		const driver = new FakeTravelDraftDriver();
		driver.interruptAfterMutation = "save_draft";

		const interrupted = await runTravelDraft(driver, changzhouPlan());
		expect(interrupted.status).toBe("interrupted");
		expect(interrupted.stage).toBe("SAVE_DRAFT");
		expect(interrupted.checkpoint.saveRequested).toBe(true);
		expect(driver.calls.filter((call) => call === "save_draft")).toHaveLength(1);

		const resumed = await runTravelDraft(driver, changzhouPlan(), { checkpoint: interrupted.checkpoint });
		expect(resumed.status).toBe("done");
		expect(driver.calls.filter((call) => call === "save_draft")).toHaveLength(1);
	});

	it("DONE 恢复点的保存证据丢失时阻断且不会第二次点击主草稿", async () => {
		const plan = changzhouPlan();
		const firstDriver = new FakeTravelDraftDriver();
		const first = await runTravelDraft(firstDriver, plan);
		expect(first.status).toBe("done");

		const resumedDriver = new FakeTravelDraftDriver();
		resumedDriver.state = cloneObservation(first.observation!);
		resumedDriver.state.draft = { saveRequested: false, saved: false };
		const resumed = await runTravelDraft(resumedDriver, plan, { checkpoint: first.checkpoint });

		expect(resumed.status).toBe("blocked");
		expect(resumedDriver.calls).toEqual(["observe"]);
		expect(resumed.errors.join("\n")).toContain("不会再次点击保存");
	});

	it("构建期固定字段不接受模型覆盖", () => {
		const expected = buildTravelDraftExpected(changzhouPlan());
		expect(expected.header).toMatchObject({
			submitter: "苏爱健",
			station: "江苏省南京",
			company: "赛昇信息技术研究院江苏有限公司",
			multipleRecipients: false,
		});
		expect(expected.allowance).toMatchObject({ allowanceType: "其他省份", days: 1, amount: 180 });
	});
});
