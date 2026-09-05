// Kept separate from the chat UI so login never changes the active model or conversation.
export function setupAntigravityLogin({ document, api, loadModels, openExternalUrl }) {
	const get = (id) => document.getElementById(`antigravity-${id}`);
	const status = get("status");
	const login = get("login");
	const logout = get("logout");
	const cancel = get("cancel");
	const reopen = get("open");
	const form = get("callback-form");
	const input = get("callback");
	const submit = get("submit");
	const modelRefresh = get("refresh-models");
	const modelStatus = get("model-status");
	const base = "/api/oauth/antigravity";
	let state = { phase: "idle", connected: false, available: true };
	let busy = false;
	let disposed = false;
	let generation = 0;
	let catalogGeneration = 0;
	let catalogBusy = false;
	let timer;

	function schedule() {
		clearTimeout(timer);
		if (!disposed && !busy && ["starting", "waiting"].includes(state.phase)) {
			timer = setTimeout(refresh, 1200);
		}
	}

	function render(next) {
		const changed = state.connected !== next.connected;
		if (state.promptId !== next.promptId || next.connected) input.value = "";
		state = next;
		if (changed && !state.connected) {
			++catalogGeneration;
			catalogBusy = false;
			modelStatus.textContent = "";
		}
		const pending = ["starting", "waiting"].includes(state.phase);
		status.textContent = state.error || state.message || (state.connected ? "已连接" : "未登录");
		login.hidden = state.connected || pending;
		login.disabled = busy || pending || !state.available;
		logout.hidden = !state.connected;
		logout.disabled = busy;
		cancel.hidden = !pending;
		cancel.disabled = busy;
		reopen.hidden = !pending || !state.verificationUrl;
		reopen.disabled = busy;
		form.hidden = !pending || !state.promptId;
		submit.disabled = busy;
		modelRefresh.hidden = !state.connected;
		modelRefresh.disabled = busy || catalogBusy;
		modelStatus.hidden = !state.connected;
		if (changed) {
			if (state.connected) void refreshModels();
			else void loadModels().catch(() => { status.textContent += "；模型列表刷新失败，请重新打开设置"; });
		}
		schedule();
	}

	async function refreshModels() {
		if (catalogBusy || disposed || !state.connected) return;
		const request = ++catalogGeneration;
		catalogBusy = true;
		modelStatus.textContent = "正在向 Google 刷新模型目录…";
		render(state);
		try {
			const result = await api(`${base}/models/refresh`, { method: "POST" });
			if (request !== catalogGeneration || disposed) return;
			await loadModels();
			if (request !== catalogGeneration || disposed) return;
			// The adapter retains cached models when discovery is unavailable.
			modelStatus.textContent = `当前目录有 ${result.count} 个 Antigravity 模型；若仍有缺失，请检查网络后重试。`;
		} catch {
			if (request === catalogGeneration && !disposed) {
				modelStatus.textContent = "模型目录刷新未完成，请检查网络后点击「刷新模型」重试；已有模型仍可使用。";
				await loadModels().catch(() => {});
			}
		} finally {
			if (request === catalogGeneration && !disposed) {
				catalogBusy = false;
				render(state);
			}
		}
	}

	async function refresh() {
		if (busy || disposed) return;
		const request = ++generation;
		try {
			const next = await api(`${base}/status`);
			if (request === generation && !disposed) render(next);
		} catch {
			if (request === generation && !disposed) {
				status.textContent = "暂时无法读取 Google 登录状态，请重新打开设置";
				schedule();
			}
		}
	}

	async function openLoginPage() {
		if (!state.verificationUrl) return;
		try { await openExternalUrl(state.verificationUrl); }
		catch { return "浏览器未能打开，请点击「打开登录网页」重试"; }
	}

	async function action(path, method, body, open = false) {
		if (busy || disposed) return;
		busy = true;
		++generation;
		render(state);
		let error;
		try {
			const next = await api(`${base}${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
			if (disposed) return;
			render(next);
			if (open) error = await openLoginPage();
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "Google 登录操作失败，请重试";
		} finally {
			busy = false;
			if (!disposed) {
				render(state);
				if (error) status.textContent = error;
			}
		}
	}

	login.addEventListener("click", () => void action("/start", "POST", undefined, true));
	logout.addEventListener("click", () => void action("", "DELETE"));
	cancel.addEventListener("click", () => void action("/cancel", "POST"));
	modelRefresh.addEventListener("click", () => void refreshModels());
	reopen.addEventListener("click", async () => {
		const error = await openLoginPage();
		if (error) status.textContent = error;
	});
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const value = input.value.trim();
		if (!value) return;
		input.value = "";
		void action("/response", "POST", { promptId: state.promptId, value });
	});
	const observer = new MutationObserver(() => {
		if (!document.getElementById("settings-modal").hidden) void refresh();
	});
	observer.observe(document.getElementById("settings-modal"), { attributes: true, attributeFilter: ["hidden"] });
	void refresh();
	return () => { disposed = true; ++generation; ++catalogGeneration; clearTimeout(timer); observer.disconnect(); input.value = ""; };
}

if (typeof window !== "undefined" && document.getElementById("antigravity-login")) {
	const dispose = setupAntigravityLogin({ document, api: window.api, loadModels: window.loadModels, openExternalUrl: window.openExternalUrl });
	window.addEventListener("pagehide", dispose, { once: true });
}
