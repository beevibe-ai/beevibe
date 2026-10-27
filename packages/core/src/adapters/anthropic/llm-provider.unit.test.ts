/**
 * AnthropicLlmProvider — keyless unit tests against a mocked SDK.
 *
 * `llm-provider.test.ts` next to this file needs ANTHROPIC_API_KEY and
 * calls the live Messages API, leaving this adapter uncovered wherever
 * keys aren't set. Our own logic is the request shape (system as a
 * top-level arg, native json_schema output_config) and `extractText`,
 * which has to concatenate only the text blocks out of a content array
 * that can also carry thinking and tool_use blocks.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ create: vi.fn(), ctorArgs: [] as unknown[] }));

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: h.create };
    constructor(opts: unknown) {
      h.ctorArgs.push(opts);
    }
  }
  return { default: FakeAnthropic };
});

const { AnthropicLlmProvider } = await import("./llm-provider.js");

function message(
  overrides: {
    content?: unknown[];
    stop_reason?: string | null;
    model?: string;
    usage?: { input_tokens: number; output_tokens: number };
  } = {},
) {
  return {
    model: overrides.model ?? "claude-haiku-4-5-20251001",
    content: overrides.content ?? [{ type: "text", text: "hello" }],
    stop_reason: overrides.stop_reason === undefined ? "end_turn" : overrides.stop_reason,
    usage: overrides.usage ?? { input_tokens: 11, output_tokens: 3 },
  };
}

function provider(config: Record<string, unknown> = {}) {
  return new AnthropicLlmProvider({ apiKey: "sk-ant-test", ...config });
}

const REQ = { system: "You are terse.", prompt: "Say hi.", maxTokens: 64 };

beforeEach(() => {
  h.create.mockReset();
  h.ctorArgs.length = 0;
});

describe("AnthropicLlmProvider construction", () => {
  it("defaults the timeout to 30s", () => {
    provider();
    expect(h.ctorArgs[0]).toMatchObject({ apiKey: "sk-ant-test", timeout: 30_000 });
  });

  it("honors a custom timeout", () => {
    provider({ timeoutMs: 5_000 });
    expect(h.ctorArgs[0]).toMatchObject({ timeout: 5_000 });
  });

  it("falls back to ANTHROPIC_API_KEY, and throws when there is none", () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-from-env";
    try {
      new AnthropicLlmProvider();
      expect(h.ctorArgs[0]).toMatchObject({ apiKey: "sk-ant-from-env" });

      delete process.env.ANTHROPIC_API_KEY;
      expect(() => new AnthropicLlmProvider()).toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it("reports its provider type", () => {
    expect(provider().type).toBe("anthropic");
  });
});

describe("AnthropicLlmProvider.complete", () => {
  it("passes system as a top-level arg, not as a message", async () => {
    h.create.mockResolvedValue(message());
    await provider().complete(REQ);

    expect(h.create).toHaveBeenCalledWith({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 64,
      system: REQ.system,
      temperature: 0.2,
      messages: [{ role: "user", content: REQ.prompt }],
    });
  });

  it("returns the text, usage and stop reason", async () => {
    h.create.mockResolvedValue(
      message({ content: [{ type: "text", text: "hi" }], stop_reason: "max_tokens" }),
    );

    await expect(provider().complete(REQ)).resolves.toEqual({
      text: "hi",
      usage: {
        input_tokens: 11,
        output_tokens: 3,
        model: "claude-haiku-4-5-20251001",
      },
      stop_reason: "max_tokens",
    });
  });

  it("honors an explicit model and a configured default", async () => {
    h.create.mockResolvedValue(message());
    await provider().complete({ ...REQ, model: "claude-opus-4-1" });
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-opus-4-1" }),
    );

    h.create.mockClear();
    await provider({ defaultModel: "claude-sonnet-4-5" }).complete(REQ);
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-4-5" }),
    );
  });

  it("passes temperature 0 through rather than defaulting it", async () => {
    h.create.mockResolvedValue(message());
    await provider().complete({ ...REQ, temperature: 0 });

    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ temperature: 0 }));
  });

  it("leaves stop_reason undefined when the API reports none", async () => {
    h.create.mockResolvedValue(message({ stop_reason: null }));

    const result = await provider().complete(REQ);
    expect(result.stop_reason).toBeUndefined();
  });
});

// A response's content array is heterogeneous. Taking `content[0].text`
// would return a thinking block's text, or undefined when the first block
// is tool_use — so the filter-and-join is the part worth pinning.
describe("AnthropicLlmProvider text extraction", () => {
  it("concatenates several text blocks in order", async () => {
    h.create.mockResolvedValue(
      message({
        content: [
          { type: "text", text: "Hello, " },
          { type: "text", text: "world." },
        ],
      }),
    );

    const result = await provider().complete(REQ);
    expect(result.text).toBe("Hello, world.");
  });

  it("skips non-text blocks, including a leading one", async () => {
    h.create.mockResolvedValue(
      message({
        content: [
          { type: "thinking", thinking: "let me consider" },
          { type: "text", text: "the answer" },
          { type: "tool_use", id: "tu_1", name: "search", input: {} },
        ],
      }),
    );

    const result = await provider().complete(REQ);
    expect(result.text).toBe("the answer");
  });

  it.each([
    ["an empty content array", []],
    ["content with no text blocks", [{ type: "tool_use", id: "tu_1", name: "x", input: {} }]],
  ])("returns an empty string for %s", async (_label, content) => {
    h.create.mockResolvedValue(message({ content }));

    const result = await provider().complete(REQ);
    expect(result.text).toBe("");
  });
});

describe("AnthropicLlmProvider.completeStructured", () => {
  const STRUCTURED = {
    ...REQ,
    schema_name: "promotion",
    schema_description: "whether to promote the fact",
    schema: { type: "object", properties: { promote: { type: "boolean" } } },
  };

  it("uses the native json_schema output_config and defaults temperature to 0", async () => {
    h.create.mockResolvedValue(
      message({ content: [{ type: "text", text: '{"promote":true}' }] }),
    );
    await provider().completeStructured(STRUCTURED);

    expect(h.create).toHaveBeenCalledWith({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 64,
      system: REQ.system,
      // Structured extraction wants determinism, so the default differs
      // from `complete`.
      temperature: 0,
      messages: [{ role: "user", content: REQ.prompt }],
      // The API enforces this server-side, which is why there is no
      // retry-on-malformed path to test.
      output_config: {
        format: { type: "json_schema", schema: STRUCTURED.schema },
      },
    });
  });

  it("parses the text into the typed value alongside usage", async () => {
    h.create.mockResolvedValue(
      message({ content: [{ type: "text", text: '{"promote":true}' }] }),
    );

    await expect(
      provider().completeStructured<{ promote: boolean }>(STRUCTURED),
    ).resolves.toEqual({
      value: { promote: true },
      usage: {
        input_tokens: 11,
        output_tokens: 3,
        model: "claude-haiku-4-5-20251001",
      },
      stop_reason: "end_turn",
    });
  });

  it("joins a schema response split across text blocks before parsing", async () => {
    h.create.mockResolvedValue(
      message({
        content: [
          { type: "text", text: '{"promote":' },
          { type: "text", text: "false}" },
        ],
      }),
    );

    const result = await provider().completeStructured<{ promote: boolean }>(STRUCTURED);
    expect(result.value).toEqual({ promote: false });
  });

  // Unlike the OpenAI adapter there is no "{}" fallback here, so an empty
  // content array is a parse failure rather than an empty object.
  it("surfaces a parse failure on empty or non-JSON content", async () => {
    h.create.mockResolvedValue(message({ content: [] }));
    await expect(provider().completeStructured(STRUCTURED)).rejects.toThrow(SyntaxError);

    h.create.mockResolvedValue(
      message({ content: [{ type: "text", text: "not json" }] }),
    );
    await expect(provider().completeStructured(STRUCTURED)).rejects.toThrow(SyntaxError);
  });

  it("honors an explicit temperature over the structured default", async () => {
    h.create.mockResolvedValue(message({ content: [{ type: "text", text: "{}" }] }));
    await provider().completeStructured({ ...STRUCTURED, temperature: 0.4 });

    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0.4 }),
    );
  });
});
