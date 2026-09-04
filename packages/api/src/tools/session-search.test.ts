/**
 * session_search tool — unit tests with a fake SessionSearchService.
 *
 * The service is tested on its own; what lives here is the adapter's
 * shape inference (which of discover / scroll / read / browse a raw
 * MCP input maps to), the caller-context passthrough, and the error
 * envelopes — including the `name`-based fallback that keeps structured
 * codes working when the error crosses a src/dist bundle boundary.
 */
import { describe, expect, it, vi } from "vitest";
import type { HierarchyLevel, SessionSearchRequest } from "@beevibe/core";
import {
  SessionSearchError,
  type SessionSearchService,
} from "@beevibe/core/services/session-search";
import { createSessionSearchTool } from "./session-search.js";
import type { AgentToolResult } from "./types.js";

const AGENT_ID = "agent_ic";
const SESSION_ID = "sess_current";

interface Harness {
  handler: (input: Record<string, unknown>) => Promise<AgentToolResult>;
  search: ReturnType<typeof vi.fn>;
  /** The request the tool inferred from the last call. */
  request: () => SessionSearchRequest;
}

function makeTool(
  opts: {
    hierarchyLevel?: HierarchyLevel;
    search?: ReturnType<typeof vi.fn>;
  } = {},
): Harness {
  const search = opts.search ?? vi.fn(async () => ({ results: [] }));
  const tool = createSessionSearchTool(
    {
      agentId: AGENT_ID,
      hierarchyLevel: opts.hierarchyLevel ?? "ic",
      sessionId: SESSION_ID,
    },
    { sessionSearch: { search } as unknown as SessionSearchService },
  );
  return {
    handler: tool.handler,
    search,
    request: () => search.mock.calls[0]![0] as SessionSearchRequest,
  };
}

describe("session_search — tool shape", () => {
  it("takes no required inputs, since browse is the no-arg shape", () => {
    const tool = createSessionSearchTool(
      { agentId: AGENT_ID, hierarchyLevel: "ic", sessionId: SESSION_ID },
      { sessionSearch: {} as SessionSearchService },
    );
    expect(tool.name).toBe("session_search");
    expect(tool.schema.required).toBeUndefined();
    expect(tool.description).toContain("FOUR CALLING SHAPES");
  });
});

describe("session_search — caller context", () => {
  it.each([["ic"], ["team"], ["org"]] as Array<[HierarchyLevel]>)(
    "passes the caller triple through for a %s caller",
    async (hierarchyLevel) => {
      const { handler, search } = makeTool({ hierarchyLevel });
      await handler({});
      expect(search.mock.calls[0]![1]).toEqual({
        callerAgentId: AGENT_ID,
        hierarchyLevel,
        currentSessionId: SESSION_ID,
      });
    },
  );

  it("returns the service result verbatim", async () => {
    const result = { kind: "browse", sessions: [{ id: "sess_1" }] };
    const { handler } = makeTool({ search: vi.fn(async () => result) });
    const res = await handler({});
    expect(res.isError).toBeUndefined();
    expect(res.content).toBe(result);
  });
});

describe("session_search — shape inference", () => {
  it("infers browse from no arguments", async () => {
    const { handler, request } = makeTool();
    await handler({});
    expect(request()).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("carries limit and filters onto browse", async () => {
    const { handler, request } = makeTool();
    await handler({ limit: 7, filters: { status: "failed" } });
    expect(request()).toEqual({
      kind: "browse",
      limit: 7,
      filters: { status: "failed" },
    });
  });

  it("infers discover from a query", async () => {
    const { handler, request } = makeTool();
    await handler({ query: "auth refactor", limit: 3, sort: "newest" });
    expect(request()).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: 3,
      sort: "newest",
      filters: undefined,
    });
  });

  it.each([
    ["an unknown value", "relevance"],
    ["not a string", 1],
    ["omitted", undefined],
  ])("drops a sort that is %s", async (_label, sort) => {
    const { handler, request } = makeTool();
    await handler({ query: "auth", sort });
    expect((request() as { sort?: string }).sort).toBeUndefined();
  });

  it("keeps 'oldest' as a valid sort", async () => {
    const { handler, request } = makeTool();
    await handler({ query: "auth", sort: "oldest" });
    expect((request() as { sort?: string }).sort).toBe("oldest");
  });

  it("infers read from a bare session_id, ignoring query and limit", async () => {
    const { handler, request } = makeTool();
    await handler({ session_id: "sess_old", query: "auth", limit: 9 });
    expect(request()).toEqual({ kind: "read", session_id: "sess_old" });
  });

  it("infers scroll when session_id and around_message_id are both set", async () => {
    const { handler, request } = makeTool();
    await handler({
      session_id: "sess_old",
      around_message_id: "evt_5",
      window: 10,
    });
    expect(request()).toEqual({
      kind: "scroll",
      session_id: "sess_old",
      around_message_id: "evt_5",
      window: 10,
    });
  });

  it("scroll beats discover when a query is also present", async () => {
    const { handler, request } = makeTool();
    await handler({
      session_id: "sess_old",
      around_message_id: "intent:sess_old",
      query: "auth",
    });
    expect(request().kind).toBe("scroll");
  });

  it.each([
    ["not a number", "10"],
    ["omitted", undefined],
  ])("leaves window undefined when it is %s", async (_label, window) => {
    const { handler, request } = makeTool();
    await handler({ session_id: "sess_old", around_message_id: "evt_5", window });
    expect((request() as { window?: number }).window).toBeUndefined();
  });

  it("trims ids and query before inferring", async () => {
    const { handler, request } = makeTool();
    await handler({ session_id: "  sess_old  ", around_message_id: "  evt_5  " });
    expect(request()).toMatchObject({
      session_id: "sess_old",
      around_message_id: "evt_5",
    });
  });

  it.each([
    ["blank strings", { session_id: "   ", around_message_id: "  ", query: "  " }],
    ["wrong types", { session_id: 1, around_message_id: 2, query: 3 }],
  ])("falls back to browse on %s", async (_label, input) => {
    const { handler, request } = makeTool();
    await handler(input);
    expect(request().kind).toBe("browse");
  });

  it("treats a blank session_id with a real anchor as browse, not scroll", async () => {
    const { handler, request } = makeTool();
    await handler({ session_id: "  ", around_message_id: "evt_5" });
    expect(request().kind).toBe("browse");
  });

  it.each([
    ["null", null],
    ["a string", "status=failed"],
    ["omitted", undefined],
  ])("drops filters that are %s", async (_label, filters) => {
    const { handler, request } = makeTool();
    await handler({ query: "auth", filters });
    expect((request() as { filters?: unknown }).filters).toBeUndefined();
  });
});

describe("session_search — error envelopes", () => {
  it("maps a null result to not_found_or_forbidden", async () => {
    const { handler } = makeTool({ search: vi.fn(async () => null) });
    const res = await handler({ session_id: "sess_theirs" });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("not_found_or_forbidden");
    expect(res.content.message).toContain("not in your scope");
  });

  it.each([
    ["forbidden_agent_filter"],
    ["missing_query"],
    ["missing_args"],
  ] as Array<[SessionSearchError["code"]]>)(
    "surfaces the %s code from a SessionSearchError",
    async (code) => {
      const { handler } = makeTool({
        search: vi.fn(async () => {
          throw new SessionSearchError(code, `bad request: ${code}`);
        }),
      });
      const res = await handler({ query: "auth" });
      expect(res.isError).toBe(true);
      expect(res.content).toEqual({ error: code, message: `bad request: ${code}` });
    },
  );

  it("recognizes a cross-bundle SessionSearchError by name", async () => {
    // The api consumes @beevibe/core from dist/; a script consuming src/
    // throws a structurally identical error that fails `instanceof`.
    const impostor = Object.assign(new Error("out of scope"), {
      name: "SessionSearchError",
      code: "forbidden_agent_filter",
    });
    const { handler } = makeTool({
      search: vi.fn(async () => {
        throw impostor;
      }),
    });
    const res = await handler({ query: "auth" });
    expect(res.content).toEqual({
      error: "forbidden_agent_filter",
      message: "out of scope",
    });
  });

  it("falls back to internal_error for an unrelated Error", async () => {
    const { handler } = makeTool({
      search: vi.fn(async () => {
        throw new Error("connection terminated");
      }),
    });
    const res = await handler({ query: "auth" });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "internal_error",
      message: "connection terminated",
    });
  });

  it("stringifies a non-Error throw", async () => {
    const { handler } = makeTool({
      search: vi.fn(async () => {
        throw "pool drained";
      }),
    });
    const res = await handler({});
    expect(res.content).toEqual({
      error: "internal_error",
      message: "pool drained",
    });
  });
});
