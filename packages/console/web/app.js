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

let sessionId = localStorage.getItem(SESSION_KEY);
let lastSeq = -1; // 已收到（含）的最大事件序号
let running = false; // 一轮对话是否进行中
let es = null; // 当前 EventSource
let reconnectTimer = null;
let currentAssistant = null; // 本轮正在流式输出的助手消息容器
let thinkingActive = false;

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
	thinkingActive = visible;
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

async function sendMessage() {
	const text = inputEl.value.trim();
	if (!text || running || !sessionId) return;
	inputEl.value = "";
	errorBarEl.hidden = true;
	appendMessage("user", text);
	setRunning(true);
	setIndicator(true, "思考中…");
	try {
		await api(`/api/sessions/${sessionId}/messages`, {
			method: "POST",
			body: JSON.stringify({ text }),
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
// 启动
// ---------------------------------------------------------------------------

(async function init() {
	try {
		await ensureSession();
		connectSSE();
		inputEl.disabled = false;
		sendBtn.disabled = false;
		inputEl.focus();
	} catch (error) {
		showError(`初始化失败：${error.message}`);
		connStateEl.textContent = "未连接";
		connStateEl.classList.add("disconnected");
	}
})();
