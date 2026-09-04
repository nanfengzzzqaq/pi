import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { instantiateWebSearchTools } from "../../src/web-search-tools.ts";
import type { PackContext } from "../../src/packs.ts";

export default function definePack(_ctx: PackContext): { tools: ToolDefinition[] } {
	return { tools: instantiateWebSearchTools() };
}
