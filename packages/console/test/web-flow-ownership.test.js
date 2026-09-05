import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const tree = ts.createSourceFile("app.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function declaration(name) { return tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === name).getText(tree); }
function listener(element, event = "click") { return tree.statements.find(node => node.getText(tree).startsWith(`${element}.addEventListener("${event}"`)).getText(tree); }

describe("Console asynchronous flow ownership", () => {
  it("keeps only the latest ordinary preview and never reopens after close", async () => {
    const pending = new Map();
    const app = createContext({
      sessionId: "A", previewRequest: 0, previewFile: null, previewModalEl: {hidden:true}, previewTitleEl: {}, previewContentEl: {innerHTML:"",appendChild(){}},
      IMAGE_MIME: new Set(["image/png"]), document: {createElement:()=>({})}, isOfficeFilePath:()=>false, isTextPreviewPath:()=>false,
      releasePreviewObjectUrl() {}, showError:vi.fn(),
      api: path=>new Promise(resolve=>pending.set(path,resolve)),
    });
    runInContext(["openFilePreview","closeFilePreview"].map(declaration).join("\n"),app);
    const a=app.openFilePreview("A.png"); const b=app.openFilePreview("B.png");
    pending.get("/api/fs/read?path=B.png")({mimeType:"image/png"}); await b;
    pending.get("/api/fs/read?path=A.png")({mimeType:"image/png"}); await a;
    expect(app.previewFile.path).toBe("B.png");
    const c=app.openFilePreview("C.png"); app.closeFilePreview(); pending.get("/api/fs/read?path=C.png")({mimeType:"image/png"}); await c;
    expect(app.previewModalEl.hidden).toBe(true); expect(app.previewFile).toBeNull();
  });
  it("captures a batch copy destination before either a copy or FileReader yields", async () => {
    let finish; const bodies=[];
    const app=createContext({LOCAL_FILE_DRAG_TYPE:"local-file",currentFsPath:"C:/intended",window:{piDesktop:{getFilePath:file=>file.path}},showInfo(){},showError:vi.fn(),loadFsDir:vi.fn(),
      api:(_path,options)=>{bodies.push(JSON.parse(options.body));return bodies.length===1?new Promise(resolve=>{finish=resolve;}):Promise.resolve({});}});
    runInContext(declaration("copyDroppedFilesToCurrentDirectory"),app);
    const copying=app.copyDroppedFilesToCurrentDirectory({getData:()=>"",files:[{path:"first"},{path:"second"}]});
    app.currentFsPath="C:/other"; finish({}); await copying;
    expect(bodies.map(body=>body.destination)).toEqual(["C:/intended","C:/intended"]);
    expect(app.loadFsDir).not.toHaveBeenCalled();
  });
  it("does not activate a delete successor after later user navigation", async () => {
    let finishList;
    const app=createContext({sessionId:"A",sessionNavigation:0,historyRequest:0,historyDisplayLimit:100,lastStreamEpoch:null,
      codeEditorPaneEl:{hidden:true},window:{confirm:()=>true},deletedSessions:new Set(),activeSubmissions:new Map(),recoverableSubmissions:new Map(),draftAttachments:new Map(),
      localStorage:{removeItem(){}},inputEl:{value:""},pendingAttachments:[],renderAttachments(){},loadSessions:vi.fn(),showInfo(){},showError:vi.fn(),
      api:(_path,options)=>options?.method==="DELETE"?Promise.resolve({}):new Promise(resolve=>{finishList=resolve;})});
    runInContext(declaration("deleteSession"),app);
    const deleting=app.deleteSession("A"); await vi.waitFor(()=>expect(typeof finishList).toBe("function"));
    app.sessionId="B"; app.sessionNavigation++;
    finishList([{id:"C"}]); await deleting;
    expect(app.sessionId).toBe("B"); expect(app.showError).not.toHaveBeenCalled();
  });
  it("rejects preview attachments over the count limit and ignores deleted destinations", () => {
    const app=createContext({sessionId:"A",deletedSessions:new Set(),attachmentReads:new Map(),draftAttachments:new Map(),pendingAttachments:Array.from({length:32},()=>({size:1})),
      showError:vi.fn(),renderAttachments:vi.fn(),saveComposerDraft:vi.fn()});
    runInContext(declaration("enqueueAttachment"),app);
    expect(app.enqueueAttachment({size:1})).toBe(false); expect(app.pendingAttachments).toHaveLength(32);
    app.deletedSessions.add("B"); expect(app.enqueueAttachment({size:1},"B")).toBe(false); expect(app.draftAttachments.has("B")).toBe(false);
  });
  it("does not apply a prior model response to the newly selected session", async () => {
    let change; let finish;
    const app=createContext({sessionId:"A",modelChangeRequest:0,modelSelectEl:{value:"fixture/model",addEventListener:(_event,fn)=>{change=fn;}},thinkingSelectEl:{value:"off"},
      api:()=>new Promise(resolve=>{finish=resolve;}),syncThinkingOptions:vi.fn(),showError:vi.fn()});
    runInContext(listener("modelSelectEl","change"),app);
    const changing=change(); app.sessionId="B"; app.modelChangeRequest++;
    finish({thinkingLevel:"high",availableThinkingLevels:["high"]}); await changing;
    expect(app.thinkingSelectEl.value).toBe("off"); expect(app.syncThinkingOptions).not.toHaveBeenCalled();
  });
  it("rolls back a rejected thinking selection even when the recovery read also fails", async () => {
    let change;
    const app=createContext({sessionId:"A",thinkingChangeRequest:0,confirmedThinkingLevel:"off",thinkingSelectEl:{value:"high",addEventListener:(_event,fn)=>{change=fn;}},
      api:async()=>{throw new Error("offline");},syncThinkingOptions(){},showError(){}});
    runInContext(listener("thinkingSelectEl","change"),app); await change();
    expect(app.thinkingSelectEl.value).toBe("off"); expect(app.thinkingSelectEl.disabled).toBe(false);
  });
  it("coalesces a slow installer poll and updates progress without rebuilding cards", async () => {
    let finish; const api=vi.fn(()=>new Promise(resolve=>{finish=resolve;}));
    const app=createContext({activePolls:new Set(),api,catalogCache:{},updateCatalogProgress:vi.fn(),renderCatalog:vi.fn(),showError:vi.fn()});
    runInContext(declaration("pollOfficeCliInstall"),app);
    const first=app.pollOfficeCliInstall(); await app.pollOfficeCliInstall();
    expect(api).toHaveBeenCalledTimes(1); finish({running:true}); await first;
    expect(app.updateCatalogProgress).toHaveBeenCalledOnce(); expect(app.renderCatalog).not.toHaveBeenCalled(); expect(app.activePolls.size).toBe(0);
  });
  it("keeps later navigation when a default workspace change finishes", async () => {
    const app=createContext({sessionNavigation:2,sessionId:"later",loadWorkspaceState:vi.fn(async()=>{}),showInfo:vi.fn(),ensureSession:vi.fn()});
    runInContext(declaration("afterWorkspaceChanged"),app);
    await app.afterWorkspaceChanged({sessionReset:true,path:"C:/new"},1);
    expect(app.sessionId).toBe("later"); expect(app.ensureSession).not.toHaveBeenCalled();
    expect(app.loadWorkspaceState).toHaveBeenCalledOnce();
  });
  it("saves explicit unauthenticated models without a key and preserves a new form revision", async () => {
    let save; let finish; let body;
    const field=value=>({value});
    const app=createContext({customModelRevision:0,customModelProviderIdEl:field(""),customModelNameEl:field("Local"),customModelBaseUrlEl:field("http://localhost/v1"),
      customModelApiKeyEl:field("stale-key"),customModelNoAuthEl:{checked:true},customModelIdEl:field("local"),customModelContextEl:field("10000"),customModelMaxTokensEl:field("1000"),
      customModelReasoningEl:{checked:false},customModelVisionEl:{checked:false},customModelSaveBtnEl:{addEventListener:(_event,fn)=>{save=fn;}},
      api:(_path,options)=>{body=JSON.parse(options.body);return new Promise(resolve=>{finish=resolve;});},resetCustomModelForm:vi.fn(),loadCustomModelsSection:vi.fn(),loadKeysSection:vi.fn(),loadModels:vi.fn(),showInfo:vi.fn(),showError:vi.fn()});
    runInContext(listener("customModelSaveBtnEl"),app);
    const saving=save(); app.customModelRevision++; app.customModelNameEl.value="Next unsaved model";
    finish({runtimePending:true}); await saving;
    expect(body.authMode).toBe("none"); expect(body.apiKey).toBe("");
    expect(app.resetCustomModelForm).not.toHaveBeenCalled(); expect(app.showInfo).toHaveBeenCalledWith("自定义模型已保存，重新启动 Pi 后生效");
  });
  it("copies exactly the previewed workspace paths and revision", async () => {
    let copy; let body;
    const button={addEventListener:(_event,fn)=>{copy=fn;}};
    const app=createContext({workspaceCopyPreview:{source:"C:/source",target:"C:/target",revision:"verified-revision"},
      $:id=>id==="workspace-copy-run"?button:{},api:async(_path,options)=>{body=JSON.parse(options.body);return{copiedFiles:1,target:"C:/target"};}});
    runInContext(listener('$("workspace-copy-run")'),app); await copy();
    expect(body).toEqual({source:"C:/source",target:"C:/target",revision:"verified-revision"});
    expect(app.workspaceCopyPreview).toBeNull(); expect(button.hidden).toBe(true);
  });
  it("downloads only the authenticated diagnostics response and restores its button", async () => {
    let download; let blob;
    const button={addEventListener:(_event,fn)=>{download=fn;}}; const link={click:vi.fn()};
    const app=createContext({$:()=>button,api:vi.fn(async()=>({version:"fixture",sessions:2})),Blob,
      URL:{createObjectURL:value=>{blob=value;return"blob:fixture";},revokeObjectURL:vi.fn()},setTimeout:fn=>fn(),document:{createElement:()=>link},showError:vi.fn()});
    runInContext(listener('$("diagnostics-export-btn")'),app); await download();
    expect(app.api).toHaveBeenCalledWith("/api/app/diagnostics"); expect(JSON.parse(await blob.text())).toEqual({version:"fixture",sessions:2});
    expect(link.download).toBe("pi-diagnostics.json"); expect(link.click).toHaveBeenCalledOnce(); expect(button.disabled).toBe(false);
  });
});
