import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Windows Electron local agent packaging", () => {
	it("builds, installs, and verifies the repository coding-agent before publishing an installer", () => {
		const buildScript = readFileSync(join(import.meta.dirname, "..", "installer", "electron-build.ps1"), "utf8");
		const orderedSteps = [
			"npm.cmd run build:offline",
			"npm.cmd pack --workspace=@earendil-works/pi-coding-agent",
			"npm.cmd install --no-audit --no-fund --no-save --package-lock=false --force $LocalAgentPackage",
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
	});
});
