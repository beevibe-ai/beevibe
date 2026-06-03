import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStructuredRequest,
  LlmStructuredResponse,
  LlmUsage,
} from "../../ports/llm-provider.js";

/**
 * Local model adapter (Ollama). Used for the alignment-meeting digest: reading
 * each specialist's memory and distilling a plain-language card. The work is
 * high-volume, repetitive, and privacy-sensitive (an agent's internal state),
 * so it runs on a small local model instead of burning hosted tokens.
 *
 * Mirrors the interview-prep-coach `/api/chat` integration: non-streaming,
 * retry-on-empty (small models occasionally return blanks), env-driven base
 * URL + model.
 *
 * `completeStructured` uses Ollama's native `format` field — pass a JSON schema
 * and the server constrains generation to it (the local equivalent of the
 * OpenAI/Anthropic json_schema modes). gemma3:4b honors this well enough for
 * the flat digest schema; we still JSON.parse defensively and retry on a blank.
 */

const DEFAULT_BASE_URL = "http://localhost:11434";
const DEFAULT_MODEL = "gemma3:4b";
const DEFAULT_NUM_CTX = 8192;
const MAX_EMPTY_RETRIES = 3;

export interface OllamaLlmProviderConfig {
  /** Default `OLLAMA_BASE_URL` env or `http://localhost:11434`. */
  baseUrl?: string;
  /** Default `OLLAMA_MODEL` env or `gemma3:4b`. */
  defaultModel?: string;
  /** Context window passed as `options.num_ctx`. Default 8192. */
  numCtx?: number;
  /** Per-request timeout (ms). Default 60_000 — local models are slower. */
  timeoutMs?: number;
}

interface OllamaChatResponse {
  message?: { content?: string };
  model?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaLlmProvider implements LlmProvider {
  readonly type = "ollama";

  private baseUrl: string;
  private defaultModel: string;
  private numCtx: number;
  private timeoutMs: number;

  constructor(config: OllamaLlmProviderConfig = {}) {
    this.baseUrl = (
      config.baseUrl ??
      process.env.OLLAMA_BASE_URL ??
      DEFAULT_BASE_URL
    ).replace(/\/$/, "");
    this.defaultModel =
      config.defaultModel ?? process.env.OLLAMA_MODEL ?? DEFAULT_MODEL;
    this.numCtx = config.numCtx ?? DEFAULT_NUM_CTX;
    this.timeoutMs = config.timeoutMs ?? 60_000;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const { text, raw } = await this.chat({
      model: req.model ?? this.defaultModel,
      system: req.system,
      prompt: req.prompt,
      temperature: req.temperature ?? 0.2,
    });
    return {
      text,
      usage: buildUsage(raw, req.model ?? this.defaultModel),
      stop_reason: "stop",
    };
  }

  async completeStructured<T>(
    req: LlmStructuredRequest,
  ): Promise<LlmStructuredResponse<T>> {
    const model = req.model ?? this.defaultModel;
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_EMPTY_RETRIES; attempt++) {
      const { text, raw } = await this.chat({
        model,
        system: req.system,
        prompt: req.prompt,
        temperature: req.temperature ?? 0,
        format: req.schema,
      });
      try {
        const value = JSON.parse(text) as T;
        return {
          value,
          usage: buildUsage(raw, model),
          stop_reason: "stop",
        };
      } catch (err) {
        // Small models occasionally emit a fenced or truncated blob even with
        // `format` set. Strip fences once, then fall through to a retry.
        const cleaned = stripJsonFence(text);
        if (cleaned !== text) {
          try {
            return {
              value: JSON.parse(cleaned) as T,
              usage: buildUsage(raw, model),
              stop_reason: "stop",
            };
          } catch {
            /* retry */
          }
        }
        lastErr = err;
      }
    }
    throw new Error(
      `OllamaLlmProvider: model "${model}" did not return valid JSON after ` +
        `${MAX_EMPTY_RETRIES} attempts. ${
          lastErr instanceof Error ? lastErr.message : String(lastErr)
        }`,
    );
  }

  private async chat(args: {
    model: string;
    system: string;
    prompt: string;
    temperature: number;
    format?: Record<string, unknown>;
  }): Promise<{ text: string; raw: OllamaChatResponse }> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_EMPTY_RETRIES; attempt++) {
      const raw = await this.postChat(args);
      const text = raw.message?.content?.trim() ?? "";
      if (text.length > 0) return { text, raw };
      lastErr = new Error("empty completion");
    }
    throw new Error(
      `OllamaLlmProvider: model "${args.model}" returned empty after ` +
        `${MAX_EMPTY_RETRIES} attempts. ${
          lastErr instanceof Error ? lastErr.message : String(lastErr)
        }`,
    );
  }

  private async postChat(args: {
    model: string;
    system: string;
    prompt: string;
    temperature: number;
    format?: Record<string, unknown>;
  }): Promise<OllamaChatResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: args.model,
          stream: false,
          messages: [
            { role: "system", content: args.system },
            { role: "user", content: args.prompt },
          ],
          ...(args.format ? { format: args.format } : {}),
          options: { temperature: args.temperature, num_ctx: this.numCtx },
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `Ollama request failed (${res.status}). Is "${args.model}" pulled ` +
            `(ollama pull ${args.model})? ${detail}`,
        );
      }
      return (await res.json()) as OllamaChatResponse;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(
          `Ollama request timed out after ${this.timeoutMs}ms at ${this.baseUrl}. ` +
            `Is "ollama serve" running?`,
        );
      }
      if (err instanceof TypeError) {
        throw new Error(
          `Could not reach Ollama at ${this.baseUrl}. Start it with ` +
            `"ollama serve" and pull the model (ollama pull ${args.model}).`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

function stripJsonFence(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function buildUsage(raw: OllamaChatResponse, model: string): LlmUsage {
  return {
    input_tokens: raw.prompt_eval_count ?? 0,
    output_tokens: raw.eval_count ?? 0,
    model: raw.model ?? model,
  };
}
