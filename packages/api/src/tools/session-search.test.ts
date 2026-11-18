/**
 * session_search tool — unit tests with vitest fakes (no DB).
 *
 * The tool's own logic is `inferRequest` plus the error envelope; the
 * retrieval itself belongs to SessionSearchService (covered against a
 * real Postgres in core). So the fake service here just records the
 * request it was handed, and these tests pin:
 *
 *   - shape inference across all four calling shapes, including the
 *     precedence rules when a caller passes overlapping args
 *   - the tier/session context threaded to the service
 *   - null → not_found_or_forbidden
 *   - SessionSearchError → its structured code, matched by name as well
 *     as instanceof (cross-bundle src/ vs dist/ imports)
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
  type SessionSearchToolServices,
} from "./session-search.js";
import type { AgentToolResult } from "./types.js";

// ── Fakes ────────────────────────────────────────────────────────────────

const CTX: SessionSearchToolContext = {
  agentId: "agent_a",
  hierarchyLevel: "team",
  sessionId: "sess_current",
};

function buildServices(
  search: SessionSearchService["search"] = vi.fn(async () => ({
    kind: "browse",
    sessions: [],
  })) as unknown as SessionSearchService["search"],
) {
  return {
    sessionSearch: { search } as unknown as SessionSearchService,
  } satisfies SessionSearchToolServices;
}

function call(
  input: Record<string, unknown>,
  services = buildServices(),
  ctx: SessionSearchToolContext = CTX,
): Promise<AgentToolResult> {
  return createSessionSearchTool(ctx, services).handler(input);
}

/** Run the tool and hand back the request the service actually received. */
async function requestFor(
  input: Record<string, unknown>,
): Promise<SessionSearchRequest> {
  const services = buildServices();
  await call(input, services);
  const firstCall = vi.mocked(services.sessionSearch.search).mock.calls[0];
  if (!firstCall) throw new Error("sessionSearch.search was never called");
  return firstCall[0];
}

// ── Surface ──────────────────────────────────────────────────────────────

describe("createSessionSearchTool — surface", () => {
  it("is named session_search with no required args (browse is the bare call)", () => {
    const tool = createSessionSearchTool(CTX, buildServices());
    expect(tool.name).toBe("session_search");
    expect(tool.schema.required).toBeUndefined();
  });

  it("documents all four calling shapes in the agent-facing description", () => {
    const { description } = createSessionSearchTool(CTX, buildServices());
    for (const shape of ["DISCOVERY", "SCROLL", "READ", "BROWSE"]) {
      expect(description).toContain(shape);
    }
  });
});

// ── Shape inference ──────────────────────────────────────────────────────

describe("inferRequest — browse", () => {
  it("infers browse from a bare call", async () => {
    expect(await requestFor({})).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("carries limit and filters into browse", async () => {
    expect(
      await requestFor({ limit: 7, filters: { status: "failed" } }),
    ).toEqual({
      kind: "browse",
      limit: 7,
      filters: { status: "failed" },
    });
  });
});

describe("inferRequest — discover", () => {
  it("infers discover from query alone", async () => {
    expect(await requestFor({ query: "auth refactor" })).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: undefined,
      sort: undefined,
      filters: undefined,
    });
  });

  it("trims the query", async () => {
    expect(await requestFor({ query: "  auth  " })).toMatchObject({
      kind: "discover",
      query: "auth",
    });
  });

  it.each(["newest", "oldest"] as const)("passes sort=%s through", async (sort) => {
    expect(await requestFor({ query: "x", sort })).toMatchObject({ sort });
  });

  it.each([
    ["an unknown value", "relevance"],
    ["a non-string", 1],
  ])("drops sort when it is %s", async (_label, sort) => {
    expect(await requestFor({ query: "x", sort })).toMatchObject({
      sort: undefined,
    });
  });

  it("drops a non-numeric limit", async () => {
    expect(await requestFor({ query: "x", limit: "3" })).toMatchObject({
      limit: undefined,
    });
  });
});

describe("inferRequest — read", () => {
  it("infers read from a bare session_id", async () => {
    expect(await requestFor({ session_id: "sess_1" })).toEqual({
      kind: "read",
      session_id: "sess_1",
    });
  });

  it("trims the session_id", async () => {
    expect(await requestFor({ session_id: " sess_1 " })).toEqual({
      kind: "read",
      session_id: "sess_1",
    });
  });

  // Documented precedence: a session_id outranks a query, because the
  // caller has already picked the conversation they want.
  it("wins over query when both are passed", async () => {
    expect(
      await requestFor({ session_id: "sess_1", query: "auth" }),
    ).toMatchObject({ kind: "read" });
  });
});

describe("inferRequest — scroll", () => {
  it("infers scroll from session_id + around_message_id", async () => {
    expect(
      await requestFor({ session_id: "sess_1", around_message_id: "evt_9" }),
    ).toEqual({
      kind: "scroll",
      session_id: "sess_1",
      around_message_id: "evt_9",
      window: undefined,
    });
  });

  it("trims both ids and carries the window", async () => {
    expect(
      await requestFor({
        session_id: " sess_1 ",
        around_message_id: " evt_9 ",
        window: 12,
      }),
    ).toEqual({
      kind: "scroll",
      session_id: "sess_1",
      around_message_id: "evt_9",
      window: 12,
    });
  });

  it("accepts the synthetic user-turn anchor id", async () => {
    expect(
      await requestFor({
        session_id: "sess_1",
        around_message_id: "intent:sess_1",
      }),
    ).toMatchObject({ kind: "scroll", around_message_id: "intent:sess_1" });
  });

  it("drops a non-numeric window rather than forwarding junk", async () => {
    expect(
      await requestFor({
        session_id: "sess_1",
        around_message_id: "evt_9",
        window: "10",
      }),
    ).toMatchObject({ window: undefined });
  });

  // Scroll is the most specific shape, so it outranks query too.
  it("wins over query", async () => {
    expect(
      await requestFor({
        session_id: "sess_1",
        around_message_id: "evt_9",
        query: "auth",
      }),
    ).toMatchObject({ kind: "scroll" });
  });

  it("degrades to read when the anchor is blank", async () => {
    expect(
      await requestFor({ session_id: "sess_1", around_message_id: "   " }),
    ).toEqual({ kind: "read", session_id: "sess_1" });
  });

  it("degrades to discover when the session_id is blank but a query is present", async () => {
    expect(
      await requestFor({
        session_id: "  ",
        around_message_id: "evt_9",
        query: "auth",
      }),
    ).toMatchObject({ kind: "discover", query: "auth" });
  });

  it("degrades to browse when everything is blank", async () => {
    expect(
      await requestFor({ session_id: "", around_message_id: "", query: "  " }),
    ).toMatchObject({ kind: "browse" });
  });
});

describe("inferRequest — filters", () => {
  it.each([
    ["null", null],
    ["a string", "status=failed"],
    ["a number", 1],
  ])("ignores filters passed as %s", async (_label, filters) => {
    expect(await requestFor({ query: "x", filters })).toMatchObject({
      filters: undefined,
    });
  });

  it("forwards a filters object verbatim", async () => {
    const filters = {
      session_type: "task",
      status: "failed",
      agent_id: "agent_b",
      task_id: "task_1",
      since: "2026-01-01T00:00:00Z",
      until: "2026-02-01T00:00:00Z",
    };
    expect(await requestFor({ query: "x", filters })).toMatchObject({
      filters,
    });
  });
});

// ── Caller context ───────────────────────────────────────────────────────

describe("session_search — caller context", () => {
  it("threads agent id, tier and current session to the service", async () => {
    const services = buildServices();
    await call({ query: "x" }, services, {
      agentId: "agent_z",
      hierarchyLevel: "org",
      sessionId: "sess_now",
    });
    expect(services.sessionSearch.search).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "discover" }),
      {
        callerAgentId: "agent_z",
        hierarchyLevel: "org",
        // Excluded from results so the agent never re-discovers
        // messages already in its context.
        currentSessionId: "sess_now",
      },
    );
  });
});

// ── Results and errors ───────────────────────────────────────────────────

describe("session_search — results", () => {
  it("returns the service result as the tool content", async () => {
    const result = { kind: "read", session_id: "sess_1", messages: [] };
    const services = buildServices(
      vi.fn(async () => result) as unknown as SessionSearchService["search"],
    );
    const res = await call({ session_id: "sess_1" }, services);
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual(result);
  });

  it("maps a null result to not_found_or_forbidden", async () => {
    const services = buildServices(
      vi.fn(async () => null) as unknown as SessionSearchService["search"],
    );
    const res = await call({ session_id: "sess_missing" }, services);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("not_found_or_forbidden");
    expect(res.content.message).toContain("not in your scope");
  });
});

describe("session_search — error envelope", () => {
  it.each([
    "forbidden_agent_filter",
    "missing_query",
    "missing_args",
  ] as const)("surfaces the %s code from a SessionSearchError", async (code) => {
    const services = buildServices(
      vi.fn(async () => {
        throw new SessionSearchError(code, `bad: ${code}`);
      }) as unknown as SessionSearchService["search"],
    );
    const res = await call({ query: "x" }, services);
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: code, message: `bad: ${code}` });
  });

  it("matches by error name too, so a cross-bundle import keeps its code", async () => {
    // An integration script importing core's src/ while the api runs
    // dist/ produces an error that fails `instanceof` but carries the
    // right `name` — the handler must still read its code.
    const foreign = Object.assign(new Error("out of scope"), {
      name: "SessionSearchError",
      code: "forbidden_agent_filter",
    });
    const services = buildServices(
      vi.fn(async () => {
        throw foreign;
      }) as unknown as SessionSearchService["search"],
    );
    const res = await call({ query: "x" }, services);
    expect(res.content).toEqual({
      error: "forbidden_agent_filter",
      message: "out of scope",
    });
  });

  it("falls back to internal_error for an unrelated Error", async () => {
    const services = buildServices(
      vi.fn(async () => {
        throw new Error("pg connection lost");
      }) as unknown as SessionSearchService["search"],
    );
    const res = await call({ query: "x" }, services);
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "internal_error",
      message: "pg connection lost",
    });
  });

  it("stringifies a non-Error throw", async () => {
    const services = buildServices(
      vi.fn(async () => {
        throw "boom";
      }) as unknown as SessionSearchService["search"],
    );
    const res = await call({ query: "x" }, services);
    expect(res.content).toEqual({ error: "internal_error", message: "boom" });
  });
});
