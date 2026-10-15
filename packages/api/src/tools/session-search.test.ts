import { describe, expect, it, vi } from "vitest";
import type {
  SessionSearchRequest,
  SessionSearchResult,
} from "@beevibe/core";
import {
  SessionSearchError,
  type SessionSearchContext,
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

interface Harness {
  handler: (input: Record<string, unknown>) => ReturnType<
    ReturnType<typeof createSessionSearchTool>["handler"]
  >;
  calls: Array<{ req: SessionSearchRequest; ctx: SessionSearchContext }>;
}

function harness(
  opts: {
    ctx?: Partial<SessionSearchToolContext>;
    result?: SessionSearchResult | null;
    throws?: unknown;
  } = {},
): Harness {
  const calls: Array<{ req: SessionSearchRequest; ctx: SessionSearchContext }> = [];
  const sessionSearch = {
    search: vi.fn(async (req: SessionSearchRequest, ctx: SessionSearchContext) => {
      if (opts.throws !== undefined) throw opts.throws;
      calls.push({ req, ctx });
      return "result" in opts
        ? opts.result
        : ({ kind: req.kind, hits: [] } as unknown as SessionSearchResult);
    }),
  } as unknown as SessionSearchService;

  const tool = createSessionSearchTool(
    { ...CTX, ...opts.ctx },
    { sessionSearch },
  );
  return { handler: tool.handler, calls };
}

/** The request the tool inferred from one raw tool input. */
async function requestFor(
  input: Record<string, unknown>,
): Promise<SessionSearchRequest> {
  const h = harness();
  await h.handler(input);
  const req = h.calls[0]?.req;
  if (!req) throw new Error("search was never called");
  return req;
}

describe("session_search descriptor", () => {
  it("names the tool and exposes every documented input", () => {
    const tool = createSessionSearchTool(CTX, {
      sessionSearch: {} as unknown as SessionSearchService,
    });
    const props = (tool.schema as { properties: Record<string, unknown> }).properties;

    expect(tool.name).toBe("session_search");
    expect(Object.keys(props).sort()).toEqual([
      "around_message_id",
      "filters",
      "limit",
      "query",
      "session_id",
      "sort",
      "window",
    ]);
  });

  it("documents all four calling shapes for the agent", () => {
    const tool = createSessionSearchTool(CTX, {
      sessionSearch: {} as unknown as SessionSearchService,
    });

    for (const shape of ["DISCOVERY", "SCROLL", "READ", "BROWSE"]) {
      expect(tool.description).toContain(shape);
    }
  });
});

describe("shape inference", () => {
  it("infers browse from no arguments at all", async () => {
    expect(await requestFor({})).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("infers discover from a query", async () => {
    expect(await requestFor({ query: "auth refactor", limit: 7, sort: "newest" })).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: 7,
      sort: "newest",
      filters: undefined,
    });
  });

  it("infers read from a bare session_id", async () => {
    expect(await requestFor({ session_id: "sess_past" })).toEqual({
      kind: "read",
      session_id: "sess_past",
    });
  });

  it("infers scroll from session_id plus around_message_id", async () => {
    expect(
      await requestFor({
        session_id: "sess_past",
        around_message_id: "evt_9",
        window: 10,
      }),
    ).toEqual({
      kind: "scroll",
      session_id: "sess_past",
      around_message_id: "evt_9",
      window: 10,
    });
  });

  it("prefers scroll over discover when a query is also passed", async () => {
    const req = await requestFor({
      query: "ignored",
      session_id: "sess_past",
      around_message_id: "evt_9",
    });

    expect(req.kind).toBe("scroll");
  });

  it("prefers read over discover when a query is also passed", async () => {
    const req = await requestFor({ query: "ignored", session_id: "sess_past" });

    expect(req).toEqual({ kind: "read", session_id: "sess_past" });
  });

  it("trims the string inputs it infers from", async () => {
    expect(
      await requestFor({ session_id: "  sess_past  ", around_message_id: "  evt_9  " }),
    ).toEqual({
      kind: "scroll",
      session_id: "sess_past",
      around_message_id: "evt_9",
      window: undefined,
    });
    expect(await requestFor({ query: "  auth  " })).toMatchObject({
      kind: "discover",
      query: "auth",
    });
  });

  it.each([
    ["blank", "   "],
    ["non-string", 7],
  ])("treats a %s session_id as absent and browses instead", async (_l, sessionId) => {
    expect(await requestFor({ session_id: sessionId })).toMatchObject({
      kind: "browse",
    });
  });

  it("falls back to read when around_message_id is blank", async () => {
    expect(
      await requestFor({ session_id: "sess_past", around_message_id: "  " }),
    ).toEqual({ kind: "read", session_id: "sess_past" });
  });

  it.each([
    ["blank", "   "],
    ["non-string", 7],
  ])("treats a %s query as absent and browses instead", async (_l, query) => {
    expect(await requestFor({ query })).toMatchObject({ kind: "browse" });
  });

  it("drops a non-numeric limit, window and an unknown sort", async () => {
    expect(await requestFor({ query: "x", limit: "3", sort: "relevance" })).toMatchObject({
      limit: undefined,
      sort: undefined,
    });
    expect(
      await requestFor({ session_id: "s", around_message_id: "e", window: "10" }),
    ).toMatchObject({ window: undefined });
  });

  it.each(["newest", "oldest"] as const)("passes sort=%s through", async (sort) => {
    expect(await requestFor({ query: "x", sort })).toMatchObject({ sort });
  });

  it("forwards filters on the discover and browse shapes", async () => {
    const filters = { session_type: "task", status: "failed", agent_id: "agent_sub" };

    expect(await requestFor({ query: "x", filters })).toMatchObject({ filters });
    expect(await requestFor({ filters })).toMatchObject({ kind: "browse", filters });
  });

  it.each([
    ["null", null],
    ["a scalar", "task"],
    ["absent", undefined],
  ])("drops filters that are %s", async (_l, filters) => {
    expect(await requestFor(filters === undefined ? {} : { filters })).toMatchObject({
      filters: undefined,
    });
  });
});

describe("caller context", () => {
  it("threads the caller agent, tier and current session into the service", async () => {
    const h = harness({ ctx: { hierarchyLevel: "org" } });
    await h.handler({ query: "x" });

    expect(h.calls[0]?.ctx).toEqual({
      callerAgentId: "agent_caller",
      hierarchyLevel: "org",
      currentSessionId: "sess_current",
    });
  });

  it("returns the service result verbatim", async () => {
    const result = { kind: "read", messages: [{ id: "evt_1" }] } as unknown as SessionSearchResult;
    const h = harness({ result });
    const out = await h.handler({ session_id: "sess_past" });

    expect(out.isError).toBeFalsy();
    expect(out.content).toBe(result);
  });
});

describe("error mapping", () => {
  it("turns a null result into not_found_or_forbidden", async () => {
    const h = harness({ result: null });
    const out = await h.handler({ session_id: "sess_other" });

    expect(out.isError).toBe(true);
    expect(out.content).toMatchObject({ error: "not_found_or_forbidden" });
    expect(out.content.message).toContain("not in your scope");
  });

  it.each([
    ["missing_query", "query is required for discovery"],
    ["missing_args", "read requires session_id"],
    ["forbidden_agent_filter", "agent_id is outside your scope"],
  ] as const)("surfaces the %s code from SessionSearchError", async (code, message) => {
    const h = harness({ throws: new SessionSearchError(code, message) });
    const out = await h.handler({ query: "x" });

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({ error: code, message });
  });

  it("matches a cross-bundle SessionSearchError by name, not just instanceof", async () => {
    // An integration script consuming core's src/ while api consumes dist/
    // throws a structurally identical error from a different class object.
    const foreign = Object.assign(new Error("query is required for discovery"), {
      name: "SessionSearchError",
      code: "missing_query",
    });
    const h = harness({ throws: foreign });
    const out = await h.handler({ query: "x" });

    expect(out.content).toEqual({
      error: "missing_query",
      message: "query is required for discovery",
    });
  });

  it("envelopes an unexpected Error as internal_error", async () => {
    const h = harness({ throws: new Error("connection terminated") });
    const out = await h.handler({ query: "x" });

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({
      error: "internal_error",
      message: "connection terminated",
    });
  });

  it("stringifies a non-Error throw", async () => {
    const h = harness({ throws: "pg exploded" });
    const out = await h.handler({ query: "x" });

    expect(out.content).toEqual({ error: "internal_error", message: "pg exploded" });
  });

  it("does not swallow an Error whose name merely looks similar", async () => {
    const h = harness({
      throws: Object.assign(new Error("nope"), { name: "SessionSearchFailure" }),
    });
    const out = await h.handler({ query: "x" });

    expect(out.content).toEqual({ error: "internal_error", message: "nope" });
  });
});
