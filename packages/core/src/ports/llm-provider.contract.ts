import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import type { LlmProvider } from "./llm-provider.js";

/**
 * The shared contract suite for {@link LlmProvider} implementations.
 *
 * `adapters/anthropic/llm-provider.test.ts` and
 * `adapters/openai/llm-provider.test.ts` were 64-line twins — the
 * largest clone in the repo — differing in exactly four values: the
 * class, the `usage.model` prefix, the api-key env var, and the describe
 * label. Everything they asserted was the port's contract, not either
 * provider's specifics, so it belongs in one place: a third adapter
 * (the port has `type` room for more) now inherits the whole suite
 * instead of starting from a copy-paste, and a contract change lands
 * once rather than twice-minus-the-one-you-forgot.
 *
 * These make real API calls. They are gated on a key being present the
 * same way they always were — by failing loudly when it isn't, which is
 * this repo's convention (there is no `describe.skipIf` here; see
 * CONTRIBUTING).
 *
 * Lives under `ports/` rather than beside either adapter because it is
 * the port's suite. `tsconfig.json` excludes the `.contract.ts` suffix
 * alongside `.test.ts`, so this file's vitest import never reaches
 * `dist/`.
 */

// Resolve the repo-root .env regardless of cwd, as each of the two test
// files did for itself.
const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../../.env") });

export interface LlmProviderContractOptions {
  /** Describe label — the implementation's class name. */
  name: string;
  /** Construct the provider under test. Called per-case, as before. */
  make: () => LlmProvider;
  /** Expected shape of `usage.model`, e.g. `/^claude-/`. */
  modelPattern: RegExp;
  /**
   * The env var the constructor reads. Asserted two ways: that an
   * absent key throws, and that the thrown message names the variable
   * so the operator knows which one to set.
   */
  apiKeyEnv: string;
}

export function describeLlmProviderContract(opts: LlmProviderContractOptions): void {
  describe(opts.name, () => {
    it("complete returns assistant text and token usage", async () => {
      const llm = opts.make();
      const res = await llm.complete({
        system: "You answer with a single word.",
        prompt: "Return the word 'ok' with no punctuation.",
        maxTokens: 20,
        temperature: 0,
      });
      expect(res.text.toLowerCase()).toContain("ok");
      expect(res.usage.input_tokens).toBeGreaterThan(0);
      expect(res.usage.output_tokens).toBeGreaterThan(0);
      expect(res.usage.model).toMatch(opts.modelPattern);
      // Neither SDK surfaces pricing, so the port leaves this undefined
      // and callers that track cost compute it from model + tokens.
      expect(res.usage.cost_usd).toBeUndefined();
    }, 30_000);

    it("completeStructured returns a typed object conforming to the schema", async () => {
      const llm = opts.make();
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
      const saved = process.env[opts.apiKeyEnv];
      process.env[opts.apiKeyEnv] = "";
      try {
        expect(() => opts.make()).toThrow(new RegExp(opts.apiKeyEnv));
      } finally {
        process.env[opts.apiKeyEnv] = saved;
      }
    });
  });
}
