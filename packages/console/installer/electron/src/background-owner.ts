import { AsyncLocalStorage } from "node:async_hooks";
import type { ChildProcess } from "node:child_process";
import { subscribe } from "node:diagnostics_channel";

export interface BackgroundOwner {
	sessionId: string;
	cwd: string;
}
export interface ProcessIdentity {
	pid: number;
	parentPid: number;
	name: string;
	startedAt: number;
	identity: string;
	command: string | null;
}
interface RootOwner extends BackgroundOwner {
	startedAt: number;
	exitedAt: number | null;
}

/** Attach ownership to actual spawned processes; simultaneous conversations keep independent async contexts. */
const context = new AsyncLocalStorage<BackgroundOwner>();
const roots = new Map<number, RootOwner>();
const descendants = new Map<number, { identity: string; owner: BackgroundOwner }>();
let subscribed = false;

export function withBackgroundOwner<T>(owner: BackgroundOwner, run: () => T): T {
	if (!subscribed) {
		subscribed = true;
		subscribe("child_process", (message) => {
			const owner = context.getStore();
			const child = (message as { process?: ChildProcess }).process;
			if (!owner || !child) return;
			const startedAt = Date.now();
			child.once("spawn", () => {
				if (!child.pid) return;
				const root: RootOwner = { ...owner, startedAt, exitedAt: null };
				roots.set(child.pid, root);
				child.once("exit", () => {
					root.exitedAt = Date.now();
				});
				// Bound retained short-lived launchers; an unverified process is omitted rather than guessed.
				while (roots.size > 2000) roots.delete(roots.keys().next().value!);
			});
		});
	}
	return context.run(owner, run);
}

export function resolveProcessOwners(
	processes: ReadonlyMap<number, ProcessIdentity>,
	launchers: ReadonlyMap<number, RootOwner>,
	known: Map<number, { identity: string; owner: BackgroundOwner }>,
): Map<number, BackgroundOwner> {
	const result = new Map<number, BackgroundOwner>();
	for (const [pid, record] of known) {
		if (processes.get(pid)?.identity === record.identity) result.set(pid, record.owner);
		else known.delete(pid);
	}
	for (const item of processes.values()) {
		let current: ProcessIdentity | undefined = item;
		const seen = new Set<number>();
		let owner = result.get(item.pid);
		while (!owner && current && !seen.has(current.pid)) {
			seen.add(current.pid);
			const root = launchers.get(current.pid);
			if (
				root &&
				current.startedAt >= root.startedAt - 1000 &&
				current.startedAt <= root.startedAt + 1000 &&
				(root.exitedAt === null || current.startedAt <= root.exitedAt)
			)
				owner = root;
			if (owner) break;
			const parent = processes.get(current.parentPid);
			const exitedRoot = launchers.get(current.parentPid);
			// Windows retains parent PID after a launcher exits. Birth time must precede that exit.
			if (
				!parent &&
				exitedRoot &&
				exitedRoot.exitedAt !== null &&
				current.startedAt >= exitedRoot.startedAt - 1000 &&
				current.startedAt <= exitedRoot.exitedAt
			) {
				owner = exitedRoot;
				break;
			}
			if (parent && parent.startedAt > current.startedAt) break; // parent PID has been reused
			owner = parent ? result.get(parent.pid) : undefined;
			current = parent;
		}
		if (owner) {
			const value = { sessionId: owner.sessionId, cwd: owner.cwd };
			result.set(item.pid, value);
			known.set(item.pid, { identity: item.identity, owner: value });
		}
	}
	return result;
}

export function getProcessOwners(processes: ReadonlyMap<number, ProcessIdentity>): Map<number, BackgroundOwner> {
	return resolveProcessOwners(processes, roots, descendants);
}
