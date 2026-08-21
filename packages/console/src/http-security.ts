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
