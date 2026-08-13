/**
 * `session_search` MCP tool — unit tests with a fake SessionSearchService.
 *
 * The tool's own logic is `inferRequest`: four calling shapes picked
 * apart from one loose bag of LLM-supplied keys, with a documented
 * precedence (scroll beats read beats discover beats browse). Getting
 * that wrong silently answers a different question than the agent
 * asked, so the shape table is what these tests pin — plus the two
 * error surfaces (`null` → not_found_or_forbidden, SessionSearchError →
 * its own code), which agents branch on.
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
  agentId: "agent_searcher01",
  hierarchyLevel: "team",
  sessionId: "sess_current0001",
};

function makeTool(ctx: Partial<SessionSearchToolContext> = {}) {
  const sessionSearch = {
    search: vi.fn(async () => ({ kind: "browse", sessions: [] })),
  } as unknown as SessionSearchService;
  const tool = createSessionSearchTool({ ...CTX, ...ctx }, { sessionSearch });
  return { tool, sessionSearch };
}

/** The request the tool handed to the service on its first call. */
function requestFrom(service: SessionSearchService): SessionSearchRequest {
  return vi.mocked(service.search).mock.calls[0]?.[0] as SessionSearchRequest;
}

describe("session_search shape inference", () => {
  it("browses when called with no arguments", async () => {
    const { tool, sessionSearch } = makeTool();

    await tool.handler({});

    expect(requestFrom(sessionSearch)).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("discovers when given a query", async () => {
    const { tool, sessionSearch } = makeTool();

    await tool.handler({ query: "  auth refactor  ", limit: 7, sort: "newest" });

    expect(requestFrom(sessionSearch)).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: 7,
      sort: "newest",
      filters: undefined,
    });
  });

  it("reads the whole conversation for a bare session_id", async () => {
    const { tool, sessionSearch } = makeTool();

    await tool.handler({ session_id: "  sess_target0001  " });

    expect(requestFrom(sessionSearch)).toEqual({
      kind: "read",
      session_id: "sess_target0001",
    });
  });

  it("scrolls when session_id and around_message_id are both present", async () => {
    const { tool, sessionSearch } = makeTool();

    await tool.handler({
      session_id: "sess_target0001",
      around_message_id: "  evt_anchor0001  ",
      window: 12,
    });

    expect(requestFrom(sessionSearch)).toEqual({
      kind: "scroll",
      session_id: "sess_target0001",
      around_message_id: "evt_anchor0001",
      window: 12,
    });
  });

  it("prefers scroll over the query the caller also sent", async () => {
    const { tool, sessionSearch } = makeTool();

    await tool.handler({
      query: "ignored",
      session_id: "sess_target0001",
      around_message_id: "evt_anchor0001",
    });

    expect(requestFrom(sessionSearch).kind).toBe("scroll");
  });

  it("prefers read over discover when both session_id and query are set", async () => {
    const { tool, sessionSearch } = makeTool();

    await tool.handler({ query: "auth refactor", session_id: "sess_target0001" });

    expect(requestFrom(sessionSearch)).toEqual({
      kind: "read",
      session_id: "sess_target0001",
    });
  });

  it("treats blank and non-string ids or queries as absent", async () => {
    const { tool, sessionSearch } = makeTool();

    await tool.handler({ query: "   ", session_id: "  ", around_message_id: 5 });

    expect(requestFrom(sessionSearch).kind).toBe("browse");
  });

  it("falls back to read when the anchor is blank", async () => {
    const { tool, sessionSearch } = makeTool();

    await tool.handler({ session_id: "sess_target0001", around_message_id: "   " });

    expect(requestFrom(sessionSearch).kind).toBe("read");
  });

  it("drops non-numeric limit/window and unknown sort values", async () => {
    const { tool, sessionSearch } = makeTool();

    await tool.handler({ query: "x", limit: "3", sort: "sideways" });
    await tool.handler({
      session_id: "sess_target0001",
      around_message_id: "evt_a",
      window: "10",
    });

    const calls = vi.mocked(sessionSearch.search).mock.calls;
    expect(calls[0]?.[0]).toMatchObject({ limit: undefined, sort: undefined });
    expect(calls[1]?.[0]).toMatchObject({ window: undefined });
  });

  it("forwards filters on the discover and browse shapes", async () => {
    const { tool, sessionSearch } = makeTool();
    const filters = { session_type: "task", status: "failed" };

    await tool.handler({ query: "deploy", filters });
    await tool.handler({ filters });

    const calls = vi.mocked(sessionSearch.search).mock.calls;
    expect(calls[0]?.[0]).toMatchObject({ kind: "discover", filters });
    expect(calls[1]?.[0]).toMatchObject({ kind: "browse", filters });
  });

  it("ignores a non-object filters value instead of passing it down", async () => {
    const { tool, sessionSearch } = makeTool();

    await tool.handler({ filters: "status:failed" });
    await tool.handler({ filters: null });

    for (const call of vi.mocked(sessionSearch.search).mock.calls) {
      expect((call[0] as { filters?: unknown }).filters).toBeUndefined();
    }
  });

  it("passes the caller's identity and active session through as scope", async () => {
    const { tool, sessionSearch } = makeTool({ hierarchyLevel: "org" });

    await tool.handler({});

    expect(vi.mocked(sessionSearch.search).mock.calls[0]?.[1]).toEqual({
      callerAgentId: CTX.agentId,
      hierarchyLevel: "org",
      currentSessionId: CTX.sessionId,
    });
  });
});

describe("session_search results and errors", () => {
  it("returns the service payload unchanged on success", async () => {
    const { tool, sessionSearch } = makeTool();
    const payload = { kind: "read", session_id: "sess_target0001", messages: [] };
    vi.mocked(sessionSearch.search).mockResolvedValue(
      payload as unknown as Awaited<ReturnType<SessionSearchService["search"]>>,
    );

    const res = await tool.handler({ session_id: "sess_target0001" });

    expect(res.isError).toBeFalsy();
    expect(res.content).toEqual(payload);
  });

  it("maps a null result to the shared not-found/forbidden error", async () => {
    const { tool, sessionSearch } = makeTool();
    vi.mocked(sessionSearch.search).mockResolvedValue(
      null as unknown as Awaited<ReturnType<SessionSearchService["search"]>>,
    );

    const res = await tool.handler({ session_id: "sess_other00001" });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("not_found_or_forbidden");
  });

  it("surfaces a SessionSearchError's own code", async () => {
    const { tool, sessionSearch } = makeTool();
    vi.mocked(sessionSearch.search).mockRejectedValue(
      new SessionSearchError("forbidden_agent_filter", "agent_x is outside your scope"),
    );

    const res = await tool.handler({ query: "x", filters: { agent_id: "agent_x" } });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "forbidden_agent_filter",
      message: "agent_x is outside your scope",
    });
  });

  it("recognises a SessionSearchError from a different bundle by name", async () => {
    // src/ and dist/ copies of core are distinct classes, so `instanceof`
    // alone would silently downgrade the code to internal_error.
    const { tool, sessionSearch } = makeTool();
    const crossBundle = new Error("query is required for discovery");
    crossBundle.name = "SessionSearchError";
    (crossBundle as Error & { code: string }).code = "missing_query";
    vi.mocked(sessionSearch.search).mockRejectedValue(crossBundle);

    const res = await tool.handler({ query: "x" });

    expect(res.content).toEqual({
      error: "missing_query",
      message: "query is required for discovery",
    });
  });

  it("degrades any other throw to internal_error", async () => {
    const { tool, sessionSearch } = makeTool();
    vi.mocked(sessionSearch.search).mockRejectedValue(new Error("pool timeout"));

    const res = await tool.handler({});

    expect(res.content).toEqual({ error: "internal_error", message: "pool timeout" });
  });

  it("stringifies a non-Error throw", async () => {
    const { tool, sessionSearch } = makeTool();
    vi.mocked(sessionSearch.search).mockRejectedValue("connection reset");

    const res = await tool.handler({});

    expect(res.content).toEqual({ error: "internal_error", message: "connection reset" });
  });
});
