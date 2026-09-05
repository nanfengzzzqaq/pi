import type { IncomingHttpHeaders } from "node:http";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * 本地控制台只接受指向自身监听端口的 Host，阻止网页通过 DNS 重绑定借用浏览器访问本地 API。
 */
export function isAllowedLoopbackHost(hostHeader: string | undefined, expectedPort: number): boolean {
	if (!hostHeader) return false;
	try {
		const parsed = new URL(`http://${hostHeader}`);
		if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return false;
		const port = parsed.port ? Number(parsed.port) : 80;
		return LOOPBACK_HOSTS.has(parsed.hostname.toLocaleLowerCase("en-US")) && port === expectedPort;
	} catch {
		return false;
	}
}

/** A loopback Host alone does not prevent cross-origin browser writes. */
export function isAllowedRequestOrigin(headers: IncomingHttpHeaders, port: number): boolean {
	if (!isAllowedLoopbackHost(headers.host, port)) return false;
	const origin = headers.origin;
	if (origin !== undefined) {
		if (typeof origin !== "string") return false;
		try {
			return origin === new URL(`http://${headers.host}`).origin;
		} catch {
			return false;
		}
	}
	const site = headers["sec-fetch-site"];
	return site === undefined || site === "same-origin" || site === "none";
}

export function isTrustedConsoleUrl(value: string, appUrl: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.origin === new URL(appUrl).origin &&
			!url.username &&
			!url.password &&
			!url.search &&
			(url.pathname === "/" || url.pathname === "/index.html")
		);
	} catch {
		return false;
	}
}

export function safeFileHeaders(name: string, mimeType: string, download = false): Record<string, string> {
	const active = /^(?:text\/html|application\/(?:xhtml\+xml|xml)|image\/svg\+xml)(?:;|$)/i.test(mimeType);
	return {
		"Content-Type": active ? "application/octet-stream" : mimeType,
		"Content-Disposition": `${download || active ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`,
		"X-Content-Type-Options": "nosniff",
		"Content-Security-Policy": "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
		"Cache-Control": "no-store",
	};
}
