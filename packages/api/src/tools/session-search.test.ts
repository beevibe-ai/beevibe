/**
 * session_search tool tests.
 *
 * The retrieval itself is SessionSearchService's job (and is covered
 * against a real Postgres in core). What this file locks down is the
 * adapter: the four calling shapes the tool description promises, how
 * raw MCP input maps onto a typed SessionSearchRequest, and the error
 * envelope — including the by-name fallback that keeps the structured
 * code when src/ and dist/ copies of the error class are both loaded.
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

function build(
  behavior: { result?: unknown; throws?: unknown } = {},
  ctx: SessionSearchToolContext = CTX,
) {
  const search = vi.fn(async (_req: SessionSearchRequest, _scope: unknown) => {
    if (behavior.throws) throw behavior.throws;
    return behavior.result === undefined ? { results: [] } : behavior.result;
  });
  const sessionSearch = { search } as unknown as SessionSearchService;
  return { search, tool: createSessionSearchTool(ctx, { sessionSearch }) };
}

type SearchStub = ReturnType<typeof build>["search"];

/** The request the handler built, typed for readable assertions. */
function requestOf(search: SearchStub): SessionSearchRequest {
  return search.mock.calls[0]![0];
}

/** The caller-scope argument the handler passed alongside the request. */
function scopeOf(search: SearchStub): unknown {
  return search.mock.calls[0]![1];
}

describe("session_search descriptor", () => {
  it("is named session_search and has no required fields — every shape is optional", () => {
    const { tool } = build();
    expect(tool.name).toBe("session_search");
    expect(tool.schema.required).toBeUndefined();
  });

  it("documents all four calling shapes in the description", () => {
    const { tool } = build();
    for (const shape of ["DISCOVERY", "SCROLL", "READ", "BROWSE"]) {
      expect(tool.description).toContain(shape);
    }
  });
});

describe("caller scope", () => {
  it("passes agent id, tier and the active session through on every call", async () => {
    const { tool, search } = build();
    await tool.handler({});

    expect(scopeOf(search)).toEqual({
      callerAgentId: "agent_a",
      hierarchyLevel: "team",
      currentSessionId: "ses_current",
    });
  });

  it("forwards the caller's own tier, not a fixed one", async () => {
    const { tool, search } = build({}, { ...CTX, hierarchyLevel: "ic" });
    await tool.handler({ query: "auth" });
    expect(scopeOf(search)).toMatchObject({ hierarchyLevel: "ic" });
  });
});

describe("shape inference", () => {
  it("browses when nothing is passed", async () => {
    const { tool, search } = build();
    await tool.handler({});
    expect(requestOf(search)).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("carries a numeric limit into the browse request", async () => {
    const { tool, search } = build();
    await tool.handler({ limit: 10 });
    expect(requestOf(search)).toMatchObject({ kind: "browse", limit: 10 });
  });

  it("discovers when a query is passed, trimming it", async () => {
    const { tool, search } = build();
    await tool.handler({ query: "  auth refactor  ", limit: 5, sort: "newest" });

    expect(requestOf(search)).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: 5,
      sort: "newest",
      filters: undefined,
    });
  });

  it("reads when only a session_id is passed", async () => {
    const { tool, search } = build();
    await tool.handler({ session_id: " ses_42 " });
    expect(requestOf(search)).toEqual({ kind: "read", session_id: "ses_42" });
  });

  it("scrolls when session_id and around_message_id are both passed", async () => {
    const { tool, search } = build();
    await tool.handler({
      session_id: "ses_42",
      around_message_id: "evt_7",
      window: 10,
    });

    expect(requestOf(search)).toEqual({
      kind: "scroll",
      session_id: "ses_42",
      around_message_id: "evt_7",
      window: 10,
    });
  });

  it("lets scroll win over a query passed alongside it", async () => {
    const { tool, search } = build();
    await tool.handler({
      query: "ignored",
      session_id: "ses_42",
      around_message_id: "evt_7",
    });
    expect(requestOf(search).kind).toBe("scroll");
  });

  it("lets read win over a query passed alongside it", async () => {
    const { tool, search } = build();
    await tool.handler({ query: "ignored", session_id: "ses_42" });
    expect(requestOf(search).kind).toBe("read");
  });

  it("treats a blank session_id / anchor / query as absent and browses", async () => {
    const { tool, search } = build();
    await tool.handler({ session_id: "   ", around_message_id: "  ", query: " " });
    expect(requestOf(search).kind).toBe("browse");
  });

  it("falls back to discover when only the anchor is blank", async () => {
    const { tool, search } = build();
    await tool.handler({ query: "auth", around_message_id: "   " });
    expect(requestOf(search).kind).toBe("discover");
  });

  it("ignores non-string session_id / anchor / query", async () => {
    const { tool, search } = build();
    await tool.handler({ session_id: 42, around_message_id: {}, query: [] });
    expect(requestOf(search).kind).toBe("browse");
  });

  it("drops a non-number window rather than passing it through", async () => {
    const { tool, search } = build();
    await tool.handler({
      session_id: "ses_42",
      around_message_id: "evt_7",
      window: "10",
    });
    expect(requestOf(search)).toMatchObject({ window: undefined });
  });

  it("drops a non-number limit rather than passing it through", async () => {
    const { tool, search } = build();
    await tool.handler({ query: "auth", limit: "5" });
    expect(requestOf(search)).toMatchObject({ limit: undefined });
  });

  it("ignores a sort value outside the enum", async () => {
    const { tool, search } = build();
    await tool.handler({ query: "auth", sort: "relevance" });
    expect(requestOf(search)).toMatchObject({ sort: undefined });
  });
});

describe("filters", () => {
  it("passes a filters object through on discovery", async () => {
    const { tool, search } = build();
    const filters = { session_type: "task", status: "failed" };
    await tool.handler({ query: "deploy", filters });
    expect(requestOf(search)).toMatchObject({ filters });
  });

  it("passes a filters object through on browse", async () => {
    const { tool, search } = build();
    const filters = { agent_id: "agent_b" };
    await tool.handler({ filters });
    expect(requestOf(search)).toMatchObject({ kind: "browse", filters });
  });

  it("treats a non-object filters value as absent", async () => {
    const { tool, search } = build();
    await tool.handler({ query: "deploy", filters: "task" });
    expect(requestOf(search)).toMatchObject({ filters: undefined });
  });

  it("treats null filters as absent", async () => {
    const { tool, search } = build();
    await tool.handler({ query: "deploy", filters: null });
    expect(requestOf(search)).toMatchObject({ filters: undefined });
  });

  it("does not attach filters to scroll or read", async () => {
    const { tool, search } = build();
    await tool.handler({ session_id: "ses_42", filters: { status: "failed" } });
    expect(requestOf(search)).not.toHaveProperty("filters");
  });
});

describe("results and errors", () => {
  it("returns the service payload verbatim", async () => {
    const payload = { kind: "read", session_id: "ses_42", messages: [{ id: "evt_1" }] };
    const { tool } = build({ result: payload });
    const result = await tool.handler({ session_id: "ses_42" });

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe(payload);
  });

  it("maps a null result to not_found_or_forbidden", async () => {
    const { tool } = build({ result: null });
    const result = await tool.handler({ session_id: "ses_other" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "not_found_or_forbidden" });
  });

  it.each(["forbidden_agent_filter", "missing_query", "missing_args"] as const)(
    "surfaces the %s code from a SessionSearchError",
    async (code) => {
      const { tool } = build({ throws: new SessionSearchError(code, `${code} detail`) });
      const result = await tool.handler({ query: "x" });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual({ error: code, message: `${code} detail` });
    },
  );

  it("matches a cross-bundle SessionSearchError by name, not just instanceof", async () => {
    // A second copy of the class (src/ vs dist/) fails instanceof but
    // still carries the name and code the agent branches on.
    const impostor = Object.assign(new Error("out of scope"), {
      name: "SessionSearchError",
      code: "forbidden_agent_filter",
    });
    const { tool } = build({ throws: impostor });
    const result = await tool.handler({ query: "x", filters: { agent_id: "agent_z" } });

    expect(result.content).toEqual({
      error: "forbidden_agent_filter",
      message: "out of scope",
    });
  });

  it("wraps an unexpected Error as internal_error", async () => {
    const { tool } = build({ throws: new Error("pool exhausted") });
    const result = await tool.handler({ query: "x" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "internal_error",
      message: "pool exhausted",
    });
  });

  it("stringifies a non-Error throw", async () => {
    const { tool } = build({ throws: "kaboom" });
    const result = await tool.handler({});

    expect(result.content).toEqual({ error: "internal_error", message: "kaboom" });
  });
});
