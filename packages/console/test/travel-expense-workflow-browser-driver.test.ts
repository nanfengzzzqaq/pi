import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildTravelDraftExpected,
	runTravelDraft,
	TRAVEL_DRAFT_CURRENT_USER,
	TRAVEL_DRAFT_DEPARTMENT,
	type TravelDraftAllowanceExpected,
	type TravelDraftExpected,
	type TravelDraftHotelExpected,
	TravelDraftInterruptedError,
	type TravelDraftPlan,
	type TravelDraftTransportExpected,
} from "../packs/travel-expense/workflow.ts";
import {
	discoverTravelApplication,
	parseTravelPaymentTotal,
	TravelDraftBrowserBlocker,
	TravelDraftBrowserDriver,
} from "../packs/travel-expense/workflow-browser-driver.ts";
import type {
	AgentBrowserRuntime,
	AgentBrowserSnapshotOptions,
	AgentBrowserState,
	AgentBrowserTarget,
	AgentBrowserUploadFile,
	EkuaibaoTrustedApplicationSourceState,
	EkuaibaoTrustedCommand,
	EkuaibaoTrustedField,
	EkuaibaoTrustedPageState,
	EkuaibaoTrustedResult,
} from "../src/agent-browser-runtime.ts";
import {
	EKUAIBAO_TRUSTED_CONTRACT_VERSION,
	EKUAIBAO_TRUSTED_PAGE_FINGERPRINT,
	vaultSensitiveUrlsInText,
} from "../src/agent-browser-runtime.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(): { cwd: string; plan: TravelDraftPlan; expected: TravelDraftExpected } {
	const cwd = mkdtempSync(join(tmpdir(), "pi-travel-browser-driver-"));
	temporaryDirectories.push(cwd);
	const ticket = join(cwd, "TEST-RAIL-OUT-001-ticket.pdf");
	const verification = join(cwd, "TEST-RAIL-OUT-001-verification.pdf");
	writeFileSync(ticket, "ticket");
	writeFileSync(verification, "verification");
	const plan: TravelDraftPlan = {
		url: "https://app.ekuaibao.com/example",
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
				fromStation: "南京南站",
				toStation: "常州站",
				trainNumber: "GTEST1",
				travelDate: "2026-08-21",
				seatClass: "二等座",
				amount: 72,
				passenger: "苏爱健",
				invoiceNumber: "TEST-RAIL-OUT-001",
				uploadFile: ticket,
				verificationFiles: [verification],
			},
		],
	};
	return { cwd, plan, expected: buildTravelDraftExpected(plan) };
}

function twoRailFixture(returnAmount = 75): { cwd: string; plan: TravelDraftPlan; expected: TravelDraftExpected } {
	const { cwd, plan } = fixture();
	const ticket = join(cwd, "TEST-RAIL-RETURN-002-ticket.pdf");
	const verification = join(cwd, "TEST-RAIL-RETURN-002-verification.pdf");
	writeFileSync(ticket, "ticket-return");
	writeFileSync(verification, "verification-return");
	const completePlan: TravelDraftPlan = {
		...plan,
		transport: [
			...plan.transport,
			{
				fromCity: "常州",
				toCity: "南京",
				fromStation: "常州站",
				toStation: "南京南站",
				trainNumber: "GTEST2",
				travelDate: "2026-08-21",
				seatClass: "二等座",
				amount: returnAmount,
				passenger: "苏爱健",
				invoiceNumber: "TEST-RAIL-RETURN-002",
				uploadFile: ticket,
				verificationFiles: [verification],
			},
		],
	};
	return { cwd, plan: completePlan, expected: buildTravelDraftExpected(completePlan) };
}

function multiDayFixture(): { cwd: string; plan: TravelDraftPlan; expected: TravelDraftExpected } {
	const { cwd, plan } = twoRailFixture(75);
	const hotelInvoice = join(cwd, "synthetic-hotel-invoice.pdf");
	const hotelVerification = join(cwd, "synthetic-hotel-verification.pdf");
	writeFileSync(hotelInvoice, "hotel-invoice");
	writeFileSync(hotelVerification, "hotel-verification");
	const multiDayPlan: TravelDraftPlan = {
		...plan,
		application: { ...plan.application, endDate: "2026-08-22" },
		transport: [plan.transport[0], { ...plan.transport[1], travelDate: "2026-08-22" }],
		hotel: {
			checkinDate: "2026-08-21",
			checkoutDate: "2026-08-22",
			amount: 400,
			invoiceNumber: "TEST-HOTEL-003",
			uploadFile: hotelInvoice,
			verificationFiles: [hotelVerification],
		},
	};
	return { cwd, plan: multiDayPlan, expected: buildTravelDraftExpected(multiDayPlan) };
}

function browserState(open: boolean): AgentBrowserState {
	return {
		open,
		url: open ? "https://app.ekuaibao.com/example#/billEntryDetail" : "",
		title: open ? "合思" : "",
		loading: false,
		canGoBack: false,
		canGoForward: false,
		status: "",
	};
}

abstract class FakeRuntime implements AgentBrowserRuntime {
	readonly calls: Array<{ method: string; value?: unknown }> = [];
	readonly uploadAllowedOrigins: Array<string | undefined> = [];
	openState = false;

	setDownloadDirectory(path: string): void {
		this.calls.push({ method: "setDownloadDirectory", value: path });
	}

	async open(url?: string): Promise<AgentBrowserState> {
		this.calls.push({ method: "open", value: url });
		this.openState = true;
		return browserState(true);
	}

	hide(): AgentBrowserState {
		this.calls.push({ method: "hide" });
		this.openState = false;
		return browserState(false);
	}

	state(): AgentBrowserState {
		return browserState(this.openState);
	}

	async navigate(url: string): Promise<AgentBrowserState> {
		this.calls.push({ method: "navigate", value: url });
		this.openState = true;
		return browserState(true);
	}

	back(): AgentBrowserState {
		this.calls.push({ method: "back" });
		return browserState(this.openState);
	}

	forward(): AgentBrowserState {
		this.calls.push({ method: "forward" });
		return browserState(this.openState);
	}

	reload(): AgentBrowserState {
		this.calls.push({ method: "reload" });
		return browserState(this.openState);
	}

	abstract snapshot(options: AgentBrowserSnapshotOptions): Promise<string>;

	async click(target: AgentBrowserTarget): Promise<string> {
		this.calls.push({ method: "click", value: structuredClone(target) });
		return "已点击";
	}

	async hover(target: AgentBrowserTarget): Promise<string> {
		this.calls.push({ method: "hover", value: structuredClone(target) });
		return "已悬浮";
	}

	async type(target: AgentBrowserTarget, value: string, pressEnter: boolean, commit: boolean): Promise<string> {
		this.calls.push({ method: "type", value: { target: structuredClone(target), value, pressEnter, commit } });
		return "已输入";
	}

	async scroll(direction: "up" | "down" | "left" | "right", amount: number): Promise<string> {
		this.calls.push({ method: "scroll", value: { direction, amount } });
		return "已滚动";
	}

	async extract(selector: string | undefined, maxChars: number): Promise<string> {
		this.calls.push({ method: "extract", value: { selector, maxChars } });
		return "";
	}

	async screenshot(path: string): Promise<string> {
		this.calls.push({ method: "screenshot", value: path });
		return path;
	}

	async wait(milliseconds: number, text?: string): Promise<string> {
		this.calls.push({ method: "wait", value: { milliseconds, text } });
		return text ? `网页已出现文字：${text}` : "等待完成";
	}

	async uploadFiles(
		files: AgentBrowserUploadFile[],
		target: AgentBrowserTarget | undefined,
		allowedOrigin?: string,
	): Promise<string> {
		this.uploadAllowedOrigins.push(allowedOrigin);
		this.calls.push({
			method: "uploadFiles",
			value: { names: files.map((file) => file.name), target: structuredClone(target) },
		});
		return `已选择文件：${files.map((file) => file.name).join("、")}`;
	}
}

function applicationSearchSnapshot(): string {
	return [
		"标题：合思",
		"可操作元素：",
		"[e1] input 搜索标题和单号 (placeholder=搜索标题和单号 type=text)",
		"页面正文：",
		"请选择关联申请",
	].join("\n");
}

interface ApplicationCandidateFixture {
	id: string;
	title: string;
	reason?: string;
	startDate?: string;
	endDate?: string;
	expenseNature?: "部门费用" | "项目费用";
	fromCity?: string;
	toCity?: string;
}

function applicationCandidatesSnapshot(candidates: ApplicationCandidateFixture[], withConfirm = false): string {
	const details = candidates.map(
		(candidate) =>
			`${candidate.title} ${candidate.id} | ${candidate.startDate ?? "2026-08-21"} 至 ${candidate.endDate ?? "2026-08-21"} | 无金额 | 详情`,
	);
	const rows = candidates.map(
		(candidate, index) =>
			`[e${index + 1}] input （无文字） (label=${candidate.title} ${candidate.id} 申请事由：${candidate.reason ?? candidate.title.replace(/^出差申请[：:]\s*/, "")} 费用性质：${candidate.expenseNature ?? "部门费用"} type=radio)`,
	);
	if (withConfirm) rows.push("[e90] button 确认 (type=button)");
	return ["标题：合思", "可操作元素：", ...rows, "页面正文：", ...details].join("\n");
}

function unselectedApplicationSnapshot(): string {
	return [
		"标题：合思",
		"可操作元素：",
		"[e1] button 存为草稿 (testid=flexable-button-edit type=button)",
		"[e2] textarea （无文字） (label=报销说明 testid=field-text-u_事由 type=text)",
		"[e3] div 部门费用 (label=费用性质 testid=custom-dimension-tree-select)",
		"页面正文：",
		"差旅费用报销单",
	].join("\n");
}

function selectedApplicationSnapshot(
	overrides: {
		id?: string;
		title?: string;
		reason?: string;
		startDate?: string;
		endDate?: string;
		expenseNature?: "部门费用" | "项目费用";
	} = {},
): string {
	const id = overrides.id ?? "S26002261";
	const title = overrides.title ?? "出差申请：常州业务拓展";
	const reason = overrides.reason ?? "常州业务拓展";
	const startDate = overrides.startDate ?? "2026-08-21";
	const endDate = overrides.endDate ?? "2026-08-21";
	const expenseNature = overrides.expenseNature ?? "部门费用";
	return [
		"标题：合思",
		"可操作元素：",
		"[e1] button 存为草稿 (testid=flexable-button-edit type=button)",
		`[e2] input/disabled 差旅费报销：${reason} (label=标题 testid=field-text-title placeholder=请输入标题 type=text)`,
		`[e3] textarea ${reason} (label=报销说明 testid=field-text-u_事由 type=text)`,
		`[e4] div ${expenseNature} (label=费用性质 testid=custom-dimension-tree-select)`,
		`[e5] input/disabled ${startDate} (label=申请单中的差旅起止日期 placeholder=开始日期)`,
		`[e6] input/disabled ${endDate} (label=申请单中的差旅起止日期 placeholder=结束日期)`,
		"页面正文：",
		"差旅费用报销单",
		title,
		id,
	].join("\n");
}

class QueueRuntime extends FakeRuntime {
	private readonly snapshots: string[];

	constructor(snapshots: string[]) {
		super();
		this.snapshots = snapshots;
	}

	async snapshot(options: AgentBrowserSnapshotOptions): Promise<string> {
		this.calls.push({ method: "snapshot", value: structuredClone(options) });
		const value = this.snapshots.shift();
		if (!value) throw new Error("测试快照队列已耗尽");
		return value;
	}
}

function trustedApplicationPage(
	overlay: EkuaibaoTrustedPageState["overlay"],
	digest: string,
	applicationSource?: EkuaibaoTrustedApplicationSourceState,
): EkuaibaoTrustedPageState {
	return {
		contractVersion: EKUAIBAO_TRUSTED_CONTRACT_VERSION,
		pageToken: "trusted-application-page",
		pageFingerprint: EKUAIBAO_TRUSTED_PAGE_FINGERPRINT,
		route: "bill-entry-detail",
		overlay,
		digest,
		fields: {},
		controls: {},
		multipleRecipients: { present: true, checked: false, source: "native-input" },
		...(applicationSource ? { applicationSource } : {}),
		validationErrors: [],
		foldedDetails: [],
		draftConfirmationVisible: false,
	};
}

class TrustedApplicationDetailsRuntime extends QueueRuntime {
	private trustedState = trustedApplicationPage("none", "trusted-main");
	private readonly applicationSource: EkuaibaoTrustedApplicationSourceState;
	private readonly failOpen: boolean;

	constructor(
		snapshots: string[],
		applicationSource: EkuaibaoTrustedApplicationSourceState,
		options: { failOpen?: boolean } = {},
	) {
		super(snapshots);
		this.applicationSource = applicationSource;
		this.failOpen = options.failOpen === true;
	}

	async runEkuaibaoTrustedCommand(command: EkuaibaoTrustedCommand): Promise<EkuaibaoTrustedResult> {
		this.calls.push({ method: "trusted", value: structuredClone(command) });
		if (command.op === "inspect") return this.success(this.trustedState);
		if (command.pageToken !== this.trustedState.pageToken || command.expectedDigest !== this.trustedState.digest) {
			return { ok: false, code: "stale_state", message: "测试可信状态已过期" };
		}
		if (command.op === "click" && command.control === "open-application") {
			this.trustedState = trustedApplicationPage("application-dialog", "trusted-dialog");
			return this.success(this.trustedState);
		}
		if (command.op === "type" && command.field === "application-search") {
			this.trustedState = trustedApplicationPage("application-dialog", "trusted-search");
			return this.success(this.trustedState);
		}
		if (command.op === "select-exact") {
			this.trustedState = trustedApplicationPage("application-dialog", "trusted-selected");
			return this.success(this.trustedState);
		}
		if (command.op === "click" && command.control === "open-application-details") {
			if (this.failOpen) return { ok: false, code: "contract_mismatch", message: "详情契约不匹配" };
			this.trustedState = trustedApplicationPage("application-details", "trusted-details", this.applicationSource);
			return this.success(this.trustedState);
		}
		if (command.op === "click" && command.control === "close-application-details") {
			this.trustedState = trustedApplicationPage("application-dialog", "trusted-closed");
			return this.success(this.trustedState);
		}
		if (command.op === "click" && command.control === "confirm-application") {
			this.trustedState = trustedApplicationPage("none", "trusted-confirmed");
			return this.success(this.trustedState);
		}
		return { ok: false, code: "invalid_command", message: "测试不支持该可信命令" };
	}

	private success(state: EkuaibaoTrustedPageState): EkuaibaoTrustedResult {
		return {
			ok: true,
			message: "测试可信命令成功",
			beforeDigest: state.digest,
			afterDigest: state.digest,
			state,
		};
	}
}

const FEE_TYPE = "差旅-城市间交通费-火车I高铁";

class InvoiceFlowRuntime extends FakeRuntime {
	drawerOpen = false;
	feeTypeTyped = false;
	feeTypeSelected = false;
	menuOpen = false;
	invoiceDialog = false;
	invoiceUploaded = false;
	recognized = false;
	invoiceSelected = false;
	invoiceBound = false;
	attachmentsUploaded = false;
	saved = false;
	reporterSelected: boolean;
	paymentSelected: boolean;
	recipientPicker: "费用报销人" | "支付信息" | undefined;
	readonly multipleInvoiceInputs: boolean;
	readonly ordinaryAttachmentVisibleInInvoiceArea: boolean;
	readonly omitRecognitionIdentity: boolean;
	readonly invoiceCheckboxClickNoop: boolean;
	readonly foldedReimbursementAmount: number;
	readonly foldedDistrictCities: boolean;
	readonly foldedExpenseReporter: boolean;
	readonly foldedPaymentAccount: boolean;
	readonly recipientSelectionNoop: boolean;
	readonly bankPaymentDisplay: boolean;
	readonly dropAttachmentsAfterSave: boolean;
	readonly swapInvoiceAfterSave: boolean;
	readonly omitBoundInvoiceIdentity: boolean;
	readonly invoiceBindingOverwritesFields: boolean;
	readonly postSaveInvoiceAmount: number | undefined;
	readonly postSaveInvoiceCount: number | undefined;
	private recognitionSnapshotsRemaining: number;
	private readonly recognitionFails: boolean;
	private startDateValue = "2026-08-21";
	private endDateValue = "2026-08-21";
	private fromCityValue = "江苏省/南京";
	private toCityValue = "江苏省/常州";
	private seatClassValue = "二等座";
	private amountValue = 72;
	private cityPicker: "出发城市" | "到达城市" | undefined;
	readonly ticketName: string;
	readonly verificationName: string;
	private readonly expected: TravelDraftExpected;

	constructor(
		expected: TravelDraftExpected,
		options: {
			multipleInvoiceInputs?: boolean;
			ordinaryAttachmentVisibleInInvoiceArea?: boolean;
			omitRecognitionIdentity?: boolean;
			invoiceCheckboxClickNoop?: boolean;
			foldedReimbursementAmount?: number;
			foldedDistrictCities?: boolean;
			foldedExpenseReporter?: boolean;
			foldedPaymentAccount?: boolean;
			reporterInitiallyEmpty?: boolean;
			paymentInitiallyEmpty?: boolean;
			recipientSelectionNoop?: boolean;
			bankPaymentDisplay?: boolean;
			dropAttachmentsAfterSave?: boolean;
			swapInvoiceAfterSave?: boolean;
			recognitionDelaySnapshots?: number;
			recognitionFails?: boolean;
			omitBoundInvoiceIdentity?: boolean;
			invoiceBindingOverwritesFields?: boolean;
			postSaveInvoiceAmount?: number;
			postSaveInvoiceCount?: number;
		} = {},
	) {
		super();
		this.expected = expected;
		this.multipleInvoiceInputs = options.multipleInvoiceInputs === true;
		this.ordinaryAttachmentVisibleInInvoiceArea = options.ordinaryAttachmentVisibleInInvoiceArea === true;
		this.omitRecognitionIdentity = options.omitRecognitionIdentity === true;
		this.invoiceCheckboxClickNoop = options.invoiceCheckboxClickNoop === true;
		this.foldedReimbursementAmount = options.foldedReimbursementAmount ?? expected.transport[0].amount;
		this.foldedDistrictCities = options.foldedDistrictCities === true;
		this.foldedExpenseReporter = options.foldedExpenseReporter !== false;
		this.foldedPaymentAccount = options.foldedPaymentAccount !== false;
		this.reporterSelected = options.reporterInitiallyEmpty !== true;
		this.paymentSelected = options.paymentInitiallyEmpty !== true;
		this.recipientSelectionNoop = options.recipientSelectionNoop === true;
		this.bankPaymentDisplay = options.bankPaymentDisplay === true;
		this.dropAttachmentsAfterSave = options.dropAttachmentsAfterSave === true;
		this.swapInvoiceAfterSave = options.swapInvoiceAfterSave === true;
		this.recognitionSnapshotsRemaining = options.recognitionDelaySnapshots ?? 0;
		this.recognitionFails = options.recognitionFails === true;
		this.omitBoundInvoiceIdentity = options.omitBoundInvoiceIdentity === true;
		this.invoiceBindingOverwritesFields = options.invoiceBindingOverwritesFields === true;
		this.postSaveInvoiceAmount = options.postSaveInvoiceAmount;
		this.postSaveInvoiceCount = options.postSaveInvoiceCount;
		this.ticketName = basename(expected.transport[0].uploadFile);
		this.verificationName = basename(expected.transport[0].verificationFiles[0]);
	}

	private detailForm(extra: string[] = []): string {
		const payment = this.bankPaymentDisplay ? "招商银行 6214 **** 苏爱健" : "苏爱健（个人账户）";
		return [
			"标题：合思",
			"可操作元素：",
			`[e1] div ${FEE_TYPE} (testid=template-feeType-item)`,
			`[e2] input ${this.startDateValue} (label=差旅起止日期 placeholder=开始日期)`,
			`[e3] input ${this.endDateValue} (label=差旅起止日期 placeholder=结束日期)`,
			"[e16] label 出发城市",
			`[e4] input/combobox ${this.fromCityValue} (type=search)`,
			"[e17] label 到达城市",
			`[e5] input/combobox ${this.toCityValue} (type=search)`,
			"[e18] label 乘坐火车席别",
			`[e6] input/combobox ${this.seatClassValue} (type=search)`,
			`[e7] button ${this.reporterSelected ? "苏爱健" : "请选择费用报销人"} (label=费用报销人)`,
			`[e8] input ${this.amountValue} (placeholder=请输入报销费用金额 type=text)`,
			`[e9] div ${this.paymentSelected ? payment : "请选择支付信息"} (label=支付信息 placeholder=请选择支付信息)`,
			"[e10] button 添加发票 (label=上传发票 type=button)",
			"[e11] button 保存 (testid=feetype-footer-save type=button)",
			"[e15] button 取消 (type=button)",
			...extra,
			"页面正文：",
			"添加明细",
			FEE_TYPE,
			"2026-08-21",
			"南京 常州 二等座 苏爱健 72",
			...extra.map((line) => line.replace(/^\[e\d+\]\s+\S+\s+/, "")),
		].join("\n");
	}

	private savedDetail(): string {
		const reimbursement = this.foldedReimbursementAmount.toFixed(2);
		const fromPath = this.foldedDistrictCities ? "江苏省/南京市/雨花台区" : "江苏省/南京市";
		const toPath = this.foldedDistrictCities ? "江苏省/常州市/天宁区" : "江苏省/常州市";
		const reporter = this.foldedExpenseReporter ? "苏爱健（CIC023）" : "其他用户（CIC999）";
		const payment = this.foldedPaymentAccount ? "苏爱健（个人账户）" : "未选择个人账户";
		return [
			"标题：合思",
			"可操作元素：",
			`[e20] div ${FEE_TYPE}（COST68） 2026-08-21 – 2026-08-21 差旅天数：1天 出发城市：${fromPath} 到达城市：${toPath} 乘坐火车席别：二等座 费用报销人：${reporter} 报销费用金额：¥${reimbursement} 核减金额：¥0.00 费用说明：无 发票金额：¥72.00 支付方式：全额支付`,
			"页面正文：",
			`${FEE_TYPE}（COST68） 2026-08-21 – 2026-08-21 差旅天数：1天 出发城市：${fromPath} 到达城市：${toPath} 乘坐火车席别：二等座 费用报销人：${reporter} 报销费用金额：¥${reimbursement} 核减金额：¥0.00 费用说明：无 发票金额：¥72.00 支付方式：全额支付`,
			"已有发票*1",
			payment,
			"CNY 72.00",
		].join("\n");
	}

	private mainForm(): string {
		return [
			"标题：合思",
			"可操作元素：",
			"[e1] button 存为草稿 (testid=flexable-button-edit type=button)",
			"页面正文：",
			"差旅费用报销单",
			`费用明细（${this.saved ? 1 : 0}）`,
			"CNY 252.00",
		].join("\n");
	}

	async snapshot(options: AgentBrowserSnapshotOptions): Promise<string> {
		this.calls.push({ method: "snapshot", value: structuredClone(options) });
		const scope = options.scopeTexts ?? [];
		if (this.recipientPicker && scope.includes("苏爱健")) {
			const text =
				this.recipientPicker === "支付信息"
					? this.bankPaymentDisplay
						? "招商银行 6214 **** 苏爱健"
						: "苏爱健（个人账户）"
					: "苏爱健（CIC023）";
			return ["可操作元素：", "[e29] div 苏爱健（个人账户）", `[e30] div/option ${text}`, "页面正文：", text].join(
				"\n",
			);
		}
		if (this.cityPicker && scope.length === 1) {
			const city = this.cityPicker === "出发城市" ? "南京" : "常州";
			if (scope[0] === city) {
				const ref = this.cityPicker === "出发城市" ? "e31" : "e32";
				return `[${ref}] div/option 城市 ${city} 中国 / 江苏省 / ${city} (testid=entity-profile)`;
			}
		}
		if (scope.includes("添加明细") && scope.includes("费用类型")) {
			return [
				"可操作元素：",
				"[e0] input/combobox 请选择费用类型 (placeholder=请选择费用类型 type=search)",
				...(this.feeTypeTyped ? [`[e1] div ${FEE_TYPE} (testid=template-feeType-item)`] : []),
				"页面正文：",
				"添加明细 费用类型 请选择费用类型 请先选择费用类型",
			].join("\n");
		}
		if (this.drawerOpen && !this.feeTypeSelected && scope.includes("添加明细") && scope.includes(FEE_TYPE)) {
			return this.feeTypeTyped
				? ["可操作元素：", `[e1] div ${FEE_TYPE} (testid=template-feeType-item)`, "页面正文：", FEE_TYPE].join("\n")
				: `${SNAPSHOT_SCOPE_MISS_FOR_TEST} ${FEE_TYPE}`;
		}
		if (scope.includes("智能识票") && scope.includes("上传文件")) {
			const inputs = this.multipleInvoiceInputs
				? ["[e1] input （无文字） (type=file)", "[e2] input （无文字） (type=file)"]
				: ["[e1] input （无文字） (type=file)"];
			return [
				"标题：合思",
				"可操作元素：",
				...inputs,
				...(this.invoiceUploaded ? [`[e3] div ${this.ticketName}`] : []),
				"[e4] button 确定 (type=button)",
				"页面正文：",
				"智能识票 上传文件",
				...(this.invoiceUploaded ? [this.ticketName] : []),
			].join("\n");
		}
		if (scope.includes("智能识票")) {
			return ["可操作元素：", "[e1] button 智能识票 (type=button)", "页面正文：", "智能识票"].join("\n");
		}
		if (scope.length === 1 && scope[0] === "与该消费绑定") {
			return "[e7] button/disabled 与该消费绑定 (type=button)";
		}
		if (scope.includes("通过智能识票识别出") && scope.includes("与该消费绑定")) {
			const row = this.expected.transport[0];
			if (!this.recognized) {
				if (this.recognitionSnapshotsRemaining > 0) {
					this.recognitionSnapshotsRemaining -= 1;
					return `${SNAPSHOT_SCOPE_MISS_FOR_TEST} 通过智能识票识别出 / 与该消费绑定`;
				}
				if (this.recognitionFails) return "页面正文：识别失败";
				this.recognized = true;
			}
			return [
				"可操作元素：",
				"[e1] label 全选已选 0 张发票, 共¥0 (label=全选已选 0 张发票, 共¥0)",
				"[e2] input （无文字） (label=全选已选 0 张发票, 共¥0 type=checkbox)",
				"[e3] label 通过智能识票识别出 1 张发票 (label=通过智能识票识别出 1 张发票)",
				"[e4] input （无文字） (label=通过智能识票识别出 1 张发票 type=checkbox)",
				"[e5] label 南京 - 常州 (label=南京 - 常州)",
				`[e6] input （无文字） (label=南京 - 常州 type=checkbox checked=${this.invoiceSelected} aria-checked=${this.invoiceSelected})`,
				`[e7] button${this.invoiceSelected ? "" : "/disabled"} 与该消费绑定 (type=button)`,
				"页面正文：",
				"通过智能识票识别出 1 张发票",
				...(this.omitRecognitionIdentity
					? []
					: [
							row.invoiceNumber,
							`${row.fromStation?.replace(/站$/, "")} - ${row.toStation?.replace(/站$/, "")}`,
							`${row.travelDate} 铁路电子客票 已验真 ¥${row.amount.toFixed(2)}`,
						]),
				"南京 - 常州",
				"与该消费绑定",
			].join("\n");
		}
		if (scope.includes(FEE_TYPE) && scope.includes("上传发票")) {
			const row = this.expected.transport[0];
			const invoiceNumber = this.saved && this.swapInvoiceAfterSave ? "TEST-OTHER-999" : row.invoiceNumber;
			const invoiceAmount = this.saved ? (this.postSaveInvoiceAmount ?? 72) : 72;
			const invoiceCount = this.saved ? (this.postSaveInvoiceCount ?? 1) : 1;
			return this.detailForm(
				this.invoiceBound
					? [
							`[e12] div ${this.ticketName}`,
							`[e13] button 已有发票*${invoiceCount}`,
							...(this.omitBoundInvoiceIdentity ? [] : [`[e14] div 发票号码：${invoiceNumber}`]),
							`[e19] div CNY ${invoiceAmount.toFixed(2)}`,
						]
					: this.ordinaryAttachmentVisibleInInvoiceArea
						? [`[e12] div ${this.ticketName}`]
						: [],
			);
		}
		if (scope.includes(FEE_TYPE) && scope.includes("附件")) {
			return this.detailForm([
				"[e12] input （无文字） (type=file)",
				...(this.attachmentsUploaded && !(this.saved && this.dropAttachmentsAfterSave)
					? [`[e13] div ${this.ticketName}`, `[e14] div ${this.verificationName}`]
					: []),
			]);
		}
		if (scope.includes(FEE_TYPE) && scope.includes("出发城市")) {
			return this.detailForm();
		}
		if (scope.includes(FEE_TYPE) && scope.includes("到达城市")) {
			return this.detailForm();
		}
		if (scope.includes(FEE_TYPE) && scope.includes("乘坐火车席别")) {
			return this.detailForm();
		}
		if (scope.includes(FEE_TYPE) && scope.includes("报销费用金额")) {
			return [
				"可操作元素：",
				`[e8] input ${this.amountValue} (placeholder=请输入报销费用金额 type=text)`,
				"页面正文：",
				`${FEE_TYPE} 报销费用金额 ${this.amountValue}`,
			].join("\n");
		}
		if (scope.length === 1 && scope[0] === "二等座") {
			return [
				"可操作元素：",
				"[e0] div 二等座",
				"[e1] div/option 二等座（ED）",
				"[e2] div/option 卧代二等座（WDEDZ）",
				"页面正文：",
				"二等座（ED） 卧代二等座（WDEDZ）",
			].join("\n");
		}
		if (this.drawerOpen && this.feeTypeSelected && scope.length === 1 && scope[0] === FEE_TYPE) {
			return `[e19] div ${FEE_TYPE} (testid=template-feeType-item)`;
		}
		if (scope.includes(FEE_TYPE) && scope.includes("南京") && scope.includes("常州")) {
			return this.saved ? this.savedDetail() : `${SNAPSHOT_SCOPE_MISS_FOR_TEST} ${scope.join(" / ")}`;
		}
		if (scope.some((item) => item.includes("差旅-出差补助"))) {
			return `${SNAPSHOT_SCOPE_MISS_FOR_TEST} ${scope.join(" / ")}`;
		}
		if (scope[0] === FEE_TYPE && !this.drawerOpen) {
			if (scope.length === 1) return `[e19] div ${FEE_TYPE} (testid=template-feeType-item)`;
			const row = this.expected.transport[0];
			if (scope.includes(row.startDate) && scope.includes(`¥${row.amount.toFixed(2)}`)) {
				return this.saved ? this.savedDetail() : `${SNAPSHOT_SCOPE_MISS_FOR_TEST} ${scope.join(" / ")}`;
			}
			return `${SNAPSHOT_SCOPE_MISS_FOR_TEST} ${scope.join(" / ")}`;
		}
		if (scope.length > 0 && scope.includes(FEE_TYPE) && this.drawerOpen) return this.detailForm();
		return this.mainForm();
	}

	async click(target: AgentBrowserTarget): Promise<string> {
		await super.click(target);
		if (target.ref === "e7" && this.drawerOpen && !this.reporterSelected && !this.invoiceDialog) {
			this.recipientPicker = "费用报销人";
		}
		if (target.ref === "e9" && this.drawerOpen && !this.paymentSelected && !this.invoiceDialog) {
			this.recipientPicker = "支付信息";
		}
		if (target.ref === "e30" && this.recipientPicker) {
			if (!this.recipientSelectionNoop) {
				if (this.recipientPicker === "费用报销人") this.reporterSelected = true;
				else this.paymentSelected = true;
			}
			this.recipientPicker = undefined;
		}
		if (target.selector === '[data-testid="field-expenseDetail-add"]') {
			this.drawerOpen = true;
			this.feeTypeTyped = false;
			this.feeTypeSelected = false;
		}
		if (target.ref === "e1" && this.drawerOpen && this.feeTypeTyped && !this.feeTypeSelected && !this.menuOpen) {
			this.feeTypeSelected = true;
		}
		if (target.ref === "e1" && this.menuOpen) {
			this.invoiceDialog = true;
			this.menuOpen = false;
		}
		if (target.ref === "e4" && this.invoiceDialog && this.invoiceUploaded) {
			this.invoiceDialog = false;
			this.recognized = this.recognitionSnapshotsRemaining === 0 && !this.recognitionFails;
		}
		if (target.ref === "e6" && this.recognized && !this.invoiceCheckboxClickNoop) this.invoiceSelected = true;
		if (target.ref === "e7" && this.invoiceSelected && target.scopeTexts?.includes("与该消费绑定")) {
			this.invoiceBound = true;
			if (this.invoiceBindingOverwritesFields) {
				this.startDateValue = "2026-08-20";
				this.endDateValue = "2026-08-20";
				this.fromCityValue = "江苏省/南京市/雨花台区";
				this.toCityValue = "江苏省/常州市/天宁区";
				this.seatClassValue = "一等座";
				this.amountValue = 999;
				this.reporterSelected = false;
				this.paymentSelected = false;
			}
		}
		if ((target.ref === "e31" || target.ref === "e32") && this.cityPicker) this.cityPicker = undefined;
		if (target.selector === '[data-testid="feetype-footer-save"]') {
			this.saved = true;
			this.drawerOpen = false;
		}
		if (target.ref === "e20" && this.saved) {
			this.drawerOpen = true;
			this.feeTypeSelected = true;
		}
		if (target.ref === "e15" && this.drawerOpen) this.drawerOpen = false;
		return "已点击";
	}

	override async type(
		target: AgentBrowserTarget,
		value: string,
		pressEnter: boolean,
		commit: boolean,
	): Promise<string> {
		const output = await super.type(target, value, pressEnter, commit);
		if (target.ref === "e0" && value === FEE_TYPE) this.feeTypeTyped = true;
		if (target.ref === "e2") this.startDateValue = value;
		if (target.ref === "e3") this.endDateValue = value;
		if (target.ref === "e4") {
			this.fromCityValue = "江苏省/南京";
			this.cityPicker = "出发城市";
		}
		if (target.ref === "e5") {
			this.toCityValue = "江苏省/常州";
			this.cityPicker = "到达城市";
		}
		if (target.ref === "e6") this.seatClassValue = value;
		if (target.ref === "e8") this.amountValue = Number(value);
		return output;
	}

	async hover(target: AgentBrowserTarget): Promise<string> {
		await super.hover(target);
		this.menuOpen = true;
		return "已悬浮";
	}

	async uploadFiles(
		files: AgentBrowserUploadFile[],
		target: AgentBrowserTarget | undefined,
		allowedOrigin?: string,
	): Promise<string> {
		await super.uploadFiles(files, target, allowedOrigin);
		if (target?.ref === "e1" && this.invoiceDialog) this.invoiceUploaded = true;
		if (target?.ref === "e12") this.attachmentsUploaded = true;
		return `已选择文件：${files.map((file) => file.name).join("、")}`;
	}
}

const SNAPSHOT_SCOPE_MISS_FOR_TEST = "范围文字未找到：";

const ALLOWANCE_FEE_TYPE = "差旅-出差补助";
const HOTEL_FEE_TYPE = "差旅-住宿费";

type HiddenDetailDrift = {
	field: "attachment" | "invoice" | "payment";
	reopenNumber: number;
};

interface CompleteRuntimeOptions {
	preboundSecondTransport?: boolean;
	hotelRecognitionCount?: number;
	hiddenDetailDrift?: HiddenDetailDrift;
	draftFailure?: "interrupt_after_click" | "snapshot_after_click";
}

class UnknownExistingDetailRuntime extends FakeRuntime {
	private readonly detailCounts: number[] | undefined;

	constructor(detailCount: number | number[] | undefined) {
		super();
		this.detailCounts = Array.isArray(detailCount)
			? detailCount
			: detailCount === undefined
				? undefined
				: [detailCount];
		this.openState = true;
	}

	async snapshot(options: AgentBrowserSnapshotOptions): Promise<string> {
		this.calls.push({ method: "snapshot", value: structuredClone(options) });
		if (options.scopeTexts?.length) return `${SNAPSHOT_SCOPE_MISS_FOR_TEST} ${options.scopeTexts.join(" / ")}`;
		return [
			"标题：合思",
			"可操作元素：",
			"[e1] button 存为草稿 (testid=flexable-button-edit type=button)",
			"页面正文：",
			"差旅费用报销单",
			...(this.detailCounts ? this.detailCounts.map((count) => `费用明细（${count}）`) : ["费用明细"]),
			`${FEE_TYPE} 出发城市：江苏省/南京市/雨花台区 到达城市：江苏省/常州市/天宁区 报销费用金额：¥999.00`,
		].join("\n");
	}
}

class CompleteTwoRailRuntime extends FakeRuntime {
	protected readonly expected: TravelDraftExpected;
	protected readonly preboundSecondTransport: boolean;
	protected readonly hotelRecognitionCount: number;
	protected readonly savedKeys = new Set<string>();
	protected drawerOpen = false;
	protected typedFeeType: string | undefined;
	protected feeTypeSelected = false;
	protected activeRow:
		| TravelDraftTransportExpected
		| TravelDraftHotelExpected
		| TravelDraftAllowanceExpected
		| undefined;
	protected reporterSelected = false;
	protected paymentSelected = false;
	protected recipientPicker: "费用报销人" | "支付信息" | undefined;
	protected invoiceMenuOpen = false;
	protected invoiceDialog = false;
	protected invoiceUploaded = false;
	protected recognized = false;
	protected invoiceSelected = false;
	protected invoiceBound = false;
	protected attachmentsUploaded = false;
	protected draftSaved = false;
	protected applicationDialog = false;
	protected applicationSearchTyped = false;
	protected applicationCandidateSelected = false;
	protected applicationConfirmed = false;
	private readonly hiddenDetailDrift: HiddenDetailDrift | undefined;
	private readonly draftFailure: CompleteRuntimeOptions["draftFailure"];
	private readonly detailReopenCounts = new Map<string, number>();
	private failNextSnapshotAfterDraftClick = false;
	private draftExplicitSuccess = true;
	private draftConfirmationText = "草稿保存成功";
	private staleDraftConfirmations = 0;

	constructor(expected: TravelDraftExpected, options: CompleteRuntimeOptions = {}) {
		super();
		this.expected = expected;
		this.preboundSecondTransport = options.preboundSecondTransport === true;
		this.hotelRecognitionCount = options.hotelRecognitionCount ?? 1;
		this.hiddenDetailDrift = options.hiddenDetailDrift;
		this.draftFailure = options.draftFailure;
	}

	configureDraftSave(options: {
		explicitSuccess?: boolean;
		staleBeforeClick?: number;
		confirmationText?: string;
	}): void {
		this.draftExplicitSuccess = options.explicitSuccess ?? true;
		this.staleDraftConfirmations = options.staleBeforeClick ?? 0;
		this.draftConfirmationText = options.confirmationText ?? "草稿保存成功";
	}

	protected activeInvoiceRow(): TravelDraftTransportExpected | TravelDraftHotelExpected | undefined {
		return this.activeRow?.kind === "allowance" ? undefined : this.activeRow;
	}

	protected nextTransport(): TravelDraftTransportExpected | undefined {
		return this.expected.transport.find((row) => !this.savedKeys.has(row.key));
	}

	protected rowFeeType(): string | undefined {
		if (this.activeRow?.kind === "transport") return FEE_TYPE;
		if (this.activeRow?.kind === "hotel") return HOTEL_FEE_TYPE;
		if (this.activeRow?.kind === "allowance") return ALLOWANCE_FEE_TYPE;
		return undefined;
	}

	protected rowDates(): { startDate: string; endDate: string } | undefined {
		const row = this.activeRow;
		if (!row) return undefined;
		return row.kind === "hotel"
			? { startDate: row.checkinDate, endDate: row.checkoutDate }
			: { startDate: row.startDate, endDate: row.endDate };
	}

	protected resetDrawer(): void {
		this.typedFeeType = undefined;
		this.feeTypeSelected = false;
		this.activeRow = undefined;
		this.reporterSelected = false;
		this.paymentSelected = false;
		this.recipientPicker = undefined;
		this.invoiceMenuOpen = false;
		this.invoiceDialog = false;
		this.invoiceUploaded = false;
		this.recognized = false;
		this.invoiceSelected = false;
		this.invoiceBound = false;
		this.attachmentsUploaded = false;
	}

	protected applyHiddenDetailDrift(
		row: TravelDraftTransportExpected | TravelDraftHotelExpected | TravelDraftAllowanceExpected,
	): void {
		const reopenNumber = (this.detailReopenCounts.get(row.key) ?? 0) + 1;
		this.detailReopenCounts.set(row.key, reopenNumber);
		if (!this.hiddenDetailDrift || row.key !== this.expected.transport[0]?.key) return;
		if (reopenNumber !== this.hiddenDetailDrift.reopenNumber) return;
		if (this.hiddenDetailDrift.field === "payment") this.paymentSelected = false;
		if (this.hiddenDetailDrift.field === "invoice") this.invoiceBound = false;
		if (this.hiddenDetailDrift.field === "attachment") this.attachmentsUploaded = false;
	}

	protected mainSnapshot(): string {
		const total = [
			...this.expected.transport,
			...(this.expected.hotel ? [this.expected.hotel] : []),
			this.expected.allowance,
		]
			.filter((row) => this.savedKeys.has(row.key))
			.reduce((sum, row) => sum + row.amount, 0);
		const staleConfirmation = !this.draftSaved && this.staleDraftConfirmations > 0;
		if (staleConfirmation) this.staleDraftConfirmations -= 1;
		return [
			"标题：合思",
			"可操作元素：",
			"[e1] button 存为草稿 (testid=flexable-button-edit type=button)",
			`[e2] textarea ${this.applicationConfirmed ? this.expected.header.explanation : "（无文字）"} (label=报销说明 testid=field-text-u_事由 type=text)`,
			"[e3] div 苏爱健 (label=提交人)",
			"[e4] input 江苏省/南京 (label=驻地 type=search)",
			"[e5] div 赛昇信息技术研究院江苏有限公司 (label=所属公司 testid=custom-dimension-tree-select)",
			`[e6] input ${this.expected.header.reimbursementDate} (label=报销日期 placeholder=请选择日期 type=text)`,
			`[e7] div ${this.expected.header.expenseNature} (label=费用性质)`,
			`[e8] div ${TRAVEL_DRAFT_DEPARTMENT} (label=申请人部门)`,
			`[e9] div ${TRAVEL_DRAFT_DEPARTMENT} (label=费用所属部门)`,
			"[e10] input （无文字） (label=是否为多收款人 type=checkbox checked=false aria-checked=false)",
			...(this.applicationConfirmed
				? [
						`[e11] input/disabled ${this.expected.application.startDate} (label=申请单中的差旅起止日期 placeholder=开始日期)`,
						`[e12] input/disabled ${this.expected.application.endDate} (label=申请单中的差旅起止日期 placeholder=结束日期)`,
						`[e13] input/disabled 差旅费报销：${this.expected.application.reason} (label=标题 testid=field-text-title placeholder=请输入标题 type=text)`,
					]
				: []),
			"[e14] div 苏爱健（个人账户） (label=支付信息)",
			`[e40] div CNY ${total.toFixed(2)} (label=支付金额总计 testid=payment-amount-total)`,
			"页面正文：",
			"差旅费用报销单",
			...(this.applicationConfirmed ? [this.expected.application.title, this.expected.application.id] : []),
			`费用明细（${this.savedKeys.size}）`,
			...(staleConfirmation ? [this.draftConfirmationText] : []),
			...(this.draftSaved && this.draftExplicitSuccess ? [this.draftConfirmationText] : []),
		].join("\n");
	}

	protected applicationCandidateSnapshot(): string {
		const application = this.expected.application;
		return [
			"可操作元素：",
			`[e301] input （无文字） (label=${application.title} ${application.id} 申请事由：${application.reason} 费用性质：${application.expenseNature} type=radio)`,
			...(this.applicationCandidateSelected ? ["[e302] button 确认 (type=button)"] : []),
			"页面正文：",
			`${application.title} ${application.id} | ${application.startDate} 至 ${application.endDate} | 无金额 | 详情`,
		].join("\n");
	}

	protected detailForm(extra: string[] = []): string {
		const row = this.activeRow;
		if (!row) return `${SNAPSHOT_SCOPE_MISS_FOR_TEST} 当前明细`;
		const feeType = this.rowFeeType();
		const dates = this.rowDates();
		if (!feeType || !dates) return `${SNAPSHOT_SCOPE_MISS_FOR_TEST} 当前明细`;
		const common = [
			`[e2] input ${dates.startDate} (label=差旅起止日期 placeholder=开始日期)`,
			`[e3] input ${dates.endDate} (label=差旅起止日期 placeholder=结束日期)`,
			`[e7] button ${this.reporterSelected ? "苏爱健" : "请选择费用报销人"} (label=费用报销人)`,
			`[e8] input ${row.amount} (placeholder=请输入报销费用金额 type=text)`,
			`[e9] div ${this.paymentSelected ? "苏爱健（个人账户）" : "请选择支付信息"} (label=支付信息 placeholder=请选择支付信息)`,
			"[e11] button 保存 (testid=feetype-footer-save type=button)",
			"[e15] button 取消 (type=button)",
		];
		const specific =
			row.kind === "transport"
				? [
						`[e4] input/combobox 江苏省/${row.fromCity} (label=出发城市 type=search)`,
						`[e5] input/combobox 江苏省/${row.toCity} (label=到达城市 type=search)`,
						`[e6] input/combobox ${row.seatClass} (label=乘坐火车席别 type=search)`,
						"[e10] button 添加发票 (label=上传发票 type=button)",
					]
				: row.kind === "hotel"
					? ["[e10] button 添加发票 (label=上传发票 type=button)"]
					: [`[e6] input/combobox ${row.allowanceType} (label=补助类型 type=search)`];
		return [
			"标题：合思",
			"可操作元素：",
			`[e1] div ${feeType} (testid=template-feeType-item)`,
			...common,
			...specific,
			...extra,
			"页面正文：",
			"添加明细",
			feeType,
			dates.startDate,
			dates.endDate,
			row.kind === "transport"
				? `${row.fromCity} ${row.toCity} ${row.seatClass} ${row.amount}`
				: row.kind === "hotel"
					? `${row.checkinDate} ${row.checkoutDate} ${row.amount}`
					: `${row.allowanceType} ${row.days} ${row.amount}`,
		].join("\n");
	}

	protected foldedTransport(row: TravelDraftTransportExpected, index: number): string {
		return [
			"可操作元素：",
			`[e${200 + index}] div ${FEE_TYPE}（COST68） ${row.startDate} – ${row.endDate} 差旅天数：1天 出发城市：江苏省/${row.fromCity}市 到达城市：江苏省/${row.toCity}市 乘坐火车席别：${row.seatClass} 费用报销人：苏爱健（CIC023） 报销费用金额：¥${row.amount.toFixed(2)} 核减金额：¥0.00 费用说明：无 发票金额：¥${row.amount.toFixed(2)} 支付方式：全额支付`,
			"页面正文：",
			"已有发票*1",
			"苏爱健（个人账户）",
			`CNY ${row.amount.toFixed(2)}`,
		].join("\n");
	}

	protected foldedAllowance(row: TravelDraftAllowanceExpected): string {
		return [
			"可操作元素：",
			`[e220] div ${ALLOWANCE_FEE_TYPE} ${row.startDate} – ${row.endDate} 补助类型：${row.allowanceType} 补助天数：${row.days}天 费用报销人：苏爱健（CIC023） 报销费用金额：¥${row.amount.toFixed(2)} 核减金额：¥0.00 支付方式：全额支付`,
			"页面正文：",
			"支付信息",
			"苏爱健（个人账户）",
			`CNY ${row.amount.toFixed(2)}`,
		].join("\n");
	}

	protected foldedHotel(row: TravelDraftHotelExpected): string {
		return [
			"可操作元素：",
			`[e210] div ${HOTEL_FEE_TYPE} ${row.checkinDate} – ${row.checkoutDate} 费用报销人：苏爱健（CIC023） 报销费用金额：¥${row.amount.toFixed(2)} 核减金额：¥0.00 发票金额：¥${row.amount.toFixed(2)} 支付方式：全额支付`,
			"页面正文：",
			"已有发票*1",
			"苏爱健（个人账户）",
			`CNY ${row.amount.toFixed(2)}`,
		].join("\n");
	}

	protected savedDetailForScope(scope: string[]): string | undefined {
		if (scope[0] === FEE_TYPE) {
			if (scope.length === 1) return `[e190] div ${FEE_TYPE} (testid=template-feeType-item)`;
			const rows = this.expected.transport
				.map((row, index) =>
					this.savedKeys.has(row.key) &&
					scope.includes(row.startDate) &&
					scope.includes(`¥${row.amount.toFixed(2)}`)
						? this.foldedTransport(row, index)
						: undefined,
				)
				.filter((value): value is string => value !== undefined);
			if (rows.length > 0) return rows.join("\n");
		}
		if (scope[0] === ALLOWANCE_FEE_TYPE && this.savedKeys.has(this.expected.allowance.key)) {
			return this.foldedAllowance(this.expected.allowance);
		}
		if (scope[0] === HOTEL_FEE_TYPE && this.expected.hotel && this.savedKeys.has(this.expected.hotel.key)) {
			return this.foldedHotel(this.expected.hotel);
		}
		return undefined;
	}

	async snapshot(options: AgentBrowserSnapshotOptions): Promise<string> {
		this.calls.push({ method: "snapshot", value: structuredClone(options) });
		if (this.failNextSnapshotAfterDraftClick) {
			this.failNextSnapshotAfterDraftClick = false;
			throw new Error("snapshot failed after draft click");
		}
		const scope = options.scopeTexts ?? [];
		if (this.applicationDialog) {
			if (!this.applicationSearchTyped && scope.includes("搜索标题和单号")) {
				return [
					"可操作元素：",
					"[e300] input 搜索标题和单号 (placeholder=搜索标题和单号 type=text)",
					"页面正文：",
					"请选择关联申请",
				].join("\n");
			}
			return this.applicationCandidateSnapshot();
		}
		if (this.recipientPicker && scope.includes("苏爱健")) {
			const text = this.recipientPicker === "支付信息" ? "苏爱健（个人账户）" : "苏爱健（CIC023）";
			return ["可操作元素：", "[e109] div 苏爱健（个人账户）", `[e110] div/option ${text}`, "页面正文：", text].join(
				"\n",
			);
		}
		if (this.invoiceDialog && scope.includes("智能识票") && scope.includes("上传文件")) {
			const row = this.activeInvoiceRow();
			return [
				"可操作元素：",
				"[e104] input （无文字） (type=file)",
				...(this.invoiceUploaded && row ? [`[e111] div ${basename(row.uploadFile)}`] : []),
				"[e105] button 确定 (type=button)",
				"页面正文：",
				"智能识票 上传文件",
			].join("\n");
		}
		if (scope.length === 1 && scope[0] === "与该消费绑定") {
			return "[e107] button/disabled 与该消费绑定 (type=button)";
		}
		if (this.recognized && scope.includes("通过智能识票识别出") && scope.includes("与该消费绑定")) {
			const row = this.activeInvoiceRow();
			if (!row) return `${SNAPSHOT_SCOPE_MISS_FOR_TEST} 与该消费绑定`;
			const recognizedCount = row.kind === "hotel" ? this.hotelRecognitionCount : 1;
			const identity =
				row.kind === "transport"
					? `${row.fromStation?.replace(/站$/, "")} - ${row.toStation?.replace(/站$/, "")} ${row.travelDate} 铁路电子客票 已验真 ¥${row.amount.toFixed(2)}`
					: `${row.checkinDate} 住宿 增值税电子普通发票 ¥${row.amount.toFixed(2)}`;
			return [
				"可操作元素：",
				`[e106] input （无文字） (label=${row.invoiceNumber} type=checkbox checked=${this.invoiceSelected} aria-checked=${this.invoiceSelected})`,
				`[e107] button${this.invoiceSelected ? "" : "/disabled"} 与该消费绑定 (type=button)`,
				"页面正文：",
				`通过智能识票识别出 ${recognizedCount} 张发票`,
				...(row.kind === "transport" ? [row.invoiceNumber] : []),
				identity,
				"与该消费绑定",
			].join("\n");
		}
		if (this.invoiceMenuOpen && scope.includes("智能识票")) {
			return ["可操作元素：", "[e103] button 智能识票 (type=button)", "页面正文：", "智能识票"].join("\n");
		}
		if (this.drawerOpen) {
			if (scope.includes("添加明细") && scope.includes("费用类型")) {
				return [
					"可操作元素：",
					"[e100] input/combobox 请选择费用类型 (placeholder=请选择费用类型 type=search)",
					...(this.typedFeeType ? [`[e101] div ${this.typedFeeType} (testid=template-feeType-item)`] : []),
					"页面正文：",
					"添加明细 费用类型 请选择费用类型",
				].join("\n");
			}
			if (
				!this.feeTypeSelected &&
				this.typedFeeType &&
				scope.includes("添加明细") &&
				scope.includes(this.typedFeeType)
			) {
				return [
					"可操作元素：",
					`[e101] div ${this.typedFeeType} (testid=template-feeType-item)`,
					"页面正文：",
					this.typedFeeType,
				].join("\n");
			}
			const row = this.activeRow;
			if (this.feeTypeSelected && row) {
				const feeType = this.rowFeeType();
				if (!feeType) return `${SNAPSHOT_SCOPE_MISS_FOR_TEST} 当前明细`;
				if (scope.length === 1 && scope[0] === feeType) {
					return `[e190] div ${feeType} (testid=template-feeType-item)`;
				}
				if (row.kind === "transport" && scope.length === 1 && scope[0] === row.seatClass) {
					return [
						"可操作元素：",
						`[e119] div ${row.seatClass}`,
						`[e120] div/option ${row.seatClass}（ED）`,
						`[e121] div/option 卧代${row.seatClass}（WDEDZ）`,
						"页面正文：",
						row.seatClass,
					].join("\n");
				}
				if (row.kind === "allowance" && scope.length === 1 && scope[0] === row.allowanceType) {
					return ["可操作元素：", `[e122] div/option ${row.allowanceType}`, "页面正文：", row.allowanceType].join(
						"\n",
					);
				}
				if (row.kind === "transport" && scope.includes("出发城市")) {
					return `[e4] input/combobox 江苏省/${row.fromCity} (label=出发城市 type=search)`;
				}
				if (row.kind === "transport" && scope.includes("到达城市")) {
					return `[e5] input/combobox 江苏省/${row.toCity} (label=到达城市 type=search)`;
				}
				if (row.kind === "transport" && scope.includes("乘坐火车席别")) {
					return `[e6] input/combobox ${row.seatClass} (label=乘坐火车席别 type=search)`;
				}
				if (scope.includes("报销费用金额")) {
					return `[e8] input ${row.amount} (placeholder=请输入报销费用金额 type=text)`;
				}
				if (row.kind === "allowance" && scope.includes("补助类型")) {
					return `[e6] input/combobox ${row.allowanceType} (label=补助类型 type=search)`;
				}
				if (row.kind !== "allowance" && scope.includes("上传发票")) {
					const invoiceExtra = this.invoiceBound
						? [
								`[e112] div ${basename(row.uploadFile)}`,
								"[e113] button 已有发票*1",
								...(row.kind === "transport" ? [`[e114] div 发票号码：${row.invoiceNumber}`] : []),
								`[e123] div CNY ${row.amount.toFixed(2)}`,
							]
						: [];
					return this.detailForm(invoiceExtra);
				}
				if (row.kind !== "allowance" && scope.includes("附件")) {
					return this.detailForm([
						"[e108] input （无文字） (type=file)",
						...(this.attachmentsUploaded
							? [
									`[e115] div ${basename(row.uploadFile)}`,
									...row.verificationFiles.map((file, index) => `[e${116 + index}] div ${basename(file)}`),
								]
							: []),
					]);
				}
				if (scope.includes(feeType)) return this.detailForm();
			}
		}
		const saved = this.savedDetailForScope(scope);
		if (saved) return saved;
		if (scope.length > 0) return `${SNAPSHOT_SCOPE_MISS_FOR_TEST} ${scope.join(" / ")}`;
		return this.mainSnapshot();
	}

	override async click(target: AgentBrowserTarget): Promise<string> {
		const output = await super.click(target);
		if (target.selector === '[data-testid="field-expenseLink-select"]') {
			this.applicationDialog = true;
			this.applicationSearchTyped = false;
			this.applicationCandidateSelected = false;
		}
		if (target.ref === "e301" && this.applicationDialog) this.applicationCandidateSelected = true;
		if (target.ref === "e302" && this.applicationCandidateSelected) {
			this.applicationDialog = false;
			this.applicationConfirmed = true;
		}
		const foldedTransportIndex = target.ref?.match(/^e20([0-9])$/)?.[1];
		if (foldedTransportIndex !== undefined) {
			const row = this.expected.transport[Number(foldedTransportIndex)];
			if (row && this.savedKeys.has(row.key)) {
				this.resetDrawer();
				this.drawerOpen = true;
				this.activeRow = row;
				this.typedFeeType = FEE_TYPE;
				this.feeTypeSelected = true;
				this.reporterSelected = true;
				this.paymentSelected = true;
				this.invoiceBound = true;
				this.attachmentsUploaded = true;
				this.applyHiddenDetailDrift(row);
			}
		}
		if (target.ref === "e220" && this.savedKeys.has(this.expected.allowance.key)) {
			this.resetDrawer();
			this.drawerOpen = true;
			this.activeRow = this.expected.allowance;
			this.typedFeeType = ALLOWANCE_FEE_TYPE;
			this.feeTypeSelected = true;
			this.reporterSelected = true;
			this.paymentSelected = true;
		}
		if (target.ref === "e210" && this.expected.hotel && this.savedKeys.has(this.expected.hotel.key)) {
			this.resetDrawer();
			this.drawerOpen = true;
			this.activeRow = this.expected.hotel;
			this.typedFeeType = HOTEL_FEE_TYPE;
			this.feeTypeSelected = true;
			this.reporterSelected = true;
			this.paymentSelected = true;
			this.invoiceBound = true;
			this.attachmentsUploaded = true;
		}
		if (target.ref === "e15" && this.drawerOpen) this.drawerOpen = false;
		if (target.selector === '[data-testid="field-expenseDetail-add"]') {
			this.drawerOpen = true;
			this.resetDrawer();
		}
		if (target.ref === "e101" && this.drawerOpen && this.typedFeeType) this.feeTypeSelected = true;
		if (target.ref === "e7" && this.drawerOpen && !this.reporterSelected) this.recipientPicker = "费用报销人";
		if (target.ref === "e9" && this.drawerOpen && !this.paymentSelected) this.recipientPicker = "支付信息";
		if (target.ref === "e110" && this.recipientPicker) {
			if (this.recipientPicker === "费用报销人") this.reporterSelected = true;
			else this.paymentSelected = true;
			this.recipientPicker = undefined;
		}
		if (target.ref === "e103" && this.invoiceMenuOpen) this.invoiceDialog = true;
		if (target.ref === "e105" && this.invoiceDialog && this.invoiceUploaded) {
			this.invoiceDialog = false;
			this.recognized = true;
		}
		if (target.ref === "e106" && this.recognized) this.invoiceSelected = true;
		if (target.ref === "e107" && this.invoiceSelected) this.invoiceBound = true;
		if (target.selector === '[data-testid="feetype-footer-save"]' && this.activeRow) {
			this.savedKeys.add(this.activeRow.key);
			this.drawerOpen = false;
		}
		if (target.selector === '[data-testid="flexable-button-edit"]') {
			this.draftSaved = true;
			if (this.draftFailure === "snapshot_after_click") this.failNextSnapshotAfterDraftClick = true;
			if (this.draftFailure === "interrupt_after_click") {
				throw new TravelDraftInterruptedError("interrupted after draft click");
			}
		}
		return output;
	}

	override async wait(milliseconds: number, text?: string): Promise<string> {
		if (text && !this.draftExplicitSuccess) {
			this.calls.push({ method: "wait", value: { milliseconds, text } });
			throw new Error(`等待超时，页面中没有出现：${text}`);
		}
		return super.wait(milliseconds, text);
	}

	override async hover(target: AgentBrowserTarget): Promise<string> {
		const output = await super.hover(target);
		if (target.ref === "e10") this.invoiceMenuOpen = true;
		return output;
	}

	override async type(
		target: AgentBrowserTarget,
		value: string,
		pressEnter: boolean,
		commit: boolean,
	): Promise<string> {
		const output = await super.type(target, value, pressEnter, commit);
		if (target.ref === "e300" && value === this.expected.application.id) this.applicationSearchTyped = true;
		if (target.ref === "e100") {
			this.typedFeeType = value;
			this.activeRow =
				value === ALLOWANCE_FEE_TYPE
					? this.expected.allowance
					: value === HOTEL_FEE_TYPE
						? this.expected.hotel
						: this.nextTransport();
			if (
				this.preboundSecondTransport &&
				this.activeRow?.kind === "transport" &&
				this.expected.transport.indexOf(this.activeRow) === 1
			) {
				this.invoiceBound = true;
			}
		}
		return output;
	}

	override async uploadFiles(
		files: AgentBrowserUploadFile[],
		target: AgentBrowserTarget | undefined,
		allowedOrigin?: string,
	): Promise<string> {
		const output = await super.uploadFiles(files, target, allowedOrigin);
		if (target?.ref === "e104" && this.invoiceDialog) this.invoiceUploaded = true;
		if (target?.ref === "e108") this.attachmentsUploaded = true;
		return output;
	}
}

class NameOnlyTwoRailPaymentRuntime extends CompleteTwoRailRuntime {
	mainPaymentSelections = 0;
	readonly paymentSelectionRows: string[] = [];
	private mainPaymentPickerOpen = false;

	override async snapshot(options: AgentBrowserSnapshotOptions): Promise<string> {
		if (this.mainPaymentPickerOpen && options.scopeTexts?.includes(TRAVEL_DRAFT_CURRENT_USER)) {
			this.calls.push({ method: "snapshot", value: structuredClone(options) });
			return ["可操作元素：", "[e110] div/option 苏爱健（个人账户）", "页面正文：", "苏爱健（个人账户）"].join("\n");
		}
		const requestedScope = options.scopeTexts ?? [];
		if (
			!this.drawerOpen &&
			!this.applicationDialog &&
			requestedScope.some((label) =>
				["报销说明", "驻地", "费用性质", "申请人部门", "费用所属部门", "报销日期", "支付信息"].includes(label),
			)
		) {
			this.calls.push({ method: "snapshot", value: structuredClone(options) });
			return this.mainSnapshot().replace(
				"[e14] div 苏爱健（个人账户） (label=支付信息)",
				"[e14] div 苏爱健 (label=支付信息)",
			);
		}
		let output = await super.snapshot(options);
		const scope = options.scopeTexts ?? [];
		if (!this.drawerOpen && !this.applicationDialog) {
			output = output.replace("[e14] div 苏爱健（个人账户） (label=支付信息)", "[e14] div 苏爱健 (label=支付信息)");
		}
		const isCurrentDetail = this.drawerOpen && scope.includes("添加明细") && !this.recipientPicker;
		const isFoldedDetail = scope[0] === FEE_TYPE || scope[0] === HOTEL_FEE_TYPE || scope[0] === ALLOWANCE_FEE_TYPE;
		if (!isCurrentDetail && !isFoldedDetail) return output;
		return output.replaceAll("苏爱健（个人账户）", "苏爱健").replaceAll("请选择支付信息", "苏爱健");
	}

	override async click(target: AgentBrowserTarget): Promise<string> {
		if (target.ref === "e14") this.mainPaymentPickerOpen = true;
		if (target.ref === "e110" && this.mainPaymentPickerOpen) {
			this.mainPaymentSelections += 1;
			this.mainPaymentPickerOpen = false;
		}
		if (target.ref === "e9" && this.activeRow) this.paymentSelectionRows.push(this.activeRow.key);
		return super.click(target);
	}
}

/**
 * Full production-flow fixture for the main-process trusted contract. Read-only
 * snapshots remain available for evidence checks, but every generic mutation is
 * a hard test failure. This catches accidental ref/selector fallbacks immediately.
 */
class TrustedOnlyCompleteRuntime extends CompleteTwoRailRuntime {
	private revision = 0;
	private documentToken = "trusted-complete-page-1";
	private applicationDetailsOpen = false;
	private mainWritableInvalidated = false;
	private mainPaymentSelected = true;
	private pendingMainSelection: EkuaibaoTrustedField | undefined;
	private readonly mainValues: Partial<Record<EkuaibaoTrustedField, string>> = {};
	private readonly detailValues: Partial<Record<EkuaibaoTrustedField, string>> = {};

	invalidateWritableDefaults(): void {
		this.mainWritableInvalidated = true;
		this.mainPaymentSelected = false;
		for (const field of [
			"description",
			"station",
			"reimbursement-date",
			"expense-nature",
			"applicant-department",
			"expense-department",
			"main-payment-recipient",
		] as const) {
			delete this.mainValues[field];
		}
	}

	rotateDocumentToken(): void {
		this.documentToken = `trusted-complete-page-${this.revision + 2}`;
		this.revision += 1;
	}

	private digest(): string {
		return `trusted-complete-${this.revision}`;
	}

	private overlay(): EkuaibaoTrustedPageState["overlay"] {
		if (this.applicationDetailsOpen) return "application-details";
		if (this.applicationDialog) return "application-dialog";
		if (this.invoiceDialog) return "invoice-dialog";
		if (this.recognized) return "invoice-results";
		if (this.invoiceMenuOpen) return "invoice-menu";
		if (this.drawerOpen) return this.feeTypeSelected ? "detail-drawer" : "detail-picker";
		return "none";
	}

	private field(value: string | undefined, required = true) {
		return { present: true, ambiguous: false, required, disabled: false, ...(value !== undefined ? { value } : {}) };
	}

	private currentMainValue(field: EkuaibaoTrustedField): string | undefined {
		if (this.mainValues[field] !== undefined) return this.mainValues[field];
		if (this.mainWritableInvalidated) return undefined;
		if (field === "description") return this.applicationConfirmed ? this.expected.header.explanation : undefined;
		if (field === "station") return "江苏省/南京";
		if (field === "reimbursement-date") return this.expected.header.reimbursementDate;
		if (field === "expense-nature") return this.expected.header.expenseNature;
		if (field === "applicant-department" || field === "expense-department") return TRAVEL_DRAFT_DEPARTMENT;
		if (field === "main-payment-recipient") return this.mainPaymentSelected ? "苏爱健" : undefined;
		return undefined;
	}

	private foldedSummary(
		row: TravelDraftTransportExpected | TravelDraftHotelExpected | TravelDraftAllowanceExpected,
	): string {
		const money = row.amount.toFixed(2);
		if (row.kind === "transport") {
			return `${FEE_TYPE} ${row.startDate} – ${row.endDate} 出发城市：江苏省/${row.fromCity}市 到达城市：江苏省/${row.toCity}市 乘坐火车席别：${row.seatClass} 费用报销人：苏爱健（CIC023） 报销费用金额：¥${money} 已有发票*1 支付信息 苏爱健 CNY ${money}`;
		}
		if (row.kind === "hotel") {
			return `${HOTEL_FEE_TYPE} ${row.checkinDate} – ${row.checkoutDate} 费用报销人：苏爱健（CIC023） 报销费用金额：¥${money} 已有发票*1 支付信息 苏爱健 CNY ${money}`;
		}
		return `${ALLOWANCE_FEE_TYPE} ${row.startDate} – ${row.endDate} 补助类型：${row.allowanceType} 补助天数：${row.days}天 费用报销人：苏爱健（CIC023） 报销费用金额：¥${money} 支付信息 苏爱健 CNY ${money}`;
	}

	private trustedState(): EkuaibaoTrustedPageState {
		const overlay = this.overlay();
		const fields: EkuaibaoTrustedPageState["fields"] = {};
		if (overlay === "none") {
			fields.company = this.field(this.expected.header.company, false);
			fields.submitter = this.field(TRAVEL_DRAFT_CURRENT_USER, false);
			fields.description = this.field(this.currentMainValue("description"));
			fields.station = this.field(this.currentMainValue("station"));
			fields["reimbursement-date"] = this.field(this.currentMainValue("reimbursement-date"));
			fields["expense-nature"] = this.field(this.currentMainValue("expense-nature"));
			fields["applicant-department"] = this.field(this.currentMainValue("applicant-department"));
			fields["expense-department"] = this.field(this.currentMainValue("expense-department"));
			fields["main-payment-recipient"] = this.field(this.currentMainValue("main-payment-recipient"));
		}
		if (overlay === "application-dialog")
			fields["application-search"] = this.field(this.applicationSearchTyped ? this.expected.application.id : "");
		if (overlay === "detail-picker") fields["fee-type-search"] = this.field(this.typedFeeType ?? "");
		if (overlay === "detail-drawer" && this.activeRow) {
			for (const field of [
				"detail-start-date",
				"detail-end-date",
				"departure-city",
				"arrival-city",
				"seat-class",
				"reimbursement-amount",
				"allowance-type",
			] as const) {
				fields[field] = this.field(this.detailValues[field]);
			}
			fields["expense-reporter"] = this.field(this.reporterSelected ? "苏爱健（CIC023）" : undefined);
			fields["payment-recipient"] = this.field(this.paymentSelected ? "苏爱健" : undefined);
		}
		const rows = [
			...this.expected.transport,
			...(this.expected.hotel ? [this.expected.hotel] : []),
			this.expected.allowance,
		].filter((row) => this.savedKeys.has(row.key));
		const total = rows.reduce((sum, row) => sum + row.amount, 0);
		return {
			contractVersion: EKUAIBAO_TRUSTED_CONTRACT_VERSION,
			pageToken: this.documentToken,
			pageFingerprint: EKUAIBAO_TRUSTED_PAGE_FINGERPRINT,
			route: "bill-entry-detail",
			overlay,
			digest: this.digest(),
			fields,
			controls: {
				"save-draft": { present: overlay === "none", ambiguous: false, disabled: false },
				"save-detail": { present: overlay === "detail-drawer", ambiguous: false, disabled: false },
			},
			multipleRecipients: { present: true, checked: false, source: "native-input" },
			...(this.applicationConfirmed
				? {
						linkedApplication: {
							id: this.expected.application.id,
							title: this.expected.application.title,
							startDate: this.expected.application.startDate,
							endDate: this.expected.application.endDate,
						},
					}
				: {}),
			...(this.applicationDetailsOpen
				? {
						applicationSource: {
							id: this.expected.application.id,
							title: this.expected.application.title,
							reason: this.expected.application.reason,
							expenseNature: this.expected.application.expenseNature,
						},
					}
				: {}),
			detailCount: this.savedKeys.size,
			calculatedTotal: total.toFixed(2),
			validationErrors: [],
			foldedDetails: rows.map((row) => ({
				feeType: row.kind,
				summary: this.foldedSummary(row),
				amount: row.amount.toFixed(2),
				invoiceCount: row.kind === "allowance" ? 0 : 1,
			})),
			draftConfirmationVisible: this.draftSaved,
		};
	}

	private trustedSuccess(beforeDigest: string): EkuaibaoTrustedResult {
		const state = this.trustedState();
		return { ok: true, message: "测试可信命令成功", beforeDigest, afterDigest: state.digest, state };
	}

	private populateReopenedRow(
		row: TravelDraftTransportExpected | TravelDraftHotelExpected | TravelDraftAllowanceExpected,
	): void {
		this.resetDrawer();
		this.drawerOpen = true;
		this.activeRow = row;
		this.typedFeeType = this.rowFeeType();
		this.feeTypeSelected = true;
		this.reporterSelected = true;
		this.paymentSelected = true;
		const dates = this.rowDates();
		if (dates) {
			this.detailValues["detail-start-date"] = dates.startDate;
			this.detailValues["detail-end-date"] = dates.endDate;
		}
		this.detailValues["reimbursement-amount"] = String(row.amount);
		if (row.kind === "transport") {
			this.detailValues["departure-city"] = `江苏省/${row.fromCity}`;
			this.detailValues["arrival-city"] = `江苏省/${row.toCity}`;
			this.detailValues["seat-class"] = row.seatClass;
			this.invoiceBound = true;
			this.attachmentsUploaded = true;
		}
		if (row.kind === "hotel") {
			this.invoiceBound = true;
			this.attachmentsUploaded = true;
		}
		if (row.kind === "allowance") this.detailValues["allowance-type"] = row.allowanceType;
		this.applyHiddenDetailDrift(row);
	}

	private rowForOpen(command: Extract<EkuaibaoTrustedCommand, { op: "click" }>) {
		const candidates = [
			...this.expected.transport,
			...(this.expected.hotel ? [this.expected.hotel] : []),
			this.expected.allowance,
		].filter((row) => row.kind === command.detailKind && this.savedKeys.has(row.key));
		const matches = candidates.filter((row) =>
			(command.evidence ?? []).every((value) => this.foldedSummary(row).includes(value)),
		);
		return matches.length === 1 ? matches[0] : undefined;
	}

	override async snapshot(options: AgentBrowserSnapshotOptions): Promise<string> {
		let output = await super.snapshot(options);
		if (this.mainWritableInvalidated && !this.drawerOpen && !this.applicationDialog) {
			const replace = (from: string | undefined, to: string | undefined) =>
				from ? output.replace(from, to ?? "（无文字）") : output;
			output = replace(this.expected.header.explanation, this.currentMainValue("description"));
			output = replace("江苏省/南京", this.currentMainValue("station"));
			output = replace(this.expected.header.reimbursementDate, this.currentMainValue("reimbursement-date"));
			output = output.replace(
				`[e7] div ${this.expected.header.expenseNature} (label=费用性质)`,
				`[e7] div ${this.currentMainValue("expense-nature") ?? "（无文字）"} (label=费用性质)`,
			);
			output = output.replace(
				`[e8] div ${TRAVEL_DRAFT_DEPARTMENT} (label=申请人部门)`,
				`[e8] div ${this.currentMainValue("applicant-department") ?? "（无文字）"} (label=申请人部门)`,
			);
			output = output.replace(
				`[e9] div ${TRAVEL_DRAFT_DEPARTMENT} (label=费用所属部门)`,
				`[e9] div ${this.currentMainValue("expense-department") ?? "（无文字）"} (label=费用所属部门)`,
			);
			output = output.replace(
				"[e14] div 苏爱健（个人账户） (label=支付信息)",
				`[e14] div ${this.currentMainValue("main-payment-recipient") ?? "请选择支付信息"} (label=支付信息)`,
			);
		}
		if (
			this.drawerOpen &&
			this.feeTypeSelected &&
			this.activeRow &&
			(options.scopeTexts ?? []).includes("添加明细")
		) {
			const dates = this.rowDates();
			if (dates) {
				output = output.replace(dates.startDate, this.detailValues["detail-start-date"] ?? "（无文字）");
				output = output.replace(dates.endDate, this.detailValues["detail-end-date"] ?? "（无文字）");
			}
			output = output.replace(
				`[e8] input ${this.activeRow.amount}`,
				`[e8] input ${this.detailValues["reimbursement-amount"] ?? "（无文字）"}`,
			);
			if (this.activeRow.kind === "transport") {
				output = output.replace(
					`江苏省/${this.activeRow.fromCity}`,
					this.detailValues["departure-city"] ?? "（无文字）",
				);
				output = output.replace(
					`江苏省/${this.activeRow.toCity}`,
					this.detailValues["arrival-city"] ?? "（无文字）",
				);
				output = output.replace(this.activeRow.seatClass, this.detailValues["seat-class"] ?? "（无文字）");
			}
			if (this.activeRow.kind === "allowance") {
				output = output.replace(this.activeRow.allowanceType, this.detailValues["allowance-type"] ?? "（无文字）");
			}
			output = output.replaceAll("苏爱健（个人账户）", "苏爱健");
		}
		if ([FEE_TYPE, HOTEL_FEE_TYPE, ALLOWANCE_FEE_TYPE].includes((options.scopeTexts ?? [])[0] ?? "")) {
			output = output.replaceAll("苏爱健（个人账户）", "苏爱健");
		}
		return output;
	}

	async runEkuaibaoTrustedCommand(command: EkuaibaoTrustedCommand): Promise<EkuaibaoTrustedResult> {
		this.calls.push({ method: "trusted", value: structuredClone(command) });
		if (command.op === "inspect") {
			const state = this.trustedState();
			return { ok: true, message: "测试可信检查成功", beforeDigest: state.digest, afterDigest: state.digest, state };
		}
		if (command.pageToken !== this.documentToken || command.expectedDigest !== this.digest()) {
			return { ok: false, code: "stale_state", message: "测试可信状态已过期" };
		}
		const beforeDigest = this.digest();
		if (command.op === "click") {
			if (command.control === "open-application") {
				this.applicationDialog = true;
				this.applicationSearchTyped = false;
				this.applicationCandidateSelected = false;
			}
			if (command.control === "open-application-details") this.applicationDetailsOpen = true;
			if (command.control === "close-application-details") this.applicationDetailsOpen = false;
			if (command.control === "confirm-application") {
				this.applicationDialog = false;
				this.applicationConfirmed = true;
			}
			if (command.control === "add-detail") {
				this.resetDrawer();
				this.drawerOpen = true;
				for (const field of Object.keys(this.detailValues) as EkuaibaoTrustedField[])
					delete this.detailValues[field];
			}
			if (command.control === "open-detail") {
				const row = this.rowForOpen(command);
				if (!row) return { ok: false, code: "ambiguous_anchor", message: "测试折叠行证据不唯一" };
				this.populateReopenedRow(row);
			}
			if (command.control === "close-detail") this.drawerOpen = false;
			if (command.control === "open-main-payment-recipient") this.mainPaymentSelected = false;
			if (command.control === "open-expense-reporter") this.recipientPicker = "费用报销人";
			if (command.control === "open-payment-recipient") this.recipientPicker = "支付信息";
			if (command.control === "open-smart-invoice") {
				this.invoiceMenuOpen = false;
				this.invoiceDialog = true;
			}
			if (command.control === "confirm-invoice-upload" && this.invoiceUploaded) {
				this.invoiceDialog = false;
				this.recognized = true;
			}
			if (command.control === "bind-recognized-invoice" && this.invoiceSelected) {
				this.recognized = false;
				this.invoiceBound = true;
			}
			if (command.control === "save-detail" && this.activeRow) {
				this.savedKeys.add(this.activeRow.key);
				this.drawerOpen = false;
			}
		}
		if (command.op === "hover") this.invoiceMenuOpen = true;
		if (command.op === "type") {
			if (command.field === "application-search") this.applicationSearchTyped = true;
			else if (command.field === "fee-type-search") {
				this.typedFeeType = command.value;
				this.activeRow =
					command.value === ALLOWANCE_FEE_TYPE
						? this.expected.allowance
						: command.value === HOTEL_FEE_TYPE
							? this.expected.hotel
							: this.nextTransport();
			} else if (command.scope.kind === "main") {
				this.mainValues[command.field] = command.value;
				this.pendingMainSelection = command.field;
			} else this.detailValues[command.field] = command.value;
		}
		if (command.op === "select-exact") {
			if (command.optionKind === "application") this.applicationCandidateSelected = true;
			if (command.optionKind === "fee-type") this.feeTypeSelected = true;
			if (command.optionKind === "station") this.mainValues.station = "江苏省/南京";
			if (command.optionKind === "expense-nature") this.mainValues["expense-nature"] = command.value;
			if (command.optionKind === "department") {
				const field =
					this.pendingMainSelection === "applicant-department" ||
					this.pendingMainSelection === "expense-department"
						? this.pendingMainSelection
						: undefined;
				if (field) this.mainValues[field] = TRAVEL_DRAFT_DEPARTMENT;
			}
			if (command.optionKind === "payment-recipient") {
				if (command.scope.kind === "main") {
					this.mainPaymentSelected = true;
					this.mainValues["main-payment-recipient"] = "苏爱健";
				} else {
					this.paymentSelected = true;
					this.recipientPicker = undefined;
				}
			}
			if (command.optionKind === "expense-reporter") {
				this.reporterSelected = true;
				this.recipientPicker = undefined;
			}
			if (command.optionKind === "city") {
				const field = this.detailValues["departure-city"] ? "arrival-city" : "departure-city";
				this.detailValues[field] = `江苏省/${command.value}`;
			}
			if (command.optionKind === "seat-class") this.detailValues["seat-class"] = command.value;
			if (command.optionKind === "allowance-type") {
				this.detailValues["allowance-type"] = command.value;
				if (this.activeRow?.kind === "allowance") {
					// This field is system-calculated after the allowance type/dates are set.
					this.detailValues["reimbursement-amount"] = String(this.activeRow.amount);
				}
			}
			if (command.optionKind === "recognized-invoice") this.invoiceSelected = true;
		}
		if (command.op === "upload") {
			if (command.slot === "smart-invoice") this.invoiceUploaded = true;
			else this.attachmentsUploaded = true;
		}
		if (command.op === "save-draft") this.draftSaved = true;
		this.revision += 1;
		return this.trustedSuccess(beforeDigest);
	}

	override async click(_target: AgentBrowserTarget): Promise<string> {
		throw new Error("trusted-only fixture forbids generic click");
	}

	override async hover(_target: AgentBrowserTarget): Promise<string> {
		throw new Error("trusted-only fixture forbids generic hover");
	}

	override async type(
		_target: AgentBrowserTarget,
		_value: string,
		_pressEnter: boolean,
		_commit: boolean,
	): Promise<string> {
		throw new Error("trusted-only fixture forbids generic type");
	}

	override async uploadFiles(
		_files: AgentBrowserUploadFile[],
		_target: AgentBrowserTarget | undefined,
		_allowedOrigin?: string,
	): Promise<string> {
		throw new Error("trusted-only fixture forbids generic upload");
	}
}

async function prepareCompleteDriverForSave(options: CompleteRuntimeOptions = {}) {
	const complete = fixture();
	const runtime = new CompleteTwoRailRuntime(complete.expected, options);
	const driver = new TravelDraftBrowserDriver({
		runtime,
		cwd: complete.cwd,
		waitMilliseconds: 100,
		maxBrowserActions: 320,
	});
	const discovery = await driver.discoverApplication({
		url: complete.plan.url,
		hint: complete.expected.application.id,
		invoiceFacts: { travelDates: ["2026-08-21"], cities: ["南京", "常州"] },
	});
	if (discovery.status !== "selected") throw new Error("test setup could not select application");
	await driver.precheck(complete.plan, complete.expected);
	for (const [index, row] of complete.expected.transport.entries()) await driver.ensureTransport(row, index);
	await driver.ensureAllowance(complete.expected.allowance);
	const verification = await driver.verify(complete.expected);
	if (verification.verification?.valid !== true) throw new Error("test setup could not verify complete draft");
	return { ...complete, runtime, driver };
}

class CompleteHeaderRuntime extends FakeRuntime {
	protected readonly expected: TravelDraftExpected;
	private readonly company: string;
	protected topPayment: string;
	protected applicantDepartment: string;
	protected expenseDepartment: string;

	constructor(
		expected: TravelDraftExpected,
		company: string = expected.header.company,
		topPayment = "苏爱健（个人账户）",
		applicantDepartment = TRAVEL_DRAFT_DEPARTMENT,
		expenseDepartment = TRAVEL_DRAFT_DEPARTMENT,
	) {
		super();
		this.expected = expected;
		this.company = company;
		this.topPayment = topPayment;
		this.applicantDepartment = applicantDepartment;
		this.expenseDepartment = expenseDepartment;
	}

	async snapshot(options: AgentBrowserSnapshotOptions): Promise<string> {
		this.calls.push({ method: "snapshot", value: structuredClone(options) });
		return [
			"标题：合思",
			"可操作元素：",
			"[e1] button 存为草稿 (testid=flexable-button-edit type=button)",
			`[e2] textarea ${this.expected.header.explanation} (label=报销说明 testid=field-text-u_事由 type=text)`,
			"[e3] div 苏爱健 (label=提交人)",
			"[e4] label 驻地",
			"[e43] input/combobox 江苏省/南京 (type=search)",
			`[e40] div ${this.company || "（无文字）"} (label=所属公司 testid=custom-dimension-tree-select)`,
			"[e41] span （无文字） (label=所属公司)",
			"[e42] span ▼ (label=所属公司)",
			`[e5] input ${this.expected.header.reimbursementDate} (label=报销日期 placeholder=请选择日期 type=text)`,
			`[e6] div ${this.expected.header.expenseNature} (label=费用性质)`,
			`[e7] div ${this.applicantDepartment} (label=申请人部门)`,
			`[e8] div ${this.expenseDepartment} (label=费用所属部门)`,
			`[e37] div ${this.topPayment} (label=支付信息 placeholder=多收款人)`,
			"[e39] input （无文字） (label=是否为多收款人 type=checkbox checked=false aria-checked=false)",
			"页面正文：",
			"差旅费用报销单",
		].join("\n");
	}
}

class TrustedHeaderReadRuntime extends CompleteHeaderRuntime {
	private readonly trustedPayment: string;
	private readonly trustedApplicantDepartment: string;
	private readonly trustedExpenseDepartment: string;

	constructor(expected: TravelDraftExpected, payment: string, applicantDepartment: string, expenseDepartment: string) {
		super(expected, expected.header.company, payment, applicantDepartment, expenseDepartment);
		this.trustedPayment = payment;
		this.trustedApplicantDepartment = applicantDepartment;
		this.trustedExpenseDepartment = expenseDepartment;
	}

	async runEkuaibaoTrustedCommand(command: EkuaibaoTrustedCommand): Promise<EkuaibaoTrustedResult> {
		this.calls.push({ method: "trusted", value: structuredClone(command) });
		if (command.op !== "inspect") return { ok: false, code: "invalid_command", message: "只读表头测试不允许写操作" };
		const field = (value: string) => ({
			present: true,
			ambiguous: false,
			required: true,
			disabled: false,
			value,
		});
		const state: EkuaibaoTrustedPageState = {
			...trustedApplicationPage("none", "trusted-header-read"),
			fields: {
				company: field(this.expected.header.company),
				description: field(this.expected.header.explanation),
				submitter: field(TRAVEL_DRAFT_CURRENT_USER),
				station: field("江苏省/南京"),
				"reimbursement-date": field(this.expected.header.reimbursementDate),
				"expense-nature": field(this.expected.header.expenseNature),
				"applicant-department": field(this.trustedApplicantDepartment),
				"expense-department": field(this.trustedExpenseDepartment),
				"main-payment-recipient": field(this.trustedPayment),
			},
			detailCount: 0,
			calculatedTotal: "0.00",
		};
		return {
			ok: true,
			message: "已读取测试表头",
			beforeDigest: state.digest,
			afterDigest: state.digest,
			state,
		};
	}
}

class PaymentHeaderRuntime extends CompleteHeaderRuntime {
	private pickerOpen = false;

	override async snapshot(options: AgentBrowserSnapshotOptions): Promise<string> {
		if (this.pickerOpen && options.scopeTexts?.includes(TRAVEL_DRAFT_CURRENT_USER)) {
			this.calls.push({ method: "snapshot", value: structuredClone(options) });
			return ["可操作元素：", "[e110] div/option 苏爱健（个人账户）", "页面正文：", "苏爱健（个人账户）"].join("\n");
		}
		return super.snapshot(options);
	}

	override async click(target: AgentBrowserTarget): Promise<string> {
		const output = await super.click(target);
		if (target.ref === "e37") this.pickerOpen = true;
		if (target.ref === "e110" && this.pickerOpen) {
			this.topPayment = "苏爱健（个人账户）";
			this.pickerOpen = false;
		}
		return output;
	}
}

class NameOnlyPaymentHeaderRuntime extends CompleteHeaderRuntime {
	private pickerOpen = false;

	constructor(expected: TravelDraftExpected) {
		super(expected, expected.header.company, "苏爱健");
	}

	showPayment(value: string): void {
		this.topPayment = value;
	}

	override async snapshot(options: AgentBrowserSnapshotOptions): Promise<string> {
		if (this.pickerOpen && options.scopeTexts?.includes(TRAVEL_DRAFT_CURRENT_USER)) {
			this.calls.push({ method: "snapshot", value: structuredClone(options) });
			return ["可操作元素：", "[e110] div/option 苏爱健", "页面正文：", "支付信息", "苏爱健", "个人账户"].join("\n");
		}
		return super.snapshot(options);
	}

	override async click(target: AgentBrowserTarget): Promise<string> {
		const output = await super.click(target);
		if (target.ref === "e37") this.pickerOpen = true;
		if (target.ref === "e110" && this.pickerOpen) {
			// The real field can collapse the selected personal account to display name only.
			this.topPayment = "苏爱健";
			this.pickerOpen = false;
		}
		return output;
	}
}

class DepartmentSelectionRuntime extends CompleteHeaderRuntime {
	private pickerOpen = false;

	constructor(expected: TravelDraftExpected) {
		super(expected, expected.header.company, "苏爱健（个人账户）", "", TRAVEL_DRAFT_DEPARTMENT);
	}

	override async snapshot(options: AgentBrowserSnapshotOptions): Promise<string> {
		const scope = options.scopeTexts ?? [];
		if (scope.length === 1 && scope[0] === "申请人部门") {
			this.calls.push({ method: "snapshot", value: structuredClone(options) });
			return this.applicantDepartment
				? `[e7] input/combobox ${this.applicantDepartment} (label=申请人部门 type=search)`
				: "[e7] input/combobox （无文字） (label=申请人部门 type=search)";
		}
		if (this.pickerOpen && scope.length === 1 && scope[0] === "工业信息安全组") {
			this.calls.push({ method: "snapshot", value: structuredClone(options) });
			return [
				"可操作元素：",
				"[e70] div/option 其他公司/政策支撑部/工业信息安全组",
				`[e71] div/option ${TRAVEL_DRAFT_DEPARTMENT}`,
				"页面正文：",
				"工业信息安全组",
			].join("\n");
		}
		return super.snapshot(options);
	}

	override async type(
		target: AgentBrowserTarget,
		value: string,
		pressEnter: boolean,
		commit: boolean,
	): Promise<string> {
		const output = await super.type(target, value, pressEnter, commit);
		if (target.ref === "e7" && value === "工业信息安全组") this.pickerOpen = true;
		return output;
	}

	override async click(target: AgentBrowserTarget): Promise<string> {
		const output = await super.click(target);
		if (target.ref === "e71" && this.pickerOpen) {
			this.applicantDepartment = "工业信息安全组";
			this.pickerOpen = false;
		}
		return output;
	}
}

class RedirectBeforeUploadRuntime extends InvoiceFlowRuntime {
	private redirected = false;

	override state(): AgentBrowserState {
		const state = super.state();
		return this.redirected ? { ...state, url: "https://malicious.example/upload" } : state;
	}

	override async click(target: AgentBrowserTarget): Promise<string> {
		const output = await super.click(target);
		if (target.ref === "e1" && this.invoiceDialog) this.redirected = true;
		return output;
	}
}

class AbortAfterNavigateRuntime extends QueueRuntime {
	private readonly controller: AbortController;

	constructor(snapshots: string[], controller: AbortController) {
		super(snapshots);
		this.controller = controller;
	}

	override async navigate(url: string): Promise<AgentBrowserState> {
		const state = await super.navigate(url);
		this.controller.abort();
		return state;
	}
}

describe("差旅确定性工作流的浏览器生产适配器", () => {
	it("只解析唯一带标签的支付金额总计，不被票号或其他总额混淆", () => {
		expect(
			parseTravelPaymentTotal(
				[
					"可操作元素：",
					"[e1] div CNY 327.00 (label=支付金额总计 testid=payment-amount-total)",
					"页面正文：",
					"票号 TEST-327-IGNORE",
					"申请金额总计 CNY 999.00",
				].join("\n"),
			),
		).toBe(327);
		expect(parseTravelPaymentTotal("票号 TEST-327-IGNORE\n申请金额总计 CNY 327.00\n支付金额总计 CNY 326.00")).toBe(
			326,
		);
		expect(parseTravelPaymentTotal("票号 TEST-327-IGNORE\n申请金额总计 CNY 327.00")).toBeUndefined();
	});

	it("候选来源明确事由和费用性质，确认后主表只证明关联编号与日期", async () => {
		const runtime = new QueueRuntime([
			unselectedApplicationSnapshot(),
			applicationSearchSnapshot(),
			applicationCandidatesSnapshot([{ id: "S26002261", title: "出差申请：常州业务拓展" }]),
			applicationCandidatesSnapshot([{ id: "S26002261", title: "出差申请：常州业务拓展" }], true),
			selectedApplicationSnapshot(),
		]);

		const result = await discoverTravelApplication(
			{
				url: "https://app.ekuaibao.com/example",
				hint: "S26002261",
				invoiceFacts: { travelDates: ["2026-08-21"], cities: ["南京", "常州"] },
			},
			{ runtime, waitMilliseconds: 100 },
		);

		expect(result.status).toBe("selected");
		if (result.status !== "selected") throw new Error("expected selected");
		expect(result.application).toEqual({
			id: "S26002261",
			title: "出差申请：常州业务拓展",
			reason: "常州业务拓展",
			startDate: "2026-08-21",
			endDate: "2026-08-21",
			expenseNature: "部门费用",
		});
		const clicks = runtime.calls.filter((call) => call.method === "click").map((call) => call.value);
		expect(clicks).toEqual([
			{ selector: '[data-testid="field-expenseLink-select"]', scopeTexts: ["关联申请"] },
			{ ref: "e1", scopeTexts: ["S26002261", "出差申请：常州业务拓展"] },
			{ ref: "e90", scopeTexts: ["S26002261", "出差申请：常州业务拓展"] },
		]);
	});

	it("申请标题可以概括，以候选来源的显式申请事由为准", async () => {
		const candidate = {
			id: "S26002261",
			title: "出差申请：常州",
			reason: "常州业务拓展",
		};
		const runtime = new QueueRuntime([
			unselectedApplicationSnapshot(),
			applicationSearchSnapshot(),
			applicationCandidatesSnapshot([candidate]),
			applicationCandidatesSnapshot([candidate], true),
			selectedApplicationSnapshot({ title: candidate.title, reason: candidate.reason }),
		]);
		const result = await discoverTravelApplication(
			{
				url: "https://app.ekuaibao.com/example",
				hint: candidate.id,
				invoiceFacts: { travelDates: ["2026-08-21"], cities: ["南京", "常州"] },
			},
			{ runtime, waitMilliseconds: 100 },
		);

		expect(result.status).toBe("selected");
		if (result.status !== "selected") throw new Error("expected selected");
		expect(result.application.reason).toBe("常州业务拓展");
		expect(result.application.title).toBe("出差申请：常州");
	});

	it("主表默认部门费用不参与判断，以候选来源的项目费用为准", async () => {
		const candidate = {
			id: "S26002261",
			title: "出差申请：常州业务拓展",
			expenseNature: "项目费用" as const,
		};
		const runtime = new QueueRuntime([
			unselectedApplicationSnapshot(),
			applicationSearchSnapshot(),
			applicationCandidatesSnapshot([candidate]),
			applicationCandidatesSnapshot([candidate], true),
			selectedApplicationSnapshot({ expenseNature: "项目费用" }),
		]);
		const result = await discoverTravelApplication(
			{
				url: "https://app.ekuaibao.com/example",
				hint: candidate.id,
				invoiceFacts: { travelDates: ["2026-08-21"], cities: ["南京", "常州"] },
			},
			{ runtime, waitMilliseconds: 100 },
		);

		expect(result.status).toBe("selected");
		if (result.status !== "selected") throw new Error("expected selected");
		expect(result.application.expenseNature).toBe("项目费用");
		expect(unselectedApplicationSnapshot()).toContain("部门费用");
	});

	it("主表默认说明和费用性质不作为申请事实，必须从唯一申请详情读取", async () => {
		const candidate = { id: "S26002261", title: "出差申请：常州业务拓展" };
		const candidateWithoutSource = [
			"可操作元素：",
			`[e1] input （无文字） (label=${candidate.title} ${candidate.id} type=radio)`,
			"[e70] button 详情 (type=button)",
			"页面正文：",
			`${candidate.title} ${candidate.id} | 2026-08-21 至 2026-08-21 | 无金额 | 详情`,
		].join("\n");
		const detailSnapshot = [
			"可操作元素：",
			"[e71] div 常州现场业务拓展 (label=申请事由)",
			"[e72] div 项目费用 (label=费用性质)",
			"[e73] button 关闭 (type=button)",
			"页面正文：",
			candidate.title,
			candidate.id,
		].join("\n");
		const runtime = new QueueRuntime([
			unselectedApplicationSnapshot(),
			applicationSearchSnapshot(),
			candidateWithoutSource,
			detailSnapshot,
			candidateWithoutSource,
			`${candidateWithoutSource}\n[e90] button 确认 (type=button)`,
			selectedApplicationSnapshot({ reason: "主表默认说明", expenseNature: "部门费用" }),
		]);

		const result = await discoverTravelApplication(
			{
				url: "https://app.ekuaibao.com/example",
				hint: candidate.id,
				invoiceFacts: { travelDates: ["2026-08-21"], cities: ["南京", "常州"] },
			},
			{ runtime, waitMilliseconds: 100 },
		);

		expect(result.status).toBe("selected");
		if (result.status !== "selected") throw new Error("expected selected");
		expect(result.application).toMatchObject({
			reason: "常州现场业务拓展",
			expenseNature: "项目费用",
		});
		const clicks = runtime.calls.filter((call) => call.method === "click").map((call) => call.value);
		expect(clicks).toContainEqual({ ref: "e70", scopeTexts: [candidate.id, candidate.title] });
		expect(clicks).toContainEqual({
			ref: "e73",
			scopeTexts: [candidate.id, candidate.title, "费用性质"],
		});
	});

	it("新运行时按 select-exact → open details → read → close 的可信顺序读取申请事实", async () => {
		const candidate = { id: "S26002261", title: "出差申请：常州业务拓展" };
		const candidateSnapshot = [
			"可操作元素：",
			`[e1] input （无文字） (label=${candidate.title} ${candidate.id} type=radio)`,
			"页面正文：",
			`${candidate.title} ${candidate.id} | 2026-08-21 至 2026-08-21 | 无金额 | 详情`,
		].join("\n");
		const runtime = new TrustedApplicationDetailsRuntime(
			[
				unselectedApplicationSnapshot(),
				applicationSearchSnapshot(),
				candidateSnapshot,
				candidateSnapshot,
				`${candidateSnapshot}\n[e90] button 确认 (type=button)`,
				selectedApplicationSnapshot({ reason: "主表默认说明", expenseNature: "部门费用" }),
			],
			{
				id: candidate.id,
				title: candidate.title,
				reason: "常州现场业务拓展",
				expenseNature: "项目费用",
			},
		);

		const result = await discoverTravelApplication(
			{
				url: "https://app.ekuaibao.com/example",
				hint: candidate.id,
				invoiceFacts: { travelDates: ["2026-08-21"], cities: ["南京", "常州"] },
			},
			{ runtime, waitMilliseconds: 100 },
		);

		expect(result.status).toBe("selected");
		if (result.status !== "selected") throw new Error("expected selected");
		expect(result.application).toMatchObject({ reason: "常州现场业务拓展", expenseNature: "项目费用" });
		const trusted = runtime.calls.filter((call) => call.method === "trusted").map((call) => call.value);
		expect(
			trusted.map((value) => {
				const command = value as EkuaibaoTrustedCommand;
				return command.op === "click"
					? `${command.op}:${command.control}`
					: command.op === "type"
						? `${command.op}:${command.field}`
						: command.op;
			}),
		).toEqual([
			"inspect",
			"click:open-application",
			"inspect",
			"type:application-search",
			"inspect",
			"select-exact",
			"click:open-application-details",
			"click:close-application-details",
			"inspect",
			"click:confirm-application",
		]);
		expect(trusted[5]).toMatchObject({
			expectedDigest: "trusted-search",
			optionKind: "application",
			value: candidate.id,
			evidence: [candidate.title],
		});
		const genericClicks = runtime.calls.filter((call) => call.method === "click").map((call) => call.value);
		expect(genericClicks).toEqual([]);
	});

	it("可信申请详情事实不一致时关闭详情后 fail closed，绝不回退通用快照点击", async () => {
		const candidate = { id: "S26002261", title: "出差申请：常州业务拓展" };
		const candidateSnapshot = [
			"可操作元素：",
			`[e1] input （无文字） (label=${candidate.title} ${candidate.id} type=radio)`,
			"页面正文：",
			`${candidate.title} ${candidate.id} | 2026-08-21 至 2026-08-21 | 无金额 | 详情`,
		].join("\n");
		const invalidSources = [
			{ id: "S26009999", title: candidate.title, reason: "常州业务拓展", expenseNature: "部门费用" },
			{ id: candidate.id, title: "出差申请：其他事项", reason: "常州业务拓展", expenseNature: "部门费用" },
			{ id: candidate.id, title: candidate.title, reason: " ", expenseNature: "部门费用" },
			{ id: candidate.id, title: candidate.title, reason: "常州业务拓展", expenseNature: "默认值" },
		];
		for (const invalidSource of invalidSources) {
			const runtime = new TrustedApplicationDetailsRuntime(
				[unselectedApplicationSnapshot(), applicationSearchSnapshot(), candidateSnapshot],
				invalidSource as EkuaibaoTrustedApplicationSourceState,
			);
			await expect(
				discoverTravelApplication(
					{
						url: "https://app.ekuaibao.com/example",
						hint: candidate.id,
						invoiceFacts: { travelDates: ["2026-08-21"], cities: ["南京", "常州"] },
					},
					{ runtime, waitMilliseconds: 100 },
				),
			).rejects.toMatchObject({
				details: { code: "unsafe_page_state", operation: "核对关联申请详情" },
			});
			const trusted = runtime.calls.filter((call) => call.method === "trusted").map((call) => call.value);
			expect(trusted).toHaveLength(8);
			expect(trusted.at(-1)).toMatchObject({ control: "close-application-details" });
			const genericClicks = runtime.calls.filter((call) => call.method === "click").map((call) => call.value);
			expect(genericClicks).toEqual([]);
		}
	});

	it("可信详情打开失败时直接阻断且不尝试通用详情定位", async () => {
		const candidate = { id: "S26002261", title: "出差申请：常州业务拓展" };
		const candidateSnapshot = applicationCandidatesSnapshot([candidate]);
		const runtime = new TrustedApplicationDetailsRuntime(
			[unselectedApplicationSnapshot(), applicationSearchSnapshot(), candidateSnapshot],
			{ id: candidate.id, title: candidate.title, reason: "常州业务拓展", expenseNature: "部门费用" },
			{ failOpen: true },
		);
		await expect(
			discoverTravelApplication(
				{
					url: "https://app.ekuaibao.com/example",
					hint: candidate.id,
					invoiceFacts: { travelDates: ["2026-08-21"], cities: ["南京", "常州"] },
				},
				{ runtime, waitMilliseconds: 100 },
			),
		).rejects.toMatchObject({ details: { code: "unverified_state", operation: "核对关联申请详情" } });
		const trusted = runtime.calls.filter((call) => call.method === "trusted").map((call) => call.value);
		expect(trusted.map((command) => (command as EkuaibaoTrustedCommand).op)).toEqual([
			"inspect",
			"click",
			"inspect",
			"type",
			"inspect",
			"select-exact",
			"click",
		]);
		expect(trusted.at(-1)).toMatchObject({ control: "open-application-details" });
		expect(runtime.calls.filter((call) => call.method === "click")).toHaveLength(0);
	});

	it("显式申请 ID 可匹配不含城市的业务标题，避免把标题误当行程事实", async () => {
		const candidate = {
			id: "S26002261",
			title: "出差申请：管局演练支撑",
		};
		const runtime = new QueueRuntime([
			unselectedApplicationSnapshot(),
			applicationSearchSnapshot(),
			applicationCandidatesSnapshot([candidate]),
			applicationCandidatesSnapshot([candidate], true),
			selectedApplicationSnapshot({
				title: candidate.title,
				reason: "管局演练支撑",
				endDate: "2026-08-23",
			}),
		]);
		const result = await discoverTravelApplication(
			{
				url: "https://app.ekuaibao.com/example",
				hint: candidate.id,
				invoiceFacts: { travelDates: ["2026-08-21"], cities: ["南京", "常州"] },
			},
			{ runtime, waitMilliseconds: 100 },
		);

		expect(result.status).toBe("selected");
		expect(runtime.calls.filter((call) => call.method === "click").map((call) => call.value)).toContainEqual({
			ref: "e90",
			scopeTexts: [candidate.id, candidate.title],
		});
	});

	it("多城市多段行程可关联同一申请，但票据集合仍必须包含驻地南京", async () => {
		const candidate = { id: "S26002261", title: "出差申请：管局演练支撑" };
		const selectedRuntime = new QueueRuntime([
			unselectedApplicationSnapshot(),
			applicationSearchSnapshot(),
			applicationCandidatesSnapshot([candidate]),
			applicationCandidatesSnapshot([candidate], true),
			selectedApplicationSnapshot({
				title: candidate.title,
				reason: "管局演练支撑",
				endDate: "2026-08-23",
			}),
		]);
		const selected = await discoverTravelApplication(
			{
				url: "https://app.ekuaibao.com/example",
				hint: candidate.id,
				invoiceFacts: {
					travelDates: ["2026-08-21", "2026-08-22", "2026-08-23"],
					cities: ["南京", "常州", "苏州"],
				},
			},
			{ runtime: selectedRuntime, waitMilliseconds: 100 },
		);
		expect(selected.status).toBe("selected");

		const rejectedRuntime = new QueueRuntime([
			unselectedApplicationSnapshot(),
			applicationSearchSnapshot(),
			applicationCandidatesSnapshot([candidate]),
			applicationCandidatesSnapshot([candidate], true),
			selectedApplicationSnapshot({ title: candidate.title, reason: "管局演练支撑" }),
		]);
		const rejected = await discoverTravelApplication(
			{
				url: "https://app.ekuaibao.com/example",
				hint: candidate.id,
				invoiceFacts: { travelDates: ["2026-08-21"], cities: ["常州", "苏州"] },
			},
			{ runtime: rejectedRuntime, waitMilliseconds: 100 },
		);
		expect(rejected.status).toBe("needs_input");
		if (rejected.status !== "needs_input") throw new Error("expected needs_input");
		expect(rejected.ambiguous.map((item) => item.code)).toContain("application_city_conflict");
	});

	it("将用户原句“常州8月21的出差”解析为城市搜索词，日期只与票据和申请范围核对", async () => {
		const runtime = new QueueRuntime([
			unselectedApplicationSnapshot(),
			applicationSearchSnapshot(),
			applicationCandidatesSnapshot([{ id: "S26002261", title: "出差申请：常州业务拓展" }]),
			applicationCandidatesSnapshot([{ id: "S26002261", title: "出差申请：常州业务拓展" }], true),
			selectedApplicationSnapshot(),
		]);

		const result = await discoverTravelApplication(
			{
				url: "https://app.ekuaibao.com/example",
				hint: "常州8月21的出差",
				invoiceFacts: { travelDates: ["2026-08-21"], cities: ["南京", "常州"] },
			},
			{ runtime, waitMilliseconds: 100 },
		);

		expect(result.status).toBe("selected");
		const searchType = runtime.calls.find((call) => call.method === "type")?.value as { value?: string };
		expect(searchType.value).toBe("常州");
	});

	it("连接中断后重新核对同一申请来源，不清空或切换为其他申请", async () => {
		const complete = twoRailFixture();
		const runtime = new CompleteTwoRailRuntime(complete.expected);
		const first = new TravelDraftBrowserDriver({ runtime, cwd: complete.cwd, waitMilliseconds: 100 });
		const selected = await first.discoverApplication({
			url: complete.plan.url,
			hint: complete.expected.application.id,
			invoiceFacts: { travelDates: ["2026-08-21"], cities: ["南京", "常州"] },
		});
		expect(selected.status).toBe("selected");
		const clicksBeforeRetry = runtime.calls.filter((call) => call.method === "click").length;

		const retry = new TravelDraftBrowserDriver({ runtime, cwd: complete.cwd, waitMilliseconds: 100 });
		const recovered = await retry.discoverApplication({
			url: complete.plan.url,
			hint: complete.expected.application.id,
			invoiceFacts: { travelDates: ["2026-08-21"], cities: ["南京", "常州"] },
		});

		expect(recovered.status).toBe("selected");
		const retryClicks = runtime.calls.filter((call) => call.method === "click").slice(clicksBeforeRetry);
		expect(retryClicks.map((call) => call.value)).toEqual([
			{ selector: '[data-testid="field-expenseLink-select"]', scopeTexts: ["关联申请"] },
			{ ref: "e301", scopeTexts: [complete.expected.application.id, complete.expected.application.title] },
			{ ref: "e302", scopeTexts: [complete.expected.application.id, complete.expected.application.title] },
		]);
	});

	it("只在导航边界还原 vaulted URL，使用合成凭据完成打开", async () => {
		const original =
			"https://app.ekuaibao.com/web/app.html?accessToken=SYNTHETIC_TEST_TOKEN&ekbCorpId=TEST#/billEntryDetail";
		const vaulted = vaultSensitiveUrlsInText(original);
		expect(vaulted).toContain("pi-browser-secret-");
		expect(vaulted).not.toContain("SYNTHETIC_TEST_TOKEN");
		const runtime = new QueueRuntime([
			unselectedApplicationSnapshot(),
			applicationSearchSnapshot(),
			applicationCandidatesSnapshot([{ id: "S26002261", title: "出差申请：常州业务拓展" }]),
			applicationCandidatesSnapshot([{ id: "S26002261", title: "出差申请：常州业务拓展" }], true),
			selectedApplicationSnapshot(),
		]);

		const result = await discoverTravelApplication(
			{
				url: vaulted,
				hint: "S26002261",
				invoiceFacts: { travelDates: ["2026-08-21"], cities: ["南京", "常州"] },
			},
			{ runtime, waitMilliseconds: 100 },
		);

		expect(result.status).toBe("selected");
		expect(runtime.calls.find((call) => call.method === "navigate")?.value).toBe(original);
		expect(JSON.stringify(result)).not.toContain("SYNTHETIC_TEST_TOKEN");
	});

	it("拒绝非易快报域名、账号信息和非标准端口，不发出导航", async () => {
		for (const url of [
			"https://app.ekuaibao.com.evil.example/form",
			"https://user:password@app.ekuaibao.com/form",
			"https://app.ekuaibao.com:444/form",
			"http://app.ekuaibao.com/form",
		]) {
			const runtime = new QueueRuntime([]);
			await expect(
				discoverTravelApplication(
					{
						url,
						hint: "S26002261",
						invoiceFacts: { travelDates: ["2026-08-21"], cities: ["南京", "常州"] },
					},
					{ runtime, waitMilliseconds: 100 },
				),
			).rejects.toMatchObject({
				name: "TravelDraftBrowserBlocker",
				details: { code: "unsafe_target", operation: "打开差旅报销页面" },
			});
			expect(runtime.calls.some((call) => call.method === "navigate")).toBe(false);
		}
	});

	it("浏览器动作达预算后在下一个 DOM 事件前熔断", async () => {
		const runtime = new QueueRuntime([]);
		const events: Array<{ index: number; kind: string }> = [];
		await expect(
			discoverTravelApplication(
				{
					url: "https://app.ekuaibao.com/example",
					hint: "S26002261",
					invoiceFacts: { travelDates: ["2026-08-21"], cities: ["南京", "常州"] },
				},
				{
					runtime,
					waitMilliseconds: 100,
					maxBrowserActions: 1,
					onBrowserAction: (event) => {
						events.push({ index: event.index, kind: event.kind });
					},
				},
			),
		).rejects.toMatchObject({ details: { code: "action_budget" } });
		expect(events).toEqual([{ index: 1, kind: "navigate" }]);
		expect(
			runtime.calls
				.filter((call) => ["navigate", "snapshot", "click", "hover", "type", "uploadFiles"].includes(call.method))
				.map((call) => call.method),
		).toEqual(["navigate"]);
	});

	it("同一生产 driver 完成两程交通和补助后低于 320 动作，旧 160 预算仍安全熔断", async () => {
		const complete = twoRailFixture();
		const runtime = new CompleteTwoRailRuntime(complete.expected);
		const browserActions: number[] = [];
		const driver = new TravelDraftBrowserDriver({
			runtime,
			cwd: complete.cwd,
			waitMilliseconds: 100,
			maxBrowserActions: 320,
			onBrowserAction: ({ index }) => {
				browserActions.push(index);
			},
		});
		const discovery = await driver.discoverApplication({
			url: complete.plan.url,
			hint: complete.expected.application.id,
			invoiceFacts: { travelDates: ["2026-08-21"], cities: ["南京", "常州"] },
		});
		expect(discovery.status).toBe("selected");
		const done = await runTravelDraft(driver, complete.plan);

		expect(done.status, JSON.stringify(done)).toBe("done");
		expect(done.stage).toBe("DONE");
		expect(browserActions.length).toBeGreaterThan(160);
		expect(browserActions.length).toBeLessThan(320);
		expect(runtime.calls).toContainEqual({
			method: "click",
			value: { selector: '[data-testid="flexable-button-edit"]', scopeTexts: ["差旅费用报销单"] },
		});
		const sameSession = await driver.observe(complete.expected);
		expect(sameSession.detailCount).toBe(3);
		expect(sameSession.details.map((row) => row.key)).toEqual([
			complete.expected.transport[0].key,
			complete.expected.transport[1].key,
			complete.expected.allowance.key,
		]);
		const recoveryDriver = new TravelDraftBrowserDriver({
			runtime,
			cwd: complete.cwd,
			waitMilliseconds: 100,
			maxBrowserActions: 320,
		});
		await expect(recoveryDriver.precheck(complete.plan, complete.expected)).rejects.toMatchObject({
			name: "TravelDraftBrowserBlocker",
			details: { code: "unverified_state", operation: "复核已有费用明细" },
		});
		expect(runtime.calls.filter((call) => call.method === "click").map((call) => call.value)).toEqual(
			expect.arrayContaining([
				{ ref: "e200", scopeTexts: [FEE_TYPE, "2026-08-21", "¥72.00"] },
				{ ref: "e201", scopeTexts: [FEE_TYPE, "2026-08-21", "¥75.00"] },
			]),
		);

		const limited = twoRailFixture();
		const limitedRuntime = new CompleteTwoRailRuntime(limited.expected);
		const limitedActions: number[] = [];
		const limitedDriver = new TravelDraftBrowserDriver({
			runtime: limitedRuntime,
			cwd: limited.cwd,
			waitMilliseconds: 100,
			maxBrowserActions: 160,
			onBrowserAction: ({ index }) => {
				limitedActions.push(index);
			},
		});
		const limitedDiscovery = await limitedDriver.discoverApplication({
			url: limited.plan.url,
			hint: limited.expected.application.id,
			invoiceFacts: { travelDates: ["2026-08-21"], cities: ["南京", "常州"] },
		});
		expect(limitedDiscovery.status).toBe("selected");
		const blocked = await runTravelDraft(limitedDriver, limited.plan);

		expect(blocked.status).toBe("blocked");
		expect(limitedActions).toHaveLength(160);
		expect(
			limitedRuntime.calls.filter((call) =>
				["navigate", "snapshot", "click", "hover", "type", "uploadFiles"].includes(call.method),
			),
		).toHaveLength(160);
		expect(JSON.stringify(limitedRuntime.calls)).not.toMatch(/flexable-button-submit|提交送审|删除单据/);
	});

	it("两条同类型交通明细的姓名折叠支付凭证按业务行隔离，新 driver 不继承", async () => {
		const complete = twoRailFixture();
		const runtime = new NameOnlyTwoRailPaymentRuntime(complete.expected);
		const driver = new TravelDraftBrowserDriver({
			runtime,
			cwd: complete.cwd,
			waitMilliseconds: 100,
			maxBrowserActions: 320,
		});
		const discovery = await driver.discoverApplication({
			url: complete.plan.url,
			hint: complete.expected.application.id,
			invoiceFacts: { travelDates: ["2026-08-21"], cities: ["南京", "常州"] },
		});
		expect(discovery.status).toBe("selected");
		await driver.precheck(complete.plan, complete.expected);
		await driver.ensureHeader(complete.expected.header);
		for (const [index, row] of complete.expected.transport.entries()) await driver.ensureTransport(row, index);

		expect(runtime.mainPaymentSelections).toBe(1);
		expect(runtime.paymentSelectionRows).toEqual(complete.expected.transport.map((row) => row.key));
		const sameDriver = await driver.observe(complete.expected);
		expect(sameDriver.details.filter((row) => row.kind === "transport").map((row) => row.key)).toEqual(
			complete.expected.transport.map((row) => row.key),
		);

		const recovered = await new TravelDraftBrowserDriver({
			runtime,
			cwd: complete.cwd,
			waitMilliseconds: 100,
		}).observe(complete.expected);
		expect(recovered.header?.paymentRecipient).toBeUndefined();
		expect(recovered.details.filter((row) => row.kind === "transport")).toEqual([]);
		expect(runtime.paymentSelectionRows).toEqual(complete.expected.transport.map((row) => row.key));
	});

	it.each([
		["同日往返", twoRailFixture, false],
		["多日含住宿", multiDayFixture, true],
	] as const)("%s 完整流程只允许 typed trusted 写操作", async (_name, makeFixture, includesHotel) => {
		const complete = makeFixture();
		const runtime = new TrustedOnlyCompleteRuntime(complete.expected);
		const driver = new TravelDraftBrowserDriver({
			runtime,
			cwd: complete.cwd,
			waitMilliseconds: 100,
			maxBrowserActions: 1_000,
		});
		const discovery = await driver.discoverApplication({
			url: complete.plan.url,
			hint: complete.expected.application.id,
			invoiceFacts: {
				travelDates: complete.expected.transport.map((row) => row.travelDate),
				cities: complete.expected.transport.flatMap((row) => [row.fromCity, row.toCity]),
			},
		});
		expect(discovery.status, JSON.stringify(discovery)).toBe("selected");
		// Exercise trusted writes even for fields that the synthetic page originally
		// populated, while retaining the already verified linked-application facts.
		runtime.invalidateWritableDefaults();

		const done = await runTravelDraft(driver, complete.plan);
		expect(done.status, JSON.stringify(done)).toBe("done");
		expect(done.stage).toBe("DONE");
		expect(runtime.calls.filter((call) => ["click", "hover", "type", "uploadFiles"].includes(call.method))).toEqual(
			[],
		);

		const commands = runtime.calls
			.filter((call) => call.method === "trusted")
			.map((call) => call.value as EkuaibaoTrustedCommand);
		const controls = commands.flatMap((command) =>
			command.op === "click" || command.op === "hover" ? [command.control] : [],
		);
		const fields = commands.flatMap((command) => (command.op === "type" ? [command.field] : []));
		const options = commands.flatMap((command) => (command.op === "select-exact" ? [command.optionKind] : []));
		const uploads = commands.flatMap((command) => (command.op === "upload" ? [command.slot] : []));

		expect(controls).toEqual(
			expect.arrayContaining([
				"open-application",
				"open-application-details",
				"close-application-details",
				"confirm-application",
				"open-main-payment-recipient",
				"add-detail",
				"open-expense-reporter",
				"open-payment-recipient",
				"show-invoice-menu",
				"open-smart-invoice",
				"confirm-invoice-upload",
				"bind-recognized-invoice",
				"save-detail",
				"open-detail",
				"close-detail",
			]),
		);
		expect(fields).toEqual(
			expect.arrayContaining([
				"application-search",
				"description",
				"station",
				"reimbursement-date",
				"expense-nature",
				"applicant-department",
				"expense-department",
				"fee-type-search",
				"detail-start-date",
				"detail-end-date",
				"departure-city",
				"arrival-city",
				"seat-class",
				"reimbursement-amount",
			]),
		);
		expect(options).toEqual(
			expect.arrayContaining([
				"application",
				"station",
				"expense-nature",
				"department",
				"fee-type",
				"city",
				"seat-class",
				"expense-reporter",
				"payment-recipient",
				"allowance-type",
				"recognized-invoice",
			]),
		);
		expect(uploads).toEqual(expect.arrayContaining(["smart-invoice", "detail-attachments"]));
		expect(commands.some((command) => command.op === "save-draft")).toBe(true);
		expect(
			commands.some(
				(command) =>
					command.op === "click" &&
					command.control === "open-detail" &&
					command.detailKind === (includesHotel ? "hotel" : "transport") &&
					(command.evidence?.length ?? 0) >= 4,
			),
		).toBe(true);
	});

	it("同一 driver 看到新 pageToken 后撤销主表和逐行业务凭证，主表重选但旧明细不放行", async () => {
		const complete = twoRailFixture();
		const runtime = new TrustedOnlyCompleteRuntime(complete.expected);
		const driver = new TravelDraftBrowserDriver({
			runtime,
			cwd: complete.cwd,
			waitMilliseconds: 100,
			maxBrowserActions: 1_000,
		});
		const discovery = await driver.discoverApplication({
			url: complete.plan.url,
			hint: complete.expected.application.id,
			invoiceFacts: { travelDates: ["2026-08-21"], cities: ["南京", "常州"] },
		});
		expect(discovery.status).toBe("selected");
		runtime.invalidateWritableDefaults();
		const done = await runTravelDraft(driver, complete.plan);
		expect(done.status, JSON.stringify(done)).toBe("done");

		const paymentSelections = () =>
			runtime.calls
				.filter((call) => call.method === "trusted")
				.map((call) => call.value as EkuaibaoTrustedCommand)
				.filter(
					(command): command is Extract<EkuaibaoTrustedCommand, { op: "select-exact" }> =>
						command.op === "select-exact" && command.optionKind === "payment-recipient",
				);
		const mainBefore = paymentSelections().filter((command) => command.scope.kind === "main").length;
		const detailsBefore = paymentSelections().filter((command) => command.scope.kind === "detail-drawer").length;
		expect(mainBefore).toBe(1);
		expect(detailsBefore).toBe(3);

		runtime.rotateDocumentToken();
		const header = await driver.ensureHeader(complete.expected.header);
		expect(header.header?.paymentRecipient).toBe(TRAVEL_DRAFT_CURRENT_USER);
		expect(paymentSelections().filter((command) => command.scope.kind === "main")).toHaveLength(mainBefore + 1);
		expect(paymentSelections().filter((command) => command.scope.kind === "detail-drawer")).toHaveLength(
			detailsBefore,
		);

		const verification = await driver.verify(complete.expected);
		expect(verification.verification).toMatchObject({ valid: false });
		expect(verification.details).toEqual([]);
		expect(paymentSelections().filter((command) => command.scope.kind === "detail-drawer")).toHaveLength(
			detailsBefore,
		);
	});

	it("controller 仅按费用类型只返回标题时，同日同金额往返仍按出发到达方向分别新增和恢复", async () => {
		const complete = twoRailFixture(72);
		const runtime = new CompleteTwoRailRuntime(complete.expected);
		const driver = new TravelDraftBrowserDriver({ runtime, cwd: complete.cwd, waitMilliseconds: 100 });
		const discovery = await driver.discoverApplication({
			url: complete.plan.url,
			hint: complete.expected.application.id,
			invoiceFacts: { travelDates: ["2026-08-21"], cities: ["南京", "常州"] },
		});
		expect(discovery.status).toBe("selected");
		const done = await runTravelDraft(driver, complete.plan);
		expect(done.status, JSON.stringify(done)).toBe("done");

		const titleOnly = await runtime.snapshot({ maxChars: 12_000, maxElements: 1_000, scopeTexts: [FEE_TYPE] });
		expect(titleOnly).toContain(FEE_TYPE);
		expect(titleOnly).not.toMatch(/出发城市|到达城市|报销费用金额/);
		const rowScopes = runtime.calls
			.filter((call) => call.method === "snapshot")
			.map((call) => (call.value as AgentBrowserSnapshotOptions).scopeTexts)
			.filter(
				(scope): scope is string[] =>
					Array.isArray(scope) &&
					scope.length === 3 &&
					scope[0] === FEE_TYPE &&
					scope[1] === "2026-08-21" &&
					scope[2] === "¥72.00",
			);
		expect(rowScopes.length).toBeGreaterThanOrEqual(4);

		const recovered = await driver.observe(complete.expected);
		expect(recovered.detailCount).toBe(3);
		expect(recovered.details.map((row) => row.key)).toEqual([
			complete.expected.transport[0].key,
			complete.expected.transport[1].key,
			complete.expected.allowance.key,
		]);
		const recoveryDriver = new TravelDraftBrowserDriver({ runtime, cwd: complete.cwd, waitMilliseconds: 100 });
		await expect(recoveryDriver.precheck(complete.plan, complete.expected)).rejects.toMatchObject({
			name: "TravelDraftBrowserBlocker",
			details: { code: "unverified_state", operation: "复核已有费用明细" },
		});
		expect(runtime.calls.filter((call) => call.method === "click").map((call) => call.value)).toEqual(
			expect.arrayContaining([
				{ ref: "e200", scopeTexts: [FEE_TYPE, "2026-08-21", "¥72.00"] },
				{ ref: "e201", scopeTexts: [FEE_TYPE, "2026-08-21", "¥72.00"] },
			]),
		);
	});

	it("多日两程交通、住宿和两日补助含双重新鲜核验仍严格低于 400 浏览器动作", async () => {
		const complete = multiDayFixture();
		const runtime = new CompleteTwoRailRuntime(complete.expected);
		const browserActions: number[] = [];
		const driver = new TravelDraftBrowserDriver({
			runtime,
			cwd: complete.cwd,
			waitMilliseconds: 100,
			maxBrowserActions: 400,
			onBrowserAction: ({ index }) => {
				browserActions.push(index);
			},
		});
		const discovery = await driver.discoverApplication({
			url: complete.plan.url,
			hint: complete.expected.application.id,
			invoiceFacts: { travelDates: ["2026-08-21", "2026-08-22"], cities: ["南京", "常州"] },
		});
		expect(discovery.status).toBe("selected");
		const done = await runTravelDraft(driver, complete.plan);

		expect(done.status, JSON.stringify(done)).toBe("done");
		expect(done.stage).toBe("DONE");
		expect(browserActions.length).toBeGreaterThan(320);
		expect(browserActions.length).toBeLessThan(400);
		expect(browserActions.length).toBeGreaterThan(200);
		expect(runtime.calls).toContainEqual({
			method: "click",
			value: { ref: "e210", scopeTexts: [HOTEL_FEE_TYPE, "苏爱健"] },
		});
		expect(JSON.stringify(runtime.calls)).not.toMatch(/flexable-button-submit|提交送审|删除单据/);
	});

	it("住宿识票不依赖票号，仅凭唯一结果、金额、合理日期和住宿票种签发绑定 token", async () => {
		const complete = multiDayFixture();
		const runtime = new CompleteTwoRailRuntime(complete.expected);
		const driver = new TravelDraftBrowserDriver({ runtime, cwd: complete.cwd, waitMilliseconds: 100 });
		const discovery = await driver.discoverApplication({
			url: complete.plan.url,
			hint: complete.expected.application.id,
			invoiceFacts: { travelDates: ["2026-08-21", "2026-08-22"], cities: ["南京", "常州"] },
		});
		expect(discovery.status).toBe("selected");
		const done = await runTravelDraft(driver, complete.plan);

		expect(done.status, JSON.stringify(done)).toBe("done");
		expect(JSON.stringify(runtime.calls)).not.toContain(complete.expected.hotel?.invoiceNumber);
	});

	it("住宿智能识票出现两个同额结果时阻断，不勾选或绑定", async () => {
		const complete = multiDayFixture();
		const runtime = new CompleteTwoRailRuntime(complete.expected, { hotelRecognitionCount: 2 });
		const driver = new TravelDraftBrowserDriver({ runtime, cwd: complete.cwd, waitMilliseconds: 100 });
		const discovery = await driver.discoverApplication({
			url: complete.plan.url,
			hint: complete.expected.application.id,
			invoiceFacts: { travelDates: ["2026-08-21", "2026-08-22"], cities: ["南京", "常州"] },
		});
		expect(discovery.status).toBe("selected");
		const blocked = await runTravelDraft(driver, complete.plan);

		expect(blocked.status).toBe("blocked");
		expect(blocked.stage).toBe("HOTEL");
		const hotelRecognitionClicks = runtime.calls.filter(
			(call) =>
				call.method === "click" &&
				(call.value as AgentBrowserTarget | undefined)?.scopeTexts?.includes("通过智能识票识别出"),
		);
		// 两程交通各有“勾选+绑定”两次；住宿的歧义结果没有新增任何一次。
		expect(hotelRecognitionClicks).toHaveLength(4);
	});

	it("AbortSignal 在当前 runtime 动作返回后立即停止，不继续快照或点击", async () => {
		const controller = new AbortController();
		const runtime = new AbortAfterNavigateRuntime([], controller);
		await expect(
			discoverTravelApplication(
				{
					url: "https://app.ekuaibao.com/example",
					hint: "S26002261",
					invoiceFacts: { travelDates: ["2026-08-21"], cities: ["南京", "常州"] },
				},
				{ runtime, waitMilliseconds: 100, signal: controller.signal },
			),
		).rejects.toBeInstanceOf(TravelDraftInterruptedError);
		expect(
			runtime.calls
				.filter((call) => ["navigate", "snapshot", "click"].includes(call.method))
				.map((call) => call.method),
		).toEqual(["navigate"]);
	});

	it("多个申请候选一次性返回 ambiguous，不点击任一 radio 或确认", async () => {
		const runtime = new QueueRuntime([
			unselectedApplicationSnapshot(),
			applicationSearchSnapshot(),
			applicationCandidatesSnapshot([
				{ id: "S26002261", title: "出差申请：常州业务拓展" },
				{ id: "S26002262", title: "出差申请：常州业务拓展二期" },
			]),
		]);

		const result = await discoverTravelApplication(
			{
				url: "https://app.ekuaibao.com/example",
				hint: "常州",
				invoiceFacts: { travelDates: ["2026-08-21"], cities: ["南京", "常州"] },
			},
			{ runtime, waitMilliseconds: 100 },
		);

		expect(result.status).toBe("needs_input");
		if (result.status !== "needs_input") throw new Error("expected needs_input");
		expect(result.ambiguous.map((item) => item.code)).toEqual(["application_ambiguous"]);
		expect(runtime.calls.filter((call) => call.method === "click")).toHaveLength(1);
	});

	it("页面已是多收款人时立即阻断，绝不触碰该开关", async () => {
		const { cwd, plan, expected } = fixture();
		const runtime = new QueueRuntime([
			[
				"可操作元素：",
				"[e1] button 存为草稿 (testid=flexable-button-edit type=button)",
				"[e2] button 苏爱健 (label=提交人)",
				"[e3] div 多收款人 (label=支付信息 placeholder=多收款人)",
				"[e4] input （无文字） (label=是否为多收款人 type=checkbox checked=true aria-checked=true)",
				"[e5] input/disabled 赛昇信息技术研究院江苏有限公司 (label=所属公司 type=text)",
				"页面正文：差旅费用报销单",
			].join("\n"),
		]);
		const driver = new TravelDraftBrowserDriver({ runtime, cwd, waitMilliseconds: 100 });
		await driver.precheck(plan, expected);
		runtime.openState = true;

		await expect(driver.ensureHeader(expected.header)).rejects.toMatchObject({
			name: "TravelDraftBrowserBlocker",
			details: { code: "unsafe_page_state" },
		});
		const actions = runtime.calls.filter((call) => ["click", "type", "hover", "uploadFiles"].includes(call.method));
		expect(actions).toEqual([]);
	});

	it("顶部支付信息为空、摘要或仅含姓名时，checkbox=false 仍必须选择精确个人账户", async () => {
		const { cwd, plan, expected } = fixture();
		for (const topPayment of ["请选择支付信息", "多收款人", "苏爱健", "苏爱健（公司账户） 招商银行 尾号1234"]) {
			const runtime = new PaymentHeaderRuntime(expected, expected.header.company, topPayment);
			const driver = new TravelDraftBrowserDriver({ runtime, cwd, waitMilliseconds: 100 });
			await driver.precheck(plan, expected);
			runtime.openState = true;

			const observation = await driver.ensureHeader(expected.header);

			expect(observation.header).toMatchObject({
				multipleRecipients: false,
				applicantDepartment: TRAVEL_DRAFT_DEPARTMENT,
				expenseDepartment: TRAVEL_DRAFT_DEPARTMENT,
			});
			expect(observation.header?.paymentRecipient).toBe(TRAVEL_DRAFT_CURRENT_USER);
			const clicks = runtime.calls.filter((call) => call.method === "click").map((call) => call.value);
			expect(clicks).toContainEqual({ ref: "e37", scopeTexts: ["支付信息"] });
			expect(clicks).toContainEqual({ ref: "e110", scopeTexts: [TRAVEL_DRAFT_CURRENT_USER] });
			expect(JSON.stringify(clicks)).not.toContain("e39");
		}
	});

	it("主表本轮选择唯一个人账户后允许字段折叠为姓名，但新 driver 不继承该凭证", async () => {
		const { cwd, plan, expected } = fixture();
		const runtime = new NameOnlyPaymentHeaderRuntime(expected);
		const driver = new TravelDraftBrowserDriver({ runtime, cwd, waitMilliseconds: 100 });
		await driver.precheck(plan, expected);
		runtime.openState = true;

		const selected = await driver.ensureHeader(expected.header);
		expect(selected.header?.paymentRecipient).toBe(TRAVEL_DRAFT_CURRENT_USER);
		expect(runtime.calls).toContainEqual({ method: "click", value: { ref: "e37", scopeTexts: ["支付信息"] } });
		expect(runtime.calls).toContainEqual({
			method: "click",
			value: { ref: "e110", scopeTexts: [TRAVEL_DRAFT_CURRENT_USER] },
		});
		runtime.showPayment("苏爱健（公司账户） 招商银行 尾号1234");
		const drifted = await driver.verify(expected);
		expect(drifted.verification).toMatchObject({ valid: false });
		expect(drifted.header?.paymentRecipient).toBeUndefined();

		runtime.showPayment("苏爱健");
		const recovered = await new TravelDraftBrowserDriver({ runtime, cwd, waitMilliseconds: 100 }).verify(expected);
		expect(recovered.verification).toMatchObject({ valid: false });
		expect(recovered.header?.paymentRecipient).toBeUndefined();
	});

	it.each(["legacy snapshot", "trusted state"] as const)(
		"新进程最终核验拒绝末级部门和非个人支付摘要：%s",
		async (mode) => {
			const { cwd, expected } = fixture();
			const makeRuntime = (payment: string, applicantDepartment: string, expenseDepartment: string) =>
				mode === "trusted state"
					? new TrustedHeaderReadRuntime(expected, payment, applicantDepartment, expenseDepartment)
					: new CompleteHeaderRuntime(
							expected,
							expected.header.company,
							payment,
							applicantDepartment,
							expenseDepartment,
						);

			const leafRuntime = makeRuntime("苏爱健（个人账户）", "工业信息安全组", "工业信息安全组");
			leafRuntime.openState = true;
			const leafVerification = await new TravelDraftBrowserDriver({
				runtime: leafRuntime,
				cwd,
				waitMilliseconds: 100,
			}).verify(expected);
			expect(leafVerification.verification).toMatchObject({ valid: false });
			expect(leafVerification.header?.applicantDepartment).toBeUndefined();
			expect(leafVerification.header?.expenseDepartment).toBeUndefined();
			expect(leafVerification.header?.paymentRecipient).toBe(TRAVEL_DRAFT_CURRENT_USER);

			const paymentRuntime = makeRuntime(
				"苏爱健（公司账户） 招商银行 尾号1234",
				TRAVEL_DRAFT_DEPARTMENT,
				TRAVEL_DRAFT_DEPARTMENT,
			);
			paymentRuntime.openState = true;
			const paymentVerification = await new TravelDraftBrowserDriver({
				runtime: paymentRuntime,
				cwd,
				waitMilliseconds: 100,
			}).verify(expected);
			expect(paymentVerification.verification).toMatchObject({ valid: false });
			expect(paymentVerification.header).toMatchObject({
				applicantDepartment: TRAVEL_DRAFT_DEPARTMENT,
				expenseDepartment: TRAVEL_DRAFT_DEPARTMENT,
			});
			expect(paymentVerification.header?.paymentRecipient).toBeUndefined();
			for (const runtime of [leafRuntime, paymentRuntime]) {
				expect(
					runtime.calls.filter((call) => ["click", "type", "hover", "uploadFiles"].includes(call.method)),
				).toEqual([]);
			}
		},
	);

	it("所属公司只读核验：空值或错误公司均在任何填写前 blocker", async () => {
		const { cwd, plan, expected } = fixture();
		for (const company of ["", "其他测试公司"]) {
			const runtime = new CompleteHeaderRuntime(expected, company);
			const driver = new TravelDraftBrowserDriver({ runtime, cwd, waitMilliseconds: 100 });
			await driver.precheck(plan, expected);
			runtime.openState = true;

			await expect(driver.ensureHeader(expected.header)).rejects.toMatchObject({
				name: "TravelDraftBrowserBlocker",
				details: { operation: "核对所属公司" },
			});
			expect(
				runtime.calls.filter((call) => ["click", "type", "hover", "uploadFiles"].includes(call.method)),
			).toEqual([]);
		}
	});

	it("部门必须核对完整组织路径，同叶不同父级或错误父级均阻断", async () => {
		const { cwd, plan, expected } = fixture();
		for (const [applicantDepartment, expenseDepartment] of [
			["其他公司/政策支撑部/工业信息安全组", TRAVEL_DRAFT_DEPARTMENT],
			[TRAVEL_DRAFT_DEPARTMENT, "赛昇信息技术研究院江苏有限公司/其他部门/工业信息安全组"],
		] as const) {
			const runtime = new CompleteHeaderRuntime(
				expected,
				expected.header.company,
				"请选择支付信息",
				applicantDepartment,
				expenseDepartment,
			);
			const driver = new TravelDraftBrowserDriver({ runtime, cwd, waitMilliseconds: 100 });
			await driver.precheck(plan, expected);
			runtime.openState = true;

			await expect(driver.ensureHeader(expected.header)).rejects.toMatchObject({
				name: "TravelDraftBrowserBlocker",
				details: { code: "unsafe_page_state" },
			});
			expect(
				runtime.calls.filter((call) => ["click", "type", "hover", "uploadFiles"].includes(call.method)),
			).toEqual([]);
		}

		const complete = new CompleteHeaderRuntime(expected);
		const driver = new TravelDraftBrowserDriver({ runtime: complete, cwd, waitMilliseconds: 100 });
		await driver.precheck(plan, expected);
		complete.openState = true;
		const observation = await driver.ensureHeader(expected.header);
		expect(observation.header).toMatchObject({
			applicantDepartment: TRAVEL_DRAFT_DEPARTMENT,
			expenseDepartment: TRAVEL_DRAFT_DEPARTMENT,
		});
	});

	it("部门为空时只选择唯一完整路径，字段折叠为叶子后仍保留本轮验证证据", async () => {
		const { cwd, plan, expected } = fixture();
		const runtime = new DepartmentSelectionRuntime(expected);
		const driver = new TravelDraftBrowserDriver({ runtime, cwd, waitMilliseconds: 100 });
		await driver.precheck(plan, expected);
		runtime.openState = true;

		const observation = await driver.ensureHeader(expected.header);

		expect(observation.header).toMatchObject({ applicantDepartment: TRAVEL_DRAFT_DEPARTMENT });
		expect(runtime.calls).toContainEqual({
			method: "click",
			value: { ref: "e71", scopeTexts: ["工业信息安全组"] },
		});
		expect(runtime.calls).not.toContainEqual({
			method: "click",
			value: { ref: "e70", scopeTexts: ["工业信息安全组"] },
		});
	});

	it("火车明细严格执行 hover 智能识票、唯一发票绑定和 scoped 附件上传", async () => {
		const { cwd, plan, expected } = fixture();
		const runtime = new InvoiceFlowRuntime(expected);
		const driver = new TravelDraftBrowserDriver({ runtime, cwd, waitMilliseconds: 100 });
		await driver.precheck(plan, expected);
		runtime.openState = true;

		await driver.ensureTransport(expected.transport[0], 0);

		const actions = runtime.calls.filter((call) => ["click", "type", "hover", "uploadFiles"].includes(call.method));
		const hoverIndex = actions.findIndex((call) => call.method === "hover");
		const smartIndex = actions.findIndex(
			(call, index) =>
				index > hoverIndex &&
				call.method === "click" &&
				(call.value as AgentBrowserTarget | undefined)?.ref === "e1",
		);
		const invoiceUploadIndex = actions.findIndex(
			(call) =>
				call.method === "uploadFiles" && (call.value as { target?: AgentBrowserTarget }).target?.ref === "e1",
		);
		const bindIndex = actions.findIndex(
			(call) => call.method === "click" && (call.value as AgentBrowserTarget | undefined)?.ref === "e7",
		);
		expect(hoverIndex).toBeGreaterThanOrEqual(0);
		expect(smartIndex).toBeGreaterThan(hoverIndex);
		expect(invoiceUploadIndex).toBeGreaterThan(smartIndex);
		expect(bindIndex).toBeGreaterThan(invoiceUploadIndex);
		expect(runtime.uploadAllowedOrigins.length).toBeGreaterThan(0);
		expect(new Set(runtime.uploadAllowedOrigins)).toEqual(new Set(["https://app.ekuaibao.com"]));
		expect(actions).toContainEqual({
			method: "uploadFiles",
			value: {
				names: [basename(expected.transport[0].uploadFile)],
				target: { ref: "e1", scopeTexts: ["智能识票", "上传文件"] },
			},
		});
		expect(actions).toContainEqual({
			method: "uploadFiles",
			value: {
				names: [basename(expected.transport[0].uploadFile), basename(expected.transport[0].verificationFiles[0])],
				target: {
					ref: "e12",
					scopeTexts: ["添加明细", FEE_TYPE, "附件", "苏爱健"],
				},
			},
		});
		const encoded = JSON.stringify(actions);
		expect(encoded).not.toMatch(/flexable-button-submit|flexable-button-delete|是否为多收款人/);
		expect(
			runtime.calls.some(
				(call) =>
					call.method === "snapshot" &&
					JSON.stringify(call.value) ===
						JSON.stringify({
							maxChars: 12000,
							maxElements: 1000,
							scopeTexts: ["与该消费绑定"],
						}),
			),
		).toBe(false);
	});

	it("识票覆盖日期、区县城市、席别、金额和收款人后，后置 ensure 全部纠正再保存", async () => {
		const { cwd, plan, expected } = fixture();
		const runtime = new InvoiceFlowRuntime(expected, { invoiceBindingOverwritesFields: true });
		const driver = new TravelDraftBrowserDriver({ runtime, cwd, waitMilliseconds: 100 });
		await driver.precheck(plan, expected);
		runtime.openState = true;

		const observation = await driver.ensureTransport(expected.transport[0], 0);

		expect(observation.details.map((row) => row.key)).toContain(expected.transport[0].key);
		const actions = runtime.calls.filter((call) => ["click", "type"].includes(call.method));
		const bindIndex = actions.findIndex(
			(call) =>
				call.method === "click" &&
				(call.value as AgentBrowserTarget | undefined)?.scopeTexts?.includes("与该消费绑定"),
		);
		for (const ref of ["e2", "e3", "e4", "e5", "e6", "e8"]) {
			expect(
				actions.findIndex(
					(call) => call.method === "type" && (call.value as { target?: AgentBrowserTarget }).target?.ref === ref,
				),
			).toBeGreaterThan(bindIndex);
		}
	});

	it("本轮识票 token 允许绑定后 UI 不显示票号，但仍要求唯一发票数和精确金额", async () => {
		const { cwd, plan, expected } = fixture();
		const runtime = new InvoiceFlowRuntime(expected, { omitBoundInvoiceIdentity: true });
		const driver = new TravelDraftBrowserDriver({ runtime, cwd, waitMilliseconds: 100 });
		await driver.precheck(plan, expected);
		runtime.openState = true;

		const observation = await driver.ensureTransport(expected.transport[0], 0);

		expect(observation.details.map((row) => row.key)).toContain(expected.transport[0].key);
	});

	it("同日同额另一方向已有发票时不得复用首程 token", async () => {
		const complete = twoRailFixture(72);
		const runtime = new CompleteTwoRailRuntime(complete.expected, { preboundSecondTransport: true });
		const driver = new TravelDraftBrowserDriver({ runtime, cwd: complete.cwd, waitMilliseconds: 100 });
		const discovery = await driver.discoverApplication({
			url: complete.plan.url,
			hint: complete.expected.application.id,
			invoiceFacts: { travelDates: ["2026-08-21"], cities: ["南京", "常州"] },
		});
		expect(discovery.status).toBe("selected");

		const blocked = await runTravelDraft(driver, complete.plan);

		expect(blocked.status).toBe("blocked");
		expect(blocked.stage).toBe("TRANSPORT");
		expect(blocked.errors.join("\n")).toContain("本轮没有识票绑定凭证");
	});

	it("智能识票结果延迟出现时轮询双锚点，超时则不勾选也不绑定", async () => {
		const { cwd, plan, expected } = fixture();
		const delayedRuntime = new InvoiceFlowRuntime(expected, { recognitionDelaySnapshots: 3 });
		const delayedDriver = new TravelDraftBrowserDriver({ runtime: delayedRuntime, cwd, waitMilliseconds: 100 });
		await delayedDriver.precheck(plan, expected);
		delayedRuntime.openState = true;
		await delayedDriver.ensureTransport(expected.transport[0], 0);
		const recognitionScopes = delayedRuntime.calls.filter(
			(call) =>
				call.method === "snapshot" &&
				JSON.stringify((call.value as AgentBrowserSnapshotOptions).scopeTexts) ===
					JSON.stringify(["通过智能识票识别出", "与该消费绑定"]),
		);
		expect(recognitionScopes.length).toBeGreaterThanOrEqual(4);

		const timeoutRuntime = new InvoiceFlowRuntime(expected, { recognitionDelaySnapshots: 31 });
		const timeoutDriver = new TravelDraftBrowserDriver({ runtime: timeoutRuntime, cwd, waitMilliseconds: 100 });
		await timeoutDriver.precheck(plan, expected);
		timeoutRuntime.openState = true;
		await expect(timeoutDriver.ensureTransport(expected.transport[0], 0)).rejects.toMatchObject({
			name: "TravelDraftBrowserBlocker",
			details: { code: "invoice_dialog_contract", operation: "选择识别发票" },
		});
		expect(
			timeoutRuntime.calls.some(
				(call) =>
					call.method === "click" &&
					["e6", "e7"].includes((call.value as AgentBrowserTarget | undefined)?.ref ?? ""),
			),
		).toBe(false);
	});

	it("保存明细后必须重开抽屉，附件丢失或换绑另一票即阻断", async () => {
		const { cwd, plan, expected } = fixture();
		for (const options of [
			{ dropAttachmentsAfterSave: true },
			{ swapInvoiceAfterSave: true },
			{ postSaveInvoiceAmount: 73 },
			{ postSaveInvoiceCount: 0 },
		]) {
			const runtime = new InvoiceFlowRuntime(expected, options);
			const driver = new TravelDraftBrowserDriver({ runtime, cwd, waitMilliseconds: 100 });
			await driver.precheck(plan, expected);
			runtime.openState = true;

			await expect(driver.ensureTransport(expected.transport[0], 0)).rejects.toMatchObject({
				name: "TravelDraftBrowserBlocker",
				details: { code: "unverified_state", operation: "复核已有费用明细" },
			});
			expect(runtime.calls).toContainEqual({
				method: "click",
				value: { ref: "e20", scopeTexts: [FEE_TYPE, "2026-08-21", "¥72.00"] },
			});
		}
	});

	it("费用报销人选择点击无效时，立即 scoped 回读失败并停止", async () => {
		const { cwd, plan, expected } = fixture();
		const runtime = new InvoiceFlowRuntime(expected, {
			reporterInitiallyEmpty: true,
			recipientSelectionNoop: true,
		});
		const driver = new TravelDraftBrowserDriver({ runtime, cwd, waitMilliseconds: 100 });
		await driver.precheck(plan, expected);
		runtime.openState = true;

		await expect(driver.ensureTransport(expected.transport[0], 0)).rejects.toMatchObject({
			name: "TravelDraftBrowserBlocker",
			details: { code: "unverified_state", operation: "填写费用报销人" },
		});
		expect(runtime.calls.some((call) => call.method === "hover")).toBe(true);
		expect(
			runtime.calls.some(
				(call) =>
					call.method === "click" &&
					(call.value as AgentBrowserTarget | undefined)?.selector === '[data-testid="feetype-footer-save"]',
			),
		).toBe(false);
	});

	it("支付信息选择点击无效时，必须回读个人账户，不能由费用报销人掩盖", async () => {
		const { cwd, plan, expected } = fixture();
		const runtime = new InvoiceFlowRuntime(expected, {
			paymentInitiallyEmpty: true,
			recipientSelectionNoop: true,
		});
		const driver = new TravelDraftBrowserDriver({ runtime, cwd, waitMilliseconds: 100 });
		await driver.precheck(plan, expected);
		runtime.openState = true;

		await expect(driver.ensureTransport(expected.transport[0], 0)).rejects.toMatchObject({
			name: "TravelDraftBrowserBlocker",
			details: { code: "unverified_state", operation: "填写支付信息" },
		});
		expect(runtime.calls.some((call) => call.method === "hover")).toBe(true);
		expect(
			runtime.calls.some(
				(call) =>
					call.method === "click" &&
					(call.value as AgentBrowserTarget | undefined)?.selector === '[data-testid="feetype-footer-save"]',
			),
		).toBe(false);
	});

	it("支付信息可回读唯一银行账号形式，选择器也不要求固定“个人账户”字样", async () => {
		const { cwd, plan, expected } = fixture();
		const runtime = new InvoiceFlowRuntime(expected, {
			paymentInitiallyEmpty: true,
			bankPaymentDisplay: true,
		});
		const driver = new TravelDraftBrowserDriver({ runtime, cwd, waitMilliseconds: 100 });
		await driver.precheck(plan, expected);
		runtime.openState = true;

		const observation = await driver.ensureTransport(expected.transport[0], 0);

		expect(observation.details.map((row) => row.key)).toContain(expected.transport[0].key);
		expect(runtime.calls).toContainEqual({
			method: "click",
			value: { ref: "e30", scopeTexts: ["苏爱健"] },
		});
	});

	it("新 driver 恢复已有折叠行时没有本轮识票 token，重开抽屉后 fail closed", async () => {
		const { cwd, plan, expected } = fixture();
		const runtime = new InvoiceFlowRuntime(expected);
		runtime.openState = true;
		runtime.saved = true;
		runtime.invoiceBound = true;
		runtime.attachmentsUploaded = true;
		const driver = new TravelDraftBrowserDriver({ runtime, cwd, waitMilliseconds: 100 });
		await expect(driver.precheck(plan, expected)).rejects.toMatchObject({
			name: "TravelDraftBrowserBlocker",
			details: { code: "unverified_state", operation: "复核已有费用明细" },
		});
		expect(runtime.calls.filter((call) => call.method === "click").map((call) => call.value)).toEqual(
			expect.arrayContaining([{ ref: "e20", scopeTexts: [FEE_TYPE, "2026-08-21", "¥72.00"] }]),
		);
		const folded = (runtime as unknown as { savedDetail(): string }).savedDetail?.();
		if (folded) {
			expect(folded).not.toContain(expected.transport[0].invoiceNumber);
			expect(folded).not.toContain(basename(expected.transport[0].uploadFile));
			expect(
				folded
					.split(/\r?\n/)
					.some((line) => line.includes("苏爱健（个人账户）") && /(?:已有发票|支付信息|CNY)/.test(line)),
			).toBe(false);
		}
	});

	it("折叠行仅有费用报销人苏爱健时不能替代逐行支付信息", async () => {
		const { cwd, plan, expected } = fixture();
		const runtime = new InvoiceFlowRuntime(expected, { foldedPaymentAccount: false });
		runtime.openState = true;
		runtime.saved = true;
		runtime.invoiceBound = true;
		runtime.attachmentsUploaded = true;
		const driver = new TravelDraftBrowserDriver({ runtime, cwd, waitMilliseconds: 100 });
		await driver.precheck(plan, expected);

		await expect(driver.ensureTransport(expected.transport[0], 0)).rejects.toMatchObject({
			name: "TravelDraftBrowserBlocker",
			details: { code: "existing_row_unverifiable", operation: "检查已有费用明细" },
		});
	});

	it("折叠行仅有支付个人账户苏爱健时不能替代费用报销人字段", async () => {
		const { cwd, plan, expected } = fixture();
		const runtime = new InvoiceFlowRuntime(expected, { foldedExpenseReporter: false });
		runtime.openState = true;
		runtime.saved = true;
		runtime.invoiceBound = true;
		runtime.attachmentsUploaded = true;
		const driver = new TravelDraftBrowserDriver({ runtime, cwd, waitMilliseconds: 100 });
		await driver.precheck(plan, expected);

		await expect(driver.ensureTransport(expected.transport[0], 0)).rejects.toMatchObject({
			name: "TravelDraftBrowserBlocker",
			details: { code: "existing_row_unverifiable", operation: "检查已有费用明细" },
		});
	});

	it("拒绝复用旧失败草稿的区县级城市路径，安全停在 existing_row_unverifiable", async () => {
		const { cwd, plan, expected } = fixture();
		const runtime = new InvoiceFlowRuntime(expected, { foldedDistrictCities: true });
		runtime.openState = true;
		runtime.saved = true;
		runtime.invoiceBound = true;
		runtime.attachmentsUploaded = true;
		const driver = new TravelDraftBrowserDriver({ runtime, cwd, waitMilliseconds: 100 });
		await driver.precheck(plan, expected);

		await expect(driver.ensureTransport(expected.transport[0], 0)).rejects.toMatchObject({
			name: "TravelDraftBrowserBlocker",
			details: { code: "existing_row_unverifiable", operation: "检查已有费用明细" },
		});
		const foldedSnapshot = JSON.stringify(runtime.calls);
		expect(foldedSnapshot).not.toContain("uploadFiles");
	});

	it("任何未完整复核的旧交通、住宿或补助行都会在点击添加前 fail closed", async () => {
		for (const kind of ["transport", "hotel", "allowance"] as const) {
			const complete = kind === "hotel" ? multiDayFixture() : fixture();
			const runtime = new UnknownExistingDetailRuntime(1);
			const driver = new TravelDraftBrowserDriver({ runtime, cwd: complete.cwd, waitMilliseconds: 100 });
			await driver.precheck(complete.plan, complete.expected);

			const action =
				kind === "transport"
					? driver.ensureTransport(complete.expected.transport[0], 0)
					: kind === "hotel"
						? driver.ensureHotel(complete.expected.hotel!)
						: driver.ensureAllowance(complete.expected.allowance);
			await expect(action, kind).rejects.toMatchObject({
				name: "TravelDraftBrowserBlocker",
				details: { code: "existing_row_unverifiable", operation: "添加费用明细" },
			});
			expect(
				runtime.calls.some(
					(call) =>
						call.method === "click" &&
						(call.value as AgentBrowserTarget | undefined)?.selector ===
							'[data-testid="field-expenseDetail-add"]',
				),
				kind,
			).toBe(false);
		}
	});

	it("新增前主表费用明细数无法读取时不点击添加", async () => {
		const { cwd, plan, expected } = fixture();
		const runtime = new UnknownExistingDetailRuntime(undefined);
		const driver = new TravelDraftBrowserDriver({ runtime, cwd, waitMilliseconds: 100 });
		await driver.precheck(plan, expected);

		await expect(driver.ensureTransport(expected.transport[0], 0)).rejects.toMatchObject({
			name: "TravelDraftBrowserBlocker",
			details: { code: "unverified_state", operation: "添加费用明细" },
		});
		expect(
			runtime.calls.some(
				(call) =>
					call.method === "click" &&
					(call.value as AgentBrowserTarget | undefined)?.selector === '[data-testid="field-expenseDetail-add"]',
			),
		).toBe(false);
	});

	it("主表重复显示同一明细数可继续，冲突明细数则在点击添加前阻断", async () => {
		const same = fixture();
		const sameRuntime = new UnknownExistingDetailRuntime([0, 0]);
		const sameDriver = new TravelDraftBrowserDriver({ runtime: sameRuntime, cwd: same.cwd, waitMilliseconds: 100 });
		await sameDriver.precheck(same.plan, same.expected);
		await expect(sameDriver.ensureTransport(same.expected.transport[0], 0)).rejects.toBeInstanceOf(
			TravelDraftBrowserBlocker,
		);
		expect(
			sameRuntime.calls.some(
				(call) =>
					call.method === "click" &&
					(call.value as AgentBrowserTarget | undefined)?.selector === '[data-testid="field-expenseDetail-add"]',
			),
		).toBe(true);

		const conflict = fixture();
		const conflictRuntime = new UnknownExistingDetailRuntime([0, 1]);
		const conflictDriver = new TravelDraftBrowserDriver({
			runtime: conflictRuntime,
			cwd: conflict.cwd,
			waitMilliseconds: 100,
		});
		await conflictDriver.precheck(conflict.plan, conflict.expected);
		await expect(conflictDriver.ensureTransport(conflict.expected.transport[0], 0)).rejects.toMatchObject({
			name: "TravelDraftBrowserBlocker",
			details: { code: "unverified_state", operation: "添加费用明细" },
		});
		expect(
			conflictRuntime.calls.some(
				(call) =>
					call.method === "click" &&
					(call.value as AgentBrowserTarget | undefined)?.selector === '[data-testid="field-expenseDetail-add"]',
			),
		).toBe(false);
	});

	it("普通附件区出现票据文件名不算发票已绑定，仍必须走智能识票", async () => {
		const { cwd, plan, expected } = fixture();
		const runtime = new InvoiceFlowRuntime(expected, { ordinaryAttachmentVisibleInInvoiceArea: true });
		const driver = new TravelDraftBrowserDriver({ runtime, cwd, waitMilliseconds: 100 });
		await driver.precheck(plan, expected);
		runtime.openState = true;

		await driver.ensureTransport(expected.transport[0], 0);

		expect(runtime.calls.some((call) => call.method === "hover")).toBe(true);
		expect(
			runtime.calls.some(
				(call) =>
					call.method === "uploadFiles" && (call.value as { target?: AgentBrowserTarget }).target?.ref === "e1",
			),
		).toBe(true);
	});

	it("折叠行只按带标签 money token 核对报销金额，不被相同发票金额误放行", async () => {
		const { cwd, plan, expected } = fixture();
		const runtime = new InvoiceFlowRuntime(expected, { foldedReimbursementAmount: 172 });
		const driver = new TravelDraftBrowserDriver({ runtime, cwd, waitMilliseconds: 100 });
		await driver.precheck(plan, expected);
		runtime.openState = true;

		await expect(driver.ensureTransport(expected.transport[0], 0)).rejects.toMatchObject({
			name: "TravelDraftBrowserBlocker",
			details: { code: "unverified_state", operation: "保存费用明细" },
		});
	});

	it("智能识票只显示归一城市路线时 blocker，不猜测票据", async () => {
		const { cwd, plan, expected } = fixture();
		const runtime = new InvoiceFlowRuntime(expected, { omitRecognitionIdentity: true });
		const driver = new TravelDraftBrowserDriver({ runtime, cwd, waitMilliseconds: 100 });
		await driver.precheck(plan, expected);
		runtime.openState = true;

		await expect(driver.ensureTransport(expected.transport[0], 0)).rejects.toMatchObject({
			name: "TravelDraftBrowserBlocker",
			details: { code: "invoice_dialog_contract", operation: "选择识别发票" },
		});
		expect(
			runtime.calls.some(
				(call) => call.method === "click" && (call.value as AgentBrowserTarget | undefined)?.ref === "e6",
			),
		).toBe(false);
	});

	it("发票 checkbox 点击无效时未回读 checked=true，绝不点击绑定", async () => {
		const { cwd, plan, expected } = fixture();
		const runtime = new InvoiceFlowRuntime(expected, { invoiceCheckboxClickNoop: true });
		const driver = new TravelDraftBrowserDriver({ runtime, cwd, waitMilliseconds: 100 });
		await driver.precheck(plan, expected);
		runtime.openState = true;

		await expect(driver.ensureTransport(expected.transport[0], 0)).rejects.toMatchObject({
			name: "TravelDraftBrowserBlocker",
			details: { code: "unverified_state", operation: "选择识别发票" },
		});
		expect(
			runtime.calls.some(
				(call) => call.method === "click" && (call.value as AgentBrowserTarget | undefined)?.ref === "e7",
			),
		).toBe(false);
	});

	it("发生重定向后上传前再校验域名，拒绝外泄本地附件", async () => {
		const { cwd, plan, expected } = fixture();
		const runtime = new RedirectBeforeUploadRuntime(expected);
		const driver = new TravelDraftBrowserDriver({ runtime, cwd, waitMilliseconds: 100 });
		await driver.precheck(plan, expected);
		runtime.openState = true;

		await expect(driver.ensureTransport(expected.transport[0], 0)).rejects.toMatchObject({
			name: "TravelDraftBrowserBlocker",
			details: { code: "unsafe_page_state", operation: "智能识票上传" },
		});
		expect(runtime.calls.some((call) => call.method === "uploadFiles")).toBe(false);
	});

	it.each([
		{ field: "attachment" as const, reopenNumber: 2, expectedStage: "VERIFY" },
		{ field: "invoice" as const, reopenNumber: 3, expectedStage: "SAVE_DRAFT" },
		{ field: "payment" as const, reopenNumber: 3, expectedStage: "SAVE_DRAFT" },
	])("折叠摘要不变但隐藏字段 $field 异步漂移时，在 $expectedStage 阶段阻断且不保存", async (testCase) => {
		const complete = twoRailFixture();
		const runtime = new CompleteTwoRailRuntime(complete.expected, {
			hiddenDetailDrift: { field: testCase.field, reopenNumber: testCase.reopenNumber },
		});
		const driver = new TravelDraftBrowserDriver({ runtime, cwd: complete.cwd, waitMilliseconds: 100 });
		const discovery = await driver.discoverApplication({
			url: complete.plan.url,
			hint: complete.expected.application.id,
			invoiceFacts: { travelDates: ["2026-08-21"], cities: ["南京", "常州"] },
		});
		expect(discovery.status).toBe("selected");

		const output = await runTravelDraft(driver, complete.plan);

		expect(output.status).toBe("blocked");
		expect(output.stage).toBe(testCase.expectedStage);
		expect(
			runtime.calls.some(
				(call) =>
					call.method === "click" &&
					(call.value as AgentBrowserTarget | undefined)?.selector === '[data-testid="flexable-button-edit"]',
			),
		).toBe(false);
		expect(
			runtime.calls.some(
				(call) =>
					call.method === "click" &&
					(call.value as AgentBrowserTarget | undefined)?.selector === '[data-testid="feetype-footer-save"]',
			),
		).toBe(true);
	});

	it("智能识票对话框出现多个 file ref 时明确 blocker，绝不上传", async () => {
		const { cwd, plan, expected } = fixture();
		const runtime = new InvoiceFlowRuntime(expected, { multipleInvoiceInputs: true });
		const driver = new TravelDraftBrowserDriver({ runtime, cwd, waitMilliseconds: 100 });
		await driver.precheck(plan, expected);
		runtime.openState = true;

		await expect(driver.ensureTransport(expected.transport[0], 0)).rejects.toMatchObject({
			name: "TravelDraftBrowserBlocker",
			details: { code: "ambiguous_anchor", operation: "智能识票上传" },
		});
		expect(runtime.calls.some((call) => call.method === "uploadFiles")).toBe(false);
	});

	it("只点击 flexable-button-edit，且明确草稿成功文案才确认保存", async () => {
		const { runtime, driver, expected } = await prepareCompleteDriverForSave();

		const saved = await driver.saveDraft(expected);
		const confirmed = await driver.confirmDraftSaved();

		expect(saved.draft).toMatchObject({ saveRequested: true, saved: true, confirmationText: "草稿保存成功" });
		expect(confirmed.draft).toMatchObject({ saved: true, confirmationText: "草稿保存成功" });
		expect(
			runtime.calls.filter(
				(call) =>
					call.method === "click" &&
					(call.value as AgentBrowserTarget | undefined)?.selector === '[data-testid="flexable-button-edit"]',
			),
		).toEqual([
			{
				method: "click",
				value: { selector: '[data-testid="flexable-button-edit"]', scopeTexts: ["差旅费用报销单"] },
			},
		]);
		expect(runtime.calls.filter((call) => call.method === "click").map((call) => call.value)).not.toContainEqual({
			selector: '[data-testid="flexable-button-submit"]',
		});
	});

	it("明细的旧保存成功 toast 消失后仍必须点击主表草稿按钮", async () => {
		const { runtime, driver, expected } = await prepareCompleteDriverForSave();
		runtime.configureDraftSave({ staleBeforeClick: 1 });

		const saved = await driver.saveDraft(expected);

		expect(saved.draft).toMatchObject({ saveRequested: true, saved: true, confirmationText: "草稿保存成功" });
		expect(
			runtime.calls.filter(
				(call) =>
					call.method === "click" &&
					(call.value as AgentBrowserTarget | undefined)?.selector === '[data-testid="flexable-button-edit"]',
			),
		).toHaveLength(1);
	});

	it("确认点击主草稿按钮且基线无旧提示后，接受实际页面常见的“保存成功”", async () => {
		const { runtime, driver, expected } = await prepareCompleteDriverForSave();
		runtime.configureDraftSave({ confirmationText: "保存成功" });
		const saved = await driver.saveDraft(expected);
		const confirmed = await driver.confirmDraftSaved();

		expect(saved.draft).toMatchObject({ saveRequested: true, saved: true, confirmationText: "保存成功" });
		expect(confirmed.draft).toMatchObject({ saveRequested: true, saved: true, confirmationText: "保存成功" });
		expect(
			runtime.calls.filter(
				(call) =>
					call.method === "click" &&
					(call.value as AgentBrowserTarget | undefined)?.selector === '[data-testid="flexable-button-edit"]',
			),
		).toHaveLength(1);
	});

	it("点击主草稿前持续存在旧“保存成功”时拒绝点击，避免误认明细 toast", async () => {
		const { runtime, driver, expected } = await prepareCompleteDriverForSave();
		runtime.configureDraftSave({ staleBeforeClick: 4, confirmationText: "保存成功" });

		await expect(driver.saveDraft(expected)).rejects.toMatchObject({
			name: "TravelDraftBrowserBlocker",
			details: { code: "unverified_state", operation: "保存差旅草稿" },
		});
		expect(
			runtime.calls.some(
				(call) =>
					call.method === "click" &&
					(call.value as AgentBrowserTarget | undefined)?.selector === '[data-testid="flexable-button-edit"]',
			),
		).toBe(false);
	});

	it("草稿成功后发生其他页面动作会立即清空保存证据", async () => {
		const { runtime, driver, plan, expected } = await prepareCompleteDriverForSave();
		await driver.saveDraft(expected);

		await driver.open(plan.url);
		const observation = await driver.observe(expected);

		expect(observation.draft).toEqual({ saveRequested: false, saved: false, confirmationText: undefined });
		expect(runtime.calls.filter((call) => call.method === "navigate")).toHaveLength(2);
		await expect(driver.saveDraft(expected)).rejects.toMatchObject({
			name: "TravelDraftBrowserBlocker",
			details: { operation: "保存差旅草稿" },
		});
		expect(
			runtime.calls.filter(
				(call) =>
					call.method === "click" &&
					(call.value as AgentBrowserTarget | undefined)?.selector === '[data-testid="flexable-button-edit"]',
			),
		).toHaveLength(1);
	});

	it("点击草稿按钮但没有成功文案时拒绝确认", async () => {
		const { runtime, driver, expected } = await prepareCompleteDriverForSave();
		runtime.configureDraftSave({ explicitSuccess: false });

		await driver.saveDraft(expected);
		await expect(driver.confirmDraftSaved()).rejects.toBeInstanceOf(TravelDraftBrowserBlocker);
	});

	it.each([
		{ failure: "interrupt_after_click" as const, firstStatus: "interrupted" },
		{ failure: "snapshot_after_click" as const, firstStatus: "blocked" },
	])("保存点击已送达后发生 $failure，恢复也绝不第二次点击", async ({ failure, firstStatus }) => {
		const complete = fixture();
		const runtime = new CompleteTwoRailRuntime(complete.expected, { draftFailure: failure });
		const driver = new TravelDraftBrowserDriver({ runtime, cwd: complete.cwd, waitMilliseconds: 100 });
		const discovery = await driver.discoverApplication({
			url: complete.plan.url,
			hint: complete.expected.application.id,
			invoiceFacts: { travelDates: ["2026-08-21"], cities: ["南京", "常州"] },
		});
		expect(discovery.status).toBe("selected");

		const first = await runTravelDraft(driver, complete.plan);
		expect(first.status).toBe(firstStatus);
		expect(first.stage).toBe("SAVE_DRAFT");
		expect(first.checkpoint.saveRequested).toBe(true);

		const restartCallIndex = runtime.calls.length;
		const restartedDriver = new TravelDraftBrowserDriver({ runtime, cwd: complete.cwd, waitMilliseconds: 100 });
		const resumed = await runTravelDraft(restartedDriver, complete.plan, { checkpoint: first.checkpoint });
		expect(resumed.status).toBe("done");
		expect(resumed.checkpoint.saveState).toBe("confirmed");
		expect(runtime.calls.slice(restartCallIndex).some((call) => call.method === "click")).toBe(false);
		expect(
			runtime.calls.filter(
				(call) =>
					call.method === "click" &&
					(call.value as AgentBrowserTarget | undefined)?.selector === '[data-testid="flexable-button-edit"]',
			),
		).toHaveLength(1);
	});

	it("保存可能已派发但重启后成功提示消失时保持 unknown，且绝不补点", async () => {
		const complete = fixture();
		const runtime = new CompleteTwoRailRuntime(complete.expected, { draftFailure: "interrupt_after_click" });
		const driver = new TravelDraftBrowserDriver({ runtime, cwd: complete.cwd, waitMilliseconds: 100 });
		const discovery = await driver.discoverApplication({
			url: complete.plan.url,
			hint: complete.expected.application.id,
			invoiceFacts: { travelDates: ["2026-08-21"], cities: ["南京", "常州"] },
		});
		expect(discovery.status).toBe("selected");

		const first = await runTravelDraft(driver, complete.plan);
		expect(first.status).toBe("interrupted");
		expect(first.checkpoint.saveState).toBe("dispatched");
		runtime.configureDraftSave({ explicitSuccess: false });
		const restartCallIndex = runtime.calls.length;

		const restartedDriver = new TravelDraftBrowserDriver({ runtime, cwd: complete.cwd, waitMilliseconds: 100 });
		const resumed = await runTravelDraft(restartedDriver, complete.plan, { checkpoint: first.checkpoint });

		expect(resumed.status).toBe("blocked");
		expect(resumed.stage).toBe("CONFIRM");
		expect(resumed.checkpoint.saveState).toBe("dispatched");
		expect(resumed.errors.join("\n")).toContain("状态仍为 unknown，绝不补点或重试保存");
		expect(runtime.calls.slice(restartCallIndex).some((call) => call.method === "click")).toBe(false);
		expect(
			runtime.calls.filter(
				(call) =>
					call.method === "click" &&
					(call.value as AgentBrowserTarget | undefined)?.selector === '[data-testid="flexable-button-edit"]',
			),
		).toHaveLength(1);
	});
});
