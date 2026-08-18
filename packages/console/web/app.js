"use strict";

// Pi 控制台前端：纯原生 JS，无构建步骤。
// 会话 id 与事件序号存在内存 / localStorage，SSE 断线用 ?since=<序号> 补发。

const SESSION_KEY = "pi-console-session";
const TOKEN_KEY = "pi-console-token";

const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send-btn");
const stopBtn = document.getElementById("stop-btn");
const indicatorEl = document.getElementById("indicator");
const errorBarEl = document.getElementById("error-bar");
const connStateEl = document.getElementById("conn-state");
const modelSelectEl = document.getElementById("model-select");
const thinkingSelectEl = document.getElementById("thinking-select");
const fileInputEl = document.getElementById("file-input");
const attachBtnEl = document.getElementById("attach-btn");
const attachmentsEl = document.getElementById("attachments");
const packsListEl = document.getElementById("packs-list");
const packsToggleEl = document.getElementById("packs-toggle");
const packsPanelEl = document.getElementById("packs-panel");
const packsChevronEl = document.getElementById("packs-chevron");

let sessionId = localStorage.getItem(SESSION_KEY);
let lastSeq = -1; // 已收到（含）的最大事件序号
let running = false; // 一轮对话是否进行中
let es = null; // 当前 EventSource
let reconnectTimer = null;
let currentAssistant = null; // 本轮正在流式输出的助手消息容器
let pendingAttachments = []; // { name, mimeType, dataBase64, size, isImage }

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
			return api(path, options); // 重试一次
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
			// 只有会话确实不存在（服务器重启过）才重建，其他错误如实抛出
			if (error.status !== 404) throw error;
			sessionId = null;
			localStorage.removeItem(SESSION_KEY);
		}
	}
	const result = await api("/api/sessions", { method: "POST", body: "{}" });
	sessionId = result.sessionId;
	localStorage.setItem(SESSION_KEY, sessionId);
	messagesEl.innerHTML = "";
	// 同步新会话的默认模型 / 思考等级（来自持久化设置）
	const history = await api(`/api/sessions/${sessionId}/history`).catch(() => null);
	if (history?.model) syncModelSelect(history.model.provider, history.model.modelId);
	if (history?.thinkingLevel) thinkingSelectEl.value = history.thinkingLevel;
}

function renderHistory(history) {
	messagesEl.innerHTML = "";
	// 从服务端给出的最新事件序号续接 SSE，避免恢复后再重放历史事件
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
// SSE 连接（手动重连，带 since 补发；按 seq 去重）
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
				// 服务端缓冲不足，全量重建
				refreshFromHistory();
				return;
			}
			if (event.seq <= lastSeq) return; // 去重
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
		/* 忽略，等下次重连 */
	}
}

// ---------------------------------------------------------------------------
// 事件渲染
// ---------------------------------------------------------------------------

function handleEvent(event) {
	switch (event.type) {
		case "text_delta":
			setIndicator(false);
			ensureAssistant().appendText(event.delta);
			break;
		case "thinking_delta":
			setIndicator(true, "思考中…");
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
			if (event.stopReason === "error") {
				showError(event.errorMessage || "模型返回错误");
			}
			currentAssistant = null;
			setIndicator(false);
			break;
		case "agent_settled":
			setRunning(false);
			setIndicator(false);
			break;
		case "auto_retry_start":
			setIndicator(true, `请求失败，自动重试中（第 ${event.attempt}/${event.maxAttempts} 次）：${event.errorMessage}`);
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

function appendMessage(role, text) {
	const wrap = document.createElement("div");
	wrap.className = `message ${role}`;
	const bubble = document.createElement("div");
	bubble.className = "bubble";
	if (text) {
		const textEl = document.createElement("div");
		textEl.className = "text";
		textEl.textContent = text;
		bubble.appendChild(textEl);
	}
	wrap.appendChild(bubble);
	messagesEl.appendChild(wrap);
	scrollToBottom();
	return {
		el: bubble,
		/** 流式追加文本；工具块之后的新文本插到工具块后面，保持顺序 */
		appendText(delta) {
			let textEl = bubble.lastElementChild;
			if (!textEl || !textEl.classList.contains("text")) {
				textEl = document.createElement("div");
				textEl.className = "text";
				bubble.appendChild(textEl);
			}
			textEl.textContent += delta;
			scrollToBottom();
		},
	};
}

function ensureAssistant() {
	if (!currentAssistant) {
		currentAssistant = appendMessage("assistant", "");
	}
	return currentAssistant;
}

function appendToolBlock(bubble, toolCallId, toolName, args, status) {
	const block = document.createElement("div");
	block.className = "tool-block running";
	block.dataset.toolCallId = toolCallId;
	const header = document.createElement("div");
	header.className = "tool-header";
	const nameEl = document.createElement("span");
	nameEl.className = "tool-name";
	nameEl.textContent = `⚙ ${toolName}`;
	const statusEl = document.createElement("span");
	statusEl.className = "tool-status";
	statusEl.textContent = status === "running" ? "运行中…" : "已结束";
	header.appendChild(nameEl);
	header.appendChild(statusEl);
	block.appendChild(header);

	const argsEl = document.createElement("div");
	argsEl.className = "tool-args";
	argsEl.textContent = summarizeArgs(args);
	block.appendChild(argsEl);

	const resultEl = document.createElement("div");
	resultEl.className = "tool-result";
	resultEl.hidden = true;
	block.appendChild(resultEl);

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
// 状态与输入
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
	errorBarEl.hidden = false;
	setTimeout(() => {
		errorBarEl.hidden = true;
	}, 15000);
}

function scrollToBottom() {
	messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---------------------------------------------------------------------------
// 附件
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
		const attachment = {
			name: file.name,
			mimeType: file.type || "application/octet-stream",
			dataBase64,
			size: file.size,
			isImage: IMAGE_MIME.has(file.type),
		};
		pendingAttachments.push(attachment);
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

async function sendMessage() {
	const text = inputEl.value.trim();
	if (!text || running || !sessionId) return;
	inputEl.value = "";
	errorBarEl.hidden = true;
	appendMessage("user", text);
	setRunning(true);
	setIndicator(true, "思考中…");

	try {
		// 1) 先提取图片（给模型看的），再保存全部附件到 uploads/（含图片，模型可用工具读取）
		const images = [];
		for (const attachment of pendingAttachments) {
			if (attachment.isImage) {
				images.push({ data: attachment.dataBase64, mimeType: attachment.mimeType });
			}
		}
		let attachmentLine = "";
		if (pendingAttachments.length > 0) {
			const saved = await api(`/api/sessions/${sessionId}/files`, {
				method: "POST",
				body: JSON.stringify({
					files: pendingAttachments.map(({ name, mimeType, dataBase64 }) => ({
						name,
						mimeType,
						dataBase64,
					})),
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
// 模型 / 思考等级选择器
// ---------------------------------------------------------------------------

function syncModelSelect(provider, modelId) {
	const value = `${provider}/${modelId}`;
	if ([...modelSelectEl.options].some((o) => o.value === value)) {
		modelSelectEl.value = value;
	}
}

async function loadModels() {
	try {
		const models = await api("/api/models");
		modelSelectEl.innerHTML = "";
		const authed = models.filter((m) => m.hasAuth);
		const others = models.filter((m) => !m.hasAuth);
		// 已配置 Key 的完整列出；无 Key 的折叠为按 provider 的占位项，避免上千项
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
		// 恢复当前会话模型
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
		// 恢复原值
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
		thinkingSelectEl.value = result.level; // 服务端按模型能力截断后的实际值
	} catch (error) {
		showError(`切换思考等级失败：${error.message}`);
	}
});

// ---------------------------------------------------------------------------
// 能力包面板
// ---------------------------------------------------------------------------

packsToggleEl.addEventListener("click", () => {
	const collapsed = packsPanelEl.classList.toggle("collapsed");
	packsChevronEl.textContent = collapsed ? "▸" : "▾";
});

async function loadPacks() {
	try {
		const packs = await api("/api/packs");
		packsListEl.innerHTML = "";
		if (packs.length === 0) {
			packsListEl.textContent = "暂无能力包";
			return;
		}
		for (const pack of packs) {
			const card = document.createElement("div");
			card.className = "pack-card";
			card.dataset.packName = pack.name;

			const header = document.createElement("div");
			header.className = "pack-header";
			const title = document.createElement("div");
			title.className = "pack-title";
			title.textContent = `${pack.displayName} v${pack.version}`;
			const toggle = document.createElement("input");
			toggle.type = "checkbox";
			toggle.className = "pack-toggle";
			toggle.checked = pack.mounted;
			toggle.addEventListener("change", () => togglePack(pack.name, toggle));
			header.appendChild(title);
			header.appendChild(toggle);
			card.appendChild(header);

			const desc = document.createElement("div");
			desc.className = "pack-desc";
			desc.textContent = pack.description;
			card.appendChild(desc);

			const tools = document.createElement("div");
			tools.className = "pack-tools";
			tools.textContent = pack.tools.join(", ");
			card.appendChild(tools);

			if (pack.name === "office-assistant") {
				const statusRow = document.createElement("div");
				statusRow.className = "officecli-status";
				card.appendChild(statusRow);
				renderOfficeCliStatus(statusRow);
			}

			packsListEl.appendChild(card);
		}
	} catch (error) {
		packsListEl.textContent = `加载失败：${error.message}`;
	}
}

async function togglePack(name, toggle) {
	const action = toggle.checked ? "mount" : "unmount";
	try {
		await api(`/api/packs/${name}/${action}`, { method: "POST", body: "{}" });
		showInfo(`${action === "mount" ? "已挂载" : "已卸载"} ${name}，下一轮对话生效`);
	} catch (error) {
		toggle.checked = !toggle.checked;
		showError(`切换能力包失败：${error.message}`);
	}
}

/** OfficeCLI 状态行 + 下载按钮 + 进度条 */
async function renderOfficeCliStatus(container, statusOverride) {
	let status = statusOverride;
	if (!status) {
		try {
			status = await api("/api/officecli/status");
		} catch {
			container.textContent = "状态获取失败";
			return;
		}
	}
	container.innerHTML = "";
	const line = document.createElement("div");
	line.className = "officecli-line";
	const stateEl = document.createElement("span");
	if (status.installed) {
		stateEl.textContent = `已安装 v${status.version}`;
	} else {
		stateEl.textContent = "未安装";
	}
	line.appendChild(stateEl);
	if (status.latestVersion && status.latestVersion !== status.version) {
		const updateBadge = document.createElement("span");
		updateBadge.className = "officecli-update-badge";
		updateBadge.textContent = `可更新 → v${status.latestVersion}`;
		line.appendChild(updateBadge);
	}
	container.appendChild(line);

	const downloadBtn = document.createElement("button");
	downloadBtn.className = "officecli-download";
	downloadBtn.textContent = status.installed ? "更新" : "下载";
	downloadBtn.addEventListener("click", async () => {
		downloadBtn.disabled = true;
		try {
			await api("/api/officecli/download", { method: "POST", body: "{}" });
			pollDownloadProgress(container, downloadBtn);
		} catch (error) {
			downloadBtn.disabled = false;
			showError(`下载失败：${error.message}`);
		}
	});
	container.appendChild(downloadBtn);
}

function pollDownloadProgress(container, downloadBtn) {
	const barWrap = document.createElement("div");
	barWrap.className = "download-bar-wrap";
	const bar = document.createElement("div");
	bar.className = "download-bar";
	barWrap.appendChild(bar);
	const pct = document.createElement("span");
	pct.className = "download-pct";
	pct.textContent = "0%";
	container.appendChild(barWrap);
	container.appendChild(pct);

	const timer = setInterval(async () => {
		let progress;
		try {
			progress = await api("/api/officecli/progress");
		} catch {
			clearInterval(timer);
			downloadBtn.disabled = false;
			return;
		}
		if (progress.running) {
			const total = progress.totalBytes ?? 0;
			const p = total > 0 ? Math.min(100, Math.round((progress.receivedBytes / total) * 100)) : 0;
			bar.style.width = `${p}%`;
			pct.textContent = `${p}%`;
		} else {
			clearInterval(timer);
			downloadBtn.disabled = false;
			barWrap.remove();
			pct.remove();
			if (progress.error) {
				showError(`OfficeCLI 下载失败：${progress.error}`);
			} else {
				showInfo(`OfficeCLI 已更新到 v${progress.version}`);
			}
			renderOfficeCliStatus(container);
		}
	}, 1000);
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

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

(async function init() {
	try {
		await loadModels();
		await ensureSession();
		connectSSE();
		loadPacks();
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
