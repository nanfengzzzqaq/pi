import { afterEach, describe, expect, it } from "vitest";
import { applyConsoleProxySettings, parseWindowsSystemProxy } from "../src/network.ts";

const PROXY_ENV_KEYS = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"] as const;
const originalProxyEnvironment = Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
	for (const key of PROXY_ENV_KEYS) {
		const value = originalProxyEnvironment[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("parseWindowsSystemProxy", () => {
	it("parses a shared enabled WinINET proxy", () => {
		expect(
			parseWindowsSystemProxy(`
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ       127.0.0.1:7897
`),
		).toEqual({ httpProxy: "http://127.0.0.1:7897", httpsProxy: "http://127.0.0.1:7897" });
	});

	it("ignores disabled WinINET proxy settings", () => {
		expect(
			parseWindowsSystemProxy(`
    ProxyEnable    REG_DWORD    0x0
    ProxyServer    REG_SZ       127.0.0.1:7897
`),
		).toBeUndefined();
	});
});

describe("applyConsoleProxySettings", () => {
	it("uses the Windows system proxy and bypasses loopback services", () => {
		for (const key of PROXY_ENV_KEYS) delete process.env[key];
		applyConsoleProxySettings(() => ({
			httpProxy: "http://127.0.0.1:7897",
			httpsProxy: "http://127.0.0.1:7897",
		}));

		expect(process.env.HTTP_PROXY).toBe("http://127.0.0.1:7897");
		expect(process.env.HTTPS_PROXY).toBe("http://127.0.0.1:7897");
		expect(process.env.NO_PROXY).toBe("localhost,127.0.0.1,::1");
	});

	it("preserves explicitly configured proxy and no-proxy values", () => {
		for (const key of PROXY_ENV_KEYS) delete process.env[key];
		process.env.HTTPS_PROXY = "http://configured:8080";
		process.env.NO_PROXY = "internal.example";
		applyConsoleProxySettings(() => ({ httpsProxy: "http://system:7897" }));

		expect(process.env.HTTPS_PROXY).toBe("http://configured:8080");
		expect(process.env.NO_PROXY).toBe("internal.example,localhost,127.0.0.1,::1");
	});
});
