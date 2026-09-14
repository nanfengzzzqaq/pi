import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { withBackgroundOwner } from "../src/background-owner.ts";
import { killBackgroundTask, listBackgroundTasks } from "../src/background-tasks.ts";

async function ready(child: ChildProcess): Promise<void> {
	await once(child.stdout!, "data");
}
describe("Windows owned listening services", () => {
	it.runIf(process.platform === "win32")(
		"lists and stops only the owned service, revalidating task identity",
		async () => {
			const command =
				'require("node:http").createServer((req,res)=>res.end("fixture")).listen(0,"127.0.0.1",function(){console.log(this.address().port)})';
			const owned = withBackgroundOwner({ sessionId: "task-fixture", cwd: process.cwd() }, () =>
				spawn(process.execPath, ["-e", command], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }),
			);
			const unrelated = spawn(process.execPath, ["-e", command], {
				windowsHide: true,
				stdio: ["ignore", "pipe", "ignore"],
			});
			try {
				await Promise.all([ready(owned), ready(unrelated)]);
				const tasks = await listBackgroundTasks();
				const task = tasks.find((item) => item.pid === owned.pid);
				expect(task).toMatchObject({ sessionId: "task-fixture", cwd: process.cwd() });
				expect(tasks.some((item) => item.pid === unrelated.pid)).toBe(false);
				if (!task) throw new Error("Owned fixture service was not detected");
				await expect(killBackgroundTask(task.pid, task.processName, "stale-task-id")).rejects.toThrow();
				expect(owned.exitCode).toBeNull();
				await killBackgroundTask(task.pid, task.processName, task.taskId);
				expect(unrelated.exitCode).toBeNull();
			} finally {
				for (const child of [owned, unrelated]) {
					if (child.exitCode !== null || child.signalCode !== null) continue;
					const closed = once(child, "close");
					child.kill();
					await closed;
				}
			}
		},
		60000,
	);
});
