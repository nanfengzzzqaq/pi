import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import defineRedTeamPack, { parseStrategyIds } from "../packs/red-team/index.ts";
import { loadPacks, selectCapabilities } from "../src/packs.ts";
import { npmAvailable, uninstall } from "../src/redteam.ts";

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
	it("短时间刷新工具目录时复用 npm 探测，安装前可强制复查", async () => {
		let probes = 0;
		const probe = async () => {
			probes++;
			return true;
		};

		expect(await npmAvailable(true, probe, 1_000)).toBe(true);
		expect(await npmAvailable(false, probe, 2_000)).toBe(true);
		expect(probes).toBe(1);
		expect(await npmAvailable(true, probe, 2_001)).toBe(true);
		expect(probes).toBe(2);
	});

	it("卸载时删除客户端专属安装目录", () => {
		const installDir = mkdtempSync(join(tmpdir(), "pi-redteam-install-"));
		temporaryDirectories.push(installDir);
		writeFileSync(join(installDir, "owned.txt"), "installed");

		expect(uninstall(installDir)).toBe(true);
		expect(existsSync(installDir)).toBe(false);
		expect(uninstall(installDir)).toBe(false);
	});

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
