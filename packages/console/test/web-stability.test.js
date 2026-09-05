import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const tree = ts.createSourceFile("app.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function declaration(name) {
  return tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === name).getText(tree);
}
function editorFixture() {
  const element = () => ({ hidden: true, textContent: "", innerHTML: "", classList: { toggle() {}, remove() {} } });
  const context = createContext({
    codeEditor: null, codeEditorFile: null, codeEditorDirty: false, codeEditorPreviewing: false, codeEditorOpenRequest: 0,
    catalogCache: { tools: [{ id: "code-development", installed: true }] },
    window: { confirm: () => true }, localStorage: { getItem: () => null }, document: { documentElement: { dataset: {} } },
    CODE_EDITOR_WIDTH_KEY: "fixture", currentFsPath: null, showInfo: vi.fn(), showError: vi.fn(),
    closeOfficePreview: vi.fn(), closeCatalog: vi.fn(), suspendSidePanel: vi.fn(), restoreSidePanel: vi.fn(),
    applyCodeEditorWidth: vi.fn(), setCodeEditorFocus: vi.fn(), codeLanguage: () => "text",
    codeEditorPaneEl: element(), codeEditorResizerEl: element(), codeEditorTitleEl: element(), codeEditorStatusEl: element(),
    codeEditorPathEl: element(), codeEditorStageEl: element(), codeEditorMarkdownPreviewEl: element(), codeEditorPreviewEl: element(),
    codeEditorSaveEl: element(), officePreviewPaneEl: element(), catalogViewEl: element(),
    api: async path => ({ text: path, sha256: "initial", encoding: "utf-8" }),
    ensureMonaco: async () => ({
      Uri: { file: path => path }, KeyMod: { CtrlCmd: 1 }, KeyCode: { KeyS: 2 },
      editor: {
        createModel(text) { return { text, dispose() {}, onDidChangeContent(fn) { this.change = fn; }, setValue(value) { this.text = value; this.change(); } }; },
        create(element, { model }) { return { getModel: () => model, getValue: () => model.text, dispose() {}, addCommand() {}, focus() {} }; },
      },
    }),
  });
  runInContext(["setCodeEditorDirty", "openCodeEditor", "saveCodeEditor", "closeCodeEditor"].map(declaration).join("\n"), context);
  return context;
}

afterEach(() => vi.useRealTimers());
describe("Console interaction regressions", () => {
  it("does not activate an older session switch after a newer one finishes", async () => {
    let finishFirstClose;
    let closes = 0;
    const app = createContext({
      sessionId: "initial", sessionNavigation: 0, historyRequest: 0, historyDisplayLimit: 100, lastStreamEpoch: null,
      saveComposerDraft() {}, restoreComposerDraft() {}, disconnectSSE() {}, connectSSE() {}, clearMessages() {},
      setRunning() {}, localStorage: { setItem() {} }, SESSION_KEY: "fixture", lastSeq: -1,
      closeOfficePreview: () => ++closes === 1 ? new Promise(resolve => { finishFirstClose = resolve; }) : Promise.resolve(),
      ensureSession: async () => {}, loadSessions: async () => {}, pollContext: async () => {}, showError: vi.fn(),
    });
    runInContext(declaration("switchSession"), app);
    const first = app.switchSession("first");
    await app.switchSession("second");
    finishFirstClose();
    await first;
    expect(app.sessionId).toBe("second");
    expect(app.showError).not.toHaveBeenCalled();
  });
  it("keeps new edits dirty when an earlier save completes", async () => {
    const app = editorFixture();
    await app.openCodeEditor("A.txt", "A.txt");
    app.codeEditor.getModel().setValue("first");
    let complete;
    app.api = () => new Promise(resolve => { complete = resolve; });
    const saving = app.saveCodeEditor();
    app.codeEditor.getModel().setValue("second");
    complete({ sha256: "saved-first" });
    await saving;
    expect(app.codeEditorDirty).toBe(true);
    expect(app.codeEditorSaveEl.disabled).toBe(false);
    expect(app.codeEditorFile.sha256).toBe("saved-first");
  });
  it("ignores an old file response after a newer file opens or the editor closes", async () => {
    const app = editorFixture();
    let complete;
    app.api = path => path.includes("A.txt") ? new Promise(resolve => { complete = resolve; }) : Promise.resolve({ text: "B", sha256: "B" });
    const opening = app.openCodeEditor("A.txt", "A.txt");
    await app.openCodeEditor("B.txt", "B.txt");
    complete({ text: "A", sha256: "A" });
    await opening;
    expect(app.codeEditorFile.path).toBe("B.txt");
    const again = app.openCodeEditor("A.txt", "A.txt");
    app.closeCodeEditor();
    complete({ text: "A", sha256: "A" });
    await again;
    expect(app.codeEditor).toBeNull();
  });
  it("never applies a prior save result to a newly opened document", async () => {
    const app = editorFixture();
    await app.openCodeEditor("A.txt", "A.txt");
    app.codeEditor.getModel().setValue("edit");
    let complete;
    app.api = (path, options) => options?.method === "PUT" ? new Promise(resolve => { complete = resolve; }) : Promise.resolve({ text: "B", sha256: "B" });
    const saving = app.saveCodeEditor();
    await app.openCodeEditor("B.txt", "B.txt");
    app.codeEditor.getModel().setValue("B edited");
    complete({ sha256: "saved-A" });
    await saving;
    expect(app.codeEditorFile.sha256).toBe("B");
    expect(app.codeEditorDirty).toBe(true);
  });
  it("keeps the old document named correctly while loading and preserves edits when switching is cancelled", async () => {
    const app = editorFixture();
    await app.openCodeEditor("A.txt", "A.txt");
    let complete;
    app.api = () => new Promise(resolve => { complete = resolve; });
    const opening = app.openCodeEditor("B.txt", "B.txt");
    expect(app.codeEditorTitleEl.textContent).toBe("A.txt");
    app.codeEditor.getModel().setValue("new edit during load");
    app.window.confirm = () => false;
    complete({ text: "B", sha256: "B" });
    await opening;
    expect(app.codeEditorFile.path).toBe("A.txt");
    expect(app.codeEditor.getValue()).toBe("new edit during load");
    expect(app.codeEditorDirty).toBe(true);
  });
  it("does not reload the current file and discard its unsaved changes", async () => {
    const app = editorFixture();
    await app.openCodeEditor("A.txt", "A.txt");
    app.codeEditor.getModel().setValue("edit");
    app.api = vi.fn();
    await app.openCodeEditor("A.txt", "A.txt");
    expect(app.api).not.toHaveBeenCalled();
    expect(app.codeEditor.getValue()).toBe("edit");
    expect(app.codeEditorDirty).toBe(true);
  });
  it.each([false, true])("preserves another session draft after a delayed send (failure=%s)", async fail => {
    const values = new Map();
    const sentAttachment = { name: "first.txt" };
    const newAttachment = { name: "second.txt" };
    let complete;
    const app = createContext({
      sessionId: "first", running: false, pendingAttachments: [sentAttachment],
      pendingMessageSessions: new Set(), attachmentReads: new Map(), draftAttachments: new Map(),
      inputEl: { value: "first draft", focus() {} }, errorBarEl: {},
      localStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
      resizeComposerInput() {}, clearActivity() {}, updateActivityOverview() {}, setRunning() {}, setIndicator() {},
      renderAttachments() {}, showError() {}, loadSessions() {}, redactSensitiveDisplayText: text => text,
      appendMessage: () => ({ el: { closest: () => ({ remove() {} }) } }),
      api: path => path.endsWith("/files") ? Promise.resolve({ files: ["uploads/first.txt"] }) : new Promise((resolve, reject) => { complete = () => fail ? reject(new Error("offline")) : resolve({}); }),
    });
    runInContext(["saveComposerDraft", "sendMessage"].map(declaration).join("\n"), app);
    const sending = app.sendMessage();
    await vi.waitFor(() => expect(typeof complete).toBe("function"));
    app.sessionId = "second";
    app.inputEl.value = "second draft";
    app.pendingAttachments = [newAttachment];
    complete();
    await sending;
    expect(app.inputEl.value).toBe("second draft");
    expect(app.pendingAttachments).toEqual([newAttachment]);
    expect(values.get("pi-console-draft:first")).toBe(fail ? "first draft" : undefined);
    expect(app.pendingMessageSessions.size).toBe(0);
  });
  it("does not send composition Enter but sends a normal Enter", () => {
    const statement = tree.statements.find(node => node.getText(tree).startsWith('inputEl.addEventListener("keydown"'));
    let listener;
    const sendMessage = vi.fn();
    const app = createContext({ composerComposing: false, inputEl: { addEventListener(type, fn) { listener = fn; } }, sendMessage });
    runInContext(statement.getText(tree), app);
    const event = { key: "Enter", isComposing: true, preventDefault: vi.fn() };
    listener(event);
    expect(sendMessage).not.toHaveBeenCalled();
    listener({ ...event, isComposing: false });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
  it("renders during an uninterrupted stream", () => {
    vi.useFakeTimers();
    let method;
    function visit(node) {
      if (ts.isMethodDeclaration(node) && node.name?.getText(tree) === "appendText") method = node;
      ts.forEachChild(node, visit);
    }
    visit(tree);
    const renderMarkdownInto = vi.fn();
    const app = createContext({ setTimeout, clearTimeout, renderMarkdownInto, scrollToBottom() {} });
    runInContext(`globalThis.message = { textEl: { dataset: {} }, ${method.getText(tree)} };`, app);
    for (let i = 0; i < 25; i++) { app.message.appendText("a"); vi.advanceTimersByTime(20); }
    expect(renderMarkdownInto.mock.calls.length).toBeGreaterThan(3);
    expect(renderMarkdownInto.mock.calls.length).toBeLessThan(25);
  });
});
