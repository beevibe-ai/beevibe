import { describe, expect, it, vi } from "vitest";
import type { SessionSearchRequest } from "@beevibe/core";
import {
  SessionSearchError,
  type SessionSearchContext,
  type SessionSearchService,
} from "@beevibe/core/services/session-search";
import {
  createSessionSearchTool,
  type SessionSearchToolContext,
} from "./session-search.js";

function harness(ctx: Partial<SessionSearchToolContext> = {}) {
  // Params are declared so `search.mock.calls` keeps its tuple type.
  const search = vi.fn(
    async (_req: SessionSearchRequest, _ctx: SessionSearchContext) => ({
      kind: "browse",
      sessions: [],
    }),
  );
  const sessionSearch = { search } as unknown as SessionSearchService;
  const tool = createSessionSearchTool(
    {
      agentId: "agent_a",
      hierarchyLevel: "ic",
      sessionId: "sess_current",
      ...ctx,
    },
    { sessionSearch },
  );
  const requestOf = (i = 0): SessionSearchRequest => {
    const call = search.mock.calls[i];
    if (!call) throw new Error(`no session search call at index ${i}`);
    return call[0];
  };
  return { tool, search, requestOf };
}

describe("session_search tool descriptor", () => {
  it("is named session_search and has no required args — browse is the no-arg shape", () => {
    const { tool } = harness();
    expect(tool.name).toBe("session_search");
    expect(tool.schema.required).toBeUndefined();
  });

  it("exposes the documented properties and the sort enum", () => {
    const { tool } = harness();
    const props = tool.schema.properties as Record<string, { enum?: string[] }>;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining([
        "query",
        "limit",
        "sort",
        "session_id",
        "around_message_id",
        "window",
        "filters",
      ]),
    );
    expect(props.sort?.enum).toEqual(["newest", "oldest"]);
  });
});

describe("session_search caller scope", () => {
  it("passes the caller agent, tier and current session as the search context", async () => {
    const { tool, search } = harness({
      agentId: "agent_org",
      hierarchyLevel: "org",
      sessionId: "sess_live",
    });

    await tool.handler({});

    expect(search.mock.calls[0]?.[1]).toEqual<SessionSearchContext>({
      callerAgentId: "agent_org",
      hierarchyLevel: "org",
      currentSessionId: "sess_live",
    });
  });
});

describe("session_search shape inference", () => {
  it("infers browse from no args", async () => {
    const { tool, requestOf } = harness();
    await tool.handler({});
    expect(requestOf()).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("infers discover from a query", async () => {
    const { tool, requestOf } = harness();
    await tool.handler({ query: "auth refactor", limit: 5, sort: "newest" });
    expect(requestOf()).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: 5,
      sort: "newest",
      filters: undefined,
    });
  });

  it("infers read from a bare session_id", async () => {
    const { tool, requestOf } = harness();
    await tool.handler({ session_id: "sess_past" });
    expect(requestOf()).toEqual({ kind: "read", session_id: "sess_past" });
  });

  it("infers scroll from session_id plus around_message_id", async () => {
    const { tool, requestOf } = harness();
    await tool.handler({
      session_id: "sess_past",
      around_message_id: "evt_9",
      window: 10,
    });
    expect(requestOf()).toEqual({
      kind: "scroll",
      session_id: "sess_past",
      around_message_id: "evt_9",
      window: 10,
    });
  });

  // Documented precedence: scroll wins when both session_id + anchor are set,
  // so a stale `query` in the agent's call doesn't silently re-run discovery.
  it("prefers scroll over discover when a query is also present", async () => {
    const { tool, requestOf } = harness();
    await tool.handler({
      query: "auth refactor",
      session_id: "sess_past",
      around_message_id: "evt_9",
    });
    expect(requestOf().kind).toBe("scroll");
  });

  it("prefers read over discover when a query is also present", async () => {
    const { tool, requestOf } = harness();
    await tool.handler({ query: "auth refactor", session_id: "sess_past" });
    expect(requestOf()).toEqual({ kind: "read", session_id: "sess_past" });
  });

  // An anchor with no session_id has nothing to center on; it degrades to
  // the next shape down rather than erroring.
  it("ignores a lone around_message_id and falls through to discover", async () => {
    const { tool, requestOf } = harness();
    await tool.handler({ around_message_id: "evt_9", query: "docker" });
    expect(requestOf()).toMatchObject({ kind: "discover", query: "docker" });
  });

  it("ignores a lone around_message_id and falls through to browse", async () => {
    const { tool, requestOf } = harness();
    await tool.handler({ around_message_id: "evt_9" });
    expect(requestOf().kind).toBe("browse");
  });

  it("accepts the synthetic user-turn anchor id format", async () => {
    const { tool, requestOf } = harness();
    await tool.handler({
      session_id: "sess_past",
      around_message_id: "intent:sess_past",
    });
    expect(requestOf()).toMatchObject({
      kind: "scroll",
      around_message_id: "intent:sess_past",
    });
  });
});

describe("session_search input normalisation", () => {
  it("trims session_id, anchor and query", async () => {
    const { tool, requestOf } = harness();
    await tool.handler({
      session_id: "  sess_past  ",
      around_message_id: "  evt_9  ",
    });
    expect(requestOf()).toMatchObject({
      session_id: "sess_past",
      around_message_id: "evt_9",
    });

    await tool.handler({ query: "  docker networking  " });
    expect(requestOf(1)).toMatchObject({ query: "docker networking" });
  });

  it("treats whitespace-only values as absent", async () => {
    const { tool, requestOf } = harness();
    await tool.handler({ session_id: "   ", query: "   " });
    expect(requestOf().kind).toBe("browse");
  });

  it("treats non-string session_id, anchor and query as absent", async () => {
    const { tool, requestOf } = harness();
    await tool.handler({ session_id: 7, around_message_id: 9, query: 11 });
    expect(requestOf().kind).toBe("browse");
  });

  it("drops a non-numeric limit and window so the service defaults apply", async () => {
    const { tool, requestOf } = harness();

    await tool.handler({ query: "x", limit: "3" });
    const discover = requestOf();
    expect(discover.kind === "discover" && discover.limit).toBeUndefined();

    await tool.handler({
      session_id: "s",
      around_message_id: "e",
      window: "10",
    });
    const scroll = requestOf(1);
    expect(scroll.kind === "scroll" && scroll.window).toBeUndefined();
  });

  it("drops an unrecognised sort value", async () => {
    const { tool, requestOf } = harness();
    await tool.handler({ query: "x", sort: "relevance" });
    const req = requestOf();
    expect(req.kind === "discover" && req.sort).toBeUndefined();
  });

  it("forwards filters on the discover shape", async () => {
    const { tool, requestOf } = harness();
    const filters = { session_type: "task", status: "failed", task_id: "task_7" };
    await tool.handler({ query: "deploy", filters });
    expect(requestOf()).toMatchObject({ kind: "discover", filters });
  });

  it("forwards a numeric limit on the browse shape", async () => {
    const { tool, requestOf } = harness();
    await tool.handler({ limit: 10 });
    expect(requestOf()).toEqual({ kind: "browse", limit: 10, filters: undefined });
  });

  it("forwards filters on the browse shape", async () => {
    const { tool, requestOf } = harness();
    const filters = { since: "2026-01-01T00:00:00Z" };
    await tool.handler({ filters });
    expect(requestOf()).toMatchObject({ kind: "browse", filters });
  });

  it("drops non-object filters", async () => {
    const { tool, requestOf } = harness();
    await tool.handler({ query: "x", filters: "status:failed" });
    const req = requestOf();
    expect(req.kind === "discover" && req.filters).toBeUndefined();
  });

  // typeof null === "object", so the null guard is load-bearing.
  it("drops null filters", async () => {
    const { tool, requestOf } = harness();
    await tool.handler({ query: "x", filters: null });
    const req = requestOf();
    expect(req.kind === "discover" && req.filters).toBeUndefined();
  });

  // The scroll shape carries no filters — passing some must not smuggle
  // them past the service's scope resolution.
  it("does not carry filters onto the scroll or read shapes", async () => {
    const { tool, requestOf } = harness();
    await tool.handler({
      session_id: "s",
      around_message_id: "e",
      filters: { agent_id: "agent_other" },
    });
    expect(requestOf()).not.toHaveProperty("filters");

    await tool.handler({ session_id: "s", filters: { agent_id: "agent_other" } });
    expect(requestOf(1)).not.toHaveProperty("filters");
  });
});

describe("session_search result handling", () => {
  it("returns the service result verbatim", async () => {
    const { tool, search } = harness();
    const payload = { kind: "read", session: { id: "sess_past" }, messages: [] };
    search.mockResolvedValueOnce(payload as never);

    const result = await tool.handler({ session_id: "sess_past" });

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe(payload);
  });

  // null is the service's "out of scope / anchor missing" signal; the tool
  // turns it into one combined message rather than leaking which case hit.
  it("maps a null result to not_found_or_forbidden", async () => {
    const { tool, search } = harness();
    search.mockResolvedValueOnce(null as never);

    const result = await tool.handler({ session_id: "sess_other" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "not_found_or_forbidden" });
    expect(result.content.message).toContain("not in your scope");
  });
});

describe("session_search error mapping", () => {
  const codes = ["forbidden_agent_filter", "missing_query", "missing_args"] as const;

  for (const code of codes) {
    it(`surfaces the ${code} code from a SessionSearchError`, async () => {
      const { tool, search } = harness();
      search.mockRejectedValueOnce(new SessionSearchError(code, `boom: ${code}`));

      const result = await tool.handler({ query: "x" });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual({ error: code, message: `boom: ${code}` });
    });
  }

  // Cross-bundle imports (a script on src/, the api on dist/) break
  // instanceof, so the handler also matches on err.name.
  it("recognises a structurally-identical error from another bundle by name", async () => {
    const { tool, search } = harness();
    const foreign = Object.assign(new Error("cross-bundle"), {
      name: "SessionSearchError",
      code: "missing_query",
    });
    search.mockRejectedValueOnce(foreign);

    const result = await tool.handler({ query: "x" });

    expect(result.content).toEqual({
      error: "missing_query",
      message: "cross-bundle",
    });
  });

  it("maps an unexpected Error to internal_error", async () => {
    const { tool, search } = harness();
    search.mockRejectedValueOnce(new Error("pool exhausted"));

    const result = await tool.handler({ query: "x" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "internal_error",
      message: "pool exhausted",
    });
  });

  it("stringifies a non-Error throw", async () => {
    const { tool, search } = harness();
    search.mockRejectedValueOnce("socket hang up");

    const result = await tool.handler({ query: "x" });

    expect(result.content).toEqual({
      error: "internal_error",
      message: "socket hang up",
    });
  });
});
