import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type AgentBrowserRuntime,
	deduplicateAgentBrowserSnapshotCandidates,
	redactSensitiveText,
	registerAgentBrowserRuntime,
	resolveSensitiveBrowserUrl,
	vaultSensitiveUrlsInText,
} from "../src/agent-browser-runtime.ts";
import { classifyBrowserClick } from "../src/agent-browser-safety.ts";
import { instantiateAgentBrowserTools, readAgentBrowserUploadFiles } from "../src/agent-browser-tools.ts";

function fakeBrowser(calls: string[], url = "https://example.com"): AgentBrowserRuntime {
	const state = {
		open: true,
		url,
		title: "Example",
		loading: false,
		canGoBack: false,
		canGoForward: false,
		status: "网页已加载",
	};
	return {
		setDownloadDirectory: (path) => calls.push(`download:${path}`),
		open: async () => state,
		hide: () => ({ ...state, open: false }),
		state: () => state,
		navigate: async (url) => {
			calls.push(`navigate:${url}`);
			return { ...state, url };
		},
		back: () => state,
		forward: () => state,
		reload: () => state,
		snapshot: async (options) => {
			calls.push(`snapshot:${JSON.stringify(options)}`);
			return `snapshot:${options.maxChars}`;
		},
		click: async (target) => {
			calls.push(`click:${JSON.stringify(target)}`);
			return `click:${target.ref}`;
		},
		hover: async (target) => {
			calls.push(`hover:${JSON.stringify(target)}`);
			return `hover:${target.text}`;
		},
		type: async (target, value, pressEnter, commit) => {
			calls.push(`type:${target.ref}:${value}:${pressEnter}:${commit}`);
			return `type:${target.ref}:${value}:${pressEnter}:${commit}`;
		},
		scroll: async (direction, amount) => `scroll:${direction}:${amount}`,
		extract: async (selector, maxChars) => `extract:${selector}:${maxChars}`,
		screenshot: async (path) => `screenshot:${path}`,
		wait: async (milliseconds, text) => `wait:${milliseconds}:${text}`,
		uploadFiles: async (files, target, allowedOrigin) => {
			calls.push(
				`upload:${files.map((file) => file.name).join("+")}:${JSON.stringify(target ?? {})}:${allowedOrigin}`,
			);
			return `已选择 ${files.length} 个文件`;
		},
	};
}

describe("客户端浏览器工具", () => {
	it("注册十个中文标注工具并把下载限制到会话工作区", async () => {
		const calls: string[] = [];
		registerAgentBrowserRuntime(fakeBrowser(calls));
		const cwd = mkdtempSync(join(tmpdir(), "pi-browser-tools-"));
		const tools = instantiateAgentBrowserTools(cwd);
		expect(tools).toHaveLength(10);
		expect(tools.map((tool) => `${tool.label}（${tool.name}）`)).toContain("打开网页（browser_navigate）");
		expect(tools.map((tool) => tool.name)).toContain("browser_upload");
		const navigate = tools.find((tool) => tool.name === "browser_navigate");
		const output = await navigate?.execute(
			"call-1",
			{ url: "https://example.com/docs" },
			undefined,
			undefined,
			undefined as never,
		);
		expect(calls).toEqual([`download:${cwd}`, "navigate:https://example.com/docs"]);
		expect(output?.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("https://example.com/docs"),
		});
	});

	it("页面快照默认限制为 6000 字符", async () => {
		const calls: string[] = [];
		registerAgentBrowserRuntime(fakeBrowser(calls));
		const snapshot = instantiateAgentBrowserTools(tmpdir()).find((tool) => tool.name === "browser_snapshot");
		const output = await snapshot?.execute("call-2", {}, undefined, undefined, undefined as never);
		expect(output?.content[0]).toMatchObject({ type: "text", text: "snapshot:6000" });
		expect(calls).toContain('snapshot:{"maxChars":6000,"maxElements":500}');
	});

	it("页面快照接受模型常见的越界请求并在运行时安全裁剪", async () => {
		const calls: string[] = [];
		registerAgentBrowserRuntime(fakeBrowser(calls));
		const snapshot = instantiateAgentBrowserTools(tmpdir()).find((tool) => tool.name === "browser_snapshot");
		expect(snapshot?.parameters).toMatchObject({
			properties: {
				maxChars: { minimum: 100, maximum: 50000 },
				maxElements: { minimum: 1, maximum: 5000 },
			},
		});
		await snapshot?.execute(
			"call-small-snapshot",
			{ maxChars: 800, maxElements: 5 },
			undefined,
			undefined,
			undefined as never,
		);
		await snapshot?.execute(
			"call-large-snapshot",
			{ maxChars: 14000, maxElements: 1400 },
			undefined,
			undefined,
			undefined as never,
		);
		expect(calls).toContain('snapshot:{"maxChars":1000,"maxElements":20}');
		expect(calls).toContain('snapshot:{"maxChars":12000,"maxElements":1000}');
	});

	it("作用域快照和真实悬浮会把范围、序号及 within 原样交给运行时", async () => {
		const calls: string[] = [];
		registerAgentBrowserRuntime(fakeBrowser(calls));
		const tools = instantiateAgentBrowserTools(tmpdir());
		const snapshot = tools.find((tool) => tool.name === "browser_snapshot");
		const hover = tools.find((tool) => tool.name === "browser_hover");
		await snapshot?.execute(
			"call-scope",
			{ maxChars: 4000, maxElements: 700, scopeTexts: ["常州", "¥75.00"] },
			undefined,
			undefined,
			undefined as never,
		);
		const output = await hover?.execute(
			"call-hover",
			{
				text: "添加发票",
				occurrence: 2,
				scopeTexts: ["常州", "南京"],
				within: { selector: '[role="dialog"]', occurrence: 1 },
			},
			undefined,
			undefined,
			undefined as never,
		);
		expect(calls).toContain('snapshot:{"maxChars":4000,"maxElements":700,"scopeTexts":["常州","¥75.00"]}');
		expect(calls).toContain(
			'hover:{"text":"添加发票","occurrence":2,"scopeTexts":["常州","南京"],"within":{"selector":"[role=\\"dialog\\"]","occurrence":1}}',
		);
		expect(output?.content[0]).toMatchObject({ type: "text", text: "hover:添加发票" });
	});

	it("易快报禁止 browser_type 通过回车确认，但普通网页保留该能力", async () => {
		const blockedCalls: string[] = [];
		registerAgentBrowserRuntime(fakeBrowser(blockedCalls, "https://app.ekuaibao.com/web/app.html#/bill"));
		const cwd = mkdtempSync(join(tmpdir(), "pi-browser-enter-"));
		const blockedType = instantiateAgentBrowserTools(cwd).find((tool) => tool.name === "browser_type");
		await expect(
			blockedType?.execute(
				"call-block-enter",
				{ ref: "e12", value: "南京", submit: true },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow("安全策略已禁止在易快报页面通过回车确认");
		expect(blockedCalls).toEqual([`download:${cwd}`]);

		const allowedCalls: string[] = [];
		registerAgentBrowserRuntime(fakeBrowser(allowedCalls));
		const allowedType = instantiateAgentBrowserTools(cwd).find((tool) => tool.name === "browser_type");
		await allowedType?.execute(
			"call-allow-enter",
			{ ref: "e12", value: "南京", submit: true },
			undefined,
			undefined,
			undefined as never,
		);
		expect(allowedCalls).toContain("type:e12:南京:true:true");
	});

	it("浏览器工具输出会脱敏 URL 中的登录令牌，但导航仍收到原始 URL", async () => {
		const calls: string[] = [];
		registerAgentBrowserRuntime(fakeBrowser(calls));
		const navigate = instantiateAgentBrowserTools(tmpdir()).find((item) => item.name === "browser_navigate");
		const raw = "https://app.ekuaibao.com/web/app.html?accessToken=secret-value&provisionalToken=second-secret#/bill";
		const output = await navigate?.execute("call-token", { url: raw }, undefined, undefined, undefined as never);
		const text = output?.content[0]?.type === "text" ? output.content[0].text : "";
		expect(calls).toContain(`navigate:${raw}`);
		expect(text).not.toContain("secret-value");
		expect(text).not.toContain("second-secret");
		expect(text).toContain("[REDACTED]");
	});

	it("用户消息和工具参数只保存内存引用，导航时还原 query 与 hash 中的原始凭据", async () => {
		const calls: string[] = [];
		registerAgentBrowserRuntime(fakeBrowser(calls));
		const navigate = instantiateAgentBrowserTools(tmpdir()).find((item) => item.name === "browser_navigate");
		const raw = "https://app.ekuaibao.com/web/app.html?accessToken=query-secret#/bill?provisionalToken=hash-secret";
		const persistedUrl = vaultSensitiveUrlsInText(raw);
		expect(persistedUrl).not.toContain("query-secret");
		expect(persistedUrl).not.toContain("hash-secret");
		expect(JSON.stringify({ url: persistedUrl })).not.toContain("query-secret");
		expect(JSON.stringify({ url: persistedUrl })).not.toContain("hash-secret");

		const output = await navigate?.execute(
			"call-vaulted-token",
			{ url: persistedUrl },
			undefined,
			undefined,
			undefined as never,
		);
		expect(calls).toContain(`navigate:${raw}`);
		const text = output?.content[0]?.type === "text" ? output.content[0].text : "";
		expect(text).not.toContain("query-secret");
		expect(text).not.toContain("hash-secret");
	});

	it("hash 路由内的敏感查询参数会在所有展示文本中脱敏", () => {
		const raw = "打开 https://example.com/#/bill?accessToken=hash-only-secret&name=visible";
		const redacted = redactSensitiveText(raw);
		expect(redacted).not.toContain("hash-only-secret");
		expect(redacted).toContain("accessToken=[REDACTED]");
		expect(redacted).toContain("name=visible");
	});

	it("编码后的 query/hash 参数名和 URL userinfo 也只持久化内存引用", () => {
		const raw =
			"https://fixture-user:fixture-password@example.com/app?access%54oken=query-sentinel#/bill?provisional%54oken=hash-sentinel";
		const persisted = vaultSensitiveUrlsInText(raw);
		expect(persisted).not.toContain("fixture-user");
		expect(persisted).not.toContain("fixture-password");
		expect(persisted).not.toContain("query-sentinel");
		expect(persisted).not.toContain("hash-sentinel");
		const restored = new URL(resolveSensitiveBrowserUrl(persisted));
		expect(restored.username).toBe("fixture-user");
		expect(restored.password).toBe("fixture-password");
		expect(restored.searchParams.get("accessToken")).toBe("query-sentinel");
		expect(new URLSearchParams(restored.hash.split("?")[1]).get("provisionalToken")).toBe("hash-sentinel");

		const redacted = redactSensitiveText(raw);
		expect(redacted).not.toContain("fixture-user");
		expect(redacted).not.toContain("fixture-password");
		expect(redacted).not.toContain("query-sentinel");
		expect(redacted).not.toContain("hash-sentinel");
		expect(redacted.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(4);
	});

	it("Markdown 链接文字和目标中的凭据都会在持久化前移除", () => {
		const rawUrl = "https://example.com/app?accessToken=markdown-secret#/bill";
		const persisted = vaultSensitiveUrlsInText(`[审批链接](${rawUrl})，备用地址：[${rawUrl}](${rawUrl})`);
		expect(persisted).not.toContain("markdown-secret");
		expect(persisted).toContain("](https://example.com/app?accessToken=pi-browser-secret-");
	});

	it("browser_upload 读取本地文件并传给运行时", async () => {
		const calls: string[] = [];
		registerAgentBrowserRuntime(fakeBrowser(calls));
		const cwd = mkdtempSync(join(tmpdir(), "pi-browser-upload-"));
		writeFileSync(join(cwd, "ticket.png"), "fake-png-bytes");
		const upload = instantiateAgentBrowserTools(cwd).find((tool) => tool.name === "browser_upload");
		const output = await upload?.execute(
			"call-3",
			{
				paths: ["ticket.png"],
				selector: 'input[type="file"]',
				occurrence: 2,
				scopeTexts: ["常州", "南京"],
				within: { selector: '[role="dialog"]', occurrence: 1 },
			},
			undefined,
			undefined,
			undefined as never,
		);
		expect(calls).toEqual([
			`download:${cwd}`,
			'upload:ticket.png:{"selector":"input[type=\\"file\\"]","occurrence":2,"scopeTexts":["常州","南京"],"within":{"selector":"[role=\\"dialog\\"]","occurrence":1}}:https://example.com',
		]);
		expect(output?.content[0]).toMatchObject({ type: "text", text: "已选择 1 个文件" });
	});

	it("公开上传 helper 复用 MIME、base64 和体积限制", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-browser-upload-helper-"));
		writeFileSync(join(cwd, "ticket.pdf"), "fake-pdf-bytes");
		expect(readAgentBrowserUploadFiles(cwd, ["ticket.pdf"])).toEqual([
			{
				name: "ticket.pdf",
				mimeType: "application/pdf",
				dataBase64: Buffer.from("fake-pdf-bytes").toString("base64"),
			},
		]);
		expect(() => readAgentBrowserUploadFiles(cwd, [])).toThrow("请至少提供一个要上传的文件路径");
	});

	it("易快报点击策略默认阻止提交和删除，仅精确放行草稿与附件移除", () => {
		const decide = (label: string, attributeSignal = "", inputType = "button", contextSignal = "") =>
			classifyBrowserClick({
				hostname: "app.ekuaibao.com",
				label,
				attributeSignal,
				contextSignal,
				tagName: "BUTTON",
				inputType,
			});
		for (const label of ["提交", "提交报销单", "送审", "确定并提交", "删除单据", "作废单据", "撤销申请"]) {
			expect(decide(label)).toMatchObject({ allowed: false, kind: "blocked" });
		}
		expect(decide("存为草稿", "flexable-button-submit 草稿")).toMatchObject({ allowed: false });
		expect(decide("存为草稿", "flexable-button-edit", "submit")).toEqual({ allowed: true, kind: "draft" });
		expect(decide("存为草稿", "flexable-button-edit")).toEqual({ allowed: true, kind: "draft" });
		expect(decide("保存", "ant-button flexable-button-edit primary", "submit")).toEqual({
			allowed: true,
			kind: "draft",
		});
		for (const attributes of [
			"flexable-button-edit-submit",
			"flexable-button-edit-delete",
			"flexable-button-edit-destroy",
			"flexable-button-edit_preview",
		]) {
			expect(decide("保存", attributes, "submit")).toMatchObject({ allowed: false, kind: "blocked" });
		}
		expect(decide("保存草稿", "", "submit")).toEqual({ allowed: true, kind: "draft" });
		for (const label of ["确认", "下一步", "完成", "保存"]) {
			expect(decide(label, "", "submit")).toMatchObject({ allowed: false, kind: "blocked" });
		}
		for (const [label, attributes, context] of [
			["删除附件", "trash-icon", ""],
			["移除发票", "remove-icon", ""],
			["删除", "attachment-remove trash-icon", ""],
			["清除", "trash-icon", "upload-list-item ticket.pdf"],
			["删除", "OutlinedEditDeleteTrash", "车票.pdf"],
			["删除", "OutlinedEditDeleteTrash", "attachmentUploadList"],
		] as const) {
			expect(decide(label, attributes, "button", context)).toEqual({ allowed: true, kind: "neutral" });
		}
		for (const [label, attributes, context] of [
			["删除", "trash-icon", ""],
			["移除", "remove-icon", "expense-detail-row"],
			["清空", "clear-button", "报销单"],
			["删除费用明细", "delete-row", "已有发票 1 张"],
			["删除", "profile-remove", "用户资料"],
			["删除", "OutlinedEditDeleteTrash", "费用明细 已有发票*1"],
			["删除", "OutlinedEditDeleteRowTrash", "附件列表 车票.pdf"],
		] as const) {
			expect(decide(label, attributes, "button", context)).toMatchObject({ allowed: false, kind: "blocked" });
		}
		for (const label of [
			"提交人：[已移除]",
			"选择提交人：[已移除]",
			"关联申请 提交人：[已移除] 常州业务拓展",
			"本单据由提交人[已移除]创建",
		]) {
			expect(decide(label)).toEqual({ allowed: true, kind: "neutral" });
		}
		expect(decide("删除单据（提交人：[已移除]）")).toMatchObject({ allowed: false, kind: "blocked" });
		expect(decide("删除单据", "trash-icon", "button", "attachment-list 发票")).toMatchObject({
			allowed: false,
			kind: "blocked",
		});
		expect(classifyBrowserClick({ hostname: "example.com", label: "提交", attributeSignal: "submit" })).toEqual({
			allowed: true,
			kind: "external",
		});
	});

	it("Electron 控制器使用可信鼠标事件实现点击和悬浮", () => {
		const controller = readFileSync(
			join(import.meta.dirname, "..", "installer", "electron", "browser-controller.js"),
			"utf8",
		);
		expect(controller).toContain("只允许保存草稿");
		expect(controller).toContain('sendInputEvent({ type: "mouseMove"');
		expect(controller).toContain('sendInputEvent({ type: "mouseDown"');
		expect(controller).toContain('sendInputEvent({ type: "mouseUp"');
		expect(controller).toContain('response.pointer.kind === "hover"');
		expect(controller).toContain("[data-pi-agent-action-token]");
		expect(controller).toContain("document.elementFromPoint(point.x, point.y)");
		expect(controller).toContain("activation !== clickable");
		expect(controller).toContain("input:not([type=hidden])");
		expect(controller).toContain('[contenteditable]:not([contenteditable="false"])');
		expect(controller).toContain('[tabindex]:not([tabindex="-1"])');
		expect(controller).toContain("[role=menuitemcheckbox]");
		expect(controller).toContain("const expectedLabelControl = Boolean(activation) && clickable.tagName === 'LABEL'");
		expect(controller).toContain("目标内部的独立交互控件");
		expect(controller.match(/await verifyPointerTarget\(\)/g)).toHaveLength(2);
		expect(controller).toContain(
			'view.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });\n\t\t\t\t\tview.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });',
		);
		expect(controller).not.toContain("clickable.click()");
		expect(controller).not.toContain("requestSubmit");
	});

	it("页面快照只折叠同一几何行的包装层与克隆，并保留独立控件和往返两行", () => {
		const candidate = (
			id: string,
			text: string,
			x: number,
			y: number,
			width: number,
			height: number,
			depth: number,
			activationKey = "",
		) => ({
			id,
			text,
			x,
			y,
			width,
			height,
			dedupeDepth: depth,
			dedupeActivationKey: activationKey,
		});
		const outbound = "出发城市：中国 / 江苏省 / 南京 到达城市：中国 / 江苏省 / 常州";
		const inbound = "出发城市：中国 / 江苏省 / 常州 到达城市：中国 / 江苏省 / 南京";
		const nested = Array.from({ length: 7 }, (_value, index) =>
			candidate(`nested-${index}`, outbound, 20 + index, 100 + index, 900 - index * 2, 64 - index * 2, index),
		);
		expect(deduplicateAgentBrowserSnapshotCandidates(nested).map((item) => item.id)).toEqual(["nested-6"]);

		const sameRowClones = [
			candidate("clone-large", outbound, 20, 100, 900, 64, 3),
			candidate("clone-small", outbound, 24, 102, 892, 60, 3),
		];
		expect(deduplicateAgentBrowserSnapshotCandidates(sameRowClones).map((item) => item.id)).toEqual(["clone-small"]);

		const twoRows = [
			candidate("row-1", outbound, 20, 100, 900, 64, 5),
			candidate("row-2", outbound, 20, 180, 900, 64, 5),
		];
		expect(deduplicateAgentBrowserSnapshotCandidates(twoRows).map((item) => item.id)).toEqual(["row-1", "row-2"]);

		const roundTrip = [
			...nested,
			...Array.from({ length: 7 }, (_value, index) =>
				candidate(`inbound-${index}`, inbound, 20 + index, 180 + index, 900 - index * 2, 64 - index * 2, index),
			),
		];
		expect(deduplicateAgentBrowserSnapshotCandidates(roundTrip).map((item) => item.id)).toEqual([
			"nested-6",
			"inbound-6",
		]);

		const independentControls = [
			candidate("edit-a", "编辑", 100, 300, 80, 32, 8, "button-a"),
			candidate("edit-b", "编辑", 100, 300, 80, 32, 8, "button-b"),
		];
		expect(deduplicateAgentBrowserSnapshotCandidates(independentControls).map((item) => item.id)).toEqual([
			"edit-a",
			"edit-b",
		]);
	});

	it("Electron 控制器支持作用域快照、隐藏上传框和严格定向上传", () => {
		const controller = readFileSync(
			join(import.meta.dirname, "..", "installer", "electron", "browser-controller.js"),
			"utf8",
		);
		expect(controller).toContain("const maxElements = Math.max(20");
		expect(controller).toContain("const scopeTexts = Array.isArray(requested.scopeTexts)");
		expect(controller).toContain("contentScopes.length ? contentScopes : [...overlays, ...roots]");
		expect(controller).toContain(
			"!preferredScopes.some((other) => other !== candidate && candidate.contains(other))",
		);
		expect(controller).toContain("deduplicateAgentBrowserSnapshotCandidates(snapshot.elements, maxElements)");
		expect(controller).toContain("dedupeActivationKey: activationKey(element)");
		expect(controller).toContain("const isFileInput = element.matches?.('input[type=\"file\"]')");
		expect(controller).not.toContain("slice(0, 200)");
		expect(controller).toContain("CSS selector 匹配到 ' + candidates.length + ' 个元素，请提供 occurrence");
		expect(controller).toContain("指定的上传目标不存在，未回退到全页上传框");
		expect(controller).toContain("const hasAnchorLocator = Boolean(target.ref || target.selector || target.text)");
		expect(controller).toContain("指定的上传目标不存在，未回退到 within、弹窗或全页上传框");
		expect(controller).toContain("withinElement.contains(anchor.control)");
		expect(controller).toContain("withinElement.contains(controlled)");
		expect(controller).toContain("const boundaryInputs = queryAll('input[type=file]', boundaryBases)");
		expect(controller).toContain("指定目标最近边界内存在多个上传框，已拒绝猜测");
		expect(controller).not.toContain("const nearby = [...container.querySelectorAll?.('input[type=file]') || []]");
		expect(controller).not.toContain("const overlayWithInputs = overlays.find");
		expect(controller).toContain("已拒绝默认选择第一个");
		expect(controller).toContain("同一最近边界内的唯一 file input");
		expect(controller).toContain("data-pi-trusted-upload-token");
		expect(controller).toContain("await revalidateTrustedUpload()");
		expect(controller).toContain("const UPLOAD_ISOLATED_WORLD_ID = 1001");
		expect(controller).toContain("executeJavaScriptInIsolatedWorld(");
		expect(controller).toContain("startOrigin !== lockedOrigin");
		expect(controller).toContain("当前页面来源与调用方锁定来源不一致");
		expect(controller).toContain("globalThis.__piUploadSession");
		expect(controller).toContain('webContents.on("did-start-navigation", onNavigation)');
		expect(controller).toContain('webContents.removeListener("did-start-navigation", onNavigation)');
		expect(controller).toContain("location.href !==");
		expect(controller).toContain("location.origin !==");
		expect(controller).not.toContain("window.__piUploadFiles");
		expect(controller.match(/const hasLocalScope =/g)).toHaveLength(2);
		expect(controller).toContain("node === document.body || node === document.documentElement");
		expect(controller).toContain("isOverlayScope || scopedText.length <= 2500");
		expect(controller).not.toContain("depth < 16");
	});

	it("Electron 快照暴露复选框状态，点击层对提交与删除采用默认拒绝", () => {
		const controller = readFileSync(
			join(import.meta.dirname, "..", "installer", "electron", "browser-controller.js"),
			"utf8",
		);
		expect(controller).toContain("Boolean(element.checked)");
		expect(controller).toContain('ariaChecked: element.getAttribute("aria-checked")');
		expect(controller).toContain("checked=" + "$" + "{element.checked}");
		expect(controller).toContain("aria-checked=" + "$" + "{element.ariaChecked}");
		expect(controller).toContain("submitControl && !isDraft");
		expect(controller).toContain("const destructive = new RegExp(safetyPatterns.destructiveAttribute");
		expect(controller).toContain("const attachmentRemoval = explicitAttachmentAction || Boolean(contextSignal)");
		expect(controller).toContain("depth <= 2 && fullNodeText.length <= 240 ? fullNodeText : ''");
		expect(controller).toContain("没有明确附件上下文的删除或移除操作");
		expect(controller).toContain(".replace(/([a-z0-9])([A-Z])/g, '$1 $2')");
		expect(controller).toContain("目标元素位于内嵌框架");
		expect(controller).toContain("const locatorSignal = [target.selector || '', target.text || '']");
		expect(controller).toContain("new RegExp(safetyPatterns.draftAttribute, 'i').test(' ' + attributeSignal + ' ')");
		expect(controller).toContain("action.kind === 'type' && action.pressEnter && isEkuaibao");
	});

	it("浏览器公开接口、工具、安全策略和 pack 清单与安装版镜像完全一致", () => {
		for (const relativePath of [
			"src/agent-browser-runtime.ts",
			"src/agent-browser-tools.ts",
			"src/agent-browser-safety.ts",
			"packs/agent-browser/pack.json",
		]) {
			const source = readFileSync(join(import.meta.dirname, "..", relativePath), "utf8");
			const packaged = readFileSync(join(import.meta.dirname, "..", "installer", "electron", relativePath), "utf8");
			expect(packaged).toBe(source);
		}
	});

	it("聊天界面发送前只显示敏感链接的脱敏副本", () => {
		const source = readFileSync(join(import.meta.dirname, "..", "web", "app.js"), "utf8");
		const packaged = readFileSync(join(import.meta.dirname, "..", "installer", "electron", "web", "app.js"), "utf8");
		expect(source).toBe(packaged);
		expect(source).toContain("function redactSensitiveDisplayText(value)");
		expect(source).toContain("redactSensitiveDisplayText(text ||");
		expect(source).toContain("attachmentsToSend.length");
		expect(source).toContain("redactSensitiveDisplayText(\n\t\t\t\t\titem.text");
	});

	it("browser_upload 拒绝不存在的文件", async () => {
		registerAgentBrowserRuntime(fakeBrowser([]));
		const upload = instantiateAgentBrowserTools(tmpdir()).find((tool) => tool.name === "browser_upload");
		await expect(
			upload?.execute("call-4", { paths: ["不存在的文件.png"] }, undefined, undefined, undefined as never),
		).rejects.toThrow();
	});
});
