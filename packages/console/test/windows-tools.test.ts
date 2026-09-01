import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	bundledWindowsRuntimeCandidates,
	getWindowsPowerShellPath,
	instantiateWindowsTools,
	isPrivateBashAvailable,
} from "../src/windows-tools.ts";

describe("Windows 原生命令工具", () => {
	it.runIf(process.platform === "win32")("安装版优先读取 app.asar.unpacked 物理目录", () => {
		expect(bundledWindowsRuntimeCandidates("C:\\PiConsole\\resources\\app.asar")).toEqual([
			"C:\\PiConsole\\resources\\app.asar.unpacked\\data\\runtime\\mingit",
			"C:\\PiConsole\\resources\\app.asar\\data\\runtime\\mingit",
		]);
	});

	it.runIf(process.platform === "win32")("使用系统 PowerShell 的绝对路径", () => {
		const path = getWindowsPowerShellPath();
		expect(path).toMatch(/^[A-Za-z]:\\.*\\powershell\.exe$/i);
		expect(path?.toLocaleLowerCase("en-US")).toContain("\\windows\\");
	});

	it.runIf(process.platform === "win32" && isPrivateBashAvailable())("私有 Bash 保持 Pi 原生模型接口", () => {
		const cwd = process.cwd();
		const privateBash = instantiateWindowsTools({ getWorkspaceRoot: () => cwd }).find(
			(candidate) => candidate.name === "bash",
		);
		const nativeBash = createBashToolDefinition(cwd);
		expect(privateBash).toMatchObject({
			name: nativeBash.name,
			label: nativeBash.label,
			description: nativeBash.description,
			promptSnippet: nativeBash.promptSnippet,
			promptGuidelines: nativeBash.promptGuidelines,
			parameters: nativeBash.parameters,
		});
	});

	it.runIf(process.platform === "win32")(
		"可以执行 Windows PowerShell 命令",
		async () => {
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
		},
		30_000,
	);

	it.runIf(process.platform === "win32")(
		"PowerShell 输出按行流式回调 onUpdate",
		async () => {
			const tool = instantiateWindowsTools({ getWorkspaceRoot: () => process.cwd() }).find(
				(candidate) => candidate.name === "powershell",
			);
			if (!tool) throw new Error("PowerShell 工具未注册");
			const updates: string[] = [];
			const result = await tool.execute(
				"test-stream",
				{
					command: '1..4 | ForEach-Object { Write-Output "line-$_"; Start-Sleep -Milliseconds 220 }',
					timeout: 20,
				},
				undefined,
				(partial) => {
					const text = (partial.content ?? [])
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("");
					updates.push(text);
				},
				{} as never,
			);
			// 至少收到一次中间更新（命令总时长 ~880ms，节流 150ms）
			expect(updates.length).toBeGreaterThanOrEqual(1);
			expect(updates[updates.length - 1] ?? "").toContain("line-1");
			const finalText = (result.content ?? [])
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("");
			for (let i = 1; i <= 4; i++) expect(finalText).toContain(`line-${i}`);
		},
		30_000,
	);

	it.runIf(process.platform === "win32")(
		"PowerShell 超时返回错误信息",
		async () => {
			const tool = instantiateWindowsTools({ getWorkspaceRoot: () => process.cwd() }).find(
				(candidate) => candidate.name === "powershell",
			);
			if (!tool) throw new Error("PowerShell 工具未注册");
			await expect(
				tool.execute(
					"test-timeout",
					{ command: "Start-Sleep -Seconds 5", timeout: 1 },
					undefined,
					undefined,
					{} as never,
				),
			).rejects.toThrow(/超时/);
		},
		30_000,
	);
});
