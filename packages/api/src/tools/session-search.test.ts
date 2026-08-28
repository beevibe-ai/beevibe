/**
 * session_search tool tests.
 *
 * The tool's own job is shape inference — turning one flat bag of MCP
 * arguments into exactly one of the four typed SessionSearchRequests —
 * plus threading caller context and translating the service's failures.
 * The FTS itself lives behind SessionSearchRepository and is covered by
 * the DB-backed suite, so the service is faked here and the assertions
 * are about which request it was handed.
 */
import { describe, expect, it, vi } from "vitest";
import type { SessionSearchRequest, SessionSearchResult } from "@beevibe/core";
import {
  SessionSearchError,
  type SessionSearchService,
} from "@beevibe/core/services/session-search";
import {
  createSessionSearchTool,
  type SessionSearchToolContext,
} from "./session-search.js";

const RESULT = { kind: "browse", sessions: [] } as unknown as SessionSearchResult;

function harness(opts: { result?: SessionSearchResult | null; throws?: unknown } = {}) {
  const calls: Array<{ req: SessionSearchRequest; ctx: unknown }> = [];
  const sessionSearch = {
    search: vi.fn(async (req: SessionSearchRequest, searchCtx: unknown) => {
      if (opts.throws) throw opts.throws;
      calls.push({ req, ctx: searchCtx });
      return opts.result === undefined ? RESULT : opts.result;
    }),
  } as unknown as SessionSearchService;
  return { sessionSearch, calls };
}

const ctx: SessionSearchToolContext = {
  agentId: "agent_a",
  hierarchyLevel: "team",
  sessionId: "sess_current",
};

function tool(sessionSearch: SessionSearchService) {
  return createSessionSearchTool(ctx, { sessionSearch });
}

describe("session_search descriptor", () => {
  it("exposes all four calling shapes' arguments with no required set", () => {
    const { sessionSearch } = harness();
    const t = tool(sessionSearch);

    expect(t.name).toBe("session_search");
    expect(Object.keys(t.schema.properties as object).sort()).toEqual([
      "around_message_id",
      "filters",
      "limit",
      "query",
      "session_id",
      "sort",
      "window",
    ]);
    // Every shape is reachable, including the zero-argument browse.
    expect(t.schema.required).toBeUndefined();
  });
});

describe("shape inference", () => {
  it("infers scroll when session_id and around_message_id are both present", async () => {
    const { sessionSearch, calls } = harness();

    await tool(sessionSearch).handler({
      session_id: "sess_1",
      around_message_id: "evt_9",
      window: 10,
      // Discovery-only args must not leak into the scroll request.
      query: "auth refactor",
      limit: 7,
    });

    expect(calls[0]?.req).toEqual({
      kind: "scroll",
      session_id: "sess_1",
      around_message_id: "evt_9",
      window: 10,
    });
  });

  it("drops a non-numeric window rather than forwarding it", async () => {
    const { sessionSearch, calls } = harness();

    await tool(sessionSearch).handler({
      session_id: "sess_1",
      around_message_id: "evt_9",
      window: "10",
    });

    expect(calls[0]?.req).toMatchObject({ kind: "scroll", window: undefined });
  });

  it("infers read from a bare session_id", async () => {
    const { sessionSearch, calls } = harness();

    await tool(sessionSearch).handler({ session_id: "sess_1", query: "ignored" });

    expect(calls[0]?.req).toEqual({ kind: "read", session_id: "sess_1" });
  });

  it("treats a blank around_message_id as absent, falling back to read", async () => {
    const { sessionSearch, calls } = harness();

    await tool(sessionSearch).handler({
      session_id: "sess_1",
      around_message_id: "   ",
    });

    expect(calls[0]?.req).toEqual({ kind: "read", session_id: "sess_1" });
  });

  it("infers discover from a query, forwarding limit, sort and filters", async () => {
    const { sessionSearch, calls } = harness();
    const filters = { session_type: "task", status: "failed" };

    await tool(sessionSearch).handler({
      query: "  auth refactor  ",
      limit: 5,
      sort: "newest",
      filters,
    });

    expect(calls[0]?.req).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: 5,
      sort: "newest",
      filters,
    });
  });

  it("drops an unrecognized sort", async () => {
    const { sessionSearch, calls } = harness();

    await tool(sessionSearch).handler({ query: "x", sort: "relevance" });

    expect(calls[0]?.req).toMatchObject({ kind: "discover", sort: undefined });
  });

  it("infers browse from no arguments at all", async () => {
    const { sessionSearch, calls } = harness();

    await tool(sessionSearch).handler({});

    expect(calls[0]?.req).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it.each([
    ["a blank query", { query: "   " }],
    ["a non-string query", { query: 42 }],
    ["a blank session_id", { session_id: "  " }],
  ])("falls back to browse for %s", async (_label, input) => {
    const { sessionSearch, calls } = harness();

    await tool(sessionSearch).handler(input);

    expect(calls[0]?.req).toMatchObject({ kind: "browse" });
  });

  it("carries limit and filters into browse", async () => {
    const { sessionSearch, calls } = harness();
    const filters = { since: "2026-01-01T00:00:00Z" };

    await tool(sessionSearch).handler({ limit: 8, filters });

    expect(calls[0]?.req).toEqual({ kind: "browse", limit: 8, filters });
  });

  it("ignores a null or non-object filters bag", async () => {
    const { sessionSearch, calls } = harness();

    await tool(sessionSearch).handler({ query: "x", filters: null });
    await tool(sessionSearch).handler({ query: "x", filters: "task" });

    expect(calls.map((c) => (c.req as { filters?: unknown }).filters)).toEqual([
      undefined,
      undefined,
    ]);
  });
});

describe("caller context", () => {
  it("threads agent id, tier and current session to the service", async () => {
    const { sessionSearch, calls } = harness();

    await tool(sessionSearch).handler({ query: "x" });

    expect(calls[0]?.ctx).toEqual({
      callerAgentId: "agent_a",
      hierarchyLevel: "team",
      currentSessionId: "sess_current",
    });
  });

  it("returns the service result unwrapped on success", async () => {
    const { sessionSearch } = harness();

    const result = await tool(sessionSearch).handler({});

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe(RESULT);
  });
});

describe("error translation", () => {
  it("turns a null result into not_found_or_forbidden", async () => {
    const { sessionSearch } = harness({ result: null });

    const result = await tool(sessionSearch).handler({ session_id: "sess_x" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "not_found_or_forbidden" });
  });

  it.each(["forbidden_agent_filter", "missing_query", "missing_args"] as const)(
    "surfaces SessionSearchError code %s verbatim",
    async (code) => {
      const { sessionSearch } = harness({
        throws: new SessionSearchError(code, `nope: ${code}`),
      });

      const result = await tool(sessionSearch).handler({ query: "x" });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual({ error: code, message: `nope: ${code}` });
    },
  );

  it("matches a cross-bundle SessionSearchError by name, not just instanceof", async () => {
    // An integration script consuming core's src/ while the api consumes
    // dist/ throws a structurally identical error from a different class
    // identity; the code still has to reach the agent.
    const impostor = new Error("out of scope");
    impostor.name = "SessionSearchError";
    (impostor as unknown as { code: string }).code = "forbidden_agent_filter";
    const { sessionSearch } = harness({ throws: impostor });

    const result = await tool(sessionSearch).handler({ query: "x" });

    expect(result.content).toEqual({
      error: "forbidden_agent_filter",
      message: "out of scope",
    });
  });

  it("wraps any other Error as internal_error", async () => {
    const { sessionSearch } = harness({ throws: new Error("connection reset") });

    const result = await tool(sessionSearch).handler({ query: "x" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "internal_error",
      message: "connection reset",
    });
  });

  it("stringifies a non-Error throw", async () => {
    const { sessionSearch } = harness({ throws: "just a string" });

    const result = await tool(sessionSearch).handler({ query: "x" });

    expect(result.content).toEqual({
      error: "internal_error",
      message: "just a string",
    });
  });
});
