/**
 * OpenAIEmbeddingService — keyless unit tests against a mocked SDK.
 *
 * `embeddings.test.ts` next to this file makes real API calls, so it only
 * runs where OPENAI_API_KEY is set; everything it asserts is about OpenAI's
 * behavior, not ours. Our own logic — batching at 2048, restoring order
 * from `item.index`, and the retry/backoff policy — is what breaks on a
 * refactor, and none of it was reachable without a key. These tests mock
 * the `openai` module so that logic runs in any environment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class FakeAPIError extends Error {
    constructor(readonly status: number) {
      super(`openai ${status}`);
      this.name = "APIError";
    }
  }
  return { create: vi.fn(), FakeAPIError, ctorArgs: [] as unknown[] };
});

vi.mock("openai", () => {
  class FakeOpenAI {
    static APIError = h.FakeAPIError;
    embeddings = { create: h.create };
    constructor(opts: unknown) {
      h.ctorArgs.push(opts);
    }
  }
  return { default: FakeOpenAI };
});

const { OpenAIEmbeddingService } = await import("./embeddings.js");

/** One embeddings response, with `index` ordered as the caller passed it. */
function response(vectors: number[][], offset = 0) {
  return {
    data: vectors.map((embedding, i) => ({ index: i + offset, embedding })),
  };
}

function service() {
  return new OpenAIEmbeddingService({ apiKey: "sk-test" });
}

beforeEach(() => {
  h.create.mockReset();
  h.ctorArgs.length = 0;
});

describe("OpenAIEmbeddingService construction", () => {
  it("disables the SDK's own retries so ours is the only policy", () => {
    service();

    expect(h.ctorArgs[0]).toMatchObject({
      apiKey: "sk-test",
      timeout: 15_000,
      maxRetries: 0,
    });
  });

  it("honors a custom timeout", () => {
    new OpenAIEmbeddingService({ apiKey: "sk-test", timeoutMs: 1_000 });

    expect(h.ctorArgs[0]).toMatchObject({ timeout: 1_000 });
  });

  it("falls back to OPENAI_API_KEY when no key is passed", () => {
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-from-env";
    try {
      new OpenAIEmbeddingService();
      expect(h.ctorArgs[0]).toMatchObject({ apiKey: "sk-from-env" });
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
    }
  });

  it("throws when neither a key nor the env var is available", () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      expect(() => new OpenAIEmbeddingService()).toThrow(/OPENAI_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  });
});

describe("OpenAIEmbeddingService requests", () => {
  it("pins the model and the 1536 dimensions the memory_fact column expects", async () => {
    h.create.mockResolvedValue(response([[0.1, 0.2]]));
    await service().embedBatch(["hello"]);

    expect(h.create).toHaveBeenCalledWith({
      model: "text-embedding-3-small",
      input: ["hello"],
      dimensions: 1536,
    });
  });

  it("embed returns the single vector rather than a one-element array", async () => {
    h.create.mockResolvedValue(response([[0.1, 0.2]]));

    await expect(service().embed("hello")).resolves.toEqual([0.1, 0.2]);
  });

  it("returns [] for an empty batch without calling the API", async () => {
    await expect(service().embedBatch([])).resolves.toEqual([]);
    expect(h.create).not.toHaveBeenCalled();
  });

  // The API is documented to return items in order, but the code indexes
  // by `item.index` precisely so it doesn't depend on that.
  it("restores caller order from item.index when the response is shuffled", async () => {
    h.create.mockResolvedValue({
      data: [
        { index: 2, embedding: [3] },
        { index: 0, embedding: [1] },
        { index: 1, embedding: [2] },
      ],
    });

    await expect(service().embedBatch(["a", "b", "c"])).resolves.toEqual([
      [1],
      [2],
      [3],
    ]);
  });
});

describe("OpenAIEmbeddingService batching", () => {
  it("sends one request per 2048 inputs and concatenates in order", async () => {
    const texts = Array.from({ length: 2049 }, (_, i) => `t${i}`);
    h.create.mockImplementation(async (args: { input: string[] }) =>
      response(
        args.input.map((t) => [Number(t.slice(1))]),
        // Index is relative to the chunk, which is why the handler adds
        // the chunk's start offset.
        0,
      ),
    );

    const vectors = await service().embedBatch(texts);

    expect(h.create).toHaveBeenCalledTimes(2);
    expect(vi.mocked(h.create).mock.calls[0]![0].input).toHaveLength(2048);
    expect(vi.mocked(h.create).mock.calls[1]![0].input).toEqual(["t2048"]);
    expect(vectors).toHaveLength(2049);
    expect(vectors[0]).toEqual([0]);
    expect(vectors[2047]).toEqual([2047]);
    expect(vectors[2048]).toEqual([2048]);
  });

  it("sends a single request at exactly the batch size", async () => {
    const texts = Array.from({ length: 2048 }, (_, i) => `t${i}`);
    h.create.mockImplementation(async (args: { input: string[] }) =>
      response(args.input.map(() => [1])),
    );

    await service().embedBatch(texts);

    expect(h.create).toHaveBeenCalledTimes(1);
  });
});

// The policy sleeps [200ms, 1000ms] between attempts. Fake timers keep the
// suite instant; `runAllTimersAsync` drains the microtasks between them so
// the retry loop actually advances.
describe("OpenAIEmbeddingService retry policy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Fails `times` times with `err`, then succeeds. */
  function failThen(times: number, err: unknown) {
    let n = 0;
    h.create.mockImplementation(async () => {
      if (n++ < times) throw err;
      return response([[1]]);
    });
  }

  /** Starts the call, then lets every backoff sleep elapse. */
  async function settle<T>(promise: Promise<T>): Promise<T> {
    const drained = vi.runAllTimersAsync();
    const result = await promise.then(
      (v) => ({ ok: true as const, v }),
      (e) => ({ ok: false as const, e }),
    );
    await drained;
    if (!result.ok) throw result.e;
    return result.v;
  }

  it.each([
    ["429 rate limit", () => new h.FakeAPIError(429)],
    ["500 server error", () => new h.FakeAPIError(500)],
    ["503 server error", () => new h.FakeAPIError(503)],
    ["ENOTFOUND", () => new Error("getaddrinfo ENOTFOUND api.openai.com")],
    ["ECONNRESET", () => new Error("socket hang up: ECONNRESET")],
    ["ETIMEDOUT", () => new Error("connect ETIMEDOUT")],
    ["EAI_AGAIN", () => new Error("getaddrinfo EAI_AGAIN")],
  ])("retries a %s and succeeds on the second attempt", async (_label, make) => {
    failThen(1, make());

    await expect(settle(service().embed("hello"))).resolves.toEqual([1]);
    expect(h.create).toHaveBeenCalledTimes(2);
  });

  it("gives up after 3 attempts and rethrows the last error", async () => {
    h.create.mockRejectedValue(new h.FakeAPIError(500));

    await expect(settle(service().embed("hello"))).rejects.toThrow("openai 500");
    expect(h.create).toHaveBeenCalledTimes(3);
  });

  // A 400 means the request is wrong; retrying it wastes 1.2s and still
  // fails, so the policy has to distinguish it from a 429.
  it.each([
    ["400 bad request", () => new h.FakeAPIError(400)],
    ["401 unauthorized", () => new h.FakeAPIError(401)],
    ["404 not found", () => new h.FakeAPIError(404)],
    ["a plain error with no retryable code", () => new Error("input too long")],
  ])("does not retry %s", async (_label, make) => {
    h.create.mockRejectedValue(make());

    await expect(settle(service().embed("hello"))).rejects.toThrow();
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  it("does not retry a non-Error throw", async () => {
    h.create.mockRejectedValue("quota exceeded");

    await expect(settle(service().embed("hello"))).rejects.toBe("quota exceeded");
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  it("retries each batch independently", async () => {
    const texts = Array.from({ length: 2049 }, (_, i) => `t${i}`);
    let calls = 0;
    h.create.mockImplementation(async (args: { input: string[] }) => {
      calls++;
      if (calls === 1) throw new h.FakeAPIError(429);
      return response(args.input.map(() => [1]));
    });

    const vectors = await settle(service().embedBatch(texts));

    // 1 failure + 1 retry for the first chunk, 1 for the second.
    expect(h.create).toHaveBeenCalledTimes(3);
    expect(vectors).toHaveLength(2049);
  });
});

describe("OpenAIEmbeddingService identity", () => {
  it("reports the model in its type so callers can record which embedder ran", () => {
    expect(service().type).toBe("openai:text-embedding-3-small");
  });
});
