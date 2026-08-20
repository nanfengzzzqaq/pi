import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	buildUpdateHelperScript,
	checkUpdate,
	resolveGithubCredential,
	resolveUpdateRelaunchTarget,
	verifyDownloadedInstaller,
} from "../src/updates.ts";

describe("resolveGithubCredential", () => {
	it("prefers an explicitly saved token", () => {
		expect(
			resolveGithubCredential({
				readSavedToken: () => "saved-token",
				environment: { GH_TOKEN: "environment-token" },
				readCliToken: () => "cli-token",
			}),
		).toEqual({ token: "saved-token", source: "saved" });
	});

	it("automatically reuses GitHub CLI authentication", () => {
		expect(
			resolveGithubCredential({
				readSavedToken: () => null,
				environment: {},
				readCliToken: () => "cli-token",
			}),
		).toEqual({ token: "cli-token", source: "gh-cli" });
	});
});

describe("checkUpdate", () => {
	it("uses the resolved credential for a private release", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					tag_name: "v0.3.9",
					assets: [
						{
							name: "Pi控制台-Setup-0.3.9.exe",
							url: "https://api.github.com/assets/1",
							browser_download_url: "https://github.com/download/1",
							size: 123,
							digest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
						},
					],
				}),
				{ status: 200 },
			),
		);

		const result = await checkUpdate({
			fetch: fetchMock as typeof fetch,
			credential: { token: "secret", source: "gh-cli" },
		});

		expect(result.latest).toBe("0.3.9");
		expect(result.assetApiUrl).toBe("https://api.github.com/assets/1");
		expect(result.assetDigest).toBe("sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
		expect(result.error).toBeNull();
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.github.com/repos/nanfengzzzqaq/pi/releases/latest",
			expect.objectContaining({
				headers: expect.objectContaining({ Authorization: "Bearer secret" }),
			}),
		);
	});

	it("distinguishes missing private-repository authentication from a network error", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(null, { status: 404 }))
			.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/login" } }));

		const result = await checkUpdate({ fetch: fetchMock as typeof fetch, credential: null });

		expect(result.latest).toBeNull();
		expect(result.error).toBe("authentication");
	});

	it("uses a stable ASCII asset name when the API cannot list release assets", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(JSON.stringify({ tag_name: "v0.3.22", assets: [] }), { status: 200 }));

		const result = await checkUpdate({ fetch: fetchMock as typeof fetch, credential: null });

		expect(result.assetName).toBe("PiConsole-Setup-0.3.22.exe");
		expect(result.assetUrl).toContain("/v0.3.22/PiConsole-Setup-0.3.22.exe");
	});
});

describe("更新安装与重启", () => {
	it("always reopens the current Electron executable from a custom install directory", () => {
		const current = "D:\\ai work\\PiConsole\\PiConsole.exe";
		const fallback = "C:\\Users\\HW\\AppData\\Local\\Programs\\PiConsole\\PiConsole.exe";
		const target = resolveUpdateRelaunchTarget({
			electronRuntime: true,
			currentExecutable: current,
			localAppData: "C:\\Users\\HW\\AppData\\Local",
			packageRoot: "D:\\ai work\\PiConsole\\resources\\app.asar",
			pathExists: (path) => path === current || path === fallback,
		});

		expect(target).toEqual({ path: current, source: "current-electron" });
	});

	it("only falls back to the legacy VBS launcher when the file really exists", () => {
		const packageRoot = "D:\\legacy\\PiConsole\\app";
		const launcher = "D:\\legacy\\PiConsole\\launcher.vbs";
		expect(
			resolveUpdateRelaunchTarget({
				electronRuntime: false,
				currentExecutable: "C:\\node\\node.exe",
				localAppData: "",
				packageRoot,
				pathExists: (path) => path === launcher,
			}),
		).toEqual({ path: launcher, source: "legacy-launcher" });
		expect(
			resolveUpdateRelaunchTarget({
				electronRuntime: false,
				currentExecutable: "C:\\node\\node.exe",
				localAppData: "",
				packageRoot,
				pathExists: () => false,
			}),
		).toBeNull();
	});

	it("records and reads the real Electron install directory for legacy migration", () => {
		const installerScript = readFileSync(
			join(import.meta.dirname, "..", "installer", "electron", "extra", "installer.nsh"),
			"utf8",
		);
		const legacyLauncher = readFileSync(
			join(import.meta.dirname, "..", "installer", "electron", "extra", "launcher-upgrade.vbs"),
			"utf8",
		);
		expect(installerScript).toContain('"ElectronInstallDir" "$INSTDIR"');
		expect(legacyLauncher).toContain("HKCU\\Software\\pi-console\\ElectronInstallDir");
	});

	it("generates a Unicode-safe helper script without inventing launcher.vbs", () => {
		const script = buildUpdateHelperScript(
			"D:\\更新文件\\PiConsole-Setup-0.3.22.exe",
			{ path: "D:\\O'Brien\\PiConsole\\PiConsole.exe", source: "current-electron" },
			"D:\\更新文件\\update-error.log",
		);

		expect(script.startsWith("\uFEFF")).toBe(true);
		expect(script).toContain("D:\\O''Brien\\PiConsole\\PiConsole.exe");
		expect(script).not.toContain("launcher.vbs");
		expect(script).toContain("-PassThru -Wait");
	});

	it("verifies both installer length and GitHub SHA256", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-update-test-"));
		const installer = join(directory, "setup.exe");
		writeFileSync(installer, "abc");
		await expect(
			verifyDownloadedInstaller(
				installer,
				3,
				3,
				"sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
			),
		).resolves.toBeUndefined();
		await expect(verifyDownloadedInstaller(installer, 2, 3, null)).rejects.toThrow("下载不完整");
		await expect(
			verifyDownloadedInstaller(
				installer,
				3,
				3,
				"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			),
		).rejects.toThrow("SHA256 校验失败");
	});
});
