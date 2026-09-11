/**
 * session_search MCP tool — unit tests with a fake SessionSearchService.
 *
 * The tool's own logic is `inferRequest`: four calling shapes the agent
 * selects implicitly by which arguments it sets, with a documented
 * precedence (scroll > read > discover > browse). Getting that wrong
 * silently answers a different question than the agent asked, so every
 * branch and every "blank counts as absent" coercion is pinned here.
 *
 * The other half is the error surface: a `null` result means
 * not-found-or-forbidden, a SessionSearchError carries its own code
 * through, and anything else degrades to `internal_error`. The service
 * is also matched by `name` rather than `instanceof` alone (src/ vs
 * dist/ dual-loading), which has its own test.
 */

import { describe, expect, it, vi } from "vitest";
import type { SessionSearchRequest } from "@beevibe/core";
import {
  SessionSearchError,
  type SessionSearchService,
} from "@beevibe/core/services/session-search";
import { createSessionSearchTool } from "./session-search.js";

const CTX = {
  agentId: "agent_a",
  hierarchyLevel: "team" as const,
  sessionId: "sess_current",
};

function harness(
  opts: { result?: unknown; throws?: unknown } = {},
): {
  search: ReturnType<typeof vi.fn>;
  tool: ReturnType<typeof createSessionSearchTool>;
} {
  const search = vi.fn(async () => {
    if (opts.throws) throw opts.throws;
    return "result" in opts ? opts.result : { kind: "browse", sessions: [] };
  });
  const sessionSearch = { search } as unknown as SessionSearchService;
  return { search, tool: createSessionSearchTool(CTX, { sessionSearch }) };
}

/** The request the tool inferred from the agent's raw arguments. */
async function inferred(
  input: Record<string, unknown>,
): Promise<SessionSearchRequest> {
  const h = harness();
  await h.tool.handler(input);
  return h.search.mock.calls[0]![0] as SessionSearchRequest;
}

describe("session_search descriptor", () => {
  it("exposes the tool name and a schema with no required fields", () => {
    const { tool } = harness();
    expect(tool.name).toBe("session_search");
    // Every shape is optional — bare `session_search()` is the browse shape.
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

  it("documents the four calling shapes in the agent-facing description", () => {
    const { tool } = harness();
    for (const shape of ["DISCOVERY", "SCROLL", "READ", "BROWSE"]) {
      expect(tool.description).toContain(shape);
    }
  });
});

describe("session_search caller context", () => {
  it("passes the caller's agent id, tier and active session to the service", async () => {
    const h = harness();
    await h.tool.handler({});

    expect(h.search.mock.calls[0]![1]).toEqual({
      callerAgentId: "agent_a",
      hierarchyLevel: "team",
      currentSessionId: "sess_current",
    });
  });
});

describe("session_search shape inference", () => {
  it("browses when no arguments are given", async () => {
    expect(await inferred({})).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("browses with a limit and filters", async () => {
    expect(
      await inferred({ limit: 8, filters: { status: "failed" } }),
    ).toEqual({
      kind: "browse",
      limit: 8,
      filters: { status: "failed" },
    });
  });

  it("discovers when a query is given", async () => {
    expect(await inferred({ query: "auth refactor", limit: 3 })).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: 3,
      sort: undefined,
      filters: undefined,
    });
  });

  it("trims the query", async () => {
    const req = await inferred({ query: "  auth refactor  " });
    expect(req).toMatchObject({ kind: "discover", query: "auth refactor" });
  });

  it.each([["newest"], ["oldest"]])("passes sort=%s through", async (sort) => {
    expect(await inferred({ query: "x", sort })).toMatchObject({ sort });
  });

  it("drops an unrecognised sort rather than forwarding it", async () => {
    expect(await inferred({ query: "x", sort: "relevance" })).toMatchObject({
      sort: undefined,
    });
  });

  it("reads when only session_id is given", async () => {
    expect(await inferred({ session_id: "sess_1" })).toEqual({
      kind: "read",
      session_id: "sess_1",
    });
  });

  it("scrolls when session_id and around_message_id are both given", async () => {
    expect(
      await inferred({
        session_id: "sess_1",
        around_message_id: "evt_9",
        window: 10,
      }),
    ).toEqual({
      kind: "scroll",
      session_id: "sess_1",
      around_message_id: "evt_9",
      window: 10,
    });
  });

  it("leaves window undefined for the service to default", async () => {
    expect(
      await inferred({ session_id: "sess_1", around_message_id: "evt_9" }),
    ).toMatchObject({ window: undefined });
  });

  it("ignores a non-numeric window", async () => {
    expect(
      await inferred({
        session_id: "sess_1",
        around_message_id: "evt_9",
        window: "10",
      }),
    ).toMatchObject({ window: undefined });
  });

  it("supports the documented user-turn anchor id format", async () => {
    expect(
      await inferred({
        session_id: "sess_1",
        around_message_id: "intent:sess_1",
      }),
    ).toMatchObject({ kind: "scroll", around_message_id: "intent:sess_1" });
  });

  it("scroll wins over discover when a query is also present", async () => {
    expect(
      await inferred({
        query: "auth",
        session_id: "sess_1",
        around_message_id: "evt_9",
      }),
    ).toMatchObject({ kind: "scroll" });
  });

  it("read wins over discover when a query is also present", async () => {
    expect(
      await inferred({ query: "auth", session_id: "sess_1" }),
    ).toMatchObject({ kind: "read" });
  });

  it("an anchor without a session_id falls back to discover", async () => {
    expect(
      await inferred({ query: "auth", around_message_id: "evt_9" }),
    ).toMatchObject({ kind: "discover" });
  });

  it("an anchor alone falls back to browse", async () => {
    expect(await inferred({ around_message_id: "evt_9" })).toMatchObject({
      kind: "browse",
    });
  });

  it.each([
    ["blank", "   "],
    ["empty", ""],
    ["non-string", 42],
  ])("treats a %s session_id as absent", async (_label, sessionId) => {
    expect(
      await inferred({ session_id: sessionId, query: "auth" }),
    ).toMatchObject({ kind: "discover" });
  });

  it.each([
    ["blank", "   "],
    ["non-string", 42],
  ])("treats a %s anchor as absent, degrading scroll to read", async (
    _label,
    anchor,
  ) => {
    expect(
      await inferred({ session_id: "sess_1", around_message_id: anchor }),
    ).toMatchObject({ kind: "read" });
  });

  it.each([
    ["blank", "   "],
    ["non-string", 42],
  ])("treats a %s query as absent, degrading discover to browse", async (
    _label,
    query,
  ) => {
    expect(await inferred({ query })).toMatchObject({ kind: "browse" });
  });

  it("drops a non-object filters value", async () => {
    expect(await inferred({ query: "auth", filters: "status:failed" })).toMatchObject(
      { filters: undefined },
    );
  });

  it("drops a null filters value rather than forwarding it", async () => {
    // `typeof null === "object"`, so this is the branch a naive check misses.
    expect(await inferred({ filters: null })).toMatchObject({
      filters: undefined,
    });
  });
});

describe("session_search results and errors", () => {
  it("returns the service result verbatim on success", async () => {
    const payload = { kind: "read", session: { id: "sess_1" }, messages: [] };
    const h = harness({ result: payload });

    const result = await h.tool.handler({ session_id: "sess_1" });

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe(payload);
  });

  it("maps a null result to not_found_or_forbidden", async () => {
    const h = harness({ result: null });

    const result = await h.tool.handler({ session_id: "sess_other" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "not_found_or_forbidden",
    });
  });

  it.each([
    ["forbidden_agent_filter"],
    ["missing_query"],
    ["missing_args"],
  ] as const)("passes the %s SessionSearchError code through", async (code) => {
    const h = harness({ throws: new SessionSearchError(code, "nope") });

    const result = await h.tool.handler({ query: "x" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: code, message: "nope" });
  });

  it("recognises a SessionSearchError from another module instance by name", async () => {
    // src/ and dist/ copies of core fail `instanceof`; the name check is
    // what keeps the structured code from degrading to internal_error.
    const foreign = new Error("scope refused");
    foreign.name = "SessionSearchError";
    (foreign as unknown as { code: string }).code = "forbidden_agent_filter";
    const h = harness({ throws: foreign });

    const result = await h.tool.handler({
      query: "x",
      filters: { agent_id: "agent_z" },
    });

    expect(result.content).toEqual({
      error: "forbidden_agent_filter",
      message: "scope refused",
    });
  });

  it("degrades an unexpected Error to internal_error", async () => {
    const h = harness({ throws: new Error("pool exhausted") });

    const result = await h.tool.handler({ query: "x" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "internal_error",
      message: "pool exhausted",
    });
  });

  it("stringifies a non-Error throw", async () => {
    const h = harness({ throws: "kaboom" });

    const result = await h.tool.handler({});

    expect(result.content).toEqual({
      error: "internal_error",
      message: "kaboom",
    });
  });
});
