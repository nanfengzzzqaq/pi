import { WebContentsView, session } from "electron";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

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
			url: rawUrl === EMPTY_PAGE ? "" : rawUrl,
			title: cleanText(contents?.getTitle()),
			loading: contents?.isLoading() ?? false,
			canGoBack: contents?.navigationHistory.canGoBack() ?? false,
			canGoForward: contents?.navigationHistory.canGoForward() ?? false,
			status: this.status,
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
		if (this.view && !this.view.webContents.isDestroyed()) this.view.setVisible(false);
		return this.emitState();
	}

	async navigate(url) {
		const view = this.ensureView();
		this.isOpen = true;
		view.setVisible(true);
		const target = normalizedUrl(url);
		this.status = `正在打开：${target}`;
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
			const selector = "a,button,input,textarea,select,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[contenteditable=true]";
			const elements = [...document.querySelectorAll(selector)].filter(visible).slice(0, 80).map((element, index) => {
				const ref = "e" + (index + 1);
				element.setAttribute("data-pi-agent-ref", ref);
				const rect = element.getBoundingClientRect();
				return {
					ref,
					tag: element.tagName.toLowerCase(),
					role: element.getAttribute("role") || "",
					text: (element.innerText || element.value || element.getAttribute("aria-label") || element.getAttribute("title") || element.getAttribute("placeholder") || "").replace(/\\s+/g, " ").trim().slice(0, 180),
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
		const elementLines = snapshot.elements.map((element) => {
			const label = [element.tag, element.role, element.disabled ? "disabled" : ""].filter(Boolean).join("/");
			const href = element.href ? ` -> ${element.href}` : "";
			return `[${element.ref}] ${label} ${element.text || "（无文字）"}${href}`;
		});
		this.status = `页面状态已读取：${snapshot.elements.length} 个可操作元素`;
		this.emitState();
		return [`标题：${snapshot.title || "（无）"}`, `网址：${snapshot.url}`, "", "可操作元素：", ...elementLines, "", "页面正文：", snapshot.text].join("\n").slice(0, limit + 6000);
	}

	async findAndRun(target, action) {
		const view = this.ensureView();
		const encodedTarget = JSON.stringify(target ?? {});
		const encodedAction = JSON.stringify(action);
		return view.webContents.executeJavaScript(`(() => {
			const target = ${encodedTarget};
			let element = null;
			if (target.ref) element = document.querySelector('[data-pi-agent-ref="' + CSS.escape(target.ref) + '"]');
			if (!element && target.selector) {
				try { element = document.querySelector(target.selector); } catch { throw new Error("CSS selector 无效"); }
			}
			if (!element && target.text) {
				const candidates = [...document.querySelectorAll('a,button,input,textarea,select,summary,[role=button],[role=link],[contenteditable=true]')];
				element = candidates.find((item) => (item.innerText || item.value || item.getAttribute('aria-label') || '').trim() === target.text)
					|| candidates.find((item) => (item.innerText || item.value || item.getAttribute('aria-label') || '').includes(target.text));
			}
			if (!element) throw new Error("没有找到目标元素，请先调用 browser_snapshot 获取最新 ref");
			element.scrollIntoView({ block: 'center', inline: 'center' });
			const label = (element.innerText || element.value || element.getAttribute('aria-label') || element.tagName).replace(/\\s+/g, ' ').trim().slice(0, 160);
			const action = ${encodedAction};
			if (action.kind === 'click') {
				element.focus();
				element.click();
				return '已点击：' + label;
			}
			const value = action.value;
			if (element.isContentEditable) {
				element.focus();
				element.textContent = value;
			} else if ('value' in element) {
				element.focus();
				const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : element.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
				const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
				if (setter) setter.call(element, value); else element.value = value;
			} else {
				throw new Error("目标元素不可输入");
			}
			element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
			element.dispatchEvent(new Event('change', { bubbles: true }));
			if (action.submit) {
				if (element.form?.requestSubmit) element.form.requestSubmit();
				else {
					element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
					element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
				}
			}
			return '已输入：' + label + (action.submit ? '，并已提交' : '');
		})()`, true);
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

	async type(target, value, submit) {
		await this.open();
		this.status = "正在输入页面内容（browser_type）";
		this.emitState();
		const output = await this.findAndRun(target, { kind: "type", value, submit });
		this.status = output;
		this.emitState();
		return output;
	}

	async scroll(direction, amount) {
		const view = this.ensureView();
		await this.open();
		const pixels = Math.max(100, Math.min(Number(amount) || 700, 5000));
		const x = direction === "left" ? -pixels : direction === "right" ? pixels : 0;
		const y = direction === "up" ? -pixels : direction === "down" ? pixels : 0;
		await view.webContents.executeJavaScript(`window.scrollBy({ left: ${x}, top: ${y}, behavior: 'smooth' })`);
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
		return `网址：${view.webContents.getURL()}\n\n${extracted || "（没有可见文字）"}`;
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
