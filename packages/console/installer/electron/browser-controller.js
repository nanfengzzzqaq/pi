import { WebContentsView, session } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import {
	agentBrowserUploadOrigin,
	deduplicateAgentBrowserSnapshotCandidates,
	EKUAIBAO_TRUSTED_CONTRACT_VERSION,
	EKUAIBAO_TRUSTED_ORIGIN,
	EKUAIBAO_TRUSTED_PAGE_FINGERPRINT,
	isEkuaibaoTrustedPageUrl,
	redactSensitiveText,
	redactSensitiveUrl,
} from "./src/agent-browser-runtime.ts";
import {
	EKUAIBAO_ATTACHMENT_ACTION_PATTERN,
	EKUAIBAO_ATTACHMENT_CONTEXT_PATTERN,
	EKUAIBAO_DANGEROUS_ATTRIBUTE_PATTERN,
	EKUAIBAO_DANGEROUS_LABEL_PATTERN,
	EKUAIBAO_DESTRUCTIVE_ATTRIBUTE_PATTERN,
	EKUAIBAO_DESTRUCTIVE_LABEL_PATTERN,
	EKUAIBAO_DRAFT_ATTRIBUTE_PATTERN,
	EKUAIBAO_DRAFT_LABEL_PATTERN,
	EKUAIBAO_ROW_CONTEXT_PATTERN,
} from "./src/agent-browser-safety.ts";

const BROWSER_PARTITION = "persist:pi-agent-browser";
const EMPTY_PAGE = "about:blank";
const UPLOAD_ISOLATED_WORLD_ID = 1001;

export const EKUAIBAO_AMOUNT_NUMBER_PATTERN_SOURCE = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?`;

const EKUAIBAO_FEE_TYPES = Object.freeze({
	transport: "差旅-城市间交通费-火车I高铁",
	hotel: "差旅-住宿费",
	allowance: "差旅-出差补助",
});

const EKUAIBAO_SCOPE_KINDS = new Set([
	"main",
	"application-dialog",
	"application-details",
	"detail-picker",
	"detail-drawer",
	"invoice-menu",
	"invoice-dialog",
	"invoice-results",
]);

const EKUAIBAO_READ_ONLY_FIELDS = new Set(["company", "submitter"]);

/**
 * This is the only selector/label table used by the typed EasyBao command
 * boundary. Callers select a semantic key; they cannot supply selectors or refs.
 */
export const EKUAIBAO_TRUSTED_DOM_CONTRACT = Object.freeze({
	fields: Object.freeze({
		"application-search": Object.freeze({
			scopes: ["application-dialog"],
			selector: 'input[placeholder="搜索标题和单号"]',
			label: "搜索标题和单号",
		}),
		company: Object.freeze({ scopes: ["main"], label: "所属公司" }),
		description: Object.freeze({ scopes: ["main"], selector: '[data-testid="field-text-u_事由"]', label: "报销说明" }),
		submitter: Object.freeze({ scopes: ["main"], label: "提交人" }),
		station: Object.freeze({ scopes: ["main"], label: "驻地" }),
		"reimbursement-date": Object.freeze({ scopes: ["main"], label: "报销日期" }),
		"expense-nature": Object.freeze({ scopes: ["main"], label: "费用性质" }),
		"applicant-department": Object.freeze({ scopes: ["main"], label: "申请人部门" }),
		"expense-department": Object.freeze({ scopes: ["main"], label: "费用所属部门" }),
		"main-payment-recipient": Object.freeze({ scopes: ["main"], label: "支付信息" }),
		"fee-type-search": Object.freeze({ scopes: ["detail-picker"], label: "费用类型" }),
		"detail-start-date": Object.freeze({
			scopes: ["detail-drawer"],
			selector: 'input[placeholder="开始日期"]',
			label: "开始日期",
		}),
		"detail-end-date": Object.freeze({
			scopes: ["detail-drawer"],
			selector: 'input[placeholder="结束日期"]',
			label: "结束日期",
		}),
		"departure-city": Object.freeze({ scopes: ["detail-drawer"], label: "出发城市" }),
		"arrival-city": Object.freeze({ scopes: ["detail-drawer"], label: "到达城市" }),
		"seat-class": Object.freeze({ scopes: ["detail-drawer"], label: "乘坐火车席别" }),
		"reimbursement-amount": Object.freeze({ scopes: ["detail-drawer"], label: "报销费用金额" }),
		"expense-reporter": Object.freeze({ scopes: ["detail-drawer"], label: "费用报销人" }),
		"payment-recipient": Object.freeze({ scopes: ["detail-drawer"], label: "支付信息" }),
		"allowance-type": Object.freeze({ scopes: ["detail-drawer"], label: "补助类型" }),
	}),
	controls: Object.freeze({
		"open-application": Object.freeze({
			scopes: ["main"],
			selector: '[data-testid="field-expenseLink-select"]',
			scopeTexts: ["关联申请"],
		}),
		"confirm-application": Object.freeze({ scopes: ["application-dialog"], text: "确定", fallbackText: "确认" }),
		"open-application-details": Object.freeze({ scopes: ["application-dialog"], text: "详情" }),
		"close-application-details": Object.freeze({ scopes: ["application-details"], text: "关闭" }),
		"open-main-payment-recipient": Object.freeze({ scopes: ["main"], label: "支付信息" }),
		"open-payment-recipient": Object.freeze({ scopes: ["detail-drawer"], label: "支付信息" }),
		"open-expense-reporter": Object.freeze({ scopes: ["detail-drawer"], label: "费用报销人" }),
		"add-detail": Object.freeze({
			scopes: ["main"],
			selector: '[data-testid="field-expenseDetail-add"]',
			scopeTexts: ["费用明细"],
		}),
		"open-detail": Object.freeze({ scopes: ["main"], text: "费用明细" }),
		"show-invoice-menu": Object.freeze({ scopes: ["detail-drawer"], text: "添加发票", scopeTexts: ["上传发票"] }),
		"open-smart-invoice": Object.freeze({ scopes: ["invoice-menu"], text: "智能识票" }),
		"confirm-invoice-upload": Object.freeze({ scopes: ["invoice-dialog"], text: "确定" }),
		"bind-recognized-invoice": Object.freeze({ scopes: ["invoice-results"], text: "与该消费绑定" }),
		"save-detail": Object.freeze({
			scopes: ["detail-drawer"],
			selector: '[data-testid="feetype-footer-save"]',
			fallbackText: "保存",
			scopeTexts: ["添加明细"],
		}),
		"close-detail": Object.freeze({ scopes: ["detail-drawer"], text: "关闭" }),
	}),
	uploadSlots: Object.freeze({
		"smart-invoice": Object.freeze({ scopes: ["invoice-dialog"], text: "上传文件" }),
		"detail-attachments": Object.freeze({ scopes: ["detail-drawer"], text: "附件" }),
	}),
	saveDraft: Object.freeze({
		selector: '[data-testid="flexable-button-edit"]',
		scopeTexts: ["差旅费用报销单"],
	}),
});

const EKUAIBAO_INSPECT_FIELDS = Object.freeze(
	Object.fromEntries(
		Object.entries(EKUAIBAO_TRUSTED_DOM_CONTRACT.fields).map(([key, entry]) => [
			key,
			{ selector: entry.selector || "", label: entry.label || "", scopes: entry.scopes || [] },
		]),
	),
);

const EKUAIBAO_INSPECT_CONTROLS = Object.freeze({
	...Object.fromEntries(
		Object.entries(EKUAIBAO_TRUSTED_DOM_CONTRACT.controls).map(([key, entry]) => [
			key,
			{
				selector: entry.selector || "",
				text: entry.text || "",
				fallbackText: entry.fallbackText || "",
				scopes: entry.scopes || [],
			},
		]),
	),
	"save-draft": { selector: EKUAIBAO_TRUSTED_DOM_CONTRACT.saveDraft.selector, text: "", scopes: ["main"] },
});

function trustedEkuaibaoError(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

function cleanText(value) {
	return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizedUrl(value) {
	const input = String(value ?? "").trim();
	if (!input) return EMPTY_PAGE;
	if (/^https?:\/\//i.test(input)) return input;
	if (/^[\w.-]+\.[A-Za-z]{2,}(?:[/:?#]|$)/.test(input)) return `https://${input}`;
	return `https://www.bing.com/search?q=${encodeURIComponent(input)}`;
}

function uniqueFilePath(directory, fileName) {
	const safeName = basename(fileName).replace(/[\\/:*?"<>|]/g, "_") || "下载文件";
	const extension = extname(safeName);
	const stem = basename(safeName, extension);
	let candidate = join(directory, safeName);
	let index = 1;
	while (existsSync(candidate)) {
		candidate = join(directory, `${stem} (${index})${extension}`);
		index++;
	}
	return candidate;
}

export class AgentBrowserController {
	constructor(options) {
		this.getWindow = options.getWindow;
		this.dataDir = options.dataDir;
		this.onState = options.onState;
		this.view = null;
		this.isOpen = false;
		this.bounds = { x: 0, y: 0, width: 0, height: 0 };
		this.status = "浏览器已准备";
		this.downloadDirectory = join(this.dataDir, "browser-downloads");
		this.trustedEkuaibaoPageToken = "";
		this.trustedEkuaibaoDraftSaveIntent = "";
		this.trustedEkuaibaoCommandActive = false;
		this.browserSession = session.fromPartition(BROWSER_PARTITION, { cache: true });
		this.configureDownloads();
	}

	invalidateTrustedEkuaibaoPage() {
		this.trustedEkuaibaoPageToken = "";
		this.trustedEkuaibaoDraftSaveIntent = "";
	}

	configureDownloads() {
		this.browserSession.on("will-download", (_event, item) => {
			mkdirSync(this.downloadDirectory, { recursive: true });
			const target = uniqueFilePath(this.downloadDirectory, item.getFilename());
			item.setSavePath(target);
			this.status = `正在下载：${item.getFilename()}`;
			this.emitState();
			item.once("done", (_doneEvent, state) => {
				this.status = state === "completed" ? `下载完成：${target}` : `下载未完成：${item.getFilename()}`;
				this.emitState(state === "completed" ? { downloadPath: target } : {});
			});
		});
	}

	setDownloadDirectory(path) {
		if (typeof path === "string" && path.trim()) this.downloadDirectory = path;
	}

	ensureView() {
		if (this.view && !this.view.webContents.isDestroyed()) return this.view;
		const window = this.getWindow();
		if (!window || window.isDestroyed()) throw new Error("Pi 客户端窗口尚未准备完成");
		const view = new WebContentsView({
			webPreferences: {
				partition: BROWSER_PARTITION,
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
				backgroundThrottling: false,
			},
		});
		this.view = view;
		window.contentView.addChildView(view);
		view.setBounds(this.bounds);
		view.setVisible(this.isOpen);
		const contents = view.webContents;
		contents.setWindowOpenHandler(({ url }) => {
			if (/^https?:\/\//i.test(url)) void contents.loadURL(url);
			return { action: "deny" };
		});
		contents.on("did-start-loading", () => {
			this.status = "正在加载网页";
			this.emitState();
		});
		contents.on("did-stop-loading", () => {
			this.status = "网页已加载";
			this.emitState();
		});
		contents.on("did-start-navigation", (_event, _url, _isInPlace, isMainFrame) => {
			if (isMainFrame !== false) this.invalidateTrustedEkuaibaoPage();
		});
		contents.on("did-navigate", () => {
			this.invalidateTrustedEkuaibaoPage();
			this.emitState();
		});
		contents.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
			if (isMainFrame !== false) this.invalidateTrustedEkuaibaoPage();
			this.emitState();
		});
		contents.on("page-title-updated", () => this.emitState());
		contents.on("render-process-gone", (_event, details) => {
			this.status = `网页进程已停止：${details.reason}`;
			this.emitState();
		});
		void contents.loadURL(EMPTY_PAGE);
		return view;
	}

	emitState(extra = {}) {
		const state = { ...this.state(), ...extra };
		this.onState(state);
		return state;
	}

	state() {
		const contents = this.view && !this.view.webContents.isDestroyed() ? this.view.webContents : null;
		const rawUrl = contents?.getURL() || "";
		return {
			open: this.isOpen,
			url: rawUrl === EMPTY_PAGE ? "" : redactSensitiveUrl(rawUrl),
			title: redactSensitiveText(cleanText(contents?.getTitle())),
			loading: contents?.isLoading() ?? false,
			canGoBack: contents?.navigationHistory.canGoBack() ?? false,
			canGoForward: contents?.navigationHistory.canGoForward() ?? false,
			status: redactSensitiveText(this.status),
		};
	}

	setBounds(bounds) {
		const window = this.getWindow();
		if (!window || window.isDestroyed()) return;
		const contentBounds = window.getContentBounds();
		const x = Math.max(0, Math.round(Number(bounds?.x) || 0));
		const y = Math.max(0, Math.round(Number(bounds?.y) || 0));
		const width = Math.max(0, Math.min(Math.round(Number(bounds?.width) || 0), contentBounds.width - x));
		const height = Math.max(0, Math.min(Math.round(Number(bounds?.height) || 0), contentBounds.height - y));
		this.bounds = { x, y, width, height };
		if (this.view && !this.view.webContents.isDestroyed()) this.view.setBounds(this.bounds);
	}

	async open(url) {
		const view = this.ensureView();
		this.isOpen = true;
		view.setVisible(true);
		this.emitState();
		if (url) return this.navigate(url);
		return this.state();
	}

	hide() {
		this.isOpen = false;
		if (this.view && !this.view.webContents.isDestroyed()) {
			void this.view.webContents.executeJavaScript("window.__piCancelElementPick?.()").catch(() => {});
			this.view.setVisible(false);
		}
		return this.emitState();
	}

	async navigate(url) {
		const view = this.ensureView();
		this.isOpen = true;
		view.setVisible(true);
		const target = normalizedUrl(url);
		this.status = `正在打开：${redactSensitiveUrl(target)}`;
		this.emitState();
		await view.webContents.loadURL(target);
		return this.emitState();
	}

	async back() {
		const view = this.ensureView();
		if (view.webContents.navigationHistory.canGoBack()) view.webContents.navigationHistory.goBack();
		return this.emitState();
	}

	async forward() {
		const view = this.ensureView();
		if (view.webContents.navigationHistory.canGoForward()) view.webContents.navigationHistory.goForward();
		return this.emitState();
	}

	async reload() {
		const view = this.ensureView();
		view.webContents.reload();
		return this.emitState();
	}

	toggleDevtools() {
		const view = this.ensureView();
		if (view.webContents.isDevToolsOpened()) view.webContents.closeDevTools();
		else view.webContents.openDevTools({ mode: "detach", activate: true });
		this.status = view.webContents.isDevToolsOpened() ? "开发者工具已打开" : "开发者工具已关闭";
		return this.emitState();
	}

	/**
	 * 让用户直接在独立浏览器里点选网页元素。只返回精简的可验证引用，
	 * 由渲染进程决定是否加入输入框，不会自动发送给模型。
	 */
	async pickElement() {
		const view = this.ensureView();
		await this.open();
		this.status = "请选择网页元素（browser_pick）";
		this.emitState();
		const picked = await view.webContents.executeJavaScript(`new Promise((resolve) => {
			window.__piCancelElementPick?.();
			const overlay = document.createElement('div');
			overlay.setAttribute('data-pi-element-picker', '');
			Object.assign(overlay.style, {
				position: 'fixed', zIndex: '2147483647', pointerEvents: 'none',
				border: '2px solid #4f7cff', background: 'rgba(79,124,255,.12)',
				boxSizing: 'border-box', display: 'none'
			});
			document.documentElement.appendChild(overlay);
			const cssPath = (element) => {
				if (element.id) return '#' + CSS.escape(element.id);
				const parts = [];
				let node = element;
				while (node && node.nodeType === 1 && node !== document.documentElement) {
					let part = node.tagName.toLowerCase();
					const testId = node.getAttribute('data-testid') || node.getAttribute('data-test');
					if (testId) { part += '[data-testid="' + CSS.escape(testId) + '"]'; parts.unshift(part); break; }
					const siblings = node.parentElement ? [...node.parentElement.children].filter((item) => item.tagName === node.tagName) : [];
					if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
					parts.unshift(part);
					node = node.parentElement;
				}
				return parts.join(' > ');
			};
			const cleanup = (result) => {
				document.removeEventListener('mouseover', onHover, true);
				document.removeEventListener('click', onClick, true);
				document.removeEventListener('keydown', onKey, true);
				overlay.remove();
				delete window.__piCancelElementPick;
				resolve(result);
			};
			const onHover = (event) => {
				const rect = event.target.getBoundingClientRect();
				Object.assign(overlay.style, {
					display: 'block', left: rect.left + 'px', top: rect.top + 'px',
					width: rect.width + 'px', height: rect.height + 'px'
				});
			};
			const onClick = (event) => {
				event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
				const element = event.target;
				const rect = element.getBoundingClientRect();
				cleanup({
					title: document.title, url: location.href,
					text: (element.innerText || element.value || element.getAttribute('aria-label') || element.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 500),
					selector: cssPath(element),
					x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height)
				});
			};
			const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); cleanup(null); } };
			window.__piCancelElementPick = () => cleanup(null);
			document.addEventListener('mouseover', onHover, true);
			document.addEventListener('click', onClick, true);
			document.addEventListener('keydown', onKey, true);
		})`, true);
		if (picked) {
			picked.url = redactSensitiveUrl(picked.url);
			picked.text = redactSensitiveText(picked.text);
			picked.title = redactSensitiveText(picked.title);
		}
		this.status = picked ? "网页元素已加入输入框" : "已取消选取网页元素";
		this.emitState();
		return picked;
	}

	async snapshot(options) {
		const view = this.ensureView();
		await this.open();
		this.status = "正在获取页面状态（browser_snapshot）";
		this.emitState();
		const requested = typeof options === "number" ? { maxChars: options } : options ?? {};
		const limit = Math.max(1000, Math.min(Number(requested.maxChars) || 6000, 12000));
		const maxElements = Math.max(20, Math.min(Number(requested.maxElements) || 500, 1000));
		const scopeTexts = Array.isArray(requested.scopeTexts)
			? requested.scopeTexts.map((item) => cleanText(item)).filter(Boolean).slice(0, 8)
			: [];
		const snapshot = await view.webContents.executeJavaScript(`(() => {
			const maxElements = ${maxElements};
			const scopeTexts = ${JSON.stringify(scopeTexts)};
			const readable = (element) => (
				element?.innerText || element?.value || element?.getAttribute?.('aria-label') ||
				element?.getAttribute?.('title') || element?.getAttribute?.('placeholder') ||
				element?.getAttribute?.('data-testid') || element?.getAttribute?.('data-test') || ''
			).replace(/\\s+/g, ' ').trim();
			const visible = (element) => {
				const style = getComputedStyle(element);
				const rect = element.getBoundingClientRect();
				return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
			};
			const roots = [document];
			for (let index = 0; index < roots.length; index++) {
				const root = roots[index];
				for (const node of root.querySelectorAll('*')) {
					if (node.shadowRoot) roots.push(node.shadowRoot);
					if (node.tagName === 'IFRAME') {
						try { if (node.contentDocument) roots.push(node.contentDocument); } catch { /* cross-origin */ }
					}
				}
			}
			const queryAll = (selector, bases = roots) => {
				const found = [];
				const seen = new Set();
				for (const base of bases) {
					if (base.matches?.(selector) && !seen.has(base)) { seen.add(base); found.push(base); }
					for (const item of base.querySelectorAll?.(selector) || []) {
						if (!seen.has(item)) { seen.add(item); found.push(item); }
					}
				}
				return found;
			};
			const layer = (element) => {
				let value = 0;
				for (let node = element; node?.nodeType === 1; node = node.parentElement) {
					const parsed = Number.parseInt(getComputedStyle(node).zIndex, 10);
					if (Number.isFinite(parsed)) value = Math.max(value, parsed);
				}
				return value;
			};
			const overlaySelector = '[role="dialog"],[aria-modal="true"],.ant-modal-wrap,.ant-drawer-content-wrapper,[class*="drawer-content"],[class*="modal-content"]';
			const overlays = queryAll(overlaySelector).filter(visible).sort((left, right) => layer(right) - layer(left));
			const scopeSelector = 'section,article,form,li,tr,[role="row"],[role="dialog"],[class*="item"],[class*="card"],[class*="detail"],[class*="drawer"],[class*="modal"],div';
			let contentScopes = [];
			if (scopeTexts.length) {
				const matchingScopes = queryAll(scopeSelector)
					.filter((element) => visible(element) && scopeTexts.every((text) => readable(element).includes(text)));
				const overlayScopes = matchingScopes.filter((element) =>
					overlays.some((overlay) => overlay === element || overlay.contains(element)),
				);
				const preferredScopes = overlayScopes.length ? overlayScopes : matchingScopes;
				contentScopes = preferredScopes
					.filter((candidate) => !preferredScopes.some((other) => other !== candidate && candidate.contains(other)))
					.sort((left, right) => readable(left).length - readable(right).length || layer(right) - layer(left))
					.slice(0, 12);
			}
			const searchScopes = contentScopes.length ? contentScopes : [...overlays, ...roots];
			const selector = "a,button,input,textarea,select,summary,label,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=combobox],[role=option],[contenteditable=true],[data-testid],[data-test],[placeholder],[onclick],[tabindex]:not([tabindex='-1'])";
			const activationSelector = 'a[href],area[href],button,input:not([type=hidden]),select,textarea,summary,details,label,iframe,object,embed,audio[controls],video[controls],[contenteditable]:not([contenteditable="false"]),[tabindex]:not([tabindex="-1"]),[role=button],[role=link],[role=option],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=switch],[role=combobox],[role=slider],[role=spinbutton],[role=textbox],[role=treeitem],[data-testid],[data-test],[onclick],[onmousedown],[onmouseup],[onpointerdown],[onpointerup]';
			const normalizedReadable = (element) => readable(element).replace(/[\\s/：:（）()_-]+/g, '').toLocaleLowerCase('zh-CN');
			const elementDepth = (element) => {
				let depth = 0;
				for (let node = element; node; node = node.parentElement || node.getRootNode?.()?.host || null) depth++;
				return depth;
			};
			const activationIds = new WeakMap();
			let activationSequence = 0;
			const activationKey = (element) => {
				const expectedText = normalizedReadable(element);
				const matchingDescendants = [...element.querySelectorAll?.(activationSelector) || []]
					.filter((candidate) => visible(candidate) && normalizedReadable(candidate) === expectedText)
					.sort((left, right) => {
						const depth = elementDepth(right) - elementDepth(left);
						if (depth !== 0) return depth;
						const leftRect = left.getBoundingClientRect();
						const rightRect = right.getBoundingClientRect();
						return leftRect.width * leftRect.height - rightRect.width * rightRect.height;
					});
				const activation = matchingDescendants[0] || (element.matches?.(activationSelector) ? element : element.closest?.(activationSelector));
				if (!activation) return '';
				if (!activationIds.has(activation)) activationIds.set(activation, 'a' + (++activationSequence));
				return activationIds.get(activation);
			};
			const elements = [];
			const seenElements = new Set();
			const candidateLimit = Math.min(4000, Math.max(maxElements + 100, maxElements * 4));
			for (const scope of searchScopes) {
				const semantic = queryAll(selector, [scope]);
				const pointerElements = queryAll('div,span,li', [scope]).filter((element) => visible(element) && getComputedStyle(element).cursor === 'pointer');
				for (const element of [...semantic, ...pointerElements]) {
					const isFileInput = element.matches?.('input[type="file"]');
					if ((!visible(element) && !isFileInput) || seenElements.has(element)) continue;
					seenElements.add(element);
					elements.push(element);
					if (elements.length >= candidateLimit) break;
				}
				if (elements.length >= candidateLimit) break;
			}
			window.__piAgentRefSequence = Number(window.__piAgentRefSequence) || 0;
			const usedRefs = new Set();
			const serialized = elements.map((element) => {
				let ref = element.getAttribute('data-pi-agent-ref') || '';
				if (!ref || usedRefs.has(ref)) {
					ref = 'e' + (++window.__piAgentRefSequence);
					element.setAttribute('data-pi-agent-ref', ref);
				}
				usedRefs.add(ref);
				const rect = element.getBoundingClientRect();
				let fieldLabel = [...(element.labels || [])].map((label) => label.innerText || label.textContent || '').join(' ').replace(/\\s+/g, ' ').trim();
				if (!fieldLabel && element.getAttribute('aria-labelledby')) {
					fieldLabel = element.getAttribute('aria-labelledby').split(/\\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ').replace(/\\s+/g, ' ').trim();
				}
				if (!fieldLabel) {
					let container = element.parentElement;
					for (let depth = 0; depth < 6 && container; depth++, container = container.parentElement) {
						const candidate = container.querySelector(':scope > label, :scope > [class*="field-label"], :scope > [class*="form-item-label"]');
						if (candidate) { fieldLabel = (candidate.innerText || candidate.textContent || '').replace(/\\s+/g, ' ').trim(); break; }
					}
				}
				let context = '';
				if (element.matches?.('input[type="file"]')) {
					let container = element.parentElement;
					for (let depth = 0; depth < 7 && container; depth++, container = container.parentElement) {
						const candidate = readable(container);
						if (candidate && candidate.length <= 500) { context = candidate; break; }
					}
				}
				return {
					ref,
					tag: element.tagName.toLowerCase(),
					role: element.getAttribute("role") || "",
					text: (element.innerText || element.value || element.getAttribute("aria-label") || element.getAttribute("title") || element.getAttribute("placeholder") || element.getAttribute("data-testid") || element.getAttribute("data-test") || "").replace(/\\s+/g, " ").trim().slice(0, 180),
					dedupeText: readable(element).slice(0, 1000),
					testId: element.getAttribute("data-testid") || element.getAttribute("data-test") || "",
					placeholder: element.getAttribute("placeholder") || "",
					name: element.getAttribute("name") || "",
					type: element.getAttribute("type") || "",
					fieldLabel: fieldLabel.slice(0, 100),
					href: element.href || "",
					disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
					checked: element.matches?.('input[type="checkbox"],input[type="radio"]') ? Boolean(element.checked) : null,
					ariaChecked: element.getAttribute("aria-checked"),
					hidden: !visible(element),
					context: context.slice(0, 180),
					x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height),
					dedupeDepth: elementDepth(element),
					dedupeActivationKey: activationKey(element),
				};
			});
			const bodyRoot = contentScopes[0] || overlays[0] || document.body;
			return {
				url: location.href,
				title: document.title,
				text: (bodyRoot?.innerText || bodyRoot?.textContent || "").replace(/\\n{3,}/g, "\\n\\n").slice(0, ${limit}),
				elements: serialized,
				scopeMatched: !scopeTexts.length || contentScopes.length > 0,
			};
		})()`);
		snapshot.elements = deduplicateAgentBrowserSnapshotCandidates(snapshot.elements, maxElements);
		snapshot.url = redactSensitiveUrl(snapshot.url);
		snapshot.text = redactSensitiveText(snapshot.text);
		const elementLines = snapshot.elements.map((element) => {
			const label = [element.tag, element.role, element.disabled ? "disabled" : "", element.hidden ? "hidden" : ""]
				.filter(Boolean)
				.join("/");
			const hints = [
				element.fieldLabel ? `label=${element.fieldLabel}` : "",
				element.testId ? `testid=${element.testId}` : "",
				element.placeholder ? `placeholder=${element.placeholder}` : "",
				element.name ? `name=${element.name}` : "",
				element.type ? `type=${element.type}` : "",
				typeof element.checked === "boolean" ? `checked=${element.checked}` : "",
				element.ariaChecked !== null && element.ariaChecked !== "" ? `aria-checked=${element.ariaChecked}` : "",
				element.context ? `context=${element.context}` : "",
			]
				.filter(Boolean)
				.join(" ");
			const href = element.href ? ` -> ${redactSensitiveUrl(element.href)}` : "";
			return `[${element.ref}] ${label} ${redactSensitiveText(element.text) || "（无文字）"}${hints ? ` (${hints})` : ""}${href}`;
		});
		this.status = `页面状态已读取：${snapshot.elements.length} 个可操作元素`;
		this.emitState();
		return redactSensitiveText(
			[
				`标题：${redactSensitiveText(snapshot.title) || "（无）"}`,
				`网址：${snapshot.url}`,
				...(snapshot.scopeMatched ? [] : [`范围文字未找到：${scopeTexts.join(" / ")}`]),
				"",
				"可操作元素：",
				...elementLines,
				"",
				"页面正文：",
				snapshot.text,
			]
				.join("\n")
				.slice(0, limit + 16000),
		);
	}

	trustedEkuaibaoScopeTexts(scope) {
		if (!scope || typeof scope !== "object" || !EKUAIBAO_SCOPE_KINDS.has(scope.kind)) {
			throw trustedEkuaibaoError("invalid_command", "合思页面命令缺少有效的固定范围");
		}
		if (["detail-drawer", "invoice-menu", "invoice-dialog", "invoice-results"].includes(scope.kind)) {
			if (!Object.hasOwn(EKUAIBAO_FEE_TYPES, scope.detailKind)) {
				throw trustedEkuaibaoError("invalid_command", "合思明细命令缺少有效的费用类型");
			}
			if (["invoice-menu", "invoice-dialog", "invoice-results"].includes(scope.kind) && scope.detailKind === "allowance") {
				throw trustedEkuaibaoError("invalid_command", "出差补助不允许进入发票命令范围");
			}
		}
		switch (scope.kind) {
			case "main":
				return ["差旅费用报销单"];
			case "application-dialog":
				return ["关联申请"];
			case "application-details":
				return ["申请详情"];
			case "detail-picker":
				return ["添加明细", "费用类型"];
			case "detail-drawer":
				return ["添加明细", EKUAIBAO_FEE_TYPES[scope.detailKind]];
			case "invoice-menu":
				return ["智能识票"];
			case "invoice-dialog":
				return ["智能识票", "上传文件"];
			case "invoice-results":
				return ["通过智能识票识别出", "与该消费绑定"];
			default:
				throw trustedEkuaibaoError("invalid_command", "未知的合思页面命令范围");
		}
	}

	trustedEkuaibaoContractTarget(entry, scope) {
		if (!entry || !entry.scopes?.includes(scope.kind)) {
			throw trustedEkuaibaoError("invalid_command", "该合思页面操作不允许用于当前固定范围");
		}
		const scopeTexts = [...new Set([...this.trustedEkuaibaoScopeTexts(scope), ...(entry.scopeTexts || [])])];
		return {
			...(entry.selector ? { selector: entry.selector } : { text: entry.text || entry.label }),
			scopeTexts,
		};
	}

	trustedEkuaibaoText(value, label, maxChars = 300) {
		const text = String(value ?? "").replace(/\s+/g, " ").trim();
		if (!text || text.length > maxChars || /[\u0000-\u001f\u007f]/.test(text)) {
			throw trustedEkuaibaoError("invalid_command", `${label}不是有效的单行页面值`);
		}
		return text;
	}

	trustedEkuaibaoTypeValue(field, value) {
		const text = this.trustedEkuaibaoText(value, field, field === "description" ? 1000 : 300);
		if (["reimbursement-date", "detail-start-date", "detail-end-date"].includes(field) && !/^\d{4}-\d{2}-\d{2}$/.test(text)) {
			throw trustedEkuaibaoError("invalid_command", `${field} 必须是 YYYY-MM-DD 日期`);
		}
		if (field === "reimbursement-amount" && !/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(text)) {
			throw trustedEkuaibaoError("invalid_command", "报销金额必须是最多两位小数的非负金额");
		}
		if (field === "station" && text !== "[驻地]") {
			throw trustedEkuaibaoError("unsafe_target", "驻地只允许填写[驻地]");
		}
		if (field === "fee-type-search" && !Object.values(EKUAIBAO_FEE_TYPES).includes(text)) {
			throw trustedEkuaibaoError("unsafe_target", "费用类型不在差旅插件固定白名单内");
		}
		return text;
	}

	trustedEkuaibaoOption(command) {
		const allowedKinds = new Set([
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
		]);
		if (!allowedKinds.has(command.optionKind)) {
			throw trustedEkuaibaoError("invalid_command", "未知的合思选择项类型");
		}
		const value = this.trustedEkuaibaoText(command.value, "选择项", 240);
		const evidence = Array.isArray(command.evidence)
			? command.evidence.map((item) => this.trustedEkuaibaoText(item, "选择项证据", 240))
			: [];
		if (evidence.length > 6) throw trustedEkuaibaoError("invalid_command", "选择项证据数量超过固定上限");
		const safetySignal = [value, ...evidence].join(" ");
		if (
			new RegExp(EKUAIBAO_DANGEROUS_LABEL_PATTERN).test(safetySignal) ||
			new RegExp(EKUAIBAO_DANGEROUS_ATTRIBUTE_PATTERN, "i").test(safetySignal)
		) {
			throw trustedEkuaibaoError("unsafe_target", "选择项包含提交、送审、删除、作废或撤销语义");
		}
		if (
			command.optionKind === "station" &&
			!(/^(?:[驻地]|(?:南京\s*)?(?:中国\s*\/\s*)?江苏省\s*\/\s*南京)$/.test(value))
		) {
			throw trustedEkuaibaoError("unsafe_target", "驻地候选必须精确指向[驻地]");
		}
		if (command.optionKind === "expense-nature" && !["部门费用", "项目费用"].includes(value)) {
			throw trustedEkuaibaoError("unsafe_target", "费用性质只能选择部门费用或项目费用");
		}
		if (command.optionKind === "fee-type" && !Object.values(EKUAIBAO_FEE_TYPES).includes(value)) {
			throw trustedEkuaibaoError("unsafe_target", "费用类型候选不在差旅插件固定白名单内");
		}
		if (command.optionKind === "allowance-type" && value !== "其他省份") {
			throw trustedEkuaibaoError("unsafe_target", "补助类型只允许选择其他省份");
		}
		return { value, evidence };
	}

	async inspectTrustedEkuaibaoPage() {
		const view = this.ensureView();
		const webContents = view.webContents;
		const startUrl = webContents.getURL();
		if (!isEkuaibaoTrustedPageUrl(startUrl)) {
			throw trustedEkuaibaoError("wrong_page", "可信差旅命令只允许当前 https://app.ekuaibao.com/web/app.html#/billEntryDetail 页面");
		}
		const fields = JSON.stringify(EKUAIBAO_INSPECT_FIELDS);
		const controls = JSON.stringify(EKUAIBAO_INSPECT_CONTROLS);
		const raw = await webContents.executeJavaScript(`(() => {
			try {
				if (
					location.origin !== ${JSON.stringify(EKUAIBAO_TRUSTED_ORIGIN)} ||
					location.pathname !== '/web/app.html' ||
					!/^#\\/billEntryDetail(?:[/?]|$)/.test(location.hash)
				) throw new Error('wrong_page');
				const fieldContract = ${fields};
				const controlContract = ${controls};
				const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
				const readable = (item) => clean(
					item?.innerText || item?.value || item?.getAttribute?.('aria-label') || item?.getAttribute?.('title') ||
					item?.getAttribute?.('placeholder') || item?.getAttribute?.('data-testid') || item?.getAttribute?.('data-test') || ''
				);
				const visible = (element) => {
					const style = getComputedStyle(element);
					const rect = element.getBoundingClientRect();
					return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
				};
				const roots = [document];
				for (let index = 0; index < roots.length; index++) {
					for (const node of roots[index].querySelectorAll('*')) if (node.shadowRoot) roots.push(node.shadowRoot);
				}
				const queryAll = (selector) => {
					const found = [];
					const seen = new Set();
					for (const root of roots) {
						for (const item of root.querySelectorAll?.(selector) || []) {
							if (!seen.has(item)) { seen.add(item); found.push(item); }
						}
					}
					return found;
				};
				const overlaySelector = '[role="dialog"],[aria-modal="true"],[role="menu"],.ant-modal-wrap,.ant-drawer-content-wrapper,.ant-dropdown,[class*="drawer-content"],[class*="modal-content"],[class*="popover"]';
				const insideVisibleOverlay = (element) => {
					const overlayElement = element?.closest?.(overlaySelector);
					return Boolean(overlayElement && visible(overlayElement));
				};
				const matchesFieldScope = (element, entry) => {
					const scopes = Array.isArray(entry.scopes) ? entry.scopes : [];
					if (scopes.includes('main')) return !insideVisibleOverlay(element);
					return scopes.length === 0 || insideVisibleOverlay(element);
				};
				const fieldBoundary = (anchor) => anchor.closest?.(
					'[role="group"],[class*="form-item"],[class*="field"],[data-testid],label,td,li,section'
				) || anchor.parentElement;
				const fieldInputs = (entry) => {
					if (entry.selector) {
						try { return queryAll(entry.selector).filter((item) => visible(item) && matchesFieldScope(item, entry)); } catch { return []; }
					}
					const labels = queryAll('label,span,div,[data-testid],[data-test]')
						.filter((item) => visible(item) && matchesFieldScope(item, entry) && readable(item) === entry.label);
					const output = [];
					for (const label of labels) {
						if (label.control) output.push(label.control);
						const boundary = fieldBoundary(label);
						for (const input of boundary?.querySelectorAll?.('input:not([type=hidden]),textarea,select,[contenteditable=true],[role=combobox]') || []) output.push(input);
					}
					return [...new Set(output)].filter((item) => visible(item) && matchesFieldScope(item, entry));
				};
				const fieldStates = {};
				for (const [key, entry] of Object.entries(fieldContract)) {
					const matches = fieldInputs(entry);
					const element = matches.length === 1 ? matches[0] : null;
					const boundary = element ? fieldBoundary(element) : null;
					const value = element ? clean(element.isContentEditable ? element.textContent : ('value' in element ? element.value : readable(element))) : '';
					fieldStates[key] = {
						present: matches.length > 0,
						ambiguous: matches.length > 1,
						required: Boolean(element?.required || element?.getAttribute?.('aria-required') === 'true' || boundary?.querySelector?.('[aria-required="true"],.required,[class*="required"]')),
						disabled: Boolean(element?.disabled || element?.getAttribute?.('aria-disabled') === 'true'),
						...(value ? { value: value.slice(0, 500) } : {}),
					};
				}
				const actionable = 'a,button,input,summary,label,[role=button],[role=link],[role=option],[role=checkbox],[data-testid],[data-test]';
				const controlStates = {};
				for (const [key, entry] of Object.entries(controlContract)) {
					const controlMatchesScope = (item) => entry.scopes?.includes('main')
						? !insideVisibleOverlay(item)
						: !entry.scopes?.length || insideVisibleOverlay(item);
					let matches = [];
					if (entry.selector) {
						try { matches = queryAll(entry.selector); } catch { matches = []; }
					} else {
						matches = queryAll(actionable).filter((item) => readable(item) === entry.text);
					}
					matches = matches.filter((item) => visible(item) && controlMatchesScope(item));
					if (matches.length === 0 && entry.fallbackText) {
						matches = queryAll(actionable)
							.filter((item) => visible(item) && controlMatchesScope(item) && readable(item) === entry.fallbackText);
					}
					controlStates[key] = {
						present: matches.length > 0,
						ambiguous: matches.length > 1,
						disabled: matches.length === 1 && Boolean(matches[0].disabled || matches[0].getAttribute('aria-disabled') === 'true'),
					};
				}
				const bodyText = readable(document.body);
				if (!bodyText.includes('差旅费用报销单') || !controlStates['save-draft']?.present) {
					throw new Error('contract_mismatch');
				}
				const overlayElements = queryAll(overlaySelector)
					.filter(visible);
				const overlays = overlayElements.map(readable);
				const inOverlay = (element) => overlayElements.some((overlayElement) => overlayElement.contains(element));
				const overlayText = overlays.join(' ');
				const queryWithin = (root, selector) => {
					const output = [];
					if (root.matches?.(selector)) output.push(root);
					for (const item of root.querySelectorAll?.(selector) || []) output.push(item);
					return [...new Set(output)];
				};
				const explicitFieldValues = (root, allowedLabels) => {
					const labelSet = new Set(allowedLabels);
					const labels = queryWithin(root, 'label,dt,th,span,div,[data-testid],[data-test]')
						.filter((item) => visible(item) && labelSet.has(readable(item)));
					const values = [];
					for (const label of labels) {
						const labelText = readable(label);
						if (label.control) {
							const controlledValue = clean('value' in label.control ? label.control.value : readable(label.control));
							if (controlledValue) values.push(controlledValue);
						}
						let boundary = label.closest?.(
							'[class*="description-item"],[class*="form-item"],[class*="field"],[role="row"],tr,li,dl,section'
						) || label.parentElement;
						if (!boundary || !root.contains(boundary)) boundary = label.parentElement;
						const explicitValues = queryWithin(
							boundary,
							'dd,td,[class*="value"],[class*="content"],[class*="description-item-content"],input:not([type=hidden]),textarea,[data-value]'
						).filter((item) => item !== label && visible(item));
						for (const valueElement of explicitValues) {
							let value = clean('value' in valueElement ? valueElement.value : valueElement.getAttribute?.('data-value') || readable(valueElement));
							if (value.startsWith(labelText)) value = clean(value.slice(labelText.length).replace(/^[：:\-—]+/, ''));
							if (value && value !== labelText && !labelSet.has(value)) values.push(value);
						}
						if (explicitValues.length === 0 && boundary) {
							const boundaryText = readable(boundary);
							if (boundaryText.startsWith(labelText)) {
								const value = clean(boundaryText.slice(labelText.length).replace(/^[：:\-—]+/, ''));
								if (value && !labelSet.has(value)) values.push(value);
							}
						}
					}
					return [...new Map(values.map((value) => [value.replace(/\\s+/g, '').toLocaleLowerCase('zh-CN'), value])).values()];
				};
				const applicationDetailSignals = overlayElements.filter((element) => {
					const text = readable(element);
					return /(?:出差)?申请详情/.test(text) || (
						/(?:申请事由|出差事由|(?:^|\\s)事由(?:\\s|[：:]))/.test(text) && text.includes('费用性质')
					);
				});
				const applicationDetailRoots = applicationDetailSignals.filter(
					(candidate) => !applicationDetailSignals.some((other) => other !== candidate && candidate.contains(other))
				);
				if (applicationDetailRoots.length > 1) throw new Error('application_details_ambiguous');
				let applicationSource;
				if (applicationDetailRoots.length === 1) {
					const root = applicationDetailRoots[0];
					const reasonValues = explicitFieldValues(root, ['申请事由', '出差事由', '事由'])
						.filter((value) => value.length <= 1000 && !/(?:费用性质|申请编号|单据编号|申请单号|申请标题|申请名称|差旅起止日期)/.test(value));
					const natureValues = explicitFieldValues(root, ['费用性质'])
						.filter((value) => value === '部门费用' || value === '项目费用');
					const explicitIds = explicitFieldValues(root, ['申请编号', '单据编号', '申请单号', '单号'])
						.filter((value) => /^(?:S\\d{6,}|ID[A-Za-z0-9_-]{6,})$/.test(value));
					const textIds = [...new Set((readable(root).match(/\\bS\\d{6,}\\b/g) || []))];
					const ids = explicitIds.length > 0 ? [...new Set(explicitIds)] : textIds;
					const explicitTitles = explicitFieldValues(root, ['申请标题', '申请名称', '标题'])
						.filter((value) => value.length <= 300 && !/^(?:申请详情|出差申请详情)$/.test(value));
					const titleElements = queryWithin(root, 'h1,h2,h3,h4,[class*="title"],[data-testid*="title"],[data-test*="title"]')
						.filter(visible)
						.map(readable)
						.filter((value) => /^出差申请[：:]/.test(value) && value.length <= 300);
					const titles = explicitTitles.length > 0 ? [...new Set(explicitTitles)] : [...new Set(titleElements)];
					if (ids.length !== 1 || titles.length !== 1 || reasonValues.length !== 1 || natureValues.length !== 1) {
						throw new Error('application_details_contract');
					}
					applicationSource = {
						id: ids[0],
						title: titles[0],
						reason: reasonValues[0],
						expenseNature: natureValues[0],
					};
				}
				let overlay = 'none';
				if (applicationDetailRoots.length === 1) overlay = 'application-details';
				else if (overlayText.includes('通过智能识票识别出') && overlayText.includes('与该消费绑定')) overlay = 'invoice-results';
				else if (overlayText.includes('智能识票') && overlayText.includes('上传文件')) overlay = 'invoice-dialog';
				else if (overlayText.includes('智能识票')) overlay = 'invoice-menu';
				else if (overlayText.includes('添加明细') && Object.values(${JSON.stringify(EKUAIBAO_FEE_TYPES)}).some((fee) => overlayText.includes(fee))) overlay = 'detail-drawer';
				else if (overlayText.includes('添加明细') && overlayText.includes('费用类型')) overlay = 'detail-picker';
				else if (overlayText.includes('关联申请')) overlay = 'application-dialog';
				const multiLabels = queryAll('label,span,div,[data-testid],[data-test]')
					.filter((item) => visible(item) && !inOverlay(item) && readable(item) === '是否为多收款人');
				const multiBoundaries = [...new Set(multiLabels.map((label) =>
					label.closest?.('[role="group"],[class*="form-item"],[class*="field"],section,td,li') || label.parentElement
				).filter(Boolean))];
				let multipleRecipients = { present: multiBoundaries.length > 0, source: multiBoundaries.length > 1 ? 'ambiguous' : 'missing' };
				if (multiBoundaries.length === 1) {
					const boundary = multiBoundaries[0];
					const nativeInputs = [...new Set([
						...multiLabels.map((label) => label.control).filter((control) => control?.matches?.('input[type="checkbox"]')),
						...boundary.querySelectorAll('input[type="checkbox"]'),
					])];
					const roleSwitches = [...boundary.querySelectorAll('[role="switch"],[role="checkbox"]')];
					const ariaInputs = [...boundary.querySelectorAll('[aria-checked]')]
						.filter((item) => !roleSwitches.includes(item));
					if (nativeInputs.length === 1) {
						multipleRecipients = { present: true, checked: Boolean(nativeInputs[0].checked), source: 'native-input' };
					} else if (nativeInputs.length > 1) {
						multipleRecipients = { present: true, source: 'ambiguous' };
					} else if (roleSwitches.length === 1 && /^(?:true|false)$/.test(roleSwitches[0].getAttribute('aria-checked') || '')) {
						multipleRecipients = { present: true, checked: roleSwitches[0].getAttribute('aria-checked') === 'true', source: 'role-switch' };
					} else if (roleSwitches.length > 1) {
						multipleRecipients = { present: true, source: 'ambiguous' };
					} else if (ariaInputs.length === 1 && /^(?:true|false)$/.test(ariaInputs[0].getAttribute('aria-checked') || '')) {
						multipleRecipients = { present: true, checked: ariaInputs[0].getAttribute('aria-checked') === 'true', source: 'aria-checked' };
					}
				}
				const applicationAnchors = queryAll('[data-testid="field-expenseLink-select"]')
					.filter((item) => visible(item) && !inOverlay(item));
				let linkedApplication;
				if (applicationAnchors.length === 1) {
					const anchor = applicationAnchors[0];
					const boundary = anchor.closest?.('[role="group"],[class*="form-item"],[class*="field"],section,td,li') || anchor;
					const applicationText = readable(boundary).slice(0, 1200);
					const selected = boundary.querySelector?.('input,[class*="selection-item"],[class*="selected"],[class*="value"]');
					const selectedText = readable(selected || anchor).slice(0, 500);
					const idAttribute = [anchor, selected].filter(Boolean)
						.flatMap((item) => ['data-id', 'data-value', 'value', 'title'].map((name) => clean(item.getAttribute?.(name))))
						.find((value) => /^(?:ID[A-Za-z0-9_-]{6,}|[A-Z]{2,}[-_]?\\d{4,})$/.test(value));
					const idMatch = idAttribute || /(?:^|\\s)(ID[A-Za-z0-9_-]{6,}|[A-Z]{2,}[-_]?\\d{4,})(?:\\s|$)/.exec(applicationText)?.[1];
					const dates = [...applicationText.matchAll(/(?:20\\d{2})[-/.](?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\\d|3[01])/g)]
						.map((match) => match[0].replace(/[/.]/g, '-'));
					const titleCandidate = clean(selectedText.replace(idMatch || '', '').replace(/(?:20\\d{2})[-/.]\\d{1,2}[-/.]\\d{1,2}/g, '')).slice(0, 300);
					const title = /^(?:请选择|选择关联申请|关联申请)$/.test(titleCandidate) ? '' : titleCandidate;
					if (idMatch || title || dates.length) linkedApplication = {
						...(idMatch ? { id: idMatch } : {}),
						...(title ? { title } : {}),
						...(dates[0] ? { startDate: dates[0] } : {}),
						...(dates[1] ? { endDate: dates[1] } : dates[0] ? { endDate: dates[0] } : {}),
					};
				}
				const detailCandidates = queryAll(
					'[data-testid*="expenseDetail"], [class*="expense-detail-item"], [class*="detail-row"], [role="row"], tr'
				).filter((item) => visible(item) && !inOverlay(item) && Object.values(${JSON.stringify(EKUAIBAO_FEE_TYPES)}).some((fee) => readable(item).includes(fee)));
				const foldedDetails = [];
				const foldedSummaries = new Set();
				for (const row of detailCandidates.sort((left, right) => readable(left).length - readable(right).length)) {
					const summary = readable(row).slice(0, 1000);
					if (!summary || foldedSummaries.has(summary)) continue;
					if ([...foldedSummaries].some((known) => known.includes(summary))) continue;
					const feeEntry = Object.entries(${JSON.stringify(EKUAIBAO_FEE_TYPES)}).find(([, fee]) => summary.includes(fee));
					if (!feeEntry) continue;
					const dates = [...summary.matchAll(/(?:20\\d{2})[-/.](?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\\d|3[01])/g)]
						.map((match) => match[0].replace(/[/.]/g, '-'));
					const amountMatch = new RegExp(
						'(?:报销费用金额|报销金额|金额|合计)[^0-9]{0,12}(' + ${JSON.stringify(EKUAIBAO_AMOUNT_NUMBER_PATTERN_SOURCE)} + ')'
					).exec(summary)?.[1];
					const amount = amountMatch?.replace(/,/g, '');
					const invoiceCount = /已有发票[^0-9]{0,8}(\\d+)/.exec(summary)?.[1];
					foldedSummaries.add(summary);
					foldedDetails.push({
						feeType: feeEntry[0],
						summary,
						...(dates[0] ? { startDate: dates[0] } : {}),
						...(dates[1] ? { endDate: dates[1] } : dates[0] ? { endDate: dates[0] } : {}),
						...(amount ? { amount } : {}),
						...(invoiceCount ? { invoiceCount: Number(invoiceCount) } : {}),
					});
					if (foldedDetails.length >= 50) break;
				}
				const countMatch = /费用明细\\s*(?:\\(|（)?\\s*(\\d+)\\s*(?:\\)|）)?/.exec(bodyText);
				const totalLabels = queryAll('label,span,div,[data-testid],[data-test]')
					.filter((item) => visible(item) && !inOverlay(item) && /^(?:报销金额总计|支付金额总计|合计金额)$/.test(readable(item)));
				const totals = totalLabels.map((label) => readable(
					label.closest?.('[role="row"],tr,[class*="form-item"],[class*="field"],section,li') || label.parentElement
				))
					.map((text) => new RegExp(
						'(?:报销金额总计|支付金额总计|合计金额)[^0-9-]{0,20}(-?' + ${JSON.stringify(EKUAIBAO_AMOUNT_NUMBER_PATTERN_SOURCE)} + ')'
					).exec(text)?.[1]?.replace(/,/g, ''))
					.filter(Boolean);
				const calculatedTotal = [...new Set(totals)].length === 1 ? totals[0] : undefined;
				const validationErrors = [...new Set(queryAll(
					'.ant-form-item-explain-error,[class*="form-item-explain-error"],[class*="validation-error"],[role="alert"]'
				).filter((item) => {
					if (!visible(item) || inOverlay(item)) return false;
					const signal = [item.className || '', item.getAttribute?.('data-testid') || '', readable(item)].join(' ');
					return /error|invalid|必填|错误|不能为空|请选择|不符合|校验|缺少/i.test(signal);
				}).map(readable).filter(Boolean))].slice(0, 50);
				const optionMaterial = queryAll('[role="option"],[role="radio"],[role="checkbox"],li')
					.filter((item) => visible(item) && (item.matches('[role="option"],[role="radio"],[role="checkbox"]') || insideVisibleOverlay(item)))
					.map(readable).filter(Boolean).slice(0, 120);
				return {
					ok: true,
					overlay,
					fields: fieldStates,
					controls: controlStates,
					multipleRecipients,
					applicationSource,
					linkedApplication,
					detailCount: countMatch ? Number(countMatch[1]) : foldedDetails.length,
					calculatedTotal,
					validationErrors,
					foldedDetails,
					draftConfirmationVisible: /(?:草稿保存成功|已存为草稿|已保存为草稿|保存成功)/.test(bodyText),
					fingerprintMaterial: [
						document.title, overlay, JSON.stringify(fieldStates), JSON.stringify(controlStates),
						JSON.stringify(multipleRecipients), JSON.stringify(applicationSource), JSON.stringify(linkedApplication), JSON.stringify(foldedDetails),
						String(calculatedTotal || ''), JSON.stringify(validationErrors), JSON.stringify(optionMaterial)
					].join('\\n'),
				};
			} catch (error) {
				return { ok: false, error: error?.message || String(error) };
			}
		})()`, true);
		if (webContents.isDestroyed() || webContents.getURL() !== startUrl || !isEkuaibaoTrustedPageUrl(webContents.getURL())) {
			throw trustedEkuaibaoError("stale_page", "读取合思页面期间发生了导航，旧页面状态已失效");
		}
		if (!raw?.ok) {
			const applicationDetailsFailure = /^application_details_/.test(raw?.error || "");
			throw trustedEkuaibaoError(
				raw?.error === "wrong_page" ? "wrong_page" : "contract_mismatch",
				raw?.error === "wrong_page"
					? "合思页面路由已改变"
					: applicationDetailsFailure
						? "申请详情层缺少唯一编号、标题、显式申请事由或白名单费用性质"
						: "当前页面不符合差旅费用报销单 DOM 契约",
			);
		}
		if (raw.overlay === "application-details") {
			const source = raw.applicationSource;
			if (
				!source ||
				typeof source.id !== "string" ||
				!source.id.trim() ||
				typeof source.title !== "string" ||
				!source.title.trim() ||
				typeof source.reason !== "string" ||
				!source.reason.trim() ||
				!["部门费用", "项目费用"].includes(source.expenseNature)
			) {
				throw trustedEkuaibaoError("contract_mismatch", "申请详情结构化事实缺失或不唯一");
			}
		}
		if (!this.trustedEkuaibaoPageToken) this.trustedEkuaibaoPageToken = randomUUID();
		const digest = createHash("sha256").update(String(raw.fingerprintMaterial || "")).digest("hex");
		const sanitizedFields = Object.fromEntries(
			Object.entries(raw.fields || {}).map(([key, state]) => [
				key,
				{ ...state, ...(state?.value ? { value: redactSensitiveText(state.value) } : {}) },
			]),
		);
		const linkedApplication = raw.linkedApplication
			? {
					...raw.linkedApplication,
					...(raw.linkedApplication.title
						? { title: redactSensitiveText(String(raw.linkedApplication.title)).slice(0, 300) }
						: {}),
				}
			: undefined;
		const applicationSource = raw.overlay === "application-details" && raw.applicationSource
			? {
					id: String(raw.applicationSource.id),
					title: redactSensitiveText(String(raw.applicationSource.title)).slice(0, 300),
					reason: redactSensitiveText(String(raw.applicationSource.reason)).slice(0, 1000),
					expenseNature: raw.applicationSource.expenseNature,
				}
			: undefined;
		const foldedDetails = Array.isArray(raw.foldedDetails)
			? raw.foldedDetails.slice(0, 50).map((row) => ({
					...row,
					summary: redactSensitiveText(String(row?.summary || "")).slice(0, 1000),
				}))
			: [];
		return {
			contractVersion: EKUAIBAO_TRUSTED_CONTRACT_VERSION,
			pageToken: this.trustedEkuaibaoPageToken,
			pageFingerprint: EKUAIBAO_TRUSTED_PAGE_FINGERPRINT,
			route: "bill-entry-detail",
			overlay: raw.overlay,
			digest,
			fields: sanitizedFields,
			controls: raw.controls || {},
			multipleRecipients: raw.multipleRecipients || { present: false, source: "missing" },
			...(applicationSource ? { applicationSource } : {}),
			...(linkedApplication ? { linkedApplication } : {}),
			...(Number.isInteger(raw.detailCount) ? { detailCount: raw.detailCount } : {}),
			...(raw.calculatedTotal ? { calculatedTotal: String(raw.calculatedTotal) } : {}),
			validationErrors: Array.isArray(raw.validationErrors)
				? raw.validationErrors.map((item) => redactSensitiveText(String(item))).slice(0, 50)
				: [],
			foldedDetails,
			draftConfirmationVisible: Boolean(raw.draftConfirmationVisible),
		};
	}

	assertTrustedEkuaibaoMutation(command, state) {
		if (typeof command.pageToken !== "string" || !command.pageToken || command.pageToken !== state.pageToken) {
			throw trustedEkuaibaoError("stale_page", "合思页面令牌已失效，请重新读取页面后再操作");
		}
		if (typeof command.expectedDigest !== "string" || command.expectedDigest !== state.digest) {
			throw trustedEkuaibaoError("stale_state", "合思页面结构或字段值已变化，请重新读取页面后再操作");
		}
		if (!state.multipleRecipients?.present || typeof state.multipleRecipients.checked !== "boolean") {
			throw trustedEkuaibaoError("contract_mismatch", "无法从原生复选框、role=switch 或 aria-checked 可靠读取是否为多收款人");
		}
		if (state.multipleRecipients.checked) {
			throw trustedEkuaibaoError("unsafe_target", "当前单据已启用多收款人，差旅草稿自动化已停止且不会切换该控件");
		}
	}

	async runEkuaibaoTrustedCommand(command) {
		if (this.trustedEkuaibaoCommandActive) {
			return { ok: false, code: "stale_state", message: "已有合思页面命令正在执行，已拒绝并发操作" };
		}
		this.trustedEkuaibaoCommandActive = true;
		try {
			if (!command || typeof command !== "object" || command.contractVersion !== EKUAIBAO_TRUSTED_CONTRACT_VERSION) {
				throw trustedEkuaibaoError("invalid_command", "合思页面命令版本无效");
			}
			const allowedOps = new Set(["inspect", "click", "hover", "type", "select-exact", "upload", "save-draft"]);
			if (!allowedOps.has(command.op)) throw trustedEkuaibaoError("invalid_command", "未知的合思页面命令");
			await this.open();
			const before = await this.inspectTrustedEkuaibaoPage();
			if (command.op === "inspect") {
				return {
					ok: true,
					message: "已读取可信合思差旅报销页面",
					beforeDigest: before.digest,
					afterDigest: before.digest,
					state: before,
				};
			}
			this.assertTrustedEkuaibaoMutation(command, before);
			let message = "";
			if (command.op === "hover") {
				if (command.control !== "show-invoice-menu") {
					throw trustedEkuaibaoError("invalid_command", "可信 hover 只允许打开当前明细的添加发票菜单");
				}
				const entry = EKUAIBAO_TRUSTED_DOM_CONTRACT.controls[command.control];
				const target = this.trustedEkuaibaoContractTarget(entry, command.scope);
				message = await this.findAndRun(target, { kind: "hover" }, { unique: true, trustedEkuaibao: true });
			} else if (command.op === "click") {
				const entry = EKUAIBAO_TRUSTED_DOM_CONTRACT.controls[command.control];
				if (!entry) throw trustedEkuaibaoError("invalid_command", "控件不在合思安全白名单内");
				let target = this.trustedEkuaibaoContractTarget(entry, command.scope);
				if (command.control === "open-detail") {
					if (before.overlay !== "none" || command.scope?.kind !== "main" || !Object.hasOwn(EKUAIBAO_FEE_TYPES, command.detailKind)) {
						throw trustedEkuaibaoError("unverified_state", "只有主表中唯一折叠费用行可以由可信命令打开");
					}
					if (!Array.isArray(command.evidence) || command.evidence.length < 2 || command.evidence.length > 8) {
						throw trustedEkuaibaoError("invalid_command", "打开折叠费用行需要 2 到 8 个固定业务事实");
					}
					const evidence = command.evidence.map((item) => this.trustedEkuaibaoText(item, "费用行证据", 240));
					const feeType = EKUAIBAO_FEE_TYPES[command.detailKind];
					target = { text: feeType, scopeTexts: [...new Set([feeType, ...evidence])] };
				}
				if (command.control === "open-application-details") {
					if (before.overlay !== "application-dialog" || command.scope?.kind !== "application-dialog") {
						throw trustedEkuaibaoError("unverified_state", "只有关联申请弹窗中的已选候选行可以打开申请详情");
					}
					message = await this.findAndRun(
						target,
						{ kind: "click" },
						{
							unique: true,
							trustedEkuaibao: true,
							selectedApplicationRow: true,
							exactLabels: ["详情", "查看详情"],
						},
					);
				} else if (command.control === "close-application-details") {
					if (before.overlay !== "application-details" || command.scope?.kind !== "application-details") {
						throw trustedEkuaibaoError("unverified_state", "当前不在已验证的申请详情层，不能执行关闭详情");
					}
					message = await this.findAndRun(
						target,
						{ kind: "click" },
						{ unique: true, trustedEkuaibao: true, exactLabels: ["关闭"] },
					);
				} else if (command.control === "confirm-application") {
					try {
						message = await this.findAndRun(
							target,
							{ kind: "click" },
							{ unique: true, trustedEkuaibao: true, exactLabels: ["确定", "确认"] },
						);
					} catch (error) {
						if (!/没有找到|没有命中|不存在/.test(error?.message || "")) throw error;
						message = await this.findAndRun(
							{ text: entry.fallbackText, scopeTexts: this.trustedEkuaibaoScopeTexts(command.scope) },
							{ kind: "click" },
							{ unique: true, trustedEkuaibao: true, exactLabels: ["确定", "确认"] },
						);
					}
				} else if (command.control === "save-detail") {
					try {
						message = await this.findAndRun(
							target,
							{ kind: "click" },
							{ unique: true, trustedEkuaibao: true, detailSaveOnly: true },
						);
					} catch (error) {
						if (!/没有找到|没有命中|不存在/.test(error?.message || "")) throw error;
						message = await this.findAndRun(
							{ text: entry.fallbackText, scopeTexts: this.trustedEkuaibaoScopeTexts(command.scope) },
							{ kind: "click" },
							{ unique: true, trustedEkuaibao: true, detailSaveOnly: true, exactLabel: "保存" },
						);
					}
				} else {
					message = await this.findAndRun(target, { kind: "click" }, { unique: true, trustedEkuaibao: true });
				}
			} else if (command.op === "type") {
				const entry = EKUAIBAO_TRUSTED_DOM_CONTRACT.fields[command.field];
				if (!entry) throw trustedEkuaibaoError("invalid_command", "字段不在合思安全白名单内");
				if (EKUAIBAO_READ_ONLY_FIELDS.has(command.field)) {
					throw trustedEkuaibaoError("unsafe_target", "所属公司和提交人只允许回读核验，可信命令不会修改");
				}
				const target = this.trustedEkuaibaoContractTarget(entry, command.scope);
				const value = this.trustedEkuaibaoTypeValue(command.field, command.value);
				message = await this.findAndRun(
					target,
					{ kind: "type", value, pressEnter: false, commit: command.commit !== false },
					{ unique: true, trustedEkuaibao: true },
				);
			} else if (command.op === "select-exact") {
				const option = this.trustedEkuaibaoOption(command);
				const allowedOptionScopes = {
					application: ["application-dialog"],
					station: ["main"],
					"expense-nature": ["main"],
					department: ["main"],
					"fee-type": ["detail-picker"],
					city: ["detail-drawer"],
					"seat-class": ["detail-drawer"],
					"expense-reporter": ["detail-drawer"],
					"payment-recipient": ["main", "detail-drawer"],
					"allowance-type": ["detail-drawer"],
					"recognized-invoice": ["invoice-results"],
				};
				if (!allowedOptionScopes[command.optionKind]?.includes(command.scope?.kind)) {
					throw trustedEkuaibaoError("invalid_command", "该选择项类型不允许用于当前固定范围");
				}
				if (command.optionKind === "seat-class" && command.scope.detailKind !== "transport") {
					throw trustedEkuaibaoError("invalid_command", "火车席别只能在城市间交通费明细选择");
				}
				if (command.optionKind === "allowance-type" && command.scope.detailKind !== "allowance") {
					throw trustedEkuaibaoError("invalid_command", "补助类型只能在出差补助明细选择");
				}
				const scopeTexts = [...option.evidence];
				let target = { text: option.value, scopeTexts };
				if (command.optionKind === "application") {
					if (command.scope.kind !== "application-dialog") throw trustedEkuaibaoError("invalid_command", "关联申请候选只能在关联申请弹窗选择");
					target = { selector: 'input[type="radio"],[role="radio"]', scopeTexts: [...scopeTexts, option.value] };
				} else if (command.optionKind === "recognized-invoice") {
					if (command.scope.kind !== "invoice-results") throw trustedEkuaibaoError("invalid_command", "识票结果只能在智能识票结果页选择");
					target = {
						selector: 'input[type="checkbox"]:not([data-testid*="all"]),[role="checkbox"]:not([data-testid*="all"])',
						scopeTexts: [...scopeTexts, option.value],
					};
				}
				message = await this.findAndRun(target, { kind: "click" }, { unique: true, trustedEkuaibao: true });
			} else if (command.op === "upload") {
				const entry = EKUAIBAO_TRUSTED_DOM_CONTRACT.uploadSlots[command.slot];
				if (!entry) throw trustedEkuaibaoError("invalid_command", "上传位置不在合思安全白名单内");
				if (!Array.isArray(command.files) || command.files.length === 0 || command.files.length > 12) {
					throw trustedEkuaibaoError("invalid_command", "合思附件数量必须在 1 到 12 个之间");
				}
				const target = this.trustedEkuaibaoContractTarget(entry, command.scope);
				message = await this.uploadFiles(command.files, target, EKUAIBAO_TRUSTED_ORIGIN, {
					trustedEkuaibao: true,
					pageToken: before.pageToken,
					expectedDigest: before.digest,
				});
			} else if (command.op === "save-draft") {
				const intent = `${before.pageToken}:${before.digest}`;
				if (this.trustedEkuaibaoDraftSaveIntent === intent) {
					throw trustedEkuaibaoError("stale_state", "同一页面状态已经发送过草稿保存，已阻止重复点击");
				}
				this.trustedEkuaibaoDraftSaveIntent = intent;
				try {
					message = await this.findAndRun(
						{ ...EKUAIBAO_TRUSTED_DOM_CONTRACT.saveDraft },
						{ kind: "click" },
						{ unique: true, trustedEkuaibao: true, draftOnly: true },
					);
				} catch (error) {
					this.trustedEkuaibaoDraftSaveIntent = "";
					throw error;
				}
			}
			if (!this.trustedEkuaibaoPageToken || this.trustedEkuaibaoPageToken !== before.pageToken) {
				throw trustedEkuaibaoError("stale_page", "合思页面在操作期间发生导航，已停止后续动作");
			}
			let after = await this.inspectTrustedEkuaibaoPage();
			if (command.op === "click" && command.control === "open-application-details") {
				const deadline = Date.now() + 5_000;
				while (after.overlay !== "application-details" && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 200));
					after = await this.inspectTrustedEkuaibaoPage();
				}
				if (after.overlay !== "application-details" || !after.applicationSource) {
					throw trustedEkuaibaoError("contract_mismatch", "打开详情后未得到唯一、显式的关联申请来源事实");
				}
			}
			if (command.op === "click" && command.control === "close-application-details") {
				const deadline = Date.now() + 5_000;
				while (after.overlay === "application-details" && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 200));
					after = await this.inspectTrustedEkuaibaoPage();
				}
				if (after.overlay === "application-details") {
					throw trustedEkuaibaoError("unverified_state", "申请详情关闭操作已发送，但详情层仍可见");
				}
			}
			if (command.op === "click" && command.control === "open-detail" && after.overlay !== "detail-drawer") {
				throw trustedEkuaibaoError("unverified_state", "折叠费用行点击后未进入唯一明细抽屉");
			}
			if (command.op === "save-draft") {
				const deadline = Date.now() + 10_000;
				while (!after.draftConfirmationVisible && after.validationErrors.length === 0 && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 250));
					after = await this.inspectTrustedEkuaibaoPage();
				}
				if (!after.draftConfirmationVisible) {
					throw trustedEkuaibaoError(
						"unverified_state",
						after.validationErrors.length > 0
							? `草稿保存后页面返回校验错误：${after.validationErrors.join("；")}`
							: "草稿保存点击已发送，但 10 秒内没有出现新的草稿保存成功提示；已停止且不会自动重试",
					);
				}
			}
			return {
				ok: true,
				message: redactSensitiveText(message),
				beforeDigest: before.digest,
				afterDigest: after.digest,
				state: after,
			};
		} catch (error) {
			const allowedCodes = new Set([
				"invalid_command",
				"wrong_page",
				"contract_mismatch",
				"stale_page",
				"stale_state",
				"missing_anchor",
				"ambiguous_anchor",
				"unsafe_target",
				"unverified_state",
			]);
			const message = redactSensitiveText(error?.message || String(error));
			let code = allowedCodes.has(error?.code) ? error.code : "unverified_state";
			if (code === "unverified_state" && /没有找到|不存在|没有命中/.test(message)) code = "missing_anchor";
			if (code === "unverified_state" && /多个目标|不再唯一|拒绝猜测/.test(message)) code = "ambiguous_anchor";
			if (code === "unverified_state" && /来源或路由|页面.*导航|文档.*改变/.test(message)) code = "stale_page";
			return {
				ok: false,
				code,
				message,
			};
		} finally {
			this.trustedEkuaibaoCommandActive = false;
		}
	}

	async findAndRun(target, action, trustedGuard) {
		const view = this.ensureView();
		const actionToken = randomUUID();
		const encodedTarget = JSON.stringify(target ?? {});
		const encodedAction = JSON.stringify(action);
		const encodedActionToken = JSON.stringify(actionToken);
		const encodedTrustedGuard = JSON.stringify(trustedGuard ?? null);
		const encodedSafetyPatterns = JSON.stringify({
			attachmentAction: EKUAIBAO_ATTACHMENT_ACTION_PATTERN,
			attachmentContext: EKUAIBAO_ATTACHMENT_CONTEXT_PATTERN,
			dangerousAttribute: EKUAIBAO_DANGEROUS_ATTRIBUTE_PATTERN,
			dangerousLabel: EKUAIBAO_DANGEROUS_LABEL_PATTERN,
			destructiveAttribute: EKUAIBAO_DESTRUCTIVE_ATTRIBUTE_PATTERN,
			destructiveLabel: EKUAIBAO_DESTRUCTIVE_LABEL_PATTERN,
			draftAttribute: EKUAIBAO_DRAFT_ATTRIBUTE_PATTERN,
			draftLabel: EKUAIBAO_DRAFT_LABEL_PATTERN,
			rowContext: EKUAIBAO_ROW_CONTEXT_PATTERN,
		});
		const response = await view.webContents.executeJavaScript(`(() => {
			try {
				const target = ${encodedTarget};
				const action = ${encodedAction};
				const actionToken = ${encodedActionToken};
				const trustedGuard = ${encodedTrustedGuard};
				const safetyPatterns = ${encodedSafetyPatterns};
				const isEkuaibao = /(^|\\.)ekuaibao\\.com$/i.test(location.hostname);
				if (trustedGuard?.trustedEkuaibao && (
					location.origin !== ${JSON.stringify(EKUAIBAO_TRUSTED_ORIGIN)} ||
					location.pathname !== '/web/app.html' ||
					!/^#\\/billEntryDetail(?:[/?]|$)/.test(location.hash)
				)) throw new Error('可信合思命令的页面来源或路由已改变');
				if (action.kind === 'type' && action.pressEnter && isEkuaibao) {
					throw new Error("安全策略已禁止在易快报页面通过回车确认，以免触发表单提交；请点击明确的候选项");
				}
				const readable = (item) => (
					item?.innerText || item?.value || item?.getAttribute?.('aria-label') || item?.getAttribute?.('title') ||
					item?.getAttribute?.('placeholder') || item?.getAttribute?.('data-testid') || item?.getAttribute?.('data-test') || ''
				).replace(/\\s+/g, ' ').trim();
				const safetyTokens = (value) => String(value || '')
					.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
					.replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
					.replace(/[^a-z0-9\\u4e00-\\u9fff]+/gi, ' ')
					.trim();
				const visible = (element) => {
					const style = getComputedStyle(element);
					const rect = element.getBoundingClientRect();
					return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
				};
				const roots = [document];
				for (let index = 0; index < roots.length; index++) {
					const root = roots[index];
					for (const node of root.querySelectorAll('*')) {
						if (node.shadowRoot) roots.push(node.shadowRoot);
						if (node.tagName === 'IFRAME') {
							try { if (node.contentDocument) roots.push(node.contentDocument); } catch { /* cross-origin */ }
						}
					}
				}
				const queryAll = (selector, bases = roots) => {
					const found = [];
					const seen = new Set();
					for (const base of bases) {
						if (base.matches?.(selector) && !seen.has(base)) { seen.add(base); found.push(base); }
						for (const item of base.querySelectorAll?.(selector) || []) {
							if (!seen.has(item)) { seen.add(item); found.push(item); }
						}
					}
					return found;
				};
				const layer = (element) => {
					let value = 0;
					for (let node = element; node?.nodeType === 1; node = node.parentElement) {
						const parsed = Number.parseInt(getComputedStyle(node).zIndex, 10);
						if (Number.isFinite(parsed)) value = Math.max(value, parsed);
					}
					return value;
				};
				const overlays = queryAll('[role="dialog"],[aria-modal="true"],.ant-modal-wrap,.ant-drawer-content-wrapper,[class*="drawer-content"],[class*="modal-content"]')
					.filter(visible)
					.sort((left, right) => layer(right) - layer(left));
				const orderedBases = (bases) => bases === roots ? [...overlays, ...roots] : bases;
				const locatorCandidates = (locator, bases = roots) => {
					const scopedBases = orderedBases(bases);
					let candidates = [];
					if (locator?.ref) candidates = queryAll('[data-pi-agent-ref="' + CSS.escape(locator.ref) + '"]', scopedBases);
					else if (locator?.selector) {
						try { candidates = queryAll(locator.selector, scopedBases); } catch { throw new Error('CSS selector 无效'); }
					} else if (locator?.text) {
						const selector = 'a,button,input,textarea,select,summary,label,li,[role=button],[role=link],[role=option],[role=combobox],[data-testid],[data-test],[placeholder],[onclick],[contenteditable=true],div,span';
						const pool = queryAll(selector, scopedBases);
						const exact = pool.filter((item) => readable(item) === locator.text);
						candidates = exact.length
							? exact
							: pool.filter((item) => readable(item).includes(locator.text)).sort((left, right) => readable(left).length - readable(right).length);
					}
					return candidates;
				};
				const occurrenceIndex = (locator) => Math.max(0, (Number(locator?.occurrence) || 1) - 1);
				const resolveLocator = (locator, bases = roots) => locatorCandidates(locator, bases)[occurrenceIndex(locator)] || null;
				const localScopeSelector = '[role="dialog"],[aria-modal="true"],[role="row"],tr,li,form,section,article,[class*="drawer"],[class*="modal"],[class*="item"],[class*="card"],[class*="detail"],[class*="field"],[class*="form-item"],[data-testid],[data-test]';
				const overlayScopeSelector = '[role="dialog"],[aria-modal="true"],[class*="drawer"],[class*="modal"]';
				const hasLocalScope = (candidate, wanted, boundary) => {
					const directText = readable(candidate);
					if (directText.length <= 800 && wanted.every((text) => directText.includes(text))) return true;
					let node = candidate.parentElement || candidate.getRootNode?.()?.host || null;
					for (let depth = 0; depth < 12 && node?.nodeType === 1; depth++) {
						if (node === document.body || node === document.documentElement) break;
						if (node.matches?.(localScopeSelector)) {
							const scopedText = readable(node);
							const isOverlayScope = node.matches(overlayScopeSelector);
							if ((isOverlayScope || scopedText.length <= 2500) && wanted.every((text) => scopedText.includes(text))) {
								return true;
							}
						}
						if (node === boundary) break;
						const root = node.getRootNode?.();
						node = node.parentElement || root?.host || null;
					}
					return false;
				};
				let withinElement = null;
				let targetBases = roots;
				if (target.within) {
					withinElement = resolveLocator(target.within);
					if (!withinElement) throw new Error('没有找到 within 指定的页面范围');
					targetBases = [withinElement];
					if (withinElement.shadowRoot) targetBases.push(withinElement.shadowRoot);
				}
				let candidates = locatorCandidates(target, targetBases);
				const scopeTexts = Array.isArray(target.scopeTexts)
					? target.scopeTexts.map((item) => String(item || '').replace(/\\s+/g, ' ').trim()).filter(Boolean)
					: [];
				if (scopeTexts.length) {
					candidates = candidates.filter((candidate) => hasLocalScope(candidate, scopeTexts, withinElement));
				}
				if (trustedGuard?.unique) {
					if (action.kind === 'click' || action.kind === 'hover') {
						const activationSelector = 'a[href],button,input:not([type=hidden]),summary,label,[role=button],[role=link],[role=option],[role=checkbox],[role=radio],[data-testid],[data-test],[onclick]';
						candidates = candidates.map((candidate) => {
							if (candidate.tagName === 'LABEL' && candidate.control) return candidate.control;
							if (candidate.matches?.(activationSelector)) return candidate;
							let container = candidate.parentElement;
							for (let depth = 0; depth < 8 && container; depth++, container = container.parentElement) {
								if (withinElement && !withinElement.contains(container)) break;
								if (container.matches?.(activationSelector) || getComputedStyle(container).cursor === 'pointer') return container;
							}
							return candidate;
						});
					} else if (action.kind === 'type') {
						candidates = candidates.map((candidate) => {
							if (candidate.isContentEditable || 'value' in candidate) return candidate;
							if (candidate.tagName === 'LABEL' && candidate.control) return candidate.control;
							let container = candidate;
							for (let depth = 0; depth < 7 && container; depth++, container = container.parentElement) {
								const input = container.querySelector?.('input:not([type=hidden]),textarea,select,[contenteditable=true],[role=combobox]');
								if (input) return input;
							}
							return candidate;
						});
					}
					candidates = [...new Set(candidates)];
					candidates = candidates.filter(visible);
					if (trustedGuard.selectedApplicationRow) {
						const detailLabels = new Set(['详情', '查看详情']);
						const dialogSelector = '[role="dialog"],[aria-modal="true"],.ant-modal-wrap,[class*="modal-content"]';
						const selectedActivationSelector = 'a[href],button,input:not([type=hidden]),summary,label,[role=button],[role=link],[role=option],[role=checkbox],[role=radio],[data-testid],[data-test],[onclick]';
						candidates = candidates.filter((candidate) => {
							for (let node = candidate; node?.nodeType === 1; node = node.parentElement) {
								if (node !== candidate && node.matches?.(dialogSelector)) break;
								const selected = node.querySelectorAll?.('input[type="radio"]:checked,[role="radio"][aria-checked="true"]') || [];
								if (selected.length !== 1) continue;
								const localDetails = locatorCandidates({ text: '详情' }, [node])
									.map((item) => {
										if (item.tagName === 'LABEL' && item.control) return item.control;
										if (item.matches?.(selectedActivationSelector)) return item;
										let activation = item.parentElement;
										for (let depth = 0; depth < 8 && activation && node.contains(activation); depth++, activation = activation.parentElement) {
											if (activation.matches?.(selectedActivationSelector) || getComputedStyle(activation).cursor === 'pointer') return activation;
										}
										return item;
									})
									.filter((item) => visible(item) && detailLabels.has(readable(item)));
								const uniqueDetails = [...new Set(localDetails)];
								if (uniqueDetails.length === 1 && uniqueDetails[0] === candidate) return true;
							}
							return false;
						});
					}
					if (candidates.length === 0) throw new Error('可信页面契约没有找到唯一目标');
					if (candidates.length !== 1) throw new Error('可信页面契约找到多个目标，已拒绝猜测 occurrence');
				}
				let element = candidates[occurrenceIndex(target)] || null;
				if (!element) throw new Error("没有找到目标元素，请先调用 browser_snapshot 获取最新 ref");

				if (action.kind === 'click' || action.kind === 'hover') {
					const clickableSelector = 'a,button,input:not([type=hidden]),summary,label,[role=button],[role=link],[role=option],[role=checkbox],[role=radio],[data-testid],[data-test],[onclick]';
					let clickable = element;
					if (element.tagName === 'LABEL' && element.control) clickable = element.control;
					else if (!element.matches(clickableSelector) && getComputedStyle(element).cursor !== 'pointer') {
						let container = element.parentElement;
						for (let depth = 0; depth < 8 && container; depth++, container = container.parentElement) {
							if (withinElement && !withinElement.contains(container)) break;
							if (container.matches(clickableSelector) || getComputedStyle(container).cursor === 'pointer') { clickable = container; break; }
						}
					}
					const label = readable(clickable).slice(0, 160) || clickable.tagName;
					if (trustedGuard?.exactLabel && label !== trustedGuard.exactLabel) {
						throw new Error('可信页面契约的控件文字与固定中文锚点不一致');
					}
					if (Array.isArray(trustedGuard?.exactLabels) && !trustedGuard.exactLabels.includes(label)) {
						throw new Error('可信页面契约的控件文字不在固定中文锚点集合内');
					}
					const locatorSignal = [target.selector || '', target.text || ''].join(' ').replace(/\\s+/g, ' ').trim();
					const attributeSignal = [
						clickable.id || '', clickable.className || '',
						clickable.getAttribute('name') || '', clickable.getAttribute('data-testid') || '',
						clickable.getAttribute('data-test') || '', clickable.getAttribute('aria-label') || '',
						clickable.getAttribute('title') || ''
					].join(' ').replace(/\\s+/g, ' ').trim();
					const blockedSignal = (locatorSignal + ' ' + attributeSignal).trim();
					const dangerousAttributePattern = new RegExp(safetyPatterns.dangerousAttribute, 'i');
					const dangerousAttribute = dangerousAttributePattern.test(blockedSignal)
						|| dangerousAttributePattern.test(safetyTokens(blockedSignal));
					const dangerousLabel = new RegExp(safetyPatterns.dangerousLabel).test(label);
					if (action.kind === 'click' && isEkuaibao && (dangerousAttribute || dangerousLabel)) {
						throw new Error("安全策略已阻止易快报的提交、送审、删除单据、作废或撤销操作；差旅插件只允许保存草稿");
					}
					// Draft recognition is deliberately evaluated only after every dangerous
					// signal above has been rejected. It is not an override for submit/delete.
					const isDraft = new RegExp(safetyPatterns.draftLabel).test(label)
						|| new RegExp(safetyPatterns.draftAttribute, 'i').test(' ' + attributeSignal + ' ');
					if (trustedGuard?.draftOnly && !isDraft) throw new Error('可信草稿命令没有命中唯一的草稿保存控件');
					const isDetailSave = Boolean(trustedGuard?.detailSaveOnly) && (
						clickable.getAttribute('data-testid') === 'feetype-footer-save' || label === '保存'
					);
					if (trustedGuard?.detailSaveOnly && !isDetailSave) throw new Error('可信明细保存命令没有命中固定保存锚点');
					const submitControl = /^(?:INPUT|BUTTON)$/i.test(clickable.tagName)
						&& /^(?:submit|image)$/i.test(clickable.type || clickable.getAttribute('type') || '');
					if (action.kind === 'click' && isEkuaibao && submitControl && !isDraft && !isDetailSave) {
						throw new Error("安全策略已阻止易快报的非草稿提交控件；差旅插件只允许精确的保存草稿按钮");
					}
					const destructive = new RegExp(safetyPatterns.destructiveAttribute, 'i').test(safetyTokens(blockedSignal))
						|| new RegExp(safetyPatterns.destructiveLabel).test(label);
					if (action.kind === 'click' && isEkuaibao && destructive) {
						let contextSignal = '';
						let destructiveRow = false;
						const attachmentActionPattern = new RegExp(safetyPatterns.attachmentAction, 'i');
						const attachmentContextPattern = new RegExp(safetyPatterns.attachmentContext, 'i');
						const rowContextPattern = new RegExp(safetyPatterns.rowContext, 'i');
						const matchesAttachmentAction = (value) => attachmentActionPattern.test(value)
							|| attachmentActionPattern.test(safetyTokens(value));
						const matchesAttachmentContext = (value) => attachmentContextPattern.test(value)
							|| attachmentContextPattern.test(safetyTokens(value));
						const matchesRowContext = (value) => rowContextPattern.test(value)
							|| rowContextPattern.test(safetyTokens(value));
						const explicitAttachmentAction = matchesAttachmentAction((label + ' ' + attributeSignal).trim());
						for (let node = clickable, depth = 0; depth < 5 && node?.nodeType === 1; depth++, node = node.parentElement) {
							const nodeAttributes = [
								node.id || '', node.className || '', node.getAttribute('name') || '',
								node.getAttribute('data-testid') || '', node.getAttribute('data-test') || '',
								node.getAttribute('aria-label') || '', node.getAttribute('title') || ''
							].join(' ').replace(/\\s+/g, ' ').trim();
							const fullNodeText = readable(node);
							const nodeText = depth <= 2 && fullNodeText.length <= 240 ? fullNodeText : '';
							const candidateContext = (nodeAttributes + ' ' + nodeText).trim();
							if (matchesRowContext(candidateContext)) destructiveRow = true;
							if (matchesAttachmentContext(candidateContext)) { contextSignal = candidateContext; break; }
							if (depth > 0 && node.matches?.('form,[role="dialog"],[role="row"],tr')) break;
						}
						if (destructiveRow && !explicitAttachmentAction) {
							throw new Error("安全策略已阻止易快报费用明细行的删除操作");
						}
						const attachmentRemoval = explicitAttachmentAction || Boolean(contextSignal);
						if (!attachmentRemoval) {
							throw new Error("安全策略已阻止易快报中没有明确附件上下文的删除或移除操作");
						}
					}
					if (clickable.disabled || clickable.getAttribute('aria-disabled') === 'true') throw new Error("目标元素已禁用");
					if (clickable.ownerDocument !== document) {
						throw new Error("目标元素位于内嵌框架，已停止可信鼠标操作以防坐标偏移点错；请改用顶层页面入口");
					}
					for (const stale of document.querySelectorAll('[data-pi-agent-action-token]')) {
						stale.removeAttribute('data-pi-agent-action-token');
					}
					clickable.setAttribute('data-pi-agent-action-token', actionToken);
					clickable.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
					if (action.kind === 'click') clickable.focus({ preventScroll: true });
					const rect = clickable.getBoundingClientRect();
					if (rect.width <= 0 || rect.height <= 0) throw new Error('目标元素当前不可见，无法发送真实鼠标事件');
					return {
						ok: true,
						pointer: {
							x: Math.max(0, Math.round(rect.left + rect.width / 2)),
							y: Math.max(0, Math.round(rect.top + rect.height / 2)),
							kind: action.kind,
							token: actionToken,
						},
						label,
						isDraft,
					};
				}

				if (!element.isContentEditable && !('value' in element)) {
					if (element.tagName === 'LABEL' && element.control) element = element.control;
					else {
						let container = element;
						for (let depth = 0; depth < 7 && container; depth++, container = container.parentElement) {
							const candidate = container.querySelector?.('input:not([type=hidden]),textarea,select,[contenteditable=true],[role=combobox]');
							if (candidate) { element = candidate; break; }
						}
					}
				}
				if (!element.isContentEditable && !('value' in element)) throw new Error("目标元素不可输入");
				if (element.disabled || element.getAttribute('aria-disabled') === 'true') throw new Error("目标元素已禁用");
				if (trustedGuard?.trustedEkuaibao && element.ownerDocument !== document) {
					throw new Error('可信合思输入目标不在顶层文档');
				}
				const label = readable(element).slice(0, 160) || element.getAttribute('placeholder') || element.tagName;
				const value = action.value;
				const ownerWindow = element.ownerDocument.defaultView || window;
				element.scrollIntoView({ block: 'center', inline: 'center' });
				element.focus();
				if (element.isContentEditable) {
					element.textContent = value;
				} else {
					const prototype = element.tagName === 'TEXTAREA' ? ownerWindow.HTMLTextAreaElement.prototype : element.tagName === 'SELECT' ? ownerWindow.HTMLSelectElement.prototype : ownerWindow.HTMLInputElement.prototype;
					const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
					if (setter) setter.call(element, value); else element.value = value;
				}
				element.dispatchEvent(new ownerWindow.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
				element.dispatchEvent(new ownerWindow.Event('change', { bubbles: true }));
				if (action.pressEnter) {
					element.dispatchEvent(new ownerWindow.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
					element.dispatchEvent(new ownerWindow.KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', bubbles: true }));
					element.dispatchEvent(new ownerWindow.KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
				}
				if (action.commit) element.blur();
				return { ok: true, value: '已输入：' + label + (action.pressEnter ? '，并已按回车确认' : '') + (action.commit ? '，字段已失焦保存' : '') };
			} catch (error) {
				return { ok: false, error: error?.message || String(error) };
			}
		})()`, true);
		if (!response?.ok) throw new Error(response?.error || "页面操作失败");
		if (response.pointer) {
			const originalPoint = { x: response.pointer.x, y: response.pointer.y };
			const verifyPointerTarget = async () => {
				const verified = await view.webContents.executeJavaScript(`(() => {
					try {
						const token = ${JSON.stringify(actionToken)};
						const point = ${JSON.stringify(originalPoint)};
						const trustedGuard = ${encodedTrustedGuard};
						const safetyPatterns = ${encodedSafetyPatterns};
						if (trustedGuard?.trustedEkuaibao && (
							location.origin !== ${JSON.stringify(EKUAIBAO_TRUSTED_ORIGIN)} ||
							location.pathname !== '/web/app.html' ||
							!/^#\\/billEntryDetail(?:[/?]|$)/.test(location.hash)
						)) throw new Error('可信合思命令在鼠标发送前发现页面来源或路由改变');
						const candidates = [...document.querySelectorAll('[data-pi-agent-action-token]')]
							.filter((element) => element.getAttribute('data-pi-agent-action-token') === token);
						if (candidates.length !== 1) throw new Error('可信鼠标目标已重渲染或不再唯一，未发送点击事件');
						const clickable = candidates[0];
						if (!clickable.isConnected || clickable.ownerDocument !== document) {
							throw new Error('可信鼠标目标已离开当前文档，未发送点击事件');
						}
						const style = getComputedStyle(clickable);
						const rect = clickable.getBoundingClientRect();
						if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0' || rect.width <= 0 || rect.height <= 0) {
							throw new Error('可信鼠标目标已不可见，未发送点击事件');
						}
						const currentPoint = {
							x: Math.max(0, Math.round(rect.left + rect.width / 2)),
							y: Math.max(0, Math.round(rect.top + rect.height / 2)),
						};
						if (Math.abs(currentPoint.x - point.x) > 2 || Math.abs(currentPoint.y - point.y) > 2) {
							throw new Error('可信鼠标目标在操作前发生位移，未发送点击事件');
						}
						const hit = document.elementFromPoint(point.x, point.y);
						if (!hit || (hit !== clickable && !clickable.contains(hit))) {
							throw new Error('可信鼠标坐标已被其他元素覆盖，未发送点击事件');
						}
						const activationSelector = [
							'a[href]', 'area[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea',
							'summary', 'details', 'label', 'iframe', 'object', 'embed', 'audio[controls]', 'video[controls]',
							'[contenteditable]:not([contenteditable="false"])', '[tabindex]:not([tabindex="-1"])',
							'[role=button]', '[role=link]', '[role=option]', '[role=checkbox]', '[role=radio]', '[role=tab]',
							'[role=menuitem]', '[role=menuitemcheckbox]', '[role=menuitemradio]', '[role=switch]',
							'[role=combobox]', '[role=slider]', '[role=spinbutton]', '[role=textbox]', '[role=treeitem]',
							'[data-testid]', '[data-test]', '[onclick]', '[onmousedown]', '[onmouseup]', '[onpointerdown]', '[onpointerup]',
						].join(',');
						let activation = hit;
						while (activation && activation !== clickable && !activation.matches?.(activationSelector)) {
							activation = activation.parentElement;
						}
						const expectedLabelControl = Boolean(activation) && clickable.tagName === 'LABEL' && clickable.control === activation;
						if (activation !== clickable && !expectedLabelControl) {
							throw new Error('可信鼠标坐标命中了目标内部的独立交互控件，未发送点击事件');
						}
						const readable = (item) => (
							item?.innerText || item?.value || item?.getAttribute?.('aria-label') || item?.getAttribute?.('title') ||
							item?.getAttribute?.('placeholder') || item?.getAttribute?.('data-testid') || item?.getAttribute?.('data-test') || ''
						).replace(/\\s+/g, ' ').trim();
						const safetyTokens = (value) => String(value || '')
							.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
							.replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
							.replace(/[^a-z0-9\\u4e00-\\u9fff]+/gi, ' ')
							.trim();
						const attributes = (item) => [
							item?.id || '', item?.className || '', item?.getAttribute?.('name') || '',
							item?.getAttribute?.('data-testid') || '', item?.getAttribute?.('data-test') || '',
							item?.getAttribute?.('aria-label') || '', item?.getAttribute?.('title') || ''
						].join(' ').replace(/\\s+/g, ' ').trim();
						const label = readable(clickable).slice(0, 160) || clickable.tagName;
						if (trustedGuard?.exactLabel && label !== trustedGuard.exactLabel) {
							throw new Error('可信页面契约在鼠标发送前发现控件文字已改变');
						}
						if (Array.isArray(trustedGuard?.exactLabels) && !trustedGuard.exactLabels.includes(label)) {
							throw new Error('可信页面契约在鼠标发送前发现控件文字不在固定中文锚点集合内');
						}
						if (trustedGuard?.selectedApplicationRow) {
							const detailLabels = new Set(['详情', '查看详情']);
							const dialogSelector = '[role="dialog"],[aria-modal="true"],.ant-modal-wrap,[class*="modal-content"]';
							let verifiedSelectedRow = false;
							for (let node = clickable; node?.nodeType === 1; node = node.parentElement) {
								if (node !== clickable && node.matches?.(dialogSelector)) break;
								const selected = node.querySelectorAll?.('input[type="radio"]:checked,[role="radio"][aria-checked="true"]') || [];
								if (selected.length !== 1) continue;
								const localDetails = [node, ...node.querySelectorAll('a,button,input,summary,label,[role=button],[role=link],[data-testid],[data-test],[onclick],div,span')]
									.filter((item) => detailLabels.has(readable(item)))
									.map((item) => {
										if (item.tagName === 'LABEL' && item.control) return item.control;
										if (item.matches?.(activationSelector)) return item;
										let activation = item.parentElement;
										for (let depth = 0; depth < 8 && activation && node.contains(activation); depth++, activation = activation.parentElement) {
											if (activation.matches?.(activationSelector) || getComputedStyle(activation).cursor === 'pointer') return activation;
										}
										return item;
									});
								const uniqueDetails = [...new Set(localDetails)];
								if (uniqueDetails.length === 1 && uniqueDetails[0] === clickable) {
									verifiedSelectedRow = true;
									break;
								}
							}
							if (!verifiedSelectedRow) {
								throw new Error('可信页面契约在鼠标发送前无法证明详情控件仍属于唯一已选申请行');
							}
						}
						const attributeSignal = (attributes(clickable) + ' ' + attributes(hit)).trim();
						const isEkuaibao = /(^|\\.)ekuaibao\\.com$/i.test(location.hostname);
						if (clickable.disabled || clickable.getAttribute('aria-disabled') === 'true') {
							throw new Error('可信鼠标目标已禁用，未发送点击事件');
						}
						if (isEkuaibao) {
							const dangerousAttributePattern = new RegExp(safetyPatterns.dangerousAttribute, 'i');
							const dangerousAttribute = dangerousAttributePattern.test(attributeSignal)
								|| dangerousAttributePattern.test(safetyTokens(attributeSignal));
							const dangerousLabel = new RegExp(safetyPatterns.dangerousLabel).test(label);
							if (dangerousAttribute || dangerousLabel) {
								throw new Error('安全策略在点击前复核时发现提交、送审、删除单据、作废或撤销控件');
							}
							const isDraft = new RegExp(safetyPatterns.draftLabel).test(label)
								|| new RegExp(safetyPatterns.draftAttribute, 'i').test(' ' + attributeSignal + ' ');
							if (trustedGuard?.draftOnly && !isDraft) {
								throw new Error('可信草稿命令在鼠标发送前没有命中草稿保存控件');
							}
							const isDetailSave = Boolean(trustedGuard?.detailSaveOnly) && (
								clickable.getAttribute('data-testid') === 'feetype-footer-save' || label === '保存'
							);
							if (trustedGuard?.detailSaveOnly && !isDetailSave) {
								throw new Error('可信明细保存命令在鼠标发送前没有命中固定保存锚点');
							}
							const submitControl = /^(?:INPUT|BUTTON)$/i.test(clickable.tagName)
								&& /^(?:submit|image)$/i.test(clickable.type || clickable.getAttribute('type') || '');
							if (submitControl && !isDraft && !isDetailSave) throw new Error('安全策略在点击前复核时发现非草稿提交控件');
							const destructive = new RegExp(safetyPatterns.destructiveAttribute, 'i').test(safetyTokens(attributeSignal))
								|| new RegExp(safetyPatterns.destructiveLabel).test(label);
							if (destructive) {
								const attachmentActionPattern = new RegExp(safetyPatterns.attachmentAction, 'i');
								const attachmentContextPattern = new RegExp(safetyPatterns.attachmentContext, 'i');
								const rowContextPattern = new RegExp(safetyPatterns.rowContext, 'i');
								const matches = (pattern, value) => pattern.test(value) || pattern.test(safetyTokens(value));
								const explicitAttachmentAction = matches(attachmentActionPattern, (label + ' ' + attributeSignal).trim());
								let attachmentContext = false;
								let destructiveRow = false;
								for (let node = clickable, depth = 0; depth < 5 && node?.nodeType === 1; depth++, node = node.parentElement) {
									const context = (attributes(node) + ' ' + (depth <= 2 ? readable(node).slice(0, 240) : '')).trim();
									if (matches(rowContextPattern, context)) destructiveRow = true;
									if (matches(attachmentContextPattern, context)) { attachmentContext = true; break; }
									if (depth > 0 && node.matches?.('form,[role="dialog"],[role="row"],tr')) break;
								}
								if ((destructiveRow && !explicitAttachmentAction) || (!explicitAttachmentAction && !attachmentContext)) {
									throw new Error('安全策略在点击前复核时发现非附件删除或移除控件');
								}
							}
							return { ok: true, point: currentPoint, label, isDraft };
						}
						return { ok: true, point: currentPoint, label, isDraft: false };
					} catch (error) {
						return { ok: false, error: error?.message || String(error) };
					}
				})()`, true);
				if (!verified?.ok) throw new Error(verified?.error || "可信鼠标目标复核失败");
				return verified;
			};
			try {
				let verified = await verifyPointerTarget();
				const point = verified.point;
				view.webContents.sendInputEvent({ type: "mouseMove", ...point });
				await new Promise((resolve) => setTimeout(resolve, response.pointer.kind === "hover" ? 100 : 40));
				if (response.pointer.kind === "click") {
					verified = await verifyPointerTarget();
					view.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
					view.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
				}
				const prefix = response.pointer.kind === "hover" ? "已悬浮：" : verified.isDraft ? "已点击草稿保存按钮：" : "已点击：";
				return redactSensitiveText(prefix + verified.label);
			} finally {
				await view.webContents.executeJavaScript(`(() => {
					for (const element of document.querySelectorAll('[data-pi-agent-action-token]')) {
						if (element.getAttribute('data-pi-agent-action-token') === ${JSON.stringify(actionToken)}) {
							element.removeAttribute('data-pi-agent-action-token');
						}
					}
				})()`).catch(() => {});
			}
		}
		return redactSensitiveText(response.value);
	}

	async click(target) {
		await this.open();
		this.status = "正在点击页面元素（browser_click）";
		this.emitState();
		const output = await this.findAndRun(target, { kind: "click" });
		this.status = output;
		this.emitState();
		return output;
	}

	async hover(target) {
		await this.open();
		this.status = "正在悬浮页面元素（browser_hover）";
		this.emitState();
		const output = await this.findAndRun(target, { kind: "hover" });
		this.status = output;
		this.emitState();
		return output;
	}

	async type(target, value, pressEnter, commit) {
		await this.open();
		this.status = "正在输入页面内容（browser_type）";
		this.emitState();
		const output = await this.findAndRun(target, { kind: "type", value, pressEnter, commit });
		this.status = output;
		this.emitState();
		return output;
	}

	/**
	 * 把本地文件注入页面的文件上传输入框（DataTransfer 方式，不弹系统对话框）。
	 * 大文件分块传入页面，避免单次 executeJavaScript 字符串过大。
	 * files: [{ name, mimeType, dataBase64 }]
	 */
	async uploadFiles(files, target, allowedOrigin, trustedGuard) {
		const view = this.ensureView();
		await this.open();
		this.status = `正在上传 ${files.length} 个附件（browser_upload）`;
		this.emitState();
		const webContents = view.webContents;
		if (typeof webContents.executeJavaScriptInIsolatedWorld !== "function") {
			throw new Error("当前浏览器内核不支持隔离附件传输，已停止上传");
		}
		const startUrl = webContents.getURL();
		let startOrigin;
		let lockedOrigin;
		try {
			startOrigin = agentBrowserUploadOrigin(startUrl);
			lockedOrigin = agentBrowserUploadOrigin(allowedOrigin);
		} catch {
			throw new Error("附件上传缺少有效的调用方来源锁，已在读取页面数据前停止");
		}
		if (String(allowedOrigin).trim() !== lockedOrigin || startOrigin !== lockedOrigin) {
			throw new Error("当前页面来源与调用方锁定来源不一致，已在注入附件数据前停止");
		}
		const activeTrustedGuard = trustedGuard?.trustedEkuaibao
			? {
					trustedEkuaibao: true,
					pageToken: String(trustedGuard.pageToken || ""),
					expectedDigest: String(trustedGuard.expectedDigest || ""),
				}
			: null;
		if (
			activeTrustedGuard &&
			(!/^[0-9a-f-]{36}$/i.test(activeTrustedGuard.pageToken) ||
				!/^[0-9a-f]{64}$/i.test(activeTrustedGuard.expectedDigest) ||
				lockedOrigin !== EKUAIBAO_TRUSTED_ORIGIN)
		) {
			throw trustedEkuaibaoError("invalid_command", "可信合思上传缺少有效的页面令牌、DOM digest 或固定来源锁");
		}
		const revalidateTrustedUpload = async () => {
			if (!activeTrustedGuard) return;
			const state = await this.inspectTrustedEkuaibaoPage();
			this.assertTrustedEkuaibaoMutation(activeTrustedGuard, state);
		};
		await revalidateTrustedUpload();
		const uploadToken = randomUUID();
		const encodedTrustedGuard = JSON.stringify(activeTrustedGuard);
		const isolated = (code) => webContents.executeJavaScriptInIsolatedWorld(
			UPLOAD_ISOLATED_WORLD_ID,
			[{ code }],
			true,
		);
		const cleanupCode = `(() => {
			if (globalThis.__piUploadSession?.token === ${JSON.stringify(uploadToken)}) delete globalThis.__piUploadSession;
			return true;
		})()`;
		let navigationStarted = false;
		const onNavigation = (_event, _url, _isInPlace, isMainFrame) => {
			if (isMainFrame === false) return;
			navigationStarted = true;
			void isolated(cleanupCode).catch(() => {});
		};
		webContents.on("did-start-navigation", onNavigation);
		const assertSameDocument = () => {
			if (navigationStarted || webContents.isDestroyed() || webContents.getURL() !== startUrl) {
				throw new Error("附件上传期间页面发生导航，已中止并清理待上传数据");
			}
		};
		try {
			assertSameDocument();
			const initialized = await isolated(`(() => {
				if (location.href !== ${JSON.stringify(startUrl)} || location.origin !== ${JSON.stringify(startOrigin)}) {
					return { ok: false, error: '附件上传页面与锁定页面不一致' };
				}
				globalThis.__piUploadSession = {
					token: ${JSON.stringify(uploadToken)},
					trustedGuard: ${encodedTrustedGuard},
					files: [],
				};
				return { ok: true };
			})()`);
			if (!initialized?.ok) throw new Error(initialized?.error || "无法建立隔离附件传输会话");
			for (const file of files) {
				assertSameDocument();
				const added = await isolated(`(() => {
					const session = globalThis.__piUploadSession;
					if (session?.token !== ${JSON.stringify(uploadToken)} || location.href !== ${JSON.stringify(startUrl)} || location.origin !== ${JSON.stringify(startOrigin)}) {
						return { ok: false, error: '附件传输会话已失效' };
					}
					session.files.push({ name: ${JSON.stringify(file.name)}, mimeType: ${JSON.stringify(file.mimeType)}, parts: [] });
					return { ok: true };
				})()`);
				if (!added?.ok) throw new Error(added?.error || "附件传输会话已失效");
				const chunkSize = 262144;
				for (let offset = 0; offset < file.dataBase64.length; offset += chunkSize) {
					assertSameDocument();
					const chunk = JSON.stringify(file.dataBase64.slice(offset, offset + chunkSize));
					const appended = await isolated(`(() => {
						const session = globalThis.__piUploadSession;
						if (session?.token !== ${JSON.stringify(uploadToken)} || location.href !== ${JSON.stringify(startUrl)} || location.origin !== ${JSON.stringify(startOrigin)}) {
							return { ok: false, error: '附件传输会话已失效' };
						}
						session.files[session.files.length - 1].parts.push(${chunk});
						return { ok: true };
					})()`);
					if (!appended?.ok) throw new Error(appended?.error || "附件分块传输已中止");
				}
			}
			assertSameDocument();
			await revalidateTrustedUpload();
			assertSameDocument();
			const encodedTarget = JSON.stringify(target ?? {});
			const response = await isolated(`(() => {
				try {
					const session = globalThis.__piUploadSession;
					if (session?.token !== ${JSON.stringify(uploadToken)} || location.href !== ${JSON.stringify(startUrl)} || location.origin !== ${JSON.stringify(startOrigin)}) {
						throw new Error('附件上传前页面或文档已改变');
					}
					const trustedGuard = ${encodedTrustedGuard};
					if (trustedGuard && (
						session.trustedGuard?.pageToken !== trustedGuard.pageToken ||
						session.trustedGuard?.expectedDigest !== trustedGuard.expectedDigest ||
						location.origin !== ${JSON.stringify(EKUAIBAO_TRUSTED_ORIGIN)} ||
						location.pathname !== '/web/app.html' ||
						!/^#\\/billEntryDetail(?:[/?]|$)/.test(location.hash)
					)) throw new Error('可信合思上传令牌、DOM digest 或页面路由已失效');
					const items = session.files;
					delete globalThis.__piUploadSession;
					const target = ${encodedTarget};
					const hasAnchorLocator = Boolean(target.ref || target.selector || target.text);
					const hasTarget = Boolean(
						hasAnchorLocator || target.within ||
						(Array.isArray(target.scopeTexts) && target.scopeTexts.length)
					);
					const readable = (item) => (
						item?.innerText || item?.value || item?.getAttribute?.('aria-label') || item?.getAttribute?.('title') ||
						item?.getAttribute?.('placeholder') || item?.getAttribute?.('data-testid') || item?.getAttribute?.('data-test') || ''
					).replace(/\\s+/g, ' ').trim();
					const visible = (element) => {
						const style = getComputedStyle(element);
						const rect = element.getBoundingClientRect();
						return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
					};
					const roots = [document];
					for (let index = 0; index < roots.length; index++) {
						const root = roots[index];
						for (const node of root.querySelectorAll('*')) {
							if (node.shadowRoot) roots.push(node.shadowRoot);
							if (node.tagName === 'IFRAME') {
								try { if (node.contentDocument) roots.push(node.contentDocument); } catch { /* cross-origin */ }
							}
						}
					}
					const queryAll = (selector, bases = roots) => {
						const found = [];
						const seen = new Set();
						for (const base of bases) {
							if (base.matches?.(selector) && !seen.has(base)) { seen.add(base); found.push(base); }
							for (const item of base.querySelectorAll?.(selector) || []) {
								if (!seen.has(item)) { seen.add(item); found.push(item); }
							}
						}
						return found;
					};
					const layer = (element) => {
						let value = 0;
						for (let node = element; node?.nodeType === 1; node = node.parentElement) {
							const parsed = Number.parseInt(getComputedStyle(node).zIndex, 10);
							if (Number.isFinite(parsed)) value = Math.max(value, parsed);
						}
						return value;
					};
					const overlays = queryAll('[role="dialog"],[aria-modal="true"],.ant-modal-wrap,.ant-drawer-content-wrapper,[class*="drawer-content"],[class*="modal-content"]')
						.filter(visible)
						.sort((left, right) => layer(right) - layer(left) || readable(left).length - readable(right).length);
					const orderedBases = (bases) => bases === roots ? [...overlays, ...roots] : bases;
					const occurrenceIndex = (locator) => Math.max(0, (Number(locator?.occurrence) || 1) - 1);
					const localScopeSelector = '[role="dialog"],[aria-modal="true"],[role="row"],tr,li,form,section,article,[class*="drawer"],[class*="modal"],[class*="item"],[class*="card"],[class*="detail"],[class*="field"],[class*="form-item"],[data-testid],[data-test]';
					const overlayScopeSelector = '[role="dialog"],[aria-modal="true"],[class*="drawer"],[class*="modal"]';
					const hasLocalScope = (candidate, wanted, boundary) => {
						const directText = readable(candidate);
						if (directText.length <= 800 && wanted.every((text) => directText.includes(text))) return true;
						let node = candidate.parentElement || candidate.getRootNode?.()?.host || null;
						for (let depth = 0; depth < 12 && node?.nodeType === 1; depth++) {
							if (node === document.body || node === document.documentElement) break;
							if (node.matches?.(localScopeSelector)) {
								const scopedText = readable(node);
								const isOverlayScope = node.matches(overlayScopeSelector);
								if ((isOverlayScope || scopedText.length <= 2500) && wanted.every((text) => scopedText.includes(text))) {
									return true;
								}
							}
							if (node === boundary) break;
							const root = node.getRootNode?.();
							node = node.parentElement || root?.host || null;
						}
						return false;
					};
					const locatorCandidates = (locator, bases = roots, requireUniqueLocator = false) => {
						const scopedBases = orderedBases(bases);
						let candidates = [];
						if (locator?.ref) candidates = queryAll('[data-pi-agent-ref="' + CSS.escape(locator.ref) + '"]', scopedBases);
						else if (locator?.selector) {
							try { candidates = queryAll(locator.selector, scopedBases); } catch { throw new Error('CSS selector 无效'); }
							if (requireUniqueLocator && candidates.length > 1 && !locator.occurrence && !trustedGuard) {
								throw new Error('CSS selector 匹配到 ' + candidates.length + ' 个元素，请提供 occurrence 指定第几个');
							}
						} else if (locator?.text) {
							const pool = queryAll('input,label,button,a,div,span,[role=button],[data-testid],[data-test]', scopedBases);
							const exact = pool.filter((item) => readable(item) === locator.text);
							candidates = exact.length
								? exact
								: pool.filter((item) => readable(item).includes(locator.text)).sort((left, right) => readable(left).length - readable(right).length);
						}
						const scopeTexts = Array.isArray(locator?.scopeTexts)
							? locator.scopeTexts.map((item) => String(item || '').replace(/\\s+/g, ' ').trim()).filter(Boolean)
							: [];
						if (scopeTexts.length) {
							const boundary = bases.find((base) => base?.nodeType === 1) || null;
							candidates = candidates.filter((candidate) => hasLocalScope(candidate, scopeTexts, boundary));
						}
						if (requireUniqueLocator && candidates.length > 1 && !locator?.occurrence && !trustedGuard) {
							throw new Error('上传目标匹配到 ' + candidates.length + ' 个文本或引用锚点，已拒绝默认选择第一个');
						}
						return candidates;
					};
					const fileInputBoundToAnchor = (candidate) => {
						if (candidate?.matches?.('input[type=file]')) return candidate;
						if (candidate?.tagName === 'LABEL' && candidate.control?.matches?.('input[type=file]')) return candidate.control;
						if (candidate?.getAttribute?.('aria-controls')) {
							const controlled = candidate.ownerDocument.getElementById(candidate.getAttribute('aria-controls'));
							if (controlled?.matches?.('input[type=file]')) return controlled;
						}
						for (let node = candidate; node?.nodeType === 1; node = node.parentElement || node.getRootNode?.()?.host || null) {
							const nearby = queryAll('input[type=file]', [node]);
							if (nearby.length > 0) return nearby.length === 1 ? nearby[0] : null;
							if (node === document.body) break;
						}
						return null;
					};
					const resolveLocator = (locator, bases = roots, strictSelector = false) => {
						const candidates = locatorCandidates(locator, bases, strictSelector);
						if (trustedGuard && strictSelector && candidates.length > 1 && !locator?.occurrence) {
							const bindings = candidates.map(fileInputBoundToAnchor);
							const uniqueBindings = [...new Set(bindings.filter(Boolean))];
							if (bindings.some((binding) => !binding) || uniqueBindings.length !== 1) {
								throw new Error('可信上传文本锚点对应多个或不明确的 file input，已拒绝默认选择第一个');
							}
							return candidates.find((candidate) => candidate === uniqueBindings[0] || candidate.control === uniqueBindings[0]) || candidates[0];
						}
						return candidates[occurrenceIndex(locator)] || null;
					};
					let withinElement = null;
					let targetBases = roots;
					if (target.within) {
						withinElement = resolveLocator(target.within, roots, true);
						if (!withinElement) throw new Error('指定的上传范围不存在，未回退到全页上传框');
						targetBases = [withinElement];
						if (withinElement.shadowRoot) targetBases.push(withinElement.shadowRoot);
					}
					const inputs = queryAll('input[type=file]');
					if (inputs.length === 0) throw new Error('页面没有文件上传入口');
					let anchor = null;
					if (target.ref || target.selector || target.text) anchor = resolveLocator(target, targetBases, true);
					if (!anchor && Array.isArray(target.scopeTexts) && target.scopeTexts.length) {
						const wanted = target.scopeTexts.map((item) => String(item || '').replace(/\\s+/g, ' ').trim()).filter(Boolean);
						const scopedAnchors = queryAll('section,article,form,li,tr,[role="row"],[role="dialog"],[class*="item"],[class*="card"],[class*="detail"],[class*="drawer"],[class*="modal"],div', targetBases)
							.filter((item) => wanted.every((text) => readable(item).includes(text)))
							.sort((left, right) => readable(left).length - readable(right).length);
						if (scopedAnchors.length > 1 && !target.occurrence) {
							throw new Error('上传范围文本匹配到多个锚点，已拒绝默认选择第一个');
						}
						anchor = scopedAnchors[occurrenceIndex(target)] || null;
					}
					if (hasAnchorLocator && !anchor) throw new Error('指定的上传目标不存在，未回退到 within、弹窗或全页上传框');
					if (hasTarget && !anchor && !withinElement) throw new Error('指定的上传目标不存在，未回退到全页上传框');
					let element = null;
					if (anchor?.matches?.('input[type=file]')) element = anchor;
					if (
						!element && anchor?.tagName === 'LABEL' && anchor.control?.matches?.('input[type=file]') &&
						(!withinElement || withinElement.contains(anchor.control))
					) {
						element = anchor.control;
					}
					if (!element && anchor?.getAttribute?.('aria-controls')) {
						const controlled = anchor.ownerDocument.getElementById(anchor.getAttribute('aria-controls'));
						if (controlled?.matches?.('input[type=file]') && (!withinElement || withinElement.contains(controlled))) {
							element = controlled;
						}
					}
					if (!element && anchor && trustedGuard) element = fileInputBoundToAnchor(anchor);
					if (!element && anchor) {
						const localBoundarySelector = 'label,[data-testid],[data-test],[class*="upload"],[class*="attachment"],[class*="field"],[class*="form-item"],[role="group"],[role="dialog"],[aria-modal="true"],[role="row"],tr,li,form,section,article,[class*="drawer"],[class*="modal"],[class*="detail"],[class*="item"],[class*="card"]';
						const closestBoundary = anchor.closest?.(localBoundarySelector) || null;
						const nearestBoundary = closestBoundary && (!withinElement || withinElement.contains(closestBoundary))
							? closestBoundary
							: withinElement || anchor;
						const boundaryBases = [nearestBoundary];
						if (nearestBoundary.shadowRoot) boundaryBases.push(nearestBoundary.shadowRoot);
						const boundaryInputs = queryAll('input[type=file]', boundaryBases);
						if (boundaryInputs.length > 1) throw new Error('指定目标最近边界内存在多个上传框，已拒绝猜测');
						if (boundaryInputs.length === 1) element = boundaryInputs[0];
					}
					if (!element && withinElement) {
						const scopedInputs = queryAll('input[type=file]', targetBases);
						if (scopedInputs.length === 1) element = scopedInputs[0];
						else if (target.occurrence && scopedInputs[occurrenceIndex(target)]) element = scopedInputs[occurrenceIndex(target)];
						else if (scopedInputs.length > 1) throw new Error('within 指定范围内存在多个上传框，必须精确指定');
					}
					if (!element) {
						if (hasTarget) throw new Error('指定目标附近没有唯一上传框，未回退到全页；请用隐藏 file input 的 ref 或 occurrence 精确指定');
						if (inputs.length !== 1) throw new Error('页面有 ' + inputs.length + ' 个上传入口，必须用 ref、selector、scopeTexts 或 within 指定明细，已停止以防附件传错');
						element = inputs[0];
					}
					if (trustedGuard) {
						if (!anchor || element.ownerDocument !== document) {
							throw new Error('可信合思上传没有绑定主文档中的唯一业务锚点和文件输入框');
						}
						const uploadBoundarySelector = 'input[type=file],label,[data-testid],[data-test],[class*="upload"],[class*="attachment"],[class*="field"],[class*="form-item"],[role="group"],section,article,form,li,tr,[role="row"],[role="dialog"],[class*="drawer"],[class*="modal"]';
						let boundaryNode = anchor;
						let boundInputs = [];
						for (let depth = 0; depth < 14 && boundaryNode?.nodeType === 1; depth++) {
							if (boundaryNode.matches?.(uploadBoundarySelector)) {
								const candidates = queryAll('input[type=file]', [boundaryNode]);
								if (candidates.length > 0) { boundInputs = candidates; break; }
							}
							if (boundaryNode === withinElement || boundaryNode === document.body) break;
							boundaryNode = boundaryNode.parentElement || boundaryNode.getRootNode?.()?.host || null;
						}
						if (boundInputs.length !== 1 || boundInputs[0] !== element) {
							throw new Error('可信合思上传锚点未与同一最近边界内的唯一 file input 绑定');
						}
					}
					const ownerWindow = element.ownerDocument.defaultView || window;
					const trustedBindingAttribute = 'data-pi-trusted-upload-token';
					if (trustedGuard) {
						element.setAttribute(trustedBindingAttribute, session.token);
						const bound = queryAll('[' + trustedBindingAttribute + '="' + CSS.escape(session.token) + '"]');
						if (bound.length !== 1 || bound[0] !== element) {
							element.removeAttribute(trustedBindingAttribute);
							throw new Error('可信合思上传输入框无法与本次隔离传输 token 唯一绑定');
						}
					}
					try {
						const dt = new ownerWindow.DataTransfer();
						for (const item of items) {
							const bin = ownerWindow.atob(item.parts.join(''));
							const bytes = new Uint8Array(bin.length);
							for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
							dt.items.add(new ownerWindow.File([bytes], item.name, { type: item.mimeType || 'application/octet-stream' }));
						}
						element.files = dt.files;
						element.dispatchEvent(new ownerWindow.Event('input', { bubbles: true }));
						element.dispatchEvent(new ownerWindow.Event('change', { bubbles: true }));
						const selected = [...element.files].map((file) => file.name);
						if (selected.length !== items.length || selected.some((name, index) => name !== items[index].name)) {
							throw new Error('页面没有保留全部附件，已停止后续填写');
						}
						const targetLabel = element.getAttribute('data-testid') || element.getAttribute('name') || readable(anchor || element) || '指定上传框';
						return { ok: true, value: '已向“' + targetLabel.slice(0, 80) + '”选择 ' + selected.length + ' 个文件：' + selected.join('、') };
					} finally {
						if (trustedGuard) element.removeAttribute(trustedBindingAttribute);
					}
				} catch (error) {
					delete globalThis.__piUploadSession;
					return { ok: false, error: error?.message || String(error) };
				}
			})()`, true);
			if (!response?.ok) throw new Error(response?.error || "附件上传失败");
			const output = redactSensitiveText(response.value);
			this.status = output;
			this.emitState();
			return output;
		} catch (error) {
			this.status = `附件上传失败：${error?.message || error}`;
			this.emitState();
			throw error;
		} finally {
			webContents.removeListener("did-start-navigation", onNavigation);
			if (!webContents.isDestroyed()) await isolated(cleanupCode).catch(() => {});
		}
	}

	async scroll(direction, amount) {
		const view = this.ensureView();
		await this.open();
		const pixels = Math.max(100, Math.min(Number(amount) || 700, 5000));
		const x = direction === "left" ? -pixels : direction === "right" ? pixels : 0;
		const y = direction === "up" ? -pixels : direction === "down" ? pixels : 0;
		await view.webContents.executeJavaScript(`(() => {
			const candidates = [document.scrollingElement, ...document.querySelectorAll('*')].filter((element) => {
				if (!element) return false;
				const style = getComputedStyle(element);
				const canScrollY = ${y} !== 0 && element.scrollHeight > element.clientHeight + 2 && /(auto|scroll)/.test(style.overflowY);
				const canScrollX = ${x} !== 0 && element.scrollWidth > element.clientWidth + 2 && /(auto|scroll)/.test(style.overflowX);
				return canScrollY || canScrollX || element === document.scrollingElement;
			});
			const target = candidates.sort((left, right) => {
				const leftRange = Math.max(left.scrollHeight - left.clientHeight, left.scrollWidth - left.clientWidth);
				const rightRange = Math.max(right.scrollHeight - right.clientHeight, right.scrollWidth - right.clientWidth);
				return rightRange - leftRange;
			})[0] || document.scrollingElement;
			target?.scrollBy({ left: ${x}, top: ${y}, behavior: 'smooth' });
			return true;
		})()`);
		this.status = `已${direction === "up" ? "向上" : direction === "down" ? "向下" : direction === "left" ? "向左" : "向右"}滚动 ${pixels} 像素`;
		this.emitState();
		return this.status;
	}

	async extract(selector, maxChars) {
		const view = this.ensureView();
		await this.open();
		const limit = Math.max(500, Math.min(Number(maxChars) || 8000, 20000));
		const encodedSelector = JSON.stringify(selector || "");
		const extracted = await view.webContents.executeJavaScript(`(() => {
			const selector = ${encodedSelector};
			let root = document.body;
			if (selector) {
				try { root = document.querySelector(selector); } catch { throw new Error("CSS selector 无效"); }
			}
			if (!root) throw new Error("没有找到要读取的页面区域");
			return (root.innerText || root.textContent || '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, ${limit});
		})()`);
		this.status = `已读取网页内容：${extracted.length} 个字符`;
		this.emitState();
		return `网址：${redactSensitiveUrl(view.webContents.getURL())}\n\n${redactSensitiveText(extracted) || "（没有可见文字）"}`;
	}

	async screenshot(path) {
		const view = this.ensureView();
		await this.open();
		const image = await view.webContents.capturePage();
		writeFileSync(path, image.toPNG());
		this.status = `网页截图已保存：${path}`;
		this.emitState();
		return this.status;
	}

	async wait(milliseconds, text) {
		const view = this.ensureView();
		await this.open();
		const timeout = Math.max(100, Math.min(Number(milliseconds) || 2000, 30000));
		this.status = text ? `正在等待网页出现文字：${text}` : `正在等待网页 ${timeout} 毫秒`;
		this.emitState();
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (!text) {
				await new Promise((resolve) => setTimeout(resolve, timeout));
				break;
			}
			const found = await view.webContents.executeJavaScript(`(document.body?.innerText || '').includes(${JSON.stringify(text)})`);
			if (found) {
				this.status = `网页已出现文字：${text}`;
				this.emitState();
				return this.status;
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		if (text) throw new Error(`等待超时，页面中没有出现：${text}`);
		this.status = "等待完成";
		this.emitState();
		return this.status;
	}
}
