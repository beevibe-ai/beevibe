/**
 * createSessionSearchTool — the session_search MCP adapter.
 *
 * The interesting logic here is `inferRequest`: four calling shapes
 * (discovery / scroll / read / browse) are inferred from which raw MCP
 * fields are present, with a fixed precedence. Getting that precedence
 * wrong silently sends the agent a different shape of answer than it
 * asked for, so each branch and each tie-break is pinned below.
 *
 * The second half covers the error envelope: a null result means
 * "not found or out of scope", a SessionSearchError keeps its code, and
 * anything else degrades to internal_error. SessionSearchService's own
 * scope resolution is covered in core against a real pool.
 */

import { describe, expect, it, vi } from "vitest";
import { SessionSearchError } from "@beevibe/core/services/session-search";
import type { SessionSearchService } from "@beevibe/core/services/session-search";
import {
  createSessionSearchTool,
  type SessionSearchToolContext,
} from "./session-search.js";

function harness(
  opts: {
    ctx?: Partial<SessionSearchToolContext>;
    searchImpl?: (...args: unknown[]) => Promise<unknown>;
  } = {},
) {
  const search = vi.fn(opts.searchImpl ?? (async () => ({ ok: true })));
  const sessionSearch = { search } as unknown as SessionSearchService;
  const tool = createSessionSearchTool(
    {
      agentId: "agent_a",
      hierarchyLevel: "ic",
      sessionId: "sess_current",
      ...opts.ctx,
    },
    { sessionSearch },
  );
  // The request is the first arg, the caller scope the second.
  const req = () => search.mock.calls[0]?.[0] as Record<string, unknown>;
  const scope = () => search.mock.calls[0]?.[1] as Record<string, unknown>;
  return { search, tool, req, scope };
}

describe("session_search tool descriptor", () => {
  it("is named session_search and takes no required fields", () => {
    const { tool } = harness();
    expect(tool.name).toBe("session_search");
    // Every shape is optional — a bare call is the browse shape.
    expect(tool.schema.required).toBeUndefined();
  });

  it("documents all four calling shapes in the agent-facing description", () => {
    const { tool } = harness();
    for (const shape of ["DISCOVERY", "SCROLL", "READ", "BROWSE"]) {
      expect(tool.description).toContain(shape);
    }
  });

  it("exposes the filter surface agents are told to use", () => {
    const { tool } = harness();
    const props = tool.schema.properties as Record<string, unknown>;
    const filters = props.filters as { properties: Record<string, unknown> };
    expect(Object.keys(filters.properties).sort()).toEqual([
      "agent_id",
      "session_type",
      "since",
      "status",
      "task_id",
      "until",
    ]);
  });
});

describe("shape inference", () => {
  it("browses when called with no arguments", async () => {
    const { tool, req } = harness();
    await tool.handler({});
    expect(req()).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("discovers when given a query", async () => {
    const { tool, req } = harness();
    await tool.handler({ query: "auth refactor", limit: 3, sort: "newest" });
    expect(req()).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: 3,
      sort: "newest",
      filters: undefined,
    });
  });

  it("reads the whole conversation when given a bare session_id", async () => {
    const { tool, req } = harness();
    await tool.handler({ session_id: "sess_42" });
    expect(req()).toEqual({ kind: "read", session_id: "sess_42" });
  });

  it("scrolls when given both session_id and around_message_id", async () => {
    const { tool, req } = harness();
    await tool.handler({
      session_id: "sess_42",
      around_message_id: "evt_7",
      window: 10,
    });
    expect(req()).toEqual({
      kind: "scroll",
      session_id: "sess_42",
      around_message_id: "evt_7",
      window: 10,
    });
  });

  it("prefers scroll over discovery when a query is also present", async () => {
    const { tool, req } = harness();
    await tool.handler({
      query: "ignored",
      session_id: "sess_42",
      around_message_id: "evt_7",
    });
    expect(req()).toMatchObject({ kind: "scroll" });
    expect(req()).not.toHaveProperty("query");
  });

  it("prefers read over discovery when a query is also present", async () => {
    const { tool, req } = harness();
    await tool.handler({ query: "ignored", session_id: "sess_42" });
    expect(req()).toEqual({ kind: "read", session_id: "sess_42" });
  });

  it("falls back to discovery when around_message_id has no session_id", async () => {
    const { tool, req } = harness();
    await tool.handler({ query: "docker", around_message_id: "evt_7" });
    expect(req()).toMatchObject({ kind: "discover", query: "docker" });
  });

  it("falls back to browse when only around_message_id is given", async () => {
    const { tool, req } = harness();
    await tool.handler({ around_message_id: "evt_7" });
    expect(req()).toMatchObject({ kind: "browse" });
  });

  it("trims whitespace off ids and the query", async () => {
    const { tool, req } = harness();
    await tool.handler({
      session_id: "  sess_42  ",
      around_message_id: "  evt_7  ",
    });
    expect(req()).toMatchObject({
      session_id: "sess_42",
      around_message_id: "evt_7",
    });
  });

  it("treats a whitespace-only query as absent and browses instead", async () => {
    const { tool, req } = harness();
    await tool.handler({ query: "   " });
    expect(req()).toMatchObject({ kind: "browse" });
  });

  it("treats a whitespace-only session_id as absent", async () => {
    const { tool, req } = harness();
    await tool.handler({ session_id: "   ", query: "docker" });
    expect(req()).toMatchObject({ kind: "discover", query: "docker" });
  });

  it("ignores non-string session_id, anchor and query values", async () => {
    const { tool, req } = harness();
    await tool.handler({ session_id: 42, around_message_id: [], query: {} });
    expect(req()).toMatchObject({ kind: "browse" });
  });

  it("drops a non-numeric limit and window rather than forwarding junk", async () => {
    const { tool, req, search } = harness();
    await tool.handler({ query: "x", limit: "3" });
    expect(req()).toMatchObject({ limit: undefined });

    search.mockClear();
    const second = harness();
    await second.tool.handler({
      session_id: "s",
      around_message_id: "a",
      window: "10",
    });
    expect(second.req()).toMatchObject({ window: undefined });
  });

  it("drops a sort value outside the newest/oldest enum", async () => {
    const { tool, req } = harness();
    await tool.handler({ query: "x", sort: "relevance" });
    expect(req()).toMatchObject({ sort: undefined });
  });

  it("accepts 'oldest' as a sort", async () => {
    const { tool, req } = harness();
    await tool.handler({ query: "x", sort: "oldest" });
    expect(req()).toMatchObject({ sort: "oldest" });
  });

  it("passes filters through on the discovery shape", async () => {
    const { tool, req } = harness();
    const filters = { session_type: "task", status: "failed" };
    await tool.handler({ query: "x", filters });
    expect(req()).toMatchObject({ filters });
  });

  it("passes filters through on the browse shape", async () => {
    const { tool, req } = harness();
    const filters = { agent_id: "agent_b" };
    await tool.handler({ filters });
    expect(req()).toMatchObject({ kind: "browse", filters });
  });

  it("ignores a null filters value", async () => {
    const { tool, req } = harness();
    await tool.handler({ query: "x", filters: null });
    expect(req()).toMatchObject({ filters: undefined });
  });

  it("ignores a non-object filters value", async () => {
    const { tool, req } = harness();
    await tool.handler({ query: "x", filters: "status:failed" });
    expect(req()).toMatchObject({ filters: undefined });
  });
});

describe("caller scope", () => {
  it("passes the caller agent, tier and current session to the service", async () => {
    const { tool, scope } = harness({
      ctx: {
        agentId: "agent_team",
        hierarchyLevel: "team",
        sessionId: "sess_live",
      },
    });

    await tool.handler({ query: "x" });

    expect(scope()).toEqual({
      callerAgentId: "agent_team",
      hierarchyLevel: "team",
      // excluded from results so the agent can't re-discover its own context
      currentSessionId: "sess_live",
    });
  });
});

describe("result and error envelopes", () => {
  it("returns the service payload untouched on success", async () => {
    const payload = { results: [{ session: { id: "sess_1" } }] };
    const { tool } = harness({ searchImpl: async () => payload });

    const result = await tool.handler({ query: "x" });

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe(payload);
  });

  it("maps a null result to not_found_or_forbidden", async () => {
    const { tool } = harness({ searchImpl: async () => null });

    const result = await tool.handler({ session_id: "sess_other" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "not_found_or_forbidden",
      message: expect.stringContaining("not in your scope"),
    });
  });

  it("keeps the code off a thrown SessionSearchError", async () => {
    const { tool } = harness({
      searchImpl: async () => {
        throw new SessionSearchError(
          "forbidden_agent_filter",
          "agent_b is outside your scope",
        );
      },
    });

    const result = await tool.handler({
      query: "x",
      filters: { agent_id: "agent_b" },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "forbidden_agent_filter",
      message: "agent_b is outside your scope",
    });
  });

  it("recognizes a SessionSearchError from another bundle by name", async () => {
    // src/ vs dist/ dual-loading means instanceof can fail across
    // bundles; the handler falls back to matching err.name.
    class ForeignSessionSearchError extends Error {
      code = "missing_query";
      constructor(message: string) {
        super(message);
        this.name = "SessionSearchError";
      }
    }
    const { tool } = harness({
      searchImpl: async () => {
        throw new ForeignSessionSearchError("query is required");
      },
    });

    const result = await tool.handler({ query: "x" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "missing_query",
      message: "query is required",
    });
  });

  it("degrades an unexpected Error to internal_error", async () => {
    const { tool } = harness({
      searchImpl: async () => {
        throw new Error("connection terminated unexpectedly");
      },
    });

    const result = await tool.handler({ query: "x" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "internal_error",
      message: "connection terminated unexpectedly",
    });
  });

  it("stringifies a non-Error throw", async () => {
    const { tool } = harness({
      searchImpl: async () => {
        throw "pg died";
      },
    });

    const result = await tool.handler({ query: "x" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "internal_error",
      message: "pg died",
    });
  });
});
