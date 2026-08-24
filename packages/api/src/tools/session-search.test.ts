/**
 * session_search tool tests.
 *
 * The tool's own logic is shape inference — turning a flat bag of MCP
 * args into one of four typed SessionSearchRequests — plus the caller
 * context it stamps on every call and the error envelope it returns.
 * The service is faked; scope resolution and FTS are its concern and are
 * covered by the DB-backed suites.
 *
 * Shape precedence is the subtle part: scroll beats read beats discover
 * beats browse, so an agent that passes session_id AND query gets the
 * session it named rather than a fresh search.
 */
import { describe, expect, it, vi } from "vitest";
import type { SessionSearchRequest } from "@beevibe/core";
import {
  SessionSearchError,
  type SessionSearchService,
} from "@beevibe/core/services/session-search";
import { createSessionSearchTool, type SessionSearchToolContext } from "./session-search.js";

interface Harness {
  services: { sessionSearch: SessionSearchService };
  calls: Array<{ req: SessionSearchRequest; ctx: Record<string, unknown> }>;
}

function harness(overrides: { throws?: unknown; result?: unknown } = {}): Harness {
  const calls: Harness["calls"] = [];
  const sessionSearch = {
    search: vi.fn(async (req: SessionSearchRequest, ctx: Record<string, unknown>) => {
      if (overrides.throws) throw overrides.throws;
      calls.push({ req, ctx });
      return overrides.result === undefined ? { results: [] } : overrides.result;
    }),
  } as unknown as SessionSearchService;
  return { services: { sessionSearch }, calls };
}

const CTX: SessionSearchToolContext = {
  agentId: "agent_a",
  hierarchyLevel: "team",
  sessionId: "sess_current",
};

function build(h: Harness, ctx: SessionSearchToolContext = CTX) {
  return createSessionSearchTool(ctx, h.services);
}

/** Run the handler and return the request the service was handed. */
async function requestFor(input: Record<string, unknown>): Promise<SessionSearchRequest> {
  const h = harness();
  await build(h).handler(input);
  return h.calls[0]!.req;
}

describe("session_search descriptor", () => {
  it("has no required args — the browse shape takes none", () => {
    const tool = build(harness());
    expect(tool.name).toBe("session_search");
    expect(tool.schema.required).toBeUndefined();
  });

  it("advertises every calling shape's arg in the schema", () => {
    const tool = build(harness());
    const props = tool.schema.properties as Record<string, unknown>;

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
});

describe("caller context", () => {
  it("stamps agent id, tier and current session on every call", async () => {
    const h = harness();
    await build(h).handler({});

    expect(h.calls[0]?.ctx).toEqual({
      callerAgentId: "agent_a",
      hierarchyLevel: "team",
      currentSessionId: "sess_current",
    });
  });

  it("passes the caller's own tier through unchanged", async () => {
    const h = harness();
    await build(h, { ...CTX, hierarchyLevel: "ic" }).handler({});

    expect(h.calls[0]?.ctx).toMatchObject({ hierarchyLevel: "ic" });
  });
});

describe("shape inference — scroll", () => {
  it("infers scroll from session_id + around_message_id", async () => {
    expect(
      await requestFor({
        session_id: "sess_9",
        around_message_id: "evt_3",
        window: 10,
      }),
    ).toEqual({
      kind: "scroll",
      session_id: "sess_9",
      around_message_id: "evt_3",
      window: 10,
    });
  });

  it("leaves window undefined so the service applies its own default", async () => {
    const req = await requestFor({
      session_id: "sess_9",
      around_message_id: "evt_3",
    });

    expect(req).toMatchObject({ kind: "scroll", window: undefined });
  });

  it("ignores a non-numeric window", async () => {
    const req = await requestFor({
      session_id: "sess_9",
      around_message_id: "evt_3",
      window: "10",
    });

    expect(req).toMatchObject({ window: undefined });
  });

  it("trims both ids", async () => {
    expect(
      await requestFor({
        session_id: "  sess_9  ",
        around_message_id: "  evt_3  ",
      }),
    ).toMatchObject({ session_id: "sess_9", around_message_id: "evt_3" });
  });

  it("carries a synthetic user-turn anchor id through untouched", async () => {
    expect(
      await requestFor({
        session_id: "sess_9",
        around_message_id: "intent:sess_9",
      }),
    ).toMatchObject({ around_message_id: "intent:sess_9" });
  });

  // scroll > read: an anchor means the agent wants the window, not the dump.
  it("beats read when both a session id and an anchor are present", async () => {
    expect(await requestFor({ session_id: "sess_9", around_message_id: "evt_3" })).toMatchObject({
      kind: "scroll",
    });
  });
});

describe("shape inference — read", () => {
  it("infers read from a bare session_id", async () => {
    expect(await requestFor({ session_id: "sess_9" })).toEqual({
      kind: "read",
      session_id: "sess_9",
    });
  });

  it("falls back to read when around_message_id is blank", async () => {
    expect(await requestFor({ session_id: "sess_9", around_message_id: "   " })).toMatchObject({
      kind: "read",
    });
  });

  // read > discover: a named session wins over a keyword search.
  it("beats discover when both session_id and query are present", async () => {
    expect(await requestFor({ session_id: "sess_9", query: "auth refactor" })).toEqual({
      kind: "read",
      session_id: "sess_9",
    });
  });
});

describe("shape inference — discover", () => {
  it("infers discover from a query and carries limit, sort and filters", async () => {
    expect(
      await requestFor({
        query: "  auth refactor  ",
        limit: 5,
        sort: "newest",
        filters: { status: "failed" },
      }),
    ).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: 5,
      sort: "newest",
      filters: { status: "failed" },
    });
  });

  it("accepts the 'oldest' sort", async () => {
    expect(await requestFor({ query: "x", sort: "oldest" })).toMatchObject({ sort: "oldest" });
  });

  it("drops an unrecognized sort rather than passing it down", async () => {
    expect(await requestFor({ query: "x", sort: "relevance" })).toMatchObject({ sort: undefined });
  });

  it("ignores a non-numeric limit", async () => {
    expect(await requestFor({ query: "x", limit: "5" })).toMatchObject({
      limit: undefined,
    });
  });
});

describe("shape inference — browse", () => {
  it("infers browse from no args at all", async () => {
    expect(await requestFor({})).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("carries limit and filters into browse", async () => {
    expect(await requestFor({ limit: 5, filters: { session_type: "chat" } })).toEqual({
      kind: "browse",
      limit: 5,
      filters: { session_type: "chat" },
    });
  });

  it.each([
    ["a blank query", { query: "   " }],
    ["a non-string query", { query: 42 }],
    ["a blank session id", { session_id: "  " }],
    ["an anchor with no session id", { around_message_id: "evt_3" }],
  ])("falls back to browse for %s", async (_label, input) => {
    expect(await requestFor(input)).toMatchObject({ kind: "browse" });
  });
});

describe("filters normalization", () => {
  it.each([
    ["null", null],
    ["a non-object", "status:failed"],
    ["omitted", undefined],
  ])("drops filters that are %s", async (_label, filters) => {
    expect(await requestFor({ query: "x", filters })).toMatchObject({
      filters: undefined,
    });
  });

  it("passes an arbitrary filter object through for the service to validate", async () => {
    const filters = {
      session_type: "task",
      status: "failed",
      agent_id: "agent_b",
      task_id: "task_1",
      since: "2026-01-01T00:00:00Z",
      until: "2026-02-01T00:00:00Z",
    };

    expect(await requestFor({ query: "x", filters })).toMatchObject({ filters });
  });
});

describe("results and errors", () => {
  it("returns the service result verbatim as tool content", async () => {
    const result = { results: [{ session: { id: "sess_1" } }], total: 1 };
    const h = harness({ result });
    const out = await build(h).handler({ query: "x" });

    expect(out.isError).toBeFalsy();
    expect(out.content).toBe(result);
  });

  // null is the service's "you can't see this" answer — it deliberately
  // does not distinguish missing from forbidden, so neither does the tool.
  it("maps a null result onto not_found_or_forbidden", async () => {
    const h = harness({ result: null });
    const out = await build(h).handler({ session_id: "sess_other" });

    expect(out.isError).toBe(true);
    expect(out.content).toMatchObject({ error: "not_found_or_forbidden" });
  });

  it.each(["forbidden_agent_filter", "missing_query", "missing_args"] as const)(
    "surfaces the %s code from a SessionSearchError",
    async (code) => {
      const h = harness({ throws: new SessionSearchError(code, `bad: ${code}`) });
      const out = await build(h).handler({ query: "x" });

      expect(out.isError).toBe(true);
      expect(out.content).toEqual({ error: code, message: `bad: ${code}` });
    },
  );

  // api consumes @beevibe/core's dist while some scripts consume src, so
  // the same error class can arrive as a different constructor. Matching
  // on `name` keeps the structured code from degrading to internal_error.
  it("recognizes a cross-bundle SessionSearchError by name, not just instanceof", async () => {
    const impostor = new Error("scope violation");
    impostor.name = "SessionSearchError";
    (impostor as unknown as { code: string }).code = "forbidden_agent_filter";

    const h = harness({ throws: impostor });
    const out = await build(h).handler({ query: "x" });

    expect(out.content).toEqual({
      error: "forbidden_agent_filter",
      message: "scope violation",
    });
  });

  it("wraps an unrelated Error as internal_error", async () => {
    const h = harness({ throws: new Error("connection reset") });
    const out = await build(h).handler({ query: "x" });

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({
      error: "internal_error",
      message: "connection reset",
    });
  });

  it("stringifies a non-Error throw", async () => {
    const h = harness({ throws: "boom" });
    const out = await build(h).handler({ query: "x" });

    expect(out.content).toEqual({ error: "internal_error", message: "boom" });
  });
});
