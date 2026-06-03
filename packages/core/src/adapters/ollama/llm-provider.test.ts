import { afterEach, describe, expect, it, vi } from "vitest";
import { OllamaLlmProvider } from "./llm-provider.js";

function mockFetchSequence(...responses: Array<{ content?: string; eval_count?: number }>) {
  let call = 0;
  const fetchMock = vi.fn(async () => {
    const body = responses[Math.min(call, responses.length - 1)]!;
    call++;
    return {
      ok: true,
      json: async () => ({
        message: { content: body.content ?? "" },
        model: "gemma3:4b",
        prompt_eval_count: 10,
        eval_count: body.eval_count ?? 5,
      }),
      text: async () => "",
    } as unknown as Response;
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OllamaLlmProvider", () => {
  it("complete posts a non-streaming /api/chat request and returns trimmed text", async () => {
    const fetchMock = mockFetchSequence({ content: "  hello team  " });
    const provider = new OllamaLlmProvider({
      baseUrl: "http://localhost:11434",
      defaultModel: "gemma3:4b",
    });

    const res = await provider.complete({
      system: "sys",
      prompt: "hi",
      maxTokens: 100,
    });

    expect(res.text).toBe("hello team");
    expect(res.usage.model).toBe("gemma3:4b");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:11434/api/chat");
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.stream).toBe(false);
    expect(sent.model).toBe("gemma3:4b");
    expect(sent.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
    expect(sent.format).toBeUndefined();
  });

  it("completeStructured passes the JSON schema as `format` and parses the result", async () => {
    const fetchMock = mockFetchSequence({
      content: '{"believes":["x"],"knows":[],"working_on":[],"rules":[]}',
    });
    const provider = new OllamaLlmProvider();
    const schema = { type: "object" } as Record<string, unknown>;

    const res = await provider.completeStructured<{ believes: string[] }>({
      system: "sys",
      prompt: "p",
      maxTokens: 100,
      schema_name: "digest",
      schema_description: "d",
      schema,
    });

    expect(res.value.believes).toEqual(["x"]);
    const sent = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(sent.format).toEqual(schema);
  });

  it("retries when a small model returns an empty completion", async () => {
    const fetchMock = mockFetchSequence({ content: "" }, { content: "recovered" });
    const provider = new OllamaLlmProvider();
    const res = await provider.complete({ system: "s", prompt: "p", maxTokens: 10 });
    expect(res.text).toBe("recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("strips a ```json fence before parsing structured output", async () => {
    mockFetchSequence({ content: '```json\n{"believes":["a"],"knows":[],"working_on":[],"rules":[]}\n```' });
    const provider = new OllamaLlmProvider();
    const res = await provider.completeStructured<{ believes: string[] }>({
      system: "s",
      prompt: "p",
      maxTokens: 10,
      schema_name: "d",
      schema_description: "d",
      schema: {},
    });
    expect(res.value.believes).toEqual(["a"]);
  });

  it("gives a clear error when Ollama is unreachable", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const provider = new OllamaLlmProvider({ baseUrl: "http://localhost:11434" });
    await expect(
      provider.complete({ system: "s", prompt: "p", maxTokens: 10 }),
    ).rejects.toThrow(/Could not reach Ollama/);
  });
});
