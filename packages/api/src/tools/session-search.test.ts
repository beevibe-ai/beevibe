/**
 * session_search MCP tool — unit tests with vitest fakes (no DB).
 *
 * The service does the scoping and the SQL; the tool owns `inferRequest`,
 * which turns loosely-typed MCP input into one of four request shapes.
 * Shape inference is priority-ordered (scroll > read > discover > browse)
 * and silently mis-routing a call is invisible at runtime — a scroll that
 * degrades to a read dumps a whole transcript into the agent's context
 * instead of a ±5 window. Hence a case per shape, plus the error mapping.
 */
import { describe, expect, it, vi } from "vitest";
import type { HierarchyLevel, SessionSearchRequest } from "@beevibe/core";
import {
  SessionSearchError,
  type SessionSearchContext,
  type SessionSearchService,
} from "@beevibe/core/services/session-search";
import { createSessionSearchTool } from "./session-search.js";

const CTX = {
  agentId: "agent_a",
  hierarchyLevel: "team" as HierarchyLevel,
  sessionId: "sess_current",
};

const BROWSE_RESULT = { kind: "browse", sessions: [] };

/** A `search` double whose recorded calls keep their argument types. */
function fakeSearch(
  impl: (
    req: SessionSearchRequest,
    ctx: SessionSearchContext,
  ) => Promise<unknown> = async () => BROWSE_RESULT,
) {
  return vi.fn(
    async (req: SessionSearchRequest, ctx: SessionSearchContext) =>
      (await impl(req, ctx)) as never,
  );
}

function build(search = fakeSearch(), ctx = CTX) {
  const sessionSearch = { search } as unknown as SessionSearchService;
  return { tool: createSessionSearchTool(ctx, { sessionSearch }), sessionSearch };
}

/** The request the tool inferred from one raw MCP input. */
async function inferred(
  input: Record<string, unknown>,
): Promise<SessionSearchRequest> {
  const search = fakeSearch();
  const { tool } = build(search);
  await tool.handler(input);
  return search.mock.calls[0]![0];
}

describe("session_search tool descriptor", () => {
  it("exposes the four calling shapes and the filter enums agents pick from", () => {
    const { tool } = build();
    const props = tool.schema.properties as Record<string, Record<string, unknown>>;
    const filters = props.filters?.properties as Record<string, { enum?: string[] }>;

    expect(tool.name).toBe("session_search");
    expect(tool.description).toContain("FOUR CALLING SHAPES");
    expect(Object.keys(props)).toEqual([
      "query",
      "limit",
      "sort",
      "session_id",
      "around_message_id",
      "window",
      "filters",
    ]);
    expect(filters.session_type?.enum).toContain("run_repo");
    expect(filters.status?.enum).toContain("failed");
    // No `required` — a bare call is the browse shape.
    expect(tool.schema.required).toBeUndefined();
  });
});

describe("session_search shape inference", () => {
  it("browses when called with no arguments", async () => {
    expect(await inferred({})).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("discovers when given a query", async () => {
    expect(await inferred({ query: "  auth refactor  ", limit: 7, sort: "newest" })).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: 7,
      sort: "newest",
      filters: undefined,
    });
  });

  it("reads when given a bare session_id", async () => {
    expect(await inferred({ session_id: "  sess_7  ", query: "ignored" })).toEqual({
      kind: "read",
      session_id: "sess_7",
    });
  });

  it("scrolls when given session_id + around_message_id, outranking query", async () => {
    expect(
      await inferred({
        session_id: "sess_7",
        around_message_id: "  evt_3  ",
        window: 12,
        query: "ignored",
      }),
    ).toEqual({
      kind: "scroll",
      session_id: "sess_7",
      around_message_id: "evt_3",
      window: 12,
    });
  });

  it("falls back to browse when every string argument is blank", async () => {
    const req = await inferred({
      query: "   ",
      session_id: "  ",
      around_message_id: "  ",
    });

    expect(req.kind).toBe("browse");
  });

  it("treats an anchor without a session_id as discovery, not scroll", async () => {
    const req = await inferred({ around_message_id: "evt_3", query: "auth" });

    expect(req.kind).toBe("discover");
  });

  it("drops non-numeric window / limit and unknown sort values", async () => {
    expect(await inferred({ session_id: "sess_7", around_message_id: "evt_3", window: "10" }))
      .toMatchObject({ window: undefined });
    expect(await inferred({ query: "x", limit: "3", sort: "relevance" })).toMatchObject({
      limit: undefined,
      sort: undefined,
    });
    expect(await inferred({ limit: null })).toMatchObject({ limit: undefined });
  });

  it("forwards filters on the discover and browse shapes", async () => {
    const filters = { status: "failed", session_type: "task" };

    expect(await inferred({ query: "x", filters })).toMatchObject({ filters });
    expect(await inferred({ filters })).toMatchObject({ filters });
  });

  it("ignores a non-object filters value", async () => {
    expect(await inferred({ filters: "status:failed" })).toMatchObject({
      filters: undefined,
    });
    expect(await inferred({ filters: null })).toMatchObject({ filters: undefined });
  });
});

describe("session_search delegation", () => {
  it("passes the caller's tier and current session as the search context", async () => {
    const search = fakeSearch();
    const { tool } = build(search);

    await tool.handler({ query: "auth" });

    expect(search.mock.calls[0]?.[1]).toEqual({
      callerAgentId: "agent_a",
      hierarchyLevel: "team",
      currentSessionId: "sess_current",
    });
  });

  it("returns the service result verbatim", async () => {
    const result = { kind: "read", session: { id: "sess_7" }, messages: [] };
    const { tool } = build(fakeSearch(async () => result));

    const out = await tool.handler({ session_id: "sess_7" });

    expect(out.isError).toBeFalsy();
    expect(out.content).toBe(result);
  });

  it("turns a null result into not_found_or_forbidden", async () => {
    const { tool } = build(fakeSearch(async () => null));

    const out = await tool.handler({ session_id: "sess_other" });

    expect(out.isError).toBe(true);
    expect(out.content).toMatchObject({ error: "not_found_or_forbidden" });
  });
});

describe("session_search error mapping", () => {
  it("surfaces a SessionSearchError's code", async () => {
    const { tool } = build(
      fakeSearch(async () => {
        throw new SessionSearchError(
          "forbidden_agent_filter",
          "agent_id outside your scope",
        );
      }),
    );

    const out = await tool.handler({ query: "x", filters: { agent_id: "agent_z" } });

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({
      error: "forbidden_agent_filter",
      message: "agent_id outside your scope",
    });
  });

  it("matches by error name too, for a cross-bundle SessionSearchError", async () => {
    // src/ and dist/ copies of core are different classes, so instanceof
    // fails across the bundle boundary; the name check is the fallback.
    const foreign = new Error("query is required for discovery") as Error & {
      code: string;
    };
    foreign.name = "SessionSearchError";
    foreign.code = "missing_query";
    const { tool } = build(
      fakeSearch(async () => {
        throw foreign;
      }),
    );

    const out = await tool.handler({ query: "x" });

    expect(out.content).toEqual({
      error: "missing_query",
      message: "query is required for discovery",
    });
  });

  it("wraps anything else as internal_error", async () => {
    const { tool } = build(
      fakeSearch(async () => {
        throw new Error("connection reset");
      }),
    );

    const out = await tool.handler({ query: "x" });

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({
      error: "internal_error",
      message: "connection reset",
    });
  });

  it("stringifies a non-Error throw", async () => {
    const { tool } = build(
      fakeSearch(async () => {
        throw "kaput";
      }),
    );

    const out = await tool.handler({});

    expect(out.content).toEqual({ error: "internal_error", message: "kaput" });
  });
});
