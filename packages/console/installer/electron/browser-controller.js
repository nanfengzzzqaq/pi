import { WebContentsView, session } from "electron";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { redactSensitiveText, redactSensitiveUrl } from "./src/agent-browser-runtime.ts";
import {
	EKUAIBAO_DANGEROUS_ATTRIBUTE_PATTERN,
	EKUAIBAO_DANGEROUS_LABEL_PATTERN,
	EKUAIBAO_DRAFT_ATTRIBUTE_PATTERN,
	EKUAIBAO_DRAFT_LABEL_PATTERN,
} from "./src/agent-browser-safety.ts";

const BROWSER_PARTITION = "persist:pi-agent-browser";
const EMPTY_PAGE = "about:blank";

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
		contents.on("did-navigate", () => this.emitState());
		contents.on("did-navigate-in-page", () => this.emitState());
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

	async snapshot(maxChars) {
		const view = this.ensureView();
		await this.open();
		this.status = "正在获取页面状态（browser_snapshot）";
		this.emitState();
		const limit = Math.max(1000, Math.min(Number(maxChars) || 6000, 12000));
		const snapshot = await view.webContents.executeJavaScript(`(() => {
			const visible = (element) => {
				const style = getComputedStyle(element);
				const rect = element.getBoundingClientRect();
				return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
			};
			document.querySelectorAll('[data-pi-agent-ref]').forEach((element) => element.removeAttribute('data-pi-agent-ref'));
			const selector = "a,button,input,textarea,select,summary,label,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=combobox],[role=option],[contenteditable=true],[data-testid],[data-test],[placeholder],[onclick],[tabindex]:not([tabindex='-1'])";
			const semantic = [...document.querySelectorAll(selector)];
			const pointerElements = [...document.querySelectorAll('div,span,li')].filter((element) => getComputedStyle(element).cursor === 'pointer');
			const elements = [...new Set([...semantic, ...pointerElements])].filter(visible).slice(0, 200).map((element, index) => {
				const ref = "e" + (index + 1);
				element.setAttribute("data-pi-agent-ref", ref);
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
				return {
					ref,
					tag: element.tagName.toLowerCase(),
					role: element.getAttribute("role") || "",
					text: (element.innerText || element.value || element.getAttribute("aria-label") || element.getAttribute("title") || element.getAttribute("placeholder") || element.getAttribute("data-testid") || element.getAttribute("data-test") || "").replace(/\\s+/g, " ").trim().slice(0, 180),
					testId: element.getAttribute("data-testid") || element.getAttribute("data-test") || "",
					placeholder: element.getAttribute("placeholder") || "",
					name: element.getAttribute("name") || "",
					type: element.getAttribute("type") || "",
					fieldLabel: fieldLabel.slice(0, 100),
					href: element.href || "",
					disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
					x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height),
				};
			});
			return {
				url: location.href,
				title: document.title,
				text: (document.body?.innerText || "").replace(/\\n{3,}/g, "\\n\\n").slice(0, ${limit}),
				elements,
			};
		})()`);
		snapshot.url = redactSensitiveUrl(snapshot.url);
		snapshot.text = redactSensitiveText(snapshot.text);
		const elementLines = snapshot.elements.map((element) => {
			const label = [element.tag, element.role, element.disabled ? "disabled" : ""].filter(Boolean).join("/");
			const hints = [
				element.fieldLabel ? `label=${element.fieldLabel}` : "",
				element.testId ? `testid=${element.testId}` : "",
				element.placeholder ? `placeholder=${element.placeholder}` : "",
				element.name ? `name=${element.name}` : "",
				element.type ? `type=${element.type}` : "",
			]
				.filter(Boolean)
				.join(" ");
			const href = element.href ? ` -> ${redactSensitiveUrl(element.href)}` : "";
			return `[${element.ref}] ${label} ${redactSensitiveText(element.text) || "（无文字）"}${hints ? ` (${hints})` : ""}${href}`;
		});
		this.status = `页面状态已读取：${snapshot.elements.length} 个可操作元素`;
		this.emitState();
		return redactSensitiveText(
			[`标题：${redactSensitiveText(snapshot.title) || "（无）"}`, `网址：${snapshot.url}`, "", "可操作元素：", ...elementLines, "", "页面正文：", snapshot.text]
				.join("\n")
				.slice(0, limit + 6000),
		);
	}

	async findAndRun(target, action) {
		const view = this.ensureView();
		const encodedTarget = JSON.stringify(target ?? {});
		const encodedAction = JSON.stringify(action);
		const encodedSafetyPatterns = JSON.stringify({
			dangerousAttribute: EKUAIBAO_DANGEROUS_ATTRIBUTE_PATTERN,
			dangerousLabel: EKUAIBAO_DANGEROUS_LABEL_PATTERN,
			draftAttribute: EKUAIBAO_DRAFT_ATTRIBUTE_PATTERN,
			draftLabel: EKUAIBAO_DRAFT_LABEL_PATTERN,
		});
		const response = await view.webContents.executeJavaScript(`(() => {
			try {
				const target = ${encodedTarget};
				const action = ${encodedAction};
				const safetyPatterns = ${encodedSafetyPatterns};
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
				const queryAll = (selector) => roots.flatMap((root) => [...root.querySelectorAll(selector)]);
				const readable = (item) => (
					item.innerText || item.value || item.getAttribute('aria-label') || item.getAttribute('title') ||
					item.getAttribute('placeholder') || item.getAttribute('data-testid') || item.getAttribute('data-test') || ''
				).replace(/\\s+/g, ' ').trim();
				let element = null;
				if (target.ref) element = queryAll('[data-pi-agent-ref="' + CSS.escape(target.ref) + '"]')[0] || null;
				if (!element && target.selector) {
					try { element = queryAll(target.selector)[0] || null; } catch { throw new Error("CSS selector 无效"); }
				}
				if (!element && target.text) {
					const selector = 'a,button,input,textarea,select,summary,label,li,[role=button],[role=link],[role=option],[role=combobox],[data-testid],[data-test],[placeholder],[onclick],[contenteditable=true]';
					const semantic = queryAll(selector);
					const textElements = queryAll('div,span,li');
					const candidates = [...new Set([...semantic, ...textElements])];
					element = candidates.find((item) => readable(item) === target.text)
						|| candidates.find((item) => readable(item).includes(target.text));
				}
				if (!element) throw new Error("没有找到目标元素，请先调用 browser_snapshot 获取最新 ref");

				if (action.kind === 'click') {
					const clickableSelector = 'a,button,input[type=button],input[type=submit],summary,label,[role=button],[role=link],[role=option],[data-testid],[data-test],[onclick]';
					let clickable = element.matches(clickableSelector) ? element : (element.closest(clickableSelector) || element);
					if (clickable === element && !element.matches(clickableSelector)) {
						let container = element.parentElement;
						for (let depth = 0; depth < 7 && container; depth++, container = container.parentElement) {
							const radios = [...container.querySelectorAll('input[type=radio]')];
							if (radios.length === 1) { clickable = radios[0]; break; }
							const controls = [...container.querySelectorAll('input:not([type=hidden]),button,[role=button],[role=combobox],[role=option]')];
							if (controls.length === 1) { clickable = controls[0]; break; }
						}
					}
					const label = readable(clickable).slice(0, 160) || clickable.tagName;
					const attributeSignal = [
						target.selector || '', target.text || '', clickable.id || '', clickable.className || '',
						clickable.getAttribute('name') || '', clickable.getAttribute('data-testid') || '',
						clickable.getAttribute('data-test') || '', clickable.getAttribute('aria-label') || '',
						clickable.getAttribute('title') || ''
					].join(' ').replace(/\\s+/g, ' ').trim();
					const isEkuaibao = /(^|\\.)ekuaibao\\.com$/i.test(location.hostname);
					const dangerousAttribute = new RegExp(safetyPatterns.dangerousAttribute, 'i').test(attributeSignal);
					// button.type exposes the browser's effective type, so a button
					// without an explicit type inside a form is still treated as submit.
					const dangerousControl = /^(?:INPUT|BUTTON)$/i.test(clickable.tagName)
						&& Boolean(clickable.form)
						&& /^submit$/i.test(clickable.type || '');
					const dangerousLabel = new RegExp(safetyPatterns.dangerousLabel).test(label);
					if (isEkuaibao && (dangerousAttribute || dangerousControl || dangerousLabel)) {
						throw new Error("安全策略已阻止易快报的提交、删除、作废或撤销操作；差旅插件只允许保存草稿");
					}
					// Draft recognition is deliberately evaluated only after every dangerous
					// signal above has been rejected. It is not an override for submit/delete.
					const isDraft = new RegExp(safetyPatterns.draftLabel).test(label)
						|| new RegExp(safetyPatterns.draftAttribute, 'i').test(' ' + attributeSignal + ' ');
					if (clickable.disabled || clickable.getAttribute('aria-disabled') === 'true') throw new Error("目标元素已禁用");
					clickable.scrollIntoView({ block: 'center', inline: 'center' });
					clickable.focus();
					clickable.click();
					return { ok: true, value: (isDraft ? '已点击草稿保存按钮：' : '已点击：') + label };
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
	async uploadFiles(files, target) {
		const view = this.ensureView();
		await this.open();
		this.status = `正在上传 ${files.length} 个附件（browser_upload）`;
		this.emitState();
		try {
			await view.webContents.executeJavaScript("(() => { window.__piUploadFiles = []; return true; })()");
			for (const file of files) {
				await view.webContents.executeJavaScript(
					`window.__piUploadFiles.push({ name: ${JSON.stringify(file.name)}, mimeType: ${JSON.stringify(file.mimeType)}, parts: [] }), true`,
				);
				const chunkSize = 262144;
				for (let offset = 0; offset < file.dataBase64.length; offset += chunkSize) {
					const chunk = JSON.stringify(file.dataBase64.slice(offset, offset + chunkSize));
					await view.webContents.executeJavaScript(
						`window.__piUploadFiles[window.__piUploadFiles.length - 1].parts.push(${chunk}), true`,
					);
				}
			}
			const encodedTarget = JSON.stringify(target ?? {});
			const response = await view.webContents.executeJavaScript(`(() => {
				try {
					const items = window.__piUploadFiles || [];
					delete window.__piUploadFiles;
					const target = ${encodedTarget};
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
					const queryAll = (selector) => roots.flatMap((root) => [...root.querySelectorAll(selector)]);
					const readable = (item) => (
						item.innerText || item.value || item.getAttribute('aria-label') || item.getAttribute('title') ||
						item.getAttribute('placeholder') || item.getAttribute('data-testid') || item.getAttribute('data-test') || ''
					).replace(/\\s+/g, ' ').trim();
					const inputs = queryAll('input[type=file]');
					if (inputs.length === 0) throw new Error('页面没有文件上传入口');
					let anchor = null;
					if (target.ref) anchor = queryAll('[data-pi-agent-ref="' + CSS.escape(target.ref) + '"]')[0] || null;
					if (!anchor && target.selector) {
						try { anchor = queryAll(target.selector)[0] || null; } catch { throw new Error('CSS selector 无效'); }
					}
					if (!anchor && target.text) {
						const candidates = queryAll('input,label,button,a,div,span,[role=button],[data-testid],[data-test]');
						anchor = candidates.find((item) => readable(item) === target.text)
							|| candidates.find((item) => readable(item).includes(target.text));
					}
					let element = null;
					if (anchor?.matches?.('input[type=file]')) element = anchor;
					if (!element && anchor?.tagName === 'LABEL' && anchor.control?.matches?.('input[type=file]')) element = anchor.control;
					if (!element && anchor) {
						let container = anchor;
						for (let depth = 0; depth < 8 && container; depth++, container = container.parentElement) {
							const nearby = [...container.querySelectorAll?.('input[type=file]') || []];
							if (nearby.length === 1) { element = nearby[0]; break; }
						}
						if (!element) throw new Error('指定的上传目标附近没有唯一的文件输入框，请重新获取页面快照后传 ref 或 selector');
					}
					if (!element) {
						if (inputs.length !== 1) throw new Error('页面有 ' + inputs.length + ' 个上传入口，必须用 ref、selector 或可见文字指定明细，已停止以防附件传错');
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
					delete window.__piUploadFiles;
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
