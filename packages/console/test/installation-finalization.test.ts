import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("Office install finalization", () => {
	it("keeps installation running until activation and reports activation failure", async () => {
		const directory = fs.mkdtempSync(join(tmpdir(), "pi-install-finalize-"));
		directories.push(directory);
		const source = fs.readFileSync(new URL("../src/officecli.ts", import.meta.url), "utf8");
		const tree = ts.createSourceFile("officecli.ts", source, ts.ScriptTarget.Latest, true);
		const names = [
			"progress",
			"finalizeInstall",
			"getDownloadProgress",
			"registerInstallFinalizer",
			"sha256OfFile",
			"hashFromSums",
			"downloadLatest",
		];
		const selected = tree.statements
			.filter(
				(node) =>
					(ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? "")) ||
					(ts.isVariableStatement(node) &&
						node.declarationList.declarations.some((declaration) =>
							names.includes(declaration.name.getText(tree)),
						)),
			)
			.map((node) => node.getText(tree).replace(/^export /u, ""))
			.join("\n");
		const bytes = Buffer.from("FAKE_OFFICE_BINARY_NOT_EXECUTED");
		const context = createContext({
			...fs,
			createHash,
			AbortSignal,
			BIN_DIR: directory,
			RECORD_FILE: join(directory, "record.json"),
			DISABLED_FILE: join(directory, "disabled"),
			DOWNLOAD_TIMEOUT_MS: 5000,
			binaryPath: () => join(directory, "fixture.exe"),
			assetName: () => "fixture.exe",
			ensureBinaryOnProcessPath: () => {},
			fetchLatestRelease: async () => ({
				tag_name: "v1.0.0",
				assets: [
					{
						name: "fixture.exe",
						browser_download_url: "https://fixture.invalid/binary",
						size: bytes.length,
						digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
					},
				],
			}),
			fetch: async () => new Response(bytes),
			Error,
		});
		runInContext(
			ts.transpileModule(selected, {
				compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
			}).outputText,
			context,
		);
		context.registerInstallFinalizer(async () => {
			expect(context.getDownloadProgress()).toMatchObject({ running: true, phase: "activating" });
			throw new Error("FAKE_ACTIVATION_PERMISSION_DENIED");
		});
		await context.downloadLatest();
		expect(context.getDownloadProgress()).toMatchObject({
			running: false,
			error: "FAKE_ACTIVATION_PERMISSION_DENIED",
		});
		expect(fs.readFileSync(join(directory, "fixture.exe"))).toEqual(bytes);
	});
});
