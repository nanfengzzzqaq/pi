import { WebContentsView, session } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import {
	agentBrowserUploadOrigin,
	deduplicateAgentBrowserSnapshotCandidates,
	redactSensitiveText,
	redactSensitiveUrl,
} from "./src/agent-browser-runtime.ts";

const BROWSER_PARTITION = "persist:pi-agent-browser";
const EMPTY_PAGE = "about:blank";
const UPLOAD_ISOLATED_WORLD_ID = 1001;

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
		this.browserSession = session.fromPartition(BROWSER_PARTITION, { cache: true });
		this.configureDownloads();
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
		contents.on("did-navigate", () => {
			this.emitState();
		});
		contents.on("did-navigate-in-page", () => {
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

	async findAndRun(target, action) {
		const view = this.ensureView();
		const actionToken = randomUUID();
		const encodedTarget = JSON.stringify(target ?? {});
		const encodedAction = JSON.stringify(action);
		const encodedActionToken = JSON.stringify(actionToken);
		const response = await view.webContents.executeJavaScript(`(() => {
			try {
				const target = ${encodedTarget};
				const action = ${encodedAction};
				const actionToken = ${encodedActionToken};
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
					if (clickable.disabled || clickable.getAttribute('aria-disabled') === 'true') throw new Error("目标元素已禁用");
					if (clickable.ownerDocument !== document) {
						throw new Error("目标元素位于内嵌框架，已停止鼠标操作以防坐标偏移点错；请改用顶层页面入口");
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
						const label = readable(clickable).slice(0, 160) || clickable.tagName;
						if (clickable.disabled || clickable.getAttribute('aria-disabled') === 'true') {
							throw new Error('目标元素已禁用，未发送点击事件');
						}
						return { ok: true, point: currentPoint, label };
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
				const prefix = response.pointer.kind === "hover" ? "已悬浮：" : "已点击：";
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
	async uploadFiles(files, target, allowedOrigin) {
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
		const uploadToken = randomUUID();
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
			const encodedTarget = JSON.stringify(target ?? {});
			const response = await isolated(`(() => {
				try {
					const session = globalThis.__piUploadSession;
					if (session?.token !== ${JSON.stringify(uploadToken)} || location.href !== ${JSON.stringify(startUrl)} || location.origin !== ${JSON.stringify(startOrigin)}) {
						throw new Error('附件上传前页面或文档已改变');
					}
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
							if (requireUniqueLocator && candidates.length > 1 && !locator.occurrence) {
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
						if (requireUniqueLocator && candidates.length > 1 && !locator?.occurrence) {
							throw new Error('上传目标匹配到 ' + candidates.length + ' 个文本或引用锚点，已拒绝默认选择第一个');
						}
						return candidates;
					};
					const resolveLocator = (locator, bases = roots, strictSelector = false) => {
						const candidates = locatorCandidates(locator, bases, strictSelector);
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
					const ownerWindow = element.ownerDocument.defaultView || window;
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
