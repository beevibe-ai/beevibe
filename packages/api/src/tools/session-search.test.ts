/**
 * session_search unit tests.
 *
 * The tool's real work is `inferRequest` — a four-way shape inference
 * (scroll / read / discover / browse) driven purely by which arguments
 * the agent happened to pass. Pick the wrong shape and the agent gets a
 * whole transcript when it asked for a five-message window, or an FTS
 * query when it asked to scroll. That inference had no test file; the
 * SessionSearchService behind it is integration-tested separately, so
 * it's faked here.
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
  agentId: "agent_a",
  hierarchyLevel: "team",
  sessionId: "ses_current",
};

function fakeService(impl?: () => unknown) {
  // Parameters are declared (rather than `async () => …`) so `mock.calls`
  // stays a two-element tuple and the assertions below type-check.
  const search = vi.fn(
    async (_req: SessionSearchRequest, _ctx: SessionSearchToolContext) =>
      impl ? impl() : { kind: "ok" },
  );
  return { sessionSearch: { search } as unknown as SessionSearchService, search };
}

/** Run the tool and hand back the request the service was called with. */
async function requestFor(input: Record<string, unknown>): Promise<SessionSearchRequest> {
  const f = fakeService();
  await createSessionSearchTool(CTX, { sessionSearch: f.sessionSearch }).handler(input);
  return f.search.mock.calls[0]?.[0] as unknown as SessionSearchRequest;
}

describe("session_search — shape inference", () => {
  it("infers browse from no arguments", async () => {
    expect(await requestFor({})).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("carries limit and filters into a browse", async () => {
    const filters = { status: "failed" };
    expect(await requestFor({ limit: 10, filters })).toEqual({
      kind: "browse",
      limit: 10,
      filters,
    });
  });

  it("infers discover from a query", async () => {
    expect(await requestFor({ query: "auth refactor", limit: 5, sort: "newest" })).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: 5,
      sort: "newest",
      filters: undefined,
    });
  });

  it("infers read from a bare session_id", async () => {
    expect(await requestFor({ session_id: "ses_7" })).toEqual({
      kind: "read",
      session_id: "ses_7",
    });
  });

  it("infers scroll from session_id + around_message_id", async () => {
    expect(
      await requestFor({ session_id: "ses_7", around_message_id: "evt_3", window: 10 }),
    ).toEqual({
      kind: "scroll",
      session_id: "ses_7",
      around_message_id: "evt_3",
      window: 10,
    });
  });

  // Scroll is the most specific shape, so it wins: an agent that pastes
  // back a whole discovery hit (query included) still gets its window.
  it("prefers scroll over read and discover when all three are present", async () => {
    const req = await requestFor({
      query: "auth refactor",
      session_id: "ses_7",
      around_message_id: "evt_3",
    });
    expect(req.kind).toBe("scroll");
  });

  it("prefers read over discover when session_id and query are both present", async () => {
    const req = await requestFor({ query: "auth refactor", session_id: "ses_7" });
    expect(req).toEqual({ kind: "read", session_id: "ses_7" });
  });

  it("trims whitespace off session_id, around_message_id and query", async () => {
    expect(await requestFor({ session_id: "  ses_7  ", around_message_id: " evt_3 " })).toEqual(
      { kind: "scroll", session_id: "ses_7", around_message_id: "evt_3", window: undefined },
    );
    expect(await requestFor({ query: "  auth  " })).toMatchObject({ query: "auth" });
  });

  // A blank string is what an agent sends when it templated an empty
  // variable; treating it as "present" would infer read on a nonexistent
  // session instead of browsing.
  it("treats blank and non-string arguments as absent", async () => {
    expect((await requestFor({ session_id: "   ", query: "   " })).kind).toBe("browse");
    expect((await requestFor({ session_id: 7, query: null })).kind).toBe("browse");
    // A blank anchor demotes scroll to read rather than scrolling nowhere.
    expect(await requestFor({ session_id: "ses_7", around_message_id: "  " })).toEqual({
      kind: "read",
      session_id: "ses_7",
    });
  });

  it("drops a non-numeric limit or window rather than forwarding it", async () => {
    expect(await requestFor({ query: "x", limit: "5" })).toMatchObject({ limit: undefined });
    expect(
      await requestFor({ session_id: "s", around_message_id: "m", window: "10" }),
    ).toMatchObject({ window: undefined });
  });

  it("only accepts 'newest' and 'oldest' for sort", async () => {
    expect(await requestFor({ query: "x", sort: "oldest" })).toMatchObject({ sort: "oldest" });
    for (const sort of ["relevance", "", 1, undefined]) {
      expect(await requestFor({ query: "x", sort })).toMatchObject({ sort: undefined });
    }
  });

  it("passes filters through on discover and browse", async () => {
    const filters = { session_type: "task", status: "failed" };
    expect(await requestFor({ query: "x", filters })).toMatchObject({ filters });
    expect(await requestFor({ filters })).toMatchObject({ filters });
  });

  it("ignores a null or non-object filters value", async () => {
    expect(await requestFor({ query: "x", filters: null })).toMatchObject({
      filters: undefined,
    });
    expect(await requestFor({ query: "x", filters: "task" })).toMatchObject({
      filters: undefined,
    });
  });
});

describe("session_search — context threading", () => {
  it("passes the caller's agent id, tier and current session to the service", async () => {
    const f = fakeService();
    await createSessionSearchTool(CTX, { sessionSearch: f.sessionSearch }).handler({});
    expect(f.search.mock.calls[0]?.[1]).toEqual({
      callerAgentId: "agent_a",
      hierarchyLevel: "team",
      currentSessionId: "ses_current",
    });
  });

  it("forwards the tier verbatim — scope resolution is the service's job", async () => {
    for (const hierarchyLevel of ["ic", "team", "org"] as const) {
      const f = fakeService();
      await createSessionSearchTool(
        { ...CTX, hierarchyLevel },
        { sessionSearch: f.sessionSearch },
      ).handler({ query: "x" });
      expect(f.search.mock.calls[0]?.[1]).toMatchObject({ hierarchyLevel });
    }
  });

  it("returns the service result verbatim on success", async () => {
    const payload = { results: [{ session: { id: "ses_1" } }] };
    const f = fakeService(() => payload);
    const result = await createSessionSearchTool(CTX, {
      sessionSearch: f.sessionSearch,
    }).handler({ query: "x" });
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe(payload);
  });
});

describe("session_search — error envelopes", () => {
  // null is the service's "out of scope / no such anchor" signal. It has
  // to become an isError result, not an empty success the agent reads as
  // "there was nothing there".
  it("turns a null result into not_found_or_forbidden", async () => {
    const f = fakeService(() => null);
    const result = await createSessionSearchTool(CTX, {
      sessionSearch: f.sessionSearch,
    }).handler({ session_id: "ses_other" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "not_found_or_forbidden" });
  });

  it("surfaces a SessionSearchError's code", async () => {
    const f = fakeService(() => {
      throw new SessionSearchError("forbidden_agent_filter", "agent_b is out of your scope");
    });
    const result = await createSessionSearchTool(CTX, {
      sessionSearch: f.sessionSearch,
    }).handler({ query: "x", filters: { agent_id: "agent_b" } });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "forbidden_agent_filter",
      message: "agent_b is out of your scope",
    });
  });

  // The handler matches on `err.name` as well as instanceof, so that a
  // cross-bundle throw (src/ vs dist/ copies of the class) still yields
  // the structured code instead of collapsing to internal_error.
  it("matches a same-named error from another bundle by name", async () => {
    const f = fakeService(() => {
      const err = new Error("missing query") as Error & { code: string };
      err.name = "SessionSearchError";
      err.code = "missing_query";
      throw err;
    });
    const result = await createSessionSearchTool(CTX, {
      sessionSearch: f.sessionSearch,
    }).handler({ query: "x" });
    expect(result.content).toEqual({ error: "missing_query", message: "missing query" });
  });

  it("wraps anything else as internal_error", async () => {
    const f = fakeService(() => {
      throw new Error("pg connection lost");
    });
    const result = await createSessionSearchTool(CTX, {
      sessionSearch: f.sessionSearch,
    }).handler({});
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "internal_error",
      message: "pg connection lost",
    });
  });

  it("stringifies a non-Error throw", async () => {
    const f = fakeService(() => {
      throw "kaboom";
    });
    const result = await createSessionSearchTool(CTX, {
      sessionSearch: f.sessionSearch,
    }).handler({});
    expect(result.content).toEqual({ error: "internal_error", message: "kaboom" });
  });
});

describe("session_search — advertised schema", () => {
  it("names the tool session_search and offers all four shapes' arguments", () => {
    const tool = createSessionSearchTool(CTX, fakeService().sessionSearch as never);
    expect(tool.name).toBe("session_search");
    expect(Object.keys(tool.schema.properties as object).sort()).toEqual([
      "around_message_id",
      "filters",
      "limit",
      "query",
      "session_id",
      "sort",
      "window",
    ]);
  });

  // Browse is the no-argument shape, so nothing may be required — a
  // `required` list here would make `session_search()` uncallable.
  it("requires no arguments, so the browse shape stays reachable", () => {
    const tool = createSessionSearchTool(CTX, fakeService().sessionSearch as never);
    expect(tool.schema.required).toBeUndefined();
  });
});
