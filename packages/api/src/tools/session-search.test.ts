/**
 * session_search handler tests.
 *
 * The interesting logic in this module is `inferRequest` — the four
 * calling shapes are inferred from which args are present, not from an
 * explicit discriminator, so the precedence between them is the
 * contract. The rest is the null/throw envelope around
 * SessionSearchService.
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
  agentId: "agent_lead",
  hierarchyLevel: "team",
  sessionId: "ses_now",
};

function fakeService(
  overrides: { result?: unknown; throws?: unknown } = {},
) {
  const calls: Array<{ req: SessionSearchRequest; scope: unknown }> = [];
  const sessionSearch = {
    search: vi.fn(async (req: SessionSearchRequest, scope: unknown) => {
      if (overrides.throws) throw overrides.throws;
      calls.push({ req, scope });
      return overrides.result === undefined ? { results: [] } : overrides.result;
    }),
  } as unknown as SessionSearchService;
  return { sessionSearch, calls };
}

function tool(
  sessionSearch: SessionSearchService,
  ctx: SessionSearchToolContext = CTX,
) {
  return createSessionSearchTool(ctx, { sessionSearch });
}

/** Run the handler and return the request the service was handed. */
async function inferred(
  input: Record<string, unknown>,
): Promise<SessionSearchRequest> {
  const { sessionSearch, calls } = fakeService();
  await tool(sessionSearch).handler(input);
  return calls[0]!.req;
}

describe("session_search shape inference", () => {
  it("browses when called with no args", async () => {
    expect(await inferred({})).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("discovers when given a query", async () => {
    expect(await inferred({ query: "auth refactor", limit: 7 })).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: 7,
      sort: undefined,
      filters: undefined,
    });
  });

  it("reads when given a bare session_id", async () => {
    expect(await inferred({ session_id: "ses_old" })).toEqual({
      kind: "read",
      session_id: "ses_old",
    });
  });

  it("scrolls when given session_id + around_message_id", async () => {
    expect(
      await inferred({
        session_id: "ses_old",
        around_message_id: "evt_42",
        window: 10,
      }),
    ).toEqual({
      kind: "scroll",
      session_id: "ses_old",
      around_message_id: "evt_42",
      window: 10,
    });
  });

  // Documented precedence: scroll beats read beats discover beats browse.
  it("prefers scroll over discover when a query is also present", async () => {
    const req = await inferred({
      query: "auth refactor",
      session_id: "ses_old",
      around_message_id: "evt_42",
    });
    expect(req.kind).toBe("scroll");
  });

  it("prefers read over discover when a query is also present", async () => {
    const req = await inferred({ query: "auth refactor", session_id: "ses_old" });
    expect(req).toEqual({ kind: "read", session_id: "ses_old" });
  });

  it("falls back to discover when the anchor is present but session_id is not", async () => {
    const req = await inferred({ query: "auth", around_message_id: "evt_42" });
    expect(req.kind).toBe("discover");
  });

  it("falls back to browse when only an anchor is given", async () => {
    expect((await inferred({ around_message_id: "evt_42" })).kind).toBe("browse");
  });

  it("trims the string args and treats whitespace-only as absent", async () => {
    expect(
      await inferred({
        session_id: "  ses_old  ",
        around_message_id: "  evt_42  ",
      }),
    ).toMatchObject({ session_id: "ses_old", around_message_id: "evt_42" });

    expect(await inferred({ query: "  spaced out  " })).toMatchObject({
      query: "spaced out",
    });

    // All blank → browse, not an empty-query discovery.
    expect(
      (await inferred({ query: "   ", session_id: "  ", around_message_id: " " }))
        .kind,
    ).toBe("browse");
  });

  it("ignores non-string ids and queries", async () => {
    expect((await inferred({ session_id: 7, query: 9 })).kind).toBe("browse");
  });

  it("drops a non-numeric limit and window instead of coercing", async () => {
    expect(await inferred({ query: "x", limit: "3" })).toMatchObject({
      limit: undefined,
    });
    expect(
      await inferred({
        session_id: "ses_old",
        around_message_id: "evt_1",
        window: "10",
      }),
    ).toMatchObject({ window: undefined });
  });

  it.each([
    ["newest", "newest"],
    ["oldest", "oldest"],
  ])("passes sort=%s through on discovery", async (_label, sort) => {
    expect(await inferred({ query: "x", sort })).toMatchObject({ sort });
  });

  it("drops an unrecognized sort", async () => {
    expect(await inferred({ query: "x", sort: "relevance" })).toMatchObject({
      sort: undefined,
    });
  });

  it.each([
    ["discover", { query: "x" }],
    ["browse", {}],
  ])("forwards filters on the %s shape", async (_label, base) => {
    const filters = { session_type: "task", status: "failed" };
    expect(await inferred({ ...base, filters })).toMatchObject({ filters });
  });

  it.each([
    ["null", null],
    ["a non-object", "task"],
  ])("treats %s filters as absent", async (_label, filters) => {
    expect(await inferred({ query: "x", filters })).toMatchObject({
      filters: undefined,
    });
  });
});

describe("session_search scope", () => {
  it("resolves scope from the caller context, not from input", async () => {
    const { sessionSearch, calls } = fakeService();
    await tool(sessionSearch).handler({ query: "x", agent_id: "agent_other" });

    expect(calls[0]?.scope).toEqual({
      callerAgentId: "agent_lead",
      hierarchyLevel: "team",
      currentSessionId: "ses_now",
    });
  });

  it.each(["ic", "team", "org"] as const)(
    "passes the %s tier through verbatim",
    async (hierarchyLevel) => {
      const { sessionSearch, calls } = fakeService();
      await tool(sessionSearch, { ...CTX, hierarchyLevel }).handler({});
      expect(calls[0]?.scope).toMatchObject({ hierarchyLevel });
    },
  );
});

describe("session_search result envelope", () => {
  it("returns the service payload as the tool content", async () => {
    const payload = { kind: "read", messages: [{ id: "evt_1" }] };
    const { sessionSearch } = fakeService({ result: payload });
    const result = await tool(sessionSearch).handler({ session_id: "ses_old" });

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe(payload);
  });

  // null is the service's "out of scope / no such anchor" signal; the
  // tool has to turn it into an error the agent can read, not an empty
  // success.
  it("maps a null result onto not_found_or_forbidden", async () => {
    const { sessionSearch } = fakeService({ result: null });
    const result = await tool(sessionSearch).handler({ session_id: "ses_other" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "not_found_or_forbidden" });
    expect(result.content.message).toContain("scope");
  });
});

describe("session_search error mapping", () => {
  it.each([
    "forbidden_agent_filter",
    "missing_query",
    "missing_args",
  ] as const)("surfaces the %s code from SessionSearchError", async (code) => {
    const { sessionSearch } = fakeService({
      throws: new SessionSearchError(code, `bad: ${code}`),
    });
    const result = await tool(sessionSearch).handler({ query: "x" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: code, message: `bad: ${code}` });
  });

  // Cross-bundle imports (src/ vs dist/) break instanceof, so the
  // handler also matches on err.name — that fallback is the point.
  it("matches a structurally-identical error by name across bundles", async () => {
    class ForeignSessionSearchError extends Error {
      code = "missing_query";
      constructor() {
        super("query required");
        this.name = "SessionSearchError";
      }
    }
    const { sessionSearch } = fakeService({
      throws: new ForeignSessionSearchError(),
    });
    const result = await tool(sessionSearch).handler({ query: "x" });

    expect(result.content).toEqual({
      error: "missing_query",
      message: "query required",
    });
  });

  it("degrades an unrelated Error to internal_error", async () => {
    const { sessionSearch } = fakeService({ throws: new Error("pool closed") });
    const result = await tool(sessionSearch).handler({ query: "x" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "internal_error",
      message: "pool closed",
    });
  });

  it("stringifies a non-Error throw", async () => {
    const { sessionSearch } = fakeService({ throws: "pg died" });
    const result = await tool(sessionSearch).handler({});
    expect(result.content).toEqual({
      error: "internal_error",
      message: "pg died",
    });
  });
});

describe("session_search tool surface", () => {
  it("requires no args, so every shape including browse is reachable", () => {
    const { sessionSearch } = fakeService();
    const t = tool(sessionSearch);
    expect(t.name).toBe("session_search");
    expect((t.schema as { required?: string[] }).required).toBeUndefined();
  });

  it("documents all four calling shapes in the agent-facing description", () => {
    const { sessionSearch } = fakeService();
    const { description } = tool(sessionSearch);
    for (const shape of ["DISCOVERY", "SCROLL", "READ", "BROWSE"]) {
      expect(description).toContain(shape);
    }
  });
});
