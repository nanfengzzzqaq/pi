/* Session organization is server-backed, so categories survive reloads and data migration. */
window.createSessionLibrary = ({ listEl, api, currentId, open, remove, menu, error }) => {
	let sessions = [], library = { categories: [], placements: {} }, filter = "all", selecting = false, busy = false;
	let signature = "";
	let revision = 0;
	const selected = new Set();
	const controls = document.createElement("div");
	controls.className = "session-library-controls";
	controls.innerHTML = `<div class="session-filter-row"><select aria-label="对话分类" class="session-filter"></select><button type="button" class="composer-mini-btn session-select-toggle">多选</button></div>
		<input class="session-filter-input" type="search" aria-label="筛选对话标题" placeholder="筛选对话…">
		<details class="session-category-editor"><summary>管理分类</summary><div><button type="button" data-category-action="create">新建分类</button><button type="button" data-category-action="rename">重命名</button><button type="button" data-category-action="remove">移除分类</button></div></details>
		<div class="session-batch" hidden><div class="session-batch-head"><label><input type="checkbox" class="session-select-all"> 全选当前列表</label><span class="session-selected-count" role="status"></span></div><select class="session-move" aria-label="移动所选对话到分类"></select><div class="session-batch-actions"><button type="button" data-batch="archive">归档</button><button type="button" data-batch="restore">恢复</button><button type="button" data-batch="delete" class="danger">删除</button></div></div>`;
	listEl.before(controls);
	const filterEl = controls.querySelector(".session-filter"), search = controls.querySelector(".session-filter-input");
	const toggle = controls.querySelector(".session-select-toggle"), batch = controls.querySelector(".session-batch");
	const all = controls.querySelector(".session-select-all"), move = controls.querySelector(".session-move");
	const placement = (id) => library.placements[id] || {};
	function visible() {
		const query = search.value.trim().toLocaleLowerCase();
		return sessions.filter(s => {
			const p = placement(s.id);
			return (filter === "archived" ? p.archived : !p.archived && (filter === "all" || (filter === "uncategorized" ? !p.categoryId : p.categoryId === filter))) && (!query || s.title.toLocaleLowerCase().includes(query));
		});
	}
	function updateSelection() {
		for (const check of listEl.querySelectorAll('input[type="checkbox"]')) check.disabled = busy;
		batch.hidden = !selecting;
		toggle.textContent = selecting ? "完成" : "多选";
		toggle.setAttribute("aria-pressed", String(selecting));
		controls.querySelector(".session-selected-count").textContent = `已选 ${selected.size}`;
		const shown = visible();
		all.checked = shown.length > 0 && shown.every(s => selected.has(s.id));
		all.indeterminate = shown.some(s => selected.has(s.id)) && !all.checked;
		for (const el of batch.querySelectorAll("button, select")) el.disabled = busy || selected.size === 0;
		all.disabled = busy || shown.length === 0;
		controls.querySelector('[data-batch="archive"]').hidden = filter === "archived";
		controls.querySelector('[data-batch="restore"]').hidden = filter !== "archived";
	}
	function render() {
		const shown = visible();
		listEl.replaceChildren();
		if (!shown.length) {
			const empty = document.createElement("div"); empty.className = "skills-empty";
			empty.textContent = search.value ? "没有匹配的对话" : filter === "archived" ? "暂无归档对话" : "此分类暂无对话";
			listEl.append(empty);
		}
		for (const s of shown) {
			const row = document.createElement("div");
			row.className = `session-row${s.id === currentId() ? " active" : ""}${s.streaming ? " running" : ""}${selected.has(s.id) ? " selected" : ""}`;
			row.dataset.sid = s.id;
			if (selecting) {
				const check = document.createElement("input"); check.type = "checkbox"; check.checked = selected.has(s.id); check.disabled = busy;
				check.setAttribute("aria-label", `选择 ${s.title}`);
				check.addEventListener("change", () => { if (check.checked) selected.add(s.id); else selected.delete(s.id); row.classList.toggle("selected", check.checked); updateSelection(); });
				row.append(check);
			}
			const link = document.createElement("button"); link.type = "button"; link.className = "session-open";
			if (s.id === currentId()) link.setAttribute("aria-current", "page");
			const title = document.createElement("span"); title.className = "session-title"; title.textContent = s.title; title.title = s.title;
			const meta = document.createElement("span"); meta.className = "session-meta";
			const category = library.categories.find(c => c.id === placement(s.id).categoryId)?.name;
			meta.textContent = [s.streaming ? "运行中" : new Date(s.updatedAt).toLocaleDateString("zh-CN"), category].filter(Boolean).join(" · ");
			link.append(title, meta); link.addEventListener("click", () => { if (!selecting) void open(s.id); else row.querySelector('input[type="checkbox"]')?.click(); });
			const more = document.createElement("button"); more.type = "button"; more.className = "session-menu-button"; more.textContent = "⋯"; more.hidden = selecting;
			more.setAttribute("aria-label", `${s.title} 的更多操作`);
			more.addEventListener("click", e => { e.stopPropagation(); const bounds = more.getBoundingClientRect(); menu(bounds.left, bounds.bottom, s.id, s.title); });
			row.addEventListener("contextmenu", e => { e.preventDefault(); e.stopPropagation(); menu(e.clientX, e.clientY, s.id, s.title); });
			row.append(link, more); listEl.append(row);
		}
		updateSelection();
	}
	function options() {
		const active = sessions.filter(s => !placement(s.id).archived);
		const entries = [["all", `全部对话 · ${active.length}`], ["uncategorized", `未分类 · ${active.filter(s => !placement(s.id).categoryId).length}`], ...library.categories.map(c => [c.id, `${c.name} · ${active.filter(s => placement(s.id).categoryId === c.id).length}`]), ["archived", `已归档 · ${sessions.length - active.length}`]];
		filterEl.replaceChildren(...entries.map(([id, name]) => new Option(name, id)));
		if (!entries.some(([id]) => id === filter)) filter = "all";
		filterEl.value = filter;
		move.replaceChildren(new Option("移动到分类…", ""), new Option("未分类", "uncategorized"), ...library.categories.map(c => new Option(c.name, c.id)));
		for (const el of controls.querySelectorAll('[data-category-action="rename"], [data-category-action="remove"]')) el.disabled = !library.categories.some(c => c.id === filter) || busy;
	}
	async function mutate(body) {
		if (busy) return;
		revision++;
		busy = true; updateSelection();
		try { library = await api("/api/session-library", { method: "POST", body: JSON.stringify(body) }); signature = ""; selected.clear(); options(); render(); }
		catch (e) { error(e.message); }
		finally { busy = false; options(); updateSelection(); }
	}
	filterEl.addEventListener("change", () => { filter = filterEl.value; selected.clear(); options(); render(); });
	search.addEventListener("input", () => { selected.clear(); render(); });
	toggle.addEventListener("click", () => { if (busy) return; selecting = !selecting; selected.clear(); render(); });
	all.addEventListener("change", () => { for (const s of visible()) { if (all.checked) selected.add(s.id); else selected.delete(s.id); } render(); });
	move.addEventListener("change", () => { if (move.value) void mutate({ action: "move", ids: [...selected], categoryId: move.value === "uncategorized" ? null : move.value }); });
	controls.addEventListener("click", async e => {
		const action = e.target.closest("[data-category-action]")?.dataset.categoryAction;
		if (action && !busy) {
			const category = library.categories.find(c => c.id === filter);
			if (action === "remove") { if (window.confirm(`移除分类“${category?.name}”？其中对话会回到未分类。`)) await mutate({ action, id: filter }); }
			else { const name = window.prompt(action === "create" ? "新分类名称：" : "分类名称：", category && action === "rename" ? category.name : ""); if (name !== null) await mutate({ action, id: filter, name }); }
		}
		const operation = e.target.closest("[data-batch]")?.dataset.batch;
		if (!operation || busy || !selected.size) return;
		if (operation !== "delete") { await mutate({ action: "archive", ids: [...selected], archived: operation === "archive" }); return; }
		busy = true; updateSelection();
		revision++;
		try {
			const removed = await remove([...selected]);
			for (const id of removed) selected.delete(id);
			sessions = sessions.filter(s => !removed.includes(s.id));
			signature = "";
		}
		finally { busy = false; render(); }
	});
	return {
		async refresh() {
			const requestRevision = revision;
			const [list, state] = await Promise.all([api("/api/sessions"), api("/api/session-library")]);
			const next = JSON.stringify([list, state, currentId()]);
			if (signature === next || busy || requestRevision !== revision) return;
			signature = next; sessions = list; library = state;
			for (const id of selected) if (!sessions.some(s => s.id === id)) selected.delete(id);
			options(); render();
		},
		reveal(id) { const p = placement(id); if (!visible().some(s => s.id === id)) { filter = p.archived ? "archived" : p.categoryId || "all"; search.value = ""; selected.clear(); options(); render(); } },
		async placeNew(id) { if (library.categories.some(c => c.id === filter)) await mutate({ action: "move", ids: [id], categoryId: filter }); else if (filter === "archived") { filter = "all"; options(); render(); } },
		organize(id) { selecting = true; selected.clear(); selected.add(id); this.reveal(id); selected.add(id); render(); },
		archive(id) { return mutate({ action: "archive", ids: [id], archived: !placement(id).archived }); },
		isArchived(id) { return Boolean(placement(id).archived); },
	};
};
