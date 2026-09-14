import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const tree = ts.createSourceFile("app.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declaration = name => tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === name).getText(tree);
const listener = name => tree.statements.find(node => node.getText(tree).startsWith(`${name}.addEventListener("click"`)).getText(tree);
function queueFixture() {
	const values = new Map();
	const app = createContext({ sessionId: "A", pendingSteerSubmissions: new Set(), removingQueuedMessage: false, deletedSessions: new Set(),
		inputEl: { value: "existing draft", focus() {} }, pendingAttachments: [], draftAttachments: new Map(),
		localStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
		resizeComposerInput() {}, renderAttachments() {}, renderSteerQueue: vi.fn(), showError: vi.fn(),
		api: vi.fn(async () => ({ text: "recalled", images: [{ mimeType: "image/png", data: "YWJj" }], queue: { sessionId: "A", steering: ["keep"] } })),
	});
	runInContext(["saveComposerDraft", "insertComposerText", "sendSteerMessage", "removeQueuedMessage"].map(declaration).join("\n"), app);
	return { app, values };
}
describe("history and queue interaction regressions", () => {
	it("keeps a long conversation expanded after clicking, new messages and switching away and back", () => {
		let click;
		const rows = Array.from({ length: 100 }, () => ({ classList: { toggle: vi.fn() } }));
		const app = createContext({ sessionId: "A", renderingHistory: false, collapsed: false, collapsedByAuto: false, AUTO_FOLD_THRESHOLD: 30,
			historyCollapseChoices: new Map(), messagesEl: { querySelectorAll: () => rows, scrollHeight: 500 }, messagesToolbarEl: {}, collapseHintEl: {},
			collapseBtnEl: { addEventListener: (_type, fn) => { click = fn; } },
		});
		runInContext(declaration("applyCollapse") + "\n" + listener("collapseBtnEl"), app);
		app.applyCollapse(); expect(app.collapsed).toBe(true);
		click(); expect(app.collapsed).toBe(false);
		rows.push({ classList: { toggle: vi.fn() } }); app.applyCollapse(); expect(app.collapsed).toBe(false);
		app.sessionId = "B"; app.applyCollapse(); expect(app.collapsed).toBe(true);
		app.sessionId = "A"; app.applyCollapse(); expect(app.collapsed).toBe(false);
	});
	it("appends recalled text and images without replacing a draft", async () => {
		const { app, values } = queueFixture();
		app.pendingAttachments.push({ name: "existing.png" });
		await app.removeQueuedMessage({ sessionId: "A", revision: "r1" }, "steer", 1, true);
		expect(app.inputEl.value).toBe("existing draft\n\nrecalled");
		expect(app.pendingAttachments).toHaveLength(2);
		expect(values.get("pi-console-draft:A")).toBe(app.inputEl.value);
		expect(JSON.parse(app.api.mock.calls[0][1].body)).toEqual({ revision: "r1", kind: "steer", index: 1 });
	});
	it("returns a delayed recall to its original session and leaves the newly opened draft untouched", async () => {
		const { app, values } = queueFixture();
		let finish;
		app.api = () => new Promise(resolve => { finish = resolve; });
		const removing = app.removeQueuedMessage({ sessionId: "A", revision: "r1" }, "steer", 0, true);
		app.sessionId = "B"; app.inputEl.value = "B draft"; values.set("pi-console-draft:A", "A draft");
		finish({ text: "recalled", images: [], queue: {} }); await removing;
		expect(app.inputEl.value).toBe("B draft");
		expect(values.get("pi-console-draft:A")).toBe("A draft\n\nrecalled");
		expect(app.renderSteerQueue).not.toHaveBeenCalled();
	});
	it("does not clear later typing or duplicate a submission while its response is pending", async () => {
		const { app } = queueFixture();
		let finish;
		app.api = vi.fn(() => new Promise(resolve => { finish = resolve; }));
		const sending = app.sendSteerMessage("existing draft");
		await app.sendSteerMessage("existing draft");
		app.inputEl.value = "next thought";
		finish({ queue: {} }); await sending;
		expect(app.inputEl.value).toBe("next thought");
		expect(app.api).toHaveBeenCalledOnce();
	});
});
