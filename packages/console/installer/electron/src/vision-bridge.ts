/**
 * 视觉桥 — 当前模型不支持识图时，把图片交给一个支持视觉的模型转写成文字证据。
 *
 * 配置保存在 <DATA_DIR>/vision-bridge.json；未显式指定模型时自动选择
 * 第一个已配置鉴权且支持图片输入的模型。转写结果按图片内容哈希缓存。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Context, ImageContent, Model } from "@earendil-works/pi-ai";

export interface VisionBridgeConfig {
	enabled: boolean;
	provider: string | null;
	modelId: string | null;
}

/** 任意 API 形态的模型（运行时只关心 input 能力标记与调用）。 */
type AnyModel = Model<Api>;

interface BridgeModelRuntime {
	getProviders(): ReadonlyArray<{ id: string }>;
	getModels(providerId: string): readonly AnyModel[];
	hasConfiguredAuth(providerId: string): boolean;
	getModel(providerId: string, modelId: string): AnyModel | undefined;
	complete(
		model: AnyModel,
		context: Context,
		options?: { signal?: AbortSignal },
	): Promise<{ content: Array<{ type: string; text?: string }> }>;
}

const MAX_CACHE_ENTRIES = 200;
const TRANSCRIBE_PROMPT =
	"请把这张图片的内容详细转写成文字，供另一个只能处理文本的 AI 助手使用。包括：图表/截图中的关键信息、界面元素与文字、照片中的场景要点。直接输出转写内容，不要寒暄。";

export class VisionBridge {
	private readonly configFile: string;
	private config: VisionBridgeConfig;
	private readonly runtime: BridgeModelRuntime;
	private readonly cache = new Map<string, string>();

	constructor(dataDir: string, runtime: BridgeModelRuntime) {
		this.runtime = runtime;
		this.configFile = join(dataDir, "vision-bridge.json");
		this.config = { enabled: true, provider: null, modelId: null };
		try {
			if (existsSync(this.configFile)) {
				const raw = JSON.parse(readFileSync(this.configFile, "utf8")) as Partial<VisionBridgeConfig>;
				this.config = {
					enabled: raw.enabled !== false,
					provider: typeof raw.provider === "string" ? raw.provider : null,
					modelId: typeof raw.modelId === "string" ? raw.modelId : null,
				};
			}
		} catch {
			/* 配置损坏时使用默认值 */
		}
	}

	getConfig(): VisionBridgeConfig & { resolved: { provider: string; modelId: string } | null } {
		return { ...this.config, resolved: this.resolveModel() };
	}

	setConfig(update: Partial<VisionBridgeConfig>): VisionBridgeConfig {
		if (update.enabled !== undefined) this.config.enabled = update.enabled === true;
		if (update.provider !== undefined)
			this.config.provider = typeof update.provider === "string" && update.provider ? update.provider : null;
		if (update.modelId !== undefined)
			this.config.modelId = typeof update.modelId === "string" && update.modelId ? update.modelId : null;
		writeFileSync(this.configFile, `${JSON.stringify(this.config, null, "\t")}\n`, "utf8");
		return { ...this.config };
	}

	private resolveModel(): { provider: string; modelId: string } | null {
		if (this.config.provider && this.config.modelId) {
			const model = this.runtime.getModel(this.config.provider, this.config.modelId);
			if (model?.input.includes("image")) {
				return { provider: this.config.provider, modelId: this.config.modelId };
			}
			return null;
		}
		// 自动选择：第一个已配置鉴权且支持图片的模型
		for (const provider of this.runtime.getProviders()) {
			if (!this.runtime.hasConfiguredAuth(provider.id)) continue;
			for (const model of this.runtime.getModels(provider.id)) {
				if (model.input.includes("image")) return { provider: provider.id, modelId: model.id };
			}
		}
		return null;
	}

	/** 列出可指定的视觉模型（设置面板用）。 */
	listVisionModels(): Array<{ provider: string; modelId: string; label: string; hasAuth: boolean }> {
		const items: Array<{ provider: string; modelId: string; label: string; hasAuth: boolean }> = [];
		for (const provider of this.runtime.getProviders()) {
			const hasAuth = this.runtime.hasConfiguredAuth(provider.id);
			for (const model of this.runtime.getModels(provider.id)) {
				if (model.input.includes("image")) {
					items.push({
						provider: provider.id,
						modelId: model.id,
						label: `${provider.id} · ${model.name ?? model.id}`,
						hasAuth,
					});
				}
			}
		}
		return items;
	}

	/**
	 * 把图片转写成文字。命中缓存直接返回；桥未启用或无可用视觉模型时抛错。
	 * 返回 null 表示不需要转写（不应发生在调用方已判断 model 不支持图片之后）。
	 */
	async transcribe(image: ImageContent, signal?: AbortSignal): Promise<string> {
		if (!this.config.enabled) throw new Error("视觉桥未启用");
		const target = this.resolveModel();
		if (!target) throw new Error("没有可用的视觉模型（可在设置中指定或先配置一个支持图片的模型）");
		const model = this.runtime.getModel(target.provider, target.modelId);
		if (!model) throw new Error("视觉桥模型已不可用，请在设置中重新选择");
		const hash = createHash("sha256")
			.update(`${target.provider}/${target.modelId}`)
			.update(typeof image.data === "string" ? image.data : "")
			.digest("hex");
		const cached = this.cache.get(hash);
		if (cached !== undefined) return cached;
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [image, { type: "text", text: TRANSCRIBE_PROMPT }],
					timestamp: Date.now(),
				},
			],
		};
		const message = await this.runtime.complete(model, context, { signal });
		const text = (message.content ?? [])
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text)
			.join("\n")
			.trim();
		if (!text) throw new Error("视觉模型没有返回转写内容");
		if (this.cache.size >= MAX_CACHE_ENTRIES) {
			const oldest = this.cache.keys().next().value;
			if (oldest !== undefined) this.cache.delete(oldest);
		}
		this.cache.set(hash, text);
		return text;
	}
}

/** 当前模型是否支持图片输入。 */
export function modelSupportsImages(model: { input?: Array<string> } | null | undefined): boolean {
	return Array.isArray(model?.input) && model.input.includes("image");
}
