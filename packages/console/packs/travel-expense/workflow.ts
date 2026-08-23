import { createHash } from "node:crypto";

export const TRAVEL_DRAFT_CURRENT_USER = "苏爱健";
export const TRAVEL_DRAFT_STATION = "江苏省南京";
export const TRAVEL_DRAFT_COMPANY = "赛昇信息技术研究院江苏有限公司";
export const TRAVEL_DRAFT_DEPARTMENT = "赛昇信息技术研究院江苏有限公司/政策支撑部/工业信息安全组";
export const TRAVEL_DRAFT_ALLOWANCE_PER_DAY = 180;

export const TRAVEL_DRAFT_STAGES = [
	"PRECHECK",
	"OPEN",
	"APPLICATION",
	"HEADER",
	"TRANSPORT",
	"HOTEL",
	"ALLOWANCE",
	"VERIFY",
	"SAVE_DRAFT",
	"CONFIRM",
	"DONE",
] as const;

export type TravelDraftStage = (typeof TRAVEL_DRAFT_STAGES)[number];
export type TravelExpenseNature = "部门费用" | "项目费用";
export type TravelDraftStatus = "done" | "needs_input" | "interrupted" | "blocked";
export type TravelDraftSaveState = "none" | "prepared" | "dispatched" | "confirmed";

export interface TravelDraftApplication {
	id: string;
	title: string;
	reason: string;
	startDate: string;
	endDate: string;
	expenseNature: TravelExpenseNature;
}

export interface TravelDraftTransportInput {
	fromCity: string;
	toCity: string;
	/** Raw station names preserved from the ticket, used to verify smart-recognition results. */
	fromStation?: string;
	toStation?: string;
	trainNumber?: string;
	travelDate: string;
	seatClass: string;
	amount: number;
	passenger: string;
	invoiceNumber: string;
	uploadFile: string;
	verificationFiles: string[];
}

export interface TravelDraftHotelInput {
	checkinDate: string;
	checkoutDate: string;
	amount: number;
	invoiceNumber: string;
	uploadFile: string;
	verificationFiles: string[];
}

export interface TravelDraftPlan {
	url: string;
	reimbursementDate: string;
	application: TravelDraftApplication;
	transport: TravelDraftTransportInput[];
	hotel?: TravelDraftHotelInput;
}

export interface TravelDraftHeaderExpected {
	explanation: string;
	submitter: typeof TRAVEL_DRAFT_CURRENT_USER;
	station: typeof TRAVEL_DRAFT_STATION;
	company: typeof TRAVEL_DRAFT_COMPANY;
	reimbursementDate: string;
	expenseNature: TravelExpenseNature;
	applicantDepartment: typeof TRAVEL_DRAFT_DEPARTMENT;
	expenseDepartment: typeof TRAVEL_DRAFT_DEPARTMENT;
	paymentRecipient: typeof TRAVEL_DRAFT_CURRENT_USER;
	multipleRecipients: false;
}

export interface TravelDraftTransportExpected extends TravelDraftTransportInput {
	kind: "transport";
	key: string;
	startDate: string;
	endDate: string;
	passenger: typeof TRAVEL_DRAFT_CURRENT_USER;
	paymentRecipient: typeof TRAVEL_DRAFT_CURRENT_USER;
}

export interface TravelDraftHotelExpected extends TravelDraftHotelInput {
	kind: "hotel";
	key: string;
	paymentRecipient: typeof TRAVEL_DRAFT_CURRENT_USER;
}

export interface TravelDraftAllowanceExpected {
	kind: "allowance";
	key: string;
	allowanceType: "其他省份";
	startDate: string;
	endDate: string;
	days: number;
	amount: number;
	paymentRecipient: typeof TRAVEL_DRAFT_CURRENT_USER;
}

export interface TravelDraftExpected {
	application: TravelDraftApplication;
	header: TravelDraftHeaderExpected;
	transport: TravelDraftTransportExpected[];
	hotel?: TravelDraftHotelExpected;
	allowance: TravelDraftAllowanceExpected;
	totalAmount: number;
}

export interface TravelDraftApplicationObservation {
	id?: string;
	title?: string;
	reason?: string;
	startDate?: string;
	endDate?: string;
	expenseNature?: TravelExpenseNature;
}

export interface TravelDraftHeaderObservation {
	explanation?: string;
	submitter?: string;
	station?: string;
	company?: string;
	reimbursementDate?: string;
	expenseNature?: TravelExpenseNature;
	applicantDepartment?: string;
	expenseDepartment?: string;
	paymentRecipient?: string;
	multipleRecipients?: boolean;
}

export interface TravelDraftDetailObservation {
	kind: "transport" | "hotel" | "allowance";
	key: string;
	startDate?: string;
	endDate?: string;
	travelDate?: string;
	fromCity?: string;
	toCity?: string;
	seatClass?: string;
	amount?: number;
	passenger?: string;
	invoiceNumber?: string;
	uploadFile?: string;
	verificationFiles?: string[];
	checkinDate?: string;
	checkoutDate?: string;
	allowanceType?: string;
	days?: number;
	paymentRecipient?: string;
}

export interface TravelDraftObservation {
	page: "closed" | "loading" | "form";
	application?: TravelDraftApplicationObservation;
	header?: TravelDraftHeaderObservation;
	details: TravelDraftDetailObservation[];
	/** Independent count read from the expense-detail summary on the main form. */
	detailCount?: number;
	calculatedTotal?: number;
	verification?: { valid: boolean; errors: string[] };
	draft?: { saveRequested: boolean; saved: boolean; confirmationText?: string };
	/** Driver-owned stable digest. If omitted, the state machine hashes the normalized observation. */
	fingerprint?: string;
}

export interface TravelDraftIssue {
	code: string;
	field: string;
	message: string;
}

export interface TravelDraftPrecheckResult {
	observation: TravelDraftObservation;
	missing?: TravelDraftIssue[];
	ambiguous?: TravelDraftIssue[];
}

export interface TravelDraftConfirmationOptions {
	/**
	 * A durable checkpoint says the save command may already have been dispatched.
	 * The driver may only read explicit success evidence; it must never click save.
	 */
	readOnlyRecovery?: boolean;
}

/**
 * Adapter boundary for the Electron browser. Every mutating method is an idempotent
 * "ensure" operation. Deliberately, there is no send-for-approval or bill-removal method.
 */
export interface TravelDraftDriver {
	precheck(plan: TravelDraftPlan, expected: TravelDraftExpected): Promise<TravelDraftPrecheckResult>;
	observe(expected: TravelDraftExpected): Promise<TravelDraftObservation>;
	open(url: string): Promise<TravelDraftObservation>;
	ensureApplication(application: TravelDraftApplication): Promise<TravelDraftObservation>;
	ensureHeader(header: TravelDraftHeaderExpected): Promise<TravelDraftObservation>;
	ensureTransport(row: TravelDraftTransportExpected, index: number): Promise<TravelDraftObservation>;
	ensureHotel(row: TravelDraftHotelExpected): Promise<TravelDraftObservation>;
	ensureAllowance(row: TravelDraftAllowanceExpected): Promise<TravelDraftObservation>;
	verify(expected: TravelDraftExpected): Promise<TravelDraftObservation>;
	saveDraft(
		expected: TravelDraftExpected,
		onDispatch: () => void | Promise<void>,
	): Promise<TravelDraftObservation>;
	confirmDraftSaved(options?: TravelDraftConfirmationOptions): Promise<TravelDraftObservation>;
}

export interface TravelDraftCheckpoint {
	version: 1;
	planFingerprint: string;
	stage: TravelDraftStage;
	transportIndex: number;
	actionsUsed: number;
	attempts: Record<string, number>;
	noProgress: Record<string, number>;
	/**
	 * Durable save lifecycle. Optional so version-1 checkpoints written before
	 * this field existed remain readable; legacy saveRequested=true maps to
	 * "dispatched" and is never replayed.
	 */
	saveState?: TravelDraftSaveState;
	/** Legacy compatibility mirror: true exactly after dispatch (or confirmation). */
	saveRequested: boolean;
	errors: string[];
}

export interface RunTravelDraftOptions {
	checkpoint?: TravelDraftCheckpoint;
	maxActions?: number;
	maxStageRetries?: number;
	maxNoProgress?: number;
	signal?: AbortSignal;
	onCheckpoint?: (checkpoint: TravelDraftCheckpoint) => void | Promise<void>;
}

export interface TravelDraftRunResult {
	status: TravelDraftStatus;
	stage: TravelDraftStage;
	expectedTotal: number;
	actionsUsed: number;
	checkpoint: TravelDraftCheckpoint;
	missing: TravelDraftIssue[];
	ambiguous: TravelDraftIssue[];
	errors: string[];
	observation?: TravelDraftObservation;
}

export class TravelDraftInterruptedError extends Error {
	constructor(message = "差旅草稿流程已中断") {
		super(message);
		this.name = "TravelDraftInterruptedError";
	}
}

class TravelDraftBudgetError extends Error {
	constructor(limit: number) {
		super(`差旅草稿流程超过全局动作预算（${limit}）`);
		this.name = "TravelDraftBudgetError";
	}
}

const EXPLICIT_DRAFT_CONFIRMATION = /(?:保存成功|草稿保存成功|已存为草稿|已保存为草稿)/;
const TRAVEL_DRAFT_SAVE_STATES = new Set<TravelDraftSaveState>(["none", "prepared", "dispatched", "confirmed"]);

function cloneCheckpoint(checkpoint: TravelDraftCheckpoint): TravelDraftCheckpoint {
	return {
		...checkpoint,
		attempts: { ...checkpoint.attempts },
		noProgress: { ...checkpoint.noProgress },
		errors: [...checkpoint.errors],
	};
}

function normalizedCheckpointSaveState(checkpoint: TravelDraftCheckpoint): TravelDraftSaveState {
	const candidate = checkpoint.saveState;
	if (checkpoint.saveRequested) {
		// saveRequested was the only durable save marker in older version-1
		// checkpoints. It always means the click may already have been dispatched.
		if (candidate === "confirmed") return "confirmed";
		return "dispatched";
	}
	return candidate && TRAVEL_DRAFT_SAVE_STATES.has(candidate) ? candidate : "none";
}

function saveStateHasDispatched(state: TravelDraftSaveState): boolean {
	return state === "dispatched" || state === "confirmed";
}

function cents(value: number | undefined): number {
	return Number.isFinite(value) ? Math.round((value ?? 0) * 100) : Number.NaN;
}

function sameAmount(actual: number | undefined, expected: number): boolean {
	return cents(actual) === cents(expected);
}

function normalizedPath(value: string): string {
	return value.trim().replaceAll("\\", "/").toLocaleLowerCase("en-US");
}

function sameFiles(actual: string[] | undefined, expected: string[]): boolean {
	if (!actual || actual.length !== expected.length) return false;
	const left = actual.map(normalizedPath).sort();
	const right = expected.map(normalizedPath).sort();
	return left.every((value, index) => value === right[index]);
}

function isIsoDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const parsed = new Date(`${value}T00:00:00.000Z`);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function travelDays(startDate: string, endDate: string): number {
	const start = Date.parse(`${startDate}T00:00:00.000Z`);
	const end = Date.parse(`${endDate}T00:00:00.000Z`);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
	return Math.floor((end - start) / 86_400_000) + 1;
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([key]) => key !== "fingerprint")
			.sort(([left], [right]) => left.localeCompare(right, "en"))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export function travelDraftObservationFingerprint(observation: TravelDraftObservation): string {
	if (observation.fingerprint?.trim()) return observation.fingerprint.trim();
	return createHash("sha256").update(stableJson(observation)).digest("hex");
}

export function travelDraftPlanFingerprint(plan: TravelDraftPlan): string {
	const fingerprintInput = {
		version: 2,
		reimbursementDate: plan.reimbursementDate,
		application: plan.application,
		transport: plan.transport.map(({ uploadFile: _uploadFile, verificationFiles: _verificationFiles, ...row }) => row),
		hotel: plan.hotel
			? (({ uploadFile: _uploadFile, verificationFiles: _verificationFiles, ...hotel }) => hotel)(plan.hotel)
			: undefined,
	};
	return createHash("sha256").update(stableJson(fingerprintInput)).digest("hex");
}

/**
 * Stable, non-sensitive identity used only for the durable save-intent guard.
 * Deliberately excludes URL/token, attachment paths/names, free-text reason/title,
 * passenger, and reimbursement date.
 */
export function travelDraftSaveIdentity(plan: TravelDraftPlan): string {
	const text = (value: string | undefined) => value?.trim().normalize("NFKC") ?? "";
	const transports = plan.transport
		.map((row) => ({
			invoiceNumber: text(row.invoiceNumber),
			date: text(row.travelDate),
			trainNumber: text(row.trainNumber),
			fromCity: text(row.fromCity),
			fromStation: text(row.fromStation),
			toCity: text(row.toCity),
			toStation: text(row.toStation),
			amountCents: cents(row.amount),
		}))
		.sort((left, right) => stableJson(left).localeCompare(stableJson(right), "en"));
	const hotel = plan.hotel
		? {
				invoiceNumber: text(plan.hotel.invoiceNumber),
				checkinDate: text(plan.hotel.checkinDate),
				checkoutDate: text(plan.hotel.checkoutDate),
				amountCents: cents(plan.hotel.amount),
			}
		: undefined;
	const identity = {
		version: 1,
		application: {
			id: text(plan.application.id),
			startDate: text(plan.application.startDate),
			endDate: text(plan.application.endDate),
		},
		transports,
		hotel,
	};
	return createHash("sha256").update(stableJson(identity)).digest("hex");
}

export function buildTravelDraftExpected(plan: TravelDraftPlan): TravelDraftExpected {
	const days = travelDays(plan.application.startDate, plan.application.endDate);
	const transport = plan.transport.map(
		(row): TravelDraftTransportExpected => ({
			...row,
			kind: "transport",
			key: `transport:${row.invoiceNumber}`,
			startDate: plan.application.startDate,
			endDate: plan.application.endDate,
			passenger: TRAVEL_DRAFT_CURRENT_USER,
			paymentRecipient: TRAVEL_DRAFT_CURRENT_USER,
		}),
	);
	const hotel: TravelDraftHotelExpected | undefined = plan.hotel
		? {
				...plan.hotel,
				kind: "hotel" as const,
				key: `hotel:${plan.hotel.invoiceNumber}`,
				paymentRecipient: TRAVEL_DRAFT_CURRENT_USER,
			}
		: undefined;
	const allowance: TravelDraftAllowanceExpected = {
		kind: "allowance",
		key: `allowance:${plan.application.startDate}:${plan.application.endDate}`,
		allowanceType: "其他省份",
		startDate: plan.application.startDate,
		endDate: plan.application.endDate,
		days,
		amount: days * TRAVEL_DRAFT_ALLOWANCE_PER_DAY,
		paymentRecipient: TRAVEL_DRAFT_CURRENT_USER,
	};
	return {
		application: { ...plan.application },
			header: {
			explanation: plan.application.reason,
			submitter: TRAVEL_DRAFT_CURRENT_USER,
			station: TRAVEL_DRAFT_STATION,
			company: TRAVEL_DRAFT_COMPANY,
			reimbursementDate: plan.reimbursementDate,
			expenseNature: plan.application.expenseNature,
			applicantDepartment: TRAVEL_DRAFT_DEPARTMENT,
			expenseDepartment: TRAVEL_DRAFT_DEPARTMENT,
			paymentRecipient: TRAVEL_DRAFT_CURRENT_USER,
			multipleRecipients: false,
		},
		transport,
		hotel,
		allowance,
		totalAmount:
			transport.reduce((sum, row) => sum + row.amount, 0) + (hotel?.amount ?? 0) + allowance.amount,
	};
}

function issue(code: string, field: string, message: string): TravelDraftIssue {
	return { code, field, message };
}

export function validateTravelDraftPlan(plan: TravelDraftPlan): {
	missing: TravelDraftIssue[];
	ambiguous: TravelDraftIssue[];
} {
	const missing: TravelDraftIssue[] = [];
	const ambiguous: TravelDraftIssue[] = [];
	const requireText = (value: string | undefined, field: string, label: string) => {
		if (!value?.trim()) missing.push(issue("missing_value", field, `缺少${label}`));
	};
	requireText(plan.url, "url", "报销链接");
	requireText(plan.application.id, "application.id", "关联申请编号");
	requireText(plan.application.title, "application.title", "关联申请标题");
	requireText(plan.application.reason, "application.reason", "关联申请事由");
	for (const [field, value] of [
		["application.startDate", plan.application.startDate],
		["application.endDate", plan.application.endDate],
		["reimbursementDate", plan.reimbursementDate],
	] as const) {
		if (!value) missing.push(issue("missing_date", field, `缺少${field}`));
		else if (!isIsoDate(value)) ambiguous.push(issue("invalid_date", field, `${field} 不是有效的 YYYY-MM-DD 日期`));
	}
	if (!(["部门费用", "项目费用"] as string[]).includes(plan.application.expenseNature)) {
		ambiguous.push(issue("invalid_expense_nature", "application.expenseNature", "费用性质必须来自关联申请"));
	}
	const days = travelDays(plan.application.startDate, plan.application.endDate);
	if (days === 0 && isIsoDate(plan.application.startDate) && isIsoDate(plan.application.endDate)) {
		ambiguous.push(issue("invalid_date_range", "application", "关联申请结束日期早于开始日期"));
	}
	if (!Array.isArray(plan.transport) || plan.transport.length === 0) {
		missing.push(issue("missing_transport", "transport", "至少需要一程火车或高铁票"));
	}
	const invoiceOwners = new Map<string, string>();
	const attachmentOwners = new Map<string, string>();
	const passengers = new Set<string>();
	const claimUnique = (value: string, field: string, owners: Map<string, string>, code: string) => {
		if (!value.trim()) return;
		const normalized = normalizedPath(value);
		const previous = owners.get(normalized);
		if (previous) ambiguous.push(issue(code, field, `${field} 与 ${previous} 重复绑定`));
		else owners.set(normalized, field);
	};
	for (const [index, row] of plan.transport.entries()) {
		const prefix = `transport[${index}]`;
		for (const [field, value, label] of [
			["fromCity", row.fromCity, "出发城市"],
			["toCity", row.toCity, "到达城市"],
			["seatClass", row.seatClass, "火车席别"],
			["passenger", row.passenger, "乘车人"],
			["invoiceNumber", row.invoiceNumber, "发票号"],
			["uploadFile", row.uploadFile, "电子客票附件"],
		] as const) {
			requireText(value, `${prefix}.${field}`, `第 ${index + 1} 程${label}`);
		}
		if (!isIsoDate(row.travelDate)) ambiguous.push(issue("invalid_date", `${prefix}.travelDate`, "乘车日期无效"));
		else if (row.travelDate < plan.application.startDate || row.travelDate > plan.application.endDate) {
			ambiguous.push(issue("date_outside_application", `${prefix}.travelDate`, "乘车日期不在关联申请范围内"));
		}
		if (!Number.isFinite(row.amount) || row.amount <= 0) {
			ambiguous.push(issue("invalid_amount", `${prefix}.amount`, "车票金额必须大于 0"));
		}
		if (row.passenger?.trim()) passengers.add(row.passenger.trim());
		if (!Array.isArray(row.verificationFiles) || row.verificationFiles.length === 0) {
			missing.push(issue("missing_verification", `${prefix}.verificationFiles`, `第 ${index + 1} 程缺少查验附件`));
		}
		claimUnique(row.invoiceNumber, `${prefix}.invoiceNumber`, invoiceOwners, "duplicate_invoice");
		claimUnique(row.uploadFile, `${prefix}.uploadFile`, attachmentOwners, "duplicate_attachment");
		for (const [attachmentIndex, file] of (row.verificationFiles ?? []).entries()) {
			requireText(file, `${prefix}.verificationFiles[${attachmentIndex}]`, `第 ${index + 1} 程查验附件路径`);
			claimUnique(
				file,
				`${prefix}.verificationFiles[${attachmentIndex}]`,
				attachmentOwners,
				"duplicate_attachment",
			);
		}
	}
	if (passengers.size > 1) {
		ambiguous.push(issue("multiple_passengers", "transport.passenger", `检测到多个乘车人：${[...passengers].join("、")}`));
	}
	for (const passenger of passengers) {
		if (passenger !== TRAVEL_DRAFT_CURRENT_USER) {
			ambiguous.push(
				issue("passenger_mismatch", "transport.passenger", `乘车人必须是${TRAVEL_DRAFT_CURRENT_USER}，当前为${passenger}`),
			);
		}
	}
	if (days > 1 && !plan.hotel) missing.push(issue("missing_hotel", "hotel", "多日出差缺少住宿发票"));
	if (days === 1 && plan.hotel) {
		ambiguous.push(issue("unexpected_hotel", "hotel", "当天往返不应生成住宿明细"));
	}
	if (plan.hotel) {
		const hotel = plan.hotel;
		for (const [field, value, label] of [
			["invoiceNumber", hotel.invoiceNumber, "住宿发票号"],
			["uploadFile", hotel.uploadFile, "住宿发票附件"],
		] as const) {
			requireText(value, `hotel.${field}`, label);
		}
		const hotelDatesValid =
			isIsoDate(hotel.checkinDate) &&
			isIsoDate(hotel.checkoutDate) &&
			hotel.checkoutDate >= hotel.checkinDate;
		if (!hotelDatesValid) {
			ambiguous.push(issue("invalid_hotel_dates", "hotel", "住宿起止日期无效"));
		} else if (
			hotel.checkinDate < plan.application.startDate ||
			hotel.checkoutDate > plan.application.endDate
		) {
			ambiguous.push(
				issue(
					"hotel_dates_outside_application",
					"hotel",
					"住宿起止日期必须完整包含在关联申请的出差起止日期内",
				),
			);
		}
		if (!Number.isFinite(hotel.amount) || hotel.amount <= 0) {
			ambiguous.push(issue("invalid_amount", "hotel.amount", "住宿金额必须大于 0"));
		}
		if (!Array.isArray(hotel.verificationFiles)) {
			missing.push(issue("missing_verification_field", "hotel.verificationFiles", "住宿查验附件字段缺失"));
		}
		claimUnique(hotel.invoiceNumber, "hotel.invoiceNumber", invoiceOwners, "duplicate_invoice");
		claimUnique(hotel.uploadFile, "hotel.uploadFile", attachmentOwners, "duplicate_attachment");
		for (const [index, file] of (hotel.verificationFiles ?? []).entries()) {
			requireText(file, `hotel.verificationFiles[${index}]`, "住宿查验附件路径");
			claimUnique(file, `hotel.verificationFiles[${index}]`, attachmentOwners, "duplicate_attachment");
		}
	}
	return { missing, ambiguous };
}

function applicationMatches(
	actual: TravelDraftApplicationObservation | undefined,
	expected: TravelDraftApplication,
): boolean {
	return Boolean(
		actual &&
			actual.id === expected.id &&
			actual.title === expected.title &&
			actual.reason === expected.reason &&
			actual.startDate === expected.startDate &&
			actual.endDate === expected.endDate &&
			actual.expenseNature === expected.expenseNature,
	);
}

function headerMatches(
	actual: TravelDraftHeaderObservation | undefined,
	expected: TravelDraftHeaderExpected,
	allowCollapsedPaymentSummary = false,
): boolean {
	return Boolean(
		actual &&
			actual.explanation === expected.explanation &&
			actual.submitter === expected.submitter &&
			actual.station === expected.station &&
			actual.company === expected.company &&
			actual.reimbursementDate === expected.reimbursementDate &&
			actual.expenseNature === expected.expenseNature &&
			actual.applicantDepartment === expected.applicantDepartment &&
			actual.expenseDepartment === expected.expenseDepartment &&
			(actual.paymentRecipient === expected.paymentRecipient ||
				(allowCollapsedPaymentSummary && actual.paymentRecipient === undefined)) &&
			actual.multipleRecipients === false,
	);
}

function transportMatches(actual: TravelDraftDetailObservation | undefined, expected: TravelDraftTransportExpected): boolean {
	return Boolean(
		actual &&
			actual.kind === "transport" &&
			actual.key === expected.key &&
			actual.startDate === expected.startDate &&
			actual.endDate === expected.endDate &&
			actual.travelDate === expected.travelDate &&
			actual.fromCity === expected.fromCity &&
			actual.toCity === expected.toCity &&
			actual.seatClass === expected.seatClass &&
			sameAmount(actual.amount, expected.amount) &&
			actual.passenger === expected.passenger &&
			actual.invoiceNumber === expected.invoiceNumber &&
			normalizedPath(actual.uploadFile ?? "") === normalizedPath(expected.uploadFile) &&
			sameFiles(actual.verificationFiles, expected.verificationFiles) &&
			actual.paymentRecipient === expected.paymentRecipient,
	);
}

function hotelMatches(actual: TravelDraftDetailObservation | undefined, expected: TravelDraftHotelExpected): boolean {
	return Boolean(
		actual &&
			actual.kind === "hotel" &&
			actual.key === expected.key &&
			actual.checkinDate === expected.checkinDate &&
			actual.checkoutDate === expected.checkoutDate &&
			sameAmount(actual.amount, expected.amount) &&
			actual.invoiceNumber === expected.invoiceNumber &&
			normalizedPath(actual.uploadFile ?? "") === normalizedPath(expected.uploadFile) &&
			sameFiles(actual.verificationFiles, expected.verificationFiles) &&
			actual.paymentRecipient === expected.paymentRecipient,
	);
}

function allowanceMatches(
	actual: TravelDraftDetailObservation | undefined,
	expected: TravelDraftAllowanceExpected,
): boolean {
	return Boolean(
		actual &&
			actual.kind === "allowance" &&
			actual.key === expected.key &&
			actual.allowanceType === expected.allowanceType &&
			actual.startDate === expected.startDate &&
			actual.endDate === expected.endDate &&
			actual.days === expected.days &&
			sameAmount(actual.amount, expected.amount) &&
			actual.paymentRecipient === expected.paymentRecipient,
	);
}

function detailByKey(observation: TravelDraftObservation, key: string): TravelDraftDetailObservation | undefined {
	return observation.details.find((row) => row.key === key);
}

function explicitDraftSaved(observation: TravelDraftObservation): boolean {
	return Boolean(
		observation.draft?.saveRequested === true &&
			observation.draft.saved &&
			observation.draft.confirmationText &&
			EXPLICIT_DRAFT_CONFIRMATION.test(observation.draft.confirmationText),
	);
}

function completeDraftMatches(observation: TravelDraftObservation, expected: TravelDraftExpected): boolean {
	const expectedDetailCount = expected.transport.length + (expected.hotel ? 1 : 0) + 1;
	return (
		observation.page === "form" &&
		observation.detailCount === expectedDetailCount &&
		applicationMatches(observation.application, expected.application) &&
		headerMatches(observation.header, expected.header, observation.details.length > 0) &&
		expected.transport.every((row) => transportMatches(detailByKey(observation, row.key), row)) &&
		(!expected.hotel || hotelMatches(detailByKey(observation, expected.hotel.key), expected.hotel)) &&
		allowanceMatches(detailByKey(observation, expected.allowance.key), expected.allowance) &&
		sameAmount(observation.calculatedTotal, expected.totalAmount)
	);
}

function result(
	status: TravelDraftStatus,
	checkpoint: TravelDraftCheckpoint,
	expected: TravelDraftExpected,
	observation: TravelDraftObservation | undefined,
	missing: TravelDraftIssue[] = [],
	ambiguous: TravelDraftIssue[] = [],
): TravelDraftRunResult {
	const snapshot = cloneCheckpoint(checkpoint);
	return {
		status,
		stage: snapshot.stage,
		expectedTotal: expected.totalAmount,
		actionsUsed: snapshot.actionsUsed,
		checkpoint: snapshot,
		missing,
		ambiguous,
		errors: [...snapshot.errors],
		observation,
	};
}

function isInterruption(error: unknown, signal: AbortSignal | undefined): boolean {
	return (
		error instanceof TravelDraftInterruptedError ||
		signal?.aborted === true ||
		(error instanceof Error && (error.name === "AbortError" || /interrupted|aborted|中断/i.test(error.message)))
	);
}

export async function runTravelDraft(
	driver: TravelDraftDriver,
	plan: TravelDraftPlan,
	options: RunTravelDraftOptions = {},
): Promise<TravelDraftRunResult> {
	const expected = buildTravelDraftExpected(plan);
	const fingerprint = travelDraftPlanFingerprint(plan);
	const maxActions = Math.max(1, options.maxActions ?? 60);
	const maxAttempts = Math.max(1, (options.maxStageRetries ?? 2) + 1);
	const maxNoProgress = Math.max(1, options.maxNoProgress ?? 2);
	let checkpoint: TravelDraftCheckpoint = options.checkpoint
		? cloneCheckpoint(options.checkpoint)
		: {
				version: 1,
				planFingerprint: fingerprint,
				stage: "PRECHECK",
				transportIndex: 0,
				actionsUsed: 0,
				attempts: {},
				noProgress: {},
				saveState: "none",
				saveRequested: false,
				errors: [],
			};
	let observation: TravelDraftObservation | undefined;
	const setSaveState = (state: TravelDraftSaveState) => {
		checkpoint.saveState = state;
		checkpoint.saveRequested = saveStateHasDispatched(state);
	};
	const initialSaveState = normalizedCheckpointSaveState(checkpoint);
	setSaveState(initialSaveState);
	const readOnlyDispatchRecovery = options.checkpoint !== undefined && initialSaveState === "dispatched";
	const saveHasDispatched = () => saveStateHasDispatched(checkpoint.saveState ?? "none");
	const persist = async () => {
		await options.onCheckpoint?.(cloneCheckpoint(checkpoint));
	};
	const interruptResult = async (message?: string) => {
		if (message) checkpoint.errors.push(message);
		await persist();
		return result("interrupted", checkpoint, expected, observation);
	};
	const call = async <T>(operation: () => Promise<T>): Promise<T> => {
		if (options.signal?.aborted) throw new TravelDraftInterruptedError();
		if (checkpoint.actionsUsed >= maxActions) throw new TravelDraftBudgetError(maxActions);
		checkpoint.actionsUsed += 1;
		await persist();
		return operation();
	};
	if (checkpoint.version !== 1 || checkpoint.planFingerprint !== fingerprint) {
		checkpoint.errors.push("恢复点与当前差旅行程不匹配，拒绝在旧草稿状态上继续");
		return result("blocked", checkpoint, expected, observation);
	}
	const localIssues = validateTravelDraftPlan(plan);
	if (localIssues.missing.length > 0 || localIssues.ambiguous.length > 0) {
		return result("needs_input", checkpoint, expected, observation, localIssues.missing, localIssues.ambiguous);
	}
	if (readOnlyDispatchRecovery && !["SAVE_DRAFT", "CONFIRM"].includes(checkpoint.stage)) {
		checkpoint.errors.push(
			`持久化派发恢复点异常停在 ${checkpoint.stage}；只允许只读确认，绝不回到核验或保存阶段`,
		);
		return result("blocked", checkpoint, expected, observation);
	}

	try {
		if (checkpoint.stage === "PRECHECK") {
			const precheck = await call(() => driver.precheck(plan, expected));
			observation = precheck.observation;
			const missing = [...(precheck.missing ?? [])];
			const ambiguous = [...(precheck.ambiguous ?? [])];
			if (missing.length > 0 || ambiguous.length > 0) {
				return result("needs_input", checkpoint, expected, observation, missing, ambiguous);
			}
			checkpoint.stage = "OPEN";
			await persist();
		} else if (readOnlyDispatchRecovery) {
			// A dispatched checkpoint is an at-most-once barrier, not proof that the
			// click reached the page. Do not reopen detail drawers or run verification;
			// the only permitted browser operation is explicit, read-only confirmation.
			observation = {
				page: "loading",
				details: [],
				draft: { saveRequested: true, saved: false },
			};
		} else {
			observation = await call(() => driver.observe(expected));
		}
	} catch (error) {
		if (isInterruption(error, options.signal)) {
			return interruptResult(error instanceof Error ? error.message : String(error));
		}
		checkpoint.errors.push(error instanceof Error ? error.message : String(error));
		return result("blocked", checkpoint, expected, observation);
	}

	const firstMissingTransport = () =>
		expected.transport.findIndex((row) => !transportMatches(detailByKey(observation!, row.key), row));
	const markSaveDispatched = async () => {
		if (saveHasDispatched()) {
			throw new Error("SAVE_DRAFT：同一个保存派发许可只能消费一次，已阻止驱动器重复发送");
		}
		if (checkpoint.saveState !== "prepared") {
			throw new Error(`SAVE_DRAFT：保存派发边界要求 prepared 状态，当前为 ${checkpoint.saveState ?? "none"}`);
		}
		setSaveState("dispatched");
		try {
			// The driver awaits this hook immediately before issuing the irreversible
			// browser click. If persistence fails, the hook rejects and no click is sent.
			await persist();
		} catch (error) {
			setSaveState("prepared");
			throw new Error(`SAVE_DRAFT：保存派发状态无法持久化，未点击草稿按钮：${error instanceof Error ? error.message : String(error)}`);
		}
	};
	const rewindForPrerequisites = async () => {
		if (!observation) return;
		if (saveHasDispatched()) return;
		let stage: TravelDraftStage | undefined;
		let transportIndex = checkpoint.transportIndex;
		if (checkpoint.stage !== "OPEN" && observation.page !== "form") stage = "OPEN";
		else if (
			!["OPEN", "APPLICATION"].includes(checkpoint.stage) &&
			!applicationMatches(observation.application, expected.application)
		) {
			stage = "APPLICATION";
		} else if (
			!["OPEN", "APPLICATION", "HEADER"].includes(checkpoint.stage) &&
			!headerMatches(observation.header, expected.header, observation.details.length > 0)
		) {
			stage = "HEADER";
		} else if (!["OPEN", "APPLICATION", "HEADER"].includes(checkpoint.stage)) {
			const missingTransport = firstMissingTransport();
			if (missingTransport >= 0 && (checkpoint.stage !== "TRANSPORT" || missingTransport < checkpoint.transportIndex)) {
				stage = "TRANSPORT";
				transportIndex = missingTransport;
			} else if (
				!["TRANSPORT", "HOTEL"].includes(checkpoint.stage) &&
				expected.hotel &&
				!hotelMatches(detailByKey(observation, expected.hotel.key), expected.hotel)
			) {
				stage = "HOTEL";
			} else if (
				!["TRANSPORT", "HOTEL", "ALLOWANCE"].includes(checkpoint.stage) &&
				!allowanceMatches(detailByKey(observation, expected.allowance.key), expected.allowance)
			) {
				stage = "ALLOWANCE";
			} else if (checkpoint.stage === "SAVE_DRAFT" && observation.verification?.valid !== true) {
				// A prepared checkpoint is reversible. After a restart/re-observation,
				// repeat the fresh verification before allowing the dispatch hook.
				stage = "VERIFY";
			} else if (checkpoint.stage === "DONE" && observation.verification?.valid !== true) {
				stage = "VERIFY";
			} else if (checkpoint.stage === "DONE" && !explicitDraftSaved(observation)) {
				stage = "SAVE_DRAFT";
			} else if (
				checkpoint.stage === "CONFIRM" &&
				(!checkpoint.saveRequested || observation.draft?.saveRequested !== true)
			) {
				stage = "SAVE_DRAFT";
			}
		}
		if (stage && (stage !== checkpoint.stage || transportIndex !== checkpoint.transportIndex)) {
			checkpoint.stage = stage;
			checkpoint.transportIndex = transportIndex;
			setSaveState("none");
			await persist();
		}
	};

	while (true) {
		if (options.signal?.aborted) return interruptResult();
		if (saveHasDispatched()) {
			if (
				!readOnlyDispatchRecovery &&
				(!completeDraftMatches(observation!, expected) || observation?.verification?.valid !== true)
			) {
				checkpoint.errors.push("草稿保存请求后页面完整性或保存前核验不再成立；为避免保存后重放修改已安全停止");
				await persist();
				return result("blocked", checkpoint, expected, observation);
			}
			if (!["SAVE_DRAFT", "CONFIRM", "DONE"].includes(checkpoint.stage)) {
				checkpoint.errors.push(`草稿保存请求后的恢复点异常停在 ${checkpoint.stage}，已拒绝回到业务填写阶段`);
				await persist();
				return result("blocked", checkpoint, expected, observation);
			}
			if (!readOnlyDispatchRecovery && checkpoint.stage === "DONE" && !explicitDraftSaved(observation!)) {
				checkpoint.errors.push("恢复点表明草稿保存已请求，但页面没有可归因的保存成功证据；不会再次点击保存");
				await persist();
				return result("blocked", checkpoint, expected, observation);
			}
		}
		await rewindForPrerequisites();
		if (checkpoint.stage === "DONE") break;
		let attemptKey: string = checkpoint.stage;
		let satisfied = false;
		let operation: (() => Promise<TravelDraftObservation>) | undefined;
		switch (checkpoint.stage) {
			case "OPEN":
				satisfied = observation?.page === "form";
				operation = () => driver.open(plan.url);
				break;
			case "APPLICATION":
				satisfied = applicationMatches(observation?.application, expected.application);
				operation = () => driver.ensureApplication(expected.application);
				break;
			case "HEADER":
				satisfied = headerMatches(
					observation?.header,
					expected.header,
					(observation?.details.length ?? 0) > 0,
				);
				operation = () => driver.ensureHeader(expected.header);
				break;
			case "TRANSPORT": {
				if (checkpoint.transportIndex >= expected.transport.length) {
					checkpoint.stage = "HOTEL";
					await persist();
					continue;
				}
				const index = checkpoint.transportIndex;
				const row = expected.transport[index];
				attemptKey = `TRANSPORT:${index}`;
				satisfied = transportMatches(detailByKey(observation!, row.key), row);
				operation = () => driver.ensureTransport(row, index);
				break;
			}
			case "HOTEL":
				if (!expected.hotel) {
					checkpoint.stage = "ALLOWANCE";
					await persist();
					continue;
				}
				satisfied = hotelMatches(detailByKey(observation!, expected.hotel.key), expected.hotel);
				operation = () => driver.ensureHotel(expected.hotel!);
				break;
			case "ALLOWANCE":
				satisfied = allowanceMatches(detailByKey(observation!, expected.allowance.key), expected.allowance);
				operation = () => driver.ensureAllowance(expected.allowance);
				break;
			case "VERIFY":
				satisfied = completeDraftMatches(observation!, expected) && observation?.verification?.valid === true;
				operation = () => driver.verify(expected);
				break;
			case "SAVE_DRAFT":
				satisfied = saveHasDispatched();
				operation = () => driver.saveDraft(expected, markSaveDispatched);
				break;
			case "CONFIRM":
				satisfied = saveHasDispatched() && explicitDraftSaved(observation!);
				operation = () =>
					driver.confirmDraftSaved(readOnlyDispatchRecovery ? { readOnlyRecovery: true } : undefined);
				break;
		}

		if (satisfied) {
			switch (checkpoint.stage) {
				case "OPEN":
					checkpoint.stage = "APPLICATION";
					break;
				case "APPLICATION":
					checkpoint.stage = "HEADER";
					break;
				case "HEADER":
					checkpoint.stage = "TRANSPORT";
					break;
				case "TRANSPORT":
					checkpoint.transportIndex += 1;
					break;
				case "HOTEL":
					checkpoint.stage = "ALLOWANCE";
					break;
				case "ALLOWANCE":
					checkpoint.stage = "VERIFY";
					break;
				case "VERIFY":
					setSaveState("prepared");
					checkpoint.stage = "SAVE_DRAFT";
					break;
				case "SAVE_DRAFT":
					checkpoint.stage = "CONFIRM";
					break;
				case "CONFIRM":
					setSaveState("confirmed");
					checkpoint.stage = "DONE";
					break;
				default:
					break;
			}
			await persist();
			continue;
		}

		const attempts = checkpoint.attempts[attemptKey] ?? 0;
		if (attempts >= maxAttempts) {
			checkpoint.errors.push(`${attemptKey} 在 ${maxAttempts} 次尝试后仍未满足阶段断言`);
			await persist();
			return result("blocked", checkpoint, expected, observation);
		}
		checkpoint.attempts[attemptKey] = attempts + 1;
		const before = travelDraftObservationFingerprint(observation!);
		try {
			observation = await call(operation!);
			if (checkpoint.stage === "SAVE_DRAFT" && !saveHasDispatched()) {
				// A driver that returns without consuming the durable permit violates the
				// irreversible-action contract. It may nevertheless have clicked, so mark
				// the state as dispatched and stop instead of ever retrying.
				setSaveState("dispatched");
				checkpoint.errors.push("SAVE_DRAFT：保存驱动器未消费持久化派发许可；保存状态未知，已禁止重试");
				await persist();
				return result("blocked", checkpoint, expected, observation);
			}
		} catch (error) {
			if (isInterruption(error, options.signal)) {
				return interruptResult(error instanceof Error ? error.message : String(error));
			}
			if (error instanceof TravelDraftBudgetError) {
				checkpoint.errors.push(error.message);
			} else {
				checkpoint.errors.push(`${attemptKey}：${error instanceof Error ? error.message : String(error)}`);
			}
			try {
				await persist();
			} catch (persistError) {
				checkpoint.errors.push(
					`恢复点持久化失败：${persistError instanceof Error ? persistError.message : String(persistError)}`,
				);
			}
			// Before the dispatch hook, SAVE_DRAFT remains prepared and is safe to
			// retry from a later invocation. After the hook it remains dispatched,
			// so recovery can confirm but can never issue a second save click.
			// Other driver exceptions remain fail-closed to avoid duplicate mutations.
			return result("blocked", checkpoint, expected, observation);
		}
		const after = travelDraftObservationFingerprint(observation);
		if (before === after) {
			checkpoint.noProgress[attemptKey] = (checkpoint.noProgress[attemptKey] ?? 0) + 1;
			if (checkpoint.noProgress[attemptKey] >= maxNoProgress) {
				checkpoint.errors.push(`${attemptKey} 连续 ${checkpoint.noProgress[attemptKey]} 次没有页面进展，已熔断`);
				await persist();
				return result("blocked", checkpoint, expected, observation);
			}
		} else {
			checkpoint.noProgress[attemptKey] = 0;
		}
		await persist();
	}

	return result("done", checkpoint, expected, observation);
}
