/**
 * session_search — unit tests with vitest fakes (no DB).
 *
 * The service owns scope resolution and the FTS queries. This module's
 * own logic is `inferRequest`: four calling shapes multiplexed onto one
 * tool, disambiguated purely by which arguments the agent passed. That
 * inference is the contract the tool description promises, so each
 * shape (and each precedence rule between them) gets a test, alongside
 * the error envelope mapping.
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

// ── Fakes ────────────────────────────────────────────────────────────────

const RESULT = { kind: "browse", sessions: [] } as const;

function buildTool(
  search?: SessionSearchService["search"],
  ctxOverrides: Partial<SessionSearchToolContext> = {},
) {
  const sessionSearch = {
    search: search ?? vi.fn(async () => RESULT),
  } as unknown as SessionSearchService;

  const ctx: SessionSearchToolContext = {
    agentId: "agent_a",
    hierarchyLevel: "team",
    sessionId: "ses_current",
    ...ctxOverrides,
  };

  return { tool: createSessionSearchTool(ctx, { sessionSearch }), sessionSearch };
}

/** Run the handler and hand back the request `inferRequest` produced. */
async function inferred(input: Record<string, unknown>): Promise<SessionSearchRequest> {
  const { tool, sessionSearch } = buildTool();
  await tool.handler(input);
  return vi.mocked(sessionSearch.search).mock.calls[0]![0];
}

// ── Tool surface ─────────────────────────────────────────────────────────

describe("createSessionSearchTool", () => {
  it("is named session_search and takes no required args", () => {
    const { tool } = buildTool();
    expect(tool.name).toBe("session_search");
    // Every argument is optional — the bare call is the browse shape.
    expect((tool.schema as { required?: string[] }).required).toBeUndefined();
  });

  it("passes the caller's identity and active session to the service", async () => {
    const { tool, sessionSearch } = buildTool(undefined, {
      agentId: "agent_b",
      hierarchyLevel: "ic",
      sessionId: "ses_mine",
    });
    await tool.handler({});
    expect(vi.mocked(sessionSearch.search).mock.calls[0]![1]).toEqual({
      callerAgentId: "agent_b",
      hierarchyLevel: "ic",
      currentSessionId: "ses_mine",
    });
  });
});

// ── Shape inference ──────────────────────────────────────────────────────

describe("inferRequest: browse", () => {
  it("infers browse from no arguments at all", async () => {
    expect(await inferred({})).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("carries limit and filters into browse", async () => {
    expect(
      await inferred({ limit: 7, filters: { status: "failed" } }),
    ).toEqual({
      kind: "browse",
      limit: 7,
      filters: { status: "failed" },
    });
  });

  it("drops a non-numeric limit", async () => {
    expect(await inferred({ limit: "7" })).toMatchObject({
      kind: "browse",
      limit: undefined,
    });
  });
});

describe("inferRequest: discover", () => {
  it("infers discover from a query", async () => {
    expect(await inferred({ query: "auth refactor" })).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: undefined,
      sort: undefined,
      filters: undefined,
    });
  });

  it("trims the query and carries limit, sort, and filters", async () => {
    expect(
      await inferred({
        query: "  auth refactor  ",
        limit: 3,
        sort: "newest",
        filters: { session_type: "chat", agent_id: "agent_z" },
      }),
    ).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: 3,
      sort: "newest",
      filters: { session_type: "chat", agent_id: "agent_z" },
    });
  });

  it("accepts oldest and rejects any other sort", async () => {
    expect(await inferred({ query: "x", sort: "oldest" })).toMatchObject({
      sort: "oldest",
    });
    for (const sort of ["relevance", "", 1, null]) {
      expect(
        await inferred({ query: "x", sort } as Record<string, unknown>),
      ).toMatchObject({ sort: undefined });
    }
  });

  it("falls back to browse when the query is blank or not a string", async () => {
    // A whitespace-only query is not a search — browsing is the useful
    // reading of it, not an empty FTS result set.
    for (const query of ["", "   ", 42, null]) {
      expect(
        await inferred({ query } as Record<string, unknown>),
      ).toMatchObject({ kind: "browse" });
    }
  });
});

describe("inferRequest: read", () => {
  it("infers read from a bare session_id", async () => {
    expect(await inferred({ session_id: "ses_7" })).toEqual({
      kind: "read",
      session_id: "ses_7",
    });
  });

  it("trims the session_id", async () => {
    expect(await inferred({ session_id: "  ses_7  " })).toEqual({
      kind: "read",
      session_id: "ses_7",
    });
  });

  it("ignores limit and filters, which read does not accept", async () => {
    expect(
      await inferred({ session_id: "ses_7", limit: 9, filters: { status: "failed" } }),
    ).toEqual({ kind: "read", session_id: "ses_7" });
  });

  it("falls back to the query shape when session_id is blank", async () => {
    expect(await inferred({ session_id: "   ", query: "x" })).toMatchObject({
      kind: "discover",
      query: "x",
    });
  });
});

describe("inferRequest: scroll", () => {
  it("infers scroll from session_id + around_message_id", async () => {
    expect(
      await inferred({ session_id: "ses_7", around_message_id: "evt_3" }),
    ).toEqual({
      kind: "scroll",
      session_id: "ses_7",
      around_message_id: "evt_3",
      window: undefined,
    });
  });

  it("trims both ids and carries the window through", async () => {
    expect(
      await inferred({
        session_id: " ses_7 ",
        around_message_id: " evt_3 ",
        window: 10,
      }),
    ).toEqual({
      kind: "scroll",
      session_id: "ses_7",
      around_message_id: "evt_3",
      window: 10,
    });
  });

  it("leaves clamping of a non-numeric or out-of-range window to the service", async () => {
    expect(
      await inferred({
        session_id: "ses_7",
        around_message_id: "evt_3",
        window: "10",
      }),
    ).toMatchObject({ window: undefined });
    expect(
      await inferred({
        session_id: "ses_7",
        around_message_id: "evt_3",
        window: 999,
      }),
    ).toMatchObject({ window: 999 });
  });

  it("accepts the synthetic user-turn anchor id format", async () => {
    expect(
      await inferred({
        session_id: "ses_7",
        around_message_id: "intent:ses_7",
      }),
    ).toMatchObject({ kind: "scroll", around_message_id: "intent:ses_7" });
  });

  it("degrades to read when the anchor is blank", async () => {
    expect(
      await inferred({ session_id: "ses_7", around_message_id: "  " }),
    ).toEqual({ kind: "read", session_id: "ses_7" });
  });

  it("wins over query when both are present", async () => {
    // Documented precedence: scroll > read > discover > browse.
    expect(
      await inferred({
        session_id: "ses_7",
        around_message_id: "evt_3",
        query: "auth refactor",
      }),
    ).toMatchObject({ kind: "scroll" });
  });

  it("ignores an anchor with no session_id", async () => {
    expect(await inferred({ around_message_id: "evt_3" })).toMatchObject({
      kind: "browse",
    });
  });
});

describe("inferRequest: filters", () => {
  it("drops filters that are not an object", async () => {
    for (const filters of [null, "status=failed", 7, undefined]) {
      expect(
        await inferred({ filters } as Record<string, unknown>),
      ).toMatchObject({ filters: undefined });
    }
  });

  it("passes an array through as-is rather than guessing", async () => {
    // typeof [] === "object"; the service validates the shape, not us.
    expect(await inferred({ filters: [] })).toMatchObject({ filters: [] });
  });
});

// ── Results and errors ───────────────────────────────────────────────────

describe("results", () => {
  it("returns the service result verbatim", async () => {
    const result = { kind: "read", messages: [{ id: "evt_1" }] };
    const { tool } = buildTool(vi.fn(async () => result) as unknown as SessionSearchService["search"]);
    const res = await tool.handler({ session_id: "ses_7" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toBe(result);
  });

  it("maps a null result to not_found_or_forbidden", async () => {
    // Null is the service's single answer for "out of scope", "no such
    // anchor", and "that's your own live conversation" — deliberately
    // undifferentiated so the tool can't be used to probe scope.
    const { tool } = buildTool(
      vi.fn(async () => null) as unknown as SessionSearchService["search"],
    );
    const res = await tool.handler({ session_id: "ses_other" });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("not_found_or_forbidden");
    expect(res.content.message).toContain("not in your scope");
  });
});

describe("error mapping", () => {
  function throwing(err: unknown) {
    return buildTool(
      vi.fn(async () => {
        throw err;
      }) as unknown as SessionSearchService["search"],
    );
  }

  it("surfaces a SessionSearchError's code", async () => {
    const { tool } = throwing(
      new SessionSearchError("forbidden_agent_filter", "agent_z is not yours"),
    );
    const res = await tool.handler({ query: "x", filters: { agent_id: "agent_z" } });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "forbidden_agent_filter",
      message: "agent_z is not yours",
    });
  });

  it("surfaces the code from a cross-bundle SessionSearchError", async () => {
    // An integration script consuming core's src/ while api consumes
    // dist/ throws a structurally-identical error that fails
    // `instanceof`. Name-matching keeps the code from degrading to
    // internal_error.
    const err = Object.assign(new Error("query required"), {
      name: "SessionSearchError",
      code: "missing_query",
    });
    const { tool } = throwing(err);
    const res = await tool.handler({ query: "x" });
    expect(res.content).toEqual({
      error: "missing_query",
      message: "query required",
    });
  });

  it("degrades an unexpected Error to internal_error", async () => {
    const { tool } = throwing(new Error("pg connection reset"));
    const res = await tool.handler({ query: "x" });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "internal_error",
      message: "pg connection reset",
    });
  });

  it("stringifies a non-Error throw", async () => {
    const { tool } = throwing("kaboom");
    const res = await tool.handler({ query: "x" });
    expect(res.content).toEqual({ error: "internal_error", message: "kaboom" });
  });

  it("does not mistake a same-named non-SessionSearchError for a coded one", async () => {
    const { tool } = throwing({ name: "SessionSearchError", code: "missing_query" });
    const res = await tool.handler({ query: "x" });
    // Not an Error instance, so it takes the catch-all path.
    expect(res.content.error).toBe("internal_error");
  });
});
