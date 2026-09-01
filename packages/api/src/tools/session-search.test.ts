/**
 * `session_search` handler tests — shape inference and error enveloping.
 *
 * The tool's whole job is turning loose MCP input into one of four typed
 * requests, and the precedence between them is not obvious from a call
 * site: scroll beats read beats discover beats browse, and a blank-ish
 * string counts as absent at every rung. Getting that wrong silently
 * answers a different question than the agent asked. The rest is error
 * enveloping — including the deliberate match-by-name fallback, which
 * exists so a cross-bundle `SessionSearchError` (src/ vs dist/) still
 * reports its code instead of degrading to `internal_error`.
 */
import { describe, expect, it, vi } from "vitest";
import {
  SessionSearchError,
  type SessionSearchService,
} from "@beevibe/core/services/session-search";
import { createSessionSearchTool } from "./session-search.js";

const AGENT = "agent_caller";
const SESSION = "sess_current";

function harness(level: "ic" | "team" | "org" = "team") {
  const sessionSearch = {
    search: vi.fn().mockResolvedValue({ kind: "browse", sessions: [] }),
  } as unknown as SessionSearchService;

  const tool = createSessionSearchTool(
    { agentId: AGENT, hierarchyLevel: level, sessionId: SESSION },
    { sessionSearch },
  );
  return { sessionSearch, tool, request: () => vi.mocked(sessionSearch.search).mock.calls[0]?.[0] };
}

describe("session_search — caller scope", () => {
  it("passes the caller's agent, tier and active session to the service", async () => {
    const h = harness("org");
    await h.tool.handler({});
    expect(vi.mocked(h.sessionSearch.search).mock.calls[0]?.[1]).toEqual({
      callerAgentId: AGENT,
      hierarchyLevel: "org",
      currentSessionId: SESSION,
    });
  });
});

// ── shape inference ──────────────────────────────────────────────────────

describe("session_search — shape inference", () => {
  it("browses when nothing is passed", async () => {
    const h = harness();
    await h.tool.handler({});
    expect(h.request()).toEqual({ kind: "browse", limit: undefined, filters: undefined });
  });

  it("discovers when a query is passed", async () => {
    const h = harness();
    await h.tool.handler({ query: "  auth refactor  ", limit: 7, sort: "newest" });
    expect(h.request()).toEqual({
      kind: "discover",
      // Trimmed.
      query: "auth refactor",
      limit: 7,
      sort: "newest",
      filters: undefined,
    });
  });

  it("reads when only a session_id is passed", async () => {
    const h = harness();
    await h.tool.handler({ session_id: " sess_x " });
    expect(h.request()).toEqual({ kind: "read", session_id: "sess_x" });
  });

  it("scrolls when session_id and around_message_id are both passed", async () => {
    const h = harness();
    await h.tool.handler({
      session_id: "sess_x",
      around_message_id: " evt_1 ",
      window: 12,
    });
    expect(h.request()).toEqual({
      kind: "scroll",
      session_id: "sess_x",
      around_message_id: "evt_1",
      window: 12,
    });
  });

  it("prefers scroll over discover when a query tags along", async () => {
    const h = harness();
    await h.tool.handler({
      session_id: "sess_x",
      around_message_id: "evt_1",
      query: "ignored",
    });
    expect(h.request()).toMatchObject({ kind: "scroll" });
  });

  it("prefers read over discover when a query tags along", async () => {
    const h = harness();
    await h.tool.handler({ session_id: "sess_x", query: "ignored" });
    expect(h.request()).toEqual({ kind: "read", session_id: "sess_x" });
  });

  it("falls back to discover when the anchor is present but session_id isn't", async () => {
    const h = harness();
    await h.tool.handler({ around_message_id: "evt_1", query: "auth" });
    expect(h.request()).toMatchObject({ kind: "discover", query: "auth" });
  });

  it.each([
    ["a blank string", "   "],
    ["an empty string", ""],
    ["a non-string", 42],
  ])("treats %s session_id as absent", async (_label, session_id) => {
    const h = harness();
    await h.tool.handler({ session_id, query: "auth" });
    expect(h.request()).toMatchObject({ kind: "discover" });
  });

  it.each([
    ["a blank string", "   "],
    ["a non-string", 42],
  ])("treats %s query as absent — browse, not discover", async (_label, query) => {
    const h = harness();
    await h.tool.handler({ query });
    expect(h.request()).toMatchObject({ kind: "browse" });
  });

  it("treats a blank anchor as absent — read, not scroll", async () => {
    const h = harness();
    await h.tool.handler({ session_id: "sess_x", around_message_id: "  " });
    expect(h.request()).toEqual({ kind: "read", session_id: "sess_x" });
  });

  it.each([
    ["limit", "limit", "3"],
    ["window", "window", "10"],
  ])("drops a non-numeric %s rather than passing it through", async (_l, key, value) => {
    const h = harness();
    await h.tool.handler(
      key === "window"
        ? { session_id: "s", around_message_id: "e", window: value }
        : { query: "q", limit: value },
    );
    expect(h.request()).toMatchObject({ [key]: undefined });
  });

  it("drops an out-of-enum sort", async () => {
    const h = harness();
    await h.tool.handler({ query: "q", sort: "relevance" });
    expect(h.request()).toMatchObject({ sort: undefined });
  });

  it("forwards filters on the discover and browse shapes", async () => {
    const filters = { session_type: "chat", status: "failed", since: "2026-01-01" };
    const discover = harness();
    await discover.tool.handler({ query: "q", filters });
    expect(discover.request()).toMatchObject({ filters });

    const browse = harness();
    await browse.tool.handler({ filters });
    expect(browse.request()).toMatchObject({ filters });
  });

  it.each([
    ["null", null],
    ["a non-object", "session_type=chat"],
  ])("drops %s filters", async (_label, filters) => {
    const h = harness();
    await h.tool.handler({ query: "q", filters });
    expect(h.request()).toMatchObject({ filters: undefined });
  });
});

// ── results and errors ───────────────────────────────────────────────────

describe("session_search — results", () => {
  it("returns the service result verbatim", async () => {
    const h = harness();
    const result = { kind: "read", session: { id: "sess_x" }, messages: [] };
    vi.mocked(h.sessionSearch.search).mockResolvedValue(result as never);

    const res = await h.tool.handler({ session_id: "sess_x" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual(result);
  });

  it("maps a null result onto the not_found_or_forbidden envelope", async () => {
    const h = harness();
    vi.mocked(h.sessionSearch.search).mockResolvedValue(null as never);

    const res = await h.tool.handler({ session_id: "sess_someone_elses" });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("not_found_or_forbidden");
    expect(String(res.content.message)).toContain("not in your scope");
  });

  it.each(["forbidden_agent_filter", "missing_query", "missing_args"] as const)(
    "surfaces the %s code from a SessionSearchError",
    async (code) => {
      const h = harness();
      vi.mocked(h.sessionSearch.search).mockRejectedValue(
        new SessionSearchError(code, `rejected: ${code}`),
      );

      const res = await h.tool.handler({ query: "q" });
      expect(res.isError).toBe(true);
      expect(res.content).toEqual({ error: code, message: `rejected: ${code}` });
    },
  );

  it("recognizes a SessionSearchError from another bundle by name", async () => {
    const h = harness();
    // Same shape, different class identity — what a src/-vs-dist/ import
    // split produces. `instanceof` misses it; the name check must not.
    const foreign = Object.assign(new Error("agent_id outside your scope"), {
      name: "SessionSearchError",
      code: "forbidden_agent_filter",
    });
    vi.mocked(h.sessionSearch.search).mockRejectedValue(foreign);

    const res = await h.tool.handler({ query: "q", filters: { agent_id: "agent_other" } });
    expect(res.content).toEqual({
      error: "forbidden_agent_filter",
      message: "agent_id outside your scope",
    });
  });

  it("envelopes an unrelated throw as internal_error", async () => {
    const h = harness();
    vi.mocked(h.sessionSearch.search).mockRejectedValue(new Error("connection terminated"));

    const res = await h.tool.handler({ query: "q" });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "internal_error",
      message: "connection terminated",
    });
  });

  it("stringifies a non-Error throw", async () => {
    const h = harness();
    vi.mocked(h.sessionSearch.search).mockRejectedValue("pool is draining");

    const res = await h.tool.handler({});
    expect(res.content).toEqual({ error: "internal_error", message: "pool is draining" });
  });
});
