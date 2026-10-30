/**
 * session_search tool tests.
 *
 * The module's real logic is `inferRequest` — one tool, four calling
 * shapes, inferred from which args are present. That inference is the
 * agent-facing contract documented in the tool description, so each
 * shape (and each precedence rule between them) is locked here against a
 * fake SessionSearchService.
 *
 * Also covered: the two error paths the service can produce — a `null`
 * result (out of scope / unknown anchor) and SessionSearchError, including
 * the name-matched cross-bundle case the handler deliberately handles.
 */
import { describe, expect, it, vi } from "vitest";
import type { SessionSearchRequest } from "@beevibe/core";
import {
  SessionSearchError,
  type SessionSearchContext,
  type SessionSearchService,
} from "@beevibe/core/services/session-search";
import {
  createSessionSearchTool,
  type SessionSearchToolContext,
} from "./session-search.js";

const CTX: SessionSearchToolContext = {
  agentId: "agent_a",
  hierarchyLevel: "team",
  sessionId: "ses_now",
};

function harness(
  opts: { result?: unknown; error?: unknown } = {},
) {
  const seen: Array<{ req: SessionSearchRequest; ctx: SessionSearchContext }> = [];
  const sessionSearch = {
    search: vi.fn(async (req: SessionSearchRequest, ctx: SessionSearchContext) => {
      seen.push({ req, ctx });
      if (opts.error) throw opts.error;
      return "result" in opts ? opts.result : { kind: "browse", sessions: [] };
    }),
  } as unknown as SessionSearchService;
  return {
    seen,
    sessionSearch,
    tool: createSessionSearchTool(CTX, { sessionSearch }),
  };
}

/** Runs the handler and returns the request the service was handed. */
async function requestFor(input: Record<string, unknown>) {
  const { tool, seen } = harness();
  await tool.handler(input);
  return seen[0]!.req;
}

describe("session_search tool surface", () => {
  it("is named session_search and takes no required args", () => {
    const { tool } = harness();
    expect(tool.name).toBe("session_search");
    expect(tool.schema.required).toBeUndefined();
    expect(tool.description).toContain("FOUR CALLING SHAPES");
  });

  it("forwards the caller's tier and active session as the search context", async () => {
    const { tool, seen } = harness();
    await tool.handler({ query: "auth refactor" });
    expect(seen[0]?.ctx).toEqual({
      callerAgentId: "agent_a",
      hierarchyLevel: "team",
      currentSessionId: "ses_now",
    });
  });
});

describe("shape inference", () => {
  it("infers browse from no args", async () => {
    expect(await requestFor({})).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("carries a numeric limit into browse", async () => {
    expect(await requestFor({ limit: 10 })).toEqual({
      kind: "browse",
      limit: 10,
      filters: undefined,
    });
  });

  it("infers discover from query, carrying limit and sort", async () => {
    expect(await requestFor({ query: "  auth refactor ", limit: 7, sort: "newest" })).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: 7,
      sort: "newest",
      filters: undefined,
    });
  });

  it("infers read from a bare session_id", async () => {
    expect(await requestFor({ session_id: " ses_7 " })).toEqual({
      kind: "read",
      session_id: "ses_7",
    });
  });

  it("infers scroll from session_id + around_message_id", async () => {
    expect(
      await requestFor({
        session_id: " ses_7 ",
        around_message_id: " evt_3 ",
        window: 12,
      }),
    ).toEqual({
      kind: "scroll",
      session_id: "ses_7",
      around_message_id: "evt_3",
      window: 12,
    });
  });

  it("accepts the synthetic user-turn anchor id format", async () => {
    const req = await requestFor({
      session_id: "ses_7",
      around_message_id: "intent:ses_7",
    });
    expect(req).toMatchObject({ kind: "scroll", around_message_id: "intent:ses_7" });
  });

  it("lets scroll win over a query passed alongside it", async () => {
    const req = await requestFor({
      session_id: "ses_7",
      around_message_id: "evt_3",
      query: "ignored",
    });
    expect(req.kind).toBe("scroll");
    expect(req).not.toHaveProperty("query");
  });

  it("lets read win over a query passed alongside it", async () => {
    const req = await requestFor({ session_id: "ses_7", query: "ignored" });
    expect(req).toEqual({ kind: "read", session_id: "ses_7" });
  });

  it("falls back to browse when an anchor arrives without a session_id", async () => {
    expect((await requestFor({ around_message_id: "evt_3" })).kind).toBe("browse");
  });

  it("treats whitespace-only ids and queries as absent", async () => {
    expect((await requestFor({ session_id: "   ", query: "  " })).kind).toBe("browse");
    expect((await requestFor({ session_id: "ses_7", around_message_id: "  " }))).toEqual({
      kind: "read",
      session_id: "ses_7",
    });
  });

  it("treats non-string ids and queries as absent", async () => {
    expect((await requestFor({ session_id: 7, query: { a: 1 } })).kind).toBe("browse");
  });
});

describe("optional-arg coercion", () => {
  it("drops a non-numeric limit rather than passing it through", async () => {
    expect(await requestFor({ query: "x", limit: "7" })).toMatchObject({
      limit: undefined,
    });
  });

  it("drops a non-numeric scroll window", async () => {
    expect(
      await requestFor({ session_id: "ses_7", around_message_id: "evt_3", window: "12" }),
    ).toMatchObject({ window: undefined });
  });

  it("only honours 'newest' and 'oldest' for sort", async () => {
    expect(await requestFor({ query: "x", sort: "oldest" })).toMatchObject({
      sort: "oldest",
    });
    for (const sort of ["relevance", "", 1, undefined]) {
      expect(await requestFor({ query: "x", sort })).toMatchObject({ sort: undefined });
    }
  });

  it("passes filters through on discover", async () => {
    const filters = { session_type: "task", status: "failed", agent_id: "agent_b" };
    expect(await requestFor({ query: "x", filters })).toMatchObject({ filters });
  });

  it("passes filters through on browse", async () => {
    const filters = { task_id: "tsk_1" };
    expect(await requestFor({ filters })).toMatchObject({ kind: "browse", filters });
  });

  it("ignores filters that aren't objects", async () => {
    for (const filters of [null, "task", 3]) {
      expect(await requestFor({ query: "x", filters })).toMatchObject({
        filters: undefined,
      });
    }
  });
});

describe("result and error envelopes", () => {
  it("returns the service result verbatim as content", async () => {
    const result = { kind: "read", session: { id: "ses_7" }, messages: [] };
    const { tool } = harness({ result });
    const out = await tool.handler({ session_id: "ses_7" });
    expect(out.isError).toBeFalsy();
    expect(out.content).toBe(result);
  });

  it("turns a null result into not_found_or_forbidden", async () => {
    const { tool } = harness({ result: null });
    const out = await tool.handler({ session_id: "ses_other" });
    expect(out.isError).toBe(true);
    expect(out.content).toMatchObject({ error: "not_found_or_forbidden" });
    expect(String(out.content.message)).toContain("not in your scope");
  });

  it("surfaces a SessionSearchError's code", async () => {
    const { tool } = harness({
      error: new SessionSearchError("forbidden_agent_filter", "agent_b is out of scope"),
    });
    const out = await tool.handler({ query: "x", filters: { agent_id: "agent_b" } });
    expect(out.isError).toBe(true);
    expect(out.content).toEqual({
      error: "forbidden_agent_filter",
      message: "agent_b is out of scope",
    });
  });

  it("matches a SessionSearchError by name so a cross-bundle import keeps its code", async () => {
    // Same class shape, different module instance — `instanceof` fails but
    // the name check in the handler still recovers the structured code.
    const crossBundle = Object.assign(new Error("query required"), {
      name: "SessionSearchError",
      code: "missing_query",
    });
    const { tool } = harness({ error: crossBundle });
    const out = await tool.handler({ query: "x" });
    expect(out.content).toEqual({ error: "missing_query", message: "query required" });
  });

  it("wraps anything else as internal_error", async () => {
    const { tool } = harness({ error: new Error("pool exhausted") });
    const out = await tool.handler({});
    expect(out.isError).toBe(true);
    expect(out.content).toEqual({ error: "internal_error", message: "pool exhausted" });
  });

  it("stringifies a non-Error throw into internal_error", async () => {
    const { tool } = harness({ error: "kaboom" });
    const out = await tool.handler({});
    expect(out.content).toEqual({ error: "internal_error", message: "kaboom" });
  });
});
