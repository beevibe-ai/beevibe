/**
 * session_search tool tests — Layer-3 memory.
 *
 * The retrieval itself (FTS ranking, lineage dedupe, bookends) is the
 * repository's job and is covered against real Postgres in
 * `core/src/adapters/postgres/session-search-repo.test.ts`. Scope
 * resolution is the service's.
 *
 * The tool's own contribution is `inferRequest` — the shape inference
 * that turns loose MCP input into one of four discriminated requests.
 * Getting that wrong means an agent asking to scroll silently gets a
 * whole-transcript dump instead, so the precedence rules
 * (scroll > read > discover > browse) are pinned exhaustively here,
 * along with the ctx forwarding and the error envelopes.
 */

import { describe, expect, it, vi } from "vitest";
import type { HierarchyLevel } from "@beevibe/core";
import {
  SessionSearchError,
  type SessionSearchService,
} from "@beevibe/core/services/session-search";
import {
  createSessionSearchTool,
  type SessionSearchToolContext,
} from "./session-search.js";

const AGENT_ID = "agent_caller";
const SESSION_ID = "sess_current";

interface Harness {
  tool: ReturnType<typeof createSessionSearchTool>;
  search: ReturnType<typeof vi.fn>;
}

function harness(
  opts: {
    ctx?: Partial<SessionSearchToolContext>;
    result?: unknown;
    error?: unknown;
  } = {},
): Harness {
  const search = vi.fn(async (_req: unknown, _ctx: unknown) => {
    if ("error" in opts) throw opts.error;
    return "result" in opts ? opts.result : { results: [] };
  });
  const ctx: SessionSearchToolContext = {
    agentId: AGENT_ID,
    hierarchyLevel: "team" as HierarchyLevel,
    sessionId: SESSION_ID,
    ...opts.ctx,
  };
  const tool = createSessionSearchTool(ctx, {
    sessionSearch: { search } as unknown as SessionSearchService,
  });
  return { tool, search };
}

/** The request the tool inferred and handed to the service. */
function sentRequest(h: Harness): Record<string, unknown> {
  return h.search.mock.calls[0]![0] as Record<string, unknown>;
}

describe("session_search — surface", () => {
  it("is named session_search and takes no required args", () => {
    const { tool } = harness();
    expect(tool.name).toBe("session_search");
    // Browse is the no-arg shape, so nothing may be required.
    expect((tool.schema as { required?: string[] }).required).toBeUndefined();
  });

  it("documents all four calling shapes in the description", () => {
    const { tool } = harness();
    for (const shape of ["DISCOVERY", "SCROLL", "READ", "BROWSE"]) {
      expect(tool.description).toContain(shape);
    }
  });
});

describe("shape inference — browse", () => {
  it("infers browse from no arguments", async () => {
    const h = harness();
    await h.tool.handler({});
    expect(sentRequest(h)).toEqual({ kind: "browse", limit: undefined, filters: undefined });
  });

  it("carries limit and filters into browse", async () => {
    const h = harness();
    await h.tool.handler({ limit: 7, filters: { status: "failed" } });
    expect(sentRequest(h)).toEqual({
      kind: "browse",
      limit: 7,
      filters: { status: "failed" },
    });
  });

  it("falls back to browse when query and session_id are only whitespace", async () => {
    const h = harness();
    await h.tool.handler({ query: "   ", session_id: "  " });
    expect(sentRequest(h).kind).toBe("browse");
  });
});

describe("shape inference — discover", () => {
  it("infers discover from a query", async () => {
    const h = harness();
    await h.tool.handler({ query: "auth refactor" });
    expect(sentRequest(h)).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: undefined,
      sort: undefined,
      filters: undefined,
    });
  });

  it("trims the query", async () => {
    const h = harness();
    await h.tool.handler({ query: "  docker networking  " });
    expect(sentRequest(h).query).toBe("docker networking");
  });

  it.each(["newest", "oldest"])("passes the valid sort %s through", async (sort) => {
    const h = harness();
    await h.tool.handler({ query: "x", sort });
    expect(sentRequest(h).sort).toBe(sort);
  });

  it.each([
    ["an unknown value", "relevance"],
    ["a non-string", 1],
  ])("drops a sort that is %s", async (_l, sort) => {
    const h = harness();
    await h.tool.handler({ query: "x", sort });
    expect(sentRequest(h).sort).toBeUndefined();
  });

  it("carries a numeric limit into discover", async () => {
    const h = harness();
    await h.tool.handler({ query: "x", limit: 7 });
    expect(sentRequest(h).limit).toBe(7);
  });

  it("drops a non-numeric limit", async () => {
    const h = harness();
    await h.tool.handler({ query: "x", limit: "3" });
    expect(sentRequest(h).limit).toBeUndefined();
  });
});

describe("shape inference — read", () => {
  it("infers read from a bare session_id", async () => {
    const h = harness();
    await h.tool.handler({ session_id: "sess_old" });
    expect(sentRequest(h)).toEqual({ kind: "read", session_id: "sess_old" });
  });

  it("trims the session_id", async () => {
    const h = harness();
    await h.tool.handler({ session_id: "  sess_old  " });
    expect(sentRequest(h).session_id).toBe("sess_old");
  });

  // Documented precedence: "Ignored when session_id + around_message_id
  // are set" — and a bare session_id likewise beats a query.
  it("beats a query when both are present", async () => {
    const h = harness();
    await h.tool.handler({ session_id: "sess_old", query: "auth" });
    expect(sentRequest(h)).toEqual({ kind: "read", session_id: "sess_old" });
  });
});

describe("shape inference — scroll", () => {
  it("infers scroll from session_id + around_message_id", async () => {
    const h = harness();
    await h.tool.handler({ session_id: "sess_old", around_message_id: "evt_5" });
    expect(sentRequest(h)).toEqual({
      kind: "scroll",
      session_id: "sess_old",
      around_message_id: "evt_5",
      window: undefined,
    });
  });

  it("trims the anchor and passes a numeric window", async () => {
    const h = harness();
    await h.tool.handler({
      session_id: "sess_old",
      around_message_id: "  evt_5  ",
      window: 10,
    });
    expect(sentRequest(h)).toMatchObject({ around_message_id: "evt_5", window: 10 });
  });

  it("leaves clamping of window to the service", async () => {
    // The tool forwards verbatim; [1,20] clamping is the service's rule.
    const h = harness();
    await h.tool.handler({ session_id: "s", around_message_id: "e", window: 999 });
    expect(sentRequest(h).window).toBe(999);
  });

  it("drops a non-numeric window", async () => {
    const h = harness();
    await h.tool.handler({ session_id: "s", around_message_id: "e", window: "10" });
    expect(sentRequest(h).window).toBeUndefined();
  });

  it("accepts the synthetic user-turn anchor id format", async () => {
    const h = harness();
    await h.tool.handler({ session_id: "sess_old", around_message_id: "intent:sess_old" });
    expect(sentRequest(h)).toMatchObject({
      kind: "scroll",
      around_message_id: "intent:sess_old",
    });
  });

  // An anchor without a session is not a scroll; the id alone can't
  // locate the conversation.
  it("degrades to discover when the anchor arrives without a session_id", async () => {
    const h = harness();
    await h.tool.handler({ around_message_id: "evt_5", query: "auth" });
    expect(sentRequest(h).kind).toBe("discover");
  });

  it("degrades to browse when the anchor arrives alone", async () => {
    const h = harness();
    await h.tool.handler({ around_message_id: "evt_5" });
    expect(sentRequest(h).kind).toBe("browse");
  });

  it("degrades to read when the anchor is blank", async () => {
    const h = harness();
    await h.tool.handler({ session_id: "sess_old", around_message_id: "   " });
    expect(sentRequest(h)).toEqual({ kind: "read", session_id: "sess_old" });
  });
});

describe("filters normalization", () => {
  it("forwards a filters object as given", async () => {
    const h = harness();
    const filters = { session_type: "task", status: "failed", agent_id: "agent_sub" };
    await h.tool.handler({ query: "x", filters });
    expect(sentRequest(h).filters).toEqual(filters);
  });

  it.each([
    ["null", null],
    ["a string", "status:failed"],
    ["absent", undefined],
  ])("drops filters that are %s", async (_l, filters) => {
    const h = harness();
    await h.tool.handler({ query: "x", filters });
    expect(sentRequest(h).filters).toBeUndefined();
  });
});

describe("caller context", () => {
  it("passes caller identity and tier from ctx, excluding the live session", async () => {
    const h = harness();
    await h.tool.handler({ query: "x" });
    // currentSessionId is what keeps the agent from re-discovering the
    // messages already in its own context window.
    expect(h.search.mock.calls[0]![1]).toEqual({
      callerAgentId: AGENT_ID,
      hierarchyLevel: "team",
      currentSessionId: SESSION_ID,
    });
  });

  it.each(["ic", "team", "org"])("forwards the %s tier verbatim", async (level) => {
    const h = harness({ ctx: { hierarchyLevel: level as HierarchyLevel } });
    await h.tool.handler({});
    expect(
      (h.search.mock.calls[0]![1] as { hierarchyLevel: string }).hierarchyLevel,
    ).toBe(level);
  });

  it("ignores caller identity supplied in the tool input", async () => {
    const h = harness();
    await h.tool.handler({ query: "x", agentId: "agent_other", callerAgentId: "agent_other" });
    expect(
      (h.search.mock.calls[0]![1] as { callerAgentId: string }).callerAgentId,
    ).toBe(AGENT_ID);
  });
});

describe("results and errors", () => {
  it("returns the service result as the tool content", async () => {
    const payload = { results: [{ session: { id: "sess_1" }, snippet: "…auth…" }] };
    const h = harness({ result: payload });
    const res = await h.tool.handler({ query: "auth" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual(payload);
  });

  // null is the service's "out of scope / no such anchor" signal; the
  // tool must turn it into an explicit error rather than empty content.
  it("maps a null result to not_found_or_forbidden", async () => {
    const h = harness({ result: null });
    const res = await h.tool.handler({ session_id: "sess_someone_elses" });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("not_found_or_forbidden");
    expect(res.content.message).toMatch(/not in your scope/);
  });

  it.each(["forbidden_agent_filter", "missing_query", "missing_args"] as const)(
    "preserves the SessionSearchError code %s",
    async (code) => {
      const h = harness({ error: new SessionSearchError(code, `nope: ${code}`) });
      const res = await h.tool.handler({ query: "x" });
      expect(res.isError).toBe(true);
      expect(res.content.error).toBe(code);
      expect(res.content.message).toBe(`nope: ${code}`);
    },
  );

  // Cross-bundle imports (a script on src/ vs api on dist/) break
  // instanceof, so the handler also matches on `name`. Simulate that
  // with a structurally identical error from a "different" class.
  it("recognizes a structurally-identical SessionSearchError by name", async () => {
    class ForeignSessionSearchError extends Error {
      code = "forbidden_agent_filter";
      constructor(message: string) {
        super(message);
        this.name = "SessionSearchError";
      }
    }
    const h = harness({ error: new ForeignSessionSearchError("out of tier") });
    const res = await h.tool.handler({ query: "x" });
    expect(res.content.error).toBe("forbidden_agent_filter");
    expect(res.content.message).toBe("out of tier");
  });

  it("wraps an unexpected Error as internal_error", async () => {
    const h = harness({ error: new Error("fts syntax error") });
    const res = await h.tool.handler({ query: "x" });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("internal_error");
    expect(res.content.message).toBe("fts syntax error");
  });

  it("stringifies a non-Error throw", async () => {
    const h = harness({ error: "boom" });
    const res = await h.tool.handler({ query: "x" });
    expect(res.content.error).toBe("internal_error");
    expect(res.content.message).toBe("boom");
  });
});
