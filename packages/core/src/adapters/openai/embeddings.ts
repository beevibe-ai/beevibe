import OpenAI from "openai";
import type { EmbeddingService } from "../../ports/embedding-service.js";

const MODEL = "text-embedding-3-small";
const DIMENSIONS = 1536;
const BATCH_SIZE = 2048;
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [200, 1000];

export interface OpenAIEmbeddingServiceConfig {
  /** Override the `OPENAI_API_KEY` env var. */
  apiKey?: string;
  /** Per-request timeout (ms). Default 15_000. */
  timeoutMs?: number;
}

/**
 * OpenAI text-embedding-3-small adapter.
 *
 * Produces 1536-dim vectors compatible with `memory_fact.embedding VECTOR(1536)`.
 * Batches large inputs (up to 2048 per request) and retries on 429 / 5xx / transient
 * network errors with exponential backoff [200ms, 1000ms], max 3 attempts.
 */
export class OpenAIEmbeddingService implements EmbeddingService {
  readonly type = `openai:${MODEL}`;

  private client: OpenAI;

  constructor(config: OpenAIEmbeddingServiceConfig = {}) {
    const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OpenAIEmbeddingService: OPENAI_API_KEY missing (pass apiKey or set env var)",
      );
    }
    this.client = new OpenAI({
      apiKey,
      timeout: config.timeoutMs ?? 15_000,
      maxRetries: 0, // we handle retries ourselves
    });
  }

  async embed(text: string): Promise<number[]> {
    const [v] = await this.embedBatch([text]);
    return v!;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const results: number[][] = new Array<number[]>(texts.length);
    for (let start = 0; start < texts.length; start += BATCH_SIZE) {
      const chunk = texts.slice(start, start + BATCH_SIZE);
      const response = await withRetry(() =>
        this.client.embeddings.create({
          model: MODEL,
          input: chunk,
          dimensions: DIMENSIONS,
        }),
      );
      for (const item of response.data) {
        results[start + item.index] = item.embedding;
      }
    }
    return results;
  }
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === MAX_ATTEMPTS - 1) throw err;
      await sleep(RETRY_DELAYS_MS[attempt]!);
    }
  }
  throw lastErr;
}

function isRetryable(err: unknown): boolean {
  if (err instanceof OpenAI.APIError) {
    const s = err.status ?? 0;
    return s === 429 || s >= 500;
  }
  const msg = (err as Error)?.message ?? "";
  return /ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN/.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
