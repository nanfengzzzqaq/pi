import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replaceCredentialFile } from "../src/credential-file.ts";

const directories: string[] = [];
afterEach(() => {
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function acl(path: string, protect = false): string {
	const script = `${protect ? "$acl=[IO.File]::GetAccessControl($env:PI_ACL_PATH); $acl.SetAccessRuleProtection($true,$true); [IO.File]::SetAccessControl($env:PI_ACL_PATH,$acl);" : ""} [IO.File]::GetAccessControl($env:PI_ACL_PATH).Sddl`;
	return execFileSync(
		join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
		["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
		{ windowsHide: true, env: { ...process.env, PI_ACL_PATH: path }, encoding: "utf8" },
	).trim();
}
describe("atomic credential file", () => {
	it("keeps the previous bytes in backup and handles Unicode without temporary residue", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-credential-file-"));
		directories.push(dir);
		const path = join(dir, "auth.json");
		writeFileSync(path, '{"fixture":"original"}');
		const before = process.platform === "win32" ? acl(path, true) : undefined;
		replaceCredentialFile(path, '{"fixture":"中文-é"}');
		expect(readFileSync(path, "utf8")).toBe('{"fixture":"中文-é"}');
		expect(readFileSync(`${path}.bak`, "utf8")).toBe('{"fixture":"original"}');
		if (before) {
			expect(acl(path)).toBe(before);
			expect(acl(`${path}.bak`)).toBe(before);
		}
		replaceCredentialFile(path, '{"fixture":"third"}');
		expect(readFileSync(`${path}.bak`, "utf8")).toBe('{"fixture":"中文-é"}');
		expect(readdirSync(dir).sort()).toEqual(["auth.json", "auth.json.bak"]);
	});
	it("a failed replace retains original bytes and removes the created temporary file", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-credential-failure-"));
		directories.push(dir);
		const path = join(dir, "missing.json");
		expect(() => replaceCredentialFile(path, "{} ")).toThrow();
		expect(existsSync(path)).toBe(false);
		expect(readdirSync(dir)).toEqual([]);
	});
});
