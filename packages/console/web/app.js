"use strict";

// Pi 控制台前端：纯原生 JS，无构建步骤。
// 布局：左栏（助手/技能/文件）+ 聊天区 + 右侧能力详情抽屉（点击助手才展开）。
// Claude 风格：Markdown 渲染、代码高亮、思考过程折叠滚动、工具调用块折叠。

const SESSION_KEY = "pi-console-session";
const TOKEN_KEY = "pi-console-token";

// ---------------------------------------------------------------------------
// 元素引用
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const messagesEl = $("messages");
const inputEl = $("input");
const sendBtn = $("send-btn");
const stopBtn = $("stop-btn");
const indicatorEl = $("indicator");
const errorBarEl = $("error-bar");
const connStateEl = $("conn-state");
const modelSelectEl = $("model-select");
const thinkingSelectEl = $("thinking-select");
const fileInputEl = $("file-input");
const attachBtnEl = $("attach-btn");
const attachmentsEl = $("attachments");
const settingsBtnEl = $("settings-btn");
const settingsModalEl = $("settings-modal");
const settingsCloseEl = $("settings-close");
const keyProviderEl = $("key-provider");
const keyInputEl = $("key-input");
const keyAddBtnEl = $("key-add-btn");
const keyListEl = $("key-list");
const appVersionEl = $("app-version");
const updateCheckBtnEl = $("update-check-btn");
const updateRunBtnEl = $("update-run-btn");
const updateStatusEl = $("update-status");
const updateProgressEl = $("update-progress");
const updateProgressBarEl = $("update-progress-bar");
const dropOverlayEl = $("drop-overlay");
const githubTokenInputEl = $("github-token-input");
const githubTokenSaveBtnEl = $("github-token-save-btn");
const githubTokenClearBtnEl = $("github-token-clear-btn");
const assistantsListEl = $("assistants-list");
const fsRootSelectEl = $("fs-root-select");
const fsTreeEl = $("fs-tree");
const fsRefreshBtnEl = $("fs-refresh");
const fsWorkspacePathEl = $("fs-workspace-path");
const fsSetWorkspaceBtnEl = $("fs-set-workspace");
const workspaceInputEl = $("workspace-input");
const workspaceSaveBtnEl = $("workspace-save-btn");
const workspaceCurrentEl = $("workspace-current");
const previewModalEl = $("preview-modal");
const previewTitleEl = $("preview-title");
const previewContentEl = $("preview-content");
const previewCloseEl = $("preview-close");
const previewAttachBtnEl = $("preview-attach");
const contextInfoEl = $("context-info");
const assistantAddBtnEl = $("assistant-add-btn");
const assistantsModalEl = $("assistants-modal");
const assistantsModalCloseEl = $("assistants-modal-close");
const assistantsModalListEl = $("assistants-modal-list");
const drawerEl = $("drawer");
const drawerTitleEl = $("drawer-title");
const drawerContentEl = $("drawer-content");
const drawerCloseEl = $("drawer-close");

let sessionId = localStorage.getItem(SESSION_KEY);
let lastSeq = -1;
let running = false;
let es = null;
let reconnectTimer = null;
let currentAssistant = null;
let pendingAttachments = [];
let previewFile = null; // 预览中的文件 {name, mimeType, dataBase64, size}

// ---------------------------------------------------------------------------
// 基础请求
// ---------------------------------------------------------------------------

function authHeaders() {
	const token = localStorage.getItem(TOKEN_KEY);
	return token ? { Authorization: `Bearer ${token}` } : {};
}

async function api(path, options = {}) {
	const res = await fetch(path, {
		...options,
		headers: { "Content-Type": "application/json", ...authHeaders(), ...(options.headers || {}) },
	});
	if (res.status === 401) {
		const token = window.prompt("此服务器需要访问令牌（PI_CONSOLE_TOKEN），请输入：");
		if (token !== null) {
			localStorage.setItem(TOKEN_KEY, token);
			return api(path, options);
		}
		throw new Error("未授权");
	}
	const body = await res.json().catch(() => ({}));
	if (!res.ok) {
		const error = new Error(body.error || `请求失败（HTTP ${res.status}）`);
		error.status = res.status;
		throw error;
	}
	return body;
}

// ---------------------------------------------------------------------------
// 会话初始化与恢复
// ---------------------------------------------------------------------------

async function ensureSession() {
	if (sessionId) {
		try {
			const history = await api(`/api/sessions/${sessionId}/history`);
			renderHistory(history);
			if (history.model) syncModelSelect(history.model.provider, history.model.modelId);
			if (history.thinkingLevel) thinkingSelectEl.value = history.thinkingLevel;
			if (history.streaming) setRunning(true, true);
			return;
		} catch (error) {
			if (error.status !== 404) throw error;
			sessionId = null;
			localStorage.removeItem(SESSION_KEY);
		}
	}
	const result = await api("/api/sessions", { method: "POST", body: "{}" });
	sessionId = result.sessionId;
	localStorage.setItem(SESSION_KEY, sessionId);
	clearMessages();
	const history = await api(`/api/sessions/${sessionId}/history`).catch(() => null);
	if (history?.model) syncModelSelect(history.model.provider, history.model.modelId);
	if (history?.thinkingLevel) thinkingSelectEl.value = history.thinkingLevel;
}

/** 清空消息区（保留折叠控制条） */
function clearMessages() {
	messagesEl.querySelectorAll(".message").forEach((m) => m.remove());
}

function renderHistory(history) {
	clearMessages();
	lastSeq = typeof history.lastSeq === "number" ? history.lastSeq : -1;
	for (const item of history.messages) {
		if (item.role === "user") {
			appendMessage("user", item.text);
		} else if (item.role === "assistant") {
			const container = appendMessage("assistant", item.text || "");
			if (Array.isArray(item.toolCalls)) {
				for (const call of item.toolCalls) {
					appendToolBlock(container.el, call.id, call.name, call.args, "done");
				}
			}
			if (item.errorMessage) showError(item.errorMessage);
		} else if (item.role === "toolResult") {
			const block = document.querySelector(`[data-tool-call-id="${CSS.escape(item.toolCallId)}"]`);
			if (block) updateToolBlock(block, item.isError, item.text);
		}
	}
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

function connectSSE() {
	if (!sessionId) return;
	if (es) es.close();
	const token = localStorage.getItem(TOKEN_KEY);
	const tokenQuery = token ? `&token=${encodeURIComponent(token)}` : "";
	es = new EventSource(`/api/sessions/${sessionId}/stream?since=${lastSeq}${tokenQuery}`);

	es.onopen = () => {
		connStateEl.textContent = "已连接";
		connStateEl.classList.remove("disconnected");
	};
	es.onmessage = (msg) => {
		let event;
		try {
			event = JSON.parse(msg.data);
		} catch {
			return;
		}
		if (typeof event.seq === "number") {
			if (event.seq === -1 && event.type === "resync") {
				refreshFromHistory();
				return;
			}
			if (event.seq <= lastSeq) return;
			lastSeq = event.seq;
		}
		handleEvent(event);
	};
	es.onerror = () => {
		connStateEl.textContent = "重连中…";
		connStateEl.classList.add("disconnected");
		es.close();
		clearTimeout(reconnectTimer);
		reconnectTimer = setTimeout(connectSSE, 2000);
	};
}

async function refreshFromHistory() {
	try {
		const history = await api(`/api/sessions/${sessionId}/history`);
		renderHistory(history);
	} catch {
		/* 等下次重连 */
	}
}

// ---------------------------------------------------------------------------
// 事件处理
// ---------------------------------------------------------------------------

function handleEvent(event) {
	switch (event.type) {
		case "text_delta":
			setIndicator(false);
			ensureAssistant().appendText(event.delta);
			break;
		case "thinking_delta":
			setIndicator(true, "思考中…");
			ensureAssistant().appendThinking(event.delta);
			break;
		case "tool_execution_start":
			setIndicator(false);
			appendToolBlock(ensureAssistant().el, event.toolCallId, event.toolName, event.args, "running");
			break;
		case "tool_execution_end": {
			const block = document.querySelector(`[data-tool-call-id="${CSS.escape(event.toolCallId)}"]`);
			if (block) updateToolBlock(block, event.isError, event.result);
			break;
		}
		case "turn_end":
			if (event.stopReason === "error") showError(event.errorMessage || "模型返回错误");
			currentAssistant = null;
			setIndicator(false);
			break;
		case "agent_settled":
			setRunning(false);
			setIndicator(false);
			break;
		case "auto_retry_start":
			setIndicator(true, `请求失败，自动重试中（第 ${event.attempt}/${event.maxAttempts} 次）`);
			break;
		case "compaction_start":
			setIndicator(true, "上下文压缩中…");
			break;
		case "compaction_end":
			setIndicator(false);
			break;
		case "model_changed":
			syncModelSelect(event.provider, event.modelId);
			break;
		case "thinking_level_changed":
			thinkingSelectEl.value = event.level;
			break;
		case "error":
			showError(event.message || "发生错误");
			setIndicator(false);
			if (!event.fatal) setRunning(false);
			break;
	}
}

// ---------------------------------------------------------------------------
// Claude 风格消息渲染
// ---------------------------------------------------------------------------

function appendMessage(role, text) {
	const wrap = document.createElement("div");
	wrap.className = `message ${role}`;

	const bubble = document.createElement("div");
	bubble.className = "bubble";
	if (role === "assistant") {
		const meta = document.createElement("div");
		meta.className = "message-meta";
		const modelName = document.createElement("span");
		modelName.textContent = modelSelectEl.value || "助手";
		const copyBtn = document.createElement("button");
		copyBtn.className = "copy-btn";
		copyBtn.textContent = "⧉";
		copyBtn.title = "复制本条回复";
		copyBtn.dataset.copy = "msg";
		meta.appendChild(modelName);
		meta.appendChild(copyBtn);
		bubble.appendChild(meta);
	}

	// 思考过程区（assistant 专用，可折叠）
	const thinking = document.createElement("div");
	thinking.className = "thinking-block";
	thinking.hidden = true;
	if (role === "assistant") bubble.appendChild(thinking);

	// 正文
	const textEl = document.createElement("div");
	textEl.className = "text";
	if (text) renderMarkdownInto(textEl, text);
	bubble.appendChild(textEl);

	wrap.appendChild(bubble);
	messagesEl.appendChild(wrap);
	applyCollapse();
	scrollToBottom();

	return {
		el: bubble,
		thinkingEl: thinking,
		textEl,
		_appendThinking(delta) {
			if (!this._thinkingOpen) {
				this._thinkingOpen = true;
				thinking.hidden = false;
				thinking.innerHTML = "";
				const head = document.createElement("div");
				head.className = "thinking-head";
				head.textContent = "💭 思考过程";
				const toggle = document.createElement("span");
				toggle.className = "thinking-toggle";
				toggle.textContent = "展开";
				head.appendChild(toggle);
				const body = document.createElement("div");
				body.className = "thinking-body";
				body.hidden = true;
				thinking.appendChild(head);
				thinking.appendChild(body);
				head.addEventListener("click", () => {
					body.hidden = !body.hidden;
					toggle.textContent = body.hidden ? "展开" : "收起";
					if (!body.hidden) body.scrollTop = body.scrollHeight;
				});
				this._thinkingBody = body;
			}
			this._thinkingBody.textContent += delta;
			if (!this._thinkingBody.hidden) this._thinkingBody.scrollTop = this._thinkingBody.scrollHeight;
		},
		appendText(delta) {
			this._textBuffer = (this._textBuffer ?? "") + delta;
			clearTimeout(this._renderTimer);
			this._renderTimer = setTimeout(() => {
				// 流式渲染：避免每 token 全量重排
				if (this._textBuffer.length > 4000) {
					// 超长时把已渲染部分固化，只渲染增量
					this.textEl.dataset.frozen = "1";
				}
				renderMarkdownInto(this.textEl, this._textBuffer, { streaming: true });
				scrollToBottom();
			}, 60);
		},
		appendThinking(delta) {
			this._appendThinking(delta);
		},
	};
}

function ensureAssistant() {
	if (!currentAssistant) {
		currentAssistant = appendMessage("assistant", "");
	}
	return currentAssistant;
}

// ---------------------------------------------------------------------------
// Markdown 渲染（手写轻量解析器，流式容错）
// ---------------------------------------------------------------------------

function escapeHtml(text) {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderInline(text) {
	// 行内：`code`、**bold**、*italic*、[text](url)
	let html = escapeHtml(text);
	html = html.replace(/`([^`]+)`/g, (m, code) => `<code>${code}</code>`);
	html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
	html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
	return html;
}

/** 简单代码高亮：tokenizer 扫描字符串/注释/关键字/数字，避免嵌套 span */
function highlightCode(code, lang) {
	const keywords = {
		js: /\b(const|let|var|function|return|if|else|for|while|class|new|import|export|from|async|await|try|catch|throw|typeof|instanceof|this|undefined|null|true|false|of|in|do|switch|case|break|continue)\b/g,
		ts: /\b(const|let|var|function|return|if|else|for|while|class|new|import|export|from|async|await|try|catch|throw|type|interface|enum|implements|extends|typeof|instanceof|this|undefined|null|true|false|of|in|readonly|declare|namespace|as)\b/g,
		python: /\b(def|return|if|elif|else|for|while|import|from|class|try|except|finally|with|as|lambda|pass|None|True|False|and|or|not|in|is|yield|global|raise|async|await)\b/g,
		json: /\b(true|false|null)\b/g,
		shell: /\b(echo|cd|ls|mkdir|rm|cp|mv|cat|grep|sed|awk|npm|npx|git|set|export|if|then|else|fi|for|do|done|curl|wget|node|python|bash|sh|exit|pwd|touch|chmod)\b/g,
		html: /\b(div|span|class|id|style|href|src|script|html|body|head|title|meta|link|table|tr|td|th|ul|li|p|h1|h2|h3|button|input|textarea|select|option|main|header|footer|aside|section)\b/g,
		css: /\b(display|flex|grid|margin|padding|color|background|border|width|height|font|position|absolute|relative|fixed|overflow|z-index|align|justify|gap|max|min|content|box-sizing|cursor|transition|opacity)\b/g,
	};
	const kw = keywords[lang] ?? keywords.js;
	const tokenRe = /("[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|\/\/[^\n]*|#[^\n]*|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/g;
	let html = "";
	let last = 0;
	for (const match of code.matchAll(tokenRe)) {
		html += escapeHtml(code.slice(last, match.index));
		const token = match[0];
		let cls = "";
		if (token.startsWith('"') || token.startsWith("'")) cls = "tok-string";
		else if (token.startsWith("//") || token.startsWith("#")) cls = "tok-comment";
		else if (/^\d/.test(token)) cls = "tok-number";
		else if (new RegExp(`^${kw.source}$`).test(token)) cls = "tok-keyword";
		html += cls ? `<span class="${cls}">${escapeHtml(token)}</span>` : escapeHtml(token);
		last = match.index + token.length;
	}
	html += escapeHtml(code.slice(last));
	return html;
}

function renderMarkdownInto(el, text, options = {}) {
	// 容错：未闭合的代码块按纯文本处理
	const lines = text.split("\n");
	let html = "";
	let inCode = false;
	let codeLang = "";
	let codeBuf = [];
	let inList = false;
	let inTable = false;

	const closeList = () => {
		if (inList) {
			html += "</ul>";
			inList = false;
		}
	};
	const closeTable = () => {
		if (inTable) {
			html += "</table>";
			inTable = false;
		}
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const codeMatch = line.match(/^```(\w*)\s*$/);
		if (codeMatch) {
			if (!inCode) {
				closeList();
				closeTable();
				inCode = true;
				codeLang = codeMatch[1];
				codeBuf = [];
			} else {
				html += `<pre><code class="lang-${codeLang || "text"}">${highlightCode(codeBuf.join("\n"), codeLang)}</code></pre>`;
				inCode = false;
			}
			continue;
		}
		if (inCode) {
			codeBuf.push(line);
			continue;
		}
		if (/^\s*$/.test(line)) {
			closeList();
			closeTable();
			continue;
		}
		if (line.startsWith("#")) {
			closeList();
			closeTable();
			const level = Math.min(3, line.match(/^#+/)[0].length);
			html += `<h${level}>${renderInline(line.replace(/^#+\s*/, ""))}</h${level}>`;
			continue;
		}
		if (/^[-*] /.test(line)) {
			closeTable();
			if (!inList) {
				html += "<ul>";
				inList = true;
			}
			html += `<li>${renderInline(line.replace(/^[-*] /, ""))}</li>`;
			continue;
		}
		if (/^\d+\. /.test(line)) {
			closeTable();
			if (!inList) {
				html += "<ul>";
				inList = true;
			}
			html += `<li>${renderInline(line.replace(/^\d+\. /, ""))}</li>`;
			continue;
		}
		if (line.startsWith(">")) {
			closeList();
			closeTable();
			html += `<blockquote>${renderInline(line.replace(/^>\s?/, ""))}</blockquote>`;
			continue;
		}
		if (line.startsWith("|") && /^\|[\s\S]*\|$/.test(line) && lines[i + 1]?.includes("---")) {
			closeList();
			if (!inTable) {
				html += "<table><thead><tr>";
				inTable = true;
			}
			const cells = line.split("|").slice(1, -1);
			html += cells.map((c) => `<th>${renderInline(c.trim())}</th>`).join("");
			html += "</tr></thead>";
			i++; // 跳过分隔行
			html += "<tbody>";
			continue;
		}
		if (inTable && line.startsWith("|")) {
			const cells = line.split("|").slice(1, -1);
			html += `<tr>${cells.map((c) => `<td>${renderInline(c.trim())}</td>`).join("")}</tr>`;
			continue;
		}
		if (line === "---" || line === "***") {
			closeList();
			closeTable();
			html += "<hr>";
			continue;
		}
		closeList();
		closeTable();
		html += `<p>${renderInline(line)}</p>`;
	}
	if (inCode) {
		// 流式过程中代码块未闭合：按代码样式输出已收集内容
		html += `<pre><code class="lang-${codeLang || "text"}">${highlightCode(codeBuf.join("\n"), codeLang)}</code></pre>`;
	}
	closeList();
	closeTable();
	el.innerHTML = html;
	// 给每个代码块加复制按钮（流式重渲染时统一重建）
	for (const pre of el.querySelectorAll("pre")) {
		const btn = document.createElement("button");
		btn.className = "copy-btn";
		btn.textContent = "⧉";
		btn.title = "复制代码";
		btn.dataset.copy = "code";
		pre.appendChild(btn);
	}
}

// ---------------------------------------------------------------------------
// 工具调用块（可折叠）
// ---------------------------------------------------------------------------

function appendToolBlock(bubble, toolCallId, toolName, args, status) {
	const block = document.createElement("div");
	block.className = "tool-block running";
	block.dataset.toolCallId = toolCallId;

	const header = document.createElement("div");
	header.className = "tool-header";
	const chevron = document.createElement("span");
	chevron.className = "tool-chevron";
	chevron.textContent = "▾";
	const nameEl = document.createElement("span");
	nameEl.className = "tool-name";
	nameEl.textContent = `⚙ ${toolName}`;
	const statusEl = document.createElement("span");
	statusEl.className = "tool-status";
	statusEl.textContent = status === "running" ? "运行中…" : "已结束";
	header.appendChild(chevron);
	header.appendChild(nameEl);
	header.appendChild(statusEl);
	block.appendChild(header);

	const body = document.createElement("div");
	body.className = "tool-body";

	const argsEl = document.createElement("div");
	argsEl.className = "tool-args";
	argsEl.textContent = summarizeArgs(args);
	body.appendChild(argsEl);

	const resultEl = document.createElement("div");
	resultEl.className = "tool-result";
	resultEl.hidden = true;
	body.appendChild(resultEl);

	block.appendChild(body);
	header.addEventListener("click", () => {
		body.hidden = !body.hidden;
		chevron.textContent = body.hidden ? "▸" : "▾";
	});

	bubble.appendChild(block);
	scrollToBottom();
	return block;
}

function updateToolBlock(block, isError, resultText) {
	block.classList.remove("running");
	block.classList.add(isError ? "error" : "done");
	const statusEl = block.querySelector(".tool-status");
	if (statusEl) statusEl.textContent = isError ? "失败" : "成功";
	const resultEl = block.querySelector(".tool-result");
	if (resultEl && resultText) {
		resultEl.textContent = resultText;
		resultEl.hidden = false;
	}
}

function summarizeArgs(args) {
	if (args === undefined || args === null) return "";
	try {
		let text = typeof args === "string" ? args : JSON.stringify(args);
		if (text.length > 200) text = `${text.slice(0, 200)}…`;
		return text;
	} catch {
		return String(args);
	}
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

function setRunning(value, restoreOnly = false) {
	running = value;
	sendBtn.hidden = value;
	stopBtn.hidden = !value;
	if (!value) {
		currentAssistant = null;
		setIndicator(false);
		if (!restoreOnly) inputEl.focus();
	}
}

function setIndicator(visible, text) {
	indicatorEl.hidden = !visible;
	if (text) indicatorEl.textContent = text;
}

function showError(message) {
	errorBarEl.textContent = message;
	errorBarEl.classList.remove("info-bar");
	errorBarEl.classList.add("error-bar");
	errorBarEl.hidden = false;
	clearTimeout(showError._t);
	showError._t = setTimeout(() => {
		errorBarEl.hidden = true;
	}, 15000);
}

let infoTimer = null;
function showInfo(message) {
	errorBarEl.textContent = message;
	errorBarEl.classList.remove("error-bar");
	errorBarEl.classList.add("info-bar");
	errorBarEl.hidden = false;
	clearTimeout(infoTimer);
	infoTimer = setTimeout(() => {
		errorBarEl.hidden = true;
		errorBarEl.classList.remove("info-bar");
		errorBarEl.classList.add("error-bar");
	}, 6000);
}

function scrollToBottom() {
	const should = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 160;
	if (should) messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---------------------------------------------------------------------------
// 折叠历史消息（sticky 控制条，不随滚动消失）
// ---------------------------------------------------------------------------

const collapseBtnEl = $("collapse-btn");
const collapseHintEl = $("collapse-hint");
const messagesToolbarEl = $("messages-toolbar");
let collapsed = false;

/** 折叠状态应用到消息列表：隐藏除最后 2 条外的消息 */
function applyCollapse() {
	const msgs = messagesEl.querySelectorAll(".message");
	const keep = Math.max(0, msgs.length - 2);
	messagesToolbarEl.hidden = msgs.length <= 2;
	for (let i = 0; i < keep; i++) {
		msgs[i].classList.toggle("collapsed-hidden", collapsed);
	}
	collapseHintEl.textContent = collapsed && keep > 0 ? `已折叠 ${keep} 条较早的消息` : "";
	collapseBtnEl.textContent = collapsed ? "▾ 展开历史消息" : "▴ 折叠历史消息";
}

collapseBtnEl.addEventListener("click", () => {
	collapsed = !collapsed;
	applyCollapse();
	// 折叠后回到顶部，展开后回到底部
	messagesEl.scrollTop = collapsed ? 0 : messagesEl.scrollHeight;
});

// ---------------------------------------------------------------------------
// 复制（消息 / 代码块）
// ---------------------------------------------------------------------------

messagesEl.addEventListener("click", (e) => {
	const btn = e.target.closest("[data-copy]");
	if (!btn) return;
	let text = "";
	if (btn.dataset.copy === "msg") {
		const bubble = btn.closest(".bubble");
		const textEl = bubble?.querySelector(".text");
		text = textEl ? textEl.innerText : "";
	} else if (btn.dataset.copy === "code") {
		const codeEl = btn.closest("pre")?.querySelector("code");
		text = codeEl ? codeEl.innerText : "";
	}
	if (!text) return;
	navigator.clipboard
		.writeText(text)
		.then(() => showInfo(`已复制（${text.length} 字符）`))
		.catch(() => showError("复制失败"));
});

// ---------------------------------------------------------------------------
// 附件（＋按钮 / 拖拽 / 粘贴）
// ---------------------------------------------------------------------------

const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function formatSize(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fileToBase64(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
		reader.onerror = reject;
		reader.readAsDataURL(file);
	});
}

function addAttachment(file) {
	fileToBase64(file).then((dataBase64) => {
		pendingAttachments.push({
			name: file.name,
			mimeType: file.type || "application/octet-stream",
			dataBase64,
			size: file.size,
			isImage: IMAGE_MIME.has(file.type),
		});
		renderAttachments();
	});
}

function renderAttachments() {
	attachmentsEl.innerHTML = "";
	attachmentsEl.hidden = pendingAttachments.length === 0;
	for (const [index, attachment] of pendingAttachments.entries()) {
		const chip = document.createElement("span");
		chip.className = "attachment-chip";
		chip.textContent = `${attachment.isImage ? "🖼" : "📄"} ${attachment.name} (${formatSize(attachment.size)})`;
		const remove = document.createElement("button");
		remove.className = "chip-remove";
		remove.textContent = "×";
		remove.title = "移除附件";
		remove.addEventListener("click", () => {
			pendingAttachments.splice(index, 1);
			renderAttachments();
		});
		chip.appendChild(remove);
		attachmentsEl.appendChild(chip);
	}
}

attachBtnEl.addEventListener("click", () => fileInputEl.click());
fileInputEl.addEventListener("change", () => {
	for (const file of fileInputEl.files ?? []) addAttachment(file);
	fileInputEl.value = "";
});

let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
	if (!e.dataTransfer?.types.includes("Files")) return;
	e.preventDefault();
	dragDepth++;
	dropOverlayEl.hidden = false;
});
window.addEventListener("dragover", (e) => {
	if (!e.dataTransfer?.types.includes("Files")) return;
	e.preventDefault();
});
window.addEventListener("dragleave", (e) => {
	e.preventDefault();
	dragDepth = Math.max(0, dragDepth - 1);
	if (dragDepth === 0) dropOverlayEl.hidden = true;
});
window.addEventListener("drop", (e) => {
	e.preventDefault();
	dragDepth = 0;
	dropOverlayEl.hidden = true;
	for (const file of e.dataTransfer?.files ?? []) addAttachment(file);
});
window.addEventListener("paste", (e) => {
	const files = e.clipboardData?.files;
	if (!files || files.length === 0) return;
	e.preventDefault();
	for (const file of files) addAttachment(file);
});

async function sendMessage() {
	const text = inputEl.value.trim();
	if (!text || running || !sessionId) return;
	inputEl.value = "";
	errorBarEl.hidden = true;
	appendMessage("user", text);
	setRunning(true);
	setIndicator(true, "思考中…");

	try {
		const images = [];
		for (const attachment of pendingAttachments) {
			if (attachment.isImage) images.push({ data: attachment.dataBase64, mimeType: attachment.mimeType });
		}
		let attachmentLine = "";
		if (pendingAttachments.length > 0) {
			const saved = await api(`/api/sessions/${sessionId}/files`, {
				method: "POST",
				body: JSON.stringify({
					files: pendingAttachments.map(({ name, mimeType, dataBase64 }) => ({ name, mimeType, dataBase64 })),
				}),
			});
			pendingAttachments = [];
			renderAttachments();
			attachmentLine = `\n[附件: ${saved.files.join(", ")}]`;
		}
		await api(`/api/sessions/${sessionId}/messages`, {
			method: "POST",
			body: JSON.stringify({ text: text + attachmentLine, images }),
		});
	} catch (error) {
		showError(error.message);
		setRunning(false);
	}
}

async function abortRun() {
	if (!sessionId) return;
	try {
		await api(`/api/sessions/${sessionId}/abort`, { method: "POST", body: "{}" });
	} catch (error) {
		showError(error.message);
	}
}

sendBtn.addEventListener("click", sendMessage);
stopBtn.addEventListener("click", abortRun);
inputEl.addEventListener("keydown", (e) => {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		sendMessage();
	}
});

// ---------------------------------------------------------------------------
// 模型 / 思考等级（输入区右下角）
// ---------------------------------------------------------------------------

function syncModelSelect(provider, modelId) {
	const value = `${provider}/${modelId}`;
	if ([...modelSelectEl.options].some((o) => o.value === value)) modelSelectEl.value = value;
}

async function loadModels() {
	try {
		const models = await api("/api/models");
		modelSelectEl.innerHTML = "";
		const authed = models.filter((m) => m.hasAuth);
		const others = models.filter((m) => !m.hasAuth);
		const byProvider = new Map();
		for (const m of others) {
			const list = byProvider.get(m.provider) ?? [];
			list.push(m);
			byProvider.set(m.provider, list);
		}
		if (authed.length > 0) {
			const group = document.createElement("optgroup");
			group.label = "已配置 Key";
			for (const m of authed) {
				const option = document.createElement("option");
				option.value = `${m.provider}/${m.modelId}`;
				option.textContent = m.label;
				group.appendChild(option);
			}
			modelSelectEl.appendChild(group);
		}
		if (byProvider.size > 0) {
			const group = document.createElement("optgroup");
			group.label = "未配置 Key";
			for (const [provider, list] of byProvider) {
				const option = document.createElement("option");
				option.value = `${provider}/__none__`;
				option.disabled = true;
				option.textContent = `${provider}（${list.length} 个模型，未配置 Key）`;
				group.appendChild(option);
			}
			modelSelectEl.appendChild(group);
		}
		modelSelectEl.disabled = models.length === 0;
		const history = await api(`/api/sessions/${sessionId}/history`).catch(() => null);
		if (history?.model) syncModelSelect(history.model.provider, history.model.modelId);
	} catch (error) {
		showError(`加载模型列表失败：${error.message}`);
	}
}

modelSelectEl.addEventListener("change", async () => {
	const value = modelSelectEl.value;
	if (!value || !sessionId) return;
	const [provider, ...rest] = value.split("/");
	const modelId = rest.join("/");
	try {
		await api(`/api/sessions/${sessionId}/model`, {
			method: "POST",
			body: JSON.stringify({ provider, modelId }),
		});
	} catch (error) {
		showError(`切换模型失败：${error.message}`);
		const history = await api(`/api/sessions/${sessionId}/history`).catch(() => null);
		if (history?.model) syncModelSelect(history.model.provider, history.model.modelId);
	}
});

thinkingSelectEl.addEventListener("change", async () => {
	if (!sessionId) return;
	try {
		const result = await api(`/api/sessions/${sessionId}/thinking`, {
			method: "POST",
			body: JSON.stringify({ level: thinkingSelectEl.value }),
		});
		thinkingSelectEl.value = result.level;
	} catch (error) {
		showError(`切换思考等级失败：${error.message}`);
	}
});

// ---------------------------------------------------------------------------
// 左栏：助手（能力包）与技能
// ---------------------------------------------------------------------------

/** 折叠面板切换 */
document.querySelectorAll(".side-header").forEach((header) => {
	header.addEventListener("click", () => {
		const panel = $(header.dataset.panel);
		if (!panel) return;
		const collapsed = panel.classList.toggle("collapsed");
		header.querySelector(".chevron").textContent = collapsed ? "▸" : "▾";
	});
});

/** 能力包数据缓存：侧栏精简列表、添加弹窗、详情抽屉共用一份 */
let packsCache = [];

/** 当前抽屉里展示的助手名（null = 抽屉关闭） */
let drawerPackName = null;

async function refreshPacks() {
	packsCache = await api("/api/packs");
}

/** 挂载 / 停用，并刷新相关 UI */
async function togglePack(pack) {
	const action = pack.mounted ? "unmount" : "mount";
	try {
		await api(`/api/packs/${pack.name}/${action}`, { method: "POST", body: "{}" });
		showInfo(action === "mount" ? `已启用 ${pack.displayName}，下一轮生效` : `已停用 ${pack.displayName}`);
		await loadAssistants();
		await loadContextPanel();
		// 抽屉正展示这个助手：停用后顺手关上，启用后刷新详情
		if (drawerPackName === pack.name) {
			if (action === "unmount") closeDrawer();
			else openDrawer(pack.name);
		}
	} catch (error) {
		showError(`操作失败：${error.message}`);
	}
}

/** 左栏：只列"已启用"的助手（精简行），其余收进"添加助手"弹窗 */
async function loadAssistants() {
	try {
		await refreshPacks();
		assistantsListEl.innerHTML = "";
		const mounted = packsCache.filter((p) => p.mounted);
		if (mounted.length === 0) {
			const empty = document.createElement("div");
			empty.className = "skills-empty";
			empty.textContent = "还没有启用的助手";
			assistantsListEl.appendChild(empty);
			return;
		}
		for (const pack of mounted) {
			const row = document.createElement("div");
			row.className = "assistant-row";
			row.dataset.packName = pack.name;

			const dot = document.createElement("span");
			dot.className = "assistant-dot";
			const name = document.createElement("span");
			name.className = "assistant-row-name";
			name.textContent = pack.displayName;
			const go = document.createElement("span");
			go.className = "assistant-row-go";
			go.textContent = "›";

			row.appendChild(dot);
			row.appendChild(name);
			row.appendChild(go);
			row.addEventListener("click", () => openDrawer(pack.name));
			assistantsListEl.appendChild(row);
		}
	} catch (error) {
		assistantsListEl.textContent = `加载失败：${error.message}`;
	}
}

/** "添加助手"弹窗：列出全部可用助手 */
function openAssistantsModal() {
	assistantsModalListEl.innerHTML = "";
	if (packsCache.length === 0) {
		assistantsModalListEl.innerHTML = '<div class="skills-empty">暂无可用助手</div>';
	} else {
		for (const pack of packsCache) {
			const item = document.createElement("div");
			item.className = "pack-option";

			const main = document.createElement("div");
			main.className = "pack-option-main";
			const title = document.createElement("div");
			title.className = "pack-option-title";
			title.textContent = `${pack.displayName} v${pack.version}`;
			const desc = document.createElement("div");
			desc.className = "pack-option-desc";
			desc.textContent = pack.description;
			main.appendChild(title);
			main.appendChild(desc);

			const actions = document.createElement("div");
			actions.className = "pack-option-actions";
			const useBtn = document.createElement("button");
			useBtn.className = pack.mounted ? "secondary-btn small" : "primary-btn small";
			useBtn.textContent = pack.mounted ? "停用" : "启用";
			useBtn.addEventListener("click", async () => {
				await togglePack(pack);
				openAssistantsModal(); // 重新渲染弹窗列表
			});
			actions.appendChild(useBtn);
			if (pack.mounted) {
				const detailBtn = document.createElement("button");
				detailBtn.className = "secondary-btn small";
				detailBtn.textContent = "能力详情";
				detailBtn.addEventListener("click", () => {
					closeAssistantsModal();
					openDrawer(pack.name);
				});
				actions.appendChild(detailBtn);
			}

			item.appendChild(main);
			item.appendChild(actions);
			assistantsModalListEl.appendChild(item);
		}
	}
	assistantsModalEl.hidden = false;
}

function closeAssistantsModal() {
	assistantsModalEl.hidden = true;
}

/** 右侧抽屉：某个助手的能力详情（工具列表 + 停用），不点开不显示 */
function openDrawer(packName) {
	const pack = packsCache.find((p) => p.name === packName);
	if (!pack) return;
	drawerPackName = packName;
	drawerTitleEl.textContent = pack.displayName;
	drawerContentEl.innerHTML = "";

	const meta = document.createElement("div");
	meta.className = "drawer-meta";
	meta.textContent = `v${pack.version} · ${pack.mounted ? "已启用" : "未启用"}`;

	const desc = document.createElement("div");
	desc.className = "drawer-desc";
	desc.textContent = pack.description;

	const toolsTitle = document.createElement("div");
	toolsTitle.className = "drawer-block-title";
	toolsTitle.textContent = `工具（${pack.tools.length}）`;
	const toolsWrap = document.createElement("div");
	toolsWrap.className = "context-tools";
	for (const tool of pack.tools) {
		const chip = document.createElement("span");
		chip.className = "tool-chip";
		chip.textContent = tool;
		toolsWrap.appendChild(chip);
	}

	const actions = document.createElement("div");
	actions.className = "drawer-actions";
	const useBtn = document.createElement("button");
	useBtn.className = pack.mounted ? "secondary-btn" : "primary-btn";
	useBtn.textContent = pack.mounted ? "停用助手" : "启用助手";
	useBtn.addEventListener("click", () => togglePack(pack));
	actions.appendChild(useBtn);

	drawerContentEl.appendChild(meta);
	drawerContentEl.appendChild(desc);
	drawerContentEl.appendChild(toolsTitle);
	drawerContentEl.appendChild(toolsWrap);
	drawerContentEl.appendChild(actions);
	drawerEl.hidden = false;
}

function closeDrawer() {
	drawerPackName = null;
	drawerEl.hidden = true;
}

assistantAddBtnEl.addEventListener("click", openAssistantsModal);
assistantsModalCloseEl.addEventListener("click", closeAssistantsModal);
assistantsModalEl.addEventListener("click", (e) => {
	if (e.target === assistantsModalEl) closeAssistantsModal();
});
drawerCloseEl.addEventListener("click", closeDrawer);

// ---------------------------------------------------------------------------
// 输入区底行：已启用能力摘要
// ---------------------------------------------------------------------------

async function loadContextPanel() {
	try {
		await refreshPacks();
		const mounted = packsCache.filter((p) => p.mounted);
		contextInfoEl.textContent = mounted.length > 0 ? `${mounted.length} 个助手已启用` : "";
	} catch {
		/* 忽略 */
	}
}

// ---------------------------------------------------------------------------
// 左栏：本地资源管理器
// ---------------------------------------------------------------------------

let fsRoots = [];
let currentFsPath = null; // 文件管理器当前浏览的目录

async function loadFsRoots() {
	try {
		fsRoots = await api("/api/fs/roots");
		fsRootSelectEl.innerHTML = "";
		for (const root of fsRoots) {
			const option = document.createElement("option");
			option.value = root.path;
			option.textContent = root.path;
			fsRootSelectEl.appendChild(option);
		}
		if (fsRoots.length > 0) await loadFsDir(fsRoots[0].path);
		await loadWorkspaceState();
	} catch (error) {
		fsTreeEl.textContent = `加载失败：${error.message}`;
	}
}

/** 工作区状态（文件面板行 + 设置弹窗） */
async function loadWorkspaceState() {
	try {
		const info = await api("/api/workspace");
		const path = info.path;
		if (path) {
			fsWorkspacePathEl.textContent = path;
			fsWorkspacePathEl.title = path;
			workspaceCurrentEl.textContent = `当前：${path}`;
			workspaceInputEl.placeholder = path;
		} else {
			fsWorkspacePathEl.textContent = "（未设置）";
			workspaceCurrentEl.textContent = "当前：未设置（默认工作区）";
			workspaceInputEl.placeholder = "例如 D:\\projects\\myapp（留空并保存 = 清除工作区）";
		}
	} catch {
		/* 忽略 */
	}
}

/** 把当前浏览目录设为工作区 */
/** 工作区切换后：重建会话（旧会话 cwd 固化无法迁移），提示迁移结果 */
async function afterWorkspaceChanged(result) {
	await loadWorkspaceState();
	await loadFsRoots();
	const migratedNote = result.migrated > 0 ? `，已从旧工作区迁移 ${result.migrated} 个文件` : "";
	if (result.sessionReset) {
		localStorage.removeItem(SESSION_KEY);
		sessionId = null;
		clearMessages();
		lastSeq = -1;
		await ensureSession();
		connectSSE();
		showInfo(`工作区已切换${migratedNote}，会话已重建，现在在新工作区工作`);
	} else {
		showInfo(`工作区已设为 ${result.path}${migratedNote}`);
	}
}

fsSetWorkspaceBtnEl.addEventListener("click", async () => {
	if (!currentFsPath) {
		showError("请先在文件面板浏览到一个目录");
		return;
	}
	try {
		const result = await api("/api/workspace", { method: "POST", body: JSON.stringify({ path: currentFsPath }) });
		await afterWorkspaceChanged(result);
	} catch (error) {
		showError(`设置工作区失败：${error.message}`);
	}
});

/** 设置弹窗：保存工作区 */
workspaceSaveBtnEl.addEventListener("click", async () => {
	workspaceSaveBtnEl.disabled = true;
	try {
		const result = await api("/api/workspace", {
			method: "POST",
			body: JSON.stringify({ path: workspaceInputEl.value.trim() }),
		});
		workspaceInputEl.value = "";
		await afterWorkspaceChanged(result);
	} catch (error) {
		showError(`保存工作区失败：${error.message}`);
	} finally {
		workspaceSaveBtnEl.disabled = false;
	}
});

async function loadFsDir(path) {
	currentFsPath = path;
	try {
		const result = await api(`/api/fs/list?path=${encodeURIComponent(path)}`);
		fsTreeEl.innerHTML = "";
		if (result.entries.length === 0) {
			fsTreeEl.textContent = "（空目录）";
			return;
		}
		for (const entry of result.entries) {
			const row = document.createElement("div");
			row.className = "fs-row";
			row.dataset.path = path.replace(/[\\/]+$/, "") + "/" + entry.name;
			row.dataset.type = entry.type;
			row.dataset.name = entry.name;
			row.dataset.mime = "";
			const icon = document.createElement("span");
			icon.className = "fs-icon";
			icon.textContent = entry.type === "dir" ? "📁" : "📄";
			const name = document.createElement("span");
			name.className = "fs-name";
			name.textContent = entry.name;
			row.appendChild(icon);
			row.appendChild(name);
			if (entry.type === "file" && entry.size !== null) {
				const size = document.createElement("span");
				size.className = "fs-size";
				size.textContent = formatSize(entry.size);
				row.appendChild(size);
			}
			if (entry.type === "dir") {
				row.addEventListener("click", () => toggleFsDir(row));
			} else {
				row.addEventListener("click", () => previewFsFile(row));
			}
			fsTreeEl.appendChild(row);
		}
	} catch (error) {
		fsTreeEl.textContent = `加载失败：${error.message}`;
	}
}

async function toggleFsDir(row) {
	const childWrap = row.nextElementSibling;
	if (childWrap && childWrap.classList.contains("fs-children")) {
		childWrap.remove();
		return;
	}
	// 展开：在该行后插入子容器
	const children = document.createElement("div");
	children.className = "fs-children";
	row.after(children);
	try {
		const result = await api(`/api/fs/list?path=${encodeURIComponent(row.dataset.path)}`);
		children.innerHTML = "";
		for (const entry of result.entries) {
			const child = document.createElement("div");
			child.className = "fs-row fs-row-child";
			child.dataset.path = row.dataset.path + "/" + entry.name;
			child.dataset.type = entry.type;
			child.dataset.name = entry.name;
			const icon = document.createElement("span");
			icon.className = "fs-icon";
			icon.textContent = entry.type === "dir" ? "📁" : "📄";
			const name = document.createElement("span");
			name.className = "fs-name";
			name.textContent = entry.name;
			child.appendChild(icon);
			child.appendChild(name);
			if (entry.type === "file" && entry.size !== null) {
				const size = document.createElement("span");
				size.className = "fs-size";
				size.textContent = formatSize(entry.size);
				child.appendChild(size);
			}
			if (entry.type === "dir") child.addEventListener("click", () => toggleFsDir(child));
			else child.addEventListener("click", () => previewFsFile(child));
			children.appendChild(child);
		}
	} catch (error) {
		children.textContent = `加载失败：${error.message}`;
	}
}

fsRootSelectEl.addEventListener("change", () => {
	if (fsRootSelectEl.value) loadFsDir(fsRootSelectEl.value);
});
fsRefreshBtnEl.addEventListener("click", () => {
	if (fsRootSelectEl.value) loadFsDir(fsRootSelectEl.value);
});

async function previewFsFile(row) {
	try {
		const file = await api(`/api/fs/read?path=${encodeURIComponent(row.dataset.path)}`);
		previewFile = {
			name: row.dataset.name,
			mimeType: file.mimeType,
			dataBase64: file.dataBase64,
			size: file.size,
			isImage: IMAGE_MIME.has(file.mimeType),
		};
		previewTitleEl.textContent = previewFile.name;
		previewContentEl.innerHTML = "";
		if (previewFile.isImage) {
			const img = document.createElement("img");
			img.src = `data:${previewFile.mimeType};base64,${previewFile.dataBase64}`;
			img.className = "preview-image";
			previewContentEl.appendChild(img);
		} else if (file.mimeType.startsWith("text/") || file.mimeType.includes("json") || file.mimeType.includes("javascript")) {
			const pre = document.createElement("pre");
			pre.className = "preview-text";
			pre.textContent = decodeBase64(previewFile.dataBase64);
			previewContentEl.appendChild(pre);
		} else if (file.mimeType.includes("officedocument") || file.mimeType === "application/pdf") {
			previewContentEl.innerHTML =
				'<div class="context-empty">该文件类型暂不支持内联预览。<br>可"添加到对话"后交给 Office 助手处理。</div>';
		} else {
			const pre = document.createElement("pre");
			pre.className = "preview-text";
			pre.textContent = decodeBase64(previewFile.dataBase64);
			previewContentEl.appendChild(pre);
		}
		previewModalEl.hidden = false;
	} catch (error) {
		showError(`读取文件失败：${error.message}`);
	}
}

function decodeBase64(base64) {
	try {
		const binary = atob(base64);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return new TextDecoder("utf-8").decode(bytes);
	} catch {
		return "（二进制内容无法预览）";
	}
}

previewCloseEl.addEventListener("click", () => {
	previewModalEl.hidden = true;
	previewFile = null;
});
previewModalEl.addEventListener("click", (e) => {
	if (e.target === previewModalEl) {
		previewModalEl.hidden = true;
		previewFile = null;
	}
});
previewAttachBtnEl.addEventListener("click", () => {
	if (!previewFile) return;
	pendingAttachments.push({ ...previewFile });
	renderAttachments();
	previewModalEl.hidden = true;
	previewFile = null;
	showInfo("已添加到对话附件");
});

// ---------------------------------------------------------------------------
// 设置弹窗
// ---------------------------------------------------------------------------

settingsBtnEl.addEventListener("click", () => {
	settingsModalEl.hidden = false;
	loadKeysSection();
	loadVersionSection();
});
settingsCloseEl.addEventListener("click", () => {
	settingsModalEl.hidden = true;
});
settingsModalEl.addEventListener("click", (e) => {
	if (e.target === settingsModalEl) settingsModalEl.hidden = true;
});

async function loadKeysSection() {
	try {
		const [keys, models] = await Promise.all([api("/api/keys"), api("/api/models")]);
		const providers = new Map(models.map((m) => [m.provider, m.label.split(" · ")[0]]));
		keyProviderEl.innerHTML = "";
		const existing = new Set(keys.map((k) => k.provider));
		const sorted = [...providers.keys()].sort((a, b) => {
			const ea = existing.has(a) ? 0 : 1;
			const eb = existing.has(b) ? 0 : 1;
			return ea - eb || a.localeCompare(b);
		});
		for (const p of sorted) {
			const option = document.createElement("option");
			option.value = p;
			option.textContent = existing.has(p) ? `${providers.get(p)}（已配置）` : providers.get(p);
			keyProviderEl.appendChild(option);
		}
		renderKeyList(keys);
	} catch (error) {
		keyListEl.textContent = `加载失败：${error.message}`;
	}
}

function renderKeyList(keys) {
	keyListEl.innerHTML = "";
	if (keys.length === 0) {
		keyListEl.innerHTML = '<div class="key-empty">尚未配置任何模型服务</div>';
		return;
	}
	for (const entry of keys) {
		const row = document.createElement("div");
		row.className = "key-row";
		const name = document.createElement("span");
		name.className = "key-name";
		name.textContent = entry.displayName;
		const masked = document.createElement("span");
		masked.className = "key-masked";
		masked.textContent = entry.masked;
		row.appendChild(name);
		row.appendChild(masked);
		if (entry.source === "file") {
			const del = document.createElement("button");
			del.className = "key-delete";
			del.textContent = "删除";
			del.addEventListener("click", async () => {
				try {
					await api(`/api/keys/${encodeURIComponent(entry.provider)}`, { method: "DELETE" });
					showInfo(`已删除 ${entry.displayName} 的 Key`);
					await loadKeysSection();
					await loadModels();
				} catch (error) {
					showError(`删除失败：${error.message}`);
				}
			});
			row.appendChild(del);
		} else {
			const envTag = document.createElement("span");
			envTag.className = "key-env-tag";
			envTag.textContent = "环境变量";
			row.appendChild(envTag);
		}
		keyListEl.appendChild(row);
	}
}

keyAddBtnEl.addEventListener("click", async () => {
	const provider = keyProviderEl.value;
	const key = keyInputEl.value.trim();
	if (!provider || !key) {
		showError("请选择服务商并填写 API Key");
		return;
	}
	keyAddBtnEl.disabled = true;
	try {
		await api("/api/keys", { method: "POST", body: JSON.stringify({ provider, key }) });
		keyInputEl.value = "";
		showInfo(`已添加 ${provider}，模型列表已刷新`);
		await loadKeysSection();
		await loadModels();
	} catch (error) {
		showError(`添加失败：${error.message}`);
	} finally {
		keyAddBtnEl.disabled = false;
	}
});

async function loadVersionSection() {
	try {
		const info = await api("/api/app/version");
		appVersionEl.textContent = `版本 v${info.version}`;
	} catch {
		appVersionEl.textContent = "版本未知";
	}
	try {
		const tokenInfo = await api("/api/app/github-token");
		githubTokenClearBtnEl.hidden = !tokenInfo.configured;
		if (tokenInfo.configured) githubTokenInputEl.placeholder = "已保存 GitHub Token（输入可替换）";
	} catch {
		/* 忽略 */
	}
}

githubTokenSaveBtnEl.addEventListener("click", async () => {
	const token = githubTokenInputEl.value.trim();
	if (!token) {
		showError("请先填写 GitHub Token");
		return;
	}
	try {
		await api("/api/app/github-token", { method: "POST", body: JSON.stringify({ token }) });
		githubTokenInputEl.value = "";
		showInfo("GitHub Token 已保存");
		await loadVersionSection();
	} catch (error) {
		showError(`保存失败：${error.message}`);
	}
});

githubTokenClearBtnEl.addEventListener("click", async () => {
	try {
		await api("/api/app/github-token", { method: "DELETE" });
		showInfo("已清除 GitHub Token");
		githubTokenInputEl.placeholder = "GitHub Token（ghp_…，可选）";
		await loadVersionSection();
	} catch (error) {
		showError(`清除失败：${error.message}`);
	}
});

updateCheckBtnEl.addEventListener("click", async () => {
	updateCheckBtnEl.disabled = true;
	updateStatusEl.textContent = "正在检查更新…";
	updateRunBtnEl.hidden = true;
	try {
		const info = await api("/api/app/update-check");
		if (info.latest === null) {
			updateStatusEl.textContent = "无法连接 GitHub 检查更新（网络问题或限流），请稍后再试";
		} else if (info.updateAvailable) {
			updateStatusEl.textContent = `发现新版本 v${info.latest}（当前 v${info.current}）`;
			updateRunBtnEl.hidden = false;
		} else {
			updateStatusEl.textContent = `已是最新版 v${info.current}`;
		}
	} catch (error) {
		updateStatusEl.textContent = `检查失败：${error.message}`;
	} finally {
		updateCheckBtnEl.disabled = false;
	}
});

updateRunBtnEl.addEventListener("click", async () => {
	updateRunBtnEl.disabled = true;
	updateStatusEl.textContent = "正在下载更新…";
	updateProgressEl.hidden = false;
	try {
		await api("/api/app/update", { method: "POST", body: "{}" });
	} catch (error) {
		updateStatusEl.textContent = `更新失败：${error.message}`;
		updateRunBtnEl.disabled = false;
		updateProgressEl.hidden = true;
		return;
	}
	const timer = setInterval(async () => {
		let progress;
		try {
			progress = await api("/api/app/update-progress");
		} catch {
			return;
		}
		if (progress.running && progress.phase === "downloading") {
			const total = progress.totalBytes ?? 0;
			const p = total > 0 ? Math.min(100, Math.round((progress.receivedBytes / total) * 100)) : 0;
			updateProgressBarEl.style.width = `${p}%`;
			updateStatusEl.textContent = `正在下载更新… ${p}%`;
		} else if (progress.running && progress.phase === "installing") {
			updateStatusEl.textContent = "下载完成，正在安装并重启客户端…";
		} else if (progress.error) {
			clearInterval(timer);
			updateStatusEl.textContent = `更新失败：${progress.error}`;
			updateRunBtnEl.disabled = false;
			updateProgressEl.hidden = true;
		}
	}, 1000);
});

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

(async function init() {
	try {
		await Promise.all([loadModels(), loadAssistants(), loadFsRoots(), loadContextPanel()]);
		await ensureSession();
		connectSSE();
		inputEl.disabled = false;
		sendBtn.disabled = false;
		modelSelectEl.disabled = false;
		thinkingSelectEl.disabled = false;
		inputEl.focus();
	} catch (error) {
		showError(`初始化失败：${error.message}`);
		connStateEl.textContent = "未连接";
		connStateEl.classList.add("disconnected");
	}
})();
