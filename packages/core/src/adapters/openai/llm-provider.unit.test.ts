/**
 * OpenAILlmProvider — keyless unit tests against a mocked SDK.
 *
 * `llm-provider.test.ts` next to this file needs OPENAI_API_KEY and calls
 * the live API, so in a keyless environment this adapter had no coverage at
 * all. What's ours to get right is the request we build (strict json_schema
 * mode, the temperature defaults, system/user message split) and how we read
 * the response back (empty-content fallbacks, usage mapping) — all of which
 * is exercised here with no network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ create: vi.fn(), ctorArgs: [] as unknown[] }));

vi.mock("openai", () => {
  class FakeOpenAI {
    chat = { completions: { create: h.create } };
    constructor(opts: unknown) {
      h.ctorArgs.push(opts);
    }
  }
  return { default: FakeOpenAI };
});

const { OpenAILlmProvider } = await import("./llm-provider.js");

function completion(
  overrides: {
    content?: string | null;
    finish_reason?: string | null;
    usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
    model?: string;
    choices?: unknown[];
  } = {},
) {
  return {
    model: overrides.model ?? "gpt-4o-mini-2024-07-18",
    choices:
      overrides.choices ??
      [
        {
          message: {
            content: "content" in overrides ? overrides.content : "hello",
          },
          finish_reason:
            overrides.finish_reason === undefined ? "stop" : overrides.finish_reason,
        },
      ],
    usage:
      overrides.usage === null
        ? undefined
        : { prompt_tokens: 11, completion_tokens: 3, ...overrides.usage },
  };
}

function provider(config: Record<string, unknown> = {}) {
  return new OpenAILlmProvider({ apiKey: "sk-test", ...config });
}

const REQ = { system: "You are terse.", prompt: "Say hi.", maxTokens: 64 };

beforeEach(() => {
  h.create.mockReset();
  h.ctorArgs.length = 0;
});

describe("OpenAILlmProvider construction", () => {
  it("defaults the timeout to 30s", () => {
    provider();
    expect(h.ctorArgs[0]).toMatchObject({ apiKey: "sk-test", timeout: 30_000 });
  });

  it("honors a custom timeout", () => {
    provider({ timeoutMs: 5_000 });
    expect(h.ctorArgs[0]).toMatchObject({ timeout: 5_000 });
  });

  it("falls back to OPENAI_API_KEY, and throws when there is none", () => {
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-from-env";
    try {
      new OpenAILlmProvider();
      expect(h.ctorArgs[0]).toMatchObject({ apiKey: "sk-from-env" });

      delete process.env.OPENAI_API_KEY;
      expect(() => new OpenAILlmProvider()).toThrow(/OPENAI_API_KEY/);
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
    }
  });

  it("reports its provider type", () => {
    expect(provider().type).toBe("openai");
  });
});

describe("OpenAILlmProvider.complete", () => {
  it("splits system and prompt into two messages and defaults temperature to 0.2", async () => {
    h.create.mockResolvedValue(completion());
    await provider().complete(REQ);

    expect(h.create).toHaveBeenCalledWith({
      model: "gpt-4o-mini",
      max_completion_tokens: 64,
      temperature: 0.2,
      messages: [
        { role: "system", content: REQ.system },
        { role: "user", content: REQ.prompt },
      ],
    });
  });

  it("returns the text, usage and stop reason", async () => {
    h.create.mockResolvedValue(completion({ content: "hi", finish_reason: "length" }));

    await expect(provider().complete(REQ)).resolves.toEqual({
      text: "hi",
      usage: {
        input_tokens: 11,
        output_tokens: 3,
        model: "gpt-4o-mini-2024-07-18",
      },
      stop_reason: "length",
    });
  });

  it("honors an explicit model and temperature", async () => {
    h.create.mockResolvedValue(completion());
    await provider().complete({ ...REQ, model: "gpt-4o", temperature: 0.9 });

    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-4o", temperature: 0.9 }),
    );
  });

  it("uses a configured default model when the request omits one", async () => {
    h.create.mockResolvedValue(completion());
    await provider({ defaultModel: "gpt-4o" }).complete(REQ);

    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-4o" }));
  });

  // temperature 0 is a meaningful value, not an absent one — `?? 0.2` is
  // correct here where `|| 0.2` would silently rewrite it.
  it("passes temperature 0 through rather than defaulting it", async () => {
    h.create.mockResolvedValue(completion());
    await provider().complete({ ...REQ, temperature: 0 });

    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ temperature: 0 }));
  });

  it.each([
    ["null content", { content: null }],
    ["no choices at all", { choices: [] }],
  ])("falls back to an empty string on %s", async (_label, overrides) => {
    h.create.mockResolvedValue(completion(overrides));

    const result = await provider().complete(REQ);
    expect(result.text).toBe("");
  });

  it("leaves stop_reason undefined when the API reports none", async () => {
    h.create.mockResolvedValue(completion({ finish_reason: null }));

    const result = await provider().complete(REQ);
    expect(result.stop_reason).toBeUndefined();
  });

  it("zeroes the token counts when usage is absent", async () => {
    h.create.mockResolvedValue(completion({ usage: null }));

    const result = await provider().complete(REQ);
    expect(result.usage).toMatchObject({ input_tokens: 0, output_tokens: 0 });
  });
});

describe("OpenAILlmProvider.completeStructured", () => {
  const STRUCTURED = {
    ...REQ,
    schema_name: "promotion",
    schema_description: "whether to promote the fact",
    schema: { type: "object", properties: { promote: { type: "boolean" } } },
  };

  it("requests strict json_schema mode and defaults temperature to 0", async () => {
    h.create.mockResolvedValue(completion({ content: '{"promote":true}' }));
    await provider().completeStructured(STRUCTURED);

    expect(h.create).toHaveBeenCalledWith({
      model: "gpt-4o-mini",
      max_completion_tokens: 64,
      // Structured extraction wants determinism, so the default differs
      // from `complete`.
      temperature: 0,
      messages: [
        { role: "system", content: REQ.system },
        { role: "user", content: REQ.prompt },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "promotion",
          description: STRUCTURED.schema_description,
          schema: STRUCTURED.schema,
          // Without strict:true the API stops enforcing the schema and
          // JSON.parse below becomes a coin flip.
          strict: true,
        },
      },
    });
  });

  it("parses the content into the typed value alongside usage", async () => {
    h.create.mockResolvedValue(completion({ content: '{"promote":true}' }));

    await expect(
      provider().completeStructured<{ promote: boolean }>(STRUCTURED),
    ).resolves.toEqual({
      value: { promote: true },
      usage: {
        input_tokens: 11,
        output_tokens: 3,
        model: "gpt-4o-mini-2024-07-18",
      },
      stop_reason: "stop",
    });
  });

  it.each([
    ["null content", { content: null }],
    ["no choices", { choices: [] }],
  ])("falls back to an empty object on %s", async (_label, overrides) => {
    h.create.mockResolvedValue(completion(overrides));

    const result = await provider().completeStructured(STRUCTURED);
    expect(result.value).toEqual({});
  });

  it("surfaces a parse failure rather than returning a half-built value", async () => {
    h.create.mockResolvedValue(completion({ content: "not json" }));

    await expect(provider().completeStructured(STRUCTURED)).rejects.toThrow(SyntaxError);
  });

  it("honors an explicit temperature over the structured default", async () => {
    h.create.mockResolvedValue(completion({ content: "{}" }));
    await provider().completeStructured({ ...STRUCTURED, temperature: 0.4 });

    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0.4 }),
    );
  });
});
