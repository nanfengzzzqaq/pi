import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { agentBrowserUploadOrigin, deduplicateAgentBrowserSnapshotCandidates, redactSensitiveText, redactSensitiveUrl } from "../src/agent-browser-runtime.ts";

// Execute the real controller without loading a locally installed Electron binary.
const source = readFileSync(new URL("../installer/electron/browser-controller.js", import.meta.url), "utf8");
const tree = ts.createSourceFile("browser-controller.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const body = tree.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(tree)).join("\n").replace("export class AgentBrowserController", "class AgentBrowserController");
const context = createContext({ AsyncLocalStorage, randomUUID, existsSync, mkdirSync, writeFileSync, basename, extname, join, agentBrowserUploadOrigin, deduplicateAgentBrowserSnapshotCandidates, redactSensitiveText, redactSensitiveUrl, URL, Buffer, AbortSignal, AbortController, Error, setTimeout, clearTimeout, session: { fromPartition: () => new EventEmitter() }, WebContentsView: class {} });
runInContext(body + "\nglobalThis.Controller = AgentBrowserController;", context);
export const AgentBrowserController = context.Controller;
