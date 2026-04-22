/**
 * Vector-embedding provider. Maps natural-language text to a fixed-dimension
 * dense vector suitable for cosine similarity search against memory_fact.embedding.
 *
 * The production adapter is OpenAI text-embedding-3-small (1536 dims), but the
 * port is dimension-agnostic — the embedding column in Postgres is VECTOR(1536)
 * so the adapter must return vectors of that length.
 */
export interface EmbeddingService {
  /** Identifier for this embedding source (e.g. "openai:text-embedding-3-small"). */
  readonly type: string;

  /** Embed a single string. */
  embed(text: string): Promise<number[]>;

  /**
   * Embed many strings in one request. Adapters may chunk internally
   * (OpenAI accepts up to 2048 inputs per request). Result order matches
   * input order.
   */
  embedBatch(texts: string[]): Promise<number[][]>;
}
