import Anthropic from "@anthropic-ai/sdk";
import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStructuredRequest,
  LlmStructuredResponse,
  LlmUsage,
} from "../../ports/llm-provider.js";
import { resolveLlmProviderConfig, type LlmProviderConfig } from "../llm-common.js";

/**
 * Default model for the memory subsystem. Haiku is cheap + fast and more than
 * adequate for classification (promotion) and short-text merging tasks.
 */
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

/**
 * Alias of the shared {@link LlmProviderConfig}. Kept as a named export
 * because `adapters/anthropic/index.ts` re-exports it as public API;
 * `defaultModel` overrides {@link DEFAULT_MODEL}, useful when a caller wants
 * Opus for harder calls.
 */
export type AnthropicLlmProviderConfig = LlmProviderConfig;

/**
 * Anthropic Messages API adapter. `completeStructured` uses the native
 * `output_config.format.type = "json_schema"` feature — the API guarantees
 * the returned text parses as JSON conforming to the provided schema, so no
 * retry-on-malformed plumbing is needed here.
 *
 * `cost_usd` is always undefined on the usage object: the Anthropic SDK does
 * not surface pricing. Callers that need cost tracking must compute it from
 * the model + token counts externally.
 */
export class AnthropicLlmProvider implements LlmProvider {
  readonly type = "anthropic";

  private client: Anthropic;
  private defaultModel: string;

  constructor(config: AnthropicLlmProviderConfig = {}) {
    const resolved = resolveLlmProviderConfig(config, {
      providerName: "AnthropicLlmProvider",
      apiKeyEnvVar: "ANTHROPIC_API_KEY",
      defaultModel: DEFAULT_MODEL,
    });
    this.client = new Anthropic({
      apiKey: resolved.apiKey,
      timeout: resolved.timeoutMs,
    });
    this.defaultModel = resolved.defaultModel;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const response = await this.client.messages.create({
      model: req.model ?? this.defaultModel,
      max_tokens: req.maxTokens,
      system: req.system,
      temperature: req.temperature ?? 0.2,
      messages: [{ role: "user", content: req.prompt }],
    });
    return {
      text: extractText(response.content),
      usage: buildUsage(response),
      stop_reason: response.stop_reason ?? undefined,
    };
  }

  async completeStructured<T>(
    req: LlmStructuredRequest,
  ): Promise<LlmStructuredResponse<T>> {
    const response = await this.client.messages.create({
      model: req.model ?? this.defaultModel,
      max_tokens: req.maxTokens,
      system: req.system,
      temperature: req.temperature ?? 0,
      messages: [{ role: "user", content: req.prompt }],
      output_config: {
        format: { type: "json_schema", schema: req.schema },
      },
    });
    const text = extractText(response.content);
    return {
      value: JSON.parse(text) as T,
      usage: buildUsage(response),
      stop_reason: response.stop_reason ?? undefined,
    };
  }
}

function extractText(content: Anthropic.Messages.Message["content"]): string {
  return content
    .filter((block): block is Anthropic.Messages.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function buildUsage(response: Anthropic.Messages.Message): LlmUsage {
  return {
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    model: response.model,
  };
}
