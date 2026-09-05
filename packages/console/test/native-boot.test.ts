import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 0.3.52 shipped an adapter whose ".js" deep imports into pi-antigravity only resolved
 * under the tsx loader used by the repo tests, so every packaged Electron start failed
 * at boot. Boot the server with plain node — the way the Electron main process loads
 * it — to keep the packaged module graph loadable without a transpiler.
 */
describe("native node boot", () => {
	it("starts the server without the tsx loader", { timeout: 120_000 }, async () => {
		const probe = createServer();
		probe.listen(0, "127.0.0.1");
		await once(probe, "listening");
		const address = probe.address();
		if (address === null || typeof address === "string") throw new Error("Failed to reserve a port");
		const port = address.port;
		await new Promise((resolve) => probe.close(resolve));

		const data = await mkdtemp(join(tmpdir(), "pi-native-boot-"));
		await mkdir(join(data, "agent"), { recursive: true });

		const child = spawn(process.execPath, ["src/server.ts"], {
			cwd: join(import.meta.dirname, ".."),
			windowsHide: true,
			env: {
				...process.env,
				PI_CONSOLE_DATA: data,
				PI_CONSOLE_TOKEN: "native-boot-fixture",
				PORT: String(port),
				PI_OFFLINE: "1",
				ANTIGRAVITY_NO_PREWARM: "1",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let logs = "";
		child.stdout.on("data", (chunk) => {
			logs += chunk;
		});
		child.stderr.on("data", (chunk) => {
			logs += chunk;
		});
		try {
			const deadline = Date.now() + 90_000;
			for (;;) {
				if (child.exitCode !== null)
					throw new Error(`Server exited during boot (code ${child.exitCode}):\n${logs}`);
				if (Date.now() > deadline) throw new Error(`Server never became reachable:\n${logs}`);
				try {
					const response = await fetch(`http://127.0.0.1:${port}/api/models`, {
						headers: { Authorization: "Bearer wrong-token" },
					});
					expect(response.status).toBe(401);
					return;
				} catch {
					await new Promise((resolve) => setTimeout(resolve, 250));
				}
			}
		} finally {
			child.kill();
			await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
			if (child.exitCode === null) child.kill("SIGKILL");
		}
	});
});
