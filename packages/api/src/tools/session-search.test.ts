/**
 * session_search tool tests.
 *
 * The handler's real work is shape inference — mapping a loose MCP input
 * bag onto one of the four typed SessionSearchRequest shapes (scroll >
 * read > discover > browse) — plus the error envelope. Both are pure
 * over an injected service, so no database is needed here.
 */
import { describe, expect, it, vi } from "vitest";
import { SessionSearchError } from "@beevibe/core/services/session-search";
import type { SessionSearchService } from "@beevibe/core/services/session-search";
import {
  createSessionSearchTool,
  type SessionSearchToolContext,
} from "./session-search.js";

function build(
  ctx: Partial<SessionSearchToolContext> = {},
  behavior: { result?: unknown; error?: unknown } = {},
) {
  const requests: unknown[] = [];
  const callerContexts: unknown[] = [];
  const sessionSearch = {
    search: vi.fn(async (req: unknown, caller: unknown) => {
      requests.push(req);
      callerContexts.push(caller);
      if (behavior.error) throw behavior.error;
      return behavior.result === undefined ? { kind: "browse", sessions: [] } : behavior.result;
    }),
  } as unknown as SessionSearchService;

  const tool = createSessionSearchTool(
    {
      agentId: "agent_a",
      hierarchyLevel: "team",
      sessionId: "ses_current",
      ...ctx,
    },
    { sessionSearch },
  );
  return { tool, requests, callerContexts };
}

describe("session_search tool descriptor", () => {
  it("is named session_search and documents the four calling shapes", () => {
    const { tool } = build();
    expect(tool.name).toBe("session_search");
    expect(tool.description).toContain("DISCOVERY");
    expect(tool.description).toContain("SCROLL");
    expect(tool.description).toContain("READ");
    expect(tool.description).toContain("BROWSE");
  });

  it("requires nothing — the bare call is the browse shape", () => {
    const { tool } = build();
    expect(tool.schema.required).toBeUndefined();
  });
});

describe("session_search shape inference", () => {
  it("infers browse from an empty input", async () => {
    const { tool, requests } = build();
    await tool.handler({});
    expect(requests[0]).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("carries limit and filters onto browse", async () => {
    const { tool, requests } = build();
    await tool.handler({ limit: 7, filters: { status: "failed" } });
    expect(requests[0]).toEqual({
      kind: "browse",
      limit: 7,
      filters: { status: "failed" },
    });
  });

  it("infers discover when a query is present", async () => {
    const { tool, requests } = build();
    await tool.handler({
      query: "  auth refactor  ",
      limit: 3,
      sort: "newest",
      filters: { session_type: "chat" },
    });
    expect(requests[0]).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: 3,
      sort: "newest",
      filters: { session_type: "chat" },
    });
  });

  it("accepts 'oldest' and drops any other sort value", async () => {
    const { tool, requests } = build();
    await tool.handler({ query: "x", sort: "oldest" });
    await tool.handler({ query: "x", sort: "relevance" });
    expect((requests[0] as { sort?: string }).sort).toBe("oldest");
    expect((requests[1] as { sort?: string }).sort).toBeUndefined();
  });

  it("drops a non-numeric limit rather than passing it through", async () => {
    const { tool, requests } = build();
    await tool.handler({ query: "x", limit: "3" });
    expect((requests[0] as { limit?: number }).limit).toBeUndefined();
  });

  it("infers read from a bare session_id, ignoring query and limit", async () => {
    const { tool, requests } = build();
    await tool.handler({
      session_id: "  ses_42  ",
      query: "ignored",
      limit: 9,
    });
    expect(requests[0]).toEqual({ kind: "read", session_id: "ses_42" });
  });

  it("infers scroll when session_id and around_message_id are both set", async () => {
    const { tool, requests } = build();
    await tool.handler({
      session_id: " ses_42 ",
      around_message_id: " evt_7 ",
      window: 10,
      query: "ignored",
    });
    expect(requests[0]).toEqual({
      kind: "scroll",
      session_id: "ses_42",
      around_message_id: "evt_7",
      window: 10,
    });
  });

  it("leaves window undefined for the service to default when not numeric", async () => {
    const { tool, requests } = build();
    await tool.handler({
      session_id: "ses_42",
      around_message_id: "evt_7",
      window: "10",
    });
    expect((requests[0] as { window?: number }).window).toBeUndefined();
  });

  it("supports the synthetic user-turn anchor id format", async () => {
    const { tool, requests } = build();
    await tool.handler({
      session_id: "ses_42",
      around_message_id: "intent:ses_42",
    });
    expect(requests[0]).toMatchObject({
      kind: "scroll",
      around_message_id: "intent:ses_42",
    });
  });

  it.each([
    ["blank", "   "],
    ["a non-string", 42],
  ])("falls back to browse when session_id is %s and no query is given", async (_l, sessionId) => {
    const { tool, requests } = build();
    await tool.handler({ session_id: sessionId } as Record<string, unknown>);
    expect((requests[0] as { kind: string }).kind).toBe("browse");
  });

  it("falls back to read when around_message_id is blank", async () => {
    const { tool, requests } = build();
    await tool.handler({ session_id: "ses_42", around_message_id: "  " });
    expect(requests[0]).toEqual({ kind: "read", session_id: "ses_42" });
  });

  it("falls back to browse when the query is only whitespace", async () => {
    const { tool, requests } = build();
    await tool.handler({ query: "   " });
    expect((requests[0] as { kind: string }).kind).toBe("browse");
  });

  it.each([
    ["null", null],
    ["a scalar", "status=failed"],
  ])("drops filters when it is %s", async (_label, filters) => {
    const { tool, requests } = build();
    await tool.handler({ query: "x", filters } as Record<string, unknown>);
    expect((requests[0] as { filters?: unknown }).filters).toBeUndefined();
  });
});

describe("session_search caller context", () => {
  it("passes the caller's agent id, tier and active session to the service", async () => {
    const { tool, callerContexts } = build({
      agentId: "agent_org",
      hierarchyLevel: "org",
      sessionId: "ses_live",
    });
    await tool.handler({ query: "x" });

    expect(callerContexts[0]).toEqual({
      callerAgentId: "agent_org",
      hierarchyLevel: "org",
      currentSessionId: "ses_live",
    });
  });
});

describe("session_search results and errors", () => {
  it("returns the service payload verbatim on success", async () => {
    const payload = { kind: "read", session: { id: "ses_42" }, messages: [] };
    const { tool } = build({}, { result: payload });
    const result = await tool.handler({ session_id: "ses_42" });

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe(payload);
  });

  it("maps a null result onto not_found_or_forbidden", async () => {
    const { tool } = build({}, { result: null });
    const result = await tool.handler({ session_id: "ses_nope" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "not_found_or_forbidden" });
    expect(result.content.message).toContain("not in your scope");
  });

  it.each([
    "forbidden_agent_filter",
    "missing_query",
    "missing_args",
  ] as const)("surfaces the %s code from a SessionSearchError", async (code) => {
    const { tool } = build({}, { error: new SessionSearchError(code, `nope: ${code}`) });
    const result = await tool.handler({ query: "x" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: code, message: `nope: ${code}` });
  });

  it("matches a cross-bundle SessionSearchError by name, not just instanceof", async () => {
    // A src/-vs-dist/ duplicate of the class fails instanceof but keeps
    // the name — the handler is expected to still unwrap the code.
    const impostor = Object.assign(new Error("scope denied"), {
      name: "SessionSearchError",
      code: "forbidden_agent_filter",
    });
    const { tool } = build({}, { error: impostor });
    const result = await tool.handler({ query: "x" });

    expect(result.content).toEqual({
      error: "forbidden_agent_filter",
      message: "scope denied",
    });
  });

  it("wraps an unexpected Error as internal_error", async () => {
    const { tool } = build({}, { error: new Error("pool exhausted") });
    const result = await tool.handler({ query: "x" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "internal_error",
      message: "pool exhausted",
    });
  });

  it("stringifies a non-Error throw", async () => {
    const { tool } = build({}, { error: "kaboom" });
    const result = await tool.handler({ query: "x" });

    expect(result.content).toEqual({
      error: "internal_error",
      message: "kaboom",
    });
  });
});
