/**
 * session_search tool — unit tests with vitest fakes (no DB, no FTS).
 *
 * The service owns scope resolution and the SQL; the tool owns *shape
 * inference* — which of the four calling shapes (discover / scroll /
 * read / browse) a loose bag of MCP input maps onto, and how a service
 * error or a `null` return becomes an agent-readable envelope. Those
 * are what these tests pin, by asserting on the request handed to a
 * fake service.
 */
import { describe, expect, it, vi } from "vitest";
import type { SessionSearchRequest, SessionSearchResult } from "@beevibe/core";
import {
  SessionSearchError,
  type SessionSearchContext,
  type SessionSearchService,
} from "@beevibe/core/services/session-search";
import {
  createSessionSearchTool,
  type SessionSearchToolContext,
} from "./session-search.js";

// ── Fakes ────────────────────────────────────────────────────────────────

const browseResult = {
  kind: "browse",
  sessions: [],
} as unknown as SessionSearchResult;

function buildTool(
  opts: {
    result?: SessionSearchResult | null;
    throws?: unknown;
    ctx?: Partial<SessionSearchToolContext>;
  } = {},
) {
  // Parameters are declared so `mock.calls` is a typed 2-tuple — the
  // tests assert on both the request and the caller context.
  const search = vi.fn(
    async (_req: SessionSearchRequest, _ctx: SessionSearchContext) => {
      if ("throws" in opts) throw opts.throws;
      return opts.result === undefined ? browseResult : opts.result;
    },
  );
  const sessionSearch = { search } as unknown as SessionSearchService;
  const ctx: SessionSearchToolContext = {
    agentId: "agent_a",
    hierarchyLevel: "team",
    sessionId: "ses_current",
    ...opts.ctx,
  };
  const tool = createSessionSearchTool(ctx, { sessionSearch });
  return { tool, search, ctx };
}

/** The request the fake service received on its Nth call. */
function requestAt(
  search: { mock: { calls: readonly unknown[][] } },
  n = 0,
): SessionSearchRequest {
  return search.mock.calls[n]?.[0] as SessionSearchRequest;
}

// ── Descriptor ───────────────────────────────────────────────────────────

describe("session_search descriptor", () => {
  it("is named session_search and carries the four-shape contract", () => {
    const { tool } = buildTool();
    expect(tool.name).toBe("session_search");
    // The description is the agent-facing contract; it has to keep
    // naming all four shapes or agents stop finding the non-discovery
    // ones.
    for (const shape of ["DISCOVERY", "SCROLL", "READ", "BROWSE"]) {
      expect(tool.description).toContain(shape);
    }
  });

  it("declares no required fields — a bare call is the browse shape", () => {
    const { tool } = buildTool();
    expect(tool.schema.required).toBeUndefined();
    const props = tool.schema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual([
      "around_message_id",
      "filters",
      "limit",
      "query",
      "session_id",
      "sort",
      "window",
    ].sort());
  });
});

// ── Caller context ───────────────────────────────────────────────────────

describe("caller context threading", () => {
  it("forwards agentId, tier and current session to the service", async () => {
    const { tool, search } = buildTool({
      ctx: { agentId: "agent_org", hierarchyLevel: "org", sessionId: "ses_x" },
    });

    await tool.handler({});

    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]?.[1]).toEqual({
      callerAgentId: "agent_org",
      hierarchyLevel: "org",
      currentSessionId: "ses_x",
    });
  });

  it("returns the service result verbatim as the tool content", async () => {
    const result = {
      kind: "discover",
      query: "auth refactor",
      hits: [],
      lineages_searched: 3,
    } as unknown as SessionSearchResult;
    const { tool } = buildTool({ result });

    const out = await tool.handler({ query: "auth refactor" });

    expect(out.isError).toBeFalsy();
    expect(out.content).toEqual(result);
  });
});

// ── Shape inference ──────────────────────────────────────────────────────

describe("shape inference: browse", () => {
  it("maps a bare call to browse", async () => {
    const { tool, search } = buildTool();
    await tool.handler({});
    expect(requestAt(search)).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("carries limit and filters into browse", async () => {
    const { tool, search } = buildTool();
    const filters = { session_type: "task", status: "failed" };
    await tool.handler({ limit: 7, filters });
    expect(requestAt(search)).toEqual({ kind: "browse", limit: 7, filters });
  });

  it("ignores a non-numeric limit and a non-object filters", async () => {
    const { tool, search } = buildTool();
    await tool.handler({ limit: "7", filters: "task" });
    expect(requestAt(search)).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("treats a blank query as no query at all (browse, not discover)", async () => {
    const { tool, search } = buildTool();
    await tool.handler({ query: "   " });
    expect(requestAt(search).kind).toBe("browse");
  });
});

describe("shape inference: discover", () => {
  it("maps a query to discover, trimming it", async () => {
    const { tool, search } = buildTool();
    await tool.handler({ query: "  auth refactor  " });
    expect(requestAt(search)).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: undefined,
      sort: undefined,
      filters: undefined,
    });
  });

  it("passes limit, sort and filters through", async () => {
    const { tool, search } = buildTool();
    const filters = { agent_id: "agent_sub", since: "2026-01-01T00:00:00Z" };
    await tool.handler({
      query: "docker networking",
      limit: 10,
      sort: "newest",
      filters,
    });
    expect(requestAt(search)).toEqual({
      kind: "discover",
      query: "docker networking",
      limit: 10,
      sort: "newest",
      filters,
    });
  });

  it("accepts only 'newest' / 'oldest' for sort", async () => {
    const { tool, search } = buildTool();

    await tool.handler({ query: "x", sort: "oldest" });
    expect(requestAt(search, 0)).toMatchObject({ sort: "oldest" });

    // Anything else is dropped rather than rejected — relevance-only is
    // the documented default.
    await tool.handler({ query: "x", sort: "relevance" });
    expect(requestAt(search, 1)).toMatchObject({ sort: undefined });
  });
});

describe("shape inference: read", () => {
  it("maps a bare session_id to read, trimming it", async () => {
    const { tool, search } = buildTool();
    await tool.handler({ session_id: "  ses_42  " });
    expect(requestAt(search)).toEqual({ kind: "read", session_id: "ses_42" });
  });

  it("wins over query — session_id is the more specific intent", async () => {
    const { tool, search } = buildTool();
    await tool.handler({ session_id: "ses_42", query: "auth" });
    expect(requestAt(search)).toEqual({ kind: "read", session_id: "ses_42" });
  });

  it("falls back to discover when session_id is blank", async () => {
    const { tool, search } = buildTool();
    await tool.handler({ session_id: "  ", query: "auth" });
    expect(requestAt(search)).toMatchObject({
      kind: "discover",
      query: "auth",
    });
  });
});

describe("shape inference: scroll", () => {
  it("maps session_id + around_message_id to scroll", async () => {
    const { tool, search } = buildTool();
    await tool.handler({
      session_id: "ses_42",
      around_message_id: "evt_7",
      window: 10,
    });
    expect(requestAt(search)).toEqual({
      kind: "scroll",
      session_id: "ses_42",
      around_message_id: "evt_7",
      window: 10,
    });
  });

  it("trims both ids and leaves window to the service when absent", async () => {
    const { tool, search } = buildTool();
    await tool.handler({
      session_id: " ses_42 ",
      around_message_id: " intent:ses_42 ",
    });
    expect(requestAt(search)).toEqual({
      kind: "scroll",
      session_id: "ses_42",
      around_message_id: "intent:ses_42",
      window: undefined,
    });
  });

  it("beats query when all three are present", async () => {
    const { tool, search } = buildTool();
    await tool.handler({
      session_id: "ses_42",
      around_message_id: "evt_7",
      query: "auth",
    });
    expect(requestAt(search).kind).toBe("scroll");
  });

  it("degrades to read when around_message_id is blank", async () => {
    const { tool, search } = buildTool();
    await tool.handler({ session_id: "ses_42", around_message_id: "   " });
    expect(requestAt(search)).toEqual({ kind: "read", session_id: "ses_42" });
  });

  it("ignores a non-numeric window", async () => {
    const { tool, search } = buildTool();
    await tool.handler({
      session_id: "ses_42",
      around_message_id: "evt_7",
      window: "10",
    });
    expect(requestAt(search)).toMatchObject({ window: undefined });
  });
});

// ── Failure envelopes ────────────────────────────────────────────────────

describe("failure envelopes", () => {
  it("turns a null result into not_found_or_forbidden", async () => {
    // null is the service's single answer for "out of scope, missing
    // anchor, or anchor in your own live conversation" — the tool must
    // not leak which, but must mark it an error.
    const { tool } = buildTool({ result: null });

    const out = await tool.handler({ session_id: "ses_other" });

    expect(out.isError).toBe(true);
    expect(out.content.error).toBe("not_found_or_forbidden");
    expect(typeof out.content.message).toBe("string");
  });

  it("surfaces a SessionSearchError's code", async () => {
    const { tool } = buildTool({
      throws: new SessionSearchError(
        "forbidden_agent_filter",
        "agent_zzz is outside your scope",
      ),
    });

    const out = await tool.handler({
      query: "x",
      filters: { agent_id: "agent_zzz" },
    });

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({
      error: "forbidden_agent_filter",
      message: "agent_zzz is outside your scope",
    });
  });

  it("matches SessionSearchError by name too, for cross-bundle imports", async () => {
    // An integration script consuming src/ while the api consumes dist/
    // produces a structurally identical error that fails `instanceof`.
    // The code still has to reach the agent.
    const impostor = Object.assign(new Error("missing query"), {
      name: "SessionSearchError",
      code: "missing_query",
    });
    const { tool } = buildTool({ throws: impostor });

    const out = await tool.handler({ query: "x" });

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({
      error: "missing_query",
      message: "missing query",
    });
  });

  it("wraps an unexpected Error as internal_error", async () => {
    const { tool } = buildTool({ throws: new Error("pool exhausted") });

    const out = await tool.handler({});

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({
      error: "internal_error",
      message: "pool exhausted",
    });
  });

  it("stringifies a non-Error throw", async () => {
    const { tool } = buildTool({ throws: "kaboom" });

    const out = await tool.handler({});

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({ error: "internal_error", message: "kaboom" });
  });
});
