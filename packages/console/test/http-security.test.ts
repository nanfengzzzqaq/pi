import { describe, expect, it } from "vitest";
import {
	isAllowedLoopbackHost,
	isAllowedRequestOrigin,
	isTrustedConsoleUrl,
	safeFileHeaders,
} from "../src/http-security.ts";

describe("本地控制台 Host 校验", () => {
	it("拒绝其他端口和网站的浏览器请求来源", () => {
		expect(isAllowedRequestOrigin({ host: "127.0.0.1:3200", origin: "http://127.0.0.1:3201" }, 3200)).toBe(false);
		expect(isAllowedRequestOrigin({ host: "127.0.0.1:3200", origin: "null" }, 3200)).toBe(false);
		expect(isAllowedRequestOrigin({ host: "127.0.0.1:3200", "sec-fetch-site": "cross-site" }, 3200)).toBe(false);
		expect(isAllowedRequestOrigin({ host: "127.0.0.1:3200", origin: "http://127.0.0.1:3200" }, 3200)).toBe(true);
		expect(isAllowedRequestOrigin({ host: "127.0.0.1:3200" }, 3200)).toBe(true);
	});
	it("原始 HTML 和 SVG 下载隔离，PDF 可继续内联预览", () => {
		for (const mime of ["text/html", "image/svg+xml", "application/xhtml+xml"]) {
			const headers = safeFileHeaders("fixture", mime);
			expect(headers["Content-Type"]).toBe("application/octet-stream");
			expect(headers["Content-Disposition"]).toMatch(/^attachment/);
			expect(headers["Content-Security-Policy"]).toContain("sandbox");
		}
		expect(safeFileHeaders("fixture.pdf", "application/pdf")["Content-Disposition"]).toMatch(/^inline/);
	});
	it("桌面权限仅授予主界面地址", () => {
		const app = "http://127.0.0.1:3200/";
		expect(isTrustedConsoleUrl(app, app)).toBe(true);
		expect(isTrustedConsoleUrl(`${app}index.html`, app)).toBe(true);
		expect(isTrustedConsoleUrl(`${app}api/fs/raw?path=fixture`, app)).toBe(false);
		expect(isTrustedConsoleUrl("http://localhost:3200/", app)).toBe(false);
		expect(isTrustedConsoleUrl(`${app}?untrusted=1`, app)).toBe(false);
	});
	it("只允许本机回环地址和当前端口", () => {
		expect(isAllowedLoopbackHost("127.0.0.1:3200", 3200)).toBe(true);
		expect(isAllowedLoopbackHost("localhost:3200", 3200)).toBe(true);
		expect(isAllowedLoopbackHost("[::1]:3200", 3200)).toBe(true);
	});

	it("拒绝缺失、外部域名和错误端口", () => {
		expect(isAllowedLoopbackHost(undefined, 3200)).toBe(false);
		expect(isAllowedLoopbackHost("attacker.example:3200", 3200)).toBe(false);
		expect(isAllowedLoopbackHost("127.0.0.1:3201", 3200)).toBe(false);
		expect(isAllowedLoopbackHost("127.0.0.1:3200/path", 3200)).toBe(false);
	});
});
