import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAttachmentSnapshotResolver, saveAttachmentSnapshot } from "../src/attachment-snapshots.ts";
import { appendAttachmentAnnotation, parseUserMessage } from "../src/session-messages.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const tree = ts.createSourceFile(
	"server.ts",
	readFileSync(new URL("../src/server.ts", import.meta.url), "utf8"),
	ts.ScriptTarget.ESNext,
	true,
);
const declaration = tree.statements.find(
	(item): item is ts.FunctionDeclaration => ts.isFunctionDeclaration(item) && item.name?.text === "buildHistory",
);
if (!declaration) throw new Error("Missing history function");
const script = new Script(
	`${ts.transpileModule(declaration.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}\nbuildHistory;`,
);

describe("historical facts and bounded rendering", () => {
	it("retains the original model and capability facts without recalculating old turns", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-history-"));
		directories.push(directory);
		const resolveAttachments = vi.fn(createAttachmentSnapshotResolver);
		const render = script.runInNewContext({
			DATA_DIR: directory,
			createAttachmentSnapshotResolver: resolveAttachments,
			parseUserMessage,
			redactSensitiveText: (value: string) => value,
			redactToolValue: (value: unknown) => value,
			toolDisplayName: (value: string) => value,
		});
		const snapshot = saveAttachmentSnapshot(directory, "a", "uploads/file.txt", "file.txt", Buffer.from("original"));
		const messages = [
			{ role: "user", content: appendAttachmentAnnotation("Original task", [snapshot]), timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "Original reply" }],
				provider: "original-provider",
				model: "original-model",
				timestamp: 2,
			},
			{ role: "user", content: "Old record without facts", timestamp: 3 },
		];
		const facts = { stepId: "stored-fact", selectedCapabilities: [{ packName: "old-capability" }] };
		const session = {
			messages,
			model: { provider: "current-provider", id: "current-model" },
			sessionManager: {
				getEntries: () => [
					{
						type: "custom",
						customType: "console-turn",
						data: { userTimestamp: 1, requestId: "original-request", capabilityTrace: facts },
					},
				],
			},
		};
		const items = render("a", session);
		expect(items[0]).toMatchObject({
			attachments: [snapshot],
			requestId: "original-request",
			capabilityTrace: facts,
		});
		expect(items[1].model).toEqual({ provider: "original-provider", modelId: "original-model" });
		expect(items[2]).not.toHaveProperty("capabilityTrace");
		expect(resolveAttachments).toHaveBeenCalledOnce();
		expect(render("a", session, 2)).toHaveLength(1);
	});
});
