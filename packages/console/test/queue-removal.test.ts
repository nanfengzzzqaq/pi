import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentSession,
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
const sessions: AgentSession[] = [];
afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose();
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
async function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "pi-queue-"));
	directories.push(cwd);
	const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: cwd,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		modelRuntime: runtime,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
	});
	sessions.push(session);
	return session;
}
describe("single queued message removal", () => {
	it("removes an exact duplicate by position while retaining images and other queue kinds", async () => {
		const session = await fixture();
		await session.steer("same", [{ type: "image", mimeType: "image/png", data: "FIRST" }]);
		await session.steer("same", [{ type: "image", mimeType: "image/png", data: "SECOND" }]);
		await session.followUp("later", [{ type: "image", mimeType: "image/png", data: "THIRD" }]);
		const removed = session.removeQueuedMessage("steer", 1);
		expect(removed).toMatchObject({
			role: "user",
			content: [
				{ type: "text", text: "same" },
				{ type: "image", data: "SECOND" },
			],
		});
		expect(session.getSteeringMessages()).toEqual(["same"]);
		expect(session.getFollowUpMessages()).toEqual(["later"]);
		expect(session.removeQueuedMessage("steer", 0)).toMatchObject({
			content: [{ type: "text" }, { type: "image", data: "FIRST" }],
		});
		expect(session.removeQueuedMessage("followUp", 0)).toMatchObject({
			content: [{ type: "text" }, { type: "image", data: "THIRD" }],
		});
		expect(session.pendingMessageCount).toBe(0);
	});
	it("does not remove the next message when the SDK display has not caught up with a drained queue", async () => {
		const session = await fixture();
		await session.steer("consumed");
		session.agent.clearSteeringQueue();
		await session.steer("newly queued");
		expect(session.removeQueuedMessage("steer", 0)).toBeUndefined();
		expect(session.agent.removeQueuedMessage("steer", 0, 1)).toMatchObject({ content: [{ text: "newly queued" }] });
	});
	it("rejects invalid positions and emits the remaining queue only after a successful removal", async () => {
		const session = await fixture();
		await session.steer("keep");
		const events: unknown[] = [];
		session.subscribe((event) => {
			if (event.type === "queue_update") events.push(event);
		});
		for (const index of [-1, 0.5, 3, Number.NaN]) expect(session.removeQueuedMessage("steer", index)).toBeUndefined();
		expect(events).toEqual([]);
		session.removeQueuedMessage("steer", 0);
		expect(events).toEqual([{ type: "queue_update", steering: [], followUp: [] }]);
	});
});
