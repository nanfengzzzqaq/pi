import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import {
	getProcessOwners,
	type ProcessIdentity,
	resolveProcessOwners,
	withBackgroundOwner,
} from "../src/background-owner.ts";

function proc(pid: number, parentPid: number, startedAt: number): ProcessIdentity {
	return { pid, parentPid, startedAt, identity: `${pid}:${startedAt}`, name: "node.exe", command: null };
}
describe("background process ownership", () => {
	it("distinguishes concurrent conversations from unrelated processes of the same name", () => {
		const processes = new Map(
			[proc(1, 0, 1000), proc(2, 1, 1100), proc(3, 0, 1200), proc(4, 3, 1400), proc(5, 0, 1000)].map((item) => [
				item.pid,
				item,
			]),
		);
		const roots = new Map([
			[1, { sessionId: "A", cwd: "project-A", startedAt: 1000, exitedAt: null }],
			[3, { sessionId: "B", cwd: "project-B", startedAt: 1200, exitedAt: null }],
		]);
		const owned = resolveProcessOwners(processes, roots, new Map());
		expect(owned.get(2)?.sessionId).toBe("A");
		expect(owned.get(4)?.sessionId).toBe("B");
		expect(owned.has(5)).toBe(false);
	});
	it("retains confirmed orphans but drops reused PIDs and newer unrelated launchers", () => {
		const owner = { sessionId: "A", cwd: "project-A" };
		const known = new Map([
			[2, { identity: "2:1500", owner }],
			[3, { identity: "3:1500", owner }],
		]);
		const roots = new Map([[1, { ...owner, startedAt: 1000, exitedAt: 2000 }]]);
		const processes = new Map(
			[proc(1, 0, 9000), proc(2, 0, 1500), proc(3, 0, 9000), proc(4, 1, 9100)].map((item) => [item.pid, item]),
		);
		const owned = resolveProcessOwners(processes, roots, known);
		expect([...owned.keys()]).toEqual([2]);
		expect(known.has(3)).toBe(false);
	});
	it("recognizes a child born before an exited launcher but rejects later PID reuse", () => {
		const roots = new Map([[1, { sessionId: "A", cwd: "project-A", startedAt: 1000, exitedAt: 2000 }]]);
		const processes = new Map([proc(2, 1, 1500), proc(3, 1, 5000)].map((item) => [item.pid, item]));
		expect([...resolveProcessOwners(processes, roots, new Map()).keys()]).toEqual([2]);
	});
	it("captures an actual asynchronous child launch without claiming another child", async () => {
		const start = Date.now();
		const child = await withBackgroundOwner({ sessionId: "owned", cwd: process.cwd() }, async () => {
			await Promise.resolve();
			return spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { windowsHide: true, stdio: "ignore" });
		});
		const unrelated = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], {
			windowsHide: true,
			stdio: "ignore",
		});
		try {
			if (!child.pid) await once(child, "spawn");
			if (!unrelated.pid) await once(unrelated, "spawn");
			await new Promise((resolve) => setTimeout(resolve, 20));
			const processes = new Map(
				[proc(child.pid!, process.pid, start), proc(unrelated.pid!, process.pid, start)].map((item) => [
					item.pid,
					item,
				]),
			);
			expect(getProcessOwners(processes).get(child.pid!)?.sessionId).toBe("owned");
			expect(getProcessOwners(processes).has(unrelated.pid!)).toBe(false);
		} finally {
			const closed = Promise.all([once(child, "close"), once(unrelated, "close")]);
			child.kill();
			unrelated.kill();
			await closed;
		}
	});
});
