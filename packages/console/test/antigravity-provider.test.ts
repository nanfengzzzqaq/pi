import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
import { AntigravityOAuthCoordinator } from "../src/antigravity-oauth.ts";
import { bundledProviderExtensionPaths, createAntigravityModelRefresher } from "../src/bundled-providers.ts";
import { RoutedSkillResourceLoader } from "../src/skill-routing.ts";

const directories: string[] = [];
afterEach(() => {
	vi.unstubAllGlobals();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function isolatedAdapter(directory: string, geminiOnly = false): string[] {
	const [entry] = bundledProviderExtensionPaths();
	expect(entry).toBeTruthy();
	const fixture = join(directory, "adapter.ts");
	// Load through the same Jiti module graph as production, but never use the user's cache.
	writeFileSync(
		fixture,
		`
import adapter from ${JSON.stringify(entry)};
import { setCatalogCachePathForTests, writeCatalogCache } from ${JSON.stringify(join(dirname(entry), "models/cache.js"))};
import { ANTIGRAVITY_MODELS, ANTIGRAVITY_ROUTING } from ${JSON.stringify(join(dirname(entry), "models/models.js"))};
setCatalogCachePathForTests(${JSON.stringify(join(directory, "catalog.json"))});
if (${geminiOnly}) writeCatalogCache({
  models: ANTIGRAVITY_MODELS.filter(model => model.id.startsWith("gemini-")),
  routing: Object.fromEntries(Object.entries(ANTIGRAVITY_ROUTING).filter(([id]) => id.startsWith("gemini-")))
});
export default adapter;
`,
	);
	return [fixture];
}

describe("bundled Antigravity provider", () => {
	it("loads the installed adapter into a fresh console session without an account or network", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-antigravity-test-"));
		directories.push(directory);
		const modelRuntime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		const resourceLoader = new RoutedSkillResourceLoader({
			cwd: directory,
			agentDir: directory,
			settingsManager: SettingsManager.inMemory(),
			additionalExtensionPaths: isolatedAdapter(directory),
		});
		await resourceLoader.reload();
		expect(resourceLoader.getExtensions().errors).toEqual([]);
		const { session } = await createAgentSession({
			cwd: directory,
			agentDir: directory,
			modelRuntime,
			resourceLoader,
			settingsManager: SettingsManager.inMemory(),
			sessionManager: SessionManager.inMemory(directory),
		});
		try {
			expect(modelRuntime.getProvider("antigravity")?.auth?.oauth).toBeDefined();
			expect(modelRuntime.getModels("antigravity").map((model) => model.id)).toEqual(
				expect.arrayContaining(["gemini-3.5-flash", "claude-sonnet-4-6", "claude-opus-4-6", "gpt-oss-120b"]),
			);
			expect(modelRuntime.hasConfiguredAuth("antigravity")).toBe(false);
			expect(modelRuntime.getProvider("openai-codex")).toBeDefined();
		} finally {
			session.dispose();
		}
	});

	it("replaces a Gemini-only cache with the complete account catalog and retains it on network failure", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-antigravity-catalog-test-"));
		directories.push(directory);
		const credentials = AuthStorage.inMemory({
			antigravity: {
				type: "oauth",
				access: "fake-google",
				refresh: "fake-refresh",
				expires: Date.now() + 3_600_000,
				projectId: "fake-project",
			},
			"openai-codex": {
				type: "oauth",
				access: "fake-codex",
				refresh: "fake-codex-refresh",
				expires: Date.now() + 3_600_000,
			},
		});
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
		const resourceLoader = new RoutedSkillResourceLoader({
			cwd: directory,
			agentDir: directory,
			settingsManager: SettingsManager.inMemory(),
			additionalExtensionPaths: isolatedAdapter(directory, true),
		});
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			expect(String(input)).toMatch(/\/v1internal:fetchAvailableModels$/);
			expect(init?.body).toBe(JSON.stringify({ project: "fake-project" }));
			return Response.json({
				models: {
					"gemini-3.5-flash-low": { displayName: "Gemini 3.5 Flash (Low)" },
					"claude-sonnet-4-6": { displayName: "Claude Sonnet 4.6 (Thinking)" },
					"claude-opus-4-6-thinking": { displayName: "Claude Opus 4.6 (Thinking)" },
					"gpt-oss-120b-medium": { displayName: "GPT-OSS 120B (Medium)" },
				},
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		await resourceLoader.reload();
		expect(resourceLoader.getExtensions().errors).toEqual([]);
		const { session } = await createAgentSession({
			cwd: directory,
			agentDir: directory,
			modelRuntime: runtime,
			resourceLoader,
			settingsManager: SettingsManager.inMemory(),
			sessionManager: SessionManager.inMemory(directory),
		});
		try {
			await runtime.refresh({ allowNetwork: false, providers: ["antigravity"] });
			expect(runtime.getModels("antigravity").every((model) => model.id.startsWith("gemini-"))).toBe(true);
			expect(fetchMock).not.toHaveBeenCalled();
			const refresh = createAntigravityModelRefresher(runtime);
			expect(await refresh()).toBeGreaterThan(5);
			expect(fetchMock).toHaveBeenCalled();
			const models = runtime.getModels("antigravity").map((model) => model.id);
			expect(models).toEqual(
				expect.arrayContaining(["gemini-3.5-flash", "claude-sonnet-4-6", "claude-opus-4-6", "gpt-oss-120b"]),
			);
			expect(readFileSync(join(directory, "catalog.json"), "utf8")).toContain("gpt-oss-120b");
			fetchMock.mockRejectedValue(new Error("offline"));
			await refresh();
			expect(runtime.getModels("antigravity").map((model) => model.id)).toEqual(models);
			expect(runtime.isUsingOAuth("openai-codex")).toBe(true);
		} finally {
			session.dispose();
		}
	});

	it("persists Google and Codex independently, including restart and Google logout", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-antigravity-auth-test-"));
		directories.push(directory);
		const authPath = join(directory, "auth.json");
		const credentials = AuthStorage.create(authPath);
		const codex = {
			type: "oauth" as const,
			access: "fake-codex",
			refresh: "fake-codex-refresh",
			expires: Date.now() + 3_600_000,
		};
		await credentials.modify("openai-codex", async () => codex);
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
		runtime.registerProvider("antigravity", {
			name: "Antigravity test",
			baseUrl: "https://example.test",
			api: "openai-completions",
			models: [],
			oauth: {
				name: "Google test",
				login: async () => ({
					access: "fake-google",
					refresh: "fake-google-refresh",
					expires: Date.now() + 3_600_000,
					projectId: "fake-project",
				}),
				refreshToken: async (current) => current,
				getApiKey: (current) => current.access,
			},
		});
		const coordinator = new AntigravityOAuthCoordinator({
			isAvailable: () => Boolean(runtime.getProvider("antigravity")),
			isConnected: () => runtime.isUsingOAuth("antigravity"),
			login: async (interaction) => {
				await runtime.login("antigravity", "oauth", interaction);
			},
			logout: () => runtime.logout("antigravity"),
		});
		expect((await coordinator.start()).connected).toBe(true);
		expect(runtime.isUsingOAuth("openai-codex")).toBe(true);
		const restarted = AuthStorage.create(authPath);
		expect(await restarted.read("openai-codex")).toEqual(codex);
		expect(await restarted.read("antigravity")).toMatchObject({
			type: "oauth",
			access: "fake-google",
			projectId: "fake-project",
		});
		await coordinator.logout();
		expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({ "openai-codex": codex });
		expect(runtime.isUsingOAuth("openai-codex")).toBe(true);
	});
});
