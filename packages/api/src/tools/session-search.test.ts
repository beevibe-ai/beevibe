/**
 * session_search handler tests.
 *
 * The tool owns two things the service can't: shape inference (which of
 * discover / scroll / read / browse a loose MCP input means) and the
 * error envelope. Shape inference is precedence-sensitive — scroll beats
 * read beats discover beats browse — so each rung is pinned, including
 * the inputs that fall *through* a rung because they're blank.
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
import type { AgentTool } from "./types.js";

interface Harness {
  tool: AgentTool;
  requests: SessionSearchRequest[];
  contexts: Array<Record<string, unknown>>;
}

function harness(
  overrides: {
    ctx?: Partial<SessionSearchToolContext>;
    search?: () => Promise<unknown>;
  } = {},
): Harness {
  const requests: SessionSearchRequest[] = [];
  const contexts: Array<Record<string, unknown>> = [];

  const sessionSearch = {
    search: vi.fn(
      async (req: SessionSearchRequest, ctx: Record<string, unknown>) => {
        requests.push(req);
        contexts.push(ctx);
        if (overrides.search) return overrides.search();
        return { kind: req.kind, results: [] };
      },
    ),
  } as unknown as SessionSearchService;

  const tool = createSessionSearchTool(
    {
      agentId: "agent_a",
      hierarchyLevel: "team",
      sessionId: "ses_current",
      ...overrides.ctx,
    },
    { sessionSearch },
  );
  return { tool, requests, contexts };
}

describe("session_search tool descriptor", () => {
  it("is named session_search and takes no required fields", () => {
    const { tool } = harness();
    expect(tool.name).toBe("session_search");
    // Every shape is optional — a bare call is the browse shape.
    expect(tool.schema.required).toBeUndefined();
  });

  it("documents all four calling shapes in the description", () => {
    const { tool } = harness();
    for (const shape of ["DISCOVERY", "SCROLL", "READ", "BROWSE"]) {
      expect(tool.description).toContain(shape);
    }
  });

  it("enumerates the sort options and the filter properties", () => {
    const { tool } = harness();
    const props = tool.schema.properties as Record<
      string,
      { enum?: string[]; properties?: Record<string, unknown> }
    >;
    expect(props.sort?.enum).toEqual(["newest", "oldest"]);
    expect(Object.keys(props.filters?.properties ?? {}).sort()).toEqual([
      "agent_id",
      "session_type",
      "since",
      "status",
      "task_id",
      "until",
    ]);
  });
});

describe("session_search scope context", () => {
  it("forwards the caller's agent id, tier and current session to the service", async () => {
    const h = harness({
      ctx: { agentId: "agent_org", hierarchyLevel: "org", sessionId: "ses_9" },
    });

    await h.tool.handler({ query: "auth refactor" });

    expect(h.contexts[0]).toEqual({
      callerAgentId: "agent_org",
      hierarchyLevel: "org",
      currentSessionId: "ses_9",
    });
  });

  it("returns the service result verbatim", async () => {
    const h = harness({
      search: async () => ({ kind: "browse", sessions: [{ id: "ses_1" }] }),
    });

    const result = await h.tool.handler({});

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ kind: "browse", sessions: [{ id: "ses_1" }] });
  });
});

describe("session_search shape inference", () => {
  it("infers scroll when session_id and around_message_id are both set", async () => {
    const h = harness();

    await h.tool.handler({
      session_id: " ses_1 ",
      around_message_id: " evt_7 ",
      window: 10,
    });

    expect(h.requests[0]).toEqual({
      kind: "scroll",
      session_id: "ses_1",
      around_message_id: "evt_7",
      window: 10,
    });
  });

  it("leaves window undefined when it is absent or not a number", async () => {
    const h = harness();

    await h.tool.handler({ session_id: "ses_1", around_message_id: "evt_7" });
    await h.tool.handler({
      session_id: "ses_1",
      around_message_id: "evt_7",
      window: "10",
    });

    expect(h.requests.map((r) => (r as { window?: number }).window)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("scroll wins over discover when a query is also present", async () => {
    const h = harness();

    await h.tool.handler({
      session_id: "ses_1",
      around_message_id: "evt_7",
      query: "ignored",
    });

    expect(h.requests[0]?.kind).toBe("scroll");
  });

  it("infers read from a bare session_id, trimmed", async () => {
    const h = harness();

    await h.tool.handler({ session_id: "  ses_1  " });

    expect(h.requests[0]).toEqual({ kind: "read", session_id: "ses_1" });
  });

  it("read wins over discover when a query is also present", async () => {
    const h = harness();

    await h.tool.handler({ session_id: "ses_1", query: "ignored" });

    expect(h.requests[0]?.kind).toBe("read");
  });

  it("falls through from scroll to read when around_message_id is blank", async () => {
    const h = harness();

    await h.tool.handler({
      session_id: "ses_1",
      around_message_id: "   ",
      query: "auth",
    });

    expect(h.requests[0]?.kind).toBe("read");
  });

  it("infers discover from a query, carrying limit, sort and filters", async () => {
    const h = harness();

    await h.tool.handler({
      query: "  docker networking  ",
      limit: 7,
      sort: "newest",
      filters: { status: "failed", session_type: "task" },
    });

    expect(h.requests[0]).toEqual({
      kind: "discover",
      query: "docker networking",
      limit: 7,
      sort: "newest",
      filters: { status: "failed", session_type: "task" },
    });
  });

  it("drops an unrecognized sort rather than passing it through", async () => {
    const h = harness();

    await h.tool.handler({ query: "x", sort: "relevance" });

    expect((h.requests[0] as { sort?: string }).sort).toBeUndefined();
  });

  it("accepts 'oldest' as a sort", async () => {
    const h = harness();

    await h.tool.handler({ query: "x", sort: "oldest" });

    expect((h.requests[0] as { sort?: string }).sort).toBe("oldest");
  });

  it("drops a non-numeric limit", async () => {
    const h = harness();

    await h.tool.handler({ query: "x", limit: "7" });

    expect((h.requests[0] as { limit?: number }).limit).toBeUndefined();
  });

  it("infers browse from an empty input", async () => {
    const h = harness();

    await h.tool.handler({});

    expect(h.requests[0]).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("infers browse when every string arg is blank", async () => {
    const h = harness();

    await h.tool.handler({ query: "   ", session_id: "  ", around_message_id: "" });

    expect(h.requests[0]?.kind).toBe("browse");
  });

  it("carries limit and filters into browse", async () => {
    const h = harness();

    await h.tool.handler({ limit: 10, filters: { agent_id: "agent_b" } });

    expect(h.requests[0]).toEqual({
      kind: "browse",
      limit: 10,
      filters: { agent_id: "agent_b" },
    });
  });

  it("treats a null or non-object filters as absent", async () => {
    const h = harness();

    await h.tool.handler({ query: "x", filters: null });
    await h.tool.handler({ query: "x", filters: "status:failed" });

    for (const req of h.requests) {
      expect((req as { filters?: unknown }).filters).toBeUndefined();
    }
  });
});

describe("session_search error envelopes", () => {
  it("reports not_found_or_forbidden when the service returns null", async () => {
    const h = harness({ search: async () => null });

    const result = await h.tool.handler({ session_id: "ses_other" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "not_found_or_forbidden" });
  });

  it("surfaces a SessionSearchError's code", async () => {
    const h = harness({
      search: async () => {
        throw new SessionSearchError(
          "forbidden_agent_filter",
          "agent_b is outside your scope",
        );
      },
    });

    const result = await h.tool.handler({
      query: "x",
      filters: { agent_id: "agent_b" },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "forbidden_agent_filter",
      message: "agent_b is outside your scope",
    });
  });

  it("matches a SessionSearchError by name across bundle boundaries", async () => {
    // A cross-bundle copy of the class fails `instanceof` but keeps the
    // name — the handler falls back to a name check so the structured
    // code still reaches the agent.
    const impostor = new Error("missing query") as Error & { code: string };
    impostor.name = "SessionSearchError";
    impostor.code = "missing_query";
    const h = harness({
      search: async () => {
        throw impostor;
      },
    });

    const result = await h.tool.handler({ query: "x" });

    expect(result.content).toEqual({
      error: "missing_query",
      message: "missing query",
    });
  });

  it("degrades an unexpected Error to internal_error", async () => {
    const h = harness({
      search: async () => {
        throw new Error("connection terminated");
      },
    });

    const result = await h.tool.handler({ query: "x" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "internal_error",
      message: "connection terminated",
    });
  });

  it("stringifies a non-Error throw into internal_error", async () => {
    const h = harness({
      search: async () => {
        throw "pool gone";
      },
    });

    const result = await h.tool.handler({ query: "x" });

    expect(result.content).toEqual({
      error: "internal_error",
      message: "pool gone",
    });
  });
});
