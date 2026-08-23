import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	WebContentsView: class {},
	session: {
		fromPartition: () => ({ on: () => {} }),
	},
}));

// @ts-expect-error The packaged Electron main-process controller is intentionally plain JavaScript.
import * as BrowserControllerModule from "../installer/electron/browser-controller";
import {
	EKUAIBAO_TRUSTED_CONTRACT_VERSION,
	EKUAIBAO_TRUSTED_ORIGIN,
	EKUAIBAO_TRUSTED_PAGE_FINGERPRINT,
	isEkuaibaoTrustedPageUrl,
} from "../src/agent-browser-runtime.ts";

const { AgentBrowserController, EKUAIBAO_AMOUNT_NUMBER_PATTERN_SOURCE, EKUAIBAO_TRUSTED_DOM_CONTRACT } =
	BrowserControllerModule;

function inspectedPage(overrides: Record<string, unknown> = {}) {
	return {
		ok: true,
		overlay: "none",
		fields: {},
		controls: {
			"save-draft": { present: true, ambiguous: false, disabled: false },
		},
		multipleRecipients: { present: true, checked: false, source: "native-input" },
		linkedApplication: {
			id: "ID01APPLICATION",
			title: "常州出差",
			startDate: "2026-08-21",
			endDate: "2026-08-21",
		},
		detailCount: 1,
		calculatedTotal: "380.00",
		validationErrors: [],
		foldedDetails: [
			{
				feeType: "transport",
				summary: "差旅-城市间交通费-火车I高铁 2026-08-21 200.00",
				startDate: "2026-08-21",
				endDate: "2026-08-21",
				amount: "200.00",
				invoiceCount: 1,
			},
		],
		draftConfirmationVisible: false,
		fingerprintMaterial: "fixture-v1",
		...overrides,
	};
}

function applicationDetailsPage(overrides: Record<string, unknown> = {}) {
	return inspectedPage({
		overlay: "application-details",
		applicationSource: {
			id: "S26002261",
			title: "出差申请：常州业务拓展",
			reason: "常州业务拓展",
			expenseNature: "部门费用",
		},
		fingerprintMaterial: "fixture-application-details",
		...overrides,
	});
}

function fakeWebContents(url: string, result = inspectedPage()) {
	const contents = new EventEmitter() as EventEmitter & Record<string, unknown>;
	contents.getURL = () => url;
	contents.getTitle = () => "差旅费用报销单";
	contents.isLoading = () => false;
	contents.isDestroyed = () => false;
	contents.navigationHistory = {
		canGoBack: () => false,
		canGoForward: () => false,
	};
	contents.executeJavaScript = vi.fn(async () => result);
	contents.sendInputEvent = vi.fn();
	return contents;
}

function controllerAt(url: string, result = inspectedPage()) {
	const webContents = fakeWebContents(url, result);
	const controller = Object.create(AgentBrowserController.prototype) as InstanceType<typeof AgentBrowserController> &
		Record<string, unknown>;
	controller.status = "浏览器已准备";
	controller.isOpen = true;
	controller.view = { webContents };
	controller.trustedEkuaibaoPageToken = "";
	controller.trustedEkuaibaoDraftSaveIntent = "";
	controller.trustedEkuaibaoCommandActive = false;
	controller.open = vi.fn(async () => controller.state());
	controller.emitState = vi.fn(() => controller.state());
	return { controller, webContents };
}

describe("typed trusted EasyBao runtime", () => {
	it("accepts only the exact HTTPS bill-entry route and never fingerprints query credentials", () => {
		expect(
			isEkuaibaoTrustedPageUrl("https://app.ekuaibao.com/web/app.html?accessToken=secret#/billEntryDetail"),
		).toBe(true);
		expect(EKUAIBAO_TRUSTED_PAGE_FINGERPRINT).toBe("https://app.ekuaibao.com/web/app.html#/billEntryDetail");
		expect(EKUAIBAO_TRUSTED_PAGE_FINGERPRINT).not.toContain("secret");
		for (const rejected of [
			"http://app.ekuaibao.com/web/app.html#/billEntryDetail",
			"https://evil.app.ekuaibao.com/web/app.html#/billEntryDetail",
			"https://app.ekuaibao.com.evil.test/web/app.html#/billEntryDetail",
			"https://user:pass@app.ekuaibao.com/web/app.html#/billEntryDetail",
			"https://app.ekuaibao.com/web/other.html#/billEntryDetail",
			"https://app.ekuaibao.com/web/app.html#/bill",
		]) {
			expect(isEkuaibaoTrustedPageUrl(rejected), rejected).toBe(false);
		}
	});

	it("returns a structured page token, linked application, multi-recipient state, totals and folded rows", async () => {
		const { controller, webContents } = controllerAt(
			"https://app.ekuaibao.com/web/app.html?accessToken=secret#/billEntryDetail",
		);
		const result = await controller.runEkuaibaoTrustedCommand({
			op: "inspect",
			contractVersion: EKUAIBAO_TRUSTED_CONTRACT_VERSION,
		});

		expect(result).toMatchObject({
			ok: true,
			state: {
				pageFingerprint: EKUAIBAO_TRUSTED_PAGE_FINGERPRINT,
				route: "bill-entry-detail",
				multipleRecipients: { present: true, checked: false, source: "native-input" },
				linkedApplication: {
					id: "ID01APPLICATION",
					title: "常州出差",
					startDate: "2026-08-21",
					endDate: "2026-08-21",
				},
				detailCount: 1,
				calculatedTotal: "380.00",
				validationErrors: [],
				foldedDetails: [{ feeType: "transport", amount: "200.00", invoiceCount: 1 }],
			},
		});
		if (!result.ok) throw new Error(result.message);
		expect(result.state.pageToken).toMatch(/^[0-9a-f-]{36}$/);
		expect(result.state.digest).toMatch(/^[0-9a-f]{64}$/);
		const inspectScript = (webContents.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
		expect(() => new Function(String(inspectScript))).not.toThrow();
		expect(inspectScript).toContain("explicitFieldValues(root, ['申请事由', '出差事由', '事由'])");
		expect(inspectScript).toContain("explicitFieldValues(root, ['费用性质'])");
		const applicationSourceParser = String(inspectScript).slice(
			String(inspectScript).indexOf("let applicationSource"),
			String(inspectScript).indexOf("let overlay = 'none'"),
		);
		expect(applicationSourceParser).not.toContain("fieldStates.description");
		expect(applicationSourceParser).not.toContain("fieldStates['expense-nature']");
	});

	it("rejects the wrong origin before executing any page script", async () => {
		const { controller, webContents } = controllerAt("https://attacker.invalid/collect");
		const result = await controller.runEkuaibaoTrustedCommand({
			op: "inspect",
			contractVersion: EKUAIBAO_TRUSTED_CONTRACT_VERSION,
		});
		expect(result).toMatchObject({ ok: false, code: "wrong_page" });
		expect(webContents.executeJavaScript).not.toHaveBeenCalled();
	});

	it("returns application source facts only from the typed application-details overlay", async () => {
		const { controller } = controllerAt(
			"https://app.ekuaibao.com/web/app.html#/billEntryDetail",
			applicationDetailsPage(),
		);
		const result = await controller.runEkuaibaoTrustedCommand({
			op: "inspect",
			contractVersion: EKUAIBAO_TRUSTED_CONTRACT_VERSION,
		});
		expect(result).toMatchObject({
			ok: true,
			state: {
				overlay: "application-details",
				applicationSource: {
					id: "S26002261",
					title: "出差申请：常州业务拓展",
					reason: "常州业务拓展",
					expenseNature: "部门费用",
				},
			},
		});
	});

	it("does not expose main-form defaults as linked-application source facts", async () => {
		const { controller } = controllerAt(
			"https://app.ekuaibao.com/web/app.html#/billEntryDetail",
			inspectedPage({
				fields: {
					description: { present: true, ambiguous: false, value: "主表默认说明" },
					"expense-nature": { present: true, ambiguous: false, value: "部门费用" },
				},
				applicationSource: {
					id: "S26002261",
					title: "出差申请：常州业务拓展",
					reason: "主表默认说明",
					expenseNature: "部门费用",
				},
			}),
		);
		const result = await controller.runEkuaibaoTrustedCommand({
			op: "inspect",
			contractVersion: EKUAIBAO_TRUSTED_CONTRACT_VERSION,
		});
		expect(result).toMatchObject({ ok: true, state: { overlay: "none" } });
		if (!result.ok) throw new Error(result.message);
		expect(result.state.applicationSource).toBeUndefined();
	});

	it("fails closed when application details omit an explicit reason or approved expense nature", async () => {
		for (const applicationSource of [
			{ id: "S26002261", title: "出差申请：常州业务拓展", expenseNature: "部门费用" },
			{ id: "S26002261", title: "出差申请：常州业务拓展", reason: "常州业务拓展", expenseNature: "默认值" },
		]) {
			const { controller } = controllerAt(
				"https://app.ekuaibao.com/web/app.html#/billEntryDetail",
				applicationDetailsPage({ applicationSource }),
			);
			const result = await controller.runEkuaibaoTrustedCommand({
				op: "inspect",
				contractVersion: EKUAIBAO_TRUSTED_CONTRACT_VERSION,
			});
			expect(result).toMatchObject({ ok: false, code: "contract_mismatch" });
		}
	});

	it("binds every mutation to the latest opaque page token and digest", async () => {
		const { controller } = controllerAt("https://app.ekuaibao.com/web/app.html#/billEntryDetail");
		controller.findAndRun = vi.fn(async () => "unexpected");
		const result = await controller.runEkuaibaoTrustedCommand({
			op: "type",
			contractVersion: EKUAIBAO_TRUSTED_CONTRACT_VERSION,
			pageToken: "stale-token",
			expectedDigest: "stale-digest",
			field: "description",
			scope: { kind: "main" },
			value: "常州出差",
		});
		expect(result).toMatchObject({ ok: false, code: "stale_page" });
		expect(controller.findAndRun).not.toHaveBeenCalled();
	});

	it("fails closed when multiple-recipient state cannot be read reliably", async () => {
		const { controller } = controllerAt(
			"https://app.ekuaibao.com/web/app.html#/billEntryDetail",
			inspectedPage({ multipleRecipients: { present: true, source: "ambiguous" } }),
		);
		const inspected = await controller.runEkuaibaoTrustedCommand({
			op: "inspect",
			contractVersion: EKUAIBAO_TRUSTED_CONTRACT_VERSION,
		});
		if (!inspected.ok) throw new Error(inspected.message);
		controller.findAndRun = vi.fn(async () => "unexpected");
		const result = await controller.runEkuaibaoTrustedCommand({
			op: "save-draft",
			contractVersion: EKUAIBAO_TRUSTED_CONTRACT_VERSION,
			pageToken: inspected.state.pageToken,
			expectedDigest: inspected.state.digest,
		});
		expect(result).toMatchObject({ ok: false, code: "contract_mismatch" });
		expect(controller.findAndRun).not.toHaveBeenCalled();
	});

	it("maps save-draft and uploads to fixed internal locators without accepting selectors", async () => {
		const { controller, webContents } = controllerAt("https://app.ekuaibao.com/web/app.html#/billEntryDetail");
		const inspected = await controller.runEkuaibaoTrustedCommand({
			op: "inspect",
			contractVersion: EKUAIBAO_TRUSTED_CONTRACT_VERSION,
		});
		if (!inspected.ok) throw new Error(inspected.message);
		controller.findAndRun = vi.fn(async () => "已点击草稿保存按钮");
		(webContents.executeJavaScript as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce(inspectedPage())
			.mockResolvedValue(
				inspectedPage({
					draftConfirmationVisible: true,
					fingerprintMaterial: "fixture-v1-saved",
				}),
			);
		const saved = await controller.runEkuaibaoTrustedCommand({
			op: "save-draft",
			contractVersion: EKUAIBAO_TRUSTED_CONTRACT_VERSION,
			pageToken: inspected.state.pageToken,
			expectedDigest: inspected.state.digest,
		});
		expect(saved.ok).toBe(true);
		expect(controller.findAndRun).toHaveBeenCalledWith(
			{
				selector: '[data-testid="flexable-button-edit"]',
				scopeTexts: ["差旅费用报销单"],
			},
			{ kind: "click" },
			{ unique: true, trustedEkuaibao: true, draftOnly: true },
		);

		controller.trustedEkuaibaoDraftSaveIntent = "";
		controller.uploadFiles = vi.fn(async () => "已上传");
		if (!saved.ok) throw new Error(saved.message);
		const uploaded = await controller.runEkuaibaoTrustedCommand({
			op: "upload",
			contractVersion: EKUAIBAO_TRUSTED_CONTRACT_VERSION,
			pageToken: saved.state.pageToken,
			expectedDigest: saved.state.digest,
			slot: "smart-invoice",
			scope: { kind: "invoice-dialog", detailKind: "transport" },
			files: [{ name: "ticket.pdf", mimeType: "application/pdf", dataBase64: "UERG" }],
		});
		expect(uploaded.ok).toBe(true);
		expect(controller.uploadFiles).toHaveBeenCalledWith(
			[{ name: "ticket.pdf", mimeType: "application/pdf", dataBase64: "UERG" }],
			{ text: "上传文件", scopeTexts: ["智能识票", "上传文件"] },
			EKUAIBAO_TRUSTED_ORIGIN,
			{
				trustedEkuaibao: true,
				pageToken: saved.state.pageToken,
				expectedDigest: saved.state.digest,
			},
		);
	});

	it("parses comma-grouped reimbursement amounts without truncating them to the leading digit", async () => {
		const pattern = new RegExp(`^${EKUAIBAO_AMOUNT_NUMBER_PATTERN_SOURCE}$`);
		expect(pattern.test("1,234.00")).toBe(true);
		expect(pattern.test("12,345,678.90")).toBe(true);
		expect("1,234.00".replace(/,/g, "")).toBe("1234.00");

		const { controller, webContents } = controllerAt("https://app.ekuaibao.com/web/app.html#/billEntryDetail");
		await controller.runEkuaibaoTrustedCommand({
			op: "inspect",
			contractVersion: EKUAIBAO_TRUSTED_CONTRACT_VERSION,
		});
		const inspectScript = String((webContents.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
		expect(inspectScript).toContain(JSON.stringify(EKUAIBAO_AMOUNT_NUMBER_PATTERN_SOURCE));
		expect(inspectScript).toContain("amountMatch?.replace(/,/g, '')");
		expect(inspectScript).toContain(".exec(text)?.[1]?.replace(/,/g, '')");
	});

	it("keeps the trusted method out of public model tools and preload IPC", () => {
		const tools = readFileSync(join(import.meta.dirname, "..", "src", "agent-browser-tools.ts"), "utf8");
		const preload = readFileSync(join(import.meta.dirname, "..", "installer", "electron", "preload.cjs"), "utf8");
		expect(tools).not.toContain("runEkuaibaoTrustedCommand");
		expect(preload).not.toContain("runEkuaibaoTrustedCommand");
		expect(Object.keys(EKUAIBAO_TRUSTED_DOM_CONTRACT.controls)).not.toEqual(
			expect.arrayContaining(["submit", "send-review", "delete", "multiple-recipients"]),
		);
		expect(Object.keys(EKUAIBAO_TRUSTED_DOM_CONTRACT.controls)).toEqual(
			expect.arrayContaining([
				"open-application-details",
				"close-application-details",
				"open-main-payment-recipient",
				"open-payment-recipient",
				"open-expense-reporter",
				"open-detail",
			]),
		);
		expect(Object.keys(EKUAIBAO_TRUSTED_DOM_CONTRACT.fields)).toEqual(
			expect.arrayContaining(["company", "submitter", "main-payment-recipient", "expense-reporter"]),
		);
		expect(EKUAIBAO_TRUSTED_DOM_CONTRACT.controls["save-detail"]).toMatchObject({
			selector: '[data-testid="feetype-footer-save"]',
			fallbackText: "保存",
		});
	});

	it("opens one folded detail only from typed kind plus fixed business evidence", async () => {
		const main = inspectedPage({ fingerprintMaterial: "fixture-open-detail-main" });
		const drawer = inspectedPage({
			overlay: "detail-drawer",
			fingerprintMaterial: "fixture-open-detail-drawer",
		});
		const { controller, webContents } = controllerAt("https://app.ekuaibao.com/web/app.html#/billEntryDetail", main);
		const inspected = await controller.runEkuaibaoTrustedCommand({
			op: "inspect",
			contractVersion: EKUAIBAO_TRUSTED_CONTRACT_VERSION,
		});
		if (!inspected.ok) throw new Error(inspected.message);
		controller.findAndRun = vi.fn(async () => "已打开唯一费用行");
		(webContents.executeJavaScript as ReturnType<typeof vi.fn>).mockResolvedValueOnce(main).mockResolvedValue(drawer);
		const evidence = ["2026-08-21", "南京", "常州", "二等座", "72.00"];
		const opened = await controller.runEkuaibaoTrustedCommand({
			op: "click",
			contractVersion: EKUAIBAO_TRUSTED_CONTRACT_VERSION,
			pageToken: inspected.state.pageToken,
			expectedDigest: inspected.state.digest,
			control: "open-detail",
			scope: { kind: "main" },
			detailKind: "transport",
			evidence,
			// Runtime input is JavaScript at this boundary. Even if a hostile caller adds
			// selector/ref keys, the controller must derive its target solely from the contract.
			selector: "#submit",
			ref: "attacker-ref",
		} as never);
		expect(opened).toMatchObject({ ok: true, state: { overlay: "detail-drawer" } });
		expect(controller.findAndRun).toHaveBeenCalledWith(
			{
				text: "差旅-城市间交通费-火车I高铁",
				scopeTexts: ["差旅-城市间交通费-火车I高铁", ...evidence],
			},
			{ kind: "click" },
			{ unique: true, trustedEkuaibao: true },
		);
		expect(JSON.stringify((controller.findAndRun as ReturnType<typeof vi.fn>).mock.calls)).not.toContain("#submit");
		expect(JSON.stringify((controller.findAndRun as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
			"attacker-ref",
		);
	});

	it("uses only an exact Chinese 保存 fallback when the stable detail-save selector is absent", async () => {
		const { controller } = controllerAt("https://app.ekuaibao.com/web/app.html#/billEntryDetail");
		const inspected = await controller.runEkuaibaoTrustedCommand({
			op: "inspect",
			contractVersion: EKUAIBAO_TRUSTED_CONTRACT_VERSION,
		});
		if (!inspected.ok) throw new Error(inspected.message);
		controller.findAndRun = vi
			.fn()
			.mockRejectedValueOnce(new Error("可信页面契约没有找到唯一目标"))
			.mockResolvedValueOnce("已点击：保存");
		const result = await controller.runEkuaibaoTrustedCommand({
			op: "click",
			contractVersion: EKUAIBAO_TRUSTED_CONTRACT_VERSION,
			pageToken: inspected.state.pageToken,
			expectedDigest: inspected.state.digest,
			control: "save-detail",
			scope: { kind: "detail-drawer", detailKind: "transport" },
		});
		expect(result.ok).toBe(true);
		expect(controller.findAndRun).toHaveBeenNthCalledWith(
			2,
			{
				text: "保存",
				scopeTexts: ["添加明细", "差旅-城市间交通费-火车I高铁"],
			},
			{ kind: "click" },
			{ unique: true, trustedEkuaibao: true, detailSaveOnly: true, exactLabel: "保存" },
		);
	});

	it("exposes only a typed hover for the current detail invoice menu", async () => {
		const { controller } = controllerAt("https://app.ekuaibao.com/web/app.html#/billEntryDetail");
		const inspected = await controller.runEkuaibaoTrustedCommand({
			op: "inspect",
			contractVersion: EKUAIBAO_TRUSTED_CONTRACT_VERSION,
		});
		if (!inspected.ok) throw new Error(inspected.message);
		controller.findAndRun = vi.fn(async () => "已悬浮：添加发票");
		const result = await controller.runEkuaibaoTrustedCommand({
			op: "hover",
			contractVersion: EKUAIBAO_TRUSTED_CONTRACT_VERSION,
			pageToken: inspected.state.pageToken,
			expectedDigest: inspected.state.digest,
			control: "show-invoice-menu",
			scope: { kind: "detail-drawer", detailKind: "hotel" },
		});
		expect(result.ok).toBe(true);
		expect(controller.findAndRun).toHaveBeenCalledWith(
			{
				text: "添加发票",
				scopeTexts: ["添加明细", "差旅-住宿费", "上传发票"],
			},
			{ kind: "hover" },
			{ unique: true, trustedEkuaibao: true },
		);
	});

	it("opens details only from the selected application row and closes only the verified details overlay", async () => {
		const applicationDialog = inspectedPage({
			overlay: "application-dialog",
			fingerprintMaterial: "fixture-application-dialog",
		});
		const details = applicationDetailsPage();
		const { controller, webContents } = controllerAt(
			"https://app.ekuaibao.com/web/app.html#/billEntryDetail",
			applicationDialog,
		);
		const inspected = await controller.runEkuaibaoTrustedCommand({
			op: "inspect",
			contractVersion: EKUAIBAO_TRUSTED_CONTRACT_VERSION,
		});
		if (!inspected.ok) throw new Error(inspected.message);
		controller.findAndRun = vi.fn(async () => "已点击");
		(webContents.executeJavaScript as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce(applicationDialog)
			.mockResolvedValue(details);
		const opened = await controller.runEkuaibaoTrustedCommand({
			op: "click",
			contractVersion: EKUAIBAO_TRUSTED_CONTRACT_VERSION,
			pageToken: inspected.state.pageToken,
			expectedDigest: inspected.state.digest,
			control: "open-application-details",
			scope: { kind: "application-dialog" },
		});
		expect(opened).toMatchObject({ ok: true, state: { overlay: "application-details" } });
		expect(controller.findAndRun).toHaveBeenNthCalledWith(
			1,
			{ text: "详情", scopeTexts: ["关联申请"] },
			{ kind: "click" },
			{
				unique: true,
				trustedEkuaibao: true,
				selectedApplicationRow: true,
				exactLabels: ["详情", "查看详情"],
			},
		);
		if (!opened.ok) throw new Error(opened.message);
		(webContents.executeJavaScript as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce(details)
			.mockResolvedValue(applicationDialog);
		const closed = await controller.runEkuaibaoTrustedCommand({
			op: "click",
			contractVersion: EKUAIBAO_TRUSTED_CONTRACT_VERSION,
			pageToken: opened.state.pageToken,
			expectedDigest: opened.state.digest,
			control: "close-application-details",
			scope: { kind: "application-details" },
		});
		expect(closed).toMatchObject({ ok: true, state: { overlay: "application-dialog" } });
		expect(controller.findAndRun).toHaveBeenNthCalledWith(
			2,
			{ text: "关闭", scopeTexts: ["申请详情"] },
			{ kind: "click" },
			{ unique: true, trustedEkuaibao: true, exactLabels: ["关闭"] },
		);
	});

	it("re-proves the selected application row immediately before the trusted mouse event", async () => {
		const { controller, webContents } = controllerAt("https://app.ekuaibao.com/web/app.html#/billEntryDetail");
		(webContents.executeJavaScript as ReturnType<typeof vi.fn>)
			.mockReset()
			.mockResolvedValueOnce({
				ok: true,
				pointer: { x: 10, y: 10, kind: "click", token: "fixture-token" },
				label: "详情",
			})
			.mockResolvedValueOnce({ ok: false, error: "fixture-stop-before-pointer" });
		await expect(
			controller.findAndRun(
				{ text: "详情", scopeTexts: ["关联申请"] },
				{ kind: "click" },
				{
					unique: true,
					trustedEkuaibao: true,
					selectedApplicationRow: true,
					exactLabels: ["详情", "查看详情"],
				},
			),
		).rejects.toThrow("fixture-stop-before-pointer");
		const scripts = (webContents.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls.map(([script]) =>
			String(script),
		);
		expect(scripts).toHaveLength(3);
		for (const script of scripts) expect(() => new Function(script)).not.toThrow();
		expect(scripts[0]).toContain("selectedApplicationRow");
		expect(scripts[0]).toContain("uniqueDetails.length === 1 && uniqueDetails[0] === candidate");
		expect(scripts[1]).toContain("无法证明详情控件仍属于唯一已选申请行");
	});
});
