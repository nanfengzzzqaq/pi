import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import {
	type AgentSession,
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionIndex } from "../src/session-index.ts";
import { disposeSessionBeforeDelete } from "../src/session-lifecycle.ts";

const directories: string[] = [];
const activeSessions: AgentSession[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const session of activeSessions.splice(0)) session.dispose();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// Load only the actual route function, avoiding server startup and user accounts.
// AgentSession, model selection, settings, and transcript storage remain real.
const source = ts.createSourceFile(
	"server.ts",
	readFileSync(new URL("../src/server.ts", import.meta.url), "utf8"),
	ts.ScriptTarget.ESNext,
	true,
);
const handler = source.statements.find(
	(statement): statement is ts.FunctionDeclaration =>
		ts.isFunctionDeclaration(statement) && statement.name?.text === "handleApi",
);
if (!handler) throw new Error("Console API handler is missing");
const routeScript = new Script(
	`${ts.transpileModule(handler.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}\nhandleApi;`,
);
const reloadHandler = source.statements.find(
	(statement): statement is ts.FunctionDeclaration =>
		ts.isFunctionDeclaration(statement) && statement.name?.text === "reloadInstalledSkillsInSessions",
);
if (!reloadHandler) throw new Error("Console skill reload handler is missing");
const reloadScript = new Script(
	`${ts.transpileModule(reloadHandler.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}\nreloadInstalledSkillsInSessions;`,
);

interface ResponseCapture {
	status?: number;
	body?: unknown;
}

async function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "pi-console-session-"));
	directories.push(directory);
	const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
	runtime.registerProvider("fixture", {
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:1",
		apiKey: "unused-fixture-key",
		models: ["first", "second"].map((id) => ({
			id,
			name: id,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_768,
			maxTokens: 4096,
		})),
	});
	const settingsManager = SettingsManager.inMemory({ defaultProvider: "fixture", defaultModel: "first" });
	const resourceLoader = new DefaultResourceLoader({
		cwd: directory,
		agentDir: directory,
		settingsManager,
		noExtensions: true,
		noSkills: true,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: directory,
		agentDir: directory,
		modelRuntime: runtime,
		model: runtime.getModel("fixture", "first"),
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.create(directory, join(directory, "sessions")),
	});
	activeSessions.push(session);
	session.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Local fixture transcript" }],
		api: "openai-completions",
		provider: "fixture",
		model: "first",
		stopReason: "stop",
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	const cs = {
		sessionId: "fixture",
		session,
		enabledPacks: new Set<string>(),
		sseClients: new Set(),
		deleting: false,
		activePrompt: null,
		modelChange: null as Promise<void> | null,
	};
	const sessions = new Map([[cs.sessionId, cs]]);
	let index: SessionIndex = {
		fixture: { cwd: directory, sessionFile: session.sessionFile, title: "fixture", createdAt: 1, updatedAt: 1 },
	};
	const updateSessionTitle = vi.fn();
	const broadcast = vi.fn();
	const execute = routeScript.runInNewContext({
		Error,
		modelRuntime: runtime,
		readBodyJson: async (request: { body?: unknown }) => request.body,
		getOrRestoreSession: async (id: string) => sessions.get(id) ?? null,
		sendJson: (response: ResponseCapture, status: number, body: unknown) => {
			response.status = status;
			response.body = body;
		},
		bufferAndBroadcast: broadcast,
		parseImages: () => [],
		resolveAttachmentImages: () => [],
		vaultSensitiveUrlsInText: (text: string) => text,
		redactSensitiveText: (text: string) => text,
		appendAttachmentAnnotation: (text: string) => text,
		updateSessionTitle,
		prepareTurnCapabilities: () => ({}),
		packSummaries: () => [],
		THINKING_LEVELS: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		disposeSessionBeforeDelete,
		sessions,
		readSessionIndex: () => index,
		writeSessionIndex: (next: SessionIndex) => {
			index = next;
		},
		unlinkSync,
		deleteAttachmentSnapshots: vi.fn(),
		DATA_DIR: directory,
	}) as (
		request: { method: string; body?: unknown },
		response: ResponseCapture,
		url: URL,
		path: string,
	) => Promise<void>;
	const request = async (method: string, action = "", body?: unknown, response: ResponseCapture = {}) => {
		const path = `/api/sessions/fixture${action ? `/${action}` : ""}`;
		await execute({ method, body }, response, new URL(path, "http://127.0.0.1"), path);
		return response;
	};
	const requestPath = async (method: string, path: string) => {
		const response: ResponseCapture = {};
		await execute({ method }, response, new URL(path, "http://127.0.0.1"), path);
		return response;
	};
	const reloadSkills = reloadScript.runInNewContext({ sessions, console }) as () => Promise<number>;
	return {
		session,
		runtime,
		settingsManager,
		resourceLoader,
		cs,
		sessions,
		request,
		requestPath,
		reloadSkills,
		updateSessionTitle,
		broadcast,
	};
}

function holdAuth(runtime: ModelRuntime, fail = false) {
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const original = runtime.checkAuth.bind(runtime);
	const check = vi.spyOn(runtime, "checkAuth").mockImplementation(async (...args) => {
		await gate;
		if (fail) throw new Error("Fixture authentication failure");
		return original(...args);
	});
	return { release, check };
}

describe("Console session route lifecycle", () => {
	for (const state of ["activePrompt", "modelChange", "deleting"] as const) {
		it(`reports ${state} as busy and protects it from tool uninstall and skill reload`, async () => {
			const item = await fixture();
			if (state === "deleting") item.cs.deleting = true;
			else if (state === "modelChange") item.cs.modelChange = Promise.resolve();
			else Reflect.set(item.cs, "activePrompt", { preflight: Promise.resolve(true), done: Promise.resolve() });
			const reload = vi.spyOn(item.session, "reload");
			expect((await item.requestPath("DELETE", "/api/tools/redteam")).status).toBe(409);
			expect(await item.reloadSkills()).toBe(0);
			expect(reload).not.toHaveBeenCalled();
			const list = await item.requestPath("GET", "/api/sessions");
			expect(list.status).toBe(200);
			expect(list.body).toEqual([expect.objectContaining({ id: "fixture", streaming: true })]);
		});
	}

	it("index write failures occur before acknowledging or starting a prompt", async () => {
		const item = await fixture();
		item.updateSessionTitle.mockImplementation(() => {
			throw new Error("Fixture disk write failure");
		});
		const prompt = vi.spyOn(item.session, "prompt");
		const response: ResponseCapture = {};
		await expect(item.request("POST", "messages", { text: "Do not acknowledge" }, response)).rejects.toThrow(
			"Fixture disk write failure",
		);
		expect(response.status).toBeUndefined();
		expect(item.broadcast).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
		expect(item.cs.activePrompt).toBeNull();
	});

	it("model and thinking choices become defaults for the next session", async () => {
		const item = await fixture();
		expect((await item.request("POST", "model", { provider: "fixture", modelId: "second" })).status).toBe(200);
		expect((await item.request("POST", "thinking", { level: "high" })).status).toBe(200);
		expect(item.settingsManager.getDefaultModel()).toBe("second");
		expect(item.settingsManager.getDefaultThinkingLevel()).toBe("high");
		const { session } = await createAgentSession({
			cwd: item.session.sessionManager.getCwd(),
			modelRuntime: item.runtime,
			settingsManager: item.settingsManager,
			resourceLoader: item.resourceLoader,
			sessionManager: SessionManager.inMemory(item.session.sessionManager.getCwd()),
		});
		activeSessions.push(session);
		expect(session.model?.id).toBe("second");
		expect(session.thinkingLevel).toBe("high");
	});

	for (const fail of [false, true]) {
		it(`deletion waits for ${fail ? "failed" : "successful"} model authentication and leaves no recreated transcript`, async () => {
			const item = await fixture();
			const auth = holdAuth(item.runtime, fail);
			const transcript = item.session.sessionFile;
			if (!transcript) throw new Error("Missing fixture transcript");
			const changing = item.request("POST", "model", { provider: "fixture", modelId: "second" });
			await vi.waitFor(() => expect(auth.check).toHaveBeenCalledOnce());
			const deleting = item.request("DELETE");
			await vi.waitFor(() => expect(item.cs.deleting).toBe(true));
			expect(existsSync(transcript)).toBe(true);
			auth.release();
			expect((await changing).status).toBe(fail ? 400 : 200);
			expect((await deleting).status).toBe(200);
			expect(existsSync(transcript)).toBe(false);
			expect(item.sessions.size).toBe(0);
			expect(item.cs.modelChange).toBeNull();
		});
	}

	it("rejects concurrent model, thinking, and prompt mutations while model authentication is pending", async () => {
		const item = await fixture();
		const auth = holdAuth(item.runtime);
		const changing = item.request("POST", "model", { provider: "fixture", modelId: "second" });
		await vi.waitFor(() => expect(auth.check).toHaveBeenCalledOnce());
		expect((await item.request("POST", "model", { provider: "fixture", modelId: "first" })).status).toBe(409);
		expect((await item.request("POST", "thinking", { level: "high" })).status).toBe(409);
		expect((await item.request("POST", "messages", { text: "Do not start while switching" })).status).toBe(409);
		auth.release();
		expect((await changing).status).toBe(200);
	});

	it("rejects model and thinking changes once deletion starts", async () => {
		const item = await fixture();
		item.cs.deleting = true;
		expect((await item.request("POST", "model", { provider: "fixture", modelId: "second" })).status).toBe(409);
		expect((await item.request("POST", "thinking", { level: "high" })).status).toBe(409);
		expect(item.session.model?.id).toBe("first");
	});
});
