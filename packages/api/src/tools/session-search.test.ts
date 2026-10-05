import { describe, expect, it, vi } from "vitest";
import type { SessionSearchRequest } from "@beevibe/core";
import {
  SessionSearchError,
  type SessionSearchService,
} from "@beevibe/core/services/session-search";
import {
  createSessionSearchTool,
  type SessionSearchToolContext,
} from "./session-search.js";

/**
 * session_search's own logic is `inferRequest` — the four calling shapes
 * are inferred from which args are present, and getting that wrong sends
 * the agent a completely different kind of answer than it asked for.
 * The precedence is: scroll > read > discover > browse.
 *
 * The rest of the handler is the error envelope: a null result (not
 * found / out of scope / anchor in the live conversation) and the two
 * throw paths, including the deliberate match-by-name fallback for when
 * src/ and dist/ copies of SessionSearchError both exist.
 */

const CTX: SessionSearchToolContext = {
  agentId: "agent_caller",
  hierarchyLevel: "team",
  sessionId: "sess_live",
};

function fakeService(
  opts: { result?: unknown; throws?: unknown } = {},
): SessionSearchService {
  return {
    search: vi.fn(async () => {
      if (opts.throws !== undefined) throw opts.throws;
      return "result" in opts ? opts.result : { kind: "browse", sessions: [] };
    }),
  } as unknown as SessionSearchService;
}

/** See the note in use-repo.test.ts: indexed mock access is optional. */
function nthArg<T>(fn: unknown, argIndex: number): T {
  const calls = (fn as { mock: { calls: unknown[][] } }).mock.calls;
  if (calls.length === 0) throw new Error("expected the spy to have been called");
  return calls[0]![argIndex] as T;
}

function tool(opts: Parameters<typeof fakeService>[0] = {}) {
  const sessionSearch = fakeService(opts);
  return {
    t: createSessionSearchTool(CTX, { sessionSearch }),
    sessionSearch,
  };
}

function requestFor(
  input: Record<string, unknown>,
): Promise<SessionSearchRequest> {
  const { t, sessionSearch } = tool();
  return t.handler(input).then(() =>
    nthArg<SessionSearchRequest>(sessionSearch.search, 0),
  );
}

describe("session_search — tool surface", () => {
  it("is named session_search and has no required args (browse is the zero-arg shape)", () => {
    const { t } = tool();
    expect(t.name).toBe("session_search");
    expect(t.schema.required).toBeUndefined();
    expect(t.description.length).toBeGreaterThan(500);
  });

  it("forwards the caller's tier and live session as the search context", async () => {
    const { t, sessionSearch } = tool();
    await t.handler({});
    expect(nthArg<unknown>(sessionSearch.search, 1)).toEqual({
      callerAgentId: CTX.agentId,
      hierarchyLevel: CTX.hierarchyLevel,
      currentSessionId: CTX.sessionId,
    });
  });
});

describe("session_search — shape inference", () => {
  it("infers browse from no args", async () => {
    expect(await requestFor({})).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("infers discover from a query", async () => {
    expect(await requestFor({ query: "auth refactor" })).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: undefined,
      sort: undefined,
      filters: undefined,
    });
  });

  it("infers read from a bare session_id", async () => {
    expect(await requestFor({ session_id: "sess_past" })).toEqual({
      kind: "read",
      session_id: "sess_past",
    });
  });

  it("infers scroll from session_id + around_message_id", async () => {
    expect(
      await requestFor({
        session_id: "sess_past",
        around_message_id: "evt_9",
        window: 10,
      }),
    ).toEqual({
      kind: "scroll",
      session_id: "sess_past",
      around_message_id: "evt_9",
      window: 10,
    });
  });

  it("lets scroll win over a query that is also present", async () => {
    const req = await requestFor({
      query: "ignored",
      session_id: "sess_past",
      around_message_id: "evt_9",
    });
    expect(req.kind).toBe("scroll");
  });

  it("lets read win over a query that is also present", async () => {
    const req = await requestFor({ query: "ignored", session_id: "sess_past" });
    expect(req.kind).toBe("read");
  });

  it("falls back to read when around_message_id is present but blank", async () => {
    const req = await requestFor({
      session_id: "sess_past",
      around_message_id: "   ",
    });
    expect(req.kind).toBe("read");
  });

  it("falls back to browse when the query is only whitespace", async () => {
    const req = await requestFor({ query: "   \t " });
    expect(req.kind).toBe("browse");
  });

  it.each([
    ["session_id", "session_id"],
    ["query", "query"],
  ])("ignores a non-string %s", async (_label, key) => {
    const req = await requestFor({ [key]: 42 });
    expect(req.kind).toBe("browse");
  });

  it("trims session_id, anchor and query", async () => {
    const scroll = await requestFor({
      session_id: "  sess_past  ",
      around_message_id: "  evt_9  ",
    });
    expect(scroll).toMatchObject({
      session_id: "sess_past",
      around_message_id: "evt_9",
    });

    const discover = await requestFor({ query: "  needle  " });
    expect(discover).toMatchObject({ query: "needle" });
  });

  it("accepts a synthetic user-turn anchor id", async () => {
    const req = await requestFor({
      session_id: "sess_past",
      around_message_id: "intent:sess_past",
    });
    expect(req).toMatchObject({
      kind: "scroll",
      around_message_id: "intent:sess_past",
    });
  });
});

describe("session_search — numeric and enum args", () => {
  it("passes a numeric limit through on discover and browse", async () => {
    expect(await requestFor({ query: "x", limit: 7 })).toMatchObject({ limit: 7 });
    expect(await requestFor({ limit: 2 })).toMatchObject({ limit: 2 });
  });

  it("drops a non-numeric limit and window rather than forwarding a string", async () => {
    expect(await requestFor({ query: "x", limit: "7" })).toMatchObject({
      limit: undefined,
    });
    expect(
      await requestFor({
        session_id: "s",
        around_message_id: "e",
        window: "10",
      }),
    ).toMatchObject({ window: undefined });
  });

  it.each(["newest", "oldest"])("passes sort=%s through", async (sort) => {
    expect(await requestFor({ query: "x", sort })).toMatchObject({ sort });
  });

  it.each([
    ["an unknown value", "relevance"],
    ["a non-string", 1],
  ])("drops sort when it is %s", async (_label, sort) => {
    expect(await requestFor({ query: "x", sort })).toMatchObject({
      sort: undefined,
    });
  });
});

describe("session_search — filters", () => {
  it("forwards a filters object on discover and browse", async () => {
    const filters = { status: "failed", session_type: "task" };
    expect(await requestFor({ query: "x", filters })).toMatchObject({ filters });
    expect(await requestFor({ filters })).toMatchObject({ filters });
  });

  it.each([
    ["null", null],
    ["a string", "status=failed"],
  ])("drops filters when it is %s", async (_label, filters) => {
    expect(await requestFor({ filters })).toMatchObject({ filters: undefined });
  });
});

describe("session_search — error envelope", () => {
  it("turns a null result into not_found_or_forbidden", async () => {
    const { t } = tool({ result: null });
    const res = await t.handler({ session_id: "sess_other" });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("not_found_or_forbidden");
    expect(res.content.message).toMatch(/not in your scope/);
  });

  it.each([
    "forbidden_agent_filter",
    "missing_query",
    "missing_args",
  ] as const)("surfaces the %s code from a SessionSearchError", async (code) => {
    const { t } = tool({ throws: new SessionSearchError(code, `bad: ${code}`) });
    const res = await t.handler({ query: "x" });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe(code);
    expect(res.content.message).toBe(`bad: ${code}`);
  });

  it("matches a SessionSearchError by name too, for cross-bundle src/dist imports", async () => {
    // Same shape, different class identity — `instanceof` fails here,
    // which is exactly the case the name check exists for.
    class Impostor extends Error {
      code = "missing_query";
      constructor() {
        super("from the other bundle");
        this.name = "SessionSearchError";
      }
    }
    const { t } = tool({ throws: new Impostor() });
    const res = await t.handler({ query: "x" });
    expect(res.content.error).toBe("missing_query");
    expect(res.content.message).toBe("from the other bundle");
  });

  it("wraps an unexpected Error as internal_error", async () => {
    const { t } = tool({ throws: new Error("fts index missing") });
    const res = await t.handler({ query: "x" });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("internal_error");
    expect(res.content.message).toBe("fts index missing");
  });

  it("stringifies a thrown non-Error", async () => {
    const { t } = tool({ throws: "pool gone" });
    const res = await t.handler({ query: "x" });
    expect(res.content.error).toBe("internal_error");
    expect(res.content.message).toBe("pool gone");
  });
});

describe("session_search — success", () => {
  it("returns the service result verbatim as content", async () => {
    const result = { kind: "discover", results: [{ session: { id: "sess_a" } }] };
    const { t } = tool({ result });
    const res = await t.handler({ query: "x" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toBe(result);
  });
});
