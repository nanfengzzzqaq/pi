import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentBrowserController } from "./browser-controller-fixture.js";
import { registerAgentBrowserRuntime } from "../src/agent-browser-runtime.ts";
import { instantiateAgentBrowserTools } from "../src/agent-browser-tools.ts";
import defineRedTeamPack, { resolveRedteamCredentials } from "../packs/red-team/index.ts";
import { loadPacks, selectCapabilities } from "../src/packs.ts";
import { cleanupStaleUpdateFiles } from "../src/updates.ts";

const directories = [];
const temporary = () => { const directory = mkdtempSync(join(tmpdir(), "pi-desktop-test-")); directories.push(directory); return directory; };
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function browser() {
	const controller = new AgentBrowserController({ getWindow: () => null, dataDir: temporary(), onState: () => {} });
	const contents = new EventEmitter();
	Object.assign(contents, { id: 7, getURL: () => "https://fixture.invalid/page", getTitle: () => "Fixture", isLoading: () => false, isDestroyed: () => false, navigationHistory: { canGoBack: () => false, canGoForward: () => false }, executeJavaScript: async () => undefined });
	controller.view = { webContents: contents, setVisible: () => {} };
	return controller;
}

describe("desktop capability boundaries", () => {
	it("requires explicit cross-session handoff and invalidates pending work", async () => {
		const controller = browser();
		await controller.runWithSession({ sessionId: "A", workspace: temporary() }, async () => "A");
		await expect(controller.runWithSession({ sessionId: "B", workspace: temporary() }, async () => "B")).rejects.toThrow("接管");
		const waiting = controller.runWithSession({ sessionId: "A", workspace: temporary() }, () => controller.pause(10_000));
		const stopped = expect(waiting).rejects.toThrow("取消");
		controller.claimSession("B", temporary());
		await stopped;
		expect(controller.state().ownerSessionId).toBe("B");
	});

	it("uses request-time download attribution after a handoff", () => {
		let beforeRequest;
		const controller = browser();
		controller.browserSession.removeAllListeners("will-download");
		controller.browserSession.webRequest = { onBeforeRequest: callback => { beforeRequest = callback; } };
		controller.configureDownloads();
		const workspaceA = temporary();
		controller.claimSession("A", workspaceA);
		beforeRequest({ webContentsId: 7, url: "https://fixture.invalid/A.csv" }, () => {});
		controller.claimSession("B", temporary());
		const item = new EventEmitter();
		Object.assign(item, { getURLChain: () => ["https://fixture.invalid/A.csv"], getFilename: () => "A.csv", setSavePath: vi.fn(), cancel: vi.fn() });
		controller.browserSession.emit("will-download", {}, item);
		expect(item.setSavePath).toHaveBeenCalledWith(join(workspaceA, "A.csv"));
		expect(item.cancel).not.toHaveBeenCalled();
	});

	it("requires a fresh snapshot after document replacement and honours pre-cancel", async () => {
		const controller = browser(); registerAgentBrowserRuntime(controller);
		controller.snapshot = async () => "fixture snapshot";
		controller.click = vi.fn(async () => "clicked");
		const tools = instantiateAgentBrowserTools(temporary(), () => "A");
		const call = (name, params, signal) => tools.find(tool => tool.name === name).execute("fixture", params, signal);
		await call("browser_snapshot", {});
		controller.pageVersion++;
		await expect(call("browser_click", { ref: "e1" })).rejects.toThrow("快照");
		const abort = new AbortController(); abort.abort();
		await expect(call("browser_click", { ref: "e1" }, abort.signal)).rejects.toThrow();
		expect(controller.click).not.toHaveBeenCalled();
	});

	it("rejects ambiguous targets before dispatching any mouse input", async () => {
		const controller = browser();
		const document = { querySelectorAll: selector => selector.startsWith("[role=") ? [] : buttons };
		const buttons = [1, 2].map(() => ({ tagName: "BUTTON", innerText: "删除", getAttribute: () => null, matches: () => true, getBoundingClientRect: () => ({ width: 20, height: 20 }) }));
		const context = vm.createContext({ document, CSS: { escape: value => value }, getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }) });
		controller.view.webContents.executeJavaScript = async code => vm.runInContext(code, context);
		controller.view.webContents.sendInputEvent = vi.fn();
		await expect(controller.findAndRun({ selector: "button" }, { kind: "click" })).rejects.toThrow("目标不唯一");
		expect(controller.view.webContents.sendInputEvent).not.toHaveBeenCalled();
	});

	it("resolves fake credential references privately and exposes no env parameter", async () => {
		const directory = temporary();
		const auth = join(directory, "auth.json");
		writeFileSync(auth, JSON.stringify({ openai: { type: "api_key", key: "FAKE_KEY_NEVER_VALID" } }));
		expect(await resolveRedteamCredentials({ OPENAI_API_KEY: "openai" }, auth)).toEqual({ OPENAI_API_KEY: "FAKE_KEY_NEVER_VALID" });
		await expect(resolveRedteamCredentials({ NODE_OPTIONS: "openai" }, auth)).rejects.toThrow("格式无效");
		const tool = defineRedTeamPack({ getWorkspaceRoot: () => directory }).tools.find(tool => tool.name === "redteam_run");
		expect(tool.parameters.properties.env).toBeUndefined();
		expect(tool.parameters.properties.credentialRefs).toBeDefined();
		expect(JSON.stringify(tool.parameters)).not.toContain("FAKE_KEY_NEVER_VALID");
	});

	it("retains pending installer past normal cache expiry", () => {
		const directory = temporary();
		const setup = join(directory, "Pi-Setup-0.3.99.exe");
		writeFileSync(setup, "FAKE_NOT_EXECUTABLE");
		const date = new Date(Date.now() - 8 * 86400000); utimesSync(setup, date, date);
		writeFileSync(join(directory, "pending-update.json"), JSON.stringify({ fromVersion: "0.3.51", targetVersion: "0.3.99", setupPath: setup, startedAt: date.getTime() }));
		cleanupStaleUpdateFiles(undefined, directory);
		expect(existsSync(setup)).toBe(true);
		expect(readFileSync(setup, "utf8")).toBe("FAKE_NOT_EXECUTABLE");
	});

	it("keeps followup capabilities and separates modern document formats", async () => {
		await loadPacks();
		const enabled = ["agent-browser", "office-assistant", "legacy-documents"];
		const previous = selectCapabilities("打开网站并填写表单", enabled);
		expect(selectCapabilities("继续，点击保存", enabled, previous)[0].packName).toBe("agent-browser");
		expect(selectCapabilities("你好", enabled, previous)).toEqual([]);
		const create = selectCapabilities("制作报告 report.docx", enabled);
		expect(create.map(match => match.packName)).toEqual(["office-assistant"]);
		expect(create[0].toolNames).toContain("office_view");
	});
});
