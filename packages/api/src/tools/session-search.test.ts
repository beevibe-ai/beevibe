/**
 * session_search handler tests.
 *
 * The service owns scoping and SQL; the handler owns `inferRequest` —
 * the four-shape dispatch (scroll / read / discover / browse) that
 * decides, from loosely-typed MCP input, which request kind the service
 * gets. Getting that wrong silently returns the wrong thing rather than
 * erroring, so the precedence rules are worth pinning. The handler also
 * owns the error envelope, including the deliberate duck-typed
 * SessionSearchError match that keeps error codes intact when src/ and
 * dist/ copies of core meet in one process.
 */
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

const CTX: SessionSearchToolContext = {
  agentId: "agent_a",
  hierarchyLevel: "team",
  sessionId: "ses_current",
};

interface Harness {
  search: ReturnType<typeof vi.fn>;
  requests: SessionSearchRequest[];
  scopes: Array<Record<string, unknown>>;
  tool: ReturnType<typeof createSessionSearchTool>;
}

function harness(
  opts: { result?: unknown; error?: unknown; ctx?: Partial<SessionSearchToolContext> } = {},
): Harness {
  const requests: SessionSearchRequest[] = [];
  const scopes: Array<Record<string, unknown>> = [];
  const search = vi.fn(
    async (req: SessionSearchRequest, scope: Record<string, unknown>) => {
      if (opts.error) throw opts.error;
      requests.push(req);
      scopes.push(scope);
      return "result" in opts ? opts.result : { kind: "browse", sessions: [] };
    },
  );
  const sessionSearch = { search } as unknown as SessionSearchService;
  return {
    search,
    requests,
    scopes,
    tool: createSessionSearchTool({ ...CTX, ...opts.ctx }, { sessionSearch }),
  };
}

describe("session_search — caller scope", () => {
  it("passes the caller's agent id, tier and active session to the service", async () => {
    const h = harness();
    await h.tool.handler({});
    expect(h.scopes[0]).toEqual({
      callerAgentId: "agent_a",
      hierarchyLevel: "team",
      currentSessionId: "ses_current",
    });
  });

  it("forwards the caller's own tier rather than assuming one", async () => {
    const h = harness({ ctx: { hierarchyLevel: "ic" } });
    await h.tool.handler({});
    expect(h.scopes[0]?.hierarchyLevel).toBe("ic");
  });
});

describe("session_search — shape inference", () => {
  it("infers scroll when session_id and around_message_id are both present", async () => {
    const h = harness();
    await h.tool.handler({
      session_id: "  ses_1  ",
      around_message_id: "  evt_9  ",
      window: 10,
    });
    expect(h.requests[0]).toEqual({
      kind: "scroll",
      session_id: "ses_1",
      around_message_id: "evt_9",
      window: 10,
    });
  });

  it("leaves window undefined for the service to default when it isn't a number", async () => {
    for (const window of [undefined, "10", null]) {
      const h = harness();
      await h.tool.handler({
        session_id: "ses_1",
        around_message_id: "evt_9",
        window,
      });
      expect(h.requests[0]).toMatchObject({ kind: "scroll" });
      expect((h.requests[0] as { window?: number }).window).toBeUndefined();
    }
  });

  it("infers read from a bare session_id", async () => {
    const h = harness();
    await h.tool.handler({ session_id: "ses_1" });
    expect(h.requests[0]).toEqual({ kind: "read", session_id: "ses_1" });
  });

  it("prefers scroll over read, and read over discover", async () => {
    // Precedence matters: an agent that passes a leftover `query` alongside
    // a session_id means to scroll/read, not to search again.
    const scroll = harness();
    await scroll.tool.handler({
      session_id: "ses_1",
      around_message_id: "evt_9",
      query: "auth",
    });
    expect(scroll.requests[0]?.kind).toBe("scroll");

    const read = harness();
    await read.tool.handler({ session_id: "ses_1", query: "auth" });
    expect(read.requests[0]?.kind).toBe("read");
  });

  it("infers discover from a query, carrying limit, sort and filters", async () => {
    const h = harness();
    await h.tool.handler({
      query: "  auth refactor  ",
      limit: 5,
      sort: "newest",
      filters: { status: "failed", session_type: "task" },
    });
    expect(h.requests[0]).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: 5,
      sort: "newest",
      filters: { status: "failed", session_type: "task" },
    });
  });

  it("accepts both sort directions and drops anything else", async () => {
    for (const sort of ["newest", "oldest"]) {
      const h = harness();
      await h.tool.handler({ query: "auth", sort });
      expect((h.requests[0] as { sort?: string }).sort).toBe(sort);
    }
    for (const sort of [undefined, "relevance", "NEWEST", 1]) {
      const h = harness();
      await h.tool.handler({ query: "auth", sort });
      expect((h.requests[0] as { sort?: string }).sort).toBeUndefined();
    }
  });

  it("infers browse from no arguments at all", async () => {
    const h = harness();
    await h.tool.handler({});
    expect(h.requests[0]).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("carries limit and filters onto browse too", async () => {
    const h = harness();
    await h.tool.handler({ limit: 8, filters: { agent_id: "agent_sub" } });
    expect(h.requests[0]).toEqual({
      kind: "browse",
      limit: 8,
      filters: { agent_id: "agent_sub" },
    });
  });

  it("treats whitespace-only and non-string ids as absent, falling back to browse", async () => {
    for (const input of [
      { session_id: "   ", around_message_id: "   ", query: "   " },
      { session_id: 1, around_message_id: 2, query: 3 },
      { session_id: null, query: null },
    ] as Array<Record<string, unknown>>) {
      const h = harness();
      await h.tool.handler(input);
      expect(h.requests[0]?.kind).toBe("browse");
    }
  });

  it("falls back to read when only the anchor is blank", async () => {
    const h = harness();
    await h.tool.handler({ session_id: "ses_1", around_message_id: "  " });
    expect(h.requests[0]).toEqual({ kind: "read", session_id: "ses_1" });
  });

  it("ignores a non-object or null filters value", async () => {
    for (const filters of [null, "status=failed", 7]) {
      const h = harness();
      await h.tool.handler({ query: "auth", filters });
      expect((h.requests[0] as { filters?: unknown }).filters).toBeUndefined();
    }
  });

  it("leaves a non-numeric limit undefined so the service applies its own default", async () => {
    const h = harness();
    await h.tool.handler({ query: "auth", limit: "5" });
    expect((h.requests[0] as { limit?: number }).limit).toBeUndefined();
  });
});

describe("session_search — results and errors", () => {
  it("returns the service payload unchanged on success", async () => {
    const payload = { kind: "discover", results: [{ session: { id: "ses_1" } }] };
    const h = harness({ result: payload });
    const result = await h.tool.handler({ query: "auth" });
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe(payload);
  });

  it("turns a null result into not_found_or_forbidden", async () => {
    const h = harness({ result: null });
    const result = await h.tool.handler({ session_id: "ses_other" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "not_found_or_forbidden" });
    expect(result.content.message).toContain("not in your scope");
  });

  it("surfaces a SessionSearchError's code verbatim", async () => {
    for (const code of ["forbidden_agent_filter", "missing_query", "missing_args"] as const) {
      const h = harness({ error: new SessionSearchError(code, `nope: ${code}`) });
      const result = await h.tool.handler({ query: "auth" });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual({ error: code, message: `nope: ${code}` });
    }
  });

  it("matches SessionSearchError by name too, for the src/dist double-import case", async () => {
    // A structurally identical error from the *other* copy of core fails
    // `instanceof`; the handler's name check is what keeps the agent-
    // visible code stable. Simulate that foreign class here.
    class ForeignSessionSearchError extends Error {
      code = "forbidden_agent_filter";
      constructor(message: string) {
        super(message);
        this.name = "SessionSearchError";
      }
    }
    const err = new ForeignSessionSearchError("out of scope");
    expect(err instanceof SessionSearchError).toBe(false);

    const h = harness({ error: err });
    const result = await h.tool.handler({ query: "auth", filters: { agent_id: "x" } });
    expect(result.content).toEqual({
      error: "forbidden_agent_filter",
      message: "out of scope",
    });
  });

  it("wraps an unexpected Error as internal_error", async () => {
    const h = harness({ error: new Error("connection terminated") });
    const result = await h.tool.handler({ query: "auth" });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "internal_error",
      message: "connection terminated",
    });
  });

  it("stringifies a non-Error throw under internal_error", async () => {
    const h = harness({ error: { pgCode: "57P01" } });
    const result = await h.tool.handler({ query: "auth" });
    expect(result.content).toMatchObject({ error: "internal_error" });
    expect(typeof result.content.message).toBe("string");
  });
});

describe("session_search — tool metadata", () => {
  it("has no required fields, since browse takes no arguments", () => {
    const h = harness();
    expect(h.tool.name).toBe("session_search");
    expect((h.tool.schema as { required?: string[] }).required).toBeUndefined();
  });

  it("documents all four calling shapes for the agent", () => {
    const d = harness().tool.description;
    for (const shape of ["DISCOVERY", "SCROLL", "READ", "BROWSE"]) {
      expect(d).toContain(shape);
    }
  });
});
