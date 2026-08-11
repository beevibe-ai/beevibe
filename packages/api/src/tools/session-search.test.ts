/**
 * session_search handler tests.
 *
 * The interesting logic here is `inferRequest` — the tool takes one flat
 * bag of optional args and infers which of four request shapes the agent
 * meant. That precedence (scroll > read > discover > browse) is invisible
 * from the schema, so it's pinned here, along with the error envelope
 * for the null-result and thrown-error paths.
 */
import { describe, expect, it, vi } from "vitest";
import { SessionSearchError } from "@beevibe/core/services/session-search";
import type { SessionSearchService } from "@beevibe/core/services/session-search";
import {
  createSessionSearchTool,
  type SessionSearchToolContext,
  type SessionSearchToolServices,
} from "./session-search.js";

interface Harness {
  services: SessionSearchToolServices;
  request: () => Record<string, unknown> | undefined;
  callerCtx: () => Record<string, unknown> | undefined;
}

function harness(opts: { result?: unknown; throws?: unknown } = {}): Harness {
  let request: Record<string, unknown> | undefined;
  let callerCtx: Record<string, unknown> | undefined;

  const sessionSearch = {
    search: vi.fn(
      async (req: Record<string, unknown>, ctx: Record<string, unknown>) => {
        request = req;
        callerCtx = ctx;
        if (opts.throws !== undefined) throw opts.throws;
        return "result" in opts ? opts.result : { sessions: [] };
      },
    ),
  } as unknown as SessionSearchService;

  return {
    services: { sessionSearch },
    request: () => request,
    callerCtx: () => callerCtx,
  };
}

const CTX: SessionSearchToolContext = {
  agentId: "agent_a",
  hierarchyLevel: "team",
  sessionId: "sess_current",
};

function tool(h: Harness, ctx: SessionSearchToolContext = CTX) {
  return createSessionSearchTool(ctx, h.services);
}

describe("session_search — shape inference", () => {
  it("infers browse from no args at all", async () => {
    const h = harness();
    await tool(h).handler({});

    expect(h.request()).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("infers discover from a query", async () => {
    const h = harness();
    await tool(h).handler({ query: "auth refactor", limit: 5, sort: "newest" });

    expect(h.request()).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: 5,
      sort: "newest",
      filters: undefined,
    });
  });

  it("infers read from a bare session_id", async () => {
    const h = harness();
    await tool(h).handler({ session_id: "sess_42" });

    expect(h.request()).toEqual({ kind: "read", session_id: "sess_42" });
  });

  it("infers scroll from session_id + around_message_id", async () => {
    const h = harness();
    await tool(h).handler({
      session_id: "sess_42",
      around_message_id: "evt_9",
      window: 10,
    });

    expect(h.request()).toEqual({
      kind: "scroll",
      session_id: "sess_42",
      around_message_id: "evt_9",
      window: 10,
    });
  });

  it("prefers scroll over discover when a query is also present", async () => {
    const h = harness();
    await tool(h).handler({
      query: "auth",
      session_id: "sess_42",
      around_message_id: "evt_9",
    });

    expect(h.request()).toMatchObject({ kind: "scroll" });
  });

  it("prefers read over discover when a query is also present", async () => {
    const h = harness();
    await tool(h).handler({ query: "auth", session_id: "sess_42" });

    expect(h.request()).toEqual({ kind: "read", session_id: "sess_42" });
  });

  it("falls back to discover when around_message_id is set without session_id", async () => {
    const h = harness();
    await tool(h).handler({ query: "auth", around_message_id: "evt_9" });

    expect(h.request()).toMatchObject({ kind: "discover", query: "auth" });
  });

  it("falls back to browse when only around_message_id is set", async () => {
    const h = harness();
    await tool(h).handler({ around_message_id: "evt_9" });

    expect(h.request()).toMatchObject({ kind: "browse" });
  });
});

describe("session_search — argument coercion", () => {
  it("trims session_id, around_message_id and query", async () => {
    const h = harness();
    await tool(h).handler({
      session_id: "  sess_42  ",
      around_message_id: "  evt_9  ",
    });

    expect(h.request()).toMatchObject({
      session_id: "sess_42",
      around_message_id: "evt_9",
    });

    await tool(h).handler({ query: "  auth refactor  " });
    expect(h.request()).toMatchObject({ query: "auth refactor" });
  });

  it("treats whitespace-only strings as absent", async () => {
    const h = harness();
    await tool(h).handler({ session_id: "   ", query: "  ", around_message_id: " " });

    expect(h.request()).toMatchObject({ kind: "browse" });
  });

  it("ignores non-string session_id / query / around_message_id", async () => {
    const h = harness();
    await tool(h).handler({ session_id: 42, query: ["auth"], around_message_id: {} });

    expect(h.request()).toMatchObject({ kind: "browse" });
  });

  it("drops a non-numeric window, limit and an unknown sort", async () => {
    const h = harness();
    await tool(h).handler({
      session_id: "sess_42",
      around_message_id: "evt_9",
      window: "10",
    });
    expect(h.request()?.window).toBeUndefined();

    await tool(h).handler({ query: "auth", limit: "5", sort: "relevance" });
    expect(h.request()).toMatchObject({
      limit: undefined,
      sort: undefined,
    });
  });

  it("forwards filters on discover and browse but not on read/scroll", async () => {
    const h = harness();
    const filters = { session_type: "task", status: "failed" };

    await tool(h).handler({ query: "auth", filters });
    expect(h.request()?.filters).toEqual(filters);

    await tool(h).handler({ filters });
    expect(h.request()?.filters).toEqual(filters);

    await tool(h).handler({ session_id: "sess_42", filters });
    expect(h.request()).not.toHaveProperty("filters");
  });

  it("treats a null or non-object filters as absent", async () => {
    const h = harness();
    await tool(h).handler({ query: "auth", filters: null });
    expect(h.request()?.filters).toBeUndefined();

    await tool(h).handler({ query: "auth", filters: "session_type=task" });
    expect(h.request()?.filters).toBeUndefined();
  });
});

describe("session_search — caller context", () => {
  it("passes the caller's agent id, tier and active session to the service", async () => {
    const h = harness();
    await tool(h).handler({ query: "auth" });

    expect(h.callerCtx()).toEqual({
      callerAgentId: "agent_a",
      hierarchyLevel: "team",
      currentSessionId: "sess_current",
    });
  });

  it("carries an ic caller's tier through unchanged", async () => {
    const h = harness();
    await tool(h, { ...CTX, hierarchyLevel: "ic" }).handler({});

    expect(h.callerCtx()).toMatchObject({ hierarchyLevel: "ic" });
  });
});

describe("session_search — result and error envelopes", () => {
  it("returns the service result verbatim as content", async () => {
    const payload = { kind: "browse", sessions: [{ id: "sess_1" }] };
    const h = harness({ result: payload });

    const result = await tool(h).handler({});
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual(payload);
  });

  it("maps a null result to not_found_or_forbidden", async () => {
    const h = harness({ result: null });

    const result = await tool(h).handler({ session_id: "sess_other" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "not_found_or_forbidden" });
  });

  it.each(["forbidden_agent_filter", "missing_query", "missing_args"] as const)(
    "surfaces the %s code from a SessionSearchError",
    async (code) => {
      const h = harness({ throws: new SessionSearchError(code, `boom: ${code}`) });

      const result = await tool(h).handler({ query: "auth" });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual({ error: code, message: `boom: ${code}` });
    },
  );

  it("matches a cross-bundle SessionSearchError by name, not just instanceof", async () => {
    // An integration script consuming src/ while the api consumes dist/
    // produces a structurally identical error from a different module
    // instance; the code must still reach the agent.
    const foreign = new Error("agent_id outside your scope");
    foreign.name = "SessionSearchError";
    (foreign as Error & { code: string }).code = "forbidden_agent_filter";
    const h = harness({ throws: foreign });

    const result = await tool(h).handler({
      query: "auth",
      filters: { agent_id: "agent_other" },
    });
    expect(result.content).toEqual({
      error: "forbidden_agent_filter",
      message: "agent_id outside your scope",
    });
  });

  it("degrades an unexpected throw to internal_error", async () => {
    const h = harness({ throws: new Error("pool exhausted") });

    const result = await tool(h).handler({});
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "internal_error",
      message: "pool exhausted",
    });
  });

  it("stringifies a non-Error throw", async () => {
    const h = harness({ throws: "kaboom" });

    const result = await tool(h).handler({});
    expect(result.content).toEqual({ error: "internal_error", message: "kaboom" });
  });
});

describe("session_search — tool descriptor", () => {
  it("is named session_search and requires nothing (browse is the no-arg shape)", () => {
    const t = tool(harness());
    expect(t.name).toBe("session_search");
    expect(t.schema.required).toBeUndefined();
  });

  it("advertises the four calling shapes in its description", () => {
    const t = tool(harness());
    for (const shape of ["DISCOVERY", "SCROLL", "READ", "BROWSE"]) {
      expect(t.description).toContain(shape);
    }
  });

  it("enumerates session types and statuses on the filters schema", () => {
    const t = tool(harness());
    const filters = (t.schema.properties as Record<string, { properties: Record<string, { enum?: string[] }> }>)
      .filters!;
    expect(filters.properties.session_type?.enum).toContain("run_repo");
    expect(filters.properties.status?.enum).toContain("failed");
  });
});
