import { describe, expect, it, vi } from "vitest";
import { checkUpdate, resolveGithubCredential } from "../src/updates.ts";

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
});
