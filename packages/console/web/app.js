"use strict";

// Pi 控制台前端：纯原生 JS，无构建步骤。
// 布局：左栏（工具/技能/对话/文件）+ 聊天区 + 右侧详情抽屉。
// Claude 风格：Markdown 渲染、代码高亮、思考过程折叠滚动、工具调用块折叠。

const SESSION_KEY = "pi-console-session";
const TOKEN_KEY = "pi-console-token";

// ---------------------------------------------------------------------------
// 元素引用
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const messagesEl = $("messages");
const messagesEmptyEl = $("messages-empty");
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
const themeBtnEl = $("theme-btn");
const settingsModalEl = $("settings-modal");
const settingsCloseEl = $("settings-close");
const keyProviderEl = $("key-provider");
const keyInputEl = $("key-input");
const keyAddBtnEl = $("key-add-btn");
const keyListEl = $("key-list");
const codexOAuthStatusEl = $("codex-oauth-status");
const codexOAuthLoginBtnEl = $("codex-oauth-login-btn");
const codexOAuthLogoutBtnEl = $("codex-oauth-logout-btn");
const codexOAuthCodeEl = $("codex-oauth-code");
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
const fsRootSelectEl = $("fs-root-select");
const fsTreeEl = $("fs-tree");
const fsRefreshBtnEl = $("fs-refresh");
const fsUpBtnEl = $("fs-up");
const fsPathInputEl = $("fs-path-input");
const fsPathGoBtnEl = $("fs-path-go");
const fsLocationStateEl = $("fs-location-state");
const fsWorkspacePathEl = $("fs-workspace-path");
const fsSetWorkspaceBtnEl = $("fs-set-workspace");
const sessionsListEl = $("sessions-list");
const sessionNewBtnEl = $("session-new-btn");
const contextBtnEl = $("context-btn");
const contextRingFgEl = $("context-ring-fg");
const contextRingTextEl = $("context-ring-text");
const workspaceInputEl = $("workspace-input");
const workspaceBrowseBtnEl = $("workspace-browse-btn");
const workspaceSaveBtnEl = $("workspace-save-btn");
const workspaceCurrentEl = $("workspace-current");
const storageInputEl = $("storage-input");
const storageBrowseBtnEl = $("storage-browse-btn");
const storageMigrateBtnEl = $("storage-migrate-btn");
const storageCurrentEl = $("storage-current");
const previewModalEl = $("preview-modal");
const previewTitleEl = $("preview-title");
const previewContentEl = $("preview-content");
const previewCloseEl = $("preview-close");
const previewAttachBtnEl = $("preview-attach");
const contextInfoEl = $("context-info");
const toolsNavBtnEl = $("tools-nav-btn");
const skillsNavBtnEl = $("skills-nav-btn");
const catalogViewEl = $("catalog-view");
const catalogTitleEl = $("catalog-title");
const catalogSubtitleEl = $("catalog-subtitle");
const catalogCloseBtnEl = $("catalog-close-btn");
const catalogToolsTabEl = $("catalog-tools-tab");
const catalogSkillsTabEl = $("catalog-skills-tab");
const catalogSearchInputEl = $("catalog-search-input");
const catalogFiltersEl = $("catalog-filters");
const catalogContentEl = $("catalog-content");
const drawerEl = $("drawer");
const drawerTitleEl = $("drawer-title");
const drawerContentEl = $("drawer-content");
const drawerCloseEl = $("drawer-close");
const conversationWorkbenchEl = $("conversation-workbench");
const officePreviewPaneEl = $("office-preview-pane");
const officePreviewResizerEl = $("office-preview-resizer");
const officePreviewTitleEl = $("office-preview-title");
const officePreviewStatusEl = $("office-preview-status");
const officePreviewLoadingEl = $("office-preview-loading");
const officePreviewFrameEl = $("office-preview-frame");
const officePreviewRefreshEl = $("office-preview-refresh");
const officePreviewExternalEl = $("office-preview-external");
const officePreviewCloseEl = $("office-preview-close");

let sessionId = localStorage.getItem(SESSION_KEY);
let lastSeq = -1;
let running = false;
let es = null;
let reconnectTimer = null;
let currentAssistant = null;
let pendingAttachments = [];
let previewFile = null; // 预览中的文件 {name, mimeType, dataBase64, size}
let previewObjectUrl = null;
let catalogCache = null;
let catalogMode = "tools";
let catalogFilter = "全部";
let officeInstallTimer = null;
let redTeamInstallTimer = null;
let codexOAuthTimer = null;
let officePreview = null;
let officePreviewRequest = 0;
const officeToolCalls = new Map();

const OFFICE_PREVIEW_WIDTH_KEY = "pi-console-office-preview-width";
const OFFICE_FILE_RE = /\.(?:docx|xlsx|pptx)$/i;
const DELIVERABLE_FILE_RE = /\.[A-Za-z0-9]{1,16}$/i;

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
// OfficeCLI 实时渲染（office_preview_watch）
// ---------------------------------------------------------------------------

function isOfficeFilePath(path) {
	return typeof path === "string" && OFFICE_FILE_RE.test(path.trim().replace(/["']$/, ""));
}

function cleanOfficeFilePath(path) {
	return path.trim().replace(/^["']|["']$/g, "");
}

function applyOfficePreviewWidth(width) {
	const bounds = conversationWorkbenchEl.getBoundingClientRect();
	const max = Math.max(360, bounds.width - 340);
	const next = Math.max(360, Math.min(Number(width) || Math.round(bounds.width * 0.56), max));
	officePreviewPaneEl.style.width = `${next}px`;
}

function showOfficePreviewPane(fileName) {
	applyOfficePreviewWidth(localStorage.getItem(OFFICE_PREVIEW_WIDTH_KEY));
	officePreviewTitleEl.textContent = fileName || "Office 文档";
	officePreviewPaneEl.hidden = false;
	officePreviewResizerEl.hidden = false;
}

async function stopOfficePreviewSession(preview) {
	if (!preview?.id) return;
	try {
		await api(`/api/office-preview/${preview.id}/stop`, { method: "POST", body: "{}" });
	} catch {
		// 关闭预览不阻断会话操作；服务端退出时仍会清理残留进程。
	}
}

async function closeOfficePreview() {
	officePreviewRequest++;
	const closing = officePreview;
	officePreview = null;
	officePreviewFrameEl.src = "about:blank";
	officePreviewPaneEl.hidden = true;
	officePreviewResizerEl.hidden = true;
	officePreviewLoadingEl.hidden = false;
	await stopOfficePreviewSession(closing);
}

async function openOfficePreview(path, source = "manual") {
	if (!isOfficeFilePath(path)) return false;
	const cleanPath = cleanOfficeFilePath(path);
	const request = ++officePreviewRequest;
	const shownName = cleanPath.split(/[\\/]/).pop() || cleanPath;
	const previous = officePreview;
	showOfficePreviewPane(shownName);
	officePreviewLoadingEl.hidden = false;
	officePreviewStatusEl.textContent = "正在启动实时预览（office_preview_start）";

	try {
		const next = await api("/api/office-preview/start", {
			method: "POST",
			body: JSON.stringify({ path: cleanPath, sessionId }),
		});
		if (request !== officePreviewRequest) {
			if (next.id !== officePreview?.id) await stopOfficePreviewSession(next);
			return true;
		}
		if (previous && previous.id !== next.id) void stopOfficePreviewSession(previous);
		const samePreview = officePreview?.id === next.id;
		officePreview = next;
		officePreviewTitleEl.textContent = next.fileName;
		officePreviewTitleEl.title = next.filePath;
		if (!samePreview || officePreviewFrameEl.src !== next.url) {
			officePreviewFrameEl.src = next.url;
		} else {
			officePreviewLoadingEl.hidden = true;
			officePreviewStatusEl.textContent =
				source === "tool" ? "文档修改已同步（office_preview_update）" : "实时预览已连接（office_preview_watch）";
		}
		return true;
	} catch (error) {
		if (request !== officePreviewRequest) return false;
		officePreviewLoadingEl.hidden = true;
		officePreviewStatusEl.textContent = "实时预览启动失败（office_preview_error）";
		if (!previous) {
			officePreviewPaneEl.hidden = true;
			officePreviewResizerEl.hidden = true;
		}
		showError(`Office 实时预览失败：${error.message}`);
		return false;
	}
}

function findOfficePath(value, preferredKeys = []) {
	if (!value) return null;
	if (typeof value === "string") return isOfficeFilePath(value) ? cleanOfficeFilePath(value) : null;
	if (typeof value !== "object") return null;
	for (const key of preferredKeys) {
		const found = findOfficePath(value[key]);
		if (found) return found;
	}
	for (const [key, child] of Object.entries(value)) {
		if (preferredKeys.includes(key)) continue;
		const found = findOfficePath(child);
		if (found) return found;
	}
	return null;
}

function maybePreviewOfficeTool(toolCall) {
	if (!toolCall?.toolName?.startsWith("office_")) return;
	const path = findOfficePath(toolCall.args, ["output", "file"]);
	if (path) void openOfficePreview(path, "tool");
}

function findDeliverableToolPath(value, preferredKeys = []) {
	if (!value) return null;
	if (typeof value === "string") {
		const path = value.trim().replace(/^["']|["']$/g, "");
		return !/^https?:\/\//i.test(path) && !/[\r\n]/.test(path) && DELIVERABLE_FILE_RE.test(path) ? path : null;
	}
	if (typeof value !== "object") return null;
	for (const key of preferredKeys) {
		const found = findDeliverableToolPath(value[key]);
		if (found) return found;
	}
	for (const [key, child] of Object.entries(value)) {
		if (preferredKeys.includes(key)) continue;
		const found = findDeliverableToolPath(child);
		if (found) return found;
	}
	return null;
}

officePreviewFrameEl.addEventListener("load", () => {
	if (!officePreview || officePreviewFrameEl.src === "about:blank") return;
	officePreviewLoadingEl.hidden = true;
	officePreviewStatusEl.textContent = "实时预览已连接（office_preview_watch）";
});

officePreviewRefreshEl.addEventListener("click", () => {
	if (!officePreview) return;
	officePreviewLoadingEl.hidden = false;
	officePreviewStatusEl.textContent = "正在重新加载（office_preview_refresh）";
	const separator = officePreview.url.includes("?") ? "&" : "?";
	officePreviewFrameEl.src = `${officePreview.url}${separator}refresh=${Date.now()}`;
});

officePreviewExternalEl.addEventListener("click", () => {
	if (officePreview) window.open(officePreview.url, "_blank", "noopener");
});
officePreviewCloseEl.addEventListener("click", () => void closeOfficePreview());

officePreviewResizerEl.addEventListener("pointerdown", (event) => {
	event.preventDefault();
	officePreviewResizerEl.setPointerCapture(event.pointerId);
	const resize = (moveEvent) => {
		const bounds = conversationWorkbenchEl.getBoundingClientRect();
		applyOfficePreviewWidth(bounds.right - moveEvent.clientX);
	};
	const finish = () => {
		officePreviewResizerEl.removeEventListener("pointermove", resize);
		localStorage.setItem(OFFICE_PREVIEW_WIDTH_KEY, String(Math.round(officePreviewPaneEl.getBoundingClientRect().width)));
	};
	officePreviewResizerEl.addEventListener("pointermove", resize);
	officePreviewResizerEl.addEventListener("pointerup", finish, { once: true });
	officePreviewResizerEl.addEventListener("pointercancel", finish, { once: true });
});

// ---------------------------------------------------------------------------
// 会话初始化与恢复
// ---------------------------------------------------------------------------

async function ensureSession() {
	if (sessionId) {
		const targetSessionId = sessionId;
		try {
			const history = await api(`/api/sessions/${targetSessionId}/history`);
			if (targetSessionId !== sessionId) return;
			renderHistory(history);
			if (history.model) syncModelSelect(history.model.provider, history.model.modelId);
			if (history.thinkingLevel) thinkingSelectEl.value = history.thinkingLevel;
			syncThinkingOptions(history.availableThinkingLevels);
			renderSessionCapabilities(history.enabledCapabilities);
			return;
		} catch (error) {
			if (error.status !== 404) throw error;
			if (targetSessionId !== sessionId) return;
			sessionId = null;
			localStorage.removeItem(SESSION_KEY);
		}
	}
	const result = await api("/api/sessions", { method: "POST", body: "{}" });
	sessionId = result.sessionId;
	localStorage.setItem(SESSION_KEY, sessionId);
	clearMessages();
	const history = await api(`/api/sessions/${sessionId}/history`).catch(() => null);
	if (history) renderHistory(history);
	else setRunning(false, true);
	if (history?.model) syncModelSelect(history.model.provider, history.model.modelId);
	if (history?.thinkingLevel) thinkingSelectEl.value = history.thinkingLevel;
	syncThinkingOptions(history?.availableThinkingLevels);
	renderSessionCapabilities(history?.enabledCapabilities);
}

/** 根据当前模型的推理能力禁用不支持的思考等级选项（避免选中后被服务端钳制弹回） */
function syncThinkingOptions(availableLevels) {
	const supported = Array.isArray(availableLevels) ? availableLevels : null;
	for (const opt of thinkingSelectEl.options) {
		const ok = !supported || supported.includes(opt.value);
		opt.disabled = !ok;
		opt.title = ok ? "" : "当前模型不支持此等级";
	}
	if (supported && !supported.includes(thinkingSelectEl.value)) {
		const firstEnabled = [...thinkingSelectEl.options].find((o) => !o.disabled);
		if (firstEnabled) thinkingSelectEl.value = firstEnabled.value;
	}
}

/** 清空消息区（保留折叠控制条） */
function clearMessages() {
	messagesEl.querySelectorAll(".message").forEach((m) => m.remove());
	messagesEmptyEl.hidden = false;
	currentAssistant = null;
	officeToolCalls.clear();
}

function renderHistory(history) {
	clearMessages();
	lastSeq = typeof history.lastSeq === "number" ? history.lastSeq : -1;
	let latestAssistant = null;
	let pendingCapabilityTrace = null;
	for (const item of history.messages) {
		if (item.role === "user") {
			if (latestAssistant) latestAssistant.foldProcess();
			latestAssistant = null;
			pendingCapabilityTrace = item.capabilityTrace || null;
			appendMessage("user", item.text || (item.attachments?.length ? `发送了 ${item.attachments.length} 个文件` : ""), item.attachments);
		} else if (item.role === "assistant") {
			const container = latestAssistant || appendMessage("assistant", "");
			latestAssistant = container;
			if (pendingCapabilityTrace) {
				addCapabilitySelectionStep(container, pendingCapabilityTrace);
				pendingCapabilityTrace = null;
			}
			if (item.text) container.appendHistoryText(item.text);
			if (Array.isArray(item.toolCalls)) {
				for (const call of item.toolCalls) {
					container.addTool(appendToolBlock(call.id, call.displayName || call.name, call.args, "done"));
					const path = findDeliverableToolPath(call.args, ["output", "file", "path", "target", "destination"]);
					if (path) container.addArtifactPath(path);
				}
			}
			if (item.usage) addModelUsageStep(container, item.usage, `history-usage-${item.timestamp}`);
			void container.finalizeArtifacts();
			if (item.errorMessage) showError(item.errorMessage);
		} else if (item.role === "toolResult") {
			const block = document.querySelector(`[data-tool-call-id="${CSS.escape(item.toolCallId)}"]`);
			if (block) updateToolBlock(block, item.isError, item.text);
			if (latestAssistant && !item.isError) {
				const path = findDeliverableToolPath(item.text);
				if (path) latestAssistant.addArtifactPath(path);
				void latestAssistant.finalizeArtifacts();
			}
		}
	}
	if (latestAssistant) {
		if (history.streaming) currentAssistant = latestAssistant;
		else latestAssistant.foldProcess();
	}
	setRunning(Boolean(history.streaming), true);
}

function addCapabilitySelectionStep(container, event) {
	const block = appendToolBlock(
		event.stepId,
		event.stepDisplayName || "查找可用能力（capability_search）",
		{
			检查范围: (event.enabledCapabilities || []).map((item) => `${item.displayName}（${item.name}）`),
			选择方式: "本地规则，零模型 token",
		},
		"done",
	);
	updateToolBlock(block, false, formatCapabilitySelection(event));
	container.addTool(block);
}

function addModelUsageStep(container, usage, id) {
	const block = appendToolBlock(
		id,
		"模型用量（model_usage）",
		{ 统计来源: "模型服务商返回的本轮实际用量" },
		"done",
	);
	updateToolBlock(block, false, formatModelUsage(usage));
	container.addTool(block);
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

function disconnectSSE() {
	clearTimeout(reconnectTimer);
	reconnectTimer = null;
	if (es) {
		es.close();
		es = null;
	}
}

function connectSSE() {
	if (!sessionId) return;
	disconnectSSE();
	const connectedSessionId = sessionId;
	const token = localStorage.getItem(TOKEN_KEY);
	const tokenQuery = token ? `&token=${encodeURIComponent(token)}` : "";
	const source = new EventSource(`/api/sessions/${connectedSessionId}/stream?since=${lastSeq}${tokenQuery}`);
	es = source;

	source.onopen = () => {
		if (source !== es || connectedSessionId !== sessionId) return;
		connStateEl.textContent = "已连接";
		connStateEl.classList.remove("disconnected");
	};
	source.onmessage = (msg) => {
		if (source !== es || connectedSessionId !== sessionId) return;
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
	source.onerror = () => {
		if (source !== es || connectedSessionId !== sessionId) return;
		connStateEl.textContent = "重连中…";
		connStateEl.classList.add("disconnected");
		source.close();
		es = null;
		clearTimeout(reconnectTimer);
		reconnectTimer = setTimeout(connectSSE, 2000);
	};
}

async function refreshFromHistory() {
	const targetSessionId = sessionId;
	try {
		const history = await api(`/api/sessions/${targetSessionId}/history`);
		if (targetSessionId !== sessionId) return;
		renderHistory(history);
	} catch {
		/* 等下次重连 */
	}
}

// ---------------------------------------------------------------------------
// 左栏：对话列表（历史会话，点击切换）
// ---------------------------------------------------------------------------

async function loadSessions() {
	try {
		const list = await api("/api/sessions");
		sessionsListEl.innerHTML = "";
		if (list.length === 0) {
			sessionsListEl.innerHTML = '<div class="skills-empty">暂无历史对话</div>';
			return;
		}
		for (const session of list) {
			const row = document.createElement("div");
			row.className = `session-row${session.id === sessionId ? " active" : ""}${session.streaming ? " running" : ""}`;
			row.dataset.sid = session.id;
			const title = document.createElement("div");
			title.className = "session-title";
			title.textContent = session.title;
			const meta = document.createElement("div");
			meta.className = `session-meta${session.streaming ? " running" : ""}`;
			const states = [];
			if (session.id === sessionId) states.push("当前");
			if (session.streaming) states.push("运行中");
			meta.textContent = `${new Date(session.updatedAt).toLocaleDateString("zh-CN")}${states.length ? ` · ${states.join(" · ")}` : ""}`;
			row.appendChild(title);
			row.appendChild(meta);
			row.addEventListener("click", () => switchSession(session.id));
			row.addEventListener("contextmenu", (e) => {
				e.preventDefault();
				e.stopPropagation(); // 阻止冒泡到 document 层，避免菜单被立即隐藏
				showSessionContextMenu(e.clientX, e.clientY, session.id, session.title);
			});
			sessionsListEl.appendChild(row);
		}
	} catch (error) {
		sessionsListEl.textContent = `加载失败：${error.message}`;
	}
}

/** 切换到历史会话（服务端从磁盘恢复，消息与 SSE 随之切换） */
async function switchSession(id) {
	if (id === sessionId) return;
	await closeOfficePreview();
	disconnectSSE();
	sessionId = id;
	localStorage.setItem(SESSION_KEY, id);
	clearMessages();
	setRunning(false, true);
	lastSeq = -1;
	try {
		await ensureSession();
		if (id !== sessionId) return;
		connectSSE();
		await loadSessions();
		await pollContext();
	} catch (error) {
		showError(`切换对话失败：${error.message}`);
	}
}

/** 删除会话：记录与对话内容删除，工作区文件保留；若删除的是当前会话则新建 */
let sessionContextMenuEl = null;

/** 删除会话：记录与对话内容删除，工作区文件保留；删除当前会话后跳转到列表第一个会话 */
async function deleteSession(id) {
	if (!window.confirm("删除此对话？\n（对话记录将被删除，工作区里的文件会保留）")) return;
	try {
		await api(`/api/sessions/${id}`, { method: "DELETE" });
		if (id === sessionId) {
			const list = await api("/api/sessions").catch(() => []);
			sessionId = null;
			localStorage.removeItem(SESSION_KEY);
			clearMessages();
			lastSeq = -1;
			if (list.length > 0) {
				// 跳转到会话栏第一个会话
				await switchSession(list[0].id);
			} else {
				// 没有会话了：保持空状态，页面显示空（用户可点 ＋ 新对话）
				disconnectSSE();
				setRunning(false, true);
				connStateEl.textContent = "空闲";
			}
		}
		await loadSessions();
		showInfo("对话已删除");
	} catch (error) {
		showError(`删除对话失败：${error.message}`);
	}
}

async function renameSession(id, currentTitle) {
	const requested = window.prompt("请输入新的会话名称：", currentTitle || "");
	if (requested === null) return;
	const title = requested.replace(/\s+/g, " ").trim();
	if (!title) {
		showError("会话名称不能为空");
		return;
	}
	try {
		await api(`/api/sessions/${id}`, {
			method: "PATCH",
			body: JSON.stringify({ title }),
		});
		await loadSessions();
		showInfo("会话名称已修改");
	} catch (error) {
		showError(`修改会话名称失败：${error.message}`);
	}
}

/** 右键菜单：修改名称或删除会话 */
function showSessionContextMenu(x, y, id, currentTitle) {
	hideSessionContextMenu();
	const menu = document.createElement("div");
	menu.className = "session-context-menu";
	const renameItem = document.createElement("div");
	renameItem.className = "session-context-item";
	renameItem.textContent = "修改会话名称";
	renameItem.addEventListener("click", async () => {
		hideSessionContextMenu();
		await renameSession(id, currentTitle);
	});
	const deleteItem = document.createElement("div");
	deleteItem.className = "session-context-item danger";
	deleteItem.textContent = "删除当前会话";
	deleteItem.addEventListener("click", async () => {
		hideSessionContextMenu();
		await deleteSession(id);
	});
	menu.append(renameItem, deleteItem);
	menu.style.left = `${x}px`;
	menu.style.top = `${y}px`;
	document.body.appendChild(menu);
	sessionContextMenuEl = menu;
}

function hideSessionContextMenu() {
	if (sessionContextMenuEl) {
		sessionContextMenuEl.remove();
		sessionContextMenuEl = null;
	}
}

document.addEventListener("click", hideSessionContextMenu);
document.addEventListener("contextmenu", hideSessionContextMenu);

sessionNewBtnEl.addEventListener("click", async () => {
	try {
		await closeOfficePreview();
		disconnectSSE();
		const result = await api("/api/sessions", { method: "POST", body: "{}" });
		sessionId = result.sessionId;
		localStorage.setItem(SESSION_KEY, sessionId);
		clearMessages();
		lastSeq = -1;
		await ensureSession();
		connectSSE();
		await loadSessions();
		await pollContext();
	} catch (error) {
		showError(`新建对话失败：${error.message}`);
	}
});

// ---------------------------------------------------------------------------
// 上下文使用量圆环（本地估算，零 token 消耗）
// ---------------------------------------------------------------------------

/** 更新圆环：percent 0-100；usage 为 null（未知）时显示 – */
function renderContextRing(info) {
	const usage = info?.usage ?? {};
	const percent = usage.percent ?? null;
	const tokens = usage.tokens ?? null;
	const contextWindow = usage.contextWindow ?? null;
	const p = percent === null || percent === undefined ? null : Math.max(0, Math.min(100, percent));
	const r = 15.5;
	const circumference = 2 * Math.PI * r;
	if (p === null) {
		contextRingFgEl.style.strokeDasharray = "0 999";
		contextRingTextEl.textContent = "–";
	} else {
		const dash = (p / 100) * circumference;
		contextRingFgEl.style.strokeDasharray = `${dash} ${circumference}`;
		contextRingFgEl.style.stroke = p >= 80 ? "#e5484d" : p >= 60 ? "#f5a524" : "#3b6ef5";
		contextRingTextEl.textContent = p < 10 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`;
	}
	// hover 完整信息（无法统计的字段显示空）
	const fmtTokens = (v) => (v === null || v === undefined ? "" : `${(v / 1000).toFixed(1)}k`);
	const capabilityNames = (info?.enabledCapabilities || []).map((item) => `${item.displayName}（${item.name}）`).join("、");
	const lastTrace = info?.lastCapabilityTrace;
	const compaction = info?.compaction;
	const rows = [
		`模型：${info?.model ? info.model.name : ""}`,
		`上下文窗口：${contextWindow ? `${(contextWindow / 1000).toFixed(0)}k tokens` : ""}`,
		`已用：${p !== null ? `${p.toFixed(2)}%（${fmtTokens(tokens)} tokens）` : ""}`,
		`缓存命中：${fmtTokens(info?.cacheRead)} tokens`,
		`缓存写入：${fmtTokens(info?.cacheWrite)} tokens`,
		`消息数：${info?.messageCount ?? ""}`,
		`思考等级：${info?.thinkingLevel ?? ""}`,
		`自动压缩：${compaction ? (compaction.enabled ? "已开启" : "已关闭") : ""}`,
		`可用工具：${capabilityNames}`,
		`上轮实际工具：${lastTrace ? `${lastTrace.toolCount} 个 / ${formatByteSize(lastTrace.schemaBytes)}` : ""}`,
		`工具定义指纹：${lastTrace?.schemaFingerprint ?? ""}`,
	];
	contextBtnEl.title = rows.map((row) => row.replace(/^[^：]+：/, "") ? row : "").filter(Boolean).join("\n") || "上下文使用量";
}

async function pollContext() {
	if (!sessionId) return;
	const targetSessionId = sessionId;
	try {
		const info = await api(`/api/sessions/${targetSessionId}/context`);
		if (targetSessionId !== sessionId) return;
		renderContextRing(info);
		renderSessionCapabilities(info.enabledCapabilities);
	} catch {
		/* 静默：会话可能刚切换 */
	}
}

contextBtnEl.addEventListener("click", async () => {
	if (!sessionId) return;
	try {
		const info = await api(`/api/sessions/${sessionId}/context`);
		const usage = info.usage ?? {};
		const compaction = info.compaction;
		const fmt = (v) => (v === null || v === undefined ? "（暂无统计）" : `${(v / 1000).toFixed(1)}k`);
		const lines = [
			`模型：${info.model ? `${info.model.name}（${info.model.provider}/${info.model.modelId}）` : "未配置"}`,
			`上下文窗口：${usage.contextWindow ? (usage.contextWindow / 1000).toFixed(0) + "k tokens" : "未知"}`,
			`已用：${usage.tokens !== null && usage.tokens !== undefined ? `${(usage.tokens / 1000).toFixed(1)}k tokens（${(usage.percent ?? 0).toFixed(2)}%）` : "（暂无统计）"}`,
			`缓存命中：${fmt(info.cacheRead)} tokens`,
			`缓存写入：${fmt(info.cacheWrite)} tokens`,
			`消息数：${info.messageCount}`,
			`思考等级：${info.thinkingLevel}`,
			`自动压缩：${compaction ? (compaction.enabled ? `已开启（接近上限时预留 ${fmt(compaction.reserveTokens)} token，压缩后保留近期约 ${fmt(compaction.keepRecentTokens)} token）` : "已关闭") : "暂无设置"}`,
			`可用工具：${(info.enabledCapabilities || []).map((item) => `${item.displayName}（${item.name}）`).join("、") || "仅原生 Pi 工具"}`,
			`上轮实际工具：${info.lastCapabilityTrace ? `${info.lastCapabilityTrace.toolCount} 个（工具定义 ${formatByteSize(info.lastCapabilityTrace.schemaBytes)}，指纹 ${info.lastCapabilityTrace.schemaFingerprint}）` : "暂无记录"}`,
			`上轮模型用量：${typeof info.lastUsage?.totalTokens === "number" ? `${info.lastUsage.totalTokens.toLocaleString("zh-CN")} token` : "暂无统计"}`,
			"",
			"上下文占用为本地估算；能力选择同样在本地完成，不请求模型、不额外消耗 token。",
		];
		showInfo(lines.join("\n"));
	} catch (error) {
		showError(`获取上下文统计失败：${error.message}`);
	}
});

// 每 5 秒刷新当前上下文和左侧后台任务状态。
setInterval(() => {
	void pollContext();
	void loadSessions();
}, 5000);

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
			officeToolCalls.set(event.toolCallId, { toolName: event.toolName, args: event.args });
			// 工具块挂到当前轮次的"执行过程"容器（运行中展开）
			ensureAssistant().addTool(
				appendToolBlock(event.toolCallId, event.toolDisplayName || event.toolName, event.args, "running"),
			);
			break;
		case "tool_execution_end": {
			const block = document.querySelector(`[data-tool-call-id="${CSS.escape(event.toolCallId)}"]`);
			if (block) updateToolBlock(block, event.isError, event.result);
			const toolCall = officeToolCalls.get(event.toolCallId);
			officeToolCalls.delete(event.toolCallId);
			if (!event.isError) {
				maybePreviewOfficeTool(toolCall);
				const path = findDeliverableToolPath(toolCall?.args, ["output", "file", "path", "target", "destination"]);
				if (path) currentAssistant?.addArtifactPath(path);
			}
			break;
		}
		case "capability_selection": {
			addCapabilitySelectionStep(ensureAssistant(), event);
			break;
		}
		case "turn_end":
			if (event.stopReason === "error") showError(event.errorMessage || "模型返回错误");
			if (event.usage && currentAssistant) {
				addModelUsageStep(currentAssistant, event.usage, `usage-${event.seq}`);
			}
			if (currentAssistant) void currentAssistant.finalizeArtifacts();
			setIndicator(false);
			break;
		case "agent_settled":
			if (currentAssistant) {
				currentAssistant.foldProcess();
				void currentAssistant.finalizeArtifacts();
			}
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
			syncThinkingOptions(event.availableThinkingLevels);
			break;
		case "thinking_level_changed":
			thinkingSelectEl.value = event.level;
			break;
		case "error":
			showError(event.message || "发生错误");
			setIndicator(false);
			if (!event.fatal) {
				if (currentAssistant) currentAssistant.foldProcess();
				setRunning(false);
			}
			break;
	}
}

function formatCapabilitySelection(event) {
	const selected = Array.isArray(event.selectedCapabilities) ? event.selectedCapabilities : [];
	const lines = [];
	if (selected.length === 0) {
		lines.push("没有命中额外能力，本轮只使用原生 Pi 工具。");
	} else {
		for (const match of selected) {
			const groups = (match.groupDisplayNames || []).map(
				(name, index) => `${name}（${match.groupNames?.[index] || "未命名分组"}）`,
			);
			lines.push(`已加载：${match.displayName}（${match.packName}）${groups.length ? ` / ${groups.join("、")}` : ""}`);
			if (match.reasons?.length) lines.push(`依据：${match.reasons.join("；")}`);
		}
	}
	const tools = Array.isArray(event.tools) ? event.tools.map((tool) => tool.displayName || tool.name) : [];
	lines.push(`本轮实际工具（${event.toolCount ?? tools.length}）：${tools.join("、") || "无"}`);
	lines.push(`工具定义大小：${formatByteSize(event.schemaBytes)}；指纹：${event.schemaFingerprint || "无"}`);
	return lines.join("\n");
}

function formatByteSize(value) {
	if (typeof value !== "number") return "暂无统计";
	return value < 1024 ? `${value} 字节` : `${(value / 1024).toFixed(1)} KB`;
}

function formatModelUsage(usage) {
	const number = (value) => (typeof value === "number" ? value.toLocaleString("zh-CN") : "暂无统计");
	const lines = [
		`输入：${number(usage.input)} token`,
		`输出：${number(usage.output)} token`,
		`缓存读取：${number(usage.cacheRead)} token`,
		`缓存写入：${number(usage.cacheWrite)} token`,
	];
	if (typeof usage.reasoning === "number") lines.push(`其中推理：${number(usage.reasoning)} token`);
	lines.push(`合计：${number(usage.totalTokens)} token`);
	if (typeof usage.cost?.total === "number") lines.push(`费用：$${usage.cost.total.toFixed(6)}`);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Claude 风格消息渲染
// ---------------------------------------------------------------------------

function artifactPresentation(file) {
	const ext = file.name.split(".").pop()?.toLocaleLowerCase("en-US") || "";
	if (ext === "docx") return { icon: "W", type: "Word 文档" };
	if (ext === "xlsx") return { icon: "X", type: "Excel 工作簿" };
	if (ext === "pptx") return { icon: "P", type: "PowerPoint 演示文稿" };
	if (ext === "pdf") return { icon: "PDF", type: "PDF 文件" };
	if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return { icon: "图", type: "图片" };
	if (["zip", "7z"].includes(ext)) return { icon: "压", type: "压缩文件" };
	return { icon: "文", type: ext ? `${ext.toLocaleUpperCase("en-US")} 文件` : "文件" };
}

const LOCAL_FILE_DRAG_TYPE = "application/x-pi-local-file";

function startPathDrag(event, path) {
	if (!path || !event.dataTransfer) return;
	event.dataTransfer.effectAllowed = "copy";
	event.dataTransfer.setData(LOCAL_FILE_DRAG_TYPE, path);
	event.dataTransfer.setData("text/plain", path);
	// Electron 使用真实本地路径启动 Windows 原生拖放，因此可直接放到桌面或系统资源管理器。
	if (window.piDesktop?.startFileDrag) {
		event.preventDefault();
		window.piDesktop.startFileDrag(path);
	}
}

function renderArtifactCards(container, files) {
	container.innerHTML = "";
	container.hidden = !Array.isArray(files) || files.length === 0;
	for (const file of files || []) {
		const presentation = artifactPresentation(file);
		const card = document.createElement("article");
		card.className = "artifact-card";
		card.draggable = true;
		card.dataset.artifactPath = file.path;
		card.dataset.artifactName = file.name;
		card.title = file.officePreview ? "点击打开实时预览" : "点击预览文件";
		const icon = document.createElement("span");
		icon.className = "artifact-icon";
		icon.textContent = presentation.icon;
		const info = document.createElement("div");
		info.className = "artifact-info";
		const name = document.createElement("div");
		name.className = "artifact-name";
		name.textContent = file.name;
		name.title = file.path;
		const meta = document.createElement("div");
		meta.className = "artifact-meta";
		meta.textContent = `${presentation.type} · ${formatSize(file.size)}`;
		info.append(name, meta);
		const actions = document.createElement("div");
		actions.className = "artifact-actions";
		const preview = document.createElement("button");
		preview.type = "button";
		preview.className = "artifact-action secondary";
		preview.textContent = file.officePreview ? "实时预览" : "预览";
		preview.title = file.officePreview ? "实时预览（office_preview_watch）" : "预览文件（file_preview）";
		preview.dataset.previewPath = file.path;
		preview.dataset.previewName = file.name;
		actions.appendChild(preview);
		const download = document.createElement("button");
		download.type = "button";
		download.className = "artifact-action primary";
		download.textContent = "下载文件";
		download.title = "下载文件（file_download）";
		download.dataset.downloadPath = file.path;
		download.dataset.downloadName = file.name;
		actions.appendChild(download);
		card.append(icon, info, actions);
		container.appendChild(card);
	}
}

function appendMessage(role, text, attachmentPaths = []) {
	messagesEmptyEl.hidden = true;
	const messageSessionId = sessionId;
	const wrap = document.createElement("div");
	wrap.className = `message ${role}`;

	const bubble = document.createElement("div");
	bubble.className = "bubble";
	if (role === "assistant") {
		const meta = document.createElement("div");
		meta.className = "message-meta";
		const modelName = document.createElement("span");
		modelName.textContent = modelSelectEl.value ? `模型 · ${modelSelectEl.value}` : "Pi";
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

	// 执行过程区（assistant 专用：一轮里的全部工具调用，运行中展开、完成折叠）
	let processWrap = null;
	let processBody = null;
	let processCount = 0;
	if (role === "assistant") {
		processWrap = document.createElement("div");
		processWrap.className = "process-block";
		processWrap.hidden = true;
		bubble.appendChild(processWrap);
	}

	// 正文
	const textEl = document.createElement("div");
	textEl.className = "text";
	if (text) renderMarkdownInto(textEl, text);
	bubble.appendChild(textEl);
	const artifactsEl = document.createElement("div");
	artifactsEl.className = "message-artifacts";
	artifactsEl.hidden = true;
	if (role === "assistant") bubble.appendChild(artifactsEl);
	const sentAttachmentsEl = document.createElement("div");
	sentAttachmentsEl.className = "message-artifacts sent-attachments";
	sentAttachmentsEl.hidden = true;
	if (role === "user" && attachmentPaths.length > 0) bubble.appendChild(sentAttachmentsEl);

	wrap.appendChild(bubble);
	messagesEl.appendChild(wrap);
	applyCollapse();
	scrollToBottom();
	if (role === "user" && attachmentPaths.length > 0 && messageSessionId) {
		void api(`/api/sessions/${messageSessionId}/artifacts`, {
			method: "POST",
			body: JSON.stringify({ paths: attachmentPaths }),
		})
			.then((result) => {
				renderArtifactCards(sentAttachmentsEl, result.files);
				scrollToBottom();
			})
			.catch(() => {
				// 附件被移动或删除时保留消息正文，不阻断历史恢复。
			});
	}

	return {
		el: bubble,
		thinkingEl: thinking,
		textEl,
		artifactsEl,
		_textBuffer: text || "",
		_artifactPaths: new Set(),
		_artifactRequest: 0,
		addArtifactPath(path) {
			if (typeof path === "string" && path.trim()) this._artifactPaths.add(path.trim());
		},
		async finalizeArtifacts() {
			if (role !== "assistant" || !messageSessionId) return;
			const request = ++this._artifactRequest;
			try {
				const result = await api(`/api/sessions/${messageSessionId}/artifacts`, {
					method: "POST",
					body: JSON.stringify({ text: this._textBuffer || "", paths: [...this._artifactPaths] }),
				});
				if (request !== this._artifactRequest) return;
				renderArtifactCards(this.artifactsEl, result.files);
				scrollToBottom();
			} catch {
				// 文件可能已被移动或会话正在切换；不影响正文显示。
			}
		},
		/** 挂载工具块到执行过程区 */
		addTool(toolBlock) {
			if (!processWrap) return;
			processCount++;
			// 首个工具：构建容器头（运行中展开）
			if (processCount === 1) {
				processWrap.innerHTML = "";
				const head = document.createElement("div");
				head.className = "process-head";
				const chevron = document.createElement("span");
				chevron.className = "tool-chevron";
				chevron.textContent = "▾";
				const label = document.createElement("span");
				label.className = "process-label";
				label.textContent = "⚙ 执行过程";
				const countEl = document.createElement("span");
				countEl.className = "process-count";
				countEl.textContent = "1 步";
				const copyAll = document.createElement("button");
				copyAll.className = "copy-btn";
				copyAll.textContent = "⧉";
				copyAll.title = "复制全部执行过程";
				copyAll.dataset.copy = "process";
				head.appendChild(chevron);
				head.appendChild(label);
				head.appendChild(countEl);
				head.appendChild(copyAll);
				head.addEventListener("click", () => {
					processBody.hidden = !processBody.hidden;
					chevron.textContent = processBody.hidden ? "▸" : "▾";
				});
				processWrap.appendChild(head);
				processBody = document.createElement("div");
				processBody.className = "process-body";
				processWrap.appendChild(processBody);
				processWrap.hidden = false;
			} else {
				const countEl = processWrap.querySelector(".process-count");
				if (countEl) countEl.textContent = `${processCount} 步`;
			}
			processBody.appendChild(toolBlock);
			scrollToBottom();
		},
		/** 一轮结束：执行过程默认折叠（用户可点开），思考块从"思考中"落定 */
		foldProcess() {
			thinking.classList.remove("active");
			const thinkingLabel = thinking.querySelector(".thinking-label");
			if (thinkingLabel) thinkingLabel.textContent = "思考过程";
			if (!processWrap || processWrap.hidden) return;
			const body = processWrap.querySelector(".process-body");
			const chevron = processWrap.querySelector(".tool-chevron");
			if (body && !body.hidden) {
				body.hidden = true;
				if (chevron) chevron.textContent = "▸";
			}
		},
		_appendThinking(delta) {
			if (!this._thinkingOpen) {
				this._thinkingOpen = true;
				thinking.hidden = false;
				thinking.innerHTML = "";
				thinking.classList.add("active");
				const head = document.createElement("div");
				head.className = "thinking-head";
				const label = document.createElement("span");
				label.className = "thinking-label";
				label.textContent = "思考中";
				head.appendChild(label);
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
		appendHistoryText(value) {
			const separator = this._textBuffer && value ? "\n\n" : "";
			this._textBuffer = `${this._textBuffer ?? ""}${separator}${value}`;
			renderMarkdownInto(this.textEl, this._textBuffer);
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

function escapeAttribute(text) {
	return escapeHtml(text).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function isLocalFileReference(path) {
	const value = path.trim();
	return !/^https?:\/\//i.test(value) && /\.[A-Za-z0-9]{1,16}$/.test(value.replace(/[?#].*$/, ""));
}

function renderInline(text) {
	// 先把代码、网页链接和文件链接替换为占位符，避免后续格式化破坏属性。
	const fragments = [];
	const hold = (html) => `\u0000${fragments.push(html) - 1}\u0000`;
	let source = text;
	source = source.replace(/`([^`]+)`/g, (_match, code) => hold(`<code>${escapeHtml(code)}</code>`));
	source = source.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_match, label, url) =>
		hold(
			`<a class="external-link" href="${escapeAttribute(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`,
		),
	);
	source = source.replace(/\[([^\]]+)\]\(([^)\n]+)\)/g, (match, label, path) => {
		if (!isLocalFileReference(path)) return match;
		return hold(
			`<button type="button" class="inline-file-link" data-download-path="${escapeAttribute(path.trim())}" data-download-name="${escapeAttribute(label)}" title="下载文件（file_download）">📎 ${escapeHtml(label)}</button>`,
		);
	});
	source = source.replace(/https?:\/\/[^\s<\u0000]+/g, (matched) => {
		let url = matched;
		let trailing = "";
		while (/[，。；：！？,;:!?)）\]}]$/u.test(url)) {
			trailing = url.slice(-1) + trailing;
			url = url.slice(0, -1);
		}
		return `${hold(
			`<a class="external-link" href="${escapeAttribute(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`,
		)}${trailing}`;
	});

	let html = escapeHtml(source);
	html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
	html = html.replace(/\u0000(\d+)\u0000/g, (_match, index) => fragments[Number(index)] || "");
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

function appendToolBlock(toolCallId, toolName, args, status) {
	const block = document.createElement("div");
	block.className = `tool-block ${status === "running" ? "running" : "done"}`;
	block.dataset.toolCallId = toolCallId;

	const header = document.createElement("div");
	header.className = "tool-header";
	const chevron = document.createElement("span");
	chevron.className = "tool-chevron";
	chevron.textContent = "▸";
	const nameEl = document.createElement("span");
	nameEl.className = "tool-name";
	nameEl.textContent = `⚙ ${toolName}`;
	const statusEl = document.createElement("span");
	statusEl.className = "tool-status";
	statusEl.textContent = status === "running" ? "运行中…" : "已结束";
	const copyBtn = document.createElement("button");
	copyBtn.className = "copy-btn";
	copyBtn.textContent = "⧉";
	copyBtn.title = "复制该执行步骤（命令与结果）";
	copyBtn.dataset.copy = "tool";
	header.appendChild(chevron);
	header.appendChild(nameEl);
	header.appendChild(statusEl);
	header.appendChild(copyBtn);
	block.appendChild(header);

	const body = document.createElement("div");
	body.className = "tool-body";
	// 默认折叠：只显示状态行，点开看参数与结果
	body.hidden = true;

	const argsEl = document.createElement("div");
	argsEl.className = "tool-args";
	argsEl.textContent = summarizeArgs(args);
	body.appendChild(argsEl);

	const resultEl = document.createElement("div");
	resultEl.className = "tool-result";
	resultEl.hidden = true;
	body.appendChild(resultEl);

	block.appendChild(body);
	header.addEventListener("click", (e) => {
		if (e.target.closest(".copy-btn")) return;
		body.hidden = !body.hidden;
		chevron.textContent = body.hidden ? "▸" : "▾";
	});

	return block;
}

/** 结果文本里的文件路径渲染为可点击链接（点击下载/预览，Shift+点击加入对话） */
function renderResultText(resultText) {
	const escaped = escapeHtml(resultText);
	// 常见路径形态：绝对路径 / 相对路径 + 常见文件扩展名
	return escaped.replace(
		/((?:[A-Za-z]:[\\/]|\.{0,2}[\\/])[\w\-. \\/\\()（）【】\[\]]+\.[A-Za-z0-9]{1,16})/g,
		'<a class="file-link" data-path="$1" title="点击下载或预览；Shift+点击加入对话">📄 $1</a>',
	);
}

function updateToolBlock(block, isError, resultText) {
	block.classList.remove("running");
	block.classList.add(isError ? "error" : "done");
	const statusEl = block.querySelector(".tool-status");
	if (statusEl) statusEl.textContent = isError ? "失败" : "成功";
	const resultEl = block.querySelector(".tool-result");
	if (resultEl && resultText) {
		resultEl.innerHTML = renderResultText(resultText);
		resultEl.hidden = false;
	}
}

/** 复制：消息 / 代码块 / 工具步骤 / 整个执行过程 */
function copyTextFrom(btn) {
	let text = "";
	const mode = btn.dataset.copy;
	if (mode === "msg") {
		const textEl = btn.closest(".bubble")?.querySelector(".text");
		text = textEl ? textEl.innerText : "";
	} else if (mode === "code") {
		const codeEl = btn.closest("pre")?.querySelector("code");
		text = codeEl ? codeEl.innerText : "";
	} else if (mode === "tool") {
		const block = btn.closest(".tool-block");
		if (block) {
			const args = block.querySelector(".tool-args")?.textContent ?? "";
			const result = block.querySelector(".tool-result")?.innerText ?? "";
			const name = block.querySelector(".tool-name")?.textContent ?? "";
			text = `${name}\n命令/参数：${args}\n${result ? `结果：\n${result}` : ""}`;
		}
	} else if (mode === "process") {
		const body = btn.closest(".process-block")?.querySelector(".process-body");
		if (body) {
			text = body.innerText;
		}
	}
	if (!text) return false;
	navigator.clipboard.writeText(text).then(() => showInfo(`已复制（${text.length} 字符）`)).catch(() => showError("复制失败"));
	return true;
}

/** 下载智能体发出的本地文件。 */
async function downloadPathLink(path, suggestedName) {
	if (!sessionId || !path) return;
	const query = new URLSearchParams({ path, sessionId });
	const request = async () =>
		await fetch(`/api/fs/download?${query}`, {
			headers: authHeaders(),
		});
	try {
		let response = await request();
		if (response.status === 401) {
			const token = window.prompt("此服务器需要访问令牌（PI_CONSOLE_TOKEN），请输入：");
			if (token === null) throw new Error("未授权");
			localStorage.setItem(TOKEN_KEY, token);
			response = await request();
		}
		if (!response.ok) {
			const body = await response.json().catch(() => ({}));
			throw new Error(body.error || `下载失败（HTTP ${response.status}）`);
		}
		const encodedName = response.headers.get("X-File-Name");
		let fileName = suggestedName || path.split(/[\\/]/).pop() || "文件";
		if (encodedName) {
			try {
				fileName = decodeURIComponent(encodedName);
			} catch {
				// 使用界面已有名称。
			}
		}
		const blobUrl = URL.createObjectURL(await response.blob());
		const anchor = document.createElement("a");
		anchor.href = blobUrl;
		anchor.download = fileName;
		document.body.appendChild(anchor);
		anchor.click();
		anchor.remove();
		setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
		showInfo(`已下载 ${fileName}（file_download）`);
	} catch (error) {
		showError(`下载文件失败：${error.message}`);
	}
}

/** 点击文件链接：读文件加入对话附件 */
async function attachPathLink(path) {
	if (!sessionId) return;
	try {
		const file = await api(`/api/sessions/${sessionId}/attach-from-path`, {
			method: "POST",
			body: JSON.stringify({ path }),
		});
		pendingAttachments.push({
			name: file.name,
			mimeType: file.mimeType,
			dataBase64: file.dataBase64,
			size: file.size,
			isImage: IMAGE_MIME.has(file.mimeType),
		});
		renderAttachments();
		showInfo(`已将 ${file.name} 添加到对话附件`);
	} catch (error) {
		showError(`读取文件失败：${error.message}`);
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
	const previewLink = e.target.closest("[data-preview-path]");
	if (previewLink) {
		e.preventDefault();
		void openFilePreview(previewLink.dataset.previewPath, previewLink.dataset.previewName, "artifact");
		return;
	}
	const downloadLink = e.target.closest("[data-download-path]");
	if (downloadLink) {
		e.preventDefault();
		if (e.shiftKey) attachPathLink(downloadLink.dataset.downloadPath);
		else void downloadPathLink(downloadLink.dataset.downloadPath, downloadLink.dataset.downloadName);
		return;
	}
	// 工具结果里的路径：Office 文件打开实时预览，其他文件直接下载；Shift+点击可重新加入对话。
	const fileLink = e.target.closest("[data-path]");
	if (fileLink) {
		e.preventDefault();
		if (isOfficeFilePath(fileLink.dataset.path)) void openOfficePreview(fileLink.dataset.path, "tool-result");
		else if (e.shiftKey) attachPathLink(fileLink.dataset.path);
		else void downloadPathLink(fileLink.dataset.path);
		return;
	}
	const artifactCard = e.target.closest("[data-artifact-path]");
	if (artifactCard) {
		e.preventDefault();
		void openFilePreview(artifactCard.dataset.artifactPath, artifactCard.dataset.artifactName, "artifact");
		return;
	}
	const btn = e.target.closest("[data-copy]");
	if (btn) copyTextFrom(btn);
});

messagesEl.addEventListener("dragstart", (event) => {
	const card = event.target.closest("[data-artifact-path]");
	if (card) startPathDrag(event, card.dataset.artifactPath);
});

// ---------------------------------------------------------------------------
// 附件（＋按钮 / 拖拽 / 粘贴）
// ---------------------------------------------------------------------------

const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"]);

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
	if (![...(e.dataTransfer?.types ?? [])].some((type) => type === "Files" || type === LOCAL_FILE_DRAG_TYPE)) return;
	if (fsTreeEl.contains(e.target)) return;
	e.preventDefault();
	dragDepth++;
	dropOverlayEl.hidden = false;
});
window.addEventListener("dragover", (e) => {
	if (![...(e.dataTransfer?.types ?? [])].some((type) => type === "Files" || type === LOCAL_FILE_DRAG_TYPE)) return;
	e.preventDefault();
});
window.addEventListener("dragleave", (e) => {
	e.preventDefault();
	dragDepth = Math.max(0, dragDepth - 1);
	if (dragDepth === 0) dropOverlayEl.hidden = true;
});
window.addEventListener("drop", (e) => {
	if (fsTreeEl.contains(e.target)) return;
	e.preventDefault();
	dragDepth = 0;
	dropOverlayEl.hidden = true;
	const files = [...(e.dataTransfer?.files ?? [])];
	if (files.length > 0) {
		for (const file of files) addAttachment(file);
		return;
	}
	const path = e.dataTransfer?.getData(LOCAL_FILE_DRAG_TYPE);
	if (path) void attachPathLink(path);
});
window.addEventListener("paste", (e) => {
	const files = e.clipboardData?.files;
	if (!files || files.length === 0) return;
	e.preventDefault();
	for (const file of files) addAttachment(file);
});

async function sendMessage() {
	const text = inputEl.value.trim();
	if ((!text && pendingAttachments.length === 0) || running || !sessionId) return;
	const targetSessionId = sessionId;
	const attachmentsToSend = [...pendingAttachments];
	inputEl.value = "";
	resizeComposerInput();
	errorBarEl.hidden = true;
	setRunning(true);
	setIndicator(true, "思考中…");

	try {
		const images = [];
		for (const attachment of attachmentsToSend) {
			if (attachment.isImage) images.push({ data: attachment.dataBase64, mimeType: attachment.mimeType });
		}
		let savedPaths = [];
		if (attachmentsToSend.length > 0) {
			const saved = await api(`/api/sessions/${targetSessionId}/files`, {
				method: "POST",
				body: JSON.stringify({
					files: attachmentsToSend.map(({ name, mimeType, dataBase64 }) => ({ name, mimeType, dataBase64 })),
				}),
			});
			savedPaths = saved.files;
			pendingAttachments = pendingAttachments.filter((attachment) => !attachmentsToSend.includes(attachment));
			renderAttachments();
		}
		if (targetSessionId === sessionId) {
			appendMessage("user", text || `发送了 ${attachmentsToSend.length} 个文件`, savedPaths);
		}
		await api(`/api/sessions/${targetSessionId}/messages`, {
			method: "POST",
			body: JSON.stringify({ text, images, attachments: savedPaths }),
		});
		void loadSessions(); // 首条消息后标题更新，并显示后台运行状态。
	} catch (error) {
		showError(error.message);
		if (targetSessionId === sessionId) setRunning(false);
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

/** 输入框按内容增高，避免空白时占据过多聊天空间。 */
function resizeComposerInput() {
	inputEl.style.height = "auto";
	inputEl.style.height = `${Math.min(inputEl.scrollHeight, 160)}px`;
}

inputEl.addEventListener("input", resizeComposerInput);
inputEl.addEventListener("keydown", (e) => {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		sendMessage();
	}
});
resizeComposerInput();

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
		const result = await api(`/api/sessions/${sessionId}/model`, {
			method: "POST",
			body: JSON.stringify({ provider, modelId }),
		});
		if (result?.thinkingLevel) thinkingSelectEl.value = result.thinkingLevel;
		syncThinkingOptions(result?.availableThinkingLevels);
	} catch (error) {
		showError(`切换模型失败：${error.message}`);
		const history = await api(`/api/sessions/${sessionId}/history`).catch(() => null);
		if (history?.model) syncModelSelect(history.model.provider, history.model.modelId);
		syncThinkingOptions(history?.availableThinkingLevels);
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
// 左栏：工具 / 技能目录
// ---------------------------------------------------------------------------

/** 折叠“对话”和“文件”面板。 */
document.querySelectorAll(".side-header").forEach((header) => {
	header.addEventListener("click", () => {
		const panel = $(header.dataset.panel);
		if (!panel) return;
		const collapsed = panel.classList.toggle("collapsed");
		header.querySelector(".chevron").textContent = collapsed ? "▸" : "▾";
	});
});

async function refreshCatalog() {
	catalogCache = await api("/api/catalog");
	renderCatalog();
	if (catalogCache.download?.running && !officeInstallTimer) {
		officeInstallTimer = setInterval(() => void pollOfficeCliInstall(), 700);
	}
	if (catalogCache.redteamDownload?.running && !redTeamInstallTimer) {
		redTeamInstallTimer = setInterval(() => void pollRedTeamInstall(), 1500);
	}
}

async function openCatalog(mode) {
	catalogMode = mode;
	catalogFilter = "全部";
	catalogViewEl.hidden = false;
	toolsNavBtnEl.classList.toggle("active", mode === "tools");
	skillsNavBtnEl.classList.toggle("active", mode === "skills");
	closeDrawer();
	if (!catalogCache) catalogContentEl.textContent = "加载中…";
	try {
		if (!catalogCache) await refreshCatalog();
		else renderCatalog();
	} catch (error) {
		catalogContentEl.textContent = `加载失败：${error.message}`;
	}
}

function closeCatalog() {
	catalogViewEl.hidden = true;
	toolsNavBtnEl.classList.remove("active");
	skillsNavBtnEl.classList.remove("active");
	closeDrawer();
	inputEl.focus();
}

function setCatalogMode(mode) {
	catalogMode = mode;
	catalogFilter = "全部";
	catalogSearchInputEl.value = "";
	toolsNavBtnEl.classList.toggle("active", mode === "tools");
	skillsNavBtnEl.classList.toggle("active", mode === "skills");
	closeDrawer();
	renderCatalog();
}

function renderCatalogFilters(filters) {
	catalogFiltersEl.innerHTML = "";
	for (const value of filters) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = `catalog-filter${catalogFilter === value ? " active" : ""}`;
		button.textContent = value;
		button.addEventListener("click", () => {
			catalogFilter = value;
			renderCatalog();
		});
		catalogFiltersEl.appendChild(button);
	}
}

function catalogMatches(item, query) {
	if (!query) return true;
	return [item.displayName, item.internalName, item.description, ...(item.formats || [])]
		.join(" ")
		.toLocaleLowerCase("zh-CN")
		.includes(query);
}

function createCatalogIcon(kind, icon) {
	const wrap = document.createElement("div");
	wrap.className = `catalog-card-icon ${String(kind || "").toLocaleLowerCase("en-US")}`;
	if (icon) {
		const image = document.createElement("img");
		image.src = icon;
		image.alt = "";
		wrap.appendChild(image);
	} else {
		wrap.textContent = kind === "PowerPoint" ? "P" : kind === "Excel" ? "X" : "W";
	}
	return wrap;
}

function createCard(item, options) {
	const card = document.createElement("article");
	card.className = "catalog-card";
	card.appendChild(createCatalogIcon(options.kind, options.icon));
	const main = document.createElement("div");
	main.className = "catalog-card-main";
	const titleRow = document.createElement("div");
	titleRow.className = "catalog-card-title-row";
	const title = document.createElement("span");
	title.className = "catalog-card-title";
	title.textContent = item.displayName;
	const code = document.createElement("span");
	code.className = "catalog-card-code";
	code.textContent = `（${item.internalName}）`;
	titleRow.append(title, code);
	const desc = document.createElement("div");
	desc.className = "catalog-card-desc";
	desc.textContent = item.description;
	main.append(titleRow, desc);
	const actions = document.createElement("div");
	actions.className = "catalog-card-actions";
	const status = document.createElement("span");
	status.className = `catalog-status${item.installed ? " installed" : options.installing ? " installing" : ""}`;
	status.textContent = item.installed ? "已安装" : options.installing ? "安装中" : "未安装";
	actions.appendChild(status);
	if (!item.installed) {
		const install = document.createElement("button");
		install.type = "button";
		install.className = "primary-btn small";
		install.dataset.installToolId = item.id;
		install.textContent = options.installText || "安装";
		install.disabled = options.installDisabled === true || options.installing === true;
		if (options.installing) install.title = options.installTitle || "正在安装，请稍候";
		else if (options.installDisabled) install.title = "请先安装所属工具";
		install.addEventListener("click", async (event) => {
			event.stopPropagation();
			await options.onInstall(install);
		});
		actions.appendChild(install);
	} else if (options.onUninstall) {
		const uninstall = document.createElement("button");
		uninstall.type = "button";
		uninstall.className = "secondary-btn small danger";
		uninstall.textContent = "卸载";
		uninstall.addEventListener("click", async (event) => {
			event.stopPropagation();
			await options.onUninstall(uninstall);
		});
		actions.appendChild(uninstall);
	}
	card.append(main, actions);
	card.addEventListener("click", options.onOpen);
	return card;
}

function installDispatcher(tool) {
	return tool.id === "redteam" ? installRedTeam : installOfficeCli;
}

async function uninstallTool(tool, button) {
	const extra =
		tool.id === "officecli"
			? "同时会删除客户端安装的 OfficeCLI 官方技能；已生成的文档不会删除。"
			: "已生成的红队配置和工作区报告不会删除。";
	if (!window.confirm(`卸载 ${tool.displayName}？\n\n${extra}`)) return;
	button.disabled = true;
	button.textContent = "卸载中…";
	try {
		await api(`/api/tools/${tool.id}`, { method: "DELETE" });
		closeDrawer();
		await refreshCatalog();
		await loadSessions();
		showInfo(`${tool.displayName} 已卸载`);
	} catch (error) {
		button.disabled = false;
		button.textContent = "卸载";
		showError(`${tool.displayName} 卸载失败：${error.message}`);
	}
}

function installDuration(elapsedMs) {
	const seconds = Math.max(0, Math.floor((elapsedMs || 0) / 1000));
	const minutes = Math.floor(seconds / 60);
	return minutes > 0 ? `${minutes}分${seconds % 60}秒` : `${seconds}秒`;
}

function installUi(tool) {
	const progress = tool.id === "redteam" ? catalogCache?.redteamDownload : catalogCache?.download;
	if (!progress?.running) return { installing: false, installText: "安装", installTitle: "" };
	if (tool.id === "redteam") {
		const elapsed = installDuration(progress.elapsedMs);
		return {
			installing: true,
			installText: `安装中 ${elapsed}`,
			installTitle: `${progress.log || "正在安装 promptfoo"}（已用时 ${elapsed}）`,
		};
	}
	const percent = progress.totalBytes
		? Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100))
		: null;
	return {
		installing: true,
		installText: percent === null ? "下载中…" : `下载中 ${percent}%`,
		installTitle: "正在下载并校验 OfficeCLI",
	};
}

function renderTools(query) {
	const tools = (catalogCache?.tools || []).filter((tool) => {
		if (catalogFilter === "已安装" && !tool.installed) return false;
		if (catalogFilter === "文档办公" && tool.category !== "文档办公") return false;
		if (catalogFilter === "安全测试" && tool.category !== "安全测试") return false;
		return catalogMatches(tool, query);
	});
	const grid = document.createElement("div");
	grid.className = "catalog-grid";
	for (const tool of tools) {
		const installState = installUi(tool);
		grid.appendChild(
			createCard(tool, {
				kind: "tool",
				icon: tool.icon,
				onOpen: () => openToolDetail(tool),
				onInstall: installDispatcher(tool),
				onUninstall: (button) => uninstallTool(tool, button),
				...installState,
			}),
		);
	}
	if (tools.length === 0) grid.innerHTML = '<div class="catalog-empty">没有符合条件的工具</div>';
	catalogContentEl.appendChild(grid);
}

function renderSkills(query) {
	for (const group of catalogCache?.skillGroups || []) {
		const skills = group.skills.filter((skill) => {
			if (catalogFilter === "已安装" && !skill.installed) return false;
			if (["Word", "PowerPoint", "Excel"].includes(catalogFilter) && skill.category !== catalogFilter) return false;
			return catalogMatches(skill, query);
		});
		if (skills.length === 0) continue;
		const section = document.createElement("section");
		section.className = "catalog-group";
		const header = document.createElement("div");
		header.className = "catalog-group-header";
		const image = document.createElement("img");
		image.src = group.icon;
		image.alt = "";
		const heading = document.createElement("div");
		const installedCount = group.skills.filter((skill) => skill.installed).length;
		heading.innerHTML = `<div class="catalog-group-title">${group.toolDisplayName}（${group.toolInternalName}）</div><div class="catalog-group-meta">${installedCount}/${group.skills.length} 个技能已安装</div>`;
		const spacer = document.createElement("div");
		spacer.className = "catalog-group-spacer";
		header.append(image, heading, spacer);
		if (group.toolInstalled && installedCount < group.skills.length) {
			const allButton = document.createElement("button");
			allButton.type = "button";
			allButton.className = "secondary-btn small";
			allButton.textContent = "安装全部官方技能";
			allButton.addEventListener("click", () => installAllOfficeCliSkills(allButton));
			header.appendChild(allButton);
		}
		const grid = document.createElement("div");
		grid.className = "catalog-grid";
		for (const skill of skills) {
			grid.appendChild(
				createCard(skill, {
					kind: skill.category,
					installDisabled: !group.toolInstalled,
					onOpen: () => openSkillDetail(skill, group),
					onInstall: (button) => installOfficeCliSkill(skill, button),
				}),
			);
		}
		section.append(header, grid);
		catalogContentEl.appendChild(section);
	}
	if (!catalogContentEl.children.length) catalogContentEl.innerHTML = '<div class="catalog-empty">没有符合条件的技能</div>';
}

function renderCatalog() {
	if (!catalogCache) return;
	const toolsMode = catalogMode === "tools";
	catalogTitleEl.textContent = toolsMode ? "工具" : "技能";
	catalogSubtitleEl.textContent = toolsMode
		? "按需安装本地能力，未命中任务时不会把工具定义放入模型上下文。"
		: "技能是写好的专业工作方法，按所属工具分类；完整说明只在任务匹配时读取。";
	catalogSearchInputEl.placeholder = toolsMode ? "搜索工具" : "搜索技能";
	catalogToolsTabEl.classList.toggle("active", toolsMode);
	catalogSkillsTabEl.classList.toggle("active", !toolsMode);
	renderCatalogFilters(toolsMode ? ["全部", "已安装", "文档办公", "安全测试"] : ["全部", "已安装", "Word", "PowerPoint", "Excel"]);
	catalogContentEl.innerHTML = "";
	const query = catalogSearchInputEl.value.trim().toLocaleLowerCase("zh-CN");
	if (toolsMode) renderTools(query);
	else renderSkills(query);
}

async function installOfficeCli(button) {
	button.disabled = true;
	button.textContent = "准备安装…";
	try {
		await api("/api/tools/officecli/install", { method: "POST", body: "{}" });
		showInfo("OfficeCLI 正在从官方来源下载并校验");
		clearInterval(officeInstallTimer);
		officeInstallTimer = setInterval(() => void pollOfficeCliInstall(), 700);
		await pollOfficeCliInstall();
	} catch (error) {
		button.disabled = false;
		button.textContent = "安装";
		showError(`OfficeCLI 安装失败：${error.message}`);
	}
}

async function pollOfficeCliInstall() {
	try {
		const progress = await api("/api/officecli/progress");
		if (catalogCache) catalogCache.download = progress;
		if (progress.running) {
			renderCatalog();
			return;
		}
		clearInterval(officeInstallTimer);
		officeInstallTimer = null;
		if (progress.error) {
			showError(`OfficeCLI 安装失败：${progress.error}`);
			await refreshCatalog();
			return;
		}
		closeDrawer();
		await refreshCatalog();
		showInfo(`OfficeCLI 已安装${progress.version ? `，版本 ${progress.version}` : ""}`);
	} catch (error) {
		clearInterval(officeInstallTimer);
		officeInstallTimer = null;
		showError(`读取 OfficeCLI 安装进度失败：${error.message}`);
	}
}

async function installRedTeam(button) {
	button.disabled = true;
	button.textContent = "准备安装…";
	try {
		await api("/api/tools/redteam/install", { method: "POST", body: "{}" });
		showInfo("红队引擎正在从 npm 官方源安装，首次安装通常需要几分钟");
		clearInterval(redTeamInstallTimer);
		redTeamInstallTimer = setInterval(() => void pollRedTeamInstall(), 1500);
		await pollRedTeamInstall();
	} catch (error) {
		button.disabled = false;
		button.textContent = "安装";
		showError(`promptfoo 安装失败：${error.message}`);
	}
}

async function pollRedTeamInstall() {
	try {
		const progress = await api("/api/tools/redteam/progress");
		if (catalogCache) catalogCache.redteamDownload = progress;
		if (progress.running) {
			renderCatalog();
			return;
		}
		clearInterval(redTeamInstallTimer);
		redTeamInstallTimer = null;
		if (progress.error) {
			showError(`红队引擎安装失败：${progress.error}`);
			await refreshCatalog();
			return;
		}
		closeDrawer();
		await refreshCatalog();
		showInfo(
			`红队引擎已安装${progress.version ? `，promptfoo ${progress.version}` : ""}（用时 ${installDuration(progress.elapsedMs)}）`,
		);
	} catch (error) {
		clearInterval(redTeamInstallTimer);
		redTeamInstallTimer = null;
		showError(`读取红队引擎安装进度失败：${error.message}`);
	}
}

async function installOfficeCliSkill(skill, button) {
	button.disabled = true;
	button.textContent = "安装中…";
	try {
		const result = await api(`/api/tools/officecli/skills/${skill.id}/install`, { method: "POST", body: "{}" });
		await refreshCatalog();
		const count = result.installed?.length || 0;
		showInfo(count > 1 ? `已安装 ${skill.displayName} 及其 ${count - 1} 个基础技能` : `已安装 ${skill.displayName}`);
	} catch (error) {
		button.disabled = false;
		button.textContent = "安装";
		showError(`技能安装失败：${error.message}`);
	}
}

async function installAllOfficeCliSkills(button) {
	button.disabled = true;
	button.textContent = "安装中…";
	try {
		await api("/api/tools/officecli/skills/install-all", { method: "POST", body: "{}" });
		await refreshCatalog();
		showInfo("OfficeCLI 的全部官方技能已安装");
	} catch (error) {
		button.disabled = false;
		button.textContent = "安装全部官方技能";
		showError(`技能安装失败：${error.message}`);
	}
}

function appendDrawerDetails(rows) {
	const list = document.createElement("dl");
	list.className = "drawer-detail-list";
	for (const [label, value] of rows) {
		const term = document.createElement("dt");
		term.textContent = label;
		const detail = document.createElement("dd");
		if (value instanceof Node) detail.appendChild(value);
		else detail.textContent = value || "—";
		list.append(term, detail);
	}
	drawerContentEl.appendChild(list);
}

function openToolDetail(tool) {
	drawerTitleEl.textContent = `${tool.displayName}（${tool.internalName}）`;
	drawerContentEl.innerHTML = "";
	const meta = document.createElement("div");
	meta.className = "drawer-meta";
	meta.textContent = `${tool.installed ? "已安装" : "未安装"}${tool.version ? ` · ${tool.version}` : ""} · ${tool.activation}`;
	const desc = document.createElement("div");
	desc.className = "drawer-desc";
	desc.textContent = tool.description;
	drawerContentEl.append(meta, desc);
	const source = document.createElement("a");
	source.className = "drawer-link";
	source.href = tool.sourceUrl;
	source.target = "_blank";
	source.rel = "noreferrer";
	source.textContent = tool.sourceName;
	appendDrawerDetails([
		[tool.category === "安全测试" ? "覆盖能力" : "文件类型", tool.formats.join("、")],
		["运行环境", tool.platform],
		["安装位置", tool.installPath],
		...(tool.skillCount > 0 ? [["技能", `${tool.installedSkillCount}/${tool.skillCount} 个已安装`]] : []),
		["来源", source],
	]);
	const toolsTitle = document.createElement("div");
	toolsTitle.className = "drawer-block-title";
	toolsTitle.textContent = `代码能力（${tool.capabilities.length}）`;
	const toolsWrap = document.createElement("div");
	toolsWrap.className = "context-tools";
	for (const capability of tool.capabilities) {
		const chip = document.createElement("span");
		chip.className = "tool-chip";
		chip.textContent = `${capability.displayName}（${capability.name}）`;
		toolsWrap.appendChild(chip);
	}
	drawerContentEl.append(toolsTitle, toolsWrap);
	if (!tool.installed) {
		const actions = document.createElement("div");
		actions.className = "drawer-actions";
		const install = document.createElement("button");
		install.className = "primary-btn";
		install.dataset.installToolId = tool.id;
		const installState = installUi(tool);
		install.textContent = installState.installing
			? installState.installText
			: tool.id === "redteam"
				? "安装红队引擎"
				: "安装 OfficeCLI";
		install.disabled = installState.installing;
		install.title = installState.installTitle;
		install.addEventListener("click", () => installDispatcher(tool)(install));
		actions.appendChild(install);
		drawerContentEl.appendChild(actions);
	} else {
		const actions = document.createElement("div");
		actions.className = "drawer-actions";
		const uninstall = document.createElement("button");
		uninstall.className = "secondary-btn danger";
		uninstall.textContent = "卸载工具";
		uninstall.addEventListener("click", () => uninstallTool(tool, uninstall));
		actions.appendChild(uninstall);
		drawerContentEl.appendChild(actions);
	}
	drawerEl.hidden = false;
}

function openSkillDetail(skill, group) {
	drawerTitleEl.textContent = `${skill.displayName}（${skill.internalName}）`;
	drawerContentEl.innerHTML = "";
	const meta = document.createElement("div");
	meta.className = "drawer-meta";
	meta.textContent = `${skill.installed ? "已安装" : "未安装"} · ${skill.category}`;
	const desc = document.createElement("div");
	desc.className = "drawer-desc";
	desc.textContent = skill.description;
	drawerContentEl.append(meta, desc);
	const skillNames = new Map(group.skills.map((item) => [item.id, `${item.displayName}（${item.internalName}）`]));
	appendDrawerDetails([
		["所属工具", `${group.toolDisplayName}（${group.toolInternalName}）`],
		["文件类型", skill.formats.join("、")],
		["基础技能", skill.requires.length ? skill.requires.map((id) => skillNames.get(id) || id).join("、") : "无"],
		["安装位置", skill.installPath],
		["来源", "OfficeCLI 二进制内置官方技能"],
	]);
	if (!skill.installed) {
		const actions = document.createElement("div");
		actions.className = "drawer-actions";
		const install = document.createElement("button");
		install.className = "primary-btn";
		install.textContent = group.toolInstalled ? "安装技能" : "请先安装 OfficeCLI";
		install.disabled = !group.toolInstalled;
		install.addEventListener("click", () => installOfficeCliSkill(skill, install));
		actions.appendChild(install);
		drawerContentEl.appendChild(actions);
	}
	drawerEl.hidden = false;
}

function closeDrawer() {
	drawerEl.hidden = true;
}

toolsNavBtnEl.addEventListener("click", () => openCatalog("tools"));
skillsNavBtnEl.addEventListener("click", () => openCatalog("skills"));
catalogCloseBtnEl.addEventListener("click", closeCatalog);
catalogToolsTabEl.addEventListener("click", () => setCatalogMode("tools"));
catalogSkillsTabEl.addEventListener("click", () => setCatalogMode("skills"));
catalogSearchInputEl.addEventListener("input", renderCatalog);
drawerCloseEl.addEventListener("click", closeDrawer);

// ---------------------------------------------------------------------------
// 输入区底行：已启用能力摘要
// ---------------------------------------------------------------------------

async function loadContextPanel() {
	try {
		if (!sessionId) {
			contextInfoEl.textContent = "";
			return;
		}
		const info = await api(`/api/sessions/${sessionId}/context`);
		renderSessionCapabilities(info.enabledCapabilities);
	} catch {
		/* 忽略 */
	}
}

function renderSessionCapabilities(capabilities) {
	const names = Array.isArray(capabilities) ? capabilities.map((item) => item.displayName) : [];
	contextInfoEl.textContent = names.length > 0 ? `${names.join("、")} · 按本轮加载` : "原生 Pi 工具";
}

// ---------------------------------------------------------------------------
// 左栏：本地资源管理器
// ---------------------------------------------------------------------------

let fsRoots = [];
let currentFsPath = null; // 内置 Windows 资源管理器当前浏览目录
let currentFsParent = null;

async function loadFsRoots(preferredPath = currentFsPath) {
	try {
		fsRoots = await api("/api/fs/roots");
		fsRootSelectEl.innerHTML = "";
		for (const root of fsRoots) {
			const option = document.createElement("option");
			option.value = root.path;
			option.textContent = root.name;
			option.title = root.path;
			fsRootSelectEl.appendChild(option);
		}
		const target = preferredPath || fsRoots.find((root) => root.kind === "workspace")?.path || fsRoots[0]?.path;
		if (target) await loadFsDir(target);
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
	await closeOfficePreview();
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

async function chooseDirectoryInto(input) {
	if (!window.piDesktop?.chooseDirectory) {
		input.focus();
		showInfo("当前为网页模式，请直接输入文件夹完整路径");
		return;
	}
	const path = await window.piDesktop.chooseDirectory();
	if (path) input.value = path;
}

workspaceBrowseBtnEl.addEventListener("click", () => void chooseDirectoryInto(workspaceInputEl));

async function loadStorageState() {
	try {
		const info = await api("/api/storage");
		storageCurrentEl.textContent = `当前：${info.path}`;
		storageCurrentEl.title = info.path;
		storageInputEl.placeholder = info.path;
	} catch (error) {
		storageCurrentEl.textContent = `读取失败：${error.message}`;
	}
}

storageBrowseBtnEl.addEventListener("click", () => void chooseDirectoryInto(storageInputEl));
storageMigrateBtnEl.addEventListener("click", async () => {
	const path = storageInputEl.value.trim();
	if (!path) {
		showError("请先选择新的 Agent 数据目录");
		return;
	}
	if (!window.confirm(`把全部 Agent 数据复制到：\n${path}\n\n迁移完成后客户端会重启，旧目录将保留作备份。`)) return;
	storageMigrateBtnEl.disabled = true;
	storageMigrateBtnEl.textContent = "正在迁移…";
	try {
		const result = await api("/api/storage/migrate", {
			method: "POST",
			body: JSON.stringify({ path }),
		});
		storageInputEl.value = "";
		storageCurrentEl.textContent = `新位置：${result.path}（已复制 ${result.copiedFiles} 个文件）`;
		if (result.restartRequired && window.piDesktop?.relaunch) {
			showInfo("Agent 数据迁移完成，正在重启客户端…");
			setTimeout(() => window.piDesktop.relaunch(), 500);
		} else if (result.restartRequired) {
			showInfo("Agent 数据迁移完成，请重新启动客户端后生效");
		} else {
			showInfo("当前已经是这个数据目录");
		}
	} catch (error) {
		showError(`迁移 Agent 数据失败：${error.message}`);
	} finally {
		storageMigrateBtnEl.disabled = false;
		storageMigrateBtnEl.textContent = "迁移并重启";
	}
});

async function loadFsDir(path) {
	try {
		const result = await api(`/api/fs/list?path=${encodeURIComponent(path)}`);
		currentFsPath = result.path;
		currentFsParent = result.parent;
		fsPathInputEl.value = result.path;
		fsUpBtnEl.disabled = !result.parent;
		fsLocationStateEl.textContent = result.isWorkspace
			? "当前位于 Agent 工作区 · 文件可拖入对话或拖到桌面"
			: "本地文件 · 文件可拖入对话或拖到桌面";
		fsLocationStateEl.classList.toggle("in-workspace", result.isWorkspace);
		const matchingRoot = fsRoots
			.filter((root) => result.path.toLocaleLowerCase().startsWith(root.path.toLocaleLowerCase()))
			.sort((a, b) => b.path.length - a.path.length)[0];
		if (matchingRoot) fsRootSelectEl.value = matchingRoot.path;
		fsTreeEl.innerHTML = "";
		if (result.entries.length === 0) {
			fsTreeEl.textContent = "（空目录）";
			return;
		}
		for (const entry of result.entries) {
			fsTreeEl.appendChild(createFsRow(result.path, entry));
		}
	} catch (error) {
		fsTreeEl.textContent = `加载失败：${error.message}`;
	}
}

function createFsRow(directory, entry) {
	const row = document.createElement("div");
	row.className = `fs-row${entry.isWorkspace ? " workspace-item" : ""}`;
	row.dataset.path = directory.replace(/[\\/]+$/, "") + "/" + entry.name;
	row.dataset.type = entry.type;
	row.dataset.name = entry.name;
	row.draggable = entry.type === "file";
	row.title = entry.type === "dir" ? "双击打开" : "双击预览；可拖入对话或拖到桌面";
	const icon = document.createElement("span");
	icon.className = "fs-icon";
	icon.textContent = entry.type === "dir" ? "📁" : "📄";
	const name = document.createElement("span");
	name.className = "fs-name";
	name.textContent = entry.name;
	row.append(icon, name);
	if (entry.type === "file" && entry.size !== null) {
		const size = document.createElement("span");
		size.className = "fs-size";
		size.textContent = formatSize(entry.size);
		row.appendChild(size);
	}
	row.addEventListener("click", () => {
		for (const selected of fsTreeEl.querySelectorAll(".fs-row.selected")) selected.classList.remove("selected");
		row.classList.add("selected");
	});
	row.addEventListener("dblclick", () => {
		if (entry.type === "dir") void loadFsDir(row.dataset.path);
		else void previewFsFile(row);
	});
	row.addEventListener("dragstart", (event) => startPathDrag(event, row.dataset.path));
	return row;
}

fsRootSelectEl.addEventListener("change", () => {
	if (fsRootSelectEl.value) loadFsDir(fsRootSelectEl.value);
});
fsRefreshBtnEl.addEventListener("click", () => {
	if (currentFsPath) void loadFsDir(currentFsPath);
});
fsUpBtnEl.addEventListener("click", () => {
	if (currentFsParent) void loadFsDir(currentFsParent);
});
fsPathGoBtnEl.addEventListener("click", () => {
	if (fsPathInputEl.value.trim()) void loadFsDir(fsPathInputEl.value.trim());
});
fsPathInputEl.addEventListener("keydown", (event) => {
	if (event.key === "Enter") {
		event.preventDefault();
		if (fsPathInputEl.value.trim()) void loadFsDir(fsPathInputEl.value.trim());
	}
});

async function copyDroppedFilesToCurrentDirectory(dataTransfer) {
	if (!currentFsPath) return;
	const source = dataTransfer.getData(LOCAL_FILE_DRAG_TYPE);
	try {
		if (source) {
			await api("/api/fs/copy", {
				method: "POST",
				body: JSON.stringify({ source, destination: currentFsPath }),
			});
		} else {
			for (const file of dataTransfer.files ?? []) {
				const localPath = window.piDesktop?.getFilePath?.(file) || "";
				if (localPath) {
					await api("/api/fs/copy", {
						method: "POST",
						body: JSON.stringify({ source: localPath, destination: currentFsPath }),
					});
				} else {
					await api("/api/fs/import", {
						method: "POST",
						body: JSON.stringify({
							name: file.name,
							dataBase64: await fileToBase64(file),
							destination: currentFsPath,
						}),
					});
				}
			}
		}
		await loadFsDir(currentFsPath);
		showInfo("文件已复制到当前文件夹（file_copy）");
	} catch (error) {
		showError(`复制文件失败：${error.message}`);
	}
}

fsTreeEl.addEventListener("dragover", (event) => {
	if (!event.dataTransfer) return;
	event.preventDefault();
	event.stopPropagation();
	event.dataTransfer.dropEffect = "copy";
	fsTreeEl.classList.add("drag-target");
});
fsTreeEl.addEventListener("dragleave", (event) => {
	if (!fsTreeEl.contains(event.relatedTarget)) fsTreeEl.classList.remove("drag-target");
});
fsTreeEl.addEventListener("drop", (event) => {
	event.preventDefault();
	event.stopPropagation();
	fsTreeEl.classList.remove("drag-target");
	dragDepth = 0;
	dropOverlayEl.hidden = true;
	if (event.dataTransfer) void copyDroppedFilesToCurrentDirectory(event.dataTransfer);
});

function releasePreviewObjectUrl() {
	if (!previewObjectUrl) return;
	URL.revokeObjectURL(previewObjectUrl);
	previewObjectUrl = null;
}

function base64ObjectUrl(base64, mimeType) {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

function closeFilePreview() {
	previewModalEl.hidden = true;
	previewFile = null;
	releasePreviewObjectUrl();
}

async function openFilePreview(path, name, source = "file") {
	try {
		if (isOfficeFilePath(path)) {
			await openOfficePreview(path, source);
			return;
		}
		const file = await api(`/api/fs/read?path=${encodeURIComponent(path)}`);
		previewFile = {
			name: name || path.split(/[\\/]/).pop() || "文件预览",
			mimeType: file.mimeType,
			dataBase64: file.dataBase64,
			size: file.size,
			isImage: IMAGE_MIME.has(file.mimeType),
		};
		previewTitleEl.textContent = previewFile.name;
		previewContentEl.innerHTML = "";
		releasePreviewObjectUrl();
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
		} else if (file.mimeType === "application/pdf") {
			previewObjectUrl = base64ObjectUrl(previewFile.dataBase64, previewFile.mimeType);
			const frame = document.createElement("iframe");
			frame.className = "preview-document";
			frame.src = previewObjectUrl;
			frame.title = `${previewFile.name} PDF 预览`;
			previewContentEl.appendChild(frame);
		} else {
			const empty = document.createElement("div");
			empty.className = "context-empty";
			empty.textContent = "该文件类型暂不支持内嵌渲染，可以下载文件或添加到对话交给智能体处理。";
			previewContentEl.appendChild(empty);
		}
		previewModalEl.hidden = false;
	} catch (error) {
		showError(`读取文件失败：${error.message}`);
	}
}

function previewFsFile(row) {
	return openFilePreview(row.dataset.path, row.dataset.name, "file");
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

previewCloseEl.addEventListener("click", closeFilePreview);
previewModalEl.addEventListener("click", (e) => {
	if (e.target === previewModalEl) closeFilePreview();
});
previewAttachBtnEl.addEventListener("click", () => {
	if (!previewFile) return;
	pendingAttachments.push({ ...previewFile });
	renderAttachments();
	closeFilePreview();
	showInfo("已添加到对话附件");
});

// ---------------------------------------------------------------------------
// 设置弹窗
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 主题切换（dark / light，localStorage 持久化）
// ---------------------------------------------------------------------------

function applyTheme(theme) {
	document.documentElement.dataset.theme = theme;
	themeBtnEl.textContent = theme === "dark" ? "🌙" : "☀️";
	themeBtnEl.title = theme === "dark" ? "切换到亮色主题" : "切换到暗色主题";
}

themeBtnEl.addEventListener("click", () => {
	const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
	localStorage.setItem("pi-console-theme", next);
	applyTheme(next);
});

applyTheme(localStorage.getItem("pi-console-theme") || "dark");

settingsBtnEl.addEventListener("click", () => {
	settingsModalEl.hidden = false;
	loadKeysSection();
	loadCodexOAuthSection();
	loadVersionSection();
	loadWorkspaceState();
	loadStorageState();
});
settingsCloseEl.addEventListener("click", () => {
	settingsModalEl.hidden = true;
});
settingsModalEl.addEventListener("click", (e) => {
	if (e.target === settingsModalEl) settingsModalEl.hidden = true;
});

function openExternalUrl(url) {
	if (!/^https:\/\//i.test(url || "")) return;
	if (window.piDesktop?.openExternal) window.piDesktop.openExternal(url);
	else window.open(url, "_blank", "noopener");
}

function renderCodexOAuthStatus(status) {
	const connected = status?.connected === true;
	const waiting = status?.phase === "waiting" || status?.phase === "starting";
	codexOAuthStatusEl.textContent = connected
		? "已登录"
		: status?.phase === "error"
			? `登录失败：${status.error || "未知错误"}`
			: waiting
				? status.message || "等待登录"
				: "未登录";
	codexOAuthLoginBtnEl.hidden = connected;
	codexOAuthLoginBtnEl.textContent = status?.verificationUrl ? "打开登录网页" : waiting ? "正在准备…" : "使用订阅登录";
	codexOAuthLoginBtnEl.disabled = status?.phase === "starting" && !status?.verificationUrl;
	codexOAuthLoginBtnEl.dataset.url = status?.verificationUrl || "";
	codexOAuthLogoutBtnEl.hidden = !connected;
	codexOAuthCodeEl.hidden = !status?.userCode;
	codexOAuthCodeEl.textContent = status?.userCode ? `设备码：${status.userCode}（点击复制）` : "";

	if (waiting) {
		if (!codexOAuthTimer) codexOAuthTimer = setInterval(() => void loadCodexOAuthSection(), 1200);
	} else if (codexOAuthTimer) {
		clearInterval(codexOAuthTimer);
		codexOAuthTimer = null;
	}
	if (connected) void loadModels();
}

async function loadCodexOAuthSection() {
	try {
		renderCodexOAuthStatus(await api("/api/oauth/openai-codex/status"));
	} catch (error) {
		codexOAuthStatusEl.textContent = `读取失败：${error.message}`;
	}
}

codexOAuthLoginBtnEl.addEventListener("click", async () => {
	const currentUrl = codexOAuthLoginBtnEl.dataset.url;
	if (currentUrl) {
		openExternalUrl(currentUrl);
		return;
	}
	codexOAuthLoginBtnEl.disabled = true;
	codexOAuthStatusEl.textContent = "正在申请设备码…";
	try {
		const status = await api("/api/oauth/openai-codex/start", { method: "POST", body: "{}" });
		renderCodexOAuthStatus(status);
		if (status.verificationUrl) openExternalUrl(status.verificationUrl);
	} catch (error) {
		showError(`Codex 订阅登录失败：${error.message}`);
		await loadCodexOAuthSection();
	} finally {
		if (!codexOAuthLoginBtnEl.hidden) codexOAuthLoginBtnEl.disabled = false;
	}
});

codexOAuthLogoutBtnEl.addEventListener("click", async () => {
	if (!window.confirm("退出 Codex 订阅登录？\n已保存的 openai-codex OAuth 凭据会从当前 Pi 客户端删除。")) return;
	codexOAuthLogoutBtnEl.disabled = true;
	try {
		renderCodexOAuthStatus(await api("/api/oauth/openai-codex", { method: "DELETE" }));
		await loadModels();
		showInfo("已退出 Codex 订阅登录（openai-codex-oauth）");
	} catch (error) {
		showError(`退出失败：${error.message}`);
	} finally {
		codexOAuthLogoutBtnEl.disabled = false;
	}
});

codexOAuthCodeEl.addEventListener("click", () => {
	const code = codexOAuthCodeEl.textContent.match(/设备码：([^（]+)/)?.[1]?.trim();
	if (!code) return;
	navigator.clipboard.writeText(code).then(() => showInfo("Codex 设备码已复制")).catch(() => showError("复制设备码失败"));
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
		githubTokenClearBtnEl.hidden = !tokenInfo.saved;
		if (tokenInfo.source === "gh-cli") {
			githubTokenInputEl.placeholder = "已使用本机 GitHub 登录";
		} else if (tokenInfo.source === "environment") {
			githubTokenInputEl.placeholder = "已使用系统中的 GitHub 登录";
		} else if (tokenInfo.source === "saved") {
			githubTokenInputEl.placeholder = "已保存 GitHub Token（输入可替换）";
		} else {
			githubTokenInputEl.placeholder = "GitHub Token（备用，可选）";
		}
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
		githubTokenInputEl.placeholder = "GitHub Token（备用，可选）";
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
			if (info.error === "authentication") {
				updateStatusEl.textContent = "GitHub 登录无效或没有此仓库的读取权限";
			} else if (info.error === "network") {
				updateStatusEl.textContent = "无法连接 GitHub；请确认系统代理正在运行后重试";
			} else {
				updateStatusEl.textContent = `GitHub 暂时无法完成更新检查${info.httpStatus ? `（HTTP ${info.httpStatus}）` : ""}`;
			}
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
		await Promise.all([refreshCatalog(), loadModels(), loadFsRoots(), loadContextPanel(), loadSessions()]);
		await ensureSession();
		connectSSE();
		inputEl.disabled = false;
		sendBtn.disabled = false;
		modelSelectEl.disabled = false;
		thinkingSelectEl.disabled = false;
		pollContext();
		inputEl.focus();
	} catch (error) {
		showError(`初始化失败：${error.message}`);
		connStateEl.textContent = "未连接";
		connStateEl.classList.add("disconnected");
	}
})();
