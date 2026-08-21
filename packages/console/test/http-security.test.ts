import { describe, expect, it } from "vitest";
import { isAllowedLoopbackHost } from "../src/http-security.ts";

describe("本地控制台 Host 校验", () => {
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
