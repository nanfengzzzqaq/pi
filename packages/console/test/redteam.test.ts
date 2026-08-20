import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import defineRedTeamPack, { parseStrategyIds } from "../packs/red-team/index.ts";
import { loadPacks, selectCapabilities } from "../src/packs.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("parseStrategyIds", () => {
	it("reads the current promptfoo strategy list from generate help", () => {
		const help = `
  --strategies <strategies>       Comma-separated list of strategies to use.

                                  Defaults to:
                                  - default (includes: basic,
                                  jailbreak:composite, jailbreak:meta)

                                  Optional:
                                  - audio, best-of-n, crescendo,
                                  jailbreak:hydra, prompt-injection
  -n, --num-tests <number>        Number of test cases
`;

		expect(parseStrategyIds(help)).toEqual([
			"default",
			"basic",
			"jailbreak:composite",
			"jailbreak:meta",
			"audio",
			"best-of-n",
			"crescendo",
			"jailbreak:hydra",
			"prompt-injection",
		]);
	});
});

describe("red-team pack", () => {
	it("uses the ToolDefinition call signature and writes a valid DeepSeek provider target", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "pi-redteam-"));
		temporaryDirectories.push(workspace);
		const pack = defineRedTeamPack({ getWorkspaceRoot: () => workspace });
		const initTool = pack.tools.find((tool) => tool.name === "redteam_init");
		if (!initTool) throw new Error("缺少 redteam_init 工具");

		await initTool.execute(
			"test-call",
			{
				target: "deepseek:deepseek-v4-flash",
				purpose: "验证客服智能体不会泄露系统提示词",
				plugins: ["prompt-extraction"],
			},
			undefined,
			undefined,
			{} as never,
		);

		const config = readFileSync(join(workspace, "promptfooconfig.yaml"), "utf8");
		expect(config).toContain('id: "deepseek:deepseek-v4-flash"');
		expect(config).toContain('- "jailbreak:composite"');
		expect(config).toContain('- "jailbreak:meta"');
	});

	it("loads no red-team tool for chat and the scan group for a red-team request", async () => {
		await loadPacks();
		expect(selectCapabilities("你好", ["red-team"])).toEqual([]);

		const matches = selectCapabilities("请对这个模型做红队漏洞扫描", ["red-team"]);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.groupNames).toContain("scan");
		expect(matches[0]?.toolNames).toEqual(
			expect.arrayContaining(["redteam_init", "redteam_generate", "redteam_run", "redteam_results"]),
		);
	});
});
