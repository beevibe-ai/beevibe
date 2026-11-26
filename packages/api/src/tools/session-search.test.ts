/**
 * session_search handler tests.
 *
 * The handler's own work is shape inference: four calling shapes are
 * distinguished by which of query / session_id / around_message_id are
 * present, and getting that wrong silently answers a different question
 * than the agent asked (a scroll degrading to a whole-transcript read,
 * say). A fake SessionSearchService captures the request the handler
 * built, which is what these assert on; the FTS itself is covered by
 * the DB-backed session-search repo suite.
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

interface Fake {
  sessionSearch: SessionSearchService;
  requests: SessionSearchRequest[];
  scopes: Record<string, unknown>[];
}

function fakeSearch(
  opts: { result?: unknown; throws?: unknown } = {},
): Fake {
  const requests: SessionSearchRequest[] = [];
  const scopes: Record<string, unknown>[] = [];
  const sessionSearch = {
    search: vi.fn(
      async (req: SessionSearchRequest, scope: Record<string, unknown>) => {
        if (opts.throws) throw opts.throws;
        requests.push(req);
        scopes.push(scope);
        return opts.result === undefined ? { results: [] } : opts.result;
      },
    ),
  } as unknown as SessionSearchService;
  return { sessionSearch, requests, scopes };
}

function tool(f: Fake, ctx = CTX) {
  return createSessionSearchTool(ctx, { sessionSearch: f.sessionSearch });
}

describe("session_search descriptor", () => {
  it("is named session_search and carries the thick agent-facing description", () => {
    const t = tool(fakeSearch());
    expect(t.name).toBe("session_search");
    // The description is the contract for the four shapes; a truncated
    // one is a real regression, so hold a floor on it.
    expect(t.description).toContain("FOUR CALLING SHAPES");
    expect(t.description.length).toBeGreaterThan(500);
  });

  it("has no required fields, since the no-arg shape is browse", () => {
    expect(tool(fakeSearch()).schema.required).toBeUndefined();
  });
});

describe("session_search shape inference", () => {
  it("infers discover from a query", async () => {
    const f = fakeSearch();
    await tool(f).handler({ query: "auth refactor" });

    expect(f.requests[0]).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: undefined,
      sort: undefined,
      filters: undefined,
    });
  });

  it("infers browse when nothing identifying is passed", async () => {
    const f = fakeSearch();
    await tool(f).handler({});

    expect(f.requests[0]).toMatchObject({ kind: "browse" });
  });

  it("infers read from a bare session_id", async () => {
    const f = fakeSearch();
    await tool(f).handler({ session_id: "ses_9" });

    expect(f.requests[0]).toEqual({ kind: "read", session_id: "ses_9" });
  });

  it("infers scroll when session_id and around_message_id are both present", async () => {
    const f = fakeSearch();
    await tool(f).handler({
      session_id: "ses_9",
      around_message_id: "evt_3",
      window: 10,
    });

    expect(f.requests[0]).toEqual({
      kind: "scroll",
      session_id: "ses_9",
      around_message_id: "evt_3",
      window: 10,
    });
  });

  it("lets scroll win over discover when a query is also passed", async () => {
    // Shape precedence is scroll > read > discover > browse. An agent
    // that passes a leftover query alongside an anchor still means to
    // scroll; answering with FTS instead would lose its place.
    const f = fakeSearch();
    await tool(f).handler({
      query: "auth refactor",
      session_id: "ses_9",
      around_message_id: "evt_3",
    });

    expect(f.requests[0]).toMatchObject({ kind: "scroll" });
  });

  it("lets read win over discover when a query is also passed", async () => {
    const f = fakeSearch();
    await tool(f).handler({ query: "auth refactor", session_id: "ses_9" });

    expect(f.requests[0]).toMatchObject({ kind: "read" });
  });

  it("treats an anchor with no session_id as discover, not scroll", async () => {
    // An anchor alone can't identify a conversation, so the query has to
    // drive instead of the handler inventing a session.
    const f = fakeSearch();
    await tool(f).handler({ around_message_id: "evt_3", query: "deploys" });

    expect(f.requests[0]).toMatchObject({ kind: "discover" });
  });

  it("treats an anchor alone as browse", async () => {
    const f = fakeSearch();
    await tool(f).handler({ around_message_id: "evt_3" });

    expect(f.requests[0]).toMatchObject({ kind: "browse" });
  });
});

describe("session_search input coercion", () => {
  it("trims the identifying strings", async () => {
    const f = fakeSearch();
    await tool(f).handler({
      session_id: "  ses_9  ",
      around_message_id: "  evt_3  ",
    });

    expect(f.requests[0]).toMatchObject({
      session_id: "ses_9",
      around_message_id: "evt_3",
    });
  });

  it("trims the query", async () => {
    const f = fakeSearch();
    await tool(f).handler({ query: "  auth refactor  " });

    expect(f.requests[0]).toMatchObject({ query: "auth refactor" });
  });

  it("falls back to browse when every field is blank or whitespace", async () => {
    const f = fakeSearch();
    await tool(f).handler({ query: "   ", session_id: "  " });

    expect(f.requests[0]).toMatchObject({ kind: "browse" });
  });

  it("ignores non-string identifying fields", async () => {
    const f = fakeSearch();
    await tool(f).handler({ query: 7, session_id: null, around_message_id: [] });

    expect(f.requests[0]).toMatchObject({ kind: "browse" });
  });

  it("drops a non-numeric window and limit rather than passing them on", async () => {
    const f = fakeSearch();
    const t = tool(f);

    await t.handler({
      session_id: "ses_9",
      around_message_id: "evt_3",
      window: "10",
    });
    expect(f.requests[0]).toMatchObject({ window: undefined });

    await t.handler({ query: "x", limit: "3" });
    expect(f.requests[1]).toMatchObject({ limit: undefined });
  });

  it("passes limit through on discover and browse", async () => {
    const f = fakeSearch();
    const t = tool(f);

    await t.handler({ query: "x", limit: 3 });
    expect(f.requests[0]).toMatchObject({ limit: 3 });

    await t.handler({ limit: 5 });
    expect(f.requests[1]).toMatchObject({ kind: "browse", limit: 5 });
  });

  it("accepts only the two documented sort values", async () => {
    const f = fakeSearch();
    const t = tool(f);

    await t.handler({ query: "x", sort: "newest" });
    expect(f.requests[0]).toMatchObject({ sort: "newest" });

    await t.handler({ query: "x", sort: "oldest" });
    expect(f.requests[1]).toMatchObject({ sort: "oldest" });

    await t.handler({ query: "x", sort: "relevance" });
    expect(f.requests[2]).toMatchObject({ sort: undefined });
  });

  it("forwards filters on discover and browse", async () => {
    const f = fakeSearch();
    const t = tool(f);
    const filters = { status: "failed", session_type: "chat" };

    await t.handler({ query: "x", filters });
    expect(f.requests[0]).toMatchObject({ filters });

    await t.handler({ filters });
    expect(f.requests[1]).toMatchObject({ kind: "browse", filters });
  });

  it("ignores a non-object filters", async () => {
    const f = fakeSearch();
    const t = tool(f);

    for (const filters of [null, "failed", 7]) {
      await t.handler({ query: "x", filters });
    }
    for (const req of f.requests) {
      expect(req).toMatchObject({ filters: undefined });
    }
  });
});

describe("session_search scope", () => {
  it("passes the caller's identity and tier from context", async () => {
    // Tier drives how wide the search reaches, so it must come from the
    // resolved caller rather than anything the agent can set.
    const f = fakeSearch();
    await tool(f).handler({ query: "x", hierarchy_level: "org" });

    expect(f.scopes[0]).toEqual({
      callerAgentId: "agent_a",
      hierarchyLevel: "team",
      currentSessionId: "ses_current",
    });
  });

  it("carries an ic caller's tier through unchanged", async () => {
    const f = fakeSearch();
    await tool(f, { ...CTX, hierarchyLevel: "ic" }).handler({ query: "x" });

    expect(f.scopes[0]).toMatchObject({ hierarchyLevel: "ic" });
  });
});

describe("session_search results and errors", () => {
  it("returns the service's payload verbatim on success", async () => {
    const payload = { results: [{ session: { id: "ses_9" } }] };
    const f = fakeSearch({ result: payload });
    const result = await tool(f).handler({ query: "x" });

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe(payload);
  });

  it("maps a null result to not_found_or_forbidden", async () => {
    // null is the service's one signal for "out of scope, missing
    // anchor, or your own live conversation" — all three are the same
    // dead end for the agent.
    const f = fakeSearch({ result: null });
    const result = await tool(f).handler({ session_id: "ses_other" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "not_found_or_forbidden",
    });
  });

  it("surfaces a SessionSearchError's code", async () => {
    const f = fakeSearch({
      throws: new SessionSearchError("forbidden_agent_filter", "out of scope"),
    });
    const result = await tool(f).handler({
      query: "x",
      filters: { agent_id: "agent_other" },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "forbidden_agent_filter",
      message: "out of scope",
    });
  });

  it("surfaces the code for a cross-bundle error matched by name", async () => {
    // src/ and dist/ copies of core produce two distinct classes, so
    // instanceof alone would drop a real code to internal_error. The
    // name check is what keeps the contract stable across that split.
    const impostor = new Error("out of scope");
    impostor.name = "SessionSearchError";
    (impostor as Error & { code: string }).code = "missing_query";

    const f = fakeSearch({ throws: impostor });
    const result = await tool(f).handler({ query: "x" });

    expect(result.content).toMatchObject({
      error: "missing_query",
      message: "out of scope",
    });
  });

  it("maps an unexpected Error to internal_error", async () => {
    const f = fakeSearch({ throws: new Error("pool exhausted") });
    const result = await tool(f).handler({ query: "x" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "internal_error",
      message: "pool exhausted",
    });
  });

  it("stringifies a non-Error throw", async () => {
    const f = fakeSearch({ throws: "kaboom" });
    const result = await tool(f).handler({ query: "x" });

    expect(result.content).toMatchObject({
      error: "internal_error",
      message: "kaboom",
    });
  });
});
