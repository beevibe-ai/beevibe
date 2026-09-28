/**
 * session_search MCP tool — unit tests with a fake SessionSearchService.
 *
 * All four calling shapes are inferred from loose MCP input, and getting
 * the inference wrong is silent: a scroll that degrades to a read dumps
 * a whole transcript into the agent's context instead of a ±5 window.
 * These tests pin the precedence order (scroll > read > discover >
 * browse), the coercion of each optional field, and the three distinct
 * error envelopes — including the cross-bundle `err.name` fallback that
 * exists because api consumes core's dist/ while scripts consume src/.
 */
import { describe, expect, it, vi } from "vitest";
import type { SessionSearchRequest, SessionSearchResult } from "@beevibe/core";
import {
  SessionSearchError,
  type SessionSearchService,
} from "@beevibe/core/services/session-search";
import {
  createSessionSearchTool,
  type SessionSearchToolContext,
} from "./session-search.js";

const AGENT_ID = "agent_caller";
const SESSION_ID = "sess_current";

const RESULT = { kind: "browse", sessions: [] } as unknown as SessionSearchResult;

interface HarnessOpts {
  ctx?: Partial<SessionSearchToolContext>;
  result?: SessionSearchResult | null;
  throws?: unknown;
}

function harness(opts: HarnessOpts = {}) {
  const sessionSearch = {
    search: vi.fn(async () => {
      if (opts.throws !== undefined) throw opts.throws;
      return "result" in opts ? opts.result : RESULT;
    }),
  } as unknown as SessionSearchService;

  const tool = createSessionSearchTool(
    {
      agentId: AGENT_ID,
      hierarchyLevel: "team",
      sessionId: SESSION_ID,
      ...opts.ctx,
    },
    { sessionSearch },
  );
  /** The request the handler inferred from the last call. */
  const lastRequest = (): SessionSearchRequest =>
    vi.mocked(sessionSearch.search).mock.calls.at(-1)![0]!;
  return { tool, sessionSearch, lastRequest };
}

describe("createSessionSearchTool", () => {
  it("names the tool and keeps every field optional (browse is the no-arg shape)", () => {
    const { tool } = harness();
    expect(tool.name).toBe("session_search");
    expect(tool.schema.required).toBeUndefined();
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

  it("passes the caller's tier and active session through as the search context", async () => {
    const { tool, sessionSearch } = harness({ ctx: { hierarchyLevel: "org" } });
    await tool.handler({});
    expect(sessionSearch.search).toHaveBeenCalledWith(expect.anything(), {
      callerAgentId: AGENT_ID,
      hierarchyLevel: "org",
      currentSessionId: SESSION_ID,
    });
  });
});

describe("shape inference", () => {
  it("scrolls when session_id and around_message_id are both present", async () => {
    const { tool, lastRequest } = harness();
    await tool.handler({
      session_id: "sess_old",
      around_message_id: "evt_1",
      window: 10,
    });
    expect(lastRequest()).toEqual({
      kind: "scroll",
      session_id: "sess_old",
      around_message_id: "evt_1",
      window: 10,
    });
  });

  it("lets scroll win over a query supplied in the same call", async () => {
    const { tool, lastRequest } = harness();
    await tool.handler({
      query: "auth refactor",
      session_id: "sess_old",
      around_message_id: "evt_1",
    });
    expect(lastRequest().kind).toBe("scroll");
  });

  it("reads when session_id stands alone, ignoring query and limit", async () => {
    const { tool, lastRequest } = harness();
    await tool.handler({ session_id: "sess_old", query: "auth", limit: 9 });
    expect(lastRequest()).toEqual({ kind: "read", session_id: "sess_old" });
  });

  it("discovers when only a query is present", async () => {
    const { tool, lastRequest } = harness();
    await tool.handler({ query: "auth refactor", limit: 3, sort: "newest" });
    expect(lastRequest()).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: 3,
      sort: "newest",
      filters: undefined,
    });
  });

  it("browses with no args", async () => {
    const { tool, lastRequest } = harness();
    await tool.handler({});
    expect(lastRequest()).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("trims session_id, around_message_id and query", async () => {
    const { tool, lastRequest } = harness();
    await tool.handler({
      session_id: "  sess_old  ",
      around_message_id: "  evt_1  ",
    });
    expect(lastRequest()).toMatchObject({
      session_id: "sess_old",
      around_message_id: "evt_1",
    });

    await tool.handler({ query: "  auth  " });
    expect(lastRequest()).toMatchObject({ kind: "discover", query: "auth" });
  });

  it.each([
    ["blank strings", { session_id: "   ", around_message_id: "   ", query: "   " }],
    ["non-strings", { session_id: 1, around_message_id: {}, query: [] }],
  ])("falls back to browse when every shape key is %s", async (_l, input) => {
    const { tool, lastRequest } = harness();
    await tool.handler(input);
    expect(lastRequest().kind).toBe("browse");
  });

  it("degrades a blank around_message_id to a read rather than a bad scroll", async () => {
    const { tool, lastRequest } = harness();
    await tool.handler({ session_id: "sess_old", around_message_id: "  " });
    expect(lastRequest()).toEqual({ kind: "read", session_id: "sess_old" });
  });
});

describe("optional field coercion", () => {
  it("drops a non-numeric window so the service applies its own default", async () => {
    for (const window of [undefined, "10", null]) {
      const { tool, lastRequest } = harness();
      await tool.handler({
        session_id: "sess_old",
        around_message_id: "evt_1",
        window,
      });
      expect(lastRequest()).toMatchObject({ window: undefined });
    }
  });

  it("forwards the raw window unclamped — clamping is the service's job", async () => {
    const { tool, lastRequest } = harness();
    await tool.handler({
      session_id: "sess_old",
      around_message_id: "evt_1",
      window: 999,
    });
    expect(lastRequest()).toMatchObject({ window: 999 });
  });

  it("drops a non-numeric limit on both discover and browse", async () => {
    const { tool, lastRequest } = harness();
    await tool.handler({ query: "auth", limit: "3" });
    expect(lastRequest()).toMatchObject({ kind: "discover", limit: undefined });
    await tool.handler({ limit: "3" });
    expect(lastRequest()).toMatchObject({ kind: "browse", limit: undefined });
  });

  it("keeps a numeric limit on browse", async () => {
    const { tool, lastRequest } = harness();
    await tool.handler({ limit: 7 });
    expect(lastRequest()).toEqual({ kind: "browse", limit: 7, filters: undefined });
  });

  it.each(["newest", "oldest"])("keeps a valid sort (%s)", async (sort) => {
    const { tool, lastRequest } = harness();
    await tool.handler({ query: "auth", sort });
    expect(lastRequest()).toMatchObject({ sort });
  });

  it("drops an unrecognised sort rather than passing it to the query builder", async () => {
    for (const sort of ["relevance", "NEWEST", 1, undefined]) {
      const { tool, lastRequest } = harness();
      await tool.handler({ query: "auth", sort });
      expect(lastRequest()).toMatchObject({ sort: undefined });
    }
  });

  it("forwards filters on discover and browse", async () => {
    const filters = { session_type: "task", status: "failed" };
    const { tool, lastRequest } = harness();
    await tool.handler({ query: "auth", filters });
    expect(lastRequest()).toMatchObject({ filters });
    await tool.handler({ filters });
    expect(lastRequest()).toMatchObject({ kind: "browse", filters });
  });

  it("drops filters that aren't an object, including null", async () => {
    for (const filters of [null, "task", 1, undefined]) {
      const { tool, lastRequest } = harness();
      await tool.handler({ query: "auth", filters });
      expect(lastRequest()).toMatchObject({ filters: undefined });
    }
  });
});

describe("result + error envelopes", () => {
  it("returns the service result verbatim on success", async () => {
    const result = { kind: "read", messages: [{ id: "evt_1" }] } as unknown as SessionSearchResult;
    const { tool } = harness({ result });
    const res = await tool.handler({ session_id: "sess_old" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toBe(result);
  });

  it("collapses a null result into one not_found_or_forbidden envelope", async () => {
    // The service deliberately can't distinguish out-of-scope from
    // nonexistent — leaking which it was would confirm a session id.
    const { tool } = harness({ result: null });
    const res = await tool.handler({ session_id: "sess_someone_elses" });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("not_found_or_forbidden");
    expect(String(res.content.message)).toContain("scope");
  });

  it.each(["forbidden_agent_filter", "missing_query", "missing_args"] as const)(
    "surfaces the %s code from a SessionSearchError",
    async (code) => {
      const { tool } = harness({ throws: new SessionSearchError(code, `bad: ${code}`) });
      const res = await tool.handler({ query: "auth" });
      expect(res.isError).toBe(true);
      expect(res.content).toEqual({ error: code, message: `bad: ${code}` });
    },
  );

  it("matches a SessionSearchError by name when instanceof fails across bundles", async () => {
    // Simulates core loaded twice (dist/ for api, src/ for a script):
    // the class identity differs, so only the name check saves the code.
    const impostor = new Error("query is required for discovery") as Error & {
      code: string;
    };
    impostor.name = "SessionSearchError";
    impostor.code = "missing_query";
    const { tool } = harness({ throws: impostor });
    const res = await tool.handler({ query: "auth" });
    expect(res.content).toEqual({
      error: "missing_query",
      message: "query is required for discovery",
    });
  });

  it("wraps any other Error as internal_error", async () => {
    const { tool } = harness({ throws: new Error("connection terminated") });
    const res = await tool.handler({});
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "internal_error",
      message: "connection terminated",
    });
  });

  it("stringifies a non-Error throw", async () => {
    const { tool } = harness({ throws: "pool drained" });
    const res = await tool.handler({});
    expect(res.content).toEqual({
      error: "internal_error",
      message: "pool drained",
    });
  });
});
