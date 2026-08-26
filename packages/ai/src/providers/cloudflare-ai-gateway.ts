import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { createProvider, type Provider } from "../models.ts";
import { CLOUDFLARE_AI_GATEWAY_MODELS } from "./cloudflare-ai-gateway.models.ts";
import { cloudflareAIGatewayAuth } from "./cloudflare-auth.ts";
import { cloudflareStreams } from "./cloudflare-stream.ts";

// models.dev 的 gateway 目录已不再收录 openai-completions 分组（含 workers-ai/*
// 透传模型），provider 能力随数据收窄为 anthropic-messages + openai-responses。
export function cloudflareAIGatewayProvider(): Provider<"anthropic-messages" | "openai-responses"> {
	return createProvider({
		id: "cloudflare-ai-gateway",
		name: "Cloudflare AI Gateway",
		auth: { apiKey: cloudflareAIGatewayAuth() },
		models: Object.values(CLOUDFLARE_AI_GATEWAY_MODELS),
		api: {
			"anthropic-messages": cloudflareStreams(anthropicMessagesApi()),
			"openai-responses": cloudflareStreams(openAIResponsesApi()),
		},
	});
}
