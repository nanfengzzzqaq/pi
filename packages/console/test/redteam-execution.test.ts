import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	run: vi.fn(),
	start: vi.fn(() => true),
	complete: vi.fn(async () => ({ version: "fixture" })),
}));
vi.mock("../src/credentials.ts", () => ({
	createConsoleCredentials: () => ({ apiKeys: async () => ({ openai: "FAKE_PRIVATE_KEY_NEVER_VALID" }) }),
}));
vi.mock("../src/redteam.ts", () => ({
	promptfooBin: () => "FAKE_CLI",
	startInstall: mocks.start,
	awaitInstall: mocks.complete,
	getLocalStatus: async () => ({ installed: true, version: "fixture", npmAvailable: true, path: "fixture" }),
}));
vi.mock("../src/tool-process.ts", () => ({ runToolProcess: mocks.run, ToolProcessError: class extends Error {} }));

import definePack from "../packs/red-team/index.ts";

describe("redteam private execution", () => {
	it("resolves credentials only for the child and redacts its output", async () => {
		mocks.run.mockResolvedValue({
			stdout: "output FAKE_PRIVATE_KEY_NEVER_VALID",
			stderr: "error FAKE_PRIVATE_KEY_NEVER_VALID",
		});
		const tool = definePack({ getWorkspaceRoot: () => "." }).tools.find((tool) => tool.name === "redteam_generate")!;
		const args = { credentialRefs: { OPENAI_API_KEY: "openai" } };
		const result = await tool.execute("fixture", args, undefined, undefined, {} as never);
		expect(JSON.stringify(result)).not.toContain("FAKE_PRIVATE_KEY_NEVER_VALID");
		expect(JSON.stringify(args)).not.toContain("FAKE_PRIVATE_KEY_NEVER_VALID");
		expect(mocks.run.mock.calls.at(-1)?.[2].env.OPENAI_API_KEY).toBe("FAKE_PRIVATE_KEY_NEVER_VALID");
	});
	it("uses the same installation task as the GUI", async () => {
		const signal = new AbortController().signal;
		const tool = definePack({ getWorkspaceRoot: () => "." }).tools.find((tool) => tool.name === "redteam_setup")!;
		await tool.execute("fixture", { action: "install", version: "0.122.0" }, signal, undefined, {} as never);
		expect(mocks.start).toHaveBeenCalledWith(false, { signal, version: "0.122.0" });
		expect(mocks.complete).toHaveBeenCalled();
	});
});
