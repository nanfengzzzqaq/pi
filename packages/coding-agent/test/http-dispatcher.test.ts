import net from "node:net";
import tls from "node:tls";
import * as undici from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyHttpProxySettings,
	configureHttpDispatcher,
	createCachedSystemProxyReader,
	parseWindowsSystemProxy,
} from "../src/core/http-dispatcher.ts";

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"] as const;
const DISPATCHER_PROXY_ENV_KEYS = PROXY_ENV_KEYS;

describe("http proxy settings", () => {
	let savedEnv: Record<(typeof PROXY_ENV_KEYS)[number], string | undefined>;

	beforeEach(() => {
		savedEnv = Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
			(typeof PROXY_ENV_KEYS)[number],
			string | undefined
		>;
		for (const key of PROXY_ENV_KEYS) {
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of PROXY_ENV_KEYS) {
			const value = savedEnv[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	it("applies httpProxy to HTTP_PROXY and HTTPS_PROXY", () => {
		applyHttpProxySettings("http://127.0.0.1:7890", () => undefined);

		expect(process.env.HTTP_PROXY).toBe("http://127.0.0.1:7890");
		expect(process.env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
		expect(process.env.NO_PROXY).toBe("localhost,127.0.0.1,::1");
	});

	it("normalizes proxy addresses without a URL scheme", () => {
		applyHttpProxySettings("127.0.0.1:7890", () => undefined);

		expect(process.env.HTTP_PROXY).toBe("http://127.0.0.1:7890");
		expect(process.env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
	});

	it("does not override existing proxy env vars", () => {
		process.env.HTTP_PROXY = "http://env-http:8080";
		process.env.HTTPS_PROXY = "http://env-https:8080";

		applyHttpProxySettings("http://settings:7890", () => undefined);

		expect(process.env.HTTP_PROXY).toBe("http://env-http:8080");
		expect(process.env.HTTPS_PROXY).toBe("http://env-https:8080");
	});

	it("does not mix WinINET bypass rules into an explicit environment proxy", () => {
		process.env.HTTPS_PROXY = "http://env-https:8080";
		process.env.NO_PROXY = "env.internal";
		const readSystemProxy = vi.fn(() => ({
			httpsProxy: "http://system:7897",
			noProxy: ["system.internal"],
		}));

		applyHttpProxySettings(undefined, readSystemProxy);

		expect(readSystemProxy).not.toHaveBeenCalled();
		expect(process.env.NO_PROXY).toBe("env.internal,localhost,127.0.0.1,::1");
	});

	it("ignores empty values", () => {
		applyHttpProxySettings("   ", () => undefined);

		expect(process.env.HTTP_PROXY).toBeUndefined();
		expect(process.env.HTTPS_PROXY).toBeUndefined();
	});

	it("falls back to the Windows system proxy", () => {
		applyHttpProxySettings(undefined, () => ({
			httpProxy: "http://127.0.0.1:7897",
			httpsProxy: "http://127.0.0.1:7897",
		}));

		expect(process.env.HTTP_PROXY).toBe("http://127.0.0.1:7897");
		expect(process.env.HTTPS_PROXY).toBe("http://127.0.0.1:7897");
	});

	it("merges safely representable WinINET proxy overrides into NO_PROXY", () => {
		applyHttpProxySettings(undefined, () => ({
			httpProxy: "http://127.0.0.1:7897",
			httpsProxy: "http://127.0.0.1:7897",
			noProxy: ["internal.example", "*.corp.example"],
		}));

		expect(process.env.NO_PROXY).toBe("localhost,127.0.0.1,::1,internal.example,*.corp.example");
	});

	it("preserves existing NO_PROXY entries while adding local model endpoints", () => {
		process.env.NO_PROXY = "example.test,localhost";

		applyHttpProxySettings("http://127.0.0.1:7890", () => undefined);

		expect(process.env.NO_PROXY).toBe("example.test,localhost,127.0.0.1,::1");
	});

	it("parses simple and per-protocol WinINET proxy settings", () => {
		expect(
			parseWindowsSystemProxy(`
ProxyEnable    REG_DWORD    0x1
ProxyServer    REG_SZ    127.0.0.1:7897
`),
		).toEqual({
			httpProxy: "http://127.0.0.1:7897",
			httpsProxy: "http://127.0.0.1:7897",
		});
		expect(
			parseWindowsSystemProxy(`
ProxyEnable    REG_DWORD    0x1
ProxyServer    REG_SZ    http=proxy.test:8080;https=secure.test:8443
`),
		).toEqual({
			httpProxy: "http://proxy.test:8080",
			httpsProxy: "http://secure.test:8443",
		});
	});

	it("parses ProxyOverride without broadening unsupported WinINET patterns", () => {
		expect(
			parseWindowsSystemProxy(`
ProxyEnable      REG_DWORD    0x1
ProxyServer      REG_SZ       127.0.0.1:7897
ProxyOverride    REG_SZ       <local>;internal.example;*.corp.example;10.*;https://invalid.example
`),
		).toEqual({
			httpProxy: "http://127.0.0.1:7897",
			httpsProxy: "http://127.0.0.1:7897",
			noProxy: ["internal.example", "*.corp.example"],
		});
	});

	it("caches a system proxy lookup, including an unavailable result", () => {
		const availableLookup = vi.fn(() => ({ httpProxy: "http://proxy.test:8080" }));
		const readAvailable = createCachedSystemProxyReader(availableLookup);
		expect(readAvailable()).toEqual({ httpProxy: "http://proxy.test:8080" });
		expect(readAvailable()).toEqual({ httpProxy: "http://proxy.test:8080" });
		expect(availableLookup).toHaveBeenCalledOnce();

		const unavailableLookup = vi.fn(() => undefined);
		const readUnavailable = createCachedSystemProxyReader(unavailableLookup);
		expect(readUnavailable()).toBeUndefined();
		expect(readUnavailable()).toBeUndefined();
		expect(unavailableLookup).toHaveBeenCalledOnce();
	});

	it("ignores disabled WinINET proxy settings", () => {
		expect(
			parseWindowsSystemProxy(`
ProxyEnable    REG_DWORD    0x0
ProxyServer    REG_SZ    127.0.0.1:7897
`),
		).toBeUndefined();
	});
});

describe("http dispatcher", () => {
	const originalDispatcher = undici.getGlobalDispatcher();
	const originalFetch = globalThis.fetch;
	let savedProxyEnv: Record<(typeof DISPATCHER_PROXY_ENV_KEYS)[number], string | undefined>;

	beforeEach(() => {
		savedProxyEnv = Object.fromEntries(DISPATCHER_PROXY_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
			(typeof DISPATCHER_PROXY_ENV_KEYS)[number],
			string | undefined
		>;
		for (const key of DISPATCHER_PROXY_ENV_KEYS) {
			delete process.env[key];
		}
	});

	afterEach(async () => {
		const dispatcher = undici.getGlobalDispatcher();
		if (dispatcher !== originalDispatcher) {
			await dispatcher.close();
			undici.setGlobalDispatcher(originalDispatcher);
		}
		for (const key of DISPATCHER_PROXY_ENV_KEYS) {
			const value = savedProxyEnv[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("allows two seconds for HTTPS connection attempts without changing the Node default", async () => {
		// Preserve a deliberate host fetch override while testing the dispatcher itself.
		globalThis.fetch = async () => {
			throw new Error("Unexpected global fetch");
		};
		const originalAttemptTimeoutMs = net.getDefaultAutoSelectFamilyAttemptTimeout();
		const connectSpy = vi.spyOn(tls, "connect").mockImplementation(() => {
			throw new Error("Connection captured");
		});

		configureHttpDispatcher();
		await expect(undici.fetch("https://example.invalid")).rejects.toThrow();

		expect(connectSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				autoSelectFamilyAttemptTimeout: 2_000,
			}),
		);
		expect(connectSpy.mock.calls[0]?.[0]).not.toHaveProperty("autoSelectFamily");
		expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(originalAttemptTimeoutMs);
	});

	it("keeps the process dispatcher when its effective configuration is unchanged", () => {
		configureHttpDispatcher();
		const firstDispatcher = undici.getGlobalDispatcher();

		configureHttpDispatcher();

		expect(undici.getGlobalDispatcher()).toBe(firstDispatcher);
	});
});
