import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
import { AntigravityOAuthCoordinator } from "../src/antigravity-oauth.ts";
import { bundledProviderExtensionPaths } from "../src/bundled-providers.ts";
import { RoutedSkillResourceLoader } from "../src/skill-routing.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("bundled Antigravity provider", () => {
	it("loads the installed adapter into a fresh console session without an account or network", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-antigravity-test-"));
		directories.push(directory);
		const modelRuntime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		const resourceLoader = new RoutedSkillResourceLoader({
			cwd: directory,
			agentDir: directory,
			settingsManager: SettingsManager.inMemory(),
			additionalExtensionPaths: bundledProviderExtensionPaths(),
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
			expect(modelRuntime.getModels().some((model) => model.provider === "antigravity")).toBe(true);
			expect(modelRuntime.hasConfiguredAuth("antigravity")).toBe(false);
			expect(modelRuntime.getProvider("openai-codex")).toBeDefined();
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
