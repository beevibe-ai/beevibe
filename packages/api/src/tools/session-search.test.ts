/**
 * session_search — unit tests with vitest fakes (no DB).
 *
 * The service owns scope resolution and the FTS queries (DB-backed suite
 * of its own). The tool's job is shape inference: four very different
 * calling shapes arrive as one flat bag of optional MCP arguments, and
 * which shape wins is decided here. These tests pin that precedence
 * (scroll > read > discover > browse), the coercion around it, and the
 * error envelopes.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  HierarchyLevel,
  SessionSearchRequest,
  SessionSearchResult,
} from "@beevibe/core";
import {
  SessionSearchError,
  SessionSearchService,
} from "@beevibe/core/services/session-search";
import {
  createSessionSearchTool,
  type SessionSearchToolContext,
} from "./session-search.js";
import type { AgentToolResult } from "./types.js";

const AGENT_ID = "agent_caller";
const SESSION_ID = "sess_current";

const EMPTY_RESULT = { kind: "browse", sessions: [] } as unknown as SessionSearchResult;

function fakeService(
  impl: SessionSearchService["search"] = vi.fn(async () => EMPTY_RESULT),
): SessionSearchService {
  return { search: impl } as unknown as SessionSearchService;
}

function build(
  sessionSearch: SessionSearchService,
  ctx: Partial<SessionSearchToolContext> = {},
) {
  return createSessionSearchTool(
    {
      agentId: AGENT_ID,
      hierarchyLevel: "team" as HierarchyLevel,
      sessionId: SESSION_ID,
      ...ctx,
    },
    { sessionSearch },
  );
}

/** Run the handler and hand back the request the service actually saw. */
async function requestFor(
  input: Record<string, unknown>,
): Promise<SessionSearchRequest> {
  const search = vi.fn(
    async (req: SessionSearchRequest) => (void req, EMPTY_RESULT),
  );
  await build(fakeService(search)).handler(input);
  return search.mock.calls[0]![0];
}

function call(
  input: Record<string, unknown>,
  search?: SessionSearchService["search"],
): Promise<AgentToolResult> {
  return build(fakeService(search)).handler(input);
}

describe("session_search — shape inference", () => {
  it("browses when called with no arguments", async () => {
    expect(await requestFor({})).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("discovers when given a query", async () => {
    expect(await requestFor({ query: "auth refactor", limit: 5 })).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: 5,
      sort: undefined,
      filters: undefined,
    });
  });

  it("reads when given a bare session_id", async () => {
    expect(await requestFor({ session_id: "sess_past" })).toEqual({
      kind: "read",
      session_id: "sess_past",
    });
  });

  it("scrolls when given a session_id and an anchor", async () => {
    expect(
      await requestFor({
        session_id: "sess_past",
        around_message_id: "evt_7",
        window: 10,
      }),
    ).toEqual({
      kind: "scroll",
      session_id: "sess_past",
      around_message_id: "evt_7",
      window: 10,
    });
  });

  // Precedence matters because an agent scrolling a discovery hit will
  // often pass the original query back alongside the anchor.
  it("prefers scroll over the query when both are supplied", async () => {
    const req = await requestFor({
      query: "auth refactor",
      session_id: "sess_past",
      around_message_id: "evt_7",
    });
    expect(req.kind).toBe("scroll");
  });

  it("prefers read over the query when a bare session_id is supplied", async () => {
    const req = await requestFor({ query: "auth refactor", session_id: "sess_past" });
    expect(req.kind).toBe("read");
  });

  // A dangling anchor with no session is not a scroll; it falls back to
  // whatever the rest of the input says.
  it("ignores an anchor with no session_id", async () => {
    expect((await requestFor({ around_message_id: "evt_7" })).kind).toBe("browse");
    expect(
      (await requestFor({ around_message_id: "evt_7", query: "auth" })).kind,
    ).toBe("discover");
  });

  it("accepts the synthetic user-turn anchor format", async () => {
    const req = await requestFor({
      session_id: "sess_past",
      around_message_id: "intent:sess_past",
    });
    expect(req).toMatchObject({ kind: "scroll", around_message_id: "intent:sess_past" });
  });
});

describe("session_search — input coercion", () => {
  it("trims the query, session_id and anchor", async () => {
    expect(
      await requestFor({ session_id: "  sess_past  ", around_message_id: "  evt_7  " }),
    ).toMatchObject({ session_id: "sess_past", around_message_id: "evt_7" });

    expect(await requestFor({ query: "  auth refactor  " })).toMatchObject({
      query: "auth refactor",
    });
  });

  it.each([
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["a non-string", 42],
  ])("treats %s query as absent and browses instead", async (_label, query) => {
    expect((await requestFor({ query })).kind).toBe("browse");
  });

  it.each([
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["a non-string", 42],
  ])("treats %s session_id as absent and browses instead", async (_label, sessionId) => {
    expect((await requestFor({ session_id: sessionId })).kind).toBe("browse");
  });

  // Clamping lives in the service; the tool just refuses to invent a
  // number from a non-numeric argument.
  it("drops a non-numeric limit and window rather than coercing them", async () => {
    expect(await requestFor({ limit: "5" })).toMatchObject({ limit: undefined });
    expect(
      await requestFor({
        session_id: "sess_past",
        around_message_id: "evt_7",
        window: "10",
      }),
    ).toMatchObject({ window: undefined });
  });

  it("passes 'newest' and 'oldest' sort through and drops anything else", async () => {
    expect(await requestFor({ query: "x", sort: "newest" })).toMatchObject({
      sort: "newest",
    });
    expect(await requestFor({ query: "x", sort: "oldest" })).toMatchObject({
      sort: "oldest",
    });
    expect(await requestFor({ query: "x", sort: "relevance" })).toMatchObject({
      sort: undefined,
    });
  });

  it("forwards a filters object on discovery and browse", async () => {
    const filters = { session_type: "task", status: "failed" };
    expect(await requestFor({ query: "x", filters })).toMatchObject({ filters });
    expect(await requestFor({ filters })).toMatchObject({ filters });
  });

  it("drops filters that aren't an object", async () => {
    expect(await requestFor({ query: "x", filters: "failed" })).toMatchObject({
      filters: undefined,
    });
    expect(await requestFor({ query: "x", filters: null })).toMatchObject({
      filters: undefined,
    });
  });
});

describe("session_search — caller context", () => {
  it("passes the caller's agent id, tier and active session to the service", async () => {
    const search = vi.fn(async () => EMPTY_RESULT);
    await build(fakeService(search), { hierarchyLevel: "org" }).handler({ query: "x" });

    expect(search).toHaveBeenCalledWith(expect.anything(), {
      callerAgentId: AGENT_ID,
      hierarchyLevel: "org",
      // The active conversation is excluded so the agent can't
      // re-discover messages already in its context.
      currentSessionId: SESSION_ID,
    });
  });

  it("returns the service result verbatim", async () => {
    const result = { kind: "read", messages: [{ id: "evt_1" }] } as unknown as SessionSearchResult;
    const res = await call({ session_id: "sess_past" }, vi.fn(async () => result));

    expect(res.isError).toBeUndefined();
    expect(res.content).toBe(result);
  });
});

describe("session_search — failures", () => {
  it("maps a null result onto not_found_or_forbidden", async () => {
    const res = await call({ session_id: "sess_other" }, vi.fn(async () => null));

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("not_found_or_forbidden");
  });

  it.each(["forbidden_agent_filter", "missing_query", "missing_args"] as const)(
    "surfaces the %s service error code",
    async (code) => {
      const res = await call(
        { query: "x" },
        vi.fn(async () => {
          throw new SessionSearchError(code, `${code} detail`);
        }),
      );

      expect(res.isError).toBe(true);
      expect(res.content).toEqual({ error: code, message: `${code} detail` });
    },
  );

  // An integration script consuming core's src/ while the api consumes
  // dist/ gets a structurally identical but non-identical class, so the
  // handler matches on `name` too.
  it("matches a cross-bundle SessionSearchError by name", async () => {
    const impostor = Object.assign(new Error("scroll requires both"), {
      name: "SessionSearchError",
      code: "missing_args",
    });
    const res = await call(
      { query: "x" },
      vi.fn(async () => {
        throw impostor;
      }),
    );

    expect(res.content).toEqual({ error: "missing_args", message: "scroll requires both" });
  });

  it("wraps an unexpected throw as internal_error", async () => {
    const res = await call(
      { query: "x" },
      vi.fn(async () => {
        throw new Error("pool exhausted");
      }),
    );

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: "internal_error", message: "pool exhausted" });
  });

  it("stringifies a non-Error throw", async () => {
    const res = await call({ query: "x" }, vi.fn(async () => Promise.reject("boom")));

    expect(res.content).toEqual({ error: "internal_error", message: "boom" });
  });
});

describe("session_search — tool surface", () => {
  it("has no required arguments, since the bare call is the browse shape", () => {
    const tool = build(fakeService());
    expect(tool.name).toBe("session_search");
    expect(tool.schema.required).toBeUndefined();
  });

  it("documents all four calling shapes in the agent-facing description", () => {
    const { description } = build(fakeService());
    for (const shape of ["DISCOVERY", "SCROLL", "READ", "BROWSE"]) {
      expect(description).toContain(shape);
    }
  });
});
