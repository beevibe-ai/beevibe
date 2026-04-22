import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { OpenAIEmbeddingService } from "./embeddings.js";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../../../.env") });

describe("OpenAIEmbeddingService", () => {
  it("embeds a single string to a 1536-dim vector", async () => {
    const svc = new OpenAIEmbeddingService();
    const v = await svc.embed("Beevibe uses pgvector with the HNSW index.");
    expect(v).toHaveLength(1536);
    // Should be roughly unit-length (OpenAI normalizes embeddings).
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeGreaterThan(0.9);
    expect(norm).toBeLessThan(1.1);
  });

  it("embedBatch preserves order across N inputs", async () => {
    const svc = new OpenAIEmbeddingService();
    const vs = await svc.embedBatch(["dog", "cat", "pnpm is preferred over npm"]);
    expect(vs).toHaveLength(3);
    vs.forEach((v) => expect(v).toHaveLength(1536));
    // "dog" should be much closer to "cat" than to the package-manager sentence.
    const cos = (a: number[], b: number[]): number => {
      let d = 0;
      for (let i = 0; i < a.length; i++) d += a[i]! * b[i]!;
      return d;
    };
    const simDogCat = cos(vs[0]!, vs[1]!);
    const simDogPkg = cos(vs[0]!, vs[2]!);
    expect(simDogCat).toBeGreaterThan(simDogPkg);
  });

  it("throws when no API key is configured", () => {
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "";
    try {
      expect(() => new OpenAIEmbeddingService()).toThrow(/OPENAI_API_KEY/);
    } finally {
      process.env.OPENAI_API_KEY = saved;
    }
  });

  it("reports its identity via the `type` field", () => {
    const svc = new OpenAIEmbeddingService();
    expect(svc.type).toBe("openai:text-embedding-3-small");
  });

  it("embedBatch([]) returns [] without hitting the API", async () => {
    // Deliberately break the key so we'd get a 401 if we actually called out.
    const svc = new OpenAIEmbeddingService({ apiKey: "sk-broken" });
    await expect(svc.embedBatch([])).resolves.toEqual([]);
  });
});
