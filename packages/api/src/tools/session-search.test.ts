/**
 * session_search tool tests.
 *
 * The tool's own job is shape inference: four very different calling
 * shapes (discover / scroll / read / browse) are squeezed into one flat
 * argument object, and `inferRequest` decides which one the agent meant.
 * Getting that wrong silently answers a different question than the one
 * asked, so the precedence rules are pinned here one by one.
 *
 * The FTS query itself needs Postgres and is covered by the repo
 * integration suite; a fake SessionSearchService stands in for it.
 */
import { describe, expect, it, vi } from "vitest";
import type { HierarchyLevel, SessionSearchRequest } from "@beevibe/core";
import {
  SessionSearchError,
  type SessionSearchService,
} from "@beevibe/core/services/session-search";
import {
  createSessionSearchTool,
  type SessionSearchToolContext,
} from "./session-search.js";

function harness(opts: { result?: unknown; throws?: unknown } = {}) {
  const requests: SessionSearchRequest[] = [];
  const contexts: Record<string, unknown>[] = [];
  const sessionSearch = {
    search: vi.fn(async (req: SessionSearchRequest, ctx: Record<string, unknown>) => {
      requests.push(req);
      contexts.push(ctx);
      if (opts.throws) throw opts.throws;
      return opts.result === undefined ? { kind: "browse", sessions: [] } : opts.result;
    }),
  } as unknown as SessionSearchService;
  return { sessionSearch, requests, contexts };
}

const CTX: SessionSearchToolContext = {
  agentId: "agent_me",
  hierarchyLevel: "team",
  sessionId: "sess_current",
};

function tool(h: ReturnType<typeof harness>, ctx: SessionSearchToolContext = CTX) {
  return createSessionSearchTool(ctx, { sessionSearch: h.sessionSearch });
}

/**
 * The one request the fake saw, widened to a plain record: the assertions
 * below read fields (`limit`, `sort`, `filters`) that only exist on some
 * arms of the SessionSearchRequest union, and proving which arm was
 * inferred is the point of these tests.
 */
async function requestFor(
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const h = harness();
  await tool(h).handler(input);
  return h.requests[0]! as unknown as Record<string, unknown>;
}

describe("session_search tool surface", () => {
  it("is named session_search and takes no required arguments", () => {
    const t = tool(harness());
    expect(t.name).toBe("session_search");
    // Browse is the no-arg shape, so nothing may be required.
    expect(t.schema.required).toBeUndefined();
  });

  it("documents all four calling shapes in the description", () => {
    const { description } = tool(harness());
    for (const shape of ["DISCOVERY", "SCROLL", "READ", "BROWSE"]) {
      expect(description).toContain(shape);
    }
  });

  it("exposes the filter and sort surface the description promises", () => {
    const props = tool(harness()).schema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.sort?.enum).toEqual(["newest", "oldest"]);
    const filters = props.filters?.properties as Record<string, unknown>;
    expect(Object.keys(filters).sort()).toEqual([
      "agent_id",
      "session_type",
      "since",
      "status",
      "task_id",
      "until",
    ]);
  });
});

describe("shape inference", () => {
  it("infers browse from no arguments", async () => {
    expect(await requestFor({})).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("infers discover from a query", async () => {
    const req = await requestFor({ query: "auth refactor" });
    expect(req).toMatchObject({ kind: "discover", query: "auth refactor" });
  });

  it("infers read from a bare session_id", async () => {
    expect(await requestFor({ session_id: "sess_old" })).toEqual({
      kind: "read",
      session_id: "sess_old",
    });
  });

  it("infers scroll from session_id plus around_message_id", async () => {
    expect(
      await requestFor({ session_id: "sess_old", around_message_id: "evt_7" }),
    ).toEqual({
      kind: "scroll",
      session_id: "sess_old",
      around_message_id: "evt_7",
      window: undefined,
    });
  });

  // Precedence, in the order inferRequest checks it.
  it("prefers scroll over discover when a query is also present", async () => {
    const req = await requestFor({
      query: "ignored",
      session_id: "sess_old",
      around_message_id: "evt_7",
    });
    expect(req.kind).toBe("scroll");
    expect(req).not.toHaveProperty("query");
  });

  it("prefers read over discover when a query is also present", async () => {
    const req = await requestFor({ query: "ignored", session_id: "sess_old" });
    expect(req.kind).toBe("read");
  });

  it("falls back to discover when around_message_id arrives without a session_id", async () => {
    const req = await requestFor({ query: "topic", around_message_id: "evt_7" });
    expect(req.kind).toBe("discover");
  });

  it("falls back to browse when around_message_id is the only argument", async () => {
    expect((await requestFor({ around_message_id: "evt_7" })).kind).toBe("browse");
  });

  it("accepts the synthetic user-turn anchor id format", async () => {
    const req = await requestFor({
      session_id: "sess_old",
      around_message_id: "intent:sess_old",
    });
    expect(req).toMatchObject({ kind: "scroll", around_message_id: "intent:sess_old" });
  });
});

describe("argument coercion", () => {
  it("trims session_id, around_message_id and query", async () => {
    expect(await requestFor({ query: "  spaced out  " })).toMatchObject({
      query: "spaced out",
    });
    expect(
      await requestFor({ session_id: "  sess_x  ", around_message_id: "  evt_1  " }),
    ).toMatchObject({ session_id: "sess_x", around_message_id: "evt_1" });
  });

  it.each([
    ["whitespace-only", "   "],
    ["empty", ""],
    ["a number", 5],
    ["null", null],
  ])("ignores a %s query and browses instead", async (_label, query) => {
    expect((await requestFor({ query })).kind).toBe("browse");
  });

  it.each([
    ["whitespace-only", "   "],
    ["a number", 5],
  ])("ignores a %s session_id", async (_label, sessionId) => {
    expect((await requestFor({ session_id: sessionId })).kind).toBe("browse");
  });

  it("passes a numeric limit through on discover and browse", async () => {
    expect(await requestFor({ query: "x", limit: 7 })).toMatchObject({ limit: 7 });
    expect(await requestFor({ limit: 2 })).toMatchObject({ limit: 2 });
  });

  it.each(["3", null, true])("drops a non-numeric limit (%p)", async (limit) => {
    expect((await requestFor({ query: "x", limit })).limit).toBeUndefined();
  });

  it("passes a numeric window through on scroll", async () => {
    const req = await requestFor({
      session_id: "sess_x",
      around_message_id: "evt_1",
      window: 12,
    });
    expect(req).toMatchObject({ window: 12 });
  });

  it("drops a non-numeric window and lets the service default it", async () => {
    const req = await requestFor({
      session_id: "sess_x",
      around_message_id: "evt_1",
      window: "12",
    });
    expect(req).toMatchObject({ window: undefined });
  });

  it.each(["newest", "oldest"] as const)("passes sort=%s through on discover", async (sort) => {
    expect(await requestFor({ query: "x", sort })).toMatchObject({ sort });
  });

  it.each(["relevance", "", 1, null])(
    "drops an unrecognized sort (%p) for relevance-only ranking",
    async (sort) => {
      expect((await requestFor({ query: "x", sort })).sort).toBeUndefined();
    },
  );

  it("forwards a filters object on discover and browse", async () => {
    const filters = { status: "failed", session_type: "task" };
    expect(await requestFor({ query: "x", filters })).toMatchObject({ filters });
    expect(await requestFor({ filters })).toMatchObject({ filters });
  });

  it.each([["null", null], ["a string", "status=failed"], ["a number", 1]])(
    "drops filters passed as %s",
    async (_label, filters) => {
      expect((await requestFor({ query: "x", filters })).filters).toBeUndefined();
    },
  );

  it("does not forward filters on the scroll or read shapes", async () => {
    const filters = { status: "failed" };
    expect(await requestFor({ session_id: "sess_x", filters })).not.toHaveProperty(
      "filters",
    );
    expect(
      await requestFor({ session_id: "sess_x", around_message_id: "e", filters }),
    ).not.toHaveProperty("filters");
  });
});

describe("caller scope", () => {
  it("passes the caller's agent id, tier and active session to the service", async () => {
    const h = harness();
    await tool(h).handler({ query: "x" });
    expect(h.contexts[0]).toEqual({
      callerAgentId: "agent_me",
      hierarchyLevel: "team",
      currentSessionId: "sess_current",
    });
  });

  it.each(["ic", "team", "org"] as HierarchyLevel[])(
    "forwards hierarchyLevel=%s unchanged — scope resolution is the service's job",
    async (level) => {
      const h = harness();
      await tool(h, { ...CTX, hierarchyLevel: level }).handler({});
      expect(h.contexts[0]?.hierarchyLevel).toBe(level);
    },
  );
});

describe("result and error projection", () => {
  it("returns the service result verbatim", async () => {
    const result = { kind: "read", session_id: "sess_old", messages: [{ id: "evt_1" }] };
    const h = harness({ result });
    const res = await tool(h).handler({ session_id: "sess_old" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe(result);
  });

  it("turns a null result into not_found_or_forbidden", async () => {
    const h = harness({ result: null });
    const res = await tool(h).handler({ session_id: "sess_other" });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("not_found_or_forbidden");
    expect(String(res.content.message)).toContain("not in your scope");
  });

  it.each(["forbidden_agent_filter", "missing_query", "missing_args"] as const)(
    "surfaces the %s code from a SessionSearchError",
    async (code) => {
      const h = harness({ throws: new SessionSearchError(code, `nope: ${code}`) });
      const res = await tool(h).handler({ query: "x" });
      expect(res.isError).toBe(true);
      expect(res.content).toEqual({ error: code, message: `nope: ${code}` });
    },
  );

  it("matches SessionSearchError by name too, for cross-bundle src/dist imports", async () => {
    // An error from a second copy of @beevibe/core fails instanceof but
    // still carries the name and code, so the structured envelope has to
    // survive. Without the name check the agent would see internal_error.
    const impostor = Object.assign(new Error("scope violation"), {
      name: "SessionSearchError",
      code: "forbidden_agent_filter",
    });
    const h = harness({ throws: impostor });
    const res = await tool(h).handler({ query: "x" });
    expect(res.content).toEqual({
      error: "forbidden_agent_filter",
      message: "scope violation",
    });
  });

  it("degrades an unexpected Error to internal_error", async () => {
    const h = harness({ throws: new Error("connection terminated") });
    const res = await tool(h).handler({ query: "x" });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "internal_error",
      message: "connection terminated",
    });
  });

  it("stringifies a non-Error throw", async () => {
    const h = harness({ throws: { pgCode: "57014" } });
    const res = await tool(h).handler({ query: "x" });
    expect(res.content.error).toBe("internal_error");
    expect(typeof res.content.message).toBe("string");
  });
});
