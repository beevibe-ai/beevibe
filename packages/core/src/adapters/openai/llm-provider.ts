import OpenAI from "openai";
import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStructuredRequest,
  LlmStructuredResponse,
  LlmUsage,
} from "../../ports/llm-provider.js";

const DEFAULT_MODEL = "gpt-4o-mini";

export interface OpenAILlmProviderConfig {
  apiKey?: string;
  defaultModel?: string;
  timeoutMs?: number;
}

/**
 * OpenAI chat completions adapter. `completeStructured` uses strict JSON
 * schema mode (`response_format.type = "json_schema"` with `strict: true`),
 * which the API enforces server-side — returned text is guaranteed to parse
 * as JSON matching the schema.
 */
export class OpenAILlmProvider implements LlmProvider {
  readonly type = "openai";

  private client: OpenAI;
  private defaultModel: string;

  constructor(config: OpenAILlmProviderConfig = {}) {
    const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OpenAILlmProvider: OPENAI_API_KEY missing");
    }
    this.client = new OpenAI({
      apiKey,
      timeout: config.timeoutMs ?? 30_000,
    });
    this.defaultModel = config.defaultModel ?? DEFAULT_MODEL;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const response = await this.client.chat.completions.create({
      model: req.model ?? this.defaultModel,
      max_completion_tokens: req.maxTokens,
      temperature: req.temperature ?? 0.2,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.prompt },
      ],
    });
    const choice = response.choices[0];
    return {
      text: choice?.message.content ?? "",
      usage: buildUsage(response),
      stop_reason: choice?.finish_reason ?? undefined,
    };
  }

  async completeStructured<T>(
    req: LlmStructuredRequest,
  ): Promise<LlmStructuredResponse<T>> {
    const response = await this.client.chat.completions.create({
      model: req.model ?? this.defaultModel,
      max_completion_tokens: req.maxTokens,
      temperature: req.temperature ?? 0,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.prompt },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: req.schema_name,
          description: req.schema_description,
          schema: req.schema,
          strict: true,
        },
      },
    });
    const choice = response.choices[0];
    const text = choice?.message.content ?? "{}";
    return {
      value: JSON.parse(text) as T,
      usage: buildUsage(response),
      stop_reason: choice?.finish_reason ?? undefined,
    };
  }
}

function buildUsage(response: OpenAI.Chat.Completions.ChatCompletion): LlmUsage {
  return {
    input_tokens: response.usage?.prompt_tokens ?? 0,
    output_tokens: response.usage?.completion_tokens ?? 0,
    model: response.model,
  };
}
