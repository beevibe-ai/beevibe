/**
 * session_search tool — vitest fakes, no DB.
 *
 * `SessionSearchService` does the scoping and the SQL; it is tested
 * against Postgres in core. The adapter's own job is shape inference —
 * deciding from a loose `Record<string, unknown>` whether the agent
 * meant scroll, read, discover or browse — plus passing the caller's
 * tier through and mapping errors. Shape inference is the part with
 * teeth: the precedence between `session_id`, `around_message_id` and
 * `query` decides which query runs at all, and a whitespace-only field
 * has to read as absent or a bare " " flips a browse into a read.
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
  sessionId: "sess_current",
};

function build(ctx: SessionSearchToolContext = CTX) {
  const sessionSearch = {
    search: vi.fn(async () => ({ results: [] })),
  } as unknown as SessionSearchService;
  return { tool: createSessionSearchTool(ctx, { sessionSearch }), sessionSearch };
}

/** The request the handler inferred from one call's raw input. */
async function inferred(input: Record<string, unknown>): Promise<SessionSearchRequest> {
  const { tool, sessionSearch } = build();
  await tool.handler(input);
  return vi.mocked(sessionSearch.search).mock.calls[0]![0];
}

describe("shape inference", () => {
  it("browses when given no arguments", async () => {
    expect(await inferred({})).toEqual({ kind: "browse", limit: undefined, filters: undefined });
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
    expect(await inferred({ session_id: "  sess_x  " })).toEqual({
      kind: "read",
      session_id: "sess_x",
    });
  });

  it("scrolls when given session_id and around_message_id", async () => {
    expect(
      await inferred({ session_id: "sess_x", around_message_id: " evt_1 ", window: 10 }),
    ).toEqual({
      kind: "scroll",
      session_id: "sess_x",
      around_message_id: "evt_1",
      window: 10,
    });
  });

  it("prefers scroll over discovery when a query is also present", async () => {
    // Documented precedence: the anchored slice wins, the query is ignored.
    const req = await inferred({
      session_id: "sess_x",
      around_message_id: "evt_1",
      query: "auth",
    });
    expect(req.kind).toBe("scroll");
  });

  it("prefers read over discovery when a query is also present", async () => {
    const req = await inferred({ session_id: "sess_x", query: "auth" });
    expect(req).toEqual({ kind: "read", session_id: "sess_x" });
  });

  it("ignores a dangling around_message_id with no session_id", async () => {
    const req = await inferred({ around_message_id: "evt_1" });
    expect(req.kind).toBe("browse");
  });

  it.each([
    ["blank", "   "],
    ["a non-string", 42],
  ])("treats %s session_id as absent", async (_label, session_id) => {
    expect((await inferred({ session_id })).kind).toBe("browse");
  });

  it.each([
    ["blank", "   "],
    ["a non-string", 42],
  ])("treats %s query as absent", async (_label, query) => {
    expect((await inferred({ query })).kind).toBe("browse");
  });

  it("treats a blank around_message_id as a read, not a scroll", async () => {
    expect((await inferred({ session_id: "sess_x", around_message_id: "  " })).kind).toBe("read");
  });

  it.each([
    ["a non-number limit", { limit: "3" }, "limit"],
    ["a non-number window", { session_id: "s", around_message_id: "e", window: "5" }, "window"],
  ])("drops %s so the service default applies", async (_label, extra, field) => {
    const req = (await inferred(extra)) as unknown as Record<string, unknown>;
    expect(req[field]).toBeUndefined();
  });

  it("drops an unrecognized sort rather than forwarding it", async () => {
    const req = (await inferred({ query: "x", sort: "relevance" })) as { sort?: string };
    expect(req.sort).toBeUndefined();
  });

  it("forwards filters on discovery and browse", async () => {
    const filters = { status: "failed", session_type: "task" };
    expect((await inferred({ query: "x", filters })) as unknown).toMatchObject({ filters });
    expect((await inferred({ filters })) as unknown).toMatchObject({ filters });
  });

  it.each([
    ["null", null],
    ["a non-object", "status=failed"],
  ])("drops %s filters", async (_label, filters) => {
    expect((await inferred({ filters })) as unknown).toMatchObject({ filters: undefined });
  });
});

describe("caller scope", () => {
  it("passes the caller's agent, tier and active session to the service", async () => {
    const { tool, sessionSearch } = build({
      agentId: "agent_b",
      hierarchyLevel: "org",
      sessionId: "sess_live",
    });
    await tool.handler({ query: "x" });

    expect(sessionSearch.search).toHaveBeenCalledWith(expect.anything(), {
      callerAgentId: "agent_b",
      hierarchyLevel: "org",
      currentSessionId: "sess_live",
    });
  });

  it("returns the service payload verbatim on success", async () => {
    const { tool, sessionSearch } = build();
    const payload = { results: [{ session: { id: "sess_1" }, snippet: "…auth…" }] };
    vi.mocked(sessionSearch.search).mockResolvedValue(payload as never);

    const res = await tool.handler({ query: "auth" });

    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual(payload);
  });
});

describe("error mapping", () => {
  it("maps a null result to not_found_or_forbidden", async () => {
    // One code for three causes on purpose — telling an out-of-scope
    // caller which of them applied would leak that the session exists.
    const { tool, sessionSearch } = build();
    vi.mocked(sessionSearch.search).mockResolvedValue(null as never);

    const res = await tool.handler({ session_id: "sess_someone_else" });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("not_found_or_forbidden");
  });

  it.each(["forbidden_agent_filter", "missing_query", "missing_args"] as const)(
    "surfaces the %s service error code",
    async (code) => {
      const { tool, sessionSearch } = build();
      vi.mocked(sessionSearch.search).mockRejectedValue(
        new SessionSearchError(code, `bad: ${code}`),
      );

      const res = await tool.handler({ query: "x" });

      expect(res.isError).toBe(true);
      expect(res.content).toEqual({ error: code, message: `bad: ${code}` });
    },
  );

  it("recognizes a SessionSearchError from another bundle by name", async () => {
    // src/ and dist/ copies of core fail `instanceof`; the name check is
    // what keeps the structured code from degrading to internal_error.
    const foreign = new Error("out of scope");
    foreign.name = "SessionSearchError";
    (foreign as Error & { code: string }).code = "forbidden_agent_filter";
    const { tool, sessionSearch } = build();
    vi.mocked(sessionSearch.search).mockRejectedValue(foreign);

    const res = await tool.handler({ query: "x" });

    expect(res.content).toEqual({ error: "forbidden_agent_filter", message: "out of scope" });
  });

  it("maps an unexpected throw to internal_error", async () => {
    const { tool, sessionSearch } = build();
    vi.mocked(sessionSearch.search).mockRejectedValue(new Error("pg down"));

    const res = await tool.handler({ query: "x" });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: "internal_error", message: "pg down" });
  });

  it("stringifies a non-Error throw", async () => {
    const { tool, sessionSearch } = build();
    vi.mocked(sessionSearch.search).mockRejectedValue("socket hang up");

    const res = await tool.handler({ query: "x" });

    expect(res.content).toEqual({ error: "internal_error", message: "socket hang up" });
  });
});
