import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectProjectEnvironment, getDeveloperComponents, getRepositorySummary } from "../src/code-development.ts";

describe("代码开发聚合插件", () => {
	it("从项目文件识别所需运行环境", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-development-test-"));
		writeFileSync(join(root, "package.json"), "{}", "utf8");
		writeFileSync(join(root, "pyproject.toml"), "[project]", "utf8");
		const detected = detectProjectEnvironment(root);
		expect(detected.componentIds).toEqual(["node", "python"]);
		expect(detected.reasons.join("\n")).toContain("package.json");
	});

	it("识别解决方案文件对应的 .NET 环境", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-development-dotnet-test-"));
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "PiConsole.sln"), "", "utf8");
		expect(detectProjectEnvironment(root).componentIds).toContain("dotnet");
	});

	it("只暴露一个插件下的六个可选环境组件", () => {
		expect(getDeveloperComponents().map((component) => component.id)).toEqual([
			"node",
			"python",
			"java",
			"go",
			"rust",
			"dotnet",
		]);
	});

	it("保留 Git porcelain 开头的空格状态位", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-development-git-test-"));
		execFileSync("git", ["init", "--quiet"], { cwd: root });
		writeFileSync(join(root, "app.ts"), "export const value = 1;\n", "utf8");
		execFileSync("git", ["add", "app.ts"], { cwd: root });
		execFileSync(
			"git",
			["-c", "user.name=Pi Test", "-c", "user.email=pi@example.invalid", "commit", "--quiet", "-m", "init"],
			{ cwd: root },
		);
		writeFileSync(join(root, "app.ts"), "export const value = 2;\n", "utf8");
		const summary = await getRepositorySummary(root);
		expect(summary.files).toEqual([{ index: " ", worktree: "M", path: "app.ts" }]);
	});
});
