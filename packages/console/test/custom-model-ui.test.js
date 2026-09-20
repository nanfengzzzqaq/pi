import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const declarations = source.match(/^const customModel\w+El = .*;$/gm).join("\n");
const form = source.slice(source.indexOf("function resetCustomModelForm()"), source.indexOf("async function loadVersionSection()"));
const script = new Script(`${declarations}\nlet customModelDetails = new Map(); let customModelRevision = 0; let customModelDiscovery = 0;\n${form}\nresetCustomModelForm(); ({ editCustomModel });`);
function fixture(api) {
	const elements = new Map();
	const element = () => ({ value: "", checked: false, dataset: {}, children: [], listeners: {}, textContent: "", addEventListener(event, callback) { this.listeners[event] = callback; }, replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); }, focus() {} });
	const get = (id) => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
	const methods = script.runInNewContext({ $: get, document: { createElement: element }, api, showInfo: vi.fn(), showError: vi.fn(), loadModels: async () => {}, loadKeysSection: async () => {} });
	return { ...methods, get: (id) => get(`custom-model-${id}`), input(id, value) { const el = get(`custom-model-${id}`); if (typeof value === "boolean") el.checked = value; else el.value = value; el.listeners.input(); } };
}
describe("custom model capability form", () => {
	it("does not carry another model's reasoning efforts into an unknown model", async () => {
		const app = fixture(async () => ({ models: ["first", "second"], details: [{ id: "first", reasoningEfforts: ["low", "xhigh"] }, { id: "second" }] }));
		app.input("base-url", "http://localhost/v1"); app.input("id", "first");
		await app.get("discover-btn").listeners.click();
		expect(app.get("efforts").value).toBe("low, xhigh");
		app.input("id", "second");
		expect(app.get("efforts").value).toBe("");
	});
	it("fills server values including false, changes with model selection, and preserves manual settings", async () => {
		const app = fixture(async () => ({ models: ["first", "second"], details: [{ id: "first", contextWindow: 262144 }, { id: "second", contextWindow: 32768, maxTokens: 4096, vision: false, reasoning: false }] }));
		app.input("base-url", "https://models.example/v1");
		app.input("id", "first");
		app.input("vision", true);
		app.input("reasoning", true);
		await app.get("discover-btn").listeners.click();
		expect(app.get("context").value).toBe("262144");
		expect(app.get("vision").checked).toBe(true);
		expect(app.get("capability-state").textContent).toContain("备用值");
		app.input("id", "second");
		expect(app.get("context").value).toBe("32768");
		expect(app.get("max-tokens").value).toBe("4096");
		expect(app.get("vision").checked).toBe(false);
		expect(app.get("reasoning").checked).toBe(false);
		app.input("auto-sync", false);
		app.input("context", "60000");
		app.input("id", "first");
		expect(app.get("context").value).toBe("60000");
	});
	it("does not apply an old discovery response after editing the endpoint", async () => {
		let finish;
		const app = fixture(() => new Promise((resolve) => { finish = resolve; }));
		app.input("base-url", "https://first.example/v1");
		const pending = app.get("discover-btn").listeners.click();
		app.input("base-url", "https://second.example/v1");
		finish({ models: ["first"], details: [{ id: "first", contextWindow: 262144 }] });
		await pending;
		expect(app.get("id").value).toBe("");
		expect(app.get("context").value).toBe("128000");
	});
});
