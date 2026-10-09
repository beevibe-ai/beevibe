/**
 * Shared construction helpers for the hosted-API provider adapters
 * (`anthropic/llm-provider`, `openai/llm-provider`, `openai/embeddings`).
 *
 * Unlike the CLI runtimes in `runtime-common.ts`, these adapters have very
 * little in common at the call layer — each speaks a different SDK's request
 * shape. What they did share, written out three times, was the constructor
 * preamble that resolves credentials and the default model.
 */

/**
 * Resolve an adapter's API key: an explicit `config.apiKey` wins, otherwise
 * the environment variable, otherwise throw.
 *
 * Failing in the constructor rather than on the first request is deliberate —
 * these adapters are built at composition-root time, so a missing key
 * surfaces at boot instead of hours later inside a dispatch.
 *
 * The thrown message names the adapter, the variable, and both ways to supply
 * it. All three copies named the adapter and the variable; only
 * `OpenAIEmbeddingService` added the "how to fix it" clause, which is the part
 * someone staring at a boot failure actually needs — so that is now the one
 * wording. No test or consumer matches on these strings (unlike
 * `bareCliExitMessage`, which has a parser pinned to it).
 */
export function requireApiKey(
  adapter: string,
  envVar: string,
  override: string | undefined,
): string {
  const apiKey = override ?? process.env[envVar];
  if (!apiKey) {
    throw new Error(`${adapter}: ${envVar} missing (pass apiKey or set env var)`);
  }
  return apiKey;
}
