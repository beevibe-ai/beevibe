/**
 * session_search — unit tests with a fake SessionSearchService (no DB).
 *
 * All the retrieval work lives in the service and its Postgres FTS
 * repo. What this module owns is `inferRequest`: turning a loose
 * `Record<string, unknown>` from an MCP client into one of four typed
 * request shapes. The precedence between them is the interesting part
 * — `session_id` + `around_message_id` beats bare `session_id` beats
 * `query` beats nothing — because an agent that passes both a query
 * and a session_id gets the read, and silently ignoring the query is
 * the documented behaviour the description promises.
 *
 * The error path matters too: the handler matches SessionSearchError by
 * `name` as well as `instanceof`, so a cross-bundle import (a script
 * consuming src/ while api consumes dist/) still yields the structured
 * code instead of degrading to internal_error. That's pinned below
 * with a same-shape error that is deliberately not an instance.
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
  agentId: "agent_caller",
  hierarchyLevel: "team",
  sessionId: "sess_current",
};

const EXPECTED_CTX = {
  callerAgentId: CTX.agentId,
  hierarchyLevel: CTX.hierarchyLevel,
  currentSessionId: CTX.sessionId,
};

function fakeService(
  impl?: SessionSearchService["search"],
): SessionSearchService {
  return {
    search: vi.fn(impl ?? (async () => ({ kind: "browse", sessions: [] }))),
  } as unknown as SessionSearchService;
}

function tool(service: SessionSearchService, ctx = CTX) {
  return createSessionSearchTool(ctx, { sessionSearch: service });
}

/** Runs the handler and returns the request the service was handed. */
async function requestFor(
  input: Record<string, unknown>,
): Promise<SessionSearchRequest> {
  const service = fakeService();
  await tool(service).handler(input);
  return vi.mocked(service.search).mock.calls[0]![0];
}

// ── Shape ────────────────────────────────────────────────────────────────

describe("createSessionSearchTool", () => {
  it("exposes the session_search contract with no required params", () => {
    const t = tool(fakeService());

    expect(t.name).toBe("session_search");
    // Every param is optional — the no-arg call is the browse shape.
    expect(t.schema.required).toBeUndefined();
    expect(Object.keys(t.schema.properties as object)).toEqual([
      "query",
      "limit",
      "sort",
      "session_id",
      "around_message_id",
      "window",
      "filters",
    ]);
  });

  it("documents the four calling shapes in its description", () => {
    const t = tool(fakeService());
    for (const shape of ["DISCOVERY", "SCROLL", "READ", "BROWSE"]) {
      expect(t.description).toContain(shape);
    }
  });

  it("always passes the caller's tier context to the service", async () => {
    const service = fakeService();
    await tool(service).handler({});

    expect(service.search).toHaveBeenCalledWith(
      expect.anything(),
      EXPECTED_CTX,
    );
  });
});

// ── Shape inference ──────────────────────────────────────────────────────

describe("session_search shape inference", () => {
  it("infers browse from no arguments", async () => {
    expect(await requestFor({})).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("infers discover from a query", async () => {
    expect(await requestFor({ query: "auth refactor" })).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: undefined,
      sort: undefined,
      filters: undefined,
    });
  });

  it("infers read from a bare session_id", async () => {
    expect(await requestFor({ session_id: "sess_1" })).toEqual({
      kind: "read",
      session_id: "sess_1",
    });
  });

  it("infers scroll from session_id + around_message_id", async () => {
    expect(
      await requestFor({
        session_id: "sess_1",
        around_message_id: "evt_9",
        window: 10,
      }),
    ).toEqual({
      kind: "scroll",
      session_id: "sess_1",
      around_message_id: "evt_9",
      window: 10,
    });
  });

  it("prefers scroll over read when both ids are present", async () => {
    const req = await requestFor({
      session_id: "sess_1",
      around_message_id: "evt_9",
    });
    expect(req.kind).toBe("scroll");
  });

  it("prefers read over discover, ignoring the query", async () => {
    // Documented: "Ignored when session_id + around_message_id are set",
    // and a bare session_id likewise wins — the query is dropped.
    const req = await requestFor({ session_id: "sess_1", query: "anything" });
    expect(req).toEqual({ kind: "read", session_id: "sess_1" });
  });

  it("prefers scroll over discover", async () => {
    const req = await requestFor({
      session_id: "sess_1",
      around_message_id: "evt_9",
      query: "anything",
    });
    expect(req.kind).toBe("scroll");
  });

  it("treats an around_message_id with no session_id as browse", async () => {
    // The anchor alone can't identify a conversation, so it is not
    // enough to make a scroll — it falls through.
    const req = await requestFor({ around_message_id: "evt_9" });
    expect(req.kind).toBe("browse");
  });

  it("accepts the synthetic user-turn anchor id format", async () => {
    const req = await requestFor({
      session_id: "sess_1",
      around_message_id: "intent:sess_1",
    });
    expect(req).toMatchObject({
      kind: "scroll",
      around_message_id: "intent:sess_1",
    });
  });
});

// ── Coercion of loose input ──────────────────────────────────────────────

describe("session_search input coercion", () => {
  it("trims the query, session_id and anchor", async () => {
    expect(
      await requestFor({
        session_id: "  sess_1  ",
        around_message_id: "  evt_9  ",
      }),
    ).toMatchObject({ session_id: "sess_1", around_message_id: "evt_9" });

    expect(await requestFor({ query: "  auth  " })).toMatchObject({
      query: "auth",
    });
  });

  it.each([
    ["whitespace only", "   "],
    ["empty", ""],
    ["a non-string", 42],
    ["null", null],
  ])("falls back to browse when query is %s", async (_label, query) => {
    const req = await requestFor({ query });
    expect(req.kind).toBe("browse");
  });

  it.each([
    ["whitespace only", "   "],
    ["empty", ""],
    ["a non-string", 42],
  ])("ignores a session_id that is %s", async (_label, sessionId) => {
    const req = await requestFor({ session_id: sessionId, query: "auth" });
    // The unusable session_id doesn't shadow the query.
    expect(req.kind).toBe("discover");
  });

  it("ignores a blank anchor, degrading scroll to read", async () => {
    const req = await requestFor({
      session_id: "sess_1",
      around_message_id: "   ",
    });
    expect(req).toEqual({ kind: "read", session_id: "sess_1" });
  });

  it.each([
    ["a string", "10"],
    ["null", null],
  ])("drops a window that is %s, leaving the service default", async (
    _label,
    window,
  ) => {
    const req = await requestFor({
      session_id: "sess_1",
      around_message_id: "evt_9",
      window,
    });
    expect(req).toMatchObject({ window: undefined });
  });

  it("passes window and limit through without clamping", async () => {
    // Clamping is the service's job ([1,20] for window, max 10 for
    // limit); the tool must not silently pre-clamp and mask it.
    expect(
      await requestFor({
        session_id: "s",
        around_message_id: "e",
        window: 999,
      }),
    ).toMatchObject({ window: 999 });

    expect(await requestFor({ query: "q", limit: 999 })).toMatchObject({
      limit: 999,
    });
  });

  it.each([
    ["a string", "3"],
    ["null", null],
  ])("drops a limit that is %s", async (_label, limit) => {
    expect(await requestFor({ query: "q", limit })).toMatchObject({
      limit: undefined,
    });
    expect(await requestFor({ limit })).toMatchObject({ limit: undefined });
  });

  it.each([["newest"], ["oldest"]])("accepts sort=%s on discover", async (
    sort,
  ) => {
    expect(await requestFor({ query: "q", sort })).toMatchObject({ sort });
  });

  it.each([
    ["an unknown value", "relevance"],
    ["a non-string", 1],
  ])("drops sort when it is %s", async (_label, sort) => {
    expect(await requestFor({ query: "q", sort })).toMatchObject({
      sort: undefined,
    });
  });

  it("forwards filters on discover and browse", async () => {
    const filters = { status: "failed", session_type: "task" };

    expect(await requestFor({ query: "q", filters })).toMatchObject({
      filters,
    });
    expect(await requestFor({ filters })).toMatchObject({ filters });
  });

  it.each([
    ["null", null],
    ["a string", "status=failed"],
  ])("drops filters that are %s", async (_label, filters) => {
    expect(await requestFor({ filters })).toMatchObject({ filters: undefined });
  });

  it("does not forward filters on the read or scroll shapes", async () => {
    // Those shapes are addressed by id; a filter would be meaningless
    // and the typed request has no slot for it.
    expect(
      await requestFor({ session_id: "s", filters: { status: "failed" } }),
    ).toEqual({ kind: "read", session_id: "s" });

    expect(
      await requestFor({
        session_id: "s",
        around_message_id: "e",
        filters: { status: "failed" },
      }),
    ).not.toHaveProperty("filters");
  });
});

// ── Results and errors ───────────────────────────────────────────────────

describe("session_search results", () => {
  it("returns the service result verbatim", async () => {
    const result = { kind: "read", messages: [{ id: "evt_1" }] };
    const service = fakeService(async () => result as never);

    const res = await tool(service).handler({ session_id: "sess_1" });

    expect(res.content).toBe(result);
    expect(res.isError).toBeUndefined();
  });

  it("maps a null result to not_found_or_forbidden", async () => {
    // null is the service's single answer for "out of scope, missing
    // anchor, or your own active conversation" — deliberately not
    // distinguished, so the tool must not guess which.
    const service = fakeService(async () => null);

    const res = await tool(service).handler({ session_id: "sess_other" });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("not_found_or_forbidden");
    expect(res.content.message).toMatch(/not in your scope/);
  });
});

describe("session_search error mapping", () => {
  it.each([
    ["forbidden_agent_filter"],
    ["missing_query"],
    ["missing_args"],
  ] as const)("surfaces the %s code from a SessionSearchError", async (code) => {
    const service = fakeService(async () => {
      throw new SessionSearchError(code, `failed: ${code}`);
    });

    const res = await tool(service).handler({ query: "q" });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: code, message: `failed: ${code}` });
  });

  it("matches a cross-bundle SessionSearchError by name", async () => {
    // Same shape, different module instance: `instanceof` is false, so
    // only the name check keeps the structured code.
    class Impostor extends Error {
      code = "missing_query";
      constructor(message: string) {
        super(message);
        this.name = "SessionSearchError";
      }
    }
    const err = new Impostor("query required");
    expect(err instanceof SessionSearchError).toBe(false);

    const service = fakeService(async () => {
      throw err;
    });

    const res = await tool(service).handler({});

    expect(res.content).toEqual({
      error: "missing_query",
      message: "query required",
    });
  });

  it("degrades an unrelated Error to internal_error", async () => {
    const service = fakeService(async () => {
      throw new Error("pg connection lost");
    });

    const res = await tool(service).handler({ query: "q" });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "internal_error",
      message: "pg connection lost",
    });
  });

  it("stringifies a non-Error throw", async () => {
    const service = fakeService(async () => {
      throw "went sideways";
    });

    const res = await tool(service).handler({ query: "q" });

    expect(res.content).toEqual({
      error: "internal_error",
      message: "went sideways",
    });
  });
});
