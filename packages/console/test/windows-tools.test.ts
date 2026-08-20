import { describe, expect, it } from "vitest";
import { getWindowsPowerShellPath, instantiateWindowsTools } from "../src/windows-tools.ts";

describe("Windows 原生命令工具", () => {
	it.runIf(process.platform === "win32")("使用系统 PowerShell 的绝对路径", () => {
		const path = getWindowsPowerShellPath();
		expect(path).toMatch(/^[A-Za-z]:\\.*\\powershell\.exe$/i);
		expect(path?.toLocaleLowerCase("en-US")).toContain("\\windows\\");
	});

	it.runIf(process.platform === "win32")("可以执行 Windows PowerShell 命令", async () => {
		const tool = instantiateWindowsTools({ getWorkspaceRoot: () => process.cwd() }).find(
			(candidate) => candidate.name === "powershell",
		);
		expect(tool?.name).toBe("powershell");
		if (!tool) throw new Error("PowerShell 工具未注册");
		const result = await tool.execute(
			"test-call",
			{ command: "Write-Output 'PI_WINDOWS_OK'", timeout: 10 },
			undefined,
			undefined,
			{} as never,
		);
		expect(result.content).toContainEqual({ type: "text", text: "PI_WINDOWS_OK" });
	});
});
