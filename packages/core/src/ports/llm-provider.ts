/**
 * LLM provider for the memory subsystem (fact merging, fact promotion,
 * and any future classification). Not used for agent sessions — those
 * run through AgentRuntime, which spawns the Claude CLI directly.
 *
 * Two call paths:
 * - `complete` for free-form text (e.g. fact merging).
 * - `completeStructured<T>` for schema-guaranteed JSON (e.g. fact promotion).
 *   Adapters MUST use the provider's native structured-output feature:
 *   Anthropic `output_config.format.type = "json_schema"`, OpenAI
 *   `response_format.type = "json_schema"` with `strict: true`. No
 *   prompt-engineering retries — the schema is guaranteed by the API.
 */
export interface LlmProvider {
  /** Identifier for this provider (e.g. "anthropic", "openai"). */
  readonly type: string;

  /** Free-form text completion. */
  complete(req: LlmRequest): Promise<LlmResponse>;

  /**
   * Schema-constrained completion. The returned `value` is guaranteed to
   * conform to `schema` by the provider's native structured-output feature.
   * Callers get typed results without runtime validation plumbing.
   */
  completeStructured<T>(req: LlmStructuredRequest): Promise<LlmStructuredResponse<T>>;
}

export interface LlmRequest {
  /** System-prompt text (goes in the top-level `system` field for Anthropic,
   *  and the `system` message for OpenAI). */
  system: string;
  /** User-prompt text (the single user turn). */
  prompt: string;
  /** Hard cap on completion tokens. */
  maxTokens: number;
  /** Sampling temperature. Default varies by adapter (typically 0.2). */
  temperature?: number;
  /** Override the adapter's default model (e.g. "claude-haiku-4-5-20251001"). */
  model?: string;
}

export interface LlmStructuredRequest extends LlmRequest {
  /** Short identifier for the schema (used as the tool name on OpenAI's side). */
  schema_name: string;
  /** Human-readable description of what the structured output represents. */
  schema_description: string;
  /** JSON schema describing the expected output. */
  schema: Record<string, unknown>;
}

export interface LlmResponse {
  text: string;
  usage: LlmUsage;
  stop_reason?: string;
}

export interface LlmStructuredResponse<T> {
  value: T;
  usage: LlmUsage;
  stop_reason?: string;
}

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
  /** Undefined when the provider doesn't return pricing (Anthropic). */
  cost_usd?: number;
  model: string;
}
