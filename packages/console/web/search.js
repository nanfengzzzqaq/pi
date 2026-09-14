// Uses the existing authenticated API, file previews and session navigation.
(() => {
	const dialog = document.createElement("dialog");
	dialog.id = "global-search-dialog";
	dialog.className = "global-search-dialog";
	dialog.setAttribute("aria-labelledby", "global-search-title");
	dialog.innerHTML = `<header class="global-search-header"><strong id="global-search-title">搜索</strong><button type="button" class="icon-btn" data-close aria-label="关闭搜索">×</button></header>
		<div class="global-search-form"><input id="global-search-input" type="search" aria-label="搜索内容" placeholder="查找对话原文、文件名或项目路径" maxlength="256" autocomplete="off"><select aria-label="搜索范围"><option value="all">全部</option><option value="session">当前对话</option></select></div>
		<p class="global-search-status" role="status" aria-live="polite"></p><div class="global-search-results"></div>`;
	document.body.appendChild(dialog);
	const queryInput = dialog.querySelector("input");
	const scopeSelect = dialog.querySelector("select");
	const resultsEl = dialog.querySelector(".global-search-results");
	const statusEl = dialog.querySelector(".global-search-status");
	let generation = 0;
	let timer;
	let controller;
	let selected = -1;
	let query = "";

	function cancelRequest() {
		generation++;
		clearTimeout(timer);
		controller?.abort();
	}
	function openSearch(scope = "all") {
		scopeSelect.value = scope;
		if (!dialog.open) dialog.showModal();
		syncBrowserNativeVisibility();
		queryInput.focus();
		queryInput.select();
		void search();
	}
	document.getElementById("global-search-open").addEventListener("click", () => openSearch());
	const currentButton = document.createElement("button");
	currentButton.type = "button";
	currentButton.className = "collapse-btn";
	currentButton.textContent = "查找本对话";
	currentButton.addEventListener("click", () => openSearch("session"));
	messagesToolbarEl.appendChild(currentButton);
	dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());
	dialog.addEventListener("close", () => { cancelRequest(); syncBrowserNativeVisibility(); });
	queryInput.addEventListener("input", () => {
		cancelRequest();
		resultsEl.replaceChildren();
		statusEl.textContent = queryInput.value.trim() ? "等待输入完成…" : "搜索历史对话原文、当前项目中的文件名，以及最近使用的项目。";
		timer = setTimeout(search, 250);
	});
	scopeSelect.addEventListener("change", () => void search());
	queryInput.addEventListener("keydown", (event) => {
		if (event.isComposing) return;
		const buttons = [...resultsEl.querySelectorAll(".global-search-result")];
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			if (!buttons.length) return;
			selected = Math.max(0, Math.min(buttons.length - 1, selected + (event.key === "ArrowDown" ? 1 : -1)));
			buttons.forEach((button, i) => button.classList.toggle("selected", i === selected));
			buttons[selected].scrollIntoView({ block: "nearest" });
		} else if (event.key === "Enter") {
			event.preventDefault();
			buttons[Math.max(0, selected)]?.click();
		}
	});

	function highlighted(text) {
		const fragment = document.createDocumentFragment();
		const needle = query.toLocaleLowerCase("zh-CN");
		const lower = text.toLocaleLowerCase("zh-CN");
		let start = 0;
		let position = needle ? lower.indexOf(needle) : -1;
		let marks = 0;
		while (position >= 0 && marks++ < 200) {
			fragment.append(document.createTextNode(text.slice(start, position)));
			const mark = document.createElement("mark");
			mark.textContent = text.slice(position, position + query.length);
			fragment.append(mark);
			start = position + query.length;
			position = lower.indexOf(needle, start);
		}
		fragment.append(document.createTextNode(text.slice(start)));
		return fragment;
	}
	function addResult(title, detail, action) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "global-search-result";
		const label = document.createElement("strong");
		label.append(highlighted(title));
		const description = document.createElement("span");
		description.append(highlighted(detail));
		button.append(label, description);
		button.addEventListener("click", () => {
			button.disabled = true;
			Promise.resolve().then(action).catch((error) => { if (error.name !== "AbortError") statusEl.textContent = error.message; }).finally(() => { button.disabled = false; });
		});
		resultsEl.appendChild(button);
	}
	function addHeading(title) {
		const heading = document.createElement("h3");
		heading.textContent = title;
		resultsEl.appendChild(heading);
	}
	async function showMessage(hit) {
		cancelRequest();
		const request = generation;
		controller = new AbortController();
		statusEl.textContent = "正在定位历史消息…";
		const data = await api(`/api/search/message?sessionId=${encodeURIComponent(hit.sessionId)}&entryId=${encodeURIComponent(hit.entryId)}&q=${encodeURIComponent(query)}`, { signal: controller.signal });
		if (request !== generation || !dialog.open) return;
		await switchSession(hit.sessionId);
		if (request !== generation || !dialog.open || sessionId !== hit.sessionId) return;
		resultsEl.replaceChildren();
		statusEl.textContent = `已定位 · ${data.title} · ${data.message.role === "user" ? "你" : "Pi"} · ${new Date(data.message.timestamp).toLocaleString()}`;
		const actions = document.createElement("div");
		actions.className = "global-search-history-actions";
		for (const [label, entryId] of [["上一条", data.previous], ["下一条", data.next]]) {
			const button = document.createElement("button");
			button.type = "button";
			button.className = "secondary-btn small";
			button.textContent = label;
			button.disabled = !entryId;
			button.addEventListener("click", () => void showMessage({ sessionId: hit.sessionId, entryId }).catch((error) => { if (error.name !== "AbortError") statusEl.textContent = error.message; }));
			actions.appendChild(button);
		}
		const back = document.createElement("button");
		back.type = "button";
		back.className = "secondary-btn small";
		back.textContent = "返回结果";
		back.addEventListener("click", () => void search());
		actions.appendChild(back);
		const text = document.createElement("div");
		text.className = "global-search-original";
		text.append(highlighted(data.message.text));
		const note = document.createElement("p");
		note.className = "global-search-note";
		note.textContent = `历史原文只读，查看不会改变当前上下文。${data.message.truncated ? "内容较长，仅展示命中位置附近的部分原文。" : ""}`;
		resultsEl.append(actions, text, note);
		text.querySelector("mark")?.scrollIntoView({ block: "center" });
	}
	async function search() {
		cancelRequest();
		const request = generation;
		query = queryInput.value.trim();
		resultsEl.replaceChildren();
		selected = -1;
		if (!query) {
			statusEl.textContent = "搜索历史对话原文、当前项目中的文件名，以及最近使用的项目。";
			return;
		}
		controller = new AbortController();
		statusEl.textContent = "搜索中…";
		try {
			const data = await api(`/api/search?q=${encodeURIComponent(query)}&scope=${scopeSelect.value}&sessionId=${encodeURIComponent(sessionId || "")}`, { signal: controller.signal });
			if (request !== generation || !dialog.open) return;
			const conversations = data.conversations.results;
			const files = data.files.results;
			if (conversations.length) {
				addHeading("历史对话");
				for (const hit of conversations) addResult(`${hit.title} · ${hit.role === "user" ? "你" : "Pi"}`, hit.text, () => showMessage(hit));
			}
			if (files.length) {
				addHeading("当前项目文件");
				for (const file of files) addResult(file.name, file.path, async () => { dialog.close(); await openFilePreview(file.path, file.name, "file"); });
			}
			if (data.projects.length) {
				addHeading("最近项目 · 浏览文件");
				for (const path of data.projects) addResult(path, "打开项目目录", async () => {
					dialog.close();
					filesPanelEl.hidden = false;
					await loadFsDir(path);
				});
			}
			const count = conversations.length + files.length + data.projects.length;
			statusEl.textContent = `${count ? `找到 ${count} 项` : "没有找到匹配项"}${data.conversations.truncated || data.files.truncated ? " · 已达本次搜索上限，请缩小关键词或选择当前对话" : ""}${data.conversations.skipped ? ` · ${data.conversations.skipped} 个会话文件未能读取或超过大小上限` : ""}${data.files.unavailable ? " · 当前项目文件暂不可搜索" : ""}`;
		} catch (error) {
			if (request === generation && error.name !== "AbortError") statusEl.textContent = `搜索失败：${error.message}`;
		}
	}
})();
