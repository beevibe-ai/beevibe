/**
 * session_search MCP tool.
 *
 * The service owns scope resolution and the SQL. What this module owns
 * is `inferRequest` — the mapping from loose MCP input onto one of the
 * four discriminated request shapes — plus the null-result and error
 * envelopes. `inferRequest` is module-private, so these tests drive it
 * through the handler and assert on the request the service receives.
 *
 * Shape precedence is the thing most worth pinning: scroll beats read
 * beats discover beats browse, so an agent that passes a stale `query`
 * alongside a `session_id` gets the scroll/read it asked for rather
 * than a surprise FTS run.
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

const ctx: SessionSearchToolContext = {
  agentId: "agent_a",
  hierarchyLevel: "team",
  sessionId: "sess_current",
};

interface Harness {
  tool: ReturnType<typeof createSessionSearchTool>;
  requests: SessionSearchRequest[];
  contexts: SessionSearchContext[];
}

function harness(
  result: unknown = { kind: "browse", sessions: [] },
  toolCtx: SessionSearchToolContext = ctx,
): Harness {
  const requests: SessionSearchRequest[] = [];
  const contexts: SessionSearchContext[] = [];
  const sessionSearch = {
    search: vi.fn(async (req: SessionSearchRequest, c: SessionSearchContext) => {
      requests.push(req);
      contexts.push(c);
      if (typeof result === "function") return (result as () => unknown)();
      return result;
    }),
  } as unknown as SessionSearchService;
  return {
    tool: createSessionSearchTool(toolCtx, { sessionSearch }),
    requests,
    contexts,
  };
}

describe("session_search tool shape", () => {
  it("is named session_search and carries a thick description", () => {
    const { tool } = harness();
    expect(tool.name).toBe("session_search");
    // The description is the agent-facing contract; assert it still
    // documents all four shapes rather than pinning its exact prose.
    for (const shape of ["DISCOVERY", "SCROLL", "READ", "BROWSE"]) {
      expect(tool.description).toContain(shape);
    }
  });

  it("declares no required properties — the bare call is the browse shape", () => {
    const { tool } = harness();
    expect(tool.schema.required).toBeUndefined();
  });
});

describe("caller context passthrough", () => {
  it("forwards agentId, hierarchyLevel and the current session id", async () => {
    const h = harness();

    await h.tool.handler({ query: "auth refactor" });

    expect(h.contexts).toEqual([
      {
        callerAgentId: "agent_a",
        hierarchyLevel: "team",
        currentSessionId: "sess_current",
      },
    ]);
  });

  it("passes an ic caller's tier through unchanged", async () => {
    const h = harness({ kind: "browse", sessions: [] }, {
      agentId: "agent_ic",
      hierarchyLevel: "ic",
      sessionId: "sess_ic",
    });

    await h.tool.handler({});

    expect(h.contexts[0]).toMatchObject({
      callerAgentId: "agent_ic",
      hierarchyLevel: "ic",
    });
  });
});

describe("shape inference — browse", () => {
  it("infers browse from no arguments", async () => {
    const h = harness();

    await h.tool.handler({});

    expect(h.requests[0]).toEqual({ kind: "browse", limit: undefined, filters: undefined });
  });

  it("carries limit and filters onto the browse request", async () => {
    const h = harness();

    await h.tool.handler({ limit: 8, filters: { status: "failed" } });

    expect(h.requests[0]).toEqual({
      kind: "browse",
      limit: 8,
      filters: { status: "failed" },
    });
  });

  it("falls back to browse when query is blank", async () => {
    const h = harness();

    await h.tool.handler({ query: "   " });

    expect(h.requests[0]?.kind).toBe("browse");
  });

  it("falls back to browse when query is a non-string", async () => {
    const h = harness();

    await h.tool.handler({ query: 42 });

    expect(h.requests[0]?.kind).toBe("browse");
  });
});

describe("shape inference — discover", () => {
  it("infers discover from a query, trimming it", async () => {
    const h = harness();

    await h.tool.handler({ query: "  docker networking  " });

    expect(h.requests[0]).toEqual({
      kind: "discover",
      query: "docker networking",
      limit: undefined,
      sort: undefined,
      filters: undefined,
    });
  });

  it("passes limit, sort and filters through", async () => {
    const h = harness();

    await h.tool.handler({
      query: "auth",
      limit: 10,
      sort: "newest",
      filters: { session_type: "task", agent_id: "agent_sub" },
    });

    expect(h.requests[0]).toEqual({
      kind: "discover",
      query: "auth",
      limit: 10,
      sort: "newest",
      filters: { session_type: "task", agent_id: "agent_sub" },
    });
  });

  it("accepts sort=oldest", async () => {
    const h = harness();

    await h.tool.handler({ query: "auth", sort: "oldest" });

    expect(h.requests[0]).toMatchObject({ sort: "oldest" });
  });

  // An unrecognized sort must degrade to relevance-only rather than
  // reaching the service and widening its accepted input.
  it("drops an unrecognized sort", async () => {
    const h = harness();

    await h.tool.handler({ query: "auth", sort: "most_relevant" });

    expect(h.requests[0]).toMatchObject({ sort: undefined });
  });

  it("drops a non-numeric limit", async () => {
    const h = harness();

    await h.tool.handler({ query: "auth", limit: "10" });

    expect(h.requests[0]).toMatchObject({ limit: undefined });
  });

  it("drops a non-object filters value", async () => {
    const h = harness();

    await h.tool.handler({ query: "auth", filters: "status:failed" });

    expect(h.requests[0]).toMatchObject({ filters: undefined });
  });

  // `typeof null === "object"`, so the null guard in inferRequest is
  // load-bearing — without it a null filters reaches the service.
  it("drops a null filters rather than forwarding it", async () => {
    const h = harness();

    await h.tool.handler({ query: "auth", filters: null });

    expect(h.requests[0]).toMatchObject({ filters: undefined });
  });
});

describe("shape inference — read", () => {
  it("infers read from a bare session_id, trimming it", async () => {
    const h = harness();

    await h.tool.handler({ session_id: "  sess_42  " });

    expect(h.requests[0]).toEqual({ kind: "read", session_id: "sess_42" });
  });

  // Precedence: a session_id outranks a query, so a stale query left in
  // the call doesn't turn a read into an FTS search.
  it("beats a query", async () => {
    const h = harness();

    await h.tool.handler({ session_id: "sess_42", query: "auth refactor" });

    expect(h.requests[0]).toEqual({ kind: "read", session_id: "sess_42" });
  });

  it("ignores window and filters, which read does not accept", async () => {
    const h = harness();

    await h.tool.handler({ session_id: "sess_42", window: 10, filters: { status: "failed" } });

    expect(h.requests[0]).toEqual({ kind: "read", session_id: "sess_42" });
  });

  it("falls through to discover when session_id is blank", async () => {
    const h = harness();

    await h.tool.handler({ session_id: "  ", query: "auth" });

    expect(h.requests[0]).toMatchObject({ kind: "discover", query: "auth" });
  });
});

describe("shape inference — scroll", () => {
  it("infers scroll from session_id + around_message_id", async () => {
    const h = harness();

    await h.tool.handler({ session_id: "sess_42", around_message_id: "evt_9" });

    expect(h.requests[0]).toEqual({
      kind: "scroll",
      session_id: "sess_42",
      around_message_id: "evt_9",
      window: undefined,
    });
  });

  it("passes a numeric window through for the service to clamp", async () => {
    const h = harness();

    await h.tool.handler({ session_id: "sess_42", around_message_id: "evt_9", window: 20 });

    expect(h.requests[0]).toMatchObject({ window: 20 });
  });

  it("drops a non-numeric window", async () => {
    const h = harness();

    await h.tool.handler({ session_id: "sess_42", around_message_id: "evt_9", window: "10" });

    expect(h.requests[0]).toMatchObject({ window: undefined });
  });

  it("accepts the synthetic user-turn anchor id format", async () => {
    const h = harness();

    await h.tool.handler({ session_id: "sess_42", around_message_id: "intent:sess_42" });

    expect(h.requests[0]).toMatchObject({
      kind: "scroll",
      around_message_id: "intent:sess_42",
    });
  });

  // Scroll is the top of the precedence chain.
  it("beats a query", async () => {
    const h = harness();

    await h.tool.handler({
      session_id: "sess_42",
      around_message_id: "evt_9",
      query: "auth refactor",
    });

    expect(h.requests[0]?.kind).toBe("scroll");
  });

  it("degrades to read when the anchor is blank", async () => {
    const h = harness();

    await h.tool.handler({ session_id: "sess_42", around_message_id: "   " });

    expect(h.requests[0]).toEqual({ kind: "read", session_id: "sess_42" });
  });

  it("degrades to browse when the anchor is given without a session_id", async () => {
    const h = harness();

    await h.tool.handler({ around_message_id: "evt_9" });

    expect(h.requests[0]?.kind).toBe("browse");
  });
});

describe("result envelopes", () => {
  it("returns the service result as the tool content", async () => {
    const payload = { kind: "read", session: { id: "sess_42" }, messages: [] };
    const h = harness(payload);

    const result = await h.tool.handler({ session_id: "sess_42" });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual(payload);
  });

  // null is the service's "not in scope / no such anchor" signal; the
  // tool must turn it into one error the agent can branch on rather
  // than returning an empty success.
  it("maps a null result onto not_found_or_forbidden", async () => {
    const h = harness(null);

    const result = await h.tool.handler({ session_id: "sess_other" });

    expect(result.isError).toBe(true);
    expect(result.content.error).toBe("not_found_or_forbidden");
    expect(String(result.content.message)).toContain("scope");
  });
});

describe("error mapping", () => {
  it("preserves a SessionSearchError's code", async () => {
    const h = harness(() => {
      throw new SessionSearchError("forbidden_agent_filter", "agent_x is out of scope");
    });

    const result = await h.tool.handler({ query: "auth", filters: { agent_id: "agent_x" } });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "forbidden_agent_filter",
      message: "agent_x is out of scope",
    });
  });

  it.each(["missing_query", "missing_args"] as const)(
    "preserves the %s code",
    async (code) => {
      const h = harness(() => {
        throw new SessionSearchError(code, `coded: ${code}`);
      });

      const result = await h.tool.handler({ query: "auth" });

      expect(result.content).toEqual({ error: code, message: `coded: ${code}` });
    },
  );

  // The handler matches on `err.name` as well as instanceof, so a
  // structurally-identical error from a different bundle copy of core
  // (src/ vs dist/) still keeps its code instead of collapsing to
  // internal_error. This is the duplicated-class case that check exists for.
  it("honors a same-named error from a different module instance", async () => {
    const h = harness(() => {
      class SessionSearchError extends Error {
        constructor(
          public code: string,
          message: string,
        ) {
          super(message);
          this.name = "SessionSearchError";
        }
      }
      throw new SessionSearchError("missing_query", "query required");
    });

    const result = await h.tool.handler({ query: "auth" });

    expect(result.content).toEqual({ error: "missing_query", message: "query required" });
  });

  it("maps an unexpected Error onto internal_error", async () => {
    const h = harness(() => {
      throw new Error("connection terminated unexpectedly");
    });

    const result = await h.tool.handler({ query: "auth" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "internal_error",
      message: "connection terminated unexpectedly",
    });
  });

  it("maps a thrown non-Error onto internal_error with the stringified value", async () => {
    const h = harness(() => {
      throw "pool drained";
    });

    const result = await h.tool.handler({ query: "auth" });

    expect(result.content).toEqual({ error: "internal_error", message: "pool drained" });
  });

  // A plain Error named something else must NOT be treated as coded.
  it("does not mistake an unrelated named error for a coded one", async () => {
    const h = harness(() => {
      const err = new Error("boom");
      err.name = "TypeError";
      throw err;
    });

    const result = await h.tool.handler({ query: "auth" });

    expect(result.content.error).toBe("internal_error");
  });
});
