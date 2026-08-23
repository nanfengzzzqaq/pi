import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Windows Electron local agent packaging", () => {
	it("builds, installs, and verifies the repository pi-ai and coding-agent before publishing an installer", () => {
		const buildScript = readFileSync(join(import.meta.dirname, "..", "installer", "electron-build.ps1"), "utf8");
		const orderedSteps = [
			"npm.cmd run build:offline",
			"npm.cmd pack --workspace=@earendil-works/pi-ai",
			"npm.cmd pack --workspace=@earendil-works/pi-coding-agent",
			"npm.cmd install --no-audit --no-fund --no-save --package-lock=false --force $LocalAgentPackage",
			"Get-Command tar.exe",
			"-tzf $LocalAiPackage",
			"-xzf $LocalAiPackage -C $ReplacementAiRoot --strip-components=1",
			'$ExtractedAiManifestPath = Join-Path $ReplacementAiRoot "package.json"',
			"Move-Item -LiteralPath $ResolvedRegistryAiRoot -Destination $RegistryAiBackupRoot",
			"Move-Item -LiteralPath $ReplacementAiRoot -Destination $InstalledAiRoot",
			"--source-ai-dist $LocalAiDist --installed-ai-dist $InstalledAiDist --installed-agent-root $InstalledAgentRoot",
			"--installed-dist $InstalledAgentDist",
			"npx.cmd electron-builder --win nsis",
			"--asar $PackagedAsar",
			"Copy-Item -LiteralPath $SetupExe -Destination $UpdateAsset -Force",
		];

		let previousIndex = -1;
		for (const step of orderedSteps) {
			const index = buildScript.indexOf(step);
			expect(index, `缺少构建步骤：${step}`).toBeGreaterThan(previousIndex);
			previousIndex = index;
		}

		expect(buildScript).toContain("--source-ai-dist $LocalAiDist --asar $PackagedAsar");
		expect(buildScript).not.toContain("npm.cmd install --prefix");
		expect(buildScript).not.toContain("Copy-Item -LiteralPath $ResolvedExtractedAiRoot");
		expect(buildScript).toContain("[IO.Path]::GetPathRoot($ShortTempRoot), $InstalledVolumeRoot");
		expect(buildScript).toContain("for ($Attempt = 0; $Attempt -lt 16 -and -not $ReplacementAiRoot; $Attempt++)");
		expect(buildScript).toContain("New-Item -ItemType Directory -Path $CandidateAiRoot -ErrorAction Stop");
		expect(buildScript).toContain("Assert-PathWithin $ResolvedShortTempRoot $ReplacementAiRoot");
		expect(buildScript).toContain(
			'Join-Path $InstalledAiParent (".b" + [guid]::NewGuid().ToString("N").Substring(0, 16))',
		);
		expect(buildScript).not.toContain(".pi-ai-registry-backup-");
		const shortStageTry = buildScript.indexOf("try {", buildScript.indexOf("$ReplacementAiRoot = $null"));
		const shortStageExtract = buildScript.indexOf("-xzf $LocalAiPackage -C $ReplacementAiRoot", shortStageTry);
		const shortStageManifest = buildScript.indexOf("$ExtractedAiManifestPath =", shortStageExtract);
		const shortStageDependencies = buildScript.indexOf(
			"Copy-Item -LiteralPath $ExistingAiDependencies",
			shortStageManifest,
		);
		const shortStageCleanup = buildScript.indexOf(
			"if ($ReplacementAiRoot -and (Test-Path -LiteralPath $ReplacementAiRoot))",
			shortStageDependencies,
		);
		expect(shortStageTry).toBeGreaterThan(-1);
		expect(shortStageExtract).toBeGreaterThan(shortStageTry);
		expect(shortStageManifest).toBeGreaterThan(shortStageExtract);
		expect(shortStageDependencies).toBeGreaterThan(shortStageManifest);
		expect(shortStageCleanup).toBeGreaterThan(shortStageDependencies);
		const rollbackRethrow = buildScript.indexOf("throw $ReplacementFailure", shortStageDependencies);
		const successfulBackupCleanup = buildScript.indexOf("if ($BackupCreated)", rollbackRethrow);
		expect(rollbackRethrow).toBeGreaterThan(shortStageDependencies);
		expect(successfulBackupCleanup).toBeGreaterThan(rollbackRethrow);
		expect(buildScript).toContain("本地 pi-ai 已替换并验证成功，但旧 registry 备份清理失败");
		expect(buildScript).toContain("Assert-PathWithin $ResolvedInstalledAgentRoot $InstalledAiRoot");
		const parentLexicalCheck = buildScript.indexOf(
			"$InstalledAiParent = Assert-PathWithin $ResolvedInstalledAgentRoot ([IO.Path]::GetFullPath($InstalledAiParent))",
		);
		const parentCreation = buildScript.indexOf("New-Item -ItemType Directory -Path $InstalledAiParent -Force");
		const parentResolvedCheck = buildScript.indexOf(
			"$ResolvedInstalledAiParent = (Resolve-Path -LiteralPath $InstalledAiParent).Path",
		);
		expect(parentLexicalCheck).toBeGreaterThan(-1);
		expect(parentCreation).toBeGreaterThan(parentLexicalCheck);
		expect(parentResolvedCheck).toBeGreaterThan(parentCreation);
		expect(buildScript).toContain(
			"$OriginalNestedAiExists = Test-Path -LiteralPath $InstalledAiRoot -PathType Container",
		);
		expect(buildScript).toContain("if ($OriginalNestedAiExists)");
		expect(buildScript).toContain("if ($BackupCreated)");
		expect(buildScript).toContain("Move-Item -LiteralPath $RegistryAiBackupRoot -Destination $InstalledAiRoot");
		expect(buildScript).toContain("Copy-Item -LiteralPath $ExistingAiDependencies");
	});
});
