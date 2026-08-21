import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import * as undici from "undici";

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;
// Node's 250ms default can terminate valid connection attempts on high-latency routes.
const DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;

export const HTTP_IDLE_TIMEOUT_CHOICES = [
	{ label: "30 sec", timeoutMs: 30_000 },
	{ label: "1 min", timeoutMs: 60_000 },
	{ label: "2 min", timeoutMs: 120_000 },
	{ label: "5 min", timeoutMs: 300_000 },
	{ label: "disabled", timeoutMs: 0 },
] as const;

const originalGlobalFetch = globalThis.fetch;
let installedGlobalFetch: typeof globalThis.fetch | undefined;

export interface SystemHttpProxySettings {
	httpProxy?: string;
	httpsProxy?: string;
	noProxy?: string[];
}

const WINDOWS_INTERNET_SETTINGS_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const LOOPBACK_NO_PROXY_HOSTS = ["localhost", "127.0.0.1", "::1"] as const;

function normalizeProxyUrl(value: string | undefined): string | undefined {
	const proxy = value?.trim();
	if (!proxy) return undefined;
	return /^[a-z][a-z\d+.-]*:\/\//iu.test(proxy) ? proxy : `http://${proxy}`;
}

function parseWindowsProxyOverrides(output: string): string[] {
	const value = output.match(/^\s*ProxyOverride\s+REG_SZ\s+(.+?)\s*$/imu)?.[1]?.trim();
	if (!value) return [];

	return value
		.split(";")
		.map((entry) => entry.trim())
		.filter((entry) => {
			if (!entry) return false;
			// WinINET's <local> means every hostname without a dot. NO_PROXY has no
			// equivalent, so omitting it is safer than bypassing unrelated hosts.
			if (/^<[^>]+>$/u.test(entry)) return false;
			if (entry.includes("://") || /[\s/?#]/u.test(entry)) return false;
			// Undici supports the conventional leading "*." suffix form, but not
			// arbitrary WinINET wildcards such as 10.* or *-internal.
			return !entry.includes("*") || /^\*\.[^*]+$/u.test(entry);
		});
}

/** Parse the WinINET proxy values emitted by `reg.exe query`. */
export function parseWindowsSystemProxy(output: string): SystemHttpProxySettings | undefined {
	const enabledMatch = output.match(/^\s*ProxyEnable\s+REG_DWORD\s+(\S+)\s*$/imu);
	if (!enabledMatch || Number(enabledMatch[1] ?? 0) !== 1) return undefined;
	const server = output.match(/^\s*ProxyServer\s+REG_SZ\s+(.+?)\s*$/imu)?.[1]?.trim();
	if (!server) return undefined;
	const noProxy = parseWindowsProxyOverrides(output);

	if (!server.includes("=")) {
		const proxy = normalizeProxyUrl(server);
		return proxy ? { httpProxy: proxy, httpsProxy: proxy, ...(noProxy.length > 0 ? { noProxy } : {}) } : undefined;
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
	return httpProxy || httpsProxy ? { httpProxy, httpsProxy, ...(noProxy.length > 0 ? { noProxy } : {}) } : undefined;
}

export function createCachedSystemProxyReader(
	readSystemProxy: () => SystemHttpProxySettings | undefined,
): () => SystemHttpProxySettings | undefined {
	let initialized = false;
	let cached: SystemHttpProxySettings | undefined;
	return () => {
		if (!initialized) {
			cached = readSystemProxy();
			initialized = true;
		}
		return cached;
	};
}

const readWindowsSystemProxy = createCachedSystemProxyReader((): SystemHttpProxySettings | undefined => {
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
});

function addProxyBypass(systemNoProxy: readonly string[] = []): void {
	const keys = ["NO_PROXY", "no_proxy"] as const;
	const configuredKeys = keys.filter((key) => process.env[key] !== undefined);
	for (const key of configuredKeys.length > 0 ? configuredKeys : ["NO_PROXY" as const]) {
		const entries = (process.env[key] ?? "")
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean);
		const normalized = new Set(entries.map((entry) => entry.toLowerCase()));
		for (const host of [...LOOPBACK_NO_PROXY_HOSTS, ...systemNoProxy]) {
			const normalizedHost = host.toLowerCase();
			if (!normalized.has(normalizedHost)) {
				entries.push(host);
				normalized.add(normalizedHost);
			}
		}
		process.env[key] = entries.join(",");
	}
}

export function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.toLowerCase() === "disabled") {
			return 0;
		}
		if (trimmed.length === 0) {
			return undefined;
		}
		return parseHttpIdleTimeoutMs(Number(trimmed));
	}

	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return Math.floor(value);
}

export function formatHttpIdleTimeoutMs(timeoutMs: number): string {
	const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.timeoutMs === timeoutMs);
	if (choice) {
		return choice.label;
	}
	return `${timeoutMs / 1000} sec`;
}

export function applyHttpProxySettings(
	httpProxy: string | undefined,
	readSystemProxy: () => SystemHttpProxySettings | undefined = readWindowsSystemProxy,
): SystemHttpProxySettings | undefined {
	const proxy = normalizeProxyUrl(httpProxy);
	const hasEnvironmentProxy = Boolean(
		process.env.HTTP_PROXY ?? process.env.http_proxy ?? process.env.HTTPS_PROXY ?? process.env.https_proxy,
	);
	const systemProxy = proxy || hasEnvironmentProxy ? undefined : readSystemProxy();
	if (proxy) {
		if (process.env.HTTP_PROXY === undefined && process.env.http_proxy === undefined) process.env.HTTP_PROXY = proxy;
		if (process.env.HTTPS_PROXY === undefined && process.env.https_proxy === undefined)
			process.env.HTTPS_PROXY = proxy;
	} else if (systemProxy) {
		if (systemProxy.httpProxy) process.env.HTTP_PROXY ??= systemProxy.httpProxy;
		if (systemProxy.httpsProxy) process.env.HTTPS_PROXY ??= systemProxy.httpsProxy;
	}

	if (process.env.HTTP_PROXY ?? process.env.http_proxy ?? process.env.HTTPS_PROXY ?? process.env.https_proxy) {
		addProxyBypass(systemProxy?.noProxy);
	}
	return systemProxy;
}

const ignoreUndiciDispatcherError = (_error: unknown): void => {};

// Undici can emit an internal Client "error" while terminating a mid-stream
// fetch body. The body stream still rejects through reader.read(); this listener
// only prevents EventEmitter's unhandled "error" special case from crashing pi.
function withUndiciErrorListener<T extends undici.Dispatcher>(dispatcher: T): T {
	if (dispatcher instanceof EventEmitter) {
		EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
	}
	return dispatcher;
}

function createUndiciClient(origin: string | URL, options: object): undici.Dispatcher {
	return withUndiciErrorListener(new undici.Client(origin, options as undici.Client.Options));
}

function createUndiciOriginDispatcher(origin: string | URL, options: object): undici.Dispatcher {
	const dispatcherOptions = options as undici.Pool.Options;
	if (dispatcherOptions.connections === 1) {
		return createUndiciClient(origin, dispatcherOptions);
	}
	return withUndiciErrorListener(
		new undici.Pool(origin, {
			...dispatcherOptions,
			factory: createUndiciClient,
		}),
	);
}

let installedGlobalDispatcher: undici.Dispatcher | undefined;
let installedDispatcherConfiguration: string | undefined;

export function configureHttpDispatcher(timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS): void {
	const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
	if (normalizedTimeoutMs === undefined) {
		throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
	}
	const configuration = JSON.stringify([
		normalizedTimeoutMs,
		process.env.http_proxy ?? process.env.HTTP_PROXY ?? "",
		process.env.https_proxy ?? process.env.HTTPS_PROXY ?? "",
	]);
	if (
		installedGlobalDispatcher !== undefined &&
		undici.getGlobalDispatcher() === installedGlobalDispatcher &&
		configuration === installedDispatcherConfiguration
	) {
		return;
	}
	const dispatcher = withUndiciErrorListener(
		new undici.EnvHttpProxyAgent({
			allowH2: false,
			bodyTimeout: normalizedTimeoutMs,
			connect: {
				autoSelectFamilyAttemptTimeout: DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
			},
			headersTimeout: normalizedTimeoutMs,
			clientFactory: createUndiciClient,
			factory: createUndiciOriginDispatcher,
		}),
	);
	undici.setGlobalDispatcher(dispatcher);
	installedGlobalDispatcher = dispatcher;
	installedDispatcherConfiguration = configuration;
	// Keep fetch and the dispatcher on the same undici implementation. Node 26.0's
	// bundled fetch can otherwise consume compressed responses through npm undici's
	// dispatcher without decompressing them, causing response.json() failures.
	// If a caller replaced fetch after module load, preserve that deliberate override.
	const shouldInstallGlobals =
		installedGlobalFetch === undefined
			? globalThis.fetch === originalGlobalFetch
			: globalThis.fetch === installedGlobalFetch;
	if (shouldInstallGlobals) {
		undici.install?.();
		installedGlobalFetch = globalThis.fetch;
	}
}
