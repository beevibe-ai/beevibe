import { describe, expect, it, vi } from "vitest";
import type { SessionSearchRequest } from "@beevibe/core";
import { SESSION_STATUSES, SESSION_TYPES } from "@beevibe/core";
import {
  SessionSearchError,
  type SessionSearchService,
} from "@beevibe/core/services/session-search";
import {
  createSessionSearchTool,
  type SessionSearchToolContext,
} from "./session-search.js";

/**
 * The tool layer over SessionSearchService does two jobs, and they're
 * both easy to get wrong in ways a DB-backed test wouldn't catch:
 *
 *   1. **Shape inference.** Four calling shapes are inferred from which
 *      of query / session_id / around_message_id arrived, with a fixed
 *      precedence (scroll > read > discover > browse). The MCP wire is
 *      untyped, so blank strings and wrong types have to collapse to
 *      "absent" rather than produce a scroll on `""`.
 *   2. **Error translation.** A SessionSearchError keeps its structured
 *      code; a `null` return is the not-found/forbidden envelope; and
 *      anything else degrades to internal_error. The code is matched by
 *      `name` as well as `instanceof` so a cross-bundle import (src/ vs
 *      dist/) still surfaces the code — that fallback is asserted below.
 */

const CTX: SessionSearchToolContext = {
  agentId: "agent_caller",
  hierarchyLevel: "team",
  sessionId: "sess_current",
};

const RESULT = { kind: "browse", sessions: [] } as const;

function fakeService(
  opts: { returns?: unknown; throws?: unknown } = {},
): SessionSearchService & { search: ReturnType<typeof vi.fn> } {
  const search = vi.fn(async () => {
    if (opts.throws) throw opts.throws;
    return "returns" in opts ? opts.returns : RESULT;
  });
  return { search } as unknown as SessionSearchService & {
    search: ReturnType<typeof vi.fn>;
  };
}

function tool(svc: SessionSearchService, ctx: Partial<SessionSearchToolContext> = {}) {
  return createSessionSearchTool({ ...CTX, ...ctx }, { sessionSearch: svc });
}

/** Run the tool and hand back the request the service was called with. */
async function requestFor(input: Record<string, unknown>): Promise<SessionSearchRequest> {
  const svc = fakeService();
  await tool(svc).handler(input);
  return svc.search.mock.calls[0]![0] as SessionSearchRequest;
}

describe("session_search — caller context", () => {
  it("passes the caller triple through on every call", async () => {
    const svc = fakeService();
    await tool(svc).handler({ query: "auth refactor" });
    expect(svc.search.mock.calls[0]![1]).toEqual({
      callerAgentId: "agent_caller",
      hierarchyLevel: "team",
      currentSessionId: "sess_current",
    });
  });

  it("forwards the caller's own hierarchy level, not a default", async () => {
    const svc = fakeService();
    await tool(svc, { hierarchyLevel: "ic" }).handler({});
    expect(svc.search.mock.calls[0]![1]).toMatchObject({ hierarchyLevel: "ic" });
  });
});

describe("session_search — shape inference", () => {
  it("infers browse from no args", async () => {
    expect(await requestFor({})).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("infers discover from a query", async () => {
    expect(await requestFor({ query: "auth refactor" })).toMatchObject({
      kind: "discover",
      query: "auth refactor",
    });
  });

  it("infers read from a bare session_id", async () => {
    expect(await requestFor({ session_id: "sess_x" })).toEqual({
      kind: "read",
      session_id: "sess_x",
    });
  });

  it("infers scroll from session_id + around_message_id", async () => {
    expect(await requestFor({ session_id: "sess_x", around_message_id: "evt_1" })).toEqual(
      { kind: "scroll", session_id: "sess_x", around_message_id: "evt_1", window: undefined },
    );
  });

  it("lets scroll win over a query that's also present", async () => {
    // Documented precedence: scroll beats discover.
    expect(
      await requestFor({
        session_id: "sess_x",
        around_message_id: "evt_1",
        query: "ignored",
      }),
    ).toMatchObject({ kind: "scroll" });
  });

  it("lets read win over a query that's also present", async () => {
    expect(await requestFor({ session_id: "sess_x", query: "ignored" })).toMatchObject({
      kind: "read",
      session_id: "sess_x",
    });
  });

  it("treats an around_message_id with no session_id as discover, not scroll", async () => {
    expect(await requestFor({ around_message_id: "evt_1", query: "q" })).toMatchObject({
      kind: "discover",
    });
  });

  it("falls back to browse when around_message_id arrives alone", async () => {
    expect(await requestFor({ around_message_id: "evt_1" })).toMatchObject({
      kind: "browse",
    });
  });

  it("accepts the synthetic user-turn anchor id format", async () => {
    expect(
      await requestFor({ session_id: "sess_x", around_message_id: "intent:sess_x" }),
    ).toMatchObject({ kind: "scroll", around_message_id: "intent:sess_x" });
  });
});

describe("session_search — blank and mistyped args collapse to absent", () => {
  it("treats a whitespace-only query as browse", async () => {
    for (const query of ["", "   ", "\n\t"]) {
      expect(await requestFor({ query })).toMatchObject({ kind: "browse" });
    }
  });

  it("treats a whitespace-only session_id as absent", async () => {
    expect(await requestFor({ session_id: "  ", query: "q" })).toMatchObject({
      kind: "discover",
    });
  });

  it("treats a blank around_message_id as read, not scroll", async () => {
    expect(await requestFor({ session_id: "sess_x", around_message_id: "   " })).toEqual({
      kind: "read",
      session_id: "sess_x",
    });
  });

  it("ignores non-string query / session_id / anchor", async () => {
    expect(await requestFor({ query: 5, session_id: {}, around_message_id: [] })).toMatchObject(
      { kind: "browse" },
    );
  });

  it("trims surrounding whitespace off the values it does use", async () => {
    expect(
      await requestFor({ session_id: "  sess_x  ", around_message_id: "  evt_1  " }),
    ).toMatchObject({ session_id: "sess_x", around_message_id: "evt_1" });
    expect(await requestFor({ query: "  auth  " })).toMatchObject({ query: "auth" });
  });
});

describe("session_search — numeric and enum passthrough", () => {
  it("passes a numeric window on scroll and drops a non-numeric one", async () => {
    expect(
      await requestFor({ session_id: "s", around_message_id: "e", window: 10 }),
    ).toMatchObject({ window: 10 });
    expect(
      await requestFor({ session_id: "s", around_message_id: "e", window: "10" }),
    ).toMatchObject({ window: undefined });
  });

  it("passes a numeric limit on discover and browse", async () => {
    expect(await requestFor({ query: "q", limit: 7 })).toMatchObject({ limit: 7 });
    expect(await requestFor({ limit: 7 })).toMatchObject({ limit: 7 });
    expect(await requestFor({ query: "q", limit: "7" })).toMatchObject({ limit: undefined });
  });

  it("accepts only the two documented sort values", async () => {
    expect(await requestFor({ query: "q", sort: "newest" })).toMatchObject({ sort: "newest" });
    expect(await requestFor({ query: "q", sort: "oldest" })).toMatchObject({ sort: "oldest" });
    for (const sort of ["random", "", 1, null]) {
      expect(await requestFor({ query: "q", sort })).toMatchObject({ sort: undefined });
    }
  });

  it("forwards a filters object on discover and browse", async () => {
    const filters = { session_type: "task", status: "failed", agent_id: "agent_sub" };
    expect(await requestFor({ query: "q", filters })).toMatchObject({ filters });
    expect(await requestFor({ filters })).toMatchObject({ filters });
  });

  it("drops a non-object or null filters value", async () => {
    for (const filters of [null, "task", 5, undefined]) {
      expect(await requestFor({ query: "q", filters })).toMatchObject({
        filters: undefined,
      });
    }
  });

  it("does not attach filters to scroll or read requests", async () => {
    // Neither shape accepts them; leaking one through would be a silent
    // no-op at best and a scope confusion at worst.
    const scroll = await requestFor({
      session_id: "s",
      around_message_id: "e",
      filters: { status: "failed" },
    });
    expect(scroll).not.toHaveProperty("filters");
    const read = await requestFor({ session_id: "s", filters: { status: "failed" } });
    expect(read).not.toHaveProperty("filters");
  });
});

describe("session_search — results and errors", () => {
  it("returns the service result as the tool content", async () => {
    const payload = { kind: "discover", results: [{ session: { id: "sess_a" } }] };
    const result = await tool(fakeService({ returns: payload })).handler({ query: "q" });
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe(payload);
  });

  it("maps a null result to not_found_or_forbidden", async () => {
    const result = await tool(fakeService({ returns: null })).handler({
      session_id: "sess_not_mine",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "not_found_or_forbidden" });
    expect(String((result.content as { message: string }).message)).toMatch(/scope/);
  });

  it("preserves each structured SessionSearchError code", async () => {
    const codes = ["forbidden_agent_filter", "missing_query", "missing_args"] as const;
    for (const code of codes) {
      const svc = fakeService({ throws: new SessionSearchError(code, `boom: ${code}`) });
      const result = await tool(svc).handler({ query: "q" });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual({ error: code, message: `boom: ${code}` });
    }
  });

  it("recognizes a SessionSearchError by name across bundle boundaries", async () => {
    // api consumes @beevibe/core from dist/ while a script may consume
    // src/, so `instanceof` can fail on a structurally identical error.
    // The name check is what keeps the code from degrading to
    // internal_error in that case.
    class ForeignSessionSearchError extends Error {
      code = "missing_query";
      constructor(message: string) {
        super(message);
        this.name = "SessionSearchError";
      }
    }
    const svc = fakeService({ throws: new ForeignSessionSearchError("no query given") });
    const result = await tool(svc).handler({ query: "q" });
    expect(result.content).toEqual({ error: "missing_query", message: "no query given" });
  });

  it("degrades an unexpected Error to internal_error with its message", async () => {
    const svc = fakeService({ throws: new Error("pool exhausted") });
    const result = await tool(svc).handler({ query: "q" });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "internal_error",
      message: "pool exhausted",
    });
  });

  it("stringifies a non-Error throw", async () => {
    const svc = fakeService({ throws: "raw string failure" });
    const result = await tool(svc).handler({ query: "q" });
    expect(result.content).toEqual({
      error: "internal_error",
      message: "raw string failure",
    });
  });
});

describe("session_search — tool surface", () => {
  it("is named session_search and takes an object input", () => {
    const t = tool(fakeService());
    expect(t.name).toBe("session_search");
    expect(t.schema).toMatchObject({ type: "object" });
  });

  it("offers the domain's full session type and status enums as filters", () => {
    const props = (
      tool(fakeService()).schema as {
        properties: { filters: { properties: Record<string, { enum?: string[] }> } };
      }
    ).properties.filters.properties;
    expect(props.session_type!.enum).toEqual([...SESSION_TYPES]);
    expect(props.status!.enum).toEqual([...SESSION_STATUSES]);
  });

  it("documents all four calling shapes for the agent", () => {
    // The description is the agent-facing contract — a shape dropped
    // from it is a shape agents stop using.
    const d = tool(fakeService()).description;
    for (const shape of ["DISCOVERY", "SCROLL", "READ", "BROWSE"]) {
      expect(d).toContain(shape);
    }
  });
});
