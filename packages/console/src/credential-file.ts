import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fchmodSync,
	fchownSync,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** ReplaceFile preserves the original Windows ACL; copying a default-ACL temp file is insufficient.
 * Content travels base64-encoded in an environment variable so headless hosts without a usable
 * console never touch [Console] input encoding. */
const WINDOWS_REPLACE = `$ErrorActionPreference='Stop'
$temporary=$env:PI_CREDENTIAL_TEMP
$target=$env:PI_CREDENTIAL_TARGET
$stream=$null
$created=$false
try {
 $content=[Convert]::FromBase64String($env:PI_CREDENTIAL_CONTENT)
 $acl=[IO.File]::GetAccessControl($target)
 $stream=[IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 $created=$true
 $stream.Write($content,0,$content.Length); $stream.Flush($true)
 $stream.Dispose(); $stream=$null
 [IO.File]::SetAccessControl($temporary,$acl)
 [IO.File]::Replace($temporary,$target,$env:PI_CREDENTIAL_BACKUP,$false)
} finally {
 if($null -ne $stream){$stream.Dispose()}
 if($created -and [IO.File]::Exists($temporary)){[IO.File]::Delete($temporary)}
}`;

export function replaceCredentialFile(path: string, content: string): void {
	const temporary = `${path}.${randomUUID()}.tmp`;
	if (process.platform === "win32") {
		const encoded = Buffer.from(content, "utf8").toString("base64");
		if (encoded.length > 24_000) throw new Error("账号配置内容过大，无法安全保存");
		try {
			execFileSync(
				join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
				[
					"-NoProfile",
					"-NonInteractive",
					"-WindowStyle",
					"Hidden",
					"-EncodedCommand",
					Buffer.from(WINDOWS_REPLACE, "utf16le").toString("base64"),
				],
				{
					env: {
						...process.env,
						PI_CREDENTIAL_TEMP: temporary,
						PI_CREDENTIAL_TARGET: path,
						PI_CREDENTIAL_BACKUP: `${path}.bak`,
						PI_CREDENTIAL_CONTENT: encoded,
					},
					windowsHide: true,
					timeout: 30_000,
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
		} catch (error) {
			const detail =
				typeof error === "object" && error !== null && "stderr" in error
					? `：${String((error as { stderr?: unknown }).stderr)
							.trim()
							.slice(0, 300)}`
					: "";
			throw new Error(`账号配置无法安全保存，原文件权限与备份已保留，请检查磁盘和权限后重试${detail}`);
		}
		return;
	}
	const stat = statSync(path);
	const write = (target: string, value: string): void => {
		const temp = `${target}.${randomUUID()}.tmp`;
		let created = false;
		try {
			const fd = openSync(temp, "wx", 0o600);
			created = true;
			try {
				fchownSync(fd, stat.uid, stat.gid);
				fchmodSync(fd, stat.mode & 0o7777);
				writeFileSync(fd, value);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			renameSync(temp, target);
		} finally {
			if (created && existsSync(temp)) unlinkSync(temp);
		}
	};
	write(`${path}.bak`, readFileSync(path, "utf8"));
	write(path, content);
}
