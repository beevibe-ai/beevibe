/**
 * session_search tool tests — Layer-3 memory's MCP surface.
 *
 * The handler's own job is shape inference (which of the four calling
 * shapes raw agent input means), caller-scope threading, and error
 * envelope mapping. The retrieval itself is SessionSearchService's and
 * is covered by the DB-backed session-search-repo suite, so the service
 * is faked here and asserted on by the request it receives.
 */
import { describe, expect, it, vi } from "vitest";
import { SessionSearchError } from "@beevibe/core/services/session-search";
import type { SessionSearchService } from "@beevibe/core/services/session-search";
import type { SessionSearchRequest } from "@beevibe/core";
import {
  createSessionSearchTool,
  type SessionSearchToolContext,
} from "./session-search.js";

const CTX: SessionSearchToolContext = {
  agentId: "agent_me",
  hierarchyLevel: "team",
  sessionId: "ses_active",
};

function harness(impl?: () => unknown) {
  const respond = impl ?? (async () => ({ kind: "browse", sessions: [] }));
  const search = vi.fn((..._args: unknown[]) => respond());
  const sessionSearch = { search } as unknown as SessionSearchService;
  return {
    search,
    tool: (ctx: SessionSearchToolContext = CTX) =>
      createSessionSearchTool(ctx, { sessionSearch }),
  };
}

/** The request the faked service was handed on the first (only) call. */
function sentRequest(search: ReturnType<typeof vi.fn>): SessionSearchRequest {
  return search.mock.calls[0]?.[0] as SessionSearchRequest;
}

describe("session_search descriptor", () => {
  it("exposes every argument as optional — the shape is inferred, not declared", () => {
    const { tool } = harness();
    const t = tool();
    expect(t.name).toBe("session_search");
    expect(t.schema.required).toBeUndefined();
    expect(Object.keys(t.schema.properties as object).sort()).toEqual([
      "around_message_id",
      "filters",
      "limit",
      "query",
      "session_id",
      "sort",
      "window",
    ]);
  });

  it("documents all four calling shapes in the agent-facing description", () => {
    const { tool } = harness();
    const d = tool().description;
    for (const shape of ["DISCOVERY", "SCROLL", "READ", "BROWSE"]) {
      expect(d).toContain(shape);
    }
  });
});

describe("shape inference", () => {
  it("session_id + around_message_id means scroll, with window passed through", async () => {
    const { search, tool } = harness();
    await tool().handler({
      session_id: "  ses_old  ",
      around_message_id: "  evt_7  ",
      window: 12,
      // A query alongside the scroll args is ignored, per the contract.
      query: "auth refactor",
    });

    expect(sentRequest(search)).toEqual({
      kind: "scroll",
      session_id: "ses_old",
      around_message_id: "evt_7",
      window: 12,
    });
  });

  it("leaves window undefined when not a number, so the service clamps its default", async () => {
    const { search, tool } = harness();
    await tool().handler({
      session_id: "ses_old",
      around_message_id: "evt_7",
      window: "12",
    });

    expect(sentRequest(search)).toMatchObject({ kind: "scroll", window: undefined });
  });

  it("bare session_id means read", async () => {
    const { search, tool } = harness();
    await tool().handler({ session_id: "ses_old" });

    expect(sentRequest(search)).toEqual({ kind: "read", session_id: "ses_old" });
  });

  it("a blank around_message_id degrades scroll to read, not a broken scroll", async () => {
    const { search, tool } = harness();
    await tool().handler({ session_id: "ses_old", around_message_id: "   " });

    expect(sentRequest(search)).toEqual({ kind: "read", session_id: "ses_old" });
  });

  it("query without session_id means discover, carrying limit, sort and filters", async () => {
    const { search, tool } = harness();
    await tool().handler({
      query: "  auth refactor  ",
      limit: 5,
      sort: "newest",
      filters: { session_type: "task", status: "failed" },
    });

    expect(sentRequest(search)).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: 5,
      sort: "newest",
      filters: { session_type: "task", status: "failed" },
    });
  });

  it("drops an unknown sort value rather than forwarding it", async () => {
    const { search, tool } = harness();
    await tool().handler({ query: "x", sort: "relevance" });

    expect(sentRequest(search)).toMatchObject({ kind: "discover", sort: undefined });
  });

  it("accepts sort=oldest", async () => {
    const { search, tool } = harness();
    await tool().handler({ query: "x", sort: "oldest" });

    expect(sentRequest(search)).toMatchObject({ sort: "oldest" });
  });

  it("no args means browse", async () => {
    const { search, tool } = harness();
    await tool().handler({});

    expect(sentRequest(search)).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("a blank session_id and blank query still mean browse", async () => {
    const { search, tool } = harness();
    await tool().handler({ session_id: "   ", query: "  " });

    expect(sentRequest(search)).toMatchObject({ kind: "browse" });
  });

  it("browse carries limit and filters", async () => {
    const { search, tool } = harness();
    await tool().handler({ limit: 10, filters: { agent_id: "agent_sub" } });

    expect(sentRequest(search)).toEqual({
      kind: "browse",
      limit: 10,
      filters: { agent_id: "agent_sub" },
    });
  });

  it("ignores a non-object filters value", async () => {
    const { search, tool } = harness();
    await tool().handler({ query: "x", filters: "session_type=task" });

    expect(sentRequest(search)).toMatchObject({ filters: undefined });
  });

  it("ignores a null filters value", async () => {
    const { search, tool } = harness();
    await tool().handler({ query: "x", filters: null });

    expect(sentRequest(search)).toMatchObject({ filters: undefined });
  });
});

describe("caller scope threading", () => {
  it("passes the caller agent id, tier and active session to the service", async () => {
    const { search, tool } = harness();
    await tool({
      agentId: "agent_org",
      hierarchyLevel: "org",
      sessionId: "ses_current",
    }).handler({ query: "x" });

    expect(search.mock.calls[0]?.[1]).toEqual({
      callerAgentId: "agent_org",
      hierarchyLevel: "org",
      currentSessionId: "ses_current",
    });
  });
});

describe("result + error envelopes", () => {
  it("returns the service result verbatim on success", async () => {
    const payload = { kind: "read", session: { id: "ses_old" }, messages: [] };
    const { tool } = harness(async () => payload);
    const res = await tool().handler({ session_id: "ses_old" });

    expect(res.isError).toBeFalsy();
    expect(res.content).toBe(payload);
  });

  it("maps a null result to not_found_or_forbidden", async () => {
    const { tool } = harness(async () => null);
    const res = await tool().handler({ session_id: "ses_other" });

    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "not_found_or_forbidden" });
    expect(String(res.content.message)).toContain("not in your scope");
  });

  it.each(["forbidden_agent_filter", "missing_query", "missing_args"] as const)(
    "surfaces SessionSearchError code %s",
    async (code) => {
      const { tool } = harness(async () => {
        throw new SessionSearchError(code, `refused: ${code}`);
      });
      const res = await tool().handler({ query: "x" });

      expect(res.isError).toBe(true);
      expect(res.content).toEqual({ error: code, message: `refused: ${code}` });
    },
  );

  it("matches a cross-bundle SessionSearchError by name, not just instanceof", async () => {
    // An integration script consuming core/src while api consumes
    // core/dist produces a structurally identical but non-instanceof
    // error; the code still has to come through.
    const alien = new Error("scope refused");
    alien.name = "SessionSearchError";
    (alien as Error & { code: string }).code = "forbidden_agent_filter";

    const { tool } = harness(async () => {
      throw alien;
    });
    const res = await tool().handler({ query: "x", filters: { agent_id: "agent_x" } });

    expect(res.content).toEqual({
      error: "forbidden_agent_filter",
      message: "scope refused",
    });
  });

  it("wraps an unexpected Error as internal_error", async () => {
    const { tool } = harness(async () => {
      throw new Error("pool exhausted");
    });
    const res = await tool().handler({});

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "internal_error",
      message: "pool exhausted",
    });
  });

  it("stringifies a thrown non-Error as internal_error", async () => {
    const { tool } = harness(async () => {
      throw "weird";
    });
    const res = await tool().handler({});

    expect(res.content).toEqual({ error: "internal_error", message: "weird" });
  });
});
