import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { instantiateAgentBrowserTools } from "../../src/agent-browser-tools.ts";
import type { PackContext } from "../../src/packs.ts";

export default function definePack(ctx: PackContext): { tools: ToolDefinition[] } {
	return { tools: instantiateAgentBrowserTools(ctx.getWorkspaceRoot()) };
}
