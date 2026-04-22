import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { AnthropicLlmProvider } from "./llm-provider.js";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../../../.env") });

describe("AnthropicLlmProvider", () => {
  it("complete returns assistant text and token usage", async () => {
    const llm = new AnthropicLlmProvider();
    const res = await llm.complete({
      system: "You answer with a single word.",
      prompt: "Return the word 'ok' with no punctuation.",
      maxTokens: 20,
      temperature: 0,
    });
    expect(res.text.toLowerCase()).toContain("ok");
    expect(res.usage.input_tokens).toBeGreaterThan(0);
    expect(res.usage.output_tokens).toBeGreaterThan(0);
    expect(res.usage.model).toMatch(/^claude-/);
    expect(res.usage.cost_usd).toBeUndefined();
  }, 30_000);

  it("completeStructured returns a typed object conforming to the schema", async () => {
    const llm = new AnthropicLlmProvider();
    interface ColorPref {
      color: string;
      confidence: number;
    }
    const res = await llm.completeStructured<ColorPref>({
      system: "You extract the user's color preference from a short statement.",
      prompt: "I really love the color green. It makes me happy.",
      maxTokens: 100,
      temperature: 0,
      schema_name: "color_preference",
      schema_description: "The user's stated color preference.",
      schema: {
        type: "object",
        properties: {
          color: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["color", "confidence"],
        additionalProperties: false,
      },
    });
    expect(typeof res.value.color).toBe("string");
    expect(res.value.color.toLowerCase()).toContain("green");
    expect(typeof res.value.confidence).toBe("number");
    expect(res.usage.input_tokens).toBeGreaterThan(0);
  }, 30_000);

  it("throws when no API key is configured", () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "";
    try {
      expect(() => new AnthropicLlmProvider()).toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it("reports its identity via the type field", () => {
    const llm = new AnthropicLlmProvider();
    expect(llm.type).toBe("anthropic");
  });
});
