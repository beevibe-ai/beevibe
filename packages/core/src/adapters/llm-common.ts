/**
 * Shared construction helper for the SDK-backed `LlmProvider` adapters
 * (anthropic, openai). Both wrap a vendor SDK client and differ genuinely in
 * everything downstream of the constructor — request shape, structured-output
 * feature, usage field names — so only the setup is shared here. The
 * per-provider request mapping stays in each adapter's `llm-provider.ts`.
 */

/**
 * Constructor config accepted by every LLM provider adapter.
 *
 * `AnthropicLlmProviderConfig` and `OpenAILlmProviderConfig` were separately
 * declared and structurally identical; both are now aliases of this, so a new
 * knob is added once rather than twice-and-hopefully-consistently.
 */
export interface LlmProviderConfig {
  /** Falls back to the provider's API-key env var. */
  apiKey?: string;
  /** Override the adapter's default model. */
  defaultModel?: string;
  /** Per-request timeout (ms). Default {@link DEFAULT_LLM_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** Per-request timeout every provider defaults to. */
export const DEFAULT_LLM_TIMEOUT_MS = 30_000;

export interface LlmProviderSpec {
  /** Adapter class name, used in the missing-key error. */
  providerName: string;
  /** Env var consulted when `config.apiKey` is absent. */
  apiKeyEnvVar: string;
  /** Model used when neither the config nor the request names one. */
  defaultModel: string;
}

/**
 * Resolve the three constructor settings, throwing when no API key can be
 * found. Both adapters spelled this out identically — env fallback, throw
 * `"<Provider>: <ENV_VAR> missing"`, `?? 30_000`, `?? DEFAULT_MODEL` — which
 * is four chances for the timeout default to drift apart between providers
 * and for the two error strings to stop matching each other's format.
 *
 * Throws rather than returning a result type because a provider with no key
 * is unusable: `bootstrap` constructs these eagerly and a missing key is a
 * deployment error, not a runtime branch.
 */
export function resolveLlmProviderConfig(
  config: LlmProviderConfig,
  spec: LlmProviderSpec,
): { apiKey: string; timeoutMs: number; defaultModel: string } {
  const apiKey = config.apiKey ?? process.env[spec.apiKeyEnvVar];
  if (!apiKey) {
    throw new Error(`${spec.providerName}: ${spec.apiKeyEnvVar} missing`);
  }
  return {
    apiKey,
    timeoutMs: config.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
    defaultModel: config.defaultModel ?? spec.defaultModel,
  };
}
