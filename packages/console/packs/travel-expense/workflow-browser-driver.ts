import { basename } from "node:path";
import {
	EKUAIBAO_TRUSTED_CONTRACT_VERSION,
	getAgentBrowserRuntime,
	redactSensitiveText,
	resolveSensitiveBrowserUrl,
	type EkuaibaoTrustedFailureCode,
	type EkuaibaoTrustedCommand,
	type EkuaibaoTrustedControl,
	type EkuaibaoTrustedField,
	type EkuaibaoTrustedOptionKind,
	type EkuaibaoTrustedPageState,
	type EkuaibaoTrustedScope,
	type EkuaibaoTrustedUploadSlot,
	type AgentBrowserRuntime,
	type AgentBrowserTarget,
} from "../../src/agent-browser-runtime.ts";
import { readAgentBrowserUploadFiles } from "../../src/agent-browser-tools.ts";
import {
	TRAVEL_DRAFT_CURRENT_USER,
	TRAVEL_DRAFT_COMPANY,
	TRAVEL_DRAFT_DEPARTMENT,
	TRAVEL_DRAFT_STATION,
	type TravelDraftAllowanceExpected,
	type TravelDraftApplication,
	type TravelDraftDetailObservation,
	type TravelDraftDriver,
	type TravelDraftExpected,
	type TravelDraftHeaderExpected,
	type TravelDraftHotelExpected,
	type TravelDraftIssue,
	type TravelDraftObservation,
	type TravelDraftPlan,
	type TravelDraftPrecheckResult,
	type TravelDraftConfirmationOptions,
	type TravelDraftTransportExpected,
	type TravelExpenseNature,
	TravelDraftInterruptedError,
} from "./workflow.ts";

const TEST_IDS = {
	application: "field-expenseLink-select",
	description: "field-text-u_事由",
	addDetail: "field-expenseDetail-add",
	feeType: "template-feeType-item",
	saveDetail: "feetype-footer-save",
	saveDraft: "flexable-button-edit",
} as const;

const FEE_TYPES = {
	transport: "差旅-城市间交通费-火车I高铁",
	hotel: "差旅-住宿费",
	allowance: "差旅-出差补助",
} as const;

const DANGEROUS_TARGET =
	/(?:flexable-button-submit|flexable-button-delete|feetype-footer-draft|提交送审|删除单据|作废|撤销|是否为多收款人)/i;
const DRAFT_CONFIRMATION = /(?:草稿保存成功|已存为草稿|已保存为草稿|保存成功)/;
const SNAPSHOT_SCOPE_MISS = "范围文字未找到：";
const EKUAIBAO_ALLOWED_ORIGIN = "https://app.ekuaibao.com";

export type TravelDraftBrowserBlockerCode =
	| "missing_anchor"
	| "ambiguous_anchor"
	| "unsafe_target"
	| "unsafe_page_state"
	| "unverified_state"
	| "invoice_dialog_contract"
	| "existing_row_unverifiable"
	| "action_budget";

export interface TravelDraftBrowserBlockerDetails {
	code: TravelDraftBrowserBlockerCode;
	operation: string;
	requirement: string;
	evidence: string[];
}

/**
 * A hard stop for DOM states that the narrow browser runtime cannot identify
 * uniquely. Callers should surface the requirement instead of broadening a
 * locator or letting a model guess an occurrence.
 */
export class TravelDraftBrowserBlocker extends Error {
	readonly details: TravelDraftBrowserBlockerDetails;

	constructor(details: TravelDraftBrowserBlockerDetails) {
		super(`${details.operation}：${details.requirement}`);
		this.name = "TravelDraftBrowserBlocker";
		this.details = details;
	}
}

export const TRAVEL_DRAFT_BROWSER_REQUIREMENTS = Object.freeze({
	application:
		"关联申请弹窗必须暴露搜索框、候选行 radio、申请标题和申请编号；候选必须能按标题+编号唯一确认。",
	field:
		"可编辑字段必须在 browser_snapshot 中有唯一 ref，并带稳定 data-testid 或准确 field label/placeholder。",
	invoice:
		"添加发票悬浮菜单必须出现“智能识票”；上传对话框必须只有一个 file ref；识别结果必须恰好一张且可唯一勾选，然后才允许“与该消费绑定”。",
	attachment: "普通附件区域必须在当前明细范围内暴露唯一 file ref；绝不回退到表单顶部或其他明细上传框。",
	draft: "只允许点击 data-testid=flexable-button-edit，且只有明确草稿成功文案才可确认保存。",
});

export interface TravelDraftBrowserDriverOptions {
	runtime?: AgentBrowserRuntime;
	cwd?: string;
	waitMilliseconds?: number;
	snapshotMaxChars?: number;
	snapshotMaxElements?: number;
	signal?: AbortSignal;
	maxBrowserActions?: number;
	onBrowserAction?: (event: TravelDraftBrowserActionEvent) => void | Promise<void>;
}

export type TravelDraftBrowserActionKind =
	| "navigate"
	| "snapshot"
	| "trusted"
	| "click"
	| "hover"
	| "type"
	| "upload";

export interface TravelDraftBrowserActionEvent {
	index: number;
	kind: TravelDraftBrowserActionKind;
	operation: string;
}

export interface TravelApplicationInvoiceFacts {
	travelDates: string[];
	cities: string[];
}

export interface DiscoverTravelApplicationInput {
	url: string;
	hint?: string;
	invoiceFacts: TravelApplicationInvoiceFacts;
}

export interface TravelApplicationCandidate {
	id: string;
	title: string;
	ref: string;
	evidence: string;
}

export type DiscoverTravelApplicationResult =
	| {
			status: "selected";
			application: TravelDraftApplication;
			candidates: TravelApplicationCandidate[];
			observation: TravelDraftObservation;
	  }
	| {
			status: "needs_input";
			missing: TravelDraftIssue[];
			ambiguous: TravelDraftIssue[];
			candidates: TravelApplicationCandidate[];
			observation?: TravelDraftObservation;
	  };

interface SnapshotElement {
	ref: string;
	descriptor: string;
	text: string;
	hints: string;
	raw: string;
}

function parseSnapshotElements(snapshot: string): SnapshotElement[] {
	const output: SnapshotElement[] = [];
	for (const raw of snapshot.split(/\r?\n/)) {
		const matched = /^\[(e\d+)\]\s+(\S+)\s+(.*)$/.exec(raw);
		if (!matched) continue;
		let text = matched[3];
		let hints = "";
		const hintStart = text.lastIndexOf(" (");
		if (hintStart >= 0 && text.endsWith(")")) {
			hints = text.slice(hintStart + 2, -1);
			text = text.slice(0, hintStart);
		}
		output.push({ ref: matched[1], descriptor: matched[2], text: text.trim(), hints, raw });
	}
	return output;
}

function hint(element: SnapshotElement, key: string): string | undefined {
	const expression = new RegExp(
		`(?:^|\\s)${key}=(.*?)(?=\\s(?:label|testid|placeholder|name|type|context|checked|ariaChecked|aria-checked)=|$)`,
	);
	return expression.exec(element.hints)?.[1]?.trim();
}

function testId(element: SnapshotElement): string | undefined {
	return hint(element, "testid");
}

function fieldLabel(element: SnapshotElement): string | undefined {
	return hint(element, "label");
}

function placeholder(element: SnapshotElement): string | undefined {
	return hint(element, "placeholder");
}

function hasType(element: SnapshotElement, type: string): boolean {
	return hint(element, "type") === type;
}

function isDisabled(element: SnapshotElement): boolean {
	return element.descriptor.split("/").includes("disabled");
}

function explicitChecked(element: SnapshotElement): boolean | undefined {
	for (const key of ["checked", "ariaChecked", "aria-checked"]) {
		const value = hint(element, key);
		if (value === "true") return true;
		if (value === "false") return false;
	}
	return undefined;
}

function isEmptyText(value: string): boolean {
	return value === "（无文字）" || value.trim() === "";
}

function semanticFieldValues(elements: SnapshotElement[], label: string): string[] {
	const values = new Map<string, string>();
	for (const element of elements) {
		if (fieldLabel(element) !== label || isEmptyText(element.text)) continue;
		const descriptor = element.descriptor.split("/")[0];
		if (["label", "span", "svg", "img", "button"].includes(descriptor)) continue;
		const normalized = normalizeText(element.text);
		if (!normalized || /^[▼▲▾▴✓✕×]+$/.test(element.text.trim())) continue;
		values.set(normalized, element.text);
	}
	return [...values.values()];
}

function isEditableElement(element: SnapshotElement): boolean {
	return /(?:input|textarea|select|combobox)/.test(element.descriptor);
}

function scopedFieldValues(elements: SnapshotElement[], label: string): string[] {
	const labeled = semanticFieldValues(elements, label);
	if (labeled.length > 0) return labeled;
	const values = new Map<string, string>();
	for (const element of elements) {
		if (fieldLabel(element) || !isEditableElement(element) || isEmptyText(element.text)) continue;
		values.set(normalizeText(element.text), element.text);
	}
	return [...values.values()];
}

function adjacentFieldValue(elements: SnapshotElement[], label: string): string | undefined {
	const labeled = semanticFieldValues(elements, label);
	if (labeled.length === 1) return labeled[0];
	if (labeled.length > 1) return undefined;
	const anchors = elements
		.map((element, index) => ({ element, index }))
		.filter(
			({ element }) =>
				element.descriptor.split("/")[0] === "label" &&
				(normalizeText(element.text) === normalizeText(label) || fieldLabel(element) === label),
		);
	if (anchors.length !== 1) return undefined;
	const candidates: string[] = [];
	for (const element of elements.slice(anchors[0].index + 1)) {
		if (element.descriptor.split("/")[0] === "label") break;
		if (fieldLabel(element) || !isEditableElement(element) || isEmptyText(element.text)) continue;
		candidates.push(element.text);
	}
	const unique = [...new Map(candidates.map((value) => [normalizeText(value), value])).values()];
	return unique.length === 1 ? unique[0] : undefined;
}

function normalizeText(value: string): string {
	return value.replace(/[\s/：:（）()_-]+/g, "").toLocaleLowerCase("zh-CN");
}

function containsNormalized(haystack: string, needle: string): boolean {
	return normalizeText(haystack).includes(normalizeText(needle));
}

function cityLevelPathMatches(value: string, city: string): boolean {
	const target = normalizeText(city).replace(/市$/, "");
	const segments = value
		.replace(/^城市\s+\S+\s+/, "")
		.split(/\s*\/\s*/)
		.map((segment) => normalizeText(segment))
		.filter(Boolean);
	const leaf = segments.at(-1)?.replace(/市$/, "");
	return leaf === target && !/(?:区|县|镇|乡|街道)$/.test(segments.at(-1) ?? "");
}

function labeledCityLevelEvidence(snapshot: string, label: "出发城市" | "到达城市", city: string): boolean {
	const value = labeledCityValue(snapshot, label);
	return Boolean(value && cityLevelPathMatches(value, city));
}

function labeledCityValue(snapshot: string, label: "出发城市" | "到达城市"): string | undefined {
	const nextLabels =
		label === "出发城市"
			? "到达城市|乘坐火车席别|费用报销人|报销费用金额"
			: "乘坐火车席别|费用报销人|报销费用金额|核减金额";
	const expression = new RegExp(`${label}[：:]\\s*(.*?)(?=\\s+(?:${nextLabels})[：:]|$)`);
	return expression.exec(snapshot)?.[1]?.trim();
}

function drawerCityLevelEvidence(
	snapshot: string,
	label: "出发城市" | "到达城市",
	city: string,
): boolean {
	const elements = parseSnapshotElements(snapshot);
	const adjacent = adjacentFieldValue(elements, label);
	if (adjacent) return cityLevelPathMatches(adjacent, city);
	const values = scopedFieldValues(elements, label);
	return values.length === 1 && cityLevelPathMatches(values[0], city);
}

interface ApplicationHintParts {
	id?: string;
	titleHint?: string;
	dates: Array<{ year?: number; month: number; day: number }>;
}

function parseApplicationHint(value: string | undefined): ApplicationHintParts {
	const source = value?.trim() ?? "";
	const id = /\bS\d{6,}\b/i.exec(source)?.[0]?.toUpperCase();
	const dates: ApplicationHintParts["dates"] = [];
	const datePattern = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})|(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)?|(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)?|\b(\d{1,2})[-/.](\d{1,2})\b/g;
	for (const match of source.matchAll(datePattern)) {
		if (match[1]) dates.push({ year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) });
		else if (match[4]) dates.push({ year: Number(match[4]), month: Number(match[5]), day: Number(match[6]) });
		else if (match[7]) dates.push({ month: Number(match[7]), day: Number(match[8]) });
		else dates.push({ month: Number(match[9]), day: Number(match[10]) });
	}
	const titleHint = source
		.replace(datePattern, " ")
		.replace(/\bS\d{6,}\b/gi, " ")
		.replace(/[\s,，、;；|]+/g, " ")
		.trim();
	return { id, titleHint: titleHint || undefined, dates };
}

function hintDateMatchesIso(
	hint: ApplicationHintParts["dates"][number],
	isoDate: string,
): boolean {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
	if (!match) return false;
	return (
		(hint.year === undefined || hint.year === Number(match[1])) &&
		hint.month === Number(match[2]) &&
		hint.day === Number(match[3])
	);
}

function isAllowedEkuaibaoUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return (
			parsed.protocol === "https:" &&
			parsed.hostname === "app.ekuaibao.com" &&
			parsed.username === "" &&
			parsed.password === "" &&
			parsed.port === ""
		);
	} catch {
		return false;
	}
}

function amountSignals(value: number): string[] {
	return [String(value), value.toFixed(2), `¥${value.toFixed(2)}`, `￥${value.toFixed(2)}`];
}

function exactAmountCents(value: string): number | undefined {
	const match = /^(?:CNY\s*|[¥￥]\s*)?((?:\d{1,3}(?:,\d{3})*)|\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
	if (!match) return undefined;
	const whole = Number(match[1].replaceAll(",", ""));
	const decimals = (match[2] ?? "").padEnd(2, "0");
	return whole * 100 + Number(decimals || "0");
}

function moneyTokenCents(value: string): number[] {
	const amounts: number[] = [];
	for (const match of value.matchAll(/(?:CNY\s*|[¥￥]\s*)((?:\d{1,3}(?:,\d{3})*)|\d+)(?:\.(\d{1,2}))?/g)) {
		const cents = exactAmountCents(match[0]);
		if (cents !== undefined) amounts.push(cents);
	}
	return amounts;
}

function labeledMoneyCents(snapshot: string, label: string): number[] {
	const values: number[] = [];
	for (const element of parseSnapshotElements(snapshot)) {
		if (fieldLabel(element) === label) {
			const cents = exactAmountCents(element.text);
			if (cents !== undefined) values.push(cents);
		}
	}
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const expression = new RegExp(
		`${escaped}[：:\\s]*((?:CNY\\s*|[¥￥]\\s*)((?:\\d{1,3}(?:,\\d{3})*)|\\d+)(?:\\.(\\d{1,2}))?)(?![\\d.])`,
		"g",
	);
	for (const match of snapshot.matchAll(expression)) {
		const cents = exactAmountCents(match[1]);
		if (cents !== undefined) values.push(cents);
	}
	return [...new Set(values)];
}

function drawerAmountEvidence(snapshot: string, expected: number): boolean {
	const placeholderAmounts = parseSnapshotElements(snapshot)
		.filter((element) => placeholder(element) === "请输入报销费用金额" && isEditableElement(element))
		.map((element) => exactAmountCents(element.text))
		.filter((value): value is number => value !== undefined);
	if (placeholderAmounts.length > 0) {
		return placeholderAmounts.length === 1 && placeholderAmounts[0] === Math.round(expected * 100);
	}
	const values = labeledMoneyCents(snapshot, "报销费用金额");
	return values.length === 1 && values[0] === Math.round(expected * 100);
}

function foldedAmountEvidence(snapshot: string, expected: number): boolean {
	const reimbursement = labeledMoneyCents(snapshot, "报销费用金额");
	if (reimbursement.length > 0) {
		return reimbursement.length === 1 && reimbursement[0] === Math.round(expected * 100);
	}
	const invoice = labeledMoneyCents(snapshot, "发票金额");
	return invoice.length === 1 && invoice[0] === Math.round(expected * 100);
}

function fileSignals(path: string): string[] {
	const name = basename(path);
	const stem = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
	if (stem.length <= 28) return [name, stem].filter(Boolean);
	return [name, stem.slice(0, 20), stem.slice(-18)].filter(Boolean);
}

function codedOptionMatches(value: string, expected: string): boolean {
	const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${escaped}(?:(?:（[^（）]+）)|(?:\\([^()]+\\)))?$`).test(value);
}

function hasFileEvidence(snapshot: string, path: string): boolean {
	return fileSignals(path).some((signal) => snapshot.includes(signal));
}

function hasBoundInvoiceCount(snapshot: string): boolean {
	return /(?:已有发票|已绑定发票|已选)\s*[*×xX]?\s*1(?:\s*张发票)?/.test(snapshot);
}

function recognizedInvoiceIdentityEvidence(
	snapshot: string,
	row: TravelDraftTransportExpected | TravelDraftHotelExpected,
): boolean {
	if (row.kind === "hotel") {
		const visibleDates = [...snapshot.matchAll(/\b\d{4}[-/.]\d{2}[-/.]\d{2}\b/g)].map((match) =>
			match[0].replaceAll("/", "-").replaceAll(".", "-"),
		);
		return (
			moneyTokenCents(snapshot).includes(Math.round(row.amount * 100)) &&
			visibleDates.some((date) => date >= row.checkinDate && date <= row.checkoutDate) &&
			/(?:住宿|酒店|增值税[^\n]{0,12}发票|电子发票)/.test(snapshot)
		);
	}
	if (!row.fromStation || !row.toStation) return false;
	const stationPattern = (value: string) => {
		const withoutSuffix = value.replace(/站$/, "");
		return `${withoutSuffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:站)?`;
	};
	const directed = new RegExp(
		`${stationPattern(row.fromStation)}\\s*(?:-|—|–|→|至|到)\\s*${stationPattern(row.toStation)}`,
	).test(snapshot);
	const labeledDirection =
		new RegExp(`出发站[：:]\\s*${stationPattern(row.fromStation)}`).test(snapshot) &&
		new RegExp(`到达站[：:]\\s*${stationPattern(row.toStation)}`).test(snapshot);
	const dateSignals = [row.travelDate, row.travelDate.replaceAll("-", "/"), row.travelDate.replaceAll("-", ".")];
	return (
		(directed || labeledDirection) &&
		moneyTokenCents(snapshot).includes(Math.round(row.amount * 100)) &&
		dateSignals.some((date) => snapshot.includes(date)) &&
		/(?:铁路电子客票|火车票|高铁票)/.test(snapshot) &&
		/(?:已验真|验真通过|查验通过)/.test(snapshot)
	);
}

function verifiedInvoiceBindingKey(row: TravelDraftTransportExpected | TravelDraftHotelExpected): string {
	return `${row.key}\u0000${row.invoiceNumber}`;
}

function boundInvoiceSummaryEvidence(
	snapshot: string,
	row: TravelDraftTransportExpected | TravelDraftHotelExpected,
): boolean {
	if (
		snapshot.includes(SNAPSHOT_SCOPE_MISS) ||
		!snapshot.includes("上传发票") ||
		!snapshot.includes("已有发票") ||
		!hasBoundInvoiceCount(snapshot) ||
		!moneyTokenCents(snapshot).includes(Math.round(row.amount * 100))
	) {
		return false;
	}
	const explicitNumbers = [
		...snapshot.matchAll(/发票(?:号码|号)[：:]\s*([^\s)）]+)/g),
	].map((match) => match[1]);
	return explicitNumbers.length === 0 || explicitNumbers.every((number) => number === row.invoiceNumber);
}

function issue(code: string, field: string, message: string): TravelDraftIssue {
	return { code, field, message };
}

function departmentPathMatches(value: string): boolean {
	return normalizeText(value) === normalizeText(TRAVEL_DRAFT_DEPARTMENT);
}

function departmentLeaf(): string {
	return TRAVEL_DRAFT_DEPARTMENT.split("/").at(-1) ?? TRAVEL_DRAFT_DEPARTMENT;
}

function departmentLeafMatches(value: string): boolean {
	return normalizeText(value) === normalizeText(departmentLeaf());
}

function applicationCandidates(snapshot: string): TravelApplicationCandidate[] {
	const candidates = new Map<string, TravelApplicationCandidate>();
	for (const element of parseSnapshotElements(snapshot)) {
		if (!hasType(element, "radio")) continue;
		const evidence = fieldLabel(element) ?? element.text;
		const id = /\b(S\d{6,})\b/.exec(evidence)?.[1];
		if (!id) continue;
		const idIndex = evidence.indexOf(id);
		const title = evidence.slice(0, idIndex).trim();
		if (!title) continue;
		candidates.set(`${id}\u0000${title}`, { id, title, ref: element.ref, evidence });
	}
	return [...candidates.values()];
}

function linkedApplicationCandidate(
	snapshot: string,
	idHint: string | undefined,
	titleHint: string | undefined,
): TravelApplicationCandidate | undefined {
	const ids = [...new Set(snapshot.match(/\bS\d{6,}\b/g) ?? [])].filter(
		(id) => !idHint || id.toUpperCase() === idHint.toUpperCase(),
	);
	const titles = [
		...new Set(
			(snapshot.match(/出差申请[：:][^\n|()（）]+/g) ?? [])
				.map((title) => title.replace(/\s+S\d{6,}.*$/, "").trim())
				.filter((title) => !titleHint || containsNormalized(title, titleHint)),
		),
	];
	if (ids.length !== 1 || titles.length !== 1) return undefined;
	return { id: ids[0], title: titles[0], ref: "", evidence: snapshot };
}

interface VerifiedApplicationFacts {
	application: TravelDraftApplication;
	source: "candidate" | "details";
}

interface ParsedApplicationFacts {
	facts?: VerifiedApplicationFacts;
	missing: TravelDraftIssue[];
	ambiguous: TravelDraftIssue[];
}

function normalizeFactDate(value: string): string | undefined {
	const match = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?$/.exec(value.trim());
	if (!match) return undefined;
	return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function normalizedFactCity(value: string): string {
	const segments = value
		.split(/\s*\/\s*/)
		.map((segment) => segment.trim())
		.filter(Boolean);
	const leaf = (segments.at(-1) ?? value.trim()).replace(/^.*?(?:省|自治区)/, "");
	return normalizeText(leaf).replace(/(?:市|地区|自治州)$/, "");
}

interface ParsedApplicationSourceFacts {
	reason?: string;
	expenseNature?: TravelExpenseNature;
	source?: VerifiedApplicationFacts["source"];
	missing: TravelDraftIssue[];
	ambiguous: TravelDraftIssue[];
}

function reasonFromApplicationTitle(title: string): string | undefined {
	const match = /^出差申请\s*[：:]\s*(.+)$/.exec(title.trim());
	return match?.[1]?.trim() || undefined;
}

function parseApplicationSourceFacts(
	snapshot: string,
	candidate: TravelApplicationCandidate,
	source: VerifiedApplicationFacts["source"],
): ParsedApplicationSourceFacts {
	const missing: TravelDraftIssue[] = [];
	const ambiguous: TravelDraftIssue[] = [];
	if (!snapshot.includes(candidate.id) || !snapshot.includes(candidate.title)) {
		missing.push(issue("application_source_unverified", "application", "申请来源范围未同时显示申请编号和标题"));
	}
	const elements = parseSnapshotElements(snapshot);
	const explicitReasons = ["申请事由", "出差事由", "事由"]
		.flatMap((label) => semanticFieldValues(elements, label))
		.map((value) => value.trim())
		.filter(Boolean);
	for (const match of snapshot.matchAll(
		/(?:申请事由|出差事由|(?<!报销)事由)\s*[：:=]\s*(.+?)(?=\s+费用性质\s*[：:=]|[|；;\n)）]|$)/g,
	)) {
		if (match[1]?.trim()) explicitReasons.push(match[1].trim());
	}
	const reasons = [...new Map(explicitReasons.map((value) => [normalizeText(value), value])).values()];
	const titleReason = reasonFromApplicationTitle(candidate.title);
	if (reasons.length === 0 && titleReason) reasons.push(titleReason);
	const expenseNatures = [
		...new Set([
			...semanticFieldValues(elements, "费用性质"),
			...(snapshot.match(/费用性质\s*[：:=]\s*(部门费用|项目费用)/g) ?? []).map(
				(value) => /部门费用/.test(value) ? "部门费用" : "项目费用",
			),
		].filter((value): value is TravelExpenseNature => value === "部门费用" || value === "项目费用")),
	];
	if (reasons.length === 0) missing.push(issue("application_fact_missing", "reason", "申请详情缺少唯一申请事由"));
	else if (reasons.length > 1) ambiguous.push(issue("application_fact_ambiguous", "reason", "申请详情出现冲突的申请事由"));
	if (expenseNatures.length === 0) {
		missing.push(issue("application_fact_missing", "expenseNature", "申请详情缺少唯一费用性质"));
	} else if (expenseNatures.length > 1) {
		ambiguous.push(issue("application_fact_ambiguous", "expenseNature", "申请详情出现冲突的费用性质"));
	}
	return {
		reason: reasons.length === 1 ? reasons[0] : undefined,
		expenseNature: expenseNatures.length === 1 ? expenseNatures[0] : undefined,
		source: missing.length === 0 && ambiguous.length === 0 ? source : undefined,
		missing,
		ambiguous,
	};
}

function parseLinkedApplicationFacts(
	snapshot: string,
	candidate: TravelApplicationCandidate,
	sourceFacts: ParsedApplicationSourceFacts,
): ParsedApplicationFacts {
	const missing: TravelDraftIssue[] = [];
	const ambiguous: TravelDraftIssue[] = [];
	const elements = parseSnapshotElements(snapshot);
	missing.push(...sourceFacts.missing);
	ambiguous.push(...sourceFacts.ambiguous);
	const linkedDates = elements.filter(
		(element) => fieldLabel(element) === "申请单中的差旅起止日期" && element.descriptor.split("/").includes("disabled"),
	);
	const dateValues = (datePlaceholder: "开始日期" | "结束日期") => [
		...new Set(
			linkedDates
				.filter((element) => placeholder(element) === datePlaceholder)
				.map((element) => normalizeFactDate(element.text))
				.filter((value): value is string => Boolean(value)),
		),
	];
	const startDates = dateValues("开始日期");
	const endDates = dateValues("结束日期");
	for (const [field, label, values] of [
		["startDate", "申请单中的差旅开始日期", startDates],
		["endDate", "申请单中的差旅结束日期", endDates],
	] as Array<[string, string, string[]]>) {
		if (values.length === 0) missing.push(issue("application_fact_missing", field, `主表未显示唯一“${label}”`));
		else if (values.length > 1) ambiguous.push(issue("application_fact_ambiguous", field, `主表出现冲突的“${label}”`));
	}
	if (!snapshot.includes(candidate.id) || !snapshot.includes(candidate.title)) {
		missing.push(issue("application_selection_unverified", "application", "主表未同时回读关联申请编号和标题"));
	}
	if (missing.length > 0 || ambiguous.length > 0) return { missing, ambiguous };
	return {
		facts: {
			application: {
				id: candidate.id,
				title: candidate.title,
				reason: sourceFacts.reason!,
				startDate: startDates[0],
				endDate: endDates[0],
				expenseNature: sourceFacts.expenseNature!,
			},
			source: sourceFacts.source!,
		},
		missing,
		ambiguous,
	};
}

function sameApplication(left: TravelDraftApplication, right: TravelDraftApplication): boolean {
	return (
		left.id === right.id &&
		left.title === right.title &&
		left.reason === right.reason &&
		left.startDate === right.startDate &&
		left.endDate === right.endDate &&
		left.expenseNature === right.expenseNature
	);
}

function linkedApplicationIssues(
	application: TravelDraftApplication,
	invoiceFacts: TravelApplicationInvoiceFacts,
): TravelDraftIssue[] {
	const issues: TravelDraftIssue[] = [];
	const invoiceDates = [...new Set(invoiceFacts.travelDates)];
	const outside = invoiceDates.filter((date) => date < application.startDate || date > application.endDate);
	if (outside.length > 0) {
		issues.push(
			issue(
				"invoice_date_outside_application",
				"application",
				`票据日期 ${outside.join("、")} 不在申请 ${application.startDate} 至 ${application.endDate} 内`,
			),
		);
	}
	const invoiceCities = [...new Set(invoiceFacts.cities.map(normalizedFactCity).filter(Boolean))];
	const station = normalizedFactCity("南京");
	const destinations = invoiceCities.filter((city) => city !== station);
	if (!invoiceCities.includes(station) || destinations.length === 0) {
		issues.push(
			issue(
				"application_city_conflict",
				"application",
				"票据城市必须包含驻地南京和至少一个外地目的地",
			),
		);
	}
	return issues;
}

function expectedDetail(row: TravelDraftTransportExpected | TravelDraftHotelExpected | TravelDraftAllowanceExpected) {
	return structuredClone(row) as TravelDraftDetailObservation;
}

function detailScope(row: TravelDraftTransportExpected | TravelDraftHotelExpected | TravelDraftAllowanceExpected): string[] {
	if (row.kind === "transport") return [FEE_TYPES.transport, row.startDate, `¥${row.amount.toFixed(2)}`];
	if (row.kind === "hotel") return [FEE_TYPES.hotel, row.paymentRecipient];
	return [FEE_TYPES.allowance, row.allowanceType, row.paymentRecipient];
}

function detailDrawerScope(feeType: string, ...fieldLabels: string[]): string[] {
	return ["添加明细", feeType, ...fieldLabels];
}

function trustedDetailKind(feeType: string): "transport" | "hotel" | "allowance" {
	if (feeType === FEE_TYPES.transport) return "transport";
	if (feeType === FEE_TYPES.hotel) return "hotel";
	if (feeType === FEE_TYPES.allowance) return "allowance";
	throw new Error(`未知差旅费用类型：${feeType}`);
}

function trustedDetailEvidence(
	row: TravelDraftTransportExpected | TravelDraftHotelExpected | TravelDraftAllowanceExpected,
): string[] {
	if (row.kind === "transport") {
		return [row.startDate, row.endDate, row.fromCity, row.toCity, row.seatClass, row.amount.toFixed(2)];
	}
	if (row.kind === "hotel") return [row.checkinDate, row.checkoutDate, row.amount.toFixed(2), row.paymentRecipient];
	return [row.startDate, row.endDate, row.allowanceType, row.amount.toFixed(2), row.paymentRecipient];
}

function detailCoreEvidence(
	snapshot: string,
	row: TravelDraftTransportExpected | TravelDraftHotelExpected | TravelDraftAllowanceExpected,
): boolean {
	if (snapshot.includes(SNAPSHOT_SCOPE_MISS)) return false;
	const required =
		row.kind === "transport"
			? [
					FEE_TYPES.transport,
					row.startDate,
					row.endDate,
					row.fromCity,
					row.toCity,
					row.seatClass,
				]
			: row.kind === "hotel"
				? [FEE_TYPES.hotel, row.checkinDate, row.checkoutDate]
				: [FEE_TYPES.allowance, row.startDate, row.endDate, row.allowanceType];
	if (!required.every((value) => containsNormalized(snapshot, value))) return false;
	return true;
}

type DetailRecipientLabel = "费用报销人" | "支付信息";

function paymentAccountEvidence(value: string): boolean {
	const normalized = normalizeText(value);
	if (!normalized.includes(normalizeText(TRAVEL_DRAFT_CURRENT_USER))) return false;
	if (paymentAccountExplicitlyNonPersonal(value)) return false;
	if (normalized.includes(normalizeText(`${TRAVEL_DRAFT_CURRENT_USER}个人账户`))) return true;
	const hasBankAccountDescriptor = /(?:银行|银行卡|卡号|账号|账户尾号|尾号)/.test(value);
	const hasAccountIdentifier = /(?:\d{4,}|[*＊•·]{2,})/.test(value);
	return hasBankAccountDescriptor && hasAccountIdentifier;
}

function paymentAccountExplicitlyNonPersonal(value: string): boolean {
	return /(?:公司账户|企业账户|对公)/.test(normalizeText(value));
}

function paymentNameOnlyEvidence(value: string): boolean {
	return !paymentAccountExplicitlyNonPersonal(value) && normalizeText(value) === normalizeText(TRAVEL_DRAFT_CURRENT_USER);
}

function paymentPickerScopeEvidence(snapshot: string): boolean {
	return (
		!paymentAccountExplicitlyNonPersonal(snapshot) &&
		containsNormalized(snapshot, TRAVEL_DRAFT_CURRENT_USER) &&
		containsNormalized(snapshot, "个人账户")
	);
}

function recipientFieldValues(snapshot: string, label: DetailRecipientLabel): string[] {
	const elements = parseSnapshotElements(snapshot);
	const direct = elements.filter((element) => {
		if (fieldLabel(element) !== label || isEmptyText(element.text)) return false;
		const descriptor = element.descriptor.split("/")[0];
		return !["label", "span", "svg", "img"].includes(descriptor);
	});
	if (direct.length > 0) {
		return [...new Map(direct.map((element) => [normalizeText(element.text), element.text])).values()];
	}
	const anchors = elements
		.map((element, index) => ({ element, index }))
		.filter(
			({ element }) =>
				element.descriptor.split("/")[0] === "label" &&
				(normalizeText(element.text) === normalizeText(label) || fieldLabel(element) === label),
		);
	if (anchors.length !== 1) return [];
	const values: string[] = [];
	for (const element of elements.slice(anchors[0].index + 1)) {
		if (element.descriptor.split("/")[0] === "label") break;
		if (fieldLabel(element) && fieldLabel(element) !== label) break;
		if (isEmptyText(element.text)) continue;
		const descriptor = element.descriptor.split("/")[0];
		if (!["button", "div", "input", "select", "combobox"].includes(descriptor)) continue;
		values.push(element.text);
	}
	return [...new Map(values.map((value) => [normalizeText(value), value])).values()];
}

function drawerRecipientEvidence(snapshot: string, label: DetailRecipientLabel, allowVerifiedNameOnly = false): boolean {
	const values = recipientFieldValues(snapshot, label);
	if (values.length !== 1 || !containsNormalized(values[0], TRAVEL_DRAFT_CURRENT_USER)) return false;
	return (
		label !== "支付信息" ||
		paymentAccountEvidence(values[0]) ||
		(allowVerifiedNameOnly && paymentNameOnlyEvidence(values[0]))
	);
}

function foldedExpenseReporterEvidence(snapshot: string): boolean {
	const escaped = TRAVEL_DRAFT_CURRENT_USER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(
		`费用报销人[：:]\\s*${escaped}(?:[（(][^）)]*[）)])?(?=\\s+(?:报销费用金额|核减金额|费用说明|发票金额|支付方式)[：:]|$)`,
	).test(snapshot);
}

function foldedPaymentEvidence(
	snapshot: string,
	row: TravelDraftTransportExpected | TravelDraftHotelExpected | TravelDraftAllowanceExpected,
	allowVerifiedNameOnly = false,
): boolean {
	const expectedCents = Math.round(row.amount * 100);
	const hasAccount = snapshot
		.split(/\r?\n/)
		.map((line) => line.trim())
		.some(
			(line) =>
				paymentAccountEvidence(line) ||
				(allowVerifiedNameOnly &&
					(paymentNameOnlyEvidence(line) ||
						new RegExp(`(?:^|\\s)(?:支付信息|收款人)[：:]?\\s*${TRAVEL_DRAFT_CURRENT_USER}(?=\\s|$)`).test(
							line,
						))),
		);
	const hasPaymentContext = /(?:支付信息|收款人|已有发票|支付计划|支付方式|全额支付)/.test(snapshot);
	return hasAccount && hasPaymentContext && moneyTokenCents(snapshot).includes(expectedCents);
}

function foldedDetailEvidence(
	snapshot: string,
	row: TravelDraftTransportExpected | TravelDraftHotelExpected | TravelDraftAllowanceExpected,
	allowVerifiedNameOnly = false,
): boolean {
	if (foldedDetailCandidates(snapshot, row).length === 0) return false;
	if (!foldedPaymentEvidence(snapshot, row, allowVerifiedNameOnly)) return false;
	if (row.kind === "allowance") return snapshot.includes(String(row.days));
	if (!hasBoundInvoiceCount(snapshot)) return false;
	return true;
}

function foldedRowCoreEvidence(
	snapshot: string,
	row: TravelDraftTransportExpected | TravelDraftHotelExpected | TravelDraftAllowanceExpected,
): boolean {
	if (!detailCoreEvidence(snapshot, row)) return false;
	if (!foldedExpenseReporterEvidence(snapshot)) return false;
	if (!foldedAmountEvidence(snapshot, row.amount)) return false;
	if (row.kind !== "transport") return true;
	return (
		labeledCityLevelEvidence(snapshot, "出发城市", row.fromCity) &&
		labeledCityLevelEvidence(snapshot, "到达城市", row.toCity)
	);
}

function drawerDetailEvidence(
	formSnapshot: string,
	reporterSnapshot: string,
	paymentSnapshot: string,
	invoiceSnapshot: string | undefined,
	attachmentSnapshot: string | undefined,
	row: TravelDraftTransportExpected | TravelDraftHotelExpected | TravelDraftAllowanceExpected,
	invoiceBindingVerified: boolean,
	paymentNameOnlyVerified: boolean,
): boolean {
	if (!detailCoreEvidence(formSnapshot, row)) return false;
	if (!drawerRecipientEvidence(reporterSnapshot, "费用报销人")) return false;
	if (!drawerRecipientEvidence(paymentSnapshot, "支付信息", paymentNameOnlyVerified)) return false;
	if (!drawerAmountEvidence(formSnapshot, row.amount)) return false;
	if (row.kind === "allowance") return formSnapshot.includes(String(row.days));
	if (
		row.kind === "transport" &&
		(!drawerCityLevelEvidence(formSnapshot, "出发城市", row.fromCity) ||
			!drawerCityLevelEvidence(formSnapshot, "到达城市", row.toCity))
	) {
		return false;
	}
	if (!invoiceBindingVerified || !invoiceSnapshot || !boundInvoiceSummaryEvidence(invoiceSnapshot, row)) return false;
	if (!attachmentSnapshot) return false;
	return [row.uploadFile, ...row.verificationFiles].every((file) => hasFileEvidence(attachmentSnapshot, file));
}

function foldedDetailCandidates(
	snapshot: string,
	row: TravelDraftTransportExpected | TravelDraftHotelExpected | TravelDraftAllowanceExpected,
): SnapshotElement[] {
	return parseSnapshotElements(snapshot).filter((element) => foldedRowCoreEvidence(element.text, row));
}

function foldedTransportRouteEvidence(snapshot: string, row: TravelDraftTransportExpected): boolean {
	const mentionsCity = (value: string, city: string) => {
		const target = normalizeText(city).replace(/市$/, "");
		return value
			.split(/\s*\/\s*/)
			.map((segment) => normalizeText(segment).replace(/市$/, ""))
			.some((segment) => segment === target);
	};
	return parseSnapshotElements(snapshot).some((element) => {
		const from = labeledCityValue(element.text, "出发城市");
		const to = labeledCityValue(element.text, "到达城市");
		return Boolean(from && to && mentionsCity(from, row.fromCity) && mentionsCity(to, row.toCity));
	});
}

function detailFeeType(row: TravelDraftTransportExpected | TravelDraftHotelExpected | TravelDraftAllowanceExpected): string {
	if (row.kind === "transport") return FEE_TYPES.transport;
	if (row.kind === "hotel") return FEE_TYPES.hotel;
	return FEE_TYPES.allowance;
}

type PaymentVerificationDomain = "main" | `detail:${string}`;

function detailPaymentDomain(
	row: TravelDraftTransportExpected | TravelDraftHotelExpected | TravelDraftAllowanceExpected,
): PaymentVerificationDomain {
	return `detail:${row.key}`;
}

function parseDetailCount(snapshot: string): number | undefined {
	const values = [
		...new Set([...snapshot.matchAll(/费用明细\s*[（(](\d+)[）)]/g)].map((match) => Number(match[1]))),
	];
	return values.length === 1 ? values[0] : undefined;
}

export function parseTravelPaymentTotal(snapshot: string): number | undefined {
	const elements = parseSnapshotElements(snapshot).filter(
		(element) => fieldLabel(element) === "支付金额总计" || testId(element) === "payment-amount-total",
	);
	if (elements.length > 0) {
		const amounts = elements
			.map((element) => exactAmountCents(element.text))
			.filter((value): value is number => value !== undefined);
		return amounts.length === 1 ? amounts[0] / 100 : undefined;
	}
	const labeled = labeledMoneyCents(snapshot, "支付金额总计");
	return labeled.length === 1 ? labeled[0] / 100 : undefined;
}

function parseExpectedTotal(snapshot: string, expected: number): number | undefined {
	const actual = parseTravelPaymentTotal(snapshot);
	return actual !== undefined && Math.round(actual * 100) === Math.round(expected * 100) ? actual : undefined;
}

function explicitConfirmation(snapshot: string): string | undefined {
	return DRAFT_CONFIRMATION.exec(snapshot)?.[0];
}

export class TravelDraftBrowserDriver implements TravelDraftDriver {
	private readonly browser: AgentBrowserRuntime;
	private readonly cwd: string;
	private readonly waitMilliseconds: number;
	private readonly snapshotMaxChars: number;
	private readonly snapshotMaxElements: number;
	private readonly signal: AbortSignal | undefined;
	private readonly maxBrowserActions: number;
	private readonly onBrowserAction: TravelDraftBrowserDriverOptions["onBrowserAction"];
	private browserActions = 0;
	private expected: TravelDraftExpected | undefined;
	private verifiedApplicationFacts: VerifiedApplicationFacts | undefined;
	private readonly verifiedDetails = new Map<string, TravelDraftDetailObservation>();
	private readonly verifiedInvoiceBindings = new Set<string>();
	private readonly verifiedDepartments = new Set<"申请人部门" | "费用所属部门">();
	private readonly verifiedPaymentDomains = new Set<PaymentVerificationDomain>();
	private verificationValid = false;
	private saveAttempted = false;
	private saveRequested = false;
	private saveConfirmation: string | undefined;
	private saveVerifiedObservation: TravelDraftObservation | undefined;
	private detailCountBeforeOpen: number | undefined;
	private lastTrustedState: EkuaibaoTrustedPageState | undefined;
	private lastVerifiedTrustedDigest: string | undefined;
	private lastDocumentToken: string | undefined;
	private lastDocumentUrl: string | undefined;

	constructor(options: TravelDraftBrowserDriverOptions = {}) {
		this.browser = options.runtime ?? getAgentBrowserRuntime();
		this.cwd = options.cwd ?? process.cwd();
		this.waitMilliseconds = Math.max(100, options.waitMilliseconds ?? 400);
		this.snapshotMaxChars = Math.max(1000, Math.min(options.snapshotMaxChars ?? 12000, 12000));
		this.snapshotMaxElements = Math.max(20, Math.min(options.snapshotMaxElements ?? 1000, 1000));
		this.signal = options.signal;
		this.maxBrowserActions = Math.max(1, options.maxBrowserActions ?? 400);
		this.onBrowserAction = options.onBrowserAction;
	}

	private blocker(
		code: TravelDraftBrowserBlockerCode,
		operation: string,
		requirement: string,
		evidence: string[] = [],
	): never {
		throw new TravelDraftBrowserBlocker({ code, operation, requirement, evidence: evidence.slice(0, 8) });
	}

	private async pause(milliseconds = this.waitMilliseconds): Promise<void> {
		this.throwIfAborted("等待页面更新");
		await this.browser.wait(milliseconds);
		this.throwIfAborted("等待页面更新");
	}

	private async waitFor(milliseconds: number, text: string): Promise<string> {
		this.throwIfAborted(`等待页面文字“${text}”`);
		const output = await this.browser.wait(milliseconds, text);
		this.throwIfAborted(`等待页面文字“${text}”`);
		return output;
	}

	private throwIfAborted(operation: string): void {
		if (this.signal?.aborted) throw new TravelDraftInterruptedError(`${operation}已中断`);
	}

	private async beforeBrowserAction(kind: TravelDraftBrowserActionKind, operation: string): Promise<void> {
		this.throwIfAborted(operation);
		if (this.browserActions >= this.maxBrowserActions) {
			this.blocker(
				"action_budget",
				operation,
				`浏览器动作已达全局上限 ${this.maxBrowserActions}，未再发出下一个 DOM 事件`,
			);
		}
		this.browserActions += 1;
		await this.onBrowserAction?.({ index: this.browserActions, kind, operation });
		this.throwIfAborted(operation);
	}

	private invalidateDraftSaveEvidence(): void {
		this.saveRequested = false;
		this.saveConfirmation = undefined;
		this.saveVerifiedObservation = undefined;
		this.verificationValid = false;
		this.lastVerifiedTrustedDigest = undefined;
		this.lastTrustedState = undefined;
	}

	private draftSaveObservation(): TravelDraftObservation {
		if (!this.saveVerifiedObservation) {
			this.blocker("unverified_state", "确认草稿保存", "保存前的新鲜全表核验结果不可用；不会再次点击保存");
		}
		const observation = structuredClone(this.saveVerifiedObservation);
		observation.draft = {
			saveRequested: this.saveRequested,
			saved: this.saveRequested && Boolean(this.saveConfirmation),
			confirmationText: this.saveConfirmation,
		};
		return observation;
	}

	private async navigate(url: string): Promise<void> {
		let resolved: string;
		try {
			resolved = resolveSensitiveBrowserUrl(url);
		} catch (error) {
			throw new Error(redactSensitiveText(error instanceof Error ? error.message : String(error)));
		}
		if (!isAllowedEkuaibaoUrl(resolved)) {
			this.blocker(
				"unsafe_target",
				"打开差旅报销页面",
				"只允许访问 https://app.ekuaibao.com（无账号信息、无非标准端口）",
			);
		}
		this.invalidateDraftSaveEvidence();
		// These capabilities are document-local. Never carry a collapsed payment
		// display proof into another form, even when business row keys happen to match.
		this.verifiedPaymentDomains.clear();
		this.lastDocumentToken = undefined;
		this.lastDocumentUrl = undefined;
		await this.beforeBrowserAction("navigate", "打开差旅报销页面");
		try {
			await this.browser.navigate(resolved);
		} catch (error) {
			if (this.signal?.aborted) throw new TravelDraftInterruptedError("打开差旅报销页面已中断");
			throw new Error(redactSensitiveText(error instanceof Error ? error.message : String(error)));
		}
		this.throwIfAborted("打开差旅报销页面");
	}

	private async snapshot(scopeTexts?: string[]): Promise<string> {
		this.observeDocumentUrl();
		await this.beforeBrowserAction("snapshot", "读取页面快照");
		const output = await this.browser.snapshot({
			maxChars: this.snapshotMaxChars,
			maxElements: this.snapshotMaxElements,
			scopeTexts: scopeTexts?.filter(Boolean),
		});
		this.throwIfAborted("读取页面快照");
		return output;
	}

	private observeDocumentUrl(): void {
		const url = this.browser.state().url;
		if (!url) return;
		if (this.lastDocumentUrl && this.lastDocumentUrl !== url) this.verifiedPaymentDomains.clear();
		this.lastDocumentUrl = url;
	}

	private observeTrustedDocumentToken(pageToken: string): void {
		if (this.lastDocumentToken && this.lastDocumentToken !== pageToken) {
			this.verifiedPaymentDomains.clear();
		}
		this.lastDocumentToken = pageToken;
	}

	private trustedBlockerCode(code: EkuaibaoTrustedFailureCode): TravelDraftBrowserBlockerCode {
		if (code === "missing_anchor") return "missing_anchor";
		if (code === "ambiguous_anchor") return "ambiguous_anchor";
		if (code === "unsafe_target") return "unsafe_target";
		if (code === "wrong_page" || code === "stale_page") return "unsafe_page_state";
		return "unverified_state";
	}

	private async inspectTrusted(operation: string): Promise<EkuaibaoTrustedPageState | undefined> {
		if (!this.browser.runEkuaibaoTrustedCommand) return undefined;
		this.observeDocumentUrl();
		await this.beforeBrowserAction("trusted", operation);
		const result = await this.browser.runEkuaibaoTrustedCommand({
			op: "inspect",
			contractVersion: EKUAIBAO_TRUSTED_CONTRACT_VERSION,
		});
		if (!result.ok) {
			this.blocker(this.trustedBlockerCode(result.code), operation, result.message, [result.code]);
		}
		this.observeTrustedDocumentToken(result.state.pageToken);
		if (this.lastVerifiedTrustedDigest && result.state.digest !== this.lastVerifiedTrustedDigest) {
			this.verificationValid = false;
		}
		this.lastTrustedState = result.state;
		return result.state;
	}

	private async runTrustedMutation(
		operation: string,
		command: Exclude<EkuaibaoTrustedCommand, { op: "inspect" }>,
	): Promise<EkuaibaoTrustedPageState> {
		const run = this.browser.runEkuaibaoTrustedCommand?.bind(this.browser);
		if (!run) this.blocker("unverified_state", operation, "当前客户端没有可信合思命令运行时");
		this.invalidateDraftSaveEvidence();
		await this.beforeBrowserAction("trusted", operation);
		const result = await run(command);
		if (!result.ok) {
			this.blocker(this.trustedBlockerCode(result.code), operation, result.message, [result.code]);
		}
		this.observeTrustedDocumentToken(result.state.pageToken);
		this.lastTrustedState = result.state;
		return result.state;
	}

	private trustedOverlayForScope(scope: EkuaibaoTrustedScope): EkuaibaoTrustedPageState["overlay"] {
		if (scope.kind === "main") return "none";
		if (scope.kind === "application-dialog") return "application-dialog";
		if (scope.kind === "application-details") return "application-details";
		if (scope.kind === "detail-picker") return "detail-picker";
		if (scope.kind === "detail-drawer") return "detail-drawer";
		if (scope.kind === "invoice-menu") return "invoice-menu";
		if (scope.kind === "invoice-dialog") return "invoice-dialog";
		return "invoice-results";
	}

	private async trustedBaseline(operation: string, scope: EkuaibaoTrustedScope): Promise<EkuaibaoTrustedPageState> {
		const state = await this.inspectTrusted(operation);
		const expectedOverlay = this.trustedOverlayForScope(scope);
		if (!state || state.overlay !== expectedOverlay) {
			this.blocker(
				"unverified_state",
				operation,
				`可信命令要求 ${scope.kind}，当前结构化页面层为 ${state?.overlay ?? "不可读"}`,
			);
		}
		return state;
	}

	private async trustedClick(
		operation: string,
		control: EkuaibaoTrustedControl,
		scope: EkuaibaoTrustedScope,
		extra: { detailKind?: "transport" | "hotel" | "allowance"; evidence?: string[] } = {},
	): Promise<EkuaibaoTrustedPageState> {
		const baseline = await this.trustedBaseline(operation, scope);
		return this.runTrustedMutation(operation, {
			op: "click",
			contractVersion: EKUAIBAO_TRUSTED_CONTRACT_VERSION,
			pageToken: baseline.pageToken,
			expectedDigest: baseline.digest,
			control,
			scope,
			...extra,
		});
	}

	private async trustedType(
		operation: string,
		field: EkuaibaoTrustedField,
		scope: EkuaibaoTrustedScope,
		value: string,
		commit = true,
	): Promise<EkuaibaoTrustedPageState> {
		const baseline = await this.trustedBaseline(operation, scope);
		return this.runTrustedMutation(operation, {
			op: "type",
			contractVersion: EKUAIBAO_TRUSTED_CONTRACT_VERSION,
			pageToken: baseline.pageToken,
			expectedDigest: baseline.digest,
			field,
			scope,
			value,
			commit,
		});
	}

	private async trustedHover(
		operation: string,
		scope: Extract<EkuaibaoTrustedScope, { kind: "detail-drawer" }>,
	): Promise<EkuaibaoTrustedPageState> {
		const baseline = await this.trustedBaseline(operation, scope);
		return this.runTrustedMutation(operation, {
			op: "hover",
			contractVersion: EKUAIBAO_TRUSTED_CONTRACT_VERSION,
			pageToken: baseline.pageToken,
			expectedDigest: baseline.digest,
			control: "show-invoice-menu",
			scope,
		});
	}

	private async trustedSelect(
		operation: string,
		optionKind: EkuaibaoTrustedOptionKind,
		scope: EkuaibaoTrustedScope,
		value: string,
		evidence: string[] = [],
	): Promise<EkuaibaoTrustedPageState> {
		const baseline = await this.trustedBaseline(operation, scope);
		return this.runTrustedMutation(operation, {
			op: "select-exact",
			contractVersion: EKUAIBAO_TRUSTED_CONTRACT_VERSION,
			pageToken: baseline.pageToken,
			expectedDigest: baseline.digest,
			optionKind,
			scope,
			value,
			evidence,
		});
	}

	private async trustedUpload(
		operation: string,
		slot: EkuaibaoTrustedUploadSlot,
		scope: Extract<EkuaibaoTrustedScope, { kind: "invoice-dialog" | "detail-drawer" }>,
		paths: string[],
	): Promise<EkuaibaoTrustedPageState> {
		const baseline = await this.trustedBaseline(operation, scope);
		const files = readAgentBrowserUploadFiles(this.cwd, paths);
		this.throwIfAborted(operation);
		return this.runTrustedMutation(operation, {
			op: "upload",
			contractVersion: EKUAIBAO_TRUSTED_CONTRACT_VERSION,
			pageToken: baseline.pageToken,
			expectedDigest: baseline.digest,
			slot,
			scope,
			files,
		});
	}

	private requireUnique(
		snapshot: string,
		predicate: (element: SnapshotElement) => boolean,
		operation: string,
		requirement: string,
	): SnapshotElement {
		const matches = parseSnapshotElements(snapshot).filter(predicate);
		if (matches.length === 0) this.blocker("missing_anchor", operation, requirement);
		if (matches.length > 1) {
			this.blocker(
				"ambiguous_anchor",
				operation,
				`${requirement}；当前匹配到 ${matches.length} 个元素`,
				matches.map((element) => element.raw),
			);
		}
		return matches[0];
	}

	private sourceFactsFromVerified(candidate: TravelApplicationCandidate): ParsedApplicationSourceFacts | undefined {
		const verified = this.verifiedApplicationFacts;
		if (!verified || verified.application.id !== candidate.id || verified.application.title !== candidate.title) {
			return undefined;
		}
		return {
			reason: verified.application.reason,
			expenseNature: verified.application.expenseNature,
			source: verified.source,
			missing: [],
			ambiguous: [],
		};
	}

	private async inspectApplicationSourceFacts(
		candidate: TravelApplicationCandidate,
		candidateSnapshot: string,
	): Promise<ParsedApplicationSourceFacts> {
		if (this.browser.runEkuaibaoTrustedCommand) {
			const operation = "核对关联申请详情";
			let state = await this.inspectTrusted(operation);
			if (!state || state.overlay !== "application-dialog") {
				this.blocker("unverified_state", operation, "可信页面当前不在唯一关联申请弹窗中");
			}
			state = await this.runTrustedMutation(operation, {
				op: "select-exact",
				contractVersion: EKUAIBAO_TRUSTED_CONTRACT_VERSION,
				pageToken: state.pageToken,
				expectedDigest: state.digest,
				optionKind: "application",
				scope: { kind: "application-dialog" },
				value: candidate.id,
				evidence: [candidate.title],
			});
			if (state.overlay !== "application-dialog") {
				this.blocker("unverified_state", operation, "选择候选后关联申请弹窗状态发生意外变化");
			}
			state = await this.runTrustedMutation(operation, {
				op: "click",
				contractVersion: EKUAIBAO_TRUSTED_CONTRACT_VERSION,
				pageToken: state.pageToken,
				expectedDigest: state.digest,
				control: "open-application-details",
				scope: { kind: "application-dialog" },
			});
			if (state.overlay !== "application-details") {
				this.blocker("unverified_state", operation, "可信详情打开命令未进入唯一申请详情层");
			}
			const source = state.applicationSource;
			const validationErrors: string[] = [];
			const sourceId = typeof source?.id === "string" ? source.id.trim() : "";
			const sourceTitle = typeof source?.title === "string" ? source.title.trim() : "";
			const sourceReason = typeof source?.reason === "string" ? source.reason.trim() : "";
			const sourceNature =
				source?.expenseNature === "部门费用" || source?.expenseNature === "项目费用"
					? source.expenseNature
					: undefined;
			if (!sourceId) validationErrors.push("详情缺少申请编号");
			else if (sourceId.toUpperCase() !== candidate.id.trim().toUpperCase()) {
				validationErrors.push(`详情申请编号 ${sourceId} 与候选 ${candidate.id} 不一致`);
			}
			if (!sourceTitle) validationErrors.push("详情缺少申请标题");
			else if (normalizeText(sourceTitle) !== normalizeText(candidate.title)) {
				validationErrors.push(`详情申请标题 ${sourceTitle} 与候选 ${candidate.title} 不一致`);
			}
			if (!sourceReason) validationErrors.push("详情缺少显式申请事由");
			if (!sourceNature) validationErrors.push("详情费用性质不在部门费用/项目费用白名单内");
			state = await this.runTrustedMutation("关闭关联申请详情", {
				op: "click",
				contractVersion: EKUAIBAO_TRUSTED_CONTRACT_VERSION,
				pageToken: state.pageToken,
				expectedDigest: state.digest,
				control: "close-application-details",
				scope: { kind: "application-details" },
			});
			if (state.overlay !== "application-dialog") {
				this.blocker("unverified_state", "关闭关联申请详情", "关闭详情后未返回唯一关联申请弹窗");
			}
			if (validationErrors.length > 0 || !sourceReason || !sourceNature) {
				this.blocker("unsafe_page_state", operation, "申请详情事实与当前唯一候选不一致", validationErrors);
			}
			return {
				reason: sourceReason,
				expenseNature: sourceNature,
				source: "details",
				missing: [],
				ambiguous: [],
			};
		}
		const cached = this.sourceFactsFromVerified(candidate);
		if (cached) return cached;
		const inline = parseApplicationSourceFacts(candidate.evidence, candidate, "candidate");
		if (inline.missing.length === 0 && inline.ambiguous.length === 0) return inline;
		const details = parseSnapshotElements(candidateSnapshot).filter(
			(element) =>
				/^(?:查看)?详情$/.test(normalizeText(element.text)) &&
				["button", "a", "div", "span"].includes(element.descriptor.split("/")[0]),
		);
		if (details.length !== 1) return inline;
		await this.click("核对关联申请详情", {
			ref: details[0].ref,
			scopeTexts: [candidate.id, candidate.title],
		});
		await this.pause();
		const detailSnapshot = await this.snapshot([candidate.id, candidate.title, "费用性质"]);
		const parsed = parseApplicationSourceFacts(detailSnapshot, candidate, "details");
		const close = this.requireUnique(
			detailSnapshot,
			(element) =>
				element.descriptor.startsWith("button") &&
				(["关闭", "取消"].includes(normalizeText(element.text)) || /OutlinedTipsClose/.test(element.text)),
			"核对关联申请详情",
			"申请详情必须有唯一关闭按钮",
		);
		await this.click("关闭关联申请详情", {
			ref: close.ref,
			scopeTexts: [candidate.id, candidate.title, "费用性质"],
		});
		await this.pause();
		return parsed;
	}

	private safeTarget(operation: string, target: AgentBrowserTarget): void {
		const encoded = JSON.stringify(target);
		if (DANGEROUS_TARGET.test(encoded)) {
			this.blocker("unsafe_target", operation, `安全策略拒绝目标：${encoded}`);
		}
	}

	private async click(operation: string, target: AgentBrowserTarget): Promise<void> {
		if (this.browser.runEkuaibaoTrustedCommand) {
			this.blocker("unsafe_target", operation, "新客户端禁止合思写操作回退到 generic click/ref/selector");
		}
		this.safeTarget(operation, target);
		if (target.selector !== `[data-testid="${TEST_IDS.saveDraft}"]`) this.invalidateDraftSaveEvidence();
		await this.beforeBrowserAction("click", operation);
		await this.browser.click(target);
		this.throwIfAborted(operation);
	}

	private async hover(operation: string, target: AgentBrowserTarget): Promise<void> {
		if (this.browser.runEkuaibaoTrustedCommand) {
			this.blocker("unsafe_target", operation, "新客户端禁止合思写操作回退到 generic hover/ref");
		}
		this.safeTarget(operation, target);
		this.invalidateDraftSaveEvidence();
		await this.beforeBrowserAction("hover", operation);
		await this.browser.hover(target);
		this.throwIfAborted(operation);
	}

	private async type(
		operation: string,
		target: AgentBrowserTarget,
		value: string,
		pressEnter = false,
		commit = true,
	): Promise<void> {
		if (this.browser.runEkuaibaoTrustedCommand) {
			this.blocker("unsafe_target", operation, "新客户端禁止合思写操作回退到 generic type/ref");
		}
		this.safeTarget(operation, target);
		this.invalidateDraftSaveEvidence();
		await this.beforeBrowserAction("type", operation);
		await this.browser.type(target, value, pressEnter, commit);
		this.throwIfAborted(operation);
	}

	private async upload(operation: string, paths: string[], target: AgentBrowserTarget): Promise<string> {
		if (this.browser.runEkuaibaoTrustedCommand) {
			this.blocker("unsafe_target", operation, "新客户端禁止合思附件回退到 generic upload/ref");
		}
		this.safeTarget(operation, target);
		this.invalidateDraftSaveEvidence();
		if (!isAllowedEkuaibaoUrl(this.browser.state().url)) {
			this.blocker(
				"unsafe_page_state",
				operation,
				"当前页面已离开 https://app.ekuaibao.com，为避免本地附件外泄已拒绝上传",
			);
		}
		await this.beforeBrowserAction("upload", operation);
		const files = readAgentBrowserUploadFiles(this.cwd, paths);
		this.throwIfAborted(operation);
		const output = await this.browser.uploadFiles(files, target, EKUAIBAO_ALLOWED_ORIGIN);
		this.throwIfAborted(operation);
		return output;
	}

	private assertExpected(): TravelDraftExpected {
		if (!this.expected) this.blocker("unverified_state", "读取差旅草稿", "驱动器尚未收到 TravelDraftExpected");
		return this.expected;
	}

	private field(
		snapshot: string,
		label: string,
		operation: string,
		options: { placeholder?: string; testId?: string; editable?: boolean; allowUnlabeled?: boolean } = {},
	): SnapshotElement {
		const elements = parseSnapshotElements(snapshot);
		const shapeMatches = (element: SnapshotElement) => {
			if (options.testId && testId(element) !== options.testId) return false;
			if (options.placeholder && placeholder(element) !== options.placeholder) return false;
			if (options.editable && !isEditableElement(element)) return false;
			return element.descriptor.split("/")[0] !== "label";
		};
		const labeled = elements.filter((element) => fieldLabel(element) === label && shapeMatches(element));
		if (labeled.length === 1) return labeled[0];
		if (labeled.length > 1) {
			this.blocker("ambiguous_anchor", operation, `字段“${label}”出现多个带准确 label 的可操作 ref`, labeled.map((item) => item.raw));
		}
		if (!options.allowUnlabeled && !options.placeholder && !options.testId) {
			this.blocker("missing_anchor", operation, `字段“${label}”必须有唯一可操作 ref`);
		}
		if (options.allowUnlabeled) {
			const anchors = elements
				.map((element, index) => ({ element, index }))
				.filter(
					({ element }) =>
						element.descriptor.split("/")[0] === "label" && normalizeText(element.text) === normalizeText(label),
				);
			if (anchors.length === 1) {
				const window: SnapshotElement[] = [];
				for (const element of elements.slice(anchors[0].index + 1)) {
					if (element.descriptor.split("/")[0] === "label") break;
					if (fieldLabel(element) && fieldLabel(element) !== label) break;
					if (shapeMatches(element)) window.push(element);
				}
				if (window.length === 1) return window[0];
				this.blocker(
					window.length === 0 ? "missing_anchor" : "ambiguous_anchor",
					operation,
					`字段“${label}”必须在对应 label 与下一个 label 之间有唯一可编辑控件`,
					window.map((item) => item.raw),
				);
			}
		}
		const unlabeled = elements.filter((element) => !fieldLabel(element) && shapeMatches(element));
		if (unlabeled.length === 1) return unlabeled[0];
		this.blocker(
			unlabeled.length === 0 ? "missing_anchor" : "ambiguous_anchor",
			operation,
			`字段“${label}”必须有唯一可操作 ref`,
			unlabeled.map((item) => item.raw),
		);
	}

	private async selectExactOption(
		operation: string,
		fieldLabelText: string,
		query: string,
		optionPredicate: (element: SnapshotElement) => boolean,
		scopeTexts: string[],
	): Promise<void> {
		if (this.browser.runEkuaibaoTrustedCommand) {
			const fieldMap: Partial<Record<string, EkuaibaoTrustedField>> = {
				费用性质: "expense-nature",
				申请人部门: "applicant-department",
				费用所属部门: "expense-department",
				出发城市: "departure-city",
				到达城市: "arrival-city",
				乘坐火车席别: "seat-class",
				补助类型: "allowance-type",
			};
			const optionMap: Partial<Record<string, EkuaibaoTrustedOptionKind>> = {
				费用性质: "expense-nature",
				申请人部门: "department",
				费用所属部门: "department",
				出发城市: "city",
				到达城市: "city",
				乘坐火车席别: "seat-class",
				补助类型: "allowance-type",
			};
			const field = fieldMap[fieldLabelText];
			const optionKind = optionMap[fieldLabelText];
			if (!field || !optionKind) this.blocker("unverified_state", operation, `字段 ${fieldLabelText} 没有可信选择契约`);
			const feeType = Object.values(FEE_TYPES).find((item) => scopeTexts.includes(item));
			const scope: EkuaibaoTrustedScope = feeType
				? { kind: "detail-drawer", detailKind: trustedDetailKind(feeType) }
				: { kind: "main" };
			await this.trustedType(operation, field, scope, query, false);
			await this.pause();
			const value = optionKind === "department" ? TRAVEL_DRAFT_DEPARTMENT : query;
			const selected = await this.trustedSelect(
				operation,
				optionKind,
				scope,
				value,
				optionKind === "department" ? [departmentLeaf()] : [],
			);
			const selectedField = selected.fields[field];
			if (!selectedField?.present || selectedField.ambiguous || !selectedField.value) {
				this.blocker("unverified_state", operation, `可信选择后未结构化回读唯一 ${fieldLabelText}`);
			}
			const verified =
				optionKind === "department"
					? departmentPathMatches(selectedField.value) || departmentLeafMatches(selectedField.value)
					: optionKind === "city"
						? cityLevelPathMatches(selectedField.value, query)
						: containsNormalized(selectedField.value, query);
			if (!verified) this.blocker("unverified_state", operation, `可信选择后 ${fieldLabelText} 回读值不匹配 ${query}`);
			await this.pause();
			return;
		}
		const before = await this.snapshot(scopeTexts);
		const input = this.field(before, fieldLabelText, operation, { editable: true, allowUnlabeled: true });
		await this.type(operation, { ref: input.ref, scopeTexts }, query, false, false);
		await this.pause();
		const options = await this.snapshot([query]);
		const choice = this.requireUnique(options, optionPredicate, operation, `“${query}”必须只有一个精确候选`);
		await this.click(operation, { ref: choice.ref, scopeTexts: [query] });
		await this.pause();
	}

	private async ensureCity(label: "出发城市" | "到达城市", city: string, feeType: string): Promise<void> {
		const scope = detailDrawerScope(feeType, label);
		const current = await this.snapshot(scope);
		if (drawerCityLevelEvidence(current, label, city)) return;
		await this.selectExactOption(
			`填写${label}`,
			label,
			city,
			(element) =>
				testId(element) === "entity-profile" &&
				new RegExp(`^城市\\s+${city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+`).test(element.text) &&
				cityLevelPathMatches(element.text, city),
			scope,
		);
		const selectedSnapshot = await this.snapshot(scope);
		if (!drawerCityLevelEvidence(selectedSnapshot, label, city)) {
			this.blocker(
				"unverified_state",
				`填写${label}`,
				`必须回读城市级路径“${city}”，末级不能是区县/市区`,
				parseSnapshotElements(selectedSnapshot).map((element) => element.raw),
			);
		}
	}

	private paymentValueEvidence(value: string, domain: PaymentVerificationDomain): boolean {
		if (paymentAccountEvidence(value)) return true;
		return this.verifiedPaymentDomains.has(domain) && paymentNameOnlyEvidence(value);
	}

	private async ensureRecipient(
		label: "支付信息" | "费用报销人",
		scopeTexts: string[],
		paymentDomain?: PaymentVerificationDomain,
	): Promise<void> {
		if (label === "支付信息" && !paymentDomain) {
			this.blocker("unverified_state", `填写${label}`, "支付信息缺少主表或唯一业务明细凭证域");
		}
		if (this.browser.runEkuaibaoTrustedCommand) {
			const feeType = Object.values(FEE_TYPES).find((item) => scopeTexts.includes(item));
			const scope: EkuaibaoTrustedScope = feeType
				? { kind: "detail-drawer", detailKind: trustedDetailKind(feeType) }
				: { kind: "main" };
			const field: EkuaibaoTrustedField =
				label === "费用报销人" ? "expense-reporter" : scope.kind === "main" ? "main-payment-recipient" : "payment-recipient";
			const current = await this.trustedBaseline(`填写${label}`, scope);
			const currentField = current.fields[field];
			if (currentField?.present && !currentField.ambiguous && currentField.value?.includes(TRAVEL_DRAFT_CURRENT_USER)) {
				if (
					label === "费用报销人" ||
					(paymentDomain && this.paymentValueEvidence(currentField.value, paymentDomain))
				) {
					return;
				}
			}
			if (!currentField?.present || currentField.ambiguous) {
				this.blocker("unverified_state", `填写${label}`, `可信页面没有唯一 ${label} 字段`);
			}
			const control: EkuaibaoTrustedControl =
				label === "费用报销人"
					? "open-expense-reporter"
					: scope.kind === "main"
						? "open-main-payment-recipient"
						: "open-payment-recipient";
			await this.trustedClick(`填写${label}`, control, scope);
			await this.pause();
			const selected = await this.trustedSelect(
				`填写${label}`,
				label === "费用报销人" ? "expense-reporter" : "payment-recipient",
				scope,
				TRAVEL_DRAFT_CURRENT_USER,
				label === "支付信息" ? [label, "个人账户"] : [label],
			);
			await this.pause();
			const verified = selected.fields[field];
			const selectedPaymentVerified =
				label !== "支付信息" ||
				Boolean(
					verified?.value &&
					(paymentAccountEvidence(verified.value) || paymentNameOnlyEvidence(verified.value)),
				);
			if (!verified?.present || verified.ambiguous || !verified.value?.includes(TRAVEL_DRAFT_CURRENT_USER) || !selectedPaymentVerified) {
				this.blocker("unverified_state", `填写${label}`, `可信选择后未结构化回读唯一 ${label}`);
			}
			if (label === "支付信息" && paymentDomain) this.verifiedPaymentDomains.add(paymentDomain);
			return;
		}
		const current = await this.snapshot(scopeTexts);
		const currentElements = parseSnapshotElements(current);
		const values = currentElements.filter((element) => {
			if (fieldLabel(element) !== label || isEmptyText(element.text)) return false;
			return !["label", "span", "svg", "img"].includes(element.descriptor.split("/")[0]);
		});
		if (drawerRecipientEvidence(current, label, Boolean(paymentDomain && this.verifiedPaymentDomains.has(paymentDomain)))) {
			return;
		}
		if (values.length !== 1) {
			this.blocker(
				values.length === 0 ? "missing_anchor" : "ambiguous_anchor",
				`填写${label}`,
				`当前范围必须只有一个“${label}”入口`,
				values.map((element) => element.raw),
			);
		}
		await this.click(`填写${label}`, { ref: values[0].ref, scopeTexts });
		await this.pause();
		const picker = await this.snapshot([TRAVEL_DRAFT_CURRENT_USER]);
		const pickerProvesPersonalAccount = label === "支付信息" && paymentPickerScopeEvidence(picker);
		const choice = this.requireUnique(
			picker,
			(element) =>
				element.text.includes(TRAVEL_DRAFT_CURRENT_USER) &&
				(label === "支付信息"
					? paymentAccountEvidence(element.text) ||
						(paymentNameOnlyEvidence(element.text) && pickerProvesPersonalAccount)
					: !isEmptyText(element.text)) &&
				fieldLabel(element) !== "提交人" &&
				fieldLabel(element) !== "是否为多收款人" &&
				(element.descriptor.split("/").includes("option") || testId(element) === "entity-profile"),
			`填写${label}`,
			`收款人“${TRAVEL_DRAFT_CURRENT_USER}”必须在当前支付信息选择器中唯一出现`,
		);
		await this.click(`填写${label}`, { ref: choice.ref, scopeTexts: [TRAVEL_DRAFT_CURRENT_USER] });
		await this.pause();
		const selected = await this.snapshot(scopeTexts);
		if (!drawerRecipientEvidence(selected, label, label === "支付信息")) {
			this.blocker(
				"unverified_state",
				`填写${label}`,
				label === "支付信息"
					? `选择后未在“支付信息”字段回读到“${TRAVEL_DRAFT_CURRENT_USER}”及个人账户/银行账号证据`
					: `选择后未在“费用报销人”字段回读到“${TRAVEL_DRAFT_CURRENT_USER}”`,
				recipientFieldValues(selected, label),
			);
		}
		if (label === "支付信息" && paymentDomain) this.verifiedPaymentDomains.add(paymentDomain);
	}

	private async ensureStation(): Promise<void> {
		if (this.browser.runEkuaibaoTrustedCommand) {
			const scope = { kind: "main" } as const;
			const current = await this.trustedBaseline("填写驻地", scope);
			const field = current.fields.station;
			if (
				field?.present &&
				!field.ambiguous &&
				field.value &&
				containsNormalized(field.value, "江苏省") &&
				cityLevelPathMatches(field.value, "南京")
			) {
				return;
			}
			if (!field?.present || field.ambiguous) this.blocker("unverified_state", "填写驻地", "可信页面没有唯一驻地字段");
			await this.trustedType("填写驻地", "station", scope, "江苏省南京", false);
			await this.pause();
			const selected = await this.trustedSelect(
				"填写驻地",
				"station",
				scope,
				"中国 / 江苏省 / 南京",
				["城市", "南京"],
			);
			const value = selected.fields.station?.value;
			if (!value || !containsNormalized(value, "江苏省") || !cityLevelPathMatches(value, "南京")) {
				this.blocker("unverified_state", "填写驻地", "可信选择后未结构化回读江苏省南京城市级驻地");
			}
			return;
		}
		const current = await this.snapshot(["驻地"]);
		if (
			scopedFieldValues(parseSnapshotElements(current), "驻地").some(
				(value) => containsNormalized(value, "江苏省") && cityLevelPathMatches(value, "南京"),
			)
		) {
			return;
		}
		const input = this.field(current, "驻地", "填写驻地", { editable: true, allowUnlabeled: true });
		await this.type("填写驻地", { ref: input.ref, scopeTexts: ["驻地"] }, "江苏省南京", false, false);
		await this.pause();
		const results = await this.snapshot(["中国 / 江苏省 / 南京"]);
		const city = this.requireUnique(
			results,
			(element) =>
				testId(element) === "entity-profile" &&
				/^城市\s+南京\s+中国\s*\/\s*江苏省\s*\/\s*南京$/.test(element.text) &&
				!element.text.includes("区/县"),
			"填写驻地",
			"驻地搜索结果必须唯一命中城市“南京 中国 / 江苏省 / 南京”，不能选择区县或市区",
		);
		await this.click("填写驻地", { ref: city.ref, scopeTexts: ["中国 / 江苏省 / 南京"] });
		await this.pause();
	}

	private async ensureDimension(label: "费用性质" | "申请人部门" | "费用所属部门", value: string): Promise<void> {
		if (this.browser.runEkuaibaoTrustedCommand) {
			const field: EkuaibaoTrustedField =
				label === "费用性质"
					? "expense-nature"
					: label === "申请人部门"
						? "applicant-department"
						: "expense-department";
			const scope = { kind: "main" } as const;
			const current = await this.trustedBaseline(`核对${label}`, scope);
			const state = current.fields[field];
			if (!state?.present || state.ambiguous) this.blocker("unverified_state", `核对${label}`, `可信页面没有唯一 ${label} 字段`);
			const currentValue = state.value?.trim() ?? "";
			if (label === "费用性质" && normalizeText(currentValue) === normalizeText(value)) return;
			if (label !== "费用性质") {
				if (departmentPathMatches(currentValue) || (departmentLeafMatches(currentValue) && this.verifiedDepartments.has(label))) {
					this.verifiedDepartments.add(label);
					return;
				}
				if (currentValue) {
					this.blocker("unsafe_page_state", `核对${label}`, `当前 ${label} 未证明属于完整组织路径 ${TRAVEL_DRAFT_DEPARTMENT}`, [
						currentValue,
					]);
				}
			}
			await this.selectExactOption(
				`填写${label}`,
				label,
				label === "费用性质" ? value : departmentLeaf(),
				() => false,
				[label],
			);
			const selected = await this.trustedBaseline(`回读${label}`, scope);
			const selectedValue = selected.fields[field]?.value ?? "";
			if (
				(label === "费用性质" && normalizeText(selectedValue) !== normalizeText(value)) ||
				(label !== "费用性质" && !departmentPathMatches(selectedValue) && !departmentLeafMatches(selectedValue))
			) {
				this.blocker("unverified_state", `填写${label}`, `可信选择后未结构化回读 ${label}`);
			}
			if (label !== "费用性质") this.verifiedDepartments.add(label);
			return;
		}
		const current = await this.snapshot([label]);
		const currentValues = scopedFieldValues(parseSnapshotElements(current), label);
		if (label !== "费用性质") {
			if (currentValues.length === 1) {
				if (departmentPathMatches(currentValues[0])) {
					this.verifiedDepartments.add(label);
					return;
				}
				if (departmentLeafMatches(currentValues[0]) && this.verifiedDepartments.has(label)) return;
			}
			if (currentValues.length > 0) {
				this.blocker(
					"unsafe_page_state",
					`核对${label}`,
					`当前${label}不是完整路径“${TRAVEL_DRAFT_DEPARTMENT}”；同名末级部门不能替代完整组织路径`,
					currentValues,
				);
			}
		} else if (currentValues.some((fieldValue) => normalizeText(fieldValue) === normalizeText(value))) {
			return;
		}
		const query = label === "费用性质" ? value : departmentLeaf();
		await this.selectExactOption(
			`填写${label}`,
			label,
			query,
			(element) =>
				(label === "费用性质"
					? normalizeText(element.text) === normalizeText(value)
					: departmentPathMatches(element.text)) &&
				fieldLabel(element) !== label &&
				(element.descriptor.includes("option") || testId(element) === "entity-profile"),
			[label],
		);
		if (label !== "费用性质") {
			const selected = scopedFieldValues(parseSnapshotElements(await this.snapshot([label])), label);
			if (selected.length !== 1 || (!departmentPathMatches(selected[0]) && !departmentLeafMatches(selected[0]))) {
				this.blocker(
					"unverified_state",
					`填写${label}`,
					`选择后必须回读完整组织路径“${TRAVEL_DRAFT_DEPARTMENT}”`,
					selected,
				);
			}
			this.verifiedDepartments.add(label);
		}
	}

	private async ensureTextField(label: string, testIdValue: string, value: string): Promise<void> {
		if (this.browser.runEkuaibaoTrustedCommand) {
			if (label !== "报销说明" || testIdValue !== TEST_IDS.description) {
				this.blocker("unverified_state", `填写${label}`, "该文本字段没有可信写入契约");
			}
			const scope = { kind: "main" } as const;
			const current = await this.trustedBaseline(`填写${label}`, scope);
			const field = current.fields.description;
			if (!field?.present || field.ambiguous) this.blocker("unverified_state", `填写${label}`, "可信页面没有唯一报销说明字段");
			if (field.value === value) return;
			const updated = await this.trustedType(`填写${label}`, "description", scope, value, true);
			if (updated.fields.description?.value !== value) {
				this.blocker("unverified_state", `填写${label}`, "可信输入后未结构化回读完整报销说明");
			}
			await this.pause();
			return;
		}
		const snapshot = await this.snapshot([label]);
		const field = this.field(snapshot, label, `填写${label}`, { testId: testIdValue, editable: true });
		if (field.text === value) return;
		await this.type(`填写${label}`, { ref: field.ref, scopeTexts: [label] }, value, false, true);
		await this.pause();
	}

	private async ensureDate(label: string, placeholderValue: "开始日期" | "结束日期", value: string, scope: string[]) {
		if (this.browser.runEkuaibaoTrustedCommand) {
			const feeType = Object.values(FEE_TYPES).find((item) => scope.includes(item));
			if (!feeType) this.blocker("unverified_state", `填写${label}${placeholderValue}`, "明细日期缺少可信费用类型范围");
			const trustedScope = { kind: "detail-drawer", detailKind: trustedDetailKind(feeType) } as const;
			const field: EkuaibaoTrustedField = placeholderValue === "开始日期" ? "detail-start-date" : "detail-end-date";
			const current = await this.trustedBaseline(`填写${label}${placeholderValue}`, trustedScope);
			const currentField = current.fields[field];
			if (!currentField?.present || currentField.ambiguous) {
				this.blocker("unverified_state", `填写${label}${placeholderValue}`, "可信页面没有唯一明细日期字段");
			}
			if (currentField.value === value) return;
			const updated = await this.trustedType(`填写${label}${placeholderValue}`, field, trustedScope, value, true);
			if (updated.fields[field]?.value !== value) {
				this.blocker("unverified_state", `填写${label}${placeholderValue}`, "可信输入后未结构化回读明细日期");
			}
			await this.pause();
			return;
		}
		const snapshot = await this.snapshot(scope);
		const field = this.field(snapshot, label, `填写${label}${placeholderValue}`, {
			placeholder: placeholderValue,
			editable: true,
		});
		if (field.text === value) return;
		await this.type(`填写${label}${placeholderValue}`, { ref: field.ref, scopeTexts: scope }, value, false, true);
		await this.pause();
	}

	private async openDetail(feeType: string): Promise<void> {
		if (this.browser.runEkuaibaoTrustedCommand) {
			const mainScope = { kind: "main" } as const;
			const main = await this.trustedBaseline("添加费用明细", mainScope);
			const currentCount = main.detailCount;
			if (currentCount === undefined) {
				this.blocker("unverified_state", "添加费用明细", "可信主表未结构化返回唯一费用明细数");
			}
			if (currentCount !== this.verifiedDetails.size) {
				this.blocker(
					"existing_row_unverifiable",
					"添加费用明细",
					`主表已有 ${currentCount} 条费用明细，但本轮只完整复核了 ${this.verifiedDetails.size} 条`,
				);
			}
			this.detailCountBeforeOpen = currentCount;
			const picker = await this.trustedClick("添加费用明细", "add-detail", mainScope);
			if (picker.overlay !== "detail-picker") {
				this.blocker("unverified_state", "添加费用明细", "可信添加按钮未进入费用类型选择层");
			}
			const pickerScope = { kind: "detail-picker" } as const;
			await this.trustedType("选择费用类型", "fee-type-search", pickerScope, feeType, false);
			await this.pause();
			const selected = await this.trustedSelect("选择费用类型", "fee-type", pickerScope, feeType);
			if (selected.overlay !== "detail-drawer") {
				this.blocker("unverified_state", "选择费用类型", `可信选择后未进入 ${feeType} 明细抽屉`);
			}
			const save = selected.controls["save-detail"];
			if (!save?.present || save.ambiguous || save.disabled) {
				this.blocker("unverified_state", "选择费用类型", "明细抽屉没有唯一可用的可信保存控件");
			}
			await this.pause();
			return;
		}
		const main = await this.snapshot();
		const currentCount = parseDetailCount(main);
		if (currentCount === undefined) {
			this.blocker(
				"unverified_state",
				"添加费用明细",
				"新增前无法从主表唯一读取费用明细数，不能证明不会产生重复行",
			);
		}
		if (currentCount !== this.verifiedDetails.size) {
			this.blocker(
				"existing_row_unverifiable",
				"添加费用明细",
				`主表已有 ${currentCount} 条费用明细，但本轮只完整复核了 ${this.verifiedDetails.size} 条；为避免在旧失败行旁重复新增已停止`,
			);
		}
		this.detailCountBeforeOpen = currentCount;
		await this.click("添加费用明细", {
			selector: `[data-testid="${TEST_IDS.addDetail}"]`,
			scopeTexts: ["费用明细"],
		});
		await this.pause();
		const picker = await this.snapshot(["添加明细", "费用类型"]);
		const feeTypeInput = this.field(picker, "费用类型", "选择费用类型", {
			editable: true,
			allowUnlabeled: true,
		});
		await this.type(
			"选择费用类型",
			{ ref: feeTypeInput.ref, scopeTexts: ["添加明细", "费用类型"] },
			feeType,
			false,
			false,
		);
		await this.pause();
		const results = await this.snapshot(["添加明细", feeType]);
		const option = this.requireUnique(
			results,
			(element) => testId(element) === TEST_IDS.feeType && element.text.startsWith(feeType),
			"选择费用类型",
			`data-testid=${TEST_IDS.feeType} 必须唯一匹配“${feeType}”`,
		);
		await this.click("选择费用类型", { ref: option.ref, scopeTexts: ["添加明细", "费用类型"] });
		await this.pause();
		const selected = await this.snapshot(["添加明细", feeType]);
		if (!selected.includes(feeType) || !selected.includes(`testid=${TEST_IDS.saveDetail}`)) {
			this.blocker("unverified_state", "选择费用类型", `未回读到“${feeType}”明细抽屉及保存锚点`);
		}
	}

	private async waitForInvoiceRecognition(): Promise<string> {
		const scope = ["通过智能识票识别出", "与该消费绑定"];
		const interval = Math.max(1000, this.waitMilliseconds);
		const attempts = Math.max(1, Math.ceil(30_000 / interval));
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			const current = await this.snapshot(scope);
			const count = /通过智能识票识别出\s*(\d+)\s*张发票/.exec(current);
			if (count?.[1] === "1") return current;
			if (count && count[1] !== "1") {
				this.blocker("invoice_dialog_contract", "选择识别发票", `智能识票结果为 ${count[1]} 张，必须恰好为 1 张`);
			}
			if (/(?:识别失败|识别异常|未识别到发票|识别出\s*0\s*张发票)/.test(current)) {
				this.blocker("invoice_dialog_contract", "选择识别发票", "智能识票明确失败或未识别到发票");
			}
			if (attempt + 1 < attempts) await this.pause(interval);
		}
		this.blocker("invoice_dialog_contract", "选择识别发票", "等待智能识票结果超过 30 秒，未勾选或绑定任何发票");
	}

	private async bindInvoice(row: TravelDraftTransportExpected | TravelDraftHotelExpected, feeType: string): Promise<void> {
		const invoiceScope = detailDrawerScope(feeType, "上传发票");
		// The caller's row type is the stronger proof here: allowance rows can never enter
		// the invoice overlays, whose trusted contract deliberately admits only these two kinds.
		const trustedScope = { kind: "detail-drawer", detailKind: row.kind } as const;
		const form = await this.snapshot(invoiceScope);
		if (hasBoundInvoiceCount(form)) {
			const existingInvoice = await this.snapshot([...invoiceScope, "已有发票"]);
			if (
				boundInvoiceSummaryEvidence(existingInvoice, row) &&
				this.verifiedInvoiceBindings.has(verifiedInvoiceBindingKey(row))
			) {
				return;
			}
			this.blocker(
				"invoice_dialog_contract",
				"绑定发票",
				`当前明细已有发票，但本轮没有识票绑定凭证，也不能从可见区域核对 ${row.invoiceNumber}`,
			);
		}
		const addInvoice = this.requireUnique(
			form,
			(element) => element.text === "添加发票" && fieldLabel(element) === "上传发票",
			"绑定发票",
			"当前明细的“添加发票”按钮必须唯一",
		);
		if (this.browser.runEkuaibaoTrustedCommand) {
			const menuState = await this.trustedHover("绑定发票", trustedScope);
			if (menuState.overlay !== "invoice-menu") this.blocker("unverified_state", "绑定发票", "可信悬浮未打开智能识票菜单");
		} else {
			await this.hover("绑定发票", { ref: addInvoice.ref, scopeTexts: invoiceScope });
		}
		await this.pause();
		const menu = await this.snapshot(["智能识票"]);
		const smart = this.requireUnique(menu, (element) => element.text === "智能识票", "绑定发票", "悬浮菜单必须唯一出现“智能识票”");
		if (this.browser.runEkuaibaoTrustedCommand) {
			const dialogState = await this.trustedClick(
				"绑定发票",
				"open-smart-invoice",
				{ kind: "invoice-menu", detailKind: trustedScope.detailKind },
			);
			if (dialogState.overlay !== "invoice-dialog") this.blocker("unverified_state", "绑定发票", "可信命令未进入智能识票上传层");
		} else {
			await this.click("绑定发票", { ref: smart.ref, scopeTexts: ["智能识票"] });
		}
		await this.pause();
		const uploadDialog = await this.snapshot(["智能识票", "上传文件"]);
		const fileInput = this.requireUnique(
			uploadDialog,
			(element) => hasType(element, "file"),
			"智能识票上传",
			"智能识票对话框必须暴露唯一 file ref；有多个时绝不按 occurrence 猜测",
		);
		if (this.browser.runEkuaibaoTrustedCommand) {
			await this.trustedUpload(
				"智能识票上传",
				"smart-invoice",
				{ kind: "invoice-dialog", detailKind: trustedScope.detailKind },
				[row.uploadFile],
			);
		} else {
			await this.upload("智能识票上传", [row.uploadFile], {
				ref: fileInput.ref,
				scopeTexts: ["智能识票", "上传文件"],
			});
		}
		await this.pause();
		const uploaded = await this.snapshot(["智能识票", "上传文件"]);
		if (!hasFileEvidence(uploaded, row.uploadFile)) {
			this.blocker("unverified_state", "智能识票上传", `上传对话框未回读到文件 ${basename(row.uploadFile)}`);
		}
		const confirm = this.requireUnique(
			uploaded,
			(element) => element.text === "确定" && element.descriptor.startsWith("button") && !isDisabled(element),
			"智能识票上传",
			"上传对话框必须有唯一可用的“确定”按钮",
		);
		if (this.browser.runEkuaibaoTrustedCommand) {
			await this.trustedClick(
				"智能识票上传",
				"confirm-invoice-upload",
				{ kind: "invoice-dialog", detailKind: trustedScope.detailKind },
			);
		} else {
			await this.click("智能识票上传", { ref: confirm.ref, scopeTexts: ["智能识票", "上传文件"] });
		}
		const recognitionScope = ["通过智能识票识别出", "与该消费绑定"];
		const recognized = await this.waitForInvoiceRecognition();
		const checkboxCandidates = parseSnapshotElements(recognized).filter(
			(element) =>
				hasType(element, "checkbox") &&
				!/^全选/.test(fieldLabel(element) ?? element.text) &&
				!/^通过智能识票/.test(fieldLabel(element) ?? element.text),
		);
		if (!recognizedInvoiceIdentityEvidence(recognized, row)) {
			this.blocker(
				"invoice_dialog_contract",
				"选择识别发票",
				row.kind === "transport"
					? "唯一识别结果必须展示有向原始站名、乘车日期、精确金额、铁路票类型和已验真状态"
					: `唯一识别结果必须展示住宿发票号 ${row.invoiceNumber} 和精确金额`,
			);
		}
		if (checkboxCandidates.length !== 1) {
			this.blocker(
				checkboxCandidates.length === 0 ? "missing_anchor" : "ambiguous_anchor",
				"选择识别发票",
				`识别结果必须只有一张可选发票，并已用票号/车次/原始站名和金额核验 ${row.invoiceNumber}`,
				checkboxCandidates.map((element) => element.raw),
			);
		}
		if (this.browser.runEkuaibaoTrustedCommand) {
			const evidence =
				row.kind === "transport"
					? [
							row.travelDate,
							row.fromStation ?? row.fromCity,
							row.toStation ?? row.toCity,
							...(row.trainNumber ? [row.trainNumber] : []),
						]
					: ["住宿"];
			await this.trustedSelect(
				"选择识别发票",
				"recognized-invoice",
				{ kind: "invoice-results", detailKind: trustedScope.detailKind },
				row.amount.toFixed(2),
				evidence,
			);
		} else {
			await this.click("选择识别发票", { ref: checkboxCandidates[0].ref, scopeTexts: recognitionScope });
		}
		await this.pause();
		const selected = await this.snapshot(recognitionScope);
		const selectedCheckboxes = parseSnapshotElements(selected).filter(
			(element) =>
				hasType(element, "checkbox") &&
				!/^\u5168选/.test(fieldLabel(element) ?? element.text) &&
				!/^\u901a过智能识票/.test(fieldLabel(element) ?? element.text),
		);
		if (selectedCheckboxes.length !== 1 || explicitChecked(selectedCheckboxes[0]) !== true) {
			this.blocker(
				"unverified_state",
				"选择识别发票",
				"点击后必须从同一唯一发票 checkbox 回读 checked/aria-checked=true，才允许绑定",
				selectedCheckboxes.map((element) => element.raw),
			);
		}
		const bind = this.requireUnique(
			selected,
			(element) => element.text === "与该消费绑定" && element.descriptor.startsWith("button") && !isDisabled(element),
			"绑定发票",
			"勾选唯一发票后“与该消费绑定”必须唯一且可用",
		);
		if (this.browser.runEkuaibaoTrustedCommand) {
			const reboundState = await this.trustedClick(
				"绑定发票",
				"bind-recognized-invoice",
				{ kind: "invoice-results", detailKind: trustedScope.detailKind },
			);
			if (reboundState.overlay !== "detail-drawer") this.blocker("unverified_state", "绑定发票", "可信绑定后未返回当前明细抽屉");
		} else {
			await this.click("绑定发票", { ref: bind.ref, scopeTexts: recognitionScope });
		}
		await this.pause(Math.max(this.waitMilliseconds, 800));
		const rebound = await this.snapshot([...invoiceScope, "已有发票"]);
		if (!boundInvoiceSummaryEvidence(rebound, row)) {
			this.blocker("unverified_state", "绑定发票", `绑定后未回读到唯一发票数及匹配金额 ${row.amount.toFixed(2)}`);
		}
		this.verifiedInvoiceBindings.add(verifiedInvoiceBindingKey(row));
	}

	private async uploadDetailAttachments(
		row: TravelDraftTransportExpected | TravelDraftHotelExpected,
		feeType: string,
	): Promise<void> {
		const paths = [row.uploadFile, ...row.verificationFiles];
		const scope = detailDrawerScope(feeType, "附件", row.paymentRecipient);
		const before = await this.snapshot(scope);
		if (paths.every((path) => hasFileEvidence(before, path))) return;
		const fileInput = this.requireUnique(
			before,
			(element) => hasType(element, "file"),
			"上传明细附件",
			"当前明细的普通附件区域必须暴露唯一 file ref；绝不回退到顶部附件或其他明细",
		);
		let output: string;
		if (this.browser.runEkuaibaoTrustedCommand) {
			await this.trustedUpload(
				"上传明细附件",
				"detail-attachments",
				{ kind: "detail-drawer", detailKind: row.kind },
				paths,
			);
			output = paths.map((path) => basename(path)).join("、");
		} else {
			output = await this.upload("上传明细附件", paths, { ref: fileInput.ref, scopeTexts: scope });
		}
		if (!paths.every((path) => output.includes(basename(path)))) {
			this.blocker("unverified_state", "上传明细附件", "浏览器没有确认保留全部定向附件", [output]);
		}
		await this.pause(Math.max(this.waitMilliseconds, 800));
		const after = await this.snapshot(scope);
		if (!paths.every((path) => hasFileEvidence(after, path))) {
			this.blocker("unverified_state", "上传明细附件", "页面未回读到当前明细的全部附件文件名");
		}
	}

	private uniqueFoldedDetail(
		snapshot: string,
		row: TravelDraftTransportExpected | TravelDraftHotelExpected | TravelDraftAllowanceExpected,
		operation: string,
	): SnapshotElement {
		if (!foldedDetailEvidence(snapshot, row, this.verifiedPaymentDomains.has(detailPaymentDomain(row)))) {
			this.blocker(
				"unverified_state",
				operation,
				`折叠行未同时回读到费用类型、日期、城市/席别、金额、收款人和已有发票数：${row.key}`,
			);
		}
		const candidates = foldedDetailCandidates(snapshot, row);
		if (candidates.length !== 1) {
			this.blocker(
				candidates.length === 0 ? "missing_anchor" : "ambiguous_anchor",
				operation,
				`折叠费用行必须按可见字段唯一定位，当前匹配 ${candidates.length} 行：${row.key}`,
				candidates.map((candidate) => candidate.raw),
			);
		}
		return candidates[0];
	}

	private async verifyOpenDetail(
		row: TravelDraftTransportExpected | TravelDraftHotelExpected | TravelDraftAllowanceExpected,
		operation: string,
	): Promise<void> {
		const feeType = detailFeeType(row);
		const form = await this.snapshot(detailDrawerScope(feeType));
		if (!form.includes(`testid=${TEST_IDS.saveDetail}`)) {
			this.blocker("unverified_state", operation, "未回读到当前明细抽屉的唯一保存锚点");
		}
		const reporterSnapshot = await this.snapshot(detailDrawerScope(feeType, "费用报销人"));
		const paymentSnapshot = await this.snapshot(detailDrawerScope(feeType, "支付信息"));
		let invoiceSnapshot: string | undefined;
		let attachmentSnapshot: string | undefined;
		if (row.kind !== "allowance") {
			invoiceSnapshot = await this.snapshot(detailDrawerScope(feeType, "上传发票", "已有发票"));
			attachmentSnapshot = await this.snapshot(detailDrawerScope(feeType, "附件", row.paymentRecipient));
		}
		if (
			!drawerDetailEvidence(
				form,
				reporterSnapshot,
				paymentSnapshot,
				invoiceSnapshot,
				attachmentSnapshot,
				row,
				row.kind === "allowance" || this.verifiedInvoiceBindings.has(verifiedInvoiceBindingKey(row)),
				this.verifiedPaymentDomains.has(detailPaymentDomain(row)),
			)
		) {
			this.blocker(
				"unverified_state",
				operation,
				`明细抽屉未完整核验字段、逐行支付信息、唯一发票绑定和定向附件：${row.key}`,
			);
		}
	}

	private async reverifyFoldedDetail(
		row: TravelDraftTransportExpected | TravelDraftHotelExpected | TravelDraftAllowanceExpected,
		foldedSnapshot: string,
	): Promise<void> {
		const candidate = this.uniqueFoldedDetail(foldedSnapshot, row, "恢复已有费用明细");
		if (this.browser.runEkuaibaoTrustedCommand) {
			const opened = await this.trustedClick("恢复已有费用明细", "open-detail", { kind: "main" }, {
				detailKind: row.kind,
				evidence: trustedDetailEvidence(row),
			});
			if (opened.overlay !== "detail-drawer") {
				this.blocker("unverified_state", "恢复已有费用明细", "可信费用行命令未打开唯一明细抽屉");
			}
		} else {
			await this.click("恢复已有费用明细", { ref: candidate.ref, scopeTexts: detailScope(row) });
		}
		await this.pause();
		await this.verifyOpenDetail(row, "复核已有费用明细");
		const feeType = detailFeeType(row);
		const drawer = await this.snapshot(detailDrawerScope(feeType));
		const elements = parseSnapshotElements(drawer);
		const closeCandidates = elements.filter(
			(element) =>
				element.descriptor.startsWith("button") &&
				!isDisabled(element) &&
				(element.text === "关闭" || element.text === "取消" || fieldLabel(element) === "关闭"),
		);
		if (closeCandidates.length !== 1) {
			this.blocker(
				closeCandidates.length === 0 ? "missing_anchor" : "ambiguous_anchor",
				"关闭已复核明细",
				"复核后抽屉必须有唯一的“关闭/取消”按钮；驱动器不会猜测 occurrence",
				closeCandidates.map((element) => element.raw),
			);
		}
		if (this.browser.runEkuaibaoTrustedCommand) {
			const closed = await this.trustedClick(
				"关闭已复核明细",
				"close-detail",
				{ kind: "detail-drawer", detailKind: trustedDetailKind(feeType) },
			);
			if (closed.overlay !== "none") this.blocker("unverified_state", "关闭已复核明细", "可信关闭后未返回主表");
		} else {
			await this.click("关闭已复核明细", { ref: closeCandidates[0].ref, scopeTexts: detailDrawerScope(feeType) });
		}
		await this.pause();
		const restored = await this.snapshot(detailScope(row));
		this.uniqueFoldedDetail(restored, row, "确认已复核明细关闭");
		this.verifiedDetails.set(row.key, expectedDetail(row));
	}

	private async saveDetail(row: TravelDraftTransportExpected | TravelDraftHotelExpected | TravelDraftAllowanceExpected) {
		await this.verifyOpenDetail(row, "保存前复核费用明细");
		if (this.detailCountBeforeOpen === undefined) {
			this.blocker("unverified_state", "保存费用明细", "新增前无法读取费用明细数，不能证明未重复新增");
		}
		let trustedSaved: EkuaibaoTrustedPageState | undefined;
		if (this.browser.runEkuaibaoTrustedCommand) {
			trustedSaved = await this.trustedClick(
				"保存费用明细",
				"save-detail",
				{ kind: "detail-drawer", detailKind: row.kind },
			);
			if (trustedSaved.overlay !== "none") this.blocker("unverified_state", "保存费用明细", "可信保存后未返回主表");
		} else {
			await this.click("保存费用明细", {
				selector: `[data-testid="${TEST_IDS.saveDetail}"]`,
				scopeTexts: ["添加明细"],
			});
		}
		await this.pause(Math.max(this.waitMilliseconds, 800));
		const main = await this.snapshot();
		const actualCount = trustedSaved?.detailCount ?? parseDetailCount(main);
		if (actualCount !== this.detailCountBeforeOpen + 1) {
			this.blocker(
				"unverified_state",
				"保存费用明细",
				`保存后费用明细数应从 ${this.detailCountBeforeOpen} 变为 ${this.detailCountBeforeOpen + 1}，当前为 ${actualCount ?? "无法读取"}`,
			);
		}
		const saved = await this.snapshot(detailScope(row));
		this.uniqueFoldedDetail(saved, row, "保存费用明细");
		await this.reverifyFoldedDetail(row, saved);
		this.detailCountBeforeOpen = undefined;
	}

	private async existingDetail(row: TravelDraftTransportExpected | TravelDraftHotelExpected | TravelDraftAllowanceExpected) {
		const snapshot = await this.snapshot(detailScope(row));
		if (foldedDetailEvidence(snapshot, row, this.verifiedPaymentDomains.has(detailPaymentDomain(row)))) {
			this.uniqueFoldedDetail(snapshot, row, "检查已有费用明细");
			if (!this.verifiedDetails.has(row.key)) await this.reverifyFoldedDetail(row, snapshot);
			return true;
		}
		const nearExistingRow =
			row.kind === "transport" ? foldedTransportRouteEvidence(snapshot, row) : !snapshot.includes(SNAPSHOT_SCOPE_MISS);
		if (nearExistingRow) {
			this.blocker(
				"existing_row_unverifiable",
				"检查已有费用明细",
				`页面已有与 ${row.key} 相近的明细，但金额/收款人/附件未能全部核实；为避免重复行已停止`,
			);
		}
		return false;
	}

	private mainHeader(
		snapshot: string,
		expected: TravelDraftExpected,
	): NonNullable<TravelDraftObservation["header"]> {
		const elements = parseSnapshotElements(snapshot);
		const fieldValue = (label: string) => adjacentFieldValue(elements, label);
		const explanation = elements.find((element) => testId(element) === TEST_IDS.description)?.text;
		const station = fieldValue("驻地");
		const companyValues = semanticFieldValues(elements, "所属公司");
		const company = companyValues.length === 1 ? companyValues[0] : undefined;
		const applicantDepartment = fieldValue("申请人部门");
		const expenseDepartment = fieldValue("费用所属部门");
		// A collapsed leaf is usable only after this driver instance selected the
		// unique full path itself. It must never mint that proof during recovery.
		if (applicantDepartment && departmentPathMatches(applicantDepartment)) {
			this.verifiedDepartments.add("申请人部门");
		}
		if (expenseDepartment && departmentPathMatches(expenseDepartment)) {
			this.verifiedDepartments.add("费用所属部门");
		}
		const payment = fieldValue("支付信息");
		const multipleRecipientCheckbox = elements.find(
			(element) => fieldLabel(element) === "是否为多收款人" && hasType(element, "checkbox"),
		);
		return {
			explanation: explanation === expected.header.explanation ? explanation : undefined,
			submitter: fieldValue("提交人") === TRAVEL_DRAFT_CURRENT_USER ? TRAVEL_DRAFT_CURRENT_USER : undefined,
			station:
				station && containsNormalized(station, "江苏省") && cityLevelPathMatches(station, "南京")
					? TRAVEL_DRAFT_STATION
					: undefined,
			company: company && normalizeText(company) === normalizeText(TRAVEL_DRAFT_COMPANY) ? TRAVEL_DRAFT_COMPANY : undefined,
			reimbursementDate:
				fieldValue("报销日期") === expected.header.reimbursementDate ? expected.header.reimbursementDate : undefined,
			expenseNature: fieldValue("费用性质") as TravelExpenseNature | undefined,
			applicantDepartment:
				applicantDepartment &&
				(departmentPathMatches(applicantDepartment) ||
					(departmentLeafMatches(applicantDepartment) && this.verifiedDepartments.has("申请人部门")))
					? TRAVEL_DRAFT_DEPARTMENT
					: undefined,
			expenseDepartment:
				expenseDepartment &&
				(departmentPathMatches(expenseDepartment) ||
					(departmentLeafMatches(expenseDepartment) && this.verifiedDepartments.has("费用所属部门")))
					? TRAVEL_DRAFT_DEPARTMENT
					: undefined,
			paymentRecipient: payment && this.paymentValueEvidence(payment, "main") ? TRAVEL_DRAFT_CURRENT_USER : undefined,
			multipleRecipients: multipleRecipientCheckbox ? explicitChecked(multipleRecipientCheckbox) : undefined,
		};
	}

	private trustedMainHeader(
		state: EkuaibaoTrustedPageState,
		expected: TravelDraftExpected,
	): NonNullable<TravelDraftObservation["header"]> {
		const value = (key: keyof EkuaibaoTrustedPageState["fields"]): string | undefined => {
			const field = state.fields[key];
			return field?.present && !field.ambiguous ? field.value : undefined;
		};
		const applicantDepartment = value("applicant-department");
		const expenseDepartment = value("expense-department");
		const company = value("company");
		const station = value("station");
		const payment = value("main-payment-recipient");
		const verifiedDepartment = (
			label: "申请人部门" | "费用所属部门",
			department: string | undefined,
		): string | undefined => {
			if (!department) return undefined;
			if (departmentPathMatches(department)) {
				this.verifiedDepartments.add(label);
				return TRAVEL_DRAFT_DEPARTMENT;
			}
			return departmentLeafMatches(department) && this.verifiedDepartments.has(label)
				? TRAVEL_DRAFT_DEPARTMENT
				: undefined;
		};
		return {
			explanation: value("description") === expected.header.explanation ? expected.header.explanation : undefined,
			submitter: value("submitter") === TRAVEL_DRAFT_CURRENT_USER ? TRAVEL_DRAFT_CURRENT_USER : undefined,
			station:
				station && containsNormalized(station, "江苏省") && cityLevelPathMatches(station, "南京")
					? TRAVEL_DRAFT_STATION
					: undefined,
			company:
				company && normalizeText(company) === normalizeText(TRAVEL_DRAFT_COMPANY)
					? TRAVEL_DRAFT_COMPANY
					: undefined,
			reimbursementDate:
				value("reimbursement-date") === expected.header.reimbursementDate
					? expected.header.reimbursementDate
					: undefined,
			expenseNature: value("expense-nature") as TravelExpenseNature | undefined,
			applicantDepartment: verifiedDepartment("申请人部门", applicantDepartment),
			expenseDepartment: verifiedDepartment("费用所属部门", expenseDepartment),
			paymentRecipient: payment && this.paymentValueEvidence(payment, "main") ? TRAVEL_DRAFT_CURRENT_USER : undefined,
			multipleRecipients:
				state.multipleRecipients.present && state.multipleRecipients.source !== "ambiguous"
					? state.multipleRecipients.checked
					: undefined,
		};
	}

	private completeTrustedHeader(
		header: TravelDraftObservation["header"],
		expected: TravelDraftExpected,
	): boolean {
		return Boolean(
			header &&
				header.explanation === expected.header.explanation &&
				header.submitter === expected.header.submitter &&
				header.station === expected.header.station &&
				header.company === expected.header.company &&
				header.reimbursementDate === expected.header.reimbursementDate &&
				header.expenseNature === expected.header.expenseNature &&
				header.applicantDepartment === expected.header.applicantDepartment &&
				header.expenseDepartment === expected.header.expenseDepartment &&
				header.paymentRecipient === expected.header.paymentRecipient &&
				header.multipleRecipients === false,
		);
	}

	private trustedApplicationObservation(
		state: EkuaibaoTrustedPageState,
		expected: TravelDraftExpected,
	): TravelDraftObservation["application"] {
		const linked = state.linkedApplication;
		if (!linked || !this.verifiedApplicationFacts) return undefined;
		if (!sameApplication(this.verifiedApplicationFacts.application, expected.application)) return undefined;
		if (linked.id !== expected.application.id || !linked.title || !containsNormalized(linked.title, expected.application.title)) {
			return undefined;
		}
		if (linked.startDate && linked.startDate !== expected.application.startDate) return undefined;
		if (linked.endDate && linked.endDate !== expected.application.endDate) return undefined;
		return structuredClone(expected.application);
	}

	private trustedFoldedSnapshot(
		state: EkuaibaoTrustedPageState,
		row: TravelDraftTransportExpected | TravelDraftHotelExpected | TravelDraftAllowanceExpected,
	): string | undefined {
		const kind = row.kind;
		const matches = state.foldedDetails
			.filter((detail) => detail.feeType === kind)
			.map((detail, index) => `[e${index + 1}] div ${detail.summary}`)
			.filter((snapshot) =>
				foldedDetailEvidence(snapshot, row, this.verifiedPaymentDomains.has(detailPaymentDomain(row))),
			);
		return matches.length === 1 ? matches[0] : undefined;
	}

	private applicationObservation(snapshot: string, expected: TravelDraftExpected): TravelDraftObservation["application"] {
		if (!snapshot.includes(expected.application.id) || !snapshot.includes(expected.application.title)) return undefined;
		if (!this.verifiedApplicationFacts || !sameApplication(this.verifiedApplicationFacts.application, expected.application)) {
			return undefined;
		}
		return structuredClone(expected.application);
	}

	async precheck(plan: TravelDraftPlan, expected: TravelDraftExpected): Promise<TravelDraftPrecheckResult> {
		this.expected = expected;
		const paths = [
			...plan.transport.flatMap((row) => [row.uploadFile, ...row.verificationFiles]),
			...(plan.hotel ? [plan.hotel.uploadFile, ...plan.hotel.verificationFiles] : []),
		];
		const missing: TravelDraftIssue[] = [];
		try {
			readAgentBrowserUploadFiles(this.cwd, paths);
		} catch (error) {
			missing.push(
				issue(
					"unreadable_attachment",
					"attachments",
					error instanceof Error ? error.message : String(error),
				),
			);
		}
		const state = this.browser.state();
		const observation = state.open ? await this.observe(expected) : { page: "closed" as const, details: [] };
		return { observation, missing };
	}

	async observe(expected: TravelDraftExpected): Promise<TravelDraftObservation> {
		this.expected = expected;
		const state = this.browser.state();
		if (!state.open) return { page: "closed", details: [] };
		const trusted = await this.inspectTrusted("读取合思差旅页面契约");
		let main: string | undefined;
		const readMain = async (): Promise<string> => {
			main ??= await this.snapshot();
			return main;
		};
		if (!trusted) {
			const legacyMain = await readMain();
			if (!legacyMain.includes("差旅费用报销单") || !legacyMain.includes(`testid=${TEST_IDS.saveDraft}`)) {
				return { page: state.loading ? "loading" : "closed", details: [] };
			}
		}

		let application = trusted ? this.trustedApplicationObservation(trusted, expected) : undefined;
		let header = trusted ? this.trustedMainHeader(trusted, expected) : undefined;
		if (!application || !this.completeTrustedHeader(header, expected)) {
			const legacyMain = await readMain();
			application ??= this.applicationObservation(legacyMain, expected);
			if (!this.completeTrustedHeader(header, expected)) {
				header = this.mainHeader(legacyMain, expected);
				if (trusted?.multipleRecipients.present && trusted.multipleRecipients.source !== "ambiguous") {
					header.multipleRecipients = trusted.multipleRecipients.checked;
				}
				const trustedPayment = trusted?.fields["main-payment-recipient"];
				if (
					trustedPayment?.present &&
					!trustedPayment.ambiguous &&
					this.paymentValueEvidence(trustedPayment.value ?? "", "main")
				) {
					header.paymentRecipient = TRAVEL_DRAFT_CURRENT_USER;
				}
			}
		}
		const details: TravelDraftDetailObservation[] = [];
		for (const row of [...expected.transport, ...(expected.hotel ? [expected.hotel] : []), expected.allowance]) {
			let scoped = trusted ? this.trustedFoldedSnapshot(trusted, row) : undefined;
			if (!scoped || !this.verifiedDetails.has(row.key)) scoped = await this.snapshot(detailScope(row));
			if (foldedDetailEvidence(scoped, row, this.verifiedPaymentDomains.has(detailPaymentDomain(row)))) {
				this.uniqueFoldedDetail(scoped, row, "观察费用明细");
				if (!this.verifiedDetails.has(row.key)) await this.reverifyFoldedDetail(row, scoped);
				const detail = expectedDetail(row);
				details.push(detail);
			} else {
				this.verifiedDetails.delete(row.key);
			}
		}
		let confirmation = this.saveRequested && trusted?.draftConfirmationVisible ? "保存成功" : undefined;
		if (this.saveRequested && !confirmation) {
			confirmation = explicitConfirmation(await readMain()) ?? this.saveConfirmation;
		}
		let detailCount = trusted?.detailCount;
		if (detailCount === undefined) detailCount = parseDetailCount(await readMain());
		let calculatedTotal = trusted?.calculatedTotal ? Number(trusted.calculatedTotal) : undefined;
		if (!Number.isFinite(calculatedTotal)) calculatedTotal = parseExpectedTotal(await readMain(), expected.totalAmount);
		if (
			calculatedTotal !== undefined &&
			Math.round(calculatedTotal * 100) !== Math.round(expected.totalAmount * 100)
		) {
			calculatedTotal = undefined;
		}
		return {
			page: "form",
			application,
			header,
			details,
			detailCount,
			calculatedTotal,
			verification: this.verificationValid ? { valid: true, errors: [] } : undefined,
			draft: {
				saveRequested: this.saveRequested,
				saved: this.saveRequested && Boolean(confirmation),
				confirmationText: confirmation,
			},
		};
	}

	async open(url: string): Promise<TravelDraftObservation> {
		await this.navigate(url);
		await this.waitFor(10_000, "差旅费用报销单");
		return this.observe(this.assertExpected());
	}

	async ensureApplication(application: TravelDraftApplication): Promise<TravelDraftObservation> {
		const expected = this.assertExpected();
		const current = await this.snapshot();
		if (this.applicationObservation(current, expected)) return this.observe(expected);
		const expectedCandidate: TravelApplicationCandidate = {
			id: application.id,
			title: application.title,
			ref: "",
			evidence: "",
		};
		const invoiceFacts: TravelApplicationInvoiceFacts = {
			travelDates: expected.transport.map((row) => row.travelDate),
			cities: expected.transport.flatMap((row) => [row.fromCity, row.toCity]),
		};
		const verifiedSource = this.sourceFactsFromVerified(expectedCandidate);
		const alreadyLinked = verifiedSource
			? parseLinkedApplicationFacts(current, expectedCandidate, verifiedSource)
			: { missing: [], ambiguous: [] };
		if (
			alreadyLinked.facts &&
			alreadyLinked.missing.length === 0 &&
			alreadyLinked.ambiguous.length === 0 &&
			sameApplication(alreadyLinked.facts.application, application) &&
			linkedApplicationIssues(application, invoiceFacts).length === 0
		) {
			this.verifiedApplicationFacts = alreadyLinked.facts;
			return this.observe(expected);
		}
		if (this.browser.runEkuaibaoTrustedCommand) {
			const opened = await this.trustedClick("选择关联申请", "open-application", { kind: "main" });
			if (opened.overlay !== "application-dialog") this.blocker("unverified_state", "选择关联申请", "可信命令未打开关联申请弹窗");
		} else {
			await this.click("选择关联申请", {
				selector: `[data-testid="${TEST_IDS.application}"]`,
				scopeTexts: ["关联申请"],
			});
		}
		await this.pause();
		const dialog = await this.snapshot(["搜索标题和单号"]);
		const search = this.requireUnique(
			dialog,
			(element) => placeholder(element) === "搜索标题和单号" && element.descriptor.startsWith("input"),
			"选择关联申请",
			"关联申请弹窗必须有唯一搜索框",
		);
		if (this.browser.runEkuaibaoTrustedCommand) {
			await this.trustedType("选择关联申请", "application-search", { kind: "application-dialog" }, application.id, false);
		} else {
			await this.type("选择关联申请", { ref: search.ref, scopeTexts: ["搜索标题和单号"] }, application.id, false, false);
		}
		await this.pause();
		const results = await this.snapshot([application.id, application.title]);
		const choices = applicationCandidates(results).filter(
			(candidate) => candidate.id === application.id && candidate.title === application.title,
		);
		if (choices.length !== 1) {
			this.blocker(
				choices.length === 0 ? "missing_anchor" : "ambiguous_anchor",
				"选择关联申请",
				`申请 ${application.id} / ${application.title} 必须唯一`,
				choices.map((candidate) => candidate.evidence),
			);
		}
		const sourceFacts = await this.inspectApplicationSourceFacts(choices[0], results);
		if (sourceFacts.missing.length > 0 || sourceFacts.ambiguous.length > 0) {
			this.blocker(
				"unverified_state",
				"核对关联申请详情",
				"无法从候选申请或其详情唯一核对申请事由和费用性质",
				[...sourceFacts.missing, ...sourceFacts.ambiguous].map((item) => item.message),
			);
		}
		let selectedChoice = choices[0];
		if (sourceFacts.source === "details") {
			const refreshed = applicationCandidates(await this.snapshot([application.id, application.title])).filter(
				(candidate) => candidate.id === application.id && candidate.title === application.title,
			);
			if (refreshed.length !== 1) {
				this.blocker("unverified_state", "选择关联申请", "关闭申请详情后无法重新定位唯一候选申请");
			}
			selectedChoice = refreshed[0];
		}
		if (!this.browser.runEkuaibaoTrustedCommand) {
			await this.click("选择关联申请", {
				ref: selectedChoice.ref,
				scopeTexts: [application.id, application.title],
			});
		}
		const confirmSnapshot = await this.snapshot([application.id, application.title, "确认"]);
		const confirm = this.requireUnique(
			confirmSnapshot,
			(element) => element.text === "确认" && element.descriptor.startsWith("button") && !isDisabled(element),
			"选择关联申请",
			"关联申请弹窗必须有唯一确认按钮",
		);
		if (this.browser.runEkuaibaoTrustedCommand) {
			await this.trustedClick("选择关联申请", "confirm-application", { kind: "application-dialog" });
		} else {
			await this.click("选择关联申请", { ref: confirm.ref, scopeTexts: [application.id, application.title] });
		}
		await this.pause(Math.max(this.waitMilliseconds, 800));
		const selected = await this.snapshot();
		const parsedFacts = parseLinkedApplicationFacts(selected, selectedChoice, sourceFacts);
		if (!parsedFacts.facts || parsedFacts.missing.length > 0 || parsedFacts.ambiguous.length > 0) {
			this.blocker(
				"unverified_state",
				"选择关联申请",
				"确认后无法从主表唯一核对自动带出的报销说明、费用性质和申请差旅日期",
				[...parsedFacts.missing, ...parsedFacts.ambiguous].map((item) => item.message),
			);
		}
		if (!sameApplication(parsedFacts.facts.application, application)) {
			this.blocker("unsafe_page_state", "选择关联申请", "关联确认后主表事实与当前差旅计划不一致", [
				JSON.stringify(parsedFacts.facts.application),
			]);
		}
		const conflicts = linkedApplicationIssues(application, invoiceFacts);
		if (conflicts.length > 0) {
			this.blocker("unsafe_page_state", "选择关联申请", "关联申请标题/日期与票据事实不一致", [
				...conflicts.map((item) => item.message),
			]);
		}
		this.verifiedApplicationFacts = parsedFacts.facts;
		return this.observe(expected);
	}

	async ensureHeader(header: TravelDraftHeaderExpected): Promise<TravelDraftObservation> {
		const expected = this.assertExpected();
		const trusted = await this.inspectTrusted("读取表头可信状态");
		const initial = await this.snapshot();
		const initialHeader = this.mainHeader(initial, expected);
		if (trusted?.multipleRecipients.present && trusted.multipleRecipients.source !== "ambiguous") {
			initialHeader.multipleRecipients = trusted.multipleRecipients.checked;
		}
		const trustedPayment = trusted?.fields["main-payment-recipient"];
		if (
			trustedPayment?.present &&
			!trustedPayment.ambiguous &&
			this.paymentValueEvidence(trustedPayment.value ?? "", "main")
		) {
			initialHeader.paymentRecipient = TRAVEL_DRAFT_CURRENT_USER;
		}
		const trustedSubmitter = trusted?.fields.submitter;
		if (trustedSubmitter?.present && !trustedSubmitter.ambiguous && trustedSubmitter.value) {
			initialHeader.submitter = trustedSubmitter.value.includes(TRAVEL_DRAFT_CURRENT_USER)
				? TRAVEL_DRAFT_CURRENT_USER
				: trustedSubmitter.value;
		}
		if (!initialHeader) this.blocker("unverified_state", "填写表头", "无法读取表头状态");
		const allCompanyElements = parseSnapshotElements(initial).filter((element) => fieldLabel(element) === "所属公司");
		const trustedCompany = trusted?.fields.company;
		const companyValues = trusted
			? trustedCompany?.present && !trustedCompany.ambiguous && trustedCompany.value
				? [trustedCompany.value]
				: []
			: semanticFieldValues(parseSnapshotElements(initial), "所属公司");
		if (companyValues.length !== 1) {
			this.blocker(
				"unverified_state",
				"核对所属公司",
				`所属公司必须由系统唯一自动带出为“${TRAVEL_DRAFT_COMPANY}”；当前可辨认值数为 ${companyValues.length}，驱动器不会自动修改`,
				allCompanyElements.map((element) => element.raw),
			);
		}
		if (normalizeText(companyValues[0]) !== normalizeText(TRAVEL_DRAFT_COMPANY)) {
			this.blocker(
				"unsafe_page_state",
				"核对所属公司",
				`所属公司不是“${TRAVEL_DRAFT_COMPANY}”，已停止且未修改该字段`,
				allCompanyElements.map((element) => element.raw),
			);
		}
		if (initialHeader.multipleRecipients === true) {
			this.blocker("unsafe_page_state", "填写表头", "页面已开启多收款人；驱动器绝不触碰“是否为多收款人”");
		}
		if (initialHeader.multipleRecipients === undefined) {
			this.blocker(
				"unverified_state",
				"填写表头",
				"browser_snapshot 未提供“是否为多收款人”的 checked/aria-checked 状态，不能安全推断",
			);
		}
		if (initialHeader.submitter !== TRAVEL_DRAFT_CURRENT_USER) {
			this.blocker("unverified_state", "填写表头", `提交人必须是${TRAVEL_DRAFT_CURRENT_USER}`);
		}
		await this.ensureTextField("报销说明", TEST_IDS.description, header.explanation);
		await this.ensureStation();
		await this.ensureDimension("费用性质", header.expenseNature);
		await this.ensureDimension("申请人部门", header.applicantDepartment);
		await this.ensureDimension("费用所属部门", header.expenseDepartment);
		if (initialHeader.paymentRecipient !== header.paymentRecipient) {
			await this.ensureRecipient("支付信息", ["支付信息"], "main");
		}
		if (this.browser.runEkuaibaoTrustedCommand) {
			const currentDate = (await this.trustedBaseline("填写报销日期", { kind: "main" })).fields["reimbursement-date"];
			if (!currentDate?.present || currentDate.ambiguous) {
				this.blocker("unverified_state", "填写报销日期", "可信页面没有唯一报销日期字段");
			}
			if (currentDate.value !== header.reimbursementDate) {
				const updated = await this.trustedType(
					"填写报销日期",
					"reimbursement-date",
					{ kind: "main" },
					header.reimbursementDate,
					true,
				);
				if (updated.fields["reimbursement-date"]?.value !== header.reimbursementDate) {
					this.blocker("unverified_state", "填写报销日期", "可信输入后未结构化回读报销日期");
				}
				await this.pause();
			}
		} else {
			const dateSnapshot = await this.snapshot(["报销日期"]);
			const dateField = this.field(dateSnapshot, "报销日期", "填写报销日期", {
				placeholder: "请选择日期",
				editable: true,
			});
			if (dateField.text !== header.reimbursementDate) {
				await this.type(
					"填写报销日期",
					{ ref: dateField.ref, scopeTexts: ["报销日期"] },
					header.reimbursementDate,
					false,
					true,
				);
				await this.pause();
			}
		}
		const verified = await this.observe(expected);
		if (verified.header?.multipleRecipients === true) {
			this.blocker("unsafe_page_state", "填写表头", "填报过程中页面切换为多收款人，已停止");
		}
		return verified;
	}

	async ensureTransport(row: TravelDraftTransportExpected, _index: number): Promise<TravelDraftObservation> {
		const expected = this.assertExpected();
		if (await this.existingDetail(row)) return this.observe(expected);
		await this.openDetail(FEE_TYPES.transport);
		await this.bindInvoice(row, FEE_TYPES.transport);
		const scope = detailDrawerScope(FEE_TYPES.transport);
		await this.ensureDate("差旅起止日期", "开始日期", row.startDate, scope);
		await this.ensureDate("差旅起止日期", "结束日期", row.endDate, scope);
		await this.ensureCity("出发城市", row.fromCity, FEE_TYPES.transport);
		await this.ensureCity("到达城市", row.toCity, FEE_TYPES.transport);
		await this.selectExactOption(
			"填写乘坐火车席别",
			"乘坐火车席别",
			row.seatClass,
			(element) =>
				codedOptionMatches(element.text, row.seatClass) &&
				fieldLabel(element) !== "乘坐火车席别" &&
				(element.descriptor.split("/").includes("option") || testId(element) === "entity-profile"),
			detailDrawerScope(FEE_TYPES.transport, "乘坐火车席别"),
		);
		const amountScope = detailDrawerScope(FEE_TYPES.transport, "报销费用金额");
		if (this.browser.runEkuaibaoTrustedCommand) {
			const trustedScope = { kind: "detail-drawer", detailKind: "transport" } as const;
			const current = (await this.trustedBaseline("填写报销费用金额", trustedScope)).fields["reimbursement-amount"];
			if (!current?.present || current.ambiguous) this.blocker("unverified_state", "填写报销费用金额", "可信页面没有唯一报销金额字段");
			if (!current.value || !amountSignals(row.amount).includes(current.value)) {
				const updated = await this.trustedType("填写报销费用金额", "reimbursement-amount", trustedScope, String(row.amount));
				if (!amountSignals(row.amount).includes(updated.fields["reimbursement-amount"]?.value ?? "")) {
					this.blocker("unverified_state", "填写报销费用金额", "可信输入后未结构化回读报销金额");
				}
				await this.pause();
			}
		} else {
			const amountSnapshot = await this.snapshot(amountScope);
			const amount = this.field(amountSnapshot, "报销费用金额", "填写报销费用金额", {
				placeholder: "请输入报销费用金额",
				editable: true,
			});
			if (!amountSignals(row.amount).includes(amount.text)) {
				await this.type("填写报销费用金额", { ref: amount.ref, scopeTexts: amountScope }, String(row.amount));
				await this.pause();
			}
		}
		await this.ensureRecipient("费用报销人", detailDrawerScope(FEE_TYPES.transport, "费用报销人"));
		await this.ensureRecipient("支付信息", detailDrawerScope(FEE_TYPES.transport, "支付信息"), detailPaymentDomain(row));
		await this.uploadDetailAttachments(row, FEE_TYPES.transport);
		await this.saveDetail(row);
		return this.observe(expected);
	}

	async ensureHotel(row: TravelDraftHotelExpected): Promise<TravelDraftObservation> {
		const expected = this.assertExpected();
		if (await this.existingDetail(row)) return this.observe(expected);
		await this.openDetail(FEE_TYPES.hotel);
		await this.bindInvoice(row, FEE_TYPES.hotel);
		const scope = detailDrawerScope(FEE_TYPES.hotel);
		await this.ensureDate("差旅起止日期", "开始日期", row.checkinDate, scope);
		await this.ensureDate("差旅起止日期", "结束日期", row.checkoutDate, scope);
		const amountScope = detailDrawerScope(FEE_TYPES.hotel, "报销费用金额");
		if (this.browser.runEkuaibaoTrustedCommand) {
			const trustedScope = { kind: "detail-drawer", detailKind: "hotel" } as const;
			const current = (await this.trustedBaseline("填写住宿报销金额", trustedScope)).fields["reimbursement-amount"];
			if (!current?.present || current.ambiguous) this.blocker("unverified_state", "填写住宿报销金额", "可信页面没有唯一住宿金额字段");
			if (!current.value || !amountSignals(row.amount).includes(current.value)) {
				const updated = await this.trustedType("填写住宿报销金额", "reimbursement-amount", trustedScope, String(row.amount));
				if (!amountSignals(row.amount).includes(updated.fields["reimbursement-amount"]?.value ?? "")) {
					this.blocker("unverified_state", "填写住宿报销金额", "可信输入后未结构化回读住宿金额");
				}
				await this.pause();
			}
		} else {
			const amountSnapshot = await this.snapshot(amountScope);
			const amount = this.field(amountSnapshot, "报销费用金额", "填写住宿报销金额", {
				placeholder: "请输入报销费用金额",
				editable: true,
			});
			if (!amountSignals(row.amount).includes(amount.text)) {
				await this.type("填写住宿报销金额", { ref: amount.ref, scopeTexts: amountScope }, String(row.amount));
				await this.pause();
			}
		}
		await this.ensureRecipient("费用报销人", detailDrawerScope(FEE_TYPES.hotel, "费用报销人"));
		await this.ensureRecipient("支付信息", detailDrawerScope(FEE_TYPES.hotel, "支付信息"), detailPaymentDomain(row));
		await this.uploadDetailAttachments(row, FEE_TYPES.hotel);
		await this.saveDetail(row);
		return this.observe(expected);
	}

	async ensureAllowance(row: TravelDraftAllowanceExpected): Promise<TravelDraftObservation> {
		const expected = this.assertExpected();
		if (await this.existingDetail(row)) return this.observe(expected);
		await this.openDetail(FEE_TYPES.allowance);
		const scope = detailDrawerScope(FEE_TYPES.allowance);
		await this.ensureDate("差旅起止日期", "开始日期", row.startDate, scope);
		await this.ensureDate("差旅起止日期", "结束日期", row.endDate, scope);
		await this.selectExactOption(
			"填写补助类型",
			"补助类型",
			row.allowanceType,
			(element) =>
				element.text === row.allowanceType &&
				fieldLabel(element) !== "补助类型" &&
				(element.descriptor.split("/").includes("option") || testId(element) === "entity-profile"),
			detailDrawerScope(FEE_TYPES.allowance, "补助类型"),
		);
		await this.ensureRecipient("费用报销人", detailDrawerScope(FEE_TYPES.allowance, "费用报销人"));
		await this.ensureRecipient("支付信息", detailDrawerScope(FEE_TYPES.allowance, "支付信息"), detailPaymentDomain(row));
		const calculation = await this.snapshot(detailDrawerScope(FEE_TYPES.allowance, row.allowanceType));
		if (!amountSignals(row.amount).some((signal) => calculation.includes(signal))) {
			this.blocker(
				"unverified_state",
				"核对出差补助",
				`系统未按 ${row.days} 天 × 180 元自动核算为 ${row.amount} 元；驱动器不会手改补助金额`,
			);
		}
		await this.saveDetail(row);
		return this.observe(expected);
	}

	async verify(expected: TravelDraftExpected): Promise<TravelDraftObservation> {
		this.expected = expected;
		this.verificationValid = false;
		// Folded rows do not expose invoice, attachment, or per-row payment state.
		// Every final verification must therefore reopen every expected row instead of
		// accepting hidden-field evidence cached by an earlier save/recovery pass.
		this.verifiedDetails.clear();
		const observation = await this.observe(expected);
		const errors: string[] = [];
		const expectedCount = expected.transport.length + (expected.hotel ? 1 : 0) + 1;
		const actualCount = observation.detailCount;
		if (actualCount !== expectedCount) errors.push(`费用明细应为 ${expectedCount} 条，页面为 ${actualCount ?? "无法读取"} 条`);
		if (observation.details.length !== expectedCount) errors.push("有明细的金额、收款人、发票或附件未通过逐行核验");
		if (observation.calculatedTotal !== expected.totalAmount) {
			errors.push(`系统金额未核验为 ${expected.totalAmount.toFixed(2)} 元`);
		}
		if (!observation.application) errors.push("关联申请编号/标题/日期/费用性质未完整核验");
		const header = observation.header;
		const detailPaymentsVerified =
			observation.details.length === expectedCount &&
			observation.details.every((row) => row.paymentRecipient === expected.header.paymentRecipient);
		const headerPaymentVerified =
			header?.paymentRecipient === expected.header.paymentRecipient ||
			(header?.paymentRecipient === undefined && header?.multipleRecipients === false && detailPaymentsVerified);
		if (
			!header ||
			header.explanation !== expected.header.explanation ||
			header.submitter !== expected.header.submitter ||
			header.station !== expected.header.station ||
			header.company !== expected.header.company ||
				header.expenseNature !== expected.header.expenseNature ||
				header.applicantDepartment !== expected.header.applicantDepartment ||
				header.expenseDepartment !== expected.header.expenseDepartment ||
				!headerPaymentVerified ||
				header.multipleRecipients !== false
		) {
			errors.push("表头固定字段或多收款人状态未完整核验");
		}
		this.verificationValid = errors.length === 0;
		this.lastVerifiedTrustedDigest = this.verificationValid ? this.lastTrustedState?.digest : undefined;
		return { ...observation, detailCount: actualCount, verification: { valid: errors.length === 0, errors } };
	}

	async saveDraft(
		expected: TravelDraftExpected,
		onDispatch?: () => void | Promise<void>,
	): Promise<TravelDraftObservation> {
		this.expected = expected;
		if (this.saveAttempted) {
			this.blocker("unverified_state", "保存差旅草稿", "本轮已发起过草稿保存；保存状态未确认时绝不再次点击");
		}
		this.saveConfirmation = undefined;
		this.saveVerifiedObservation = undefined;
		if (this.browser.runEkuaibaoTrustedCommand) {
			let baseline = await this.inspectTrusted("核对草稿保存基线");
			if (!baseline) this.blocker("unverified_state", "保存差旅草稿", "可信合思页面契约不可用");
			for (let attempt = 0; baseline.draftConfirmationVisible && attempt < 3; attempt += 1) {
				await this.pause(Math.max(this.waitMilliseconds, 500));
				baseline = (await this.inspectTrusted("等待旧保存提示消失")) ?? baseline;
			}
			if (baseline.draftConfirmationVisible) {
				this.blocker(
					"unverified_state",
					"保存差旅草稿",
					"点击主草稿按钮前仍存在旧“保存成功”提示，无法证明后续提示属于主草稿保存",
				);
			}
			if (!this.verificationValid || this.lastVerifiedTrustedDigest !== baseline.digest) {
				this.blocker(
					"unverified_state",
					"保存差旅草稿",
					"保存前可信 DOM 摘要已变化，必须重新逐项核验后再进入保存边界",
					baseline.validationErrors,
				);
			}
			const verified = await this.observe(expected);
			if (verified.verification?.valid !== true || this.lastTrustedState?.digest !== baseline.digest) {
				this.blocker(
					"unverified_state",
					"保存差旅草稿",
					"保存前结构化回读与刚完成的逐行核验不一致；不会点击草稿按钮",
				);
			}
			this.saveVerifiedObservation = structuredClone(verified);
			await onDispatch?.();
			this.saveAttempted = true;
			this.saveRequested = true;
			await this.beforeBrowserAction("trusted", "保存差旅草稿");
			const result = await this.browser.runEkuaibaoTrustedCommand({
				op: "save-draft",
				contractVersion: EKUAIBAO_TRUSTED_CONTRACT_VERSION,
				pageToken: baseline.pageToken,
				expectedDigest: baseline.digest,
			});
			if (!result.ok) {
				this.blocker(this.trustedBlockerCode(result.code), "保存差旅草稿", result.message, [result.code]);
			}
			this.lastTrustedState = result.state;
			this.saveConfirmation = result.state.draftConfirmationVisible ? "保存成功" : undefined;
			return this.draftSaveObservation();
		}
		let baseline = await this.snapshot();
		for (let attempt = 0; explicitConfirmation(baseline) && attempt < 3; attempt += 1) {
			await this.pause(Math.max(this.waitMilliseconds, 500));
			baseline = await this.snapshot();
		}
		if (explicitConfirmation(baseline)) {
			this.blocker(
				"unverified_state",
				"保存差旅草稿",
				"点击主草稿按钮前仍存在旧“保存成功”提示，无法证明后续提示属于主草稿保存",
			);
		}
		const verified = await this.verify(expected);
		if (verified.verification?.valid !== true) {
			this.blocker(
				"unverified_state",
				"保存差旅草稿",
				"点击草稿按钮前的新鲜全表核验未通过；不会使用 VERIFY 阶段的缓存结果",
				verified.verification?.errors,
			);
		}
		this.saveVerifiedObservation = structuredClone(verified);
		// This flag is intentionally irreversible for the lifetime of this driver.
		// It is set before dispatch so an abort or runtime exception after the DOM
		// receives the click can never lead to a second save attempt.
		await onDispatch?.();
		this.saveAttempted = true;
		this.saveRequested = true;
		await this.click("保存差旅草稿", {
			selector: `[data-testid="${TEST_IDS.saveDraft}"]`,
			scopeTexts: ["差旅费用报销单"],
		});
		await this.pause();
		const snapshot = await this.snapshot();
		this.saveConfirmation = explicitConfirmation(snapshot);
		return this.draftSaveObservation();
	}

	async confirmDraftSaved(options: TravelDraftConfirmationOptions = {}): Promise<TravelDraftObservation> {
		if (options.readOnlyRecovery) {
			let confirmation: string | undefined;
			if (this.browser.runEkuaibaoTrustedCommand) {
				for (let attempt = 0; attempt < 3 && !confirmation; attempt += 1) {
					const state = await this.inspectTrusted("只读恢复草稿保存结果");
					confirmation = state?.overlay === "none" && state.draftConfirmationVisible ? "保存成功" : undefined;
					if (!confirmation && attempt < 2) await this.pause(Math.max(this.waitMilliseconds, 500));
				}
			} else {
				const immediate = await this.snapshot();
				if (!immediate.includes("差旅费用报销单") || !immediate.includes(`testid=${TEST_IDS.saveDraft}`)) {
					this.blocker(
						"unsafe_page_state",
						"只读恢复草稿保存结果",
						"当前页面不是可唯一识别的差旅费用报销主表；状态仍为 unknown，绝不补点或重试保存",
					);
				}
				confirmation = explicitConfirmation(immediate);
				if (!confirmation) {
					try {
						const waited = await this.waitFor(5_000, "保存成功");
						confirmation = explicitConfirmation(waited);
					} catch (error) {
						if (error instanceof TravelDraftInterruptedError) throw error;
					}
				}
			}
			if (!confirmation) {
				this.blocker(
					"unverified_state",
					"只读恢复草稿保存结果",
					"持久化记录只证明保存可能已派发，页面未显示明确保存成功证据；状态仍为 unknown，绝不补点或重试保存",
				);
			}
			return {
				page: "form",
				details: [],
				draft: { saveRequested: true, saved: true, confirmationText: confirmation },
			};
		}
		this.assertExpected();
		if (!this.saveAttempted || !this.saveRequested) {
			this.blocker("unverified_state", "确认草稿保存", "本轮没有不可逆的草稿保存请求凭证；不会补点保存按钮");
		}
		if (!this.saveConfirmation) {
			const immediate = await this.snapshot();
			this.saveConfirmation = explicitConfirmation(immediate);
		}
		if (!this.saveConfirmation) {
			let waited: string;
			try {
				waited = await this.waitFor(5_000, "保存成功");
			} catch (error) {
				if (error instanceof TravelDraftInterruptedError) throw error;
				this.blocker(
					"unverified_state",
					"确认草稿保存",
					error instanceof Error ? error.message : "未出现明确的草稿保存成功文案",
				);
			}
			if (!DRAFT_CONFIRMATION.test(waited)) {
				this.blocker("unverified_state", "确认草稿保存", "未出现明确的草稿保存成功文案");
			}
			this.saveConfirmation = DRAFT_CONFIRMATION.exec(waited)?.[0];
		}
		if (!this.saveConfirmation) {
			this.blocker("unverified_state", "确认草稿保存", "未出现明确的草稿保存成功文案");
		}
		return this.draftSaveObservation();
	}

	async discoverApplication(input: DiscoverTravelApplicationInput): Promise<DiscoverTravelApplicationResult> {
		const missing: TravelDraftIssue[] = [];
		const ambiguous: TravelDraftIssue[] = [];
		if (!input.url.trim()) missing.push(issue("missing_url", "url", "缺少易快报报销链接"));
		if (!input.hint?.trim() && input.invoiceFacts.cities.length === 0) {
			missing.push(issue("missing_application_hint", "hint", "缺少关联申请标题/编号线索或票据城市"));
		}
		if (input.invoiceFacts.travelDates.length === 0) {
			missing.push(issue("missing_travel_date", "invoiceFacts.travelDates", "票据中没有可用于核对申请的乘车日期"));
		}
		if (input.invoiceFacts.cities.length === 0) {
			missing.push(issue("missing_invoice_cities", "invoiceFacts.cities", "票据中没有可用于核对申请出发到达城市的事实"));
		}
		if (missing.length > 0) return { status: "needs_input", missing, ambiguous, candidates: [] };
		const parsedHint = parseApplicationHint(input.hint);
		const unmatchedHintDates = parsedHint.dates.filter(
			(date) => !input.invoiceFacts.travelDates.some((travelDate) => hintDateMatchesIso(date, travelDate)),
		);
		if (unmatchedHintDates.length > 0) {
			ambiguous.push(
				issue(
					"application_hint_date_conflict",
					"hint",
					"关联申请线索中的日期与票据乘车日期不一致",
				),
			);
			return { status: "needs_input", missing, ambiguous, candidates: [] };
		}
		const allCities = [...new Set(input.invoiceFacts.cities.map((city) => city.trim()).filter(Boolean))];
		const destinationCities = allCities.filter((city) => normalizedFactCity(city) !== normalizedFactCity("南京"));
		const hintedDestination = destinationCities.find(
			(city) => parsedHint.titleHint && containsNormalized(parsedHint.titleHint, city),
		);
		const effectiveTitleHint = hintedDestination || parsedHint.titleHint;

		await this.navigate(input.url);
		await this.waitFor(10_000, "差旅费用报销单");
		const unlinkedBaseline = await this.snapshot();
		const existing = linkedApplicationCandidate(unlinkedBaseline, parsedHint.id, effectiveTitleHint);
		if (this.browser.runEkuaibaoTrustedCommand) {
			const opened = await this.trustedClick("发现关联申请", "open-application", { kind: "main" });
			if (opened.overlay !== "application-dialog") this.blocker("unverified_state", "发现关联申请", "可信命令未打开关联申请弹窗");
		} else {
			await this.click("发现关联申请", {
				selector: `[data-testid="${TEST_IDS.application}"]`,
				scopeTexts: ["关联申请"],
			});
		}
		await this.pause();
		const dialog = await this.snapshot(["搜索标题和单号"]);
		const search = this.requireUnique(
			dialog,
			(element) => placeholder(element) === "搜索标题和单号" && element.descriptor.startsWith("input"),
			"发现关联申请",
			"关联申请弹窗必须有唯一搜索框",
		);
		const targetId = existing?.id ?? parsedHint.id;
		const targetTitle = existing?.title ?? effectiveTitleHint;
		const query = targetId || targetTitle || destinationCities[0] || allCities[0] || "";
		if (this.browser.runEkuaibaoTrustedCommand) {
			await this.trustedType("发现关联申请", "application-search", { kind: "application-dialog" }, query, false);
		} else {
			await this.type("发现关联申请", { ref: search.ref, scopeTexts: ["搜索标题和单号"] }, query, false, false);
		}
		await this.pause();
		const results = await this.snapshot(query ? [query] : ["搜索标题和单号"]);
		const candidates = applicationCandidates(results);
		const matches = candidates.filter((candidate) => {
			if (targetId && candidate.id.toUpperCase() !== targetId.toUpperCase()) return false;
			if (!targetId && targetTitle && !containsNormalized(candidate.title, targetTitle)) return false;
			return true;
		});
		if (matches.length === 0) {
			missing.push(
				issue(
					"application_not_found",
					"application",
					`没有找到同时匹配线索“${query}”的已有出差申请`,
				),
			);
			return { status: "needs_input", missing, ambiguous, candidates };
		}
		if (matches.length > 1) {
			ambiguous.push(
				issue(
					"application_ambiguous",
					"application",
					`找到 ${matches.length} 个匹配申请：${matches.map((candidate) => `${candidate.title}（${candidate.id}）`).join("、")}`,
				),
			);
			return { status: "needs_input", missing, ambiguous, candidates: matches };
		}

		let selected = matches[0];
		const sourceFacts = await this.inspectApplicationSourceFacts(selected, results);
		missing.push(...sourceFacts.missing);
		ambiguous.push(...sourceFacts.ambiguous);
		if (missing.length > 0 || ambiguous.length > 0) {
			return { status: "needs_input", missing, ambiguous, candidates: [selected] };
		}
		if (sourceFacts.source === "details") {
			const refreshed = applicationCandidates(await this.snapshot([selected.id, selected.title])).filter(
				(candidate) => candidate.id === selected.id && candidate.title === selected.title,
			);
			if (refreshed.length !== 1) {
				ambiguous.push(
					issue("application_candidate_stale", "application", "关闭申请详情后无法重新定位唯一候选申请"),
				);
				return { status: "needs_input", missing, ambiguous, candidates: matches };
			}
			selected = refreshed[0];
		}
		if (!this.browser.runEkuaibaoTrustedCommand) {
			await this.click("发现关联申请", {
				ref: selected.ref,
				scopeTexts: [selected.id, selected.title],
			});
		}
		const confirmSnapshot = await this.snapshot([selected.id, selected.title, "确认"]);
		const confirm = this.requireUnique(
			confirmSnapshot,
			(element) => element.text === "确认" && element.descriptor.startsWith("button") && !isDisabled(element),
			"发现关联申请",
			"关联申请弹窗必须有唯一确认按钮",
		);
		if (this.browser.runEkuaibaoTrustedCommand) {
			await this.trustedClick("发现关联申请", "confirm-application", { kind: "application-dialog" });
		} else {
			await this.click("发现关联申请", { ref: confirm.ref, scopeTexts: [selected.id, selected.title] });
		}
		await this.pause(Math.max(this.waitMilliseconds, 800));
		const form = await this.snapshot();
		const parsedFacts = parseLinkedApplicationFacts(form, selected, sourceFacts);
		missing.push(...parsedFacts.missing);
		ambiguous.push(...parsedFacts.ambiguous);
		if (!parsedFacts.facts || missing.length > 0 || ambiguous.length > 0) {
			return {
				status: "needs_input",
				missing,
				ambiguous,
				candidates: [selected],
				observation: { page: "form", details: [] },
			};
		}
		const application = parsedFacts.facts.application;
		ambiguous.push(...linkedApplicationIssues(application, input.invoiceFacts));
		if (ambiguous.length > 0) return { status: "needs_input", missing, ambiguous, candidates: [selected] };
		this.verifiedApplicationFacts = parsedFacts.facts;
		const observation: TravelDraftObservation = { page: "form", application, details: [] };
		return { status: "selected", application, candidates: [selected], observation };
	}
}

export async function discoverTravelApplication(
	input: DiscoverTravelApplicationInput,
	options: TravelDraftBrowserDriverOptions = {},
): Promise<DiscoverTravelApplicationResult> {
	return new TravelDraftBrowserDriver(options).discoverApplication(input);
}
