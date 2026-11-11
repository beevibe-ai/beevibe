/**
 * session_search handler tests.
 *
 * The module's real logic is `inferRequest` — mapping loose MCP input
 * onto one of four discriminated request shapes (discover / scroll /
 * read / browse). It isn't exported, so it's exercised through the
 * handler by capturing what reaches the service.
 *
 * Also covered: the null → not_found_or_forbidden envelope, and the
 * error branch's deliberate match-by-name fallback, which exists so a
 * SessionSearchError thrown from a different bundle (src/ vs dist/)
 * still keeps its structured code instead of degrading to
 * internal_error.
 */
import { describe, expect, it, vi } from "vitest";
import type { SessionSearchRequest } from "@beevibe/core";
import {
  SessionSearchError,
  SessionSearchService,
} from "@beevibe/core/services/session-search";
import {
  createSessionSearchTool,
  type SessionSearchToolContext,
} from "./session-search.js";

type SearchCtx = Parameters<SessionSearchService["search"]>[1];

function harness(opts?: { result?: unknown; throws?: unknown }) {
  const requests: SessionSearchRequest[] = [];
  const contexts: SearchCtx[] = [];
  const sessionSearch = {
    search: vi.fn(async (req: SessionSearchRequest, c: SearchCtx) => {
      requests.push(req);
      contexts.push(c);
      if (opts?.throws !== undefined) throw opts.throws;
      return opts?.result === undefined ? { sessions: [] } : opts.result;
    }),
  } as unknown as SessionSearchService;
  return { sessionSearch, requests, contexts };
}

const ctx: SessionSearchToolContext = {
  agentId: "agent_a",
  hierarchyLevel: "team",
  sessionId: "sess_current",
};

function tool(sessionSearch: SessionSearchService, c = ctx) {
  return createSessionSearchTool(c, { sessionSearch });
}

/** Run the handler and return the request the service actually saw. */
async function inferred(
  input: Record<string, unknown>,
): Promise<SessionSearchRequest> {
  const h = harness();
  await tool(h.sessionSearch).handler(input);
  const req = h.requests[0];
  if (!req) throw new Error("service was not called");
  return req;
}

describe("session_search tool shape", () => {
  it("is named session_search and marks nothing required", () => {
    const t = tool(harness().sessionSearch);
    expect(t.name).toBe("session_search");
    // The browse shape is a bare call, so there can be no required args.
    expect(t.schema.required).toBeUndefined();
  });

  it("advertises every documented arg", () => {
    const t = tool(harness().sessionSearch);
    const props = t.schema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual([
      "around_message_id",
      "filters",
      "limit",
      "query",
      "session_id",
      "sort",
      "window",
    ]);
  });

  it("documents the four calling shapes in the description", () => {
    const t = tool(harness().sessionSearch);
    for (const shape of ["DISCOVERY", "SCROLL", "READ", "BROWSE"]) {
      expect(t.description).toContain(shape);
    }
  });
});

describe("caller context", () => {
  it("passes agent id, tier, and the active session to the service", async () => {
    const h = harness();
    await tool(h.sessionSearch).handler({});

    expect(h.contexts[0]).toEqual({
      callerAgentId: "agent_a",
      hierarchyLevel: "team",
      currentSessionId: "sess_current",
    });
  });

  it("forwards whatever tier the caller resolved to", async () => {
    const h = harness();
    await tool(h.sessionSearch, { ...ctx, hierarchyLevel: "ic" }).handler({});

    expect(h.contexts[0]?.hierarchyLevel).toBe("ic");
  });
});

describe("shape inference: browse", () => {
  it("treats a bare call as browse", async () => {
    expect(await inferred({})).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("carries a numeric limit and filters into browse", async () => {
    expect(
      await inferred({ limit: 7, filters: { status: "failed" } }),
    ).toEqual({
      kind: "browse",
      limit: 7,
      filters: { status: "failed" },
    });
  });

  it("drops a non-numeric limit so the service default applies", async () => {
    expect(await inferred({ limit: "7" })).toMatchObject({
      kind: "browse",
      limit: undefined,
    });
  });

  it("browses when query is present but blank", async () => {
    expect(await inferred({ query: "   " })).toMatchObject({ kind: "browse" });
  });

  it("browses when query is not a string", async () => {
    expect(await inferred({ query: 42 })).toMatchObject({ kind: "browse" });
  });
});

describe("shape inference: discover", () => {
  it("infers discover from a query and trims it", async () => {
    expect(await inferred({ query: "  auth refactor  " })).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: undefined,
      sort: undefined,
      filters: undefined,
    });
  });

  it("carries limit, sort, and filters", async () => {
    expect(
      await inferred({
        query: "docker",
        limit: 5,
        sort: "newest",
        filters: { session_type: "task", agent_id: "agent_b" },
      }),
    ).toEqual({
      kind: "discover",
      query: "docker",
      limit: 5,
      sort: "newest",
      filters: { session_type: "task", agent_id: "agent_b" },
    });
  });

  it.each(["newest", "oldest"])("accepts sort=%s", async (sort) => {
    expect(await inferred({ query: "x", sort })).toMatchObject({ sort });
  });

  it.each([
    ["an unknown value", "relevance"],
    ["a non-string", 1],
  ])("drops sort when it is %s", async (_label, sort) => {
    expect(await inferred({ query: "x", sort })).toMatchObject({
      kind: "discover",
      sort: undefined,
    });
  });
});

describe("shape inference: read", () => {
  it("infers read from a bare session_id and trims it", async () => {
    expect(await inferred({ session_id: "  sess_7  " })).toEqual({
      kind: "read",
      session_id: "sess_7",
    });
  });

  it("prefers read over discover when both session_id and query are set", async () => {
    // Documented precedence: session_id wins, query is ignored.
    expect(await inferred({ session_id: "sess_7", query: "auth" })).toEqual({
      kind: "read",
      session_id: "sess_7",
    });
  });

  it("ignores a blank session_id and falls through to discover", async () => {
    expect(await inferred({ session_id: "  ", query: "auth" })).toMatchObject({
      kind: "discover",
      query: "auth",
    });
  });

  it("ignores a non-string session_id and falls through to browse", async () => {
    expect(await inferred({ session_id: 99 })).toMatchObject({
      kind: "browse",
    });
  });

  it("reads rather than scrolls when the anchor is blank", async () => {
    expect(
      await inferred({ session_id: "sess_7", around_message_id: "   " }),
    ).toEqual({ kind: "read", session_id: "sess_7" });
  });
});

describe("shape inference: scroll", () => {
  it("needs both session_id and around_message_id, and trims both", async () => {
    expect(
      await inferred({
        session_id: " sess_7 ",
        around_message_id: " evt_3 ",
      }),
    ).toEqual({
      kind: "scroll",
      session_id: "sess_7",
      around_message_id: "evt_3",
      window: undefined,
    });
  });

  it("carries a numeric window through unclamped — the service clamps", async () => {
    expect(
      await inferred({
        session_id: "sess_7",
        around_message_id: "evt_3",
        window: 999,
      }),
    ).toMatchObject({ window: 999 });
  });

  it("drops a non-numeric window", async () => {
    expect(
      await inferred({
        session_id: "sess_7",
        around_message_id: "evt_3",
        window: "10",
      }),
    ).toMatchObject({ kind: "scroll", window: undefined });
  });

  it("accepts the synthetic user-turn anchor id format", async () => {
    expect(
      await inferred({
        session_id: "sess_7",
        around_message_id: "intent:sess_7",
      }),
    ).toMatchObject({
      kind: "scroll",
      around_message_id: "intent:sess_7",
    });
  });

  it("outranks discover when a query is also present", async () => {
    expect(
      await inferred({
        session_id: "sess_7",
        around_message_id: "evt_3",
        query: "auth",
      }),
    ).toMatchObject({ kind: "scroll" });
  });

  it("ignores an anchor with no session_id", async () => {
    expect(await inferred({ around_message_id: "evt_3" })).toMatchObject({
      kind: "browse",
    });
  });
});

describe("filters passthrough", () => {
  it.each([
    ["null", null],
    ["a string", "status:failed"],
    ["a number", 3],
  ])("drops filters that are %s", async (_label, filters) => {
    expect(await inferred({ query: "x", filters })).toMatchObject({
      filters: undefined,
    });
  });

  it("forwards an arbitrary filter object verbatim for the service to validate", async () => {
    const filters = {
      session_type: "chat",
      status: "succeeded",
      task_id: "task_1",
      since: "2026-01-01T00:00:00Z",
      until: "2026-02-01T00:00:00Z",
    };
    expect(await inferred({ query: "x", filters })).toMatchObject({ filters });
  });

  it("does not attach filters to scroll or read, which don't accept them", async () => {
    const scroll = await inferred({
      session_id: "s",
      around_message_id: "e",
      filters: { status: "failed" },
    });
    const read = await inferred({
      session_id: "s",
      filters: { status: "failed" },
    });
    expect(scroll).not.toHaveProperty("filters");
    expect(read).not.toHaveProperty("filters");
  });
});

describe("result handling", () => {
  it("returns the service result as tool content", async () => {
    const result = { sessions: [{ id: "sess_1" }], total: 1 };
    const h = harness({ result });

    const out = await tool(h.sessionSearch).handler({ query: "auth" });

    expect(out.isError).toBeUndefined();
    expect(out.content).toEqual(result);
  });

  it("maps a null result onto not_found_or_forbidden", async () => {
    const h = harness({ result: null });

    const out = await tool(h.sessionSearch).handler({ session_id: "sess_x" });

    expect(out.isError).toBe(true);
    expect(out.content.error).toBe("not_found_or_forbidden");
    expect(out.content.message).toContain("not in your scope");
  });
});

describe("error mapping", () => {
  it.each([
    ["forbidden_agent_filter", "agent_b is outside your scope"],
    ["missing_query", "query is required for discovery"],
    ["missing_args", "pass a query or a session_id"],
  ] as const)("preserves the %s code", async (code, message) => {
    const h = harness({ throws: new SessionSearchError(code, message) });

    const out = await tool(h.sessionSearch).handler({ query: "x" });

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({ error: code, message });
  });

  it("recognizes a cross-bundle SessionSearchError by name", async () => {
    // A structurally identical error from another bundle fails
    // `instanceof`; the name check is what keeps its code.
    class ForeignSessionSearchError extends Error {
      code = "forbidden_agent_filter";
      constructor(message: string) {
        super(message);
        this.name = "SessionSearchError";
      }
    }
    const h = harness({
      throws: new ForeignSessionSearchError("out of scope"),
    });

    const out = await tool(h.sessionSearch).handler({ query: "x" });

    expect(out.content).toEqual({
      error: "forbidden_agent_filter",
      message: "out of scope",
    });
  });

  it("degrades an unrelated Error to internal_error", async () => {
    const h = harness({ throws: new Error("connection terminated") });

    const out = await tool(h.sessionSearch).handler({ query: "x" });

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({
      error: "internal_error",
      message: "connection terminated",
    });
  });

  it("stringifies a non-Error throw", async () => {
    const h = harness({ throws: "pg gone" });

    const out = await tool(h.sessionSearch).handler({ query: "x" });

    expect(out.content).toEqual({
      error: "internal_error",
      message: "pg gone",
    });
  });
});
