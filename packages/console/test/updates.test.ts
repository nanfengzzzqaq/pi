import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	checkUpdate,
	cleanupStaleUpdateFiles,
	reconcilePendingUpdate,
	resolveGithubCredential,
	UPDATE_INSTALLER_ARGS,
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
				JSON.stringify([
					{
						tag_name: "v9.3.9",
						draft: false,
						prerelease: false,
						assets: [
							{
								name: "PiConsole-Setup-9.3.9.exe",
								url: "https://api.github.com/assets/1",
								browser_download_url: "https://github.com/download/1",
								size: 123,
								digest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
							},
						],
					},
				]),
				{ status: 200 },
			),
		);

		const result = await checkUpdate({
			fetch: fetchMock as typeof fetch,
			credential: { token: "secret", source: "gh-cli" },
		});

		expect(result.latest).toBe("9.3.9");
		expect(result.assetApiUrl).toBe("https://api.github.com/assets/1");
		expect(result.assetDigest).toBe("sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
		expect(result.error).toBeNull();
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.github.com/repos/nanfengzzzqaq/pi/releases?per_page=100",
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

	it("selects the newest stable Console release from mixed repository releases", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify([
					{
						tag_name: "v10.0.0",
						assets: [{ name: "pi-windows-x64.zip", browser_download_url: "https://github.com/coding-agent" }],
					},
					{
						tag_name: "v9.8.0",
						assets: [
							{
								name: "PiConsole-Setup-9.8.0.exe",
								browser_download_url: "https://github.com/console-9.8.0",
							},
						],
					},
					{
						tag_name: "v9.9.0",
						draft: true,
						assets: [
							{
								name: "PiConsole-Setup-9.9.0.exe",
								browser_download_url: "https://github.com/draft-console",
							},
						],
					},
					{
						tag_name: "v9.8.1-beta.1",
						assets: [
							{
								name: "PiConsole-Setup-9.8.1-beta.1.exe",
								browser_download_url: "https://github.com/prerelease-console",
							},
						],
					},
				]),
				{ status: 200 },
			),
		);

		const result = await checkUpdate({ fetch: fetchMock as typeof fetch, credential: null });

		expect(result.latest).toBe("9.8.0");
		expect(result.assetName).toBe("PiConsole-Setup-9.8.0.exe");
		expect(result.assetUrl).toBe("https://github.com/console-9.8.0");
		expect(result.updateAvailable).toBe(true);
	});

	it("ignores a newer latest release without a Console installer and uses the older valid Console release", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify([
					{
						tag_name: "v99.0.0",
						assets: [{ name: "pi-linux-x64.tar.gz", browser_download_url: "https://github.com/coding-agent" }],
					},
					{
						tag_name: "v98.0.0",
						assets: [
							{
								name: "PiConsole-Setup-98.0.0.exe",
								browser_download_url: "https://github.com/console-98.0.0",
							},
						],
					},
				]),
				{ status: 200 },
			),
		);

		const result = await checkUpdate({ fetch: fetchMock as typeof fetch, credential: null });

		expect(result.latest).toBe("98.0.0");
		expect(result.assetUrl).toBe("https://github.com/console-98.0.0");
	});

	it("does not offer an update or invent a download URL when no release has the exact Console asset", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify([
					{
						tag_name: "v99.0.0",
						assets: [
							{
								name: "PiConsole-Setup-latest.exe",
								browser_download_url: "https://github.com/wrong-console-asset",
							},
						],
					},
				]),
				{ status: 200 },
			),
		);

		const result = await checkUpdate({ fetch: fetchMock as typeof fetch, credential: null });

		expect(result.latest).toBeNull();
		expect(result.updateAvailable).not.toBe(true);
		expect(result.assetName).toBeNull();
		expect(result.assetUrl).toBeNull();
		expect(result.assetApiUrl).toBeNull();
	});

	it("rejects a release tag that cannot be compared safely", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify([
					{
						tag_name: "latest-windows",
						assets: [
							{
								name: "PiConsole-Setup-latest-windows.exe",
								browser_download_url: "https://github.com/invalid-version",
							},
						],
					},
				]),
				{ status: 200 },
			),
		);

		const result = await checkUpdate({ fetch: fetchMock as typeof fetch, credential: null });

		expect(result.latest).toBeNull();
		expect(result.updateAvailable).toBeNull();
		expect(result.error).toBe("github");
	});

	it("keeps the redirect fallback but only trusts an asset confirmed by the release API", async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new Error("temporary network failure"))
			.mockResolvedValueOnce(
				new Response(null, {
					status: 302,
					headers: { location: "/nanfengzzzqaq/pi/releases/tag/v8.0.0" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						tag_name: "v8.0.0",
						assets: [
							{
								name: "PiConsole-Setup-8.0.0.exe",
								browser_download_url: "https://github.com/console-8.0.0",
							},
						],
					}),
					{ status: 200 },
				),
			);

		const result = await checkUpdate({ fetch: fetchMock as typeof fetch, credential: null });

		expect(result.latest).toBe("8.0.0");
		expect(result.assetUrl).toBe("https://github.com/console-8.0.0");
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});
});

describe("更新安装与重启", () => {
	it("uses electron-builder's native NSIS update arguments", () => {
		expect(UPDATE_INSTALLER_ARGS).toEqual(["--updated", "/S", "--force-run", "/currentuser"]);
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
		expect(installerScript).toContain(
			'"$INSTDIR\\resources\\app.asar.unpacked\\extra\\launcher-upgrade.vbs" "$INSTDIR\\resources\\launcher.vbs"',
		);
		expect(installerScript).not.toContain('CopyFiles "$INSTDIR\\extra\\launcher-upgrade.vbs"');
		expect(legacyLauncher).toContain("HKCU\\Software\\pi-console\\ElectronInstallDir");
	});

	it("keeps a verified installer after a failed handoff and clears it only after the target version starts", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-update-recovery-"));
		const installer = join(directory, "PiConsole-Setup-0.3.27.exe");
		const pendingFile = join(directory, "pending-update.json");
		try {
			writeFileSync(installer, "verified installer");
			writeFileSync(
				pendingFile,
				JSON.stringify({
					fromVersion: "0.3.26",
					targetVersion: "0.3.27",
					setupPath: installer,
					startedAt: 123,
					lastError: "测试启动失败",
				}),
			);

			const failed = reconcilePendingUpdate(directory, "0.3.26");
			expect(failed).toMatchObject({
				state: "failed",
				targetVersion: "0.3.27",
				installerAvailable: true,
			});
			expect(failed?.message).toContain("测试启动失败");
			expect(existsSync(installer)).toBe(true);
			expect(existsSync(pendingFile)).toBe(true);

			const completed = reconcilePendingUpdate(directory, "0.3.27");
			expect(completed).toMatchObject({ state: "completed", targetVersion: "0.3.27" });
			expect(existsSync(installer)).toBe(false);
			expect(existsSync(pendingFile)).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("cleans obsolete installers and helper scripts without deleting the pending installer", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-update-cleanup-"));
		const pendingInstaller = join(directory, "PiConsole-Setup-0.3.27.exe");
		const obsoleteInstaller = join(directory, "PiConsole-Setup-0.3.26.exe");
		const obsoleteHelper = join(directory, "apply-update.ps1");
		const incompleteDownload = join(directory, "PiConsole-Setup-0.3.28.exe.123.part");
		const diagnostic = join(directory, "recent.log");
		try {
			for (const file of [pendingInstaller, obsoleteInstaller, obsoleteHelper, incompleteDownload, diagnostic]) {
				writeFileSync(file, "test");
			}
			writeFileSync(
				join(directory, "pending-update.json"),
				JSON.stringify({
					fromVersion: "0.3.26",
					targetVersion: "0.3.27",
					setupPath: pendingInstaller,
					startedAt: 123,
				}),
			);

			expect(cleanupStaleUpdateFiles(Number.MAX_SAFE_INTEGER, directory)).toBe(3);
			expect(existsSync(pendingInstaller)).toBe(true);
			expect(existsSync(obsoleteInstaller)).toBe(false);
			expect(existsSync(obsoleteHelper)).toBe(false);
			expect(existsSync(incompleteDownload)).toBe(false);
			expect(existsSync(diagnostic)).toBe(true);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
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
