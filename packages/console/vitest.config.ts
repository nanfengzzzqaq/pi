import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

export default mergeConfig(baseConfig, defineConfig({
	test: {
		environment: "node",
		testTimeout: 30_000,
		env: { PI_OFFLINE: "1", ANTIGRAVITY_NO_PREWARM: "1" },
		unstubEnvs: true,
	},
	resolve: { alias: [
		{ find: /^@earendil-works\/pi-coding-agent$/, replacement: workspaceSourcePaths.codingAgentIndex },
		{ find: /^@earendil-works\/pi-client$/, replacement: fileURLToPath(new URL("../client/src/index.ts", import.meta.url)) },
		{ find: /^@earendil-works\/pi-protocol$/, replacement: fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url)) },
	] },
}));
