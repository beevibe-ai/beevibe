/**
 * Unit tests for the `session_search` MCP tool.
 *
 * The retrieval itself belongs to SessionSearchService (covered in core).
 * What this module owns is the agent-facing adapter, and that is what is
 * pinned here:
 *
 *   1. shape inference — which of discover / scroll / read / browse a
 *      given bag of tool input resolves to, including the precedence
 *      rules when several keys are present,
 *   2. caller-context threading into SessionSearchContext,
 *   3. the error envelope, including the by-name SessionSearchError match
 *      that keeps structured codes working across a src/dist bundle split.
 */

import { describe, expect, it, vi } from "vitest";
import type { HierarchyLevel, SessionSearchRequest } from "@beevibe/core";
import {
  SessionSearchError,
  type SessionSearchService,
} from "@beevibe/core/services/session-search";
import {
  createSessionSearchTool,
  type SessionSearchToolContext,
} from "./session-search.js";

const CTX: SessionSearchToolContext = {
  agentId: "agent_caller",
  hierarchyLevel: "ic",
  sessionId: "sess_current",
};

interface Harness {
  search: ReturnType<typeof vi.fn>;
  tool: ReturnType<typeof createSessionSearchTool>;
}

function harness(
  ctx: SessionSearchToolContext = CTX,
  opts: { throws?: unknown; result?: unknown } = {},
): Harness {
  const search = vi.fn(async () => {
    if (opts.throws !== undefined) throw opts.throws;
    return (opts.result === undefined
      ? { kind: "browse", sessions: [] }
      : opts.result) as never;
  });

  const tool = createSessionSearchTool(ctx, {
    sessionSearch: { search } as unknown as SessionSearchService,
  });
  return { search, tool };
}

/** The SessionSearchRequest the tool derived from a bag of raw input. */
async function requestFor(
  input: Record<string, unknown>,
  ctx?: SessionSearchToolContext,
): Promise<SessionSearchRequest> {
  const h = harness(ctx);
  await h.tool.handler(input);
  return h.search.mock.calls[0]?.[0] as SessionSearchRequest;
}

describe("session_search — surface", () => {
  it("exposes the tool name and a schema with no required keys", () => {
    const { tool } = harness();
    expect(tool.name).toBe("session_search");
    // Every key is optional: bare session_search() is the browse shape.
    expect(tool.schema.required).toBeUndefined();
    expect(Object.keys(tool.schema.properties as object)).toEqual([
      "query",
      "limit",
      "sort",
      "session_id",
      "around_message_id",
      "window",
      "filters",
    ]);
  });

  it("documents all four calling shapes in the agent-facing description", () => {
    const { tool } = harness();
    for (const shape of ["DISCOVERY", "SCROLL", "READ", "BROWSE"]) {
      expect(tool.description).toContain(shape);
    }
  });
});

describe("session_search — browse shape", () => {
  it("infers browse from no arguments at all", async () => {
    expect(await requestFor({})).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("carries a numeric limit and filters", async () => {
    const req = await requestFor({
      limit: 7,
      filters: { status: "failed" },
    });
    expect(req).toEqual({
      kind: "browse",
      limit: 7,
      filters: { status: "failed" },
    });
  });

  it("ignores a non-numeric limit", async () => {
    expect(await requestFor({ limit: "7" })).toMatchObject({
      kind: "browse",
      limit: undefined,
    });
  });

  it("falls back to browse when the query is only whitespace", async () => {
    expect(await requestFor({ query: "   \n " })).toMatchObject({
      kind: "browse",
    });
  });
});

describe("session_search — discover shape", () => {
  it("infers discover from a query and trims it", async () => {
    expect(await requestFor({ query: "  auth refactor  " })).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: undefined,
      sort: undefined,
      filters: undefined,
    });
  });

  it.each(["newest", "oldest"])("passes the valid sort %s through", async (sort) => {
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

  it("carries limit and filters", async () => {
    expect(
      await requestFor({
        query: "docker networking",
        limit: 10,
        filters: { session_type: "task", agent_id: "agent_sub" },
      }),
    ).toEqual({
      kind: "discover",
      query: "docker networking",
      limit: 10,
      sort: undefined,
      filters: { session_type: "task", agent_id: "agent_sub" },
    });
  });

  it("ignores a null filters value", async () => {
    expect(await requestFor({ query: "x", filters: null })).toMatchObject({
      filters: undefined,
    });
  });

  it("ignores a non-object filters value", async () => {
    expect(await requestFor({ query: "x", filters: "status:failed" })).toMatchObject(
      { filters: undefined },
    );
  });
});

describe("session_search — read shape", () => {
  it("infers read from a bare session_id and trims it", async () => {
    expect(await requestFor({ session_id: "  sess_42  " })).toEqual({
      kind: "read",
      session_id: "sess_42",
    });
  });

  it("wins over a query when both are present", async () => {
    expect(
      await requestFor({ session_id: "sess_42", query: "auth" }),
    ).toEqual({ kind: "read", session_id: "sess_42" });
  });

  it("drops filters, which read does not accept", async () => {
    const req = await requestFor({
      session_id: "sess_42",
      filters: { status: "failed" },
    });
    expect(req).not.toHaveProperty("filters");
  });

  it("falls through to browse when session_id is whitespace only", async () => {
    expect(await requestFor({ session_id: "   " })).toMatchObject({
      kind: "browse",
    });
  });

  it("falls through to discover when session_id is a non-string", async () => {
    expect(await requestFor({ session_id: 42, query: "auth" })).toMatchObject({
      kind: "discover",
      query: "auth",
    });
  });
});

describe("session_search — scroll shape", () => {
  it("infers scroll from session_id plus around_message_id, both trimmed", async () => {
    expect(
      await requestFor({
        session_id: "  sess_42  ",
        around_message_id: "  evt_7  ",
      }),
    ).toEqual({
      kind: "scroll",
      session_id: "sess_42",
      around_message_id: "evt_7",
      window: undefined,
    });
  });

  it("carries a numeric window", async () => {
    expect(
      await requestFor({
        session_id: "sess_42",
        around_message_id: "evt_7",
        window: 20,
      }),
    ).toMatchObject({ kind: "scroll", window: 20 });
  });

  it("ignores a non-numeric window, leaving the clamp to the service", async () => {
    expect(
      await requestFor({
        session_id: "sess_42",
        around_message_id: "evt_7",
        window: "20",
      }),
    ).toMatchObject({ kind: "scroll", window: undefined });
  });

  it("accepts the synthetic user-turn anchor id format", async () => {
    expect(
      await requestFor({
        session_id: "sess_42",
        around_message_id: "intent:sess_42",
      }),
    ).toMatchObject({
      kind: "scroll",
      around_message_id: "intent:sess_42",
    });
  });

  it("wins over a query when all three are present", async () => {
    expect(
      await requestFor({
        session_id: "sess_42",
        around_message_id: "evt_7",
        query: "auth",
      }),
    ).toMatchObject({ kind: "scroll" });
  });

  it("degrades to read when the anchor is whitespace only", async () => {
    expect(
      await requestFor({ session_id: "sess_42", around_message_id: "  " }),
    ).toEqual({ kind: "read", session_id: "sess_42" });
  });

  it("degrades to read when the anchor is a non-string", async () => {
    expect(
      await requestFor({ session_id: "sess_42", around_message_id: 7 }),
    ).toEqual({ kind: "read", session_id: "sess_42" });
  });

  it("is browse, not scroll, when only the anchor is given", async () => {
    expect(await requestFor({ around_message_id: "evt_7" })).toMatchObject({
      kind: "browse",
    });
  });
});

describe("session_search — caller context", () => {
  it.each<HierarchyLevel>(["ic", "team", "org"])(
    "threads the %s caller context into the service call",
    async (hierarchyLevel) => {
      const h = harness({
        agentId: "agent_x",
        hierarchyLevel,
        sessionId: "sess_active",
      });
      await h.tool.handler({ query: "auth" });

      expect(h.search).toHaveBeenCalledWith(expect.anything(), {
        callerAgentId: "agent_x",
        hierarchyLevel,
        currentSessionId: "sess_active",
      });
    },
  );
});

describe("session_search — results", () => {
  it("returns the service result verbatim as the tool content", async () => {
    const result = { kind: "read", messages: [{ id: "evt_1" }] };
    const h = harness(CTX, { result });

    const out = await h.tool.handler({ session_id: "sess_42" });

    expect(out.isError).toBeFalsy();
    expect(out.content).toBe(result);
  });

  it("maps a null result to not_found_or_forbidden", async () => {
    const h = harness(CTX, { result: null });
    const out = await h.tool.handler({ session_id: "sess_nope" });

    expect(out.isError).toBe(true);
    expect(out.content).toMatchObject({ error: "not_found_or_forbidden" });
    expect(out.content.message).toContain("not in your scope");
  });
});

describe("session_search — error envelope", () => {
  it.each<SessionSearchError["code"]>([
    "forbidden_agent_filter",
    "missing_query",
    "missing_args",
  ])("surfaces the %s code from a SessionSearchError", async (code) => {
    const h = harness(CTX, {
      throws: new SessionSearchError(code, `rejected: ${code}`),
    });
    const out = await h.tool.handler({ query: "auth" });

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({ error: code, message: `rejected: ${code}` });
  });

  it("matches SessionSearchError by name so a src/dist bundle split still yields a code", async () => {
    // Same shape, different class identity — what an integration script
    // consuming core/src gets while the api consumes core/dist.
    const crossBundle = Object.assign(new Error("forbidden filter"), {
      name: "SessionSearchError",
      code: "forbidden_agent_filter",
    });
    const h = harness(CTX, { throws: crossBundle });

    const out = await h.tool.handler({ query: "auth", filters: { agent_id: "x" } });

    expect(out.content).toEqual({
      error: "forbidden_agent_filter",
      message: "forbidden filter",
    });
  });

  it("falls back to internal_error for an unrelated Error", async () => {
    const h = harness(CTX, { throws: new Error("connection terminated") });
    const out = await h.tool.handler({ query: "auth" });

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({
      error: "internal_error",
      message: "connection terminated",
    });
  });

  it("does not mistake a same-message Error for a SessionSearchError", async () => {
    const h = harness(CTX, { throws: new Error("missing_query") });
    const out = await h.tool.handler({});

    expect(out.content).toMatchObject({ error: "internal_error" });
  });

  it("stringifies a thrown non-Error", async () => {
    const h = harness(CTX, { throws: "pool drained" });
    const out = await h.tool.handler({ query: "auth" });

    expect(out.content).toEqual({
      error: "internal_error",
      message: "pool drained",
    });
  });
});
