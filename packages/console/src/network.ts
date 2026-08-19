import { execFileSync } from "node:child_process";
import * as undici from "undici";

const WINDOWS_INTERNET_SETTINGS_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const LOOPBACK_NO_PROXY_HOSTS = ["localhost", "127.0.0.1", "::1"] as const;
const HTTP_IDLE_TIMEOUT_MS = 300_000;

export interface SystemProxySettings {
	httpProxy?: string;
	httpsProxy?: string;
}

function normalizeProxyUrl(value: string | undefined): string | undefined {
	const proxy = value?.trim();
	if (!proxy) return undefined;
	return /^[a-z][a-z\d+.-]*:\/\//iu.test(proxy) ? proxy : `http://${proxy}`;
}

/** Parse the WinINET proxy values emitted by reg.exe. */
export function parseWindowsSystemProxy(output: string): SystemProxySettings | undefined {
	const enabledMatch = output.match(/^\s*ProxyEnable\s+REG_DWORD\s+(\S+)\s*$/imu);
	if (!enabledMatch || Number(enabledMatch[1] ?? 0) !== 1) return undefined;
	const server = output.match(/^\s*ProxyServer\s+REG_SZ\s+(.+?)\s*$/imu)?.[1]?.trim();
	if (!server) return undefined;

	if (!server.includes("=")) {
		const proxy = normalizeProxyUrl(server);
		return proxy ? { httpProxy: proxy, httpsProxy: proxy } : undefined;
	}

	const entries = new Map(
		server
			.split(";")
			.map((entry) => entry.split("=", 2).map((part) => part.trim()))
			.filter((entry): entry is [string, string] => entry.length === 2 && Boolean(entry[0]) && Boolean(entry[1]))
			.map(([protocol, address]) => [protocol.toLowerCase(), address] as const),
	);
	const httpProxy = normalizeProxyUrl(entries.get("http"));
	const httpsProxy = normalizeProxyUrl(entries.get("https"));
	return httpProxy || httpsProxy ? { httpProxy, httpsProxy } : undefined;
}

function readWindowsSystemProxy(): SystemProxySettings | undefined {
	if (process.platform !== "win32") return undefined;
	try {
		const output = execFileSync("reg.exe", ["query", WINDOWS_INTERNET_SETTINGS_KEY], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			windowsHide: true,
		});
		return parseWindowsSystemProxy(output);
	} catch {
		return undefined;
	}
}

function addLoopbackProxyBypass(): void {
	const configuredKeys = (["NO_PROXY", "no_proxy"] as const).filter((key) => process.env[key] !== undefined);
	for (const key of configuredKeys.length > 0 ? configuredKeys : (["NO_PROXY"] as const)) {
		const entries = (process.env[key] ?? "")
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean);
		const normalized = new Set(entries.map((entry) => entry.toLowerCase()));
		for (const host of LOOPBACK_NO_PROXY_HOSTS) {
			if (!normalized.has(host)) entries.push(host);
		}
		process.env[key] = entries.join(",");
	}
}

/** Populate proxy environment variables without overriding explicit user configuration. */
export function applyConsoleProxySettings(
	readSystemProxy: () => SystemProxySettings | undefined = readWindowsSystemProxy,
): SystemProxySettings | undefined {
	const hasEnvironmentProxy = Boolean(
		process.env.HTTP_PROXY ?? process.env.http_proxy ?? process.env.HTTPS_PROXY ?? process.env.https_proxy,
	);
	const systemProxy = hasEnvironmentProxy ? undefined : readSystemProxy();
	if (systemProxy?.httpProxy) process.env.HTTP_PROXY ??= systemProxy.httpProxy;
	if (systemProxy?.httpsProxy) process.env.HTTPS_PROXY ??= systemProxy.httpsProxy;

	if (process.env.HTTP_PROXY ?? process.env.http_proxy ?? process.env.HTTPS_PROXY ?? process.env.https_proxy) {
		addLoopbackProxyBypass();
	}
	return systemProxy;
}

/** Configure the process-wide fetch implementation used by model APIs and the updater. */
export function configureConsoleNetworking(): void {
	applyConsoleProxySettings();
	const dispatcher = new undici.EnvHttpProxyAgent({
		allowH2: false,
		bodyTimeout: HTTP_IDLE_TIMEOUT_MS,
		headersTimeout: HTTP_IDLE_TIMEOUT_MS,
		connect: { autoSelectFamilyAttemptTimeout: 2_000 },
	});
	undici.setGlobalDispatcher(dispatcher);
	undici.install?.();
}
