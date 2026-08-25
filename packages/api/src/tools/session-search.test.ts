/**
 * `session_search` — Layer-3 memory. Unit tests with a fake service.
 *
 * The service does the scope resolution and the SQL; the tool's whole
 * job is (a) inferring which of the four calling shapes the agent
 * meant from a loosely-typed input bag, and (b) translating the
 * result — including `null` and a thrown SessionSearchError — into the
 * MCP envelope. Shape inference is where an agent's sloppy call turns
 * into the wrong query, so the precedence rules get a case each.
 */
import { describe, expect, it, vi } from "vitest";
import type { HierarchyLevel, SessionSearchRequest } from "@beevibe/core";
import {
  SessionSearchError,
  type SessionSearchService,
} from "@beevibe/core/services/session-search";
import { createSessionSearchTool } from "./session-search.js";

const CTX: { agentId: string; hierarchyLevel: HierarchyLevel; sessionId: string } = {
  agentId: "agent_ic",
  hierarchyLevel: "ic",
  sessionId: "sess_current00",
};

function makeTool(
  searchImpl?: (...args: unknown[]) => Promise<unknown>,
  ctx: Partial<typeof CTX> = {},
) {
  const search = vi.fn(searchImpl ?? (async () => ({ kind: "browse", sessions: [] })));
  const tool = createSessionSearchTool(
    { ...CTX, ...ctx },
    { sessionSearch: { search } as unknown as SessionSearchService },
  );
  const reqOf = (i = 0) => search.mock.calls[i]![0] as SessionSearchRequest;
  return { tool, search, reqOf };
}

describe("session_search surface", () => {
  it("is named session_search and takes no required args", () => {
    const { tool } = makeTool();
    expect(tool.name).toBe("session_search");
    expect(tool.schema.required).toBeUndefined();
  });
});

describe("shape inference", () => {
  it("browses when nothing usable is passed", async () => {
    const { tool, reqOf } = makeTool();
    await tool.handler({});
    expect(reqOf()).toEqual({ kind: "browse", limit: undefined, filters: undefined });
  });

  it("discovers when a query is present", async () => {
    const { tool, reqOf } = makeTool();
    await tool.handler({ query: "  auth refactor  ", limit: 5, sort: "newest" });
    expect(reqOf()).toMatchObject({
      kind: "discover",
      query: "auth refactor",
      limit: 5,
      sort: "newest",
    });
  });

  it("reads when a bare session_id is present", async () => {
    const { tool, reqOf } = makeTool();
    await tool.handler({ session_id: "  sess_target000  " });
    expect(reqOf()).toEqual({ kind: "read", session_id: "sess_target000" });
  });

  it("scrolls when session_id and around_message_id are both present", async () => {
    const { tool, reqOf } = makeTool();
    await tool.handler({
      session_id: "sess_target000",
      around_message_id: "evt_9",
      window: 10,
    });
    expect(reqOf()).toEqual({
      kind: "scroll",
      session_id: "sess_target000",
      around_message_id: "evt_9",
      window: 10,
    });
  });

  it("lets scroll win over a query passed alongside it", async () => {
    const { tool, reqOf } = makeTool();
    await tool.handler({
      query: "ignored",
      session_id: "sess_target000",
      around_message_id: "evt_9",
    });
    expect(reqOf().kind).toBe("scroll");
  });

  it("lets read win over a query passed alongside it", async () => {
    const { tool, reqOf } = makeTool();
    await tool.handler({ query: "ignored", session_id: "sess_target000" });
    expect(reqOf().kind).toBe("read");
  });

  it("falls back to browse when every string arg is blank", async () => {
    const { tool, reqOf } = makeTool();
    await tool.handler({ query: "   ", session_id: "  ", around_message_id: "   " });
    expect(reqOf().kind).toBe("browse");
  });

  it("treats a blank around_message_id as a read, not a scroll", async () => {
    const { tool, reqOf } = makeTool();
    await tool.handler({ session_id: "sess_target000", around_message_id: "   " });
    expect(reqOf()).toEqual({ kind: "read", session_id: "sess_target000" });
  });

  it("ignores non-string query and session_id values", async () => {
    const { tool, reqOf } = makeTool();
    await tool.handler({ query: 42, session_id: null });
    expect(reqOf().kind).toBe("browse");
  });
});

describe("optional argument coercion", () => {
  it("drops a non-numeric limit and window rather than forwarding junk", async () => {
    const { tool, reqOf } = makeTool();
    await tool.handler({ query: "x", limit: "5" });
    expect((reqOf(0) as { limit?: number }).limit).toBeUndefined();

    await tool.handler({ session_id: "sess_a", around_message_id: "evt_1", window: "10" });
    expect((reqOf(1) as { window?: number }).window).toBeUndefined();
  });

  it("only accepts 'newest' or 'oldest' for sort", async () => {
    const { tool, reqOf } = makeTool();
    for (const sort of ["newest", "oldest", "relevance", 1, undefined]) {
      await tool.handler({ query: "x", sort });
    }
    expect((reqOf(0) as { sort?: string }).sort).toBe("newest");
    expect((reqOf(1) as { sort?: string }).sort).toBe("oldest");
    for (const i of [2, 3, 4]) {
      expect((reqOf(i) as { sort?: string }).sort).toBeUndefined();
    }
  });

  it("forwards a filters object and drops a non-object one", async () => {
    const { tool, reqOf } = makeTool();
    await tool.handler({ query: "x", filters: { status: "failed" } });
    expect((reqOf(0) as { filters?: unknown }).filters).toEqual({ status: "failed" });

    await tool.handler({ query: "x", filters: "failed" });
    expect((reqOf(1) as { filters?: unknown }).filters).toBeUndefined();

    await tool.handler({ query: "x", filters: null });
    expect((reqOf(2) as { filters?: unknown }).filters).toBeUndefined();
  });
});

describe("caller scope", () => {
  it("passes the caller's agent, tier and active session to the service", async () => {
    const { tool, search } = makeTool(undefined, {
      agentId: "agent_team",
      hierarchyLevel: "team",
      sessionId: "sess_live00000",
    });
    await tool.handler({ query: "x" });
    expect(search.mock.calls[0]![1]).toEqual({
      callerAgentId: "agent_team",
      hierarchyLevel: "team",
      currentSessionId: "sess_live00000",
    });
  });
});

describe("result translation", () => {
  it("returns the service result verbatim on success", async () => {
    const payload = { kind: "read", session: { id: "sess_a" }, messages: [{ id: "evt_1" }] };
    const { tool } = makeTool(async () => payload);
    const result = await tool.handler({ session_id: "sess_a" });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual(payload);
  });

  it("maps a null result to not_found_or_forbidden", async () => {
    const { tool } = makeTool(async () => null);
    const result = await tool.handler({ session_id: "sess_out_of_scope" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "not_found_or_forbidden" });
    expect(String(result.content.message)).toContain("scope");
  });

  it("surfaces a SessionSearchError's structured code", async () => {
    const { tool } = makeTool(async () => {
      throw new SessionSearchError(
        "forbidden_agent_filter",
        "agent_other is outside your scope",
      );
    });
    const result = await tool.handler({ query: "x", filters: { agent_id: "agent_other" } });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "forbidden_agent_filter",
      message: "agent_other is outside your scope",
    });
  });

  it("matches SessionSearchError by name too, for cross-bundle imports", async () => {
    // An integration script consuming core's src/ while api consumes
    // dist/ throws a structurally identical error that fails
    // `instanceof`. The code still has to reach the agent.
    const impostor = Object.assign(new Error("no query given"), {
      name: "SessionSearchError",
      code: "missing_query",
    });
    const { tool } = makeTool(async () => {
      throw impostor;
    });
    const result = await tool.handler({ query: "x" });
    expect(result.content).toEqual({ error: "missing_query", message: "no query given" });
  });

  it("degrades an unexpected throw to internal_error", async () => {
    const { tool } = makeTool(async () => {
      throw new Error("connection terminated");
    });
    const result = await tool.handler({ query: "x" });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "internal_error",
      message: "connection terminated",
    });
  });

  it("stringifies a non-Error throw", async () => {
    const { tool } = makeTool(async () => {
      throw "kaboom";
    });
    const result = await tool.handler({ query: "x" });
    expect(result.content).toEqual({ error: "internal_error", message: "kaboom" });
  });
});
