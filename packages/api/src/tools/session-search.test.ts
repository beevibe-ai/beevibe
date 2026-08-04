/**
 * Tests for the session_search MCP tool.
 *
 * The tool has no logic of its own past `inferRequest` — but that
 * function is the whole agent-facing contract: four calling shapes
 * distinguished only by which loosely-typed keys are present, with a
 * documented precedence (scroll beats read beats discover beats
 * browse). An agent that passes `session_id` alongside a `query` gets a
 * materially different answer depending on which branch wins, so the
 * precedence is worth pinning rather than inferring from the
 * description prose.
 *
 * The remaining surface is the error envelope: a `null` result means
 * "not in scope / no such anchor" and must not be reported as success,
 * and a SessionSearchError has to keep its `code` even when it arrives
 * from a differently-bundled copy of the class.
 */
import { describe, expect, it, vi, type Mock } from "vitest";
import type { SessionSearchRequest } from "@beevibe/core";
import {
  SessionSearchError,
  type SessionSearchService,
} from "@beevibe/core/services/session-search";
import { createSessionSearchTool } from "./session-search.js";

const CTX = {
  agentId: "agent_caller",
  hierarchyLevel: "team" as const,
  sessionId: "sess_current",
};

/** What the tool passes the service: the inferred request + caller scope. */
type SearchCall = [SessionSearchRequest, Record<string, unknown>];

type SearchMock = Mock<(...args: SearchCall) => Promise<unknown>>;

function makeTool(
  impl: (...args: SearchCall) => Promise<unknown> = async () => ({
    results: [],
  }),
): {
  tool: ReturnType<typeof createSessionSearchTool>;
  search: SearchMock;
} {
  const search = vi.fn(impl) as SearchMock;
  const sessionSearch = { search } as unknown as SessionSearchService;
  return { tool: createSessionSearchTool(CTX, { sessionSearch }), search };
}

/** The request `inferRequest` produced for a given raw tool input. */
async function requestFor(input: Record<string, unknown>): Promise<SessionSearchRequest> {
  const { tool, search } = makeTool();
  await tool.handler(input);
  return search.mock.calls[0]![0];
}

describe("session_search descriptor", () => {
  it("is named and described for the agent", () => {
    const { tool } = makeTool();
    expect(tool.name).toBe("session_search");
    expect(tool.description).toContain("FOUR CALLING SHAPES");
    expect(tool.schema.type).toBe("object");
  });
});

describe("session_search shape inference", () => {
  it("browses when nothing identifying is passed", async () => {
    expect(await requestFor({})).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("discovers on a query", async () => {
    expect(await requestFor({ query: "  auth refactor  ", limit: 3 })).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: 3,
      sort: undefined,
      filters: undefined,
    });
  });

  it("reads on a bare session_id", async () => {
    expect(await requestFor({ session_id: "  sess_a  " })).toEqual({
      kind: "read",
      session_id: "sess_a",
    });
  });

  it("scrolls when session_id and an anchor are both present", async () => {
    expect(
      await requestFor({
        session_id: "sess_a",
        around_message_id: " evt_b ",
        window: 10,
      }),
    ).toEqual({
      kind: "scroll",
      session_id: "sess_a",
      around_message_id: "evt_b",
      window: 10,
    });
  });

  it("prefers scroll over read and discover when the keys overlap", async () => {
    const req = await requestFor({
      session_id: "sess_a",
      around_message_id: "evt_b",
      query: "auth",
    });
    expect(req.kind).toBe("scroll");
  });

  it("prefers read over discover when both session_id and query are set", async () => {
    const req = await requestFor({ session_id: "sess_a", query: "auth" });
    expect(req.kind).toBe("read");
  });

  it("ignores an anchor with no session_id and falls through to discover", async () => {
    const req = await requestFor({ around_message_id: "evt_b", query: "auth" });
    expect(req.kind).toBe("discover");
  });

  it.each([
    ["blank", "   "],
    ["a non-string", 7],
    ["null", null],
  ])("treats %s session_id as absent", async (_label, session_id) => {
    expect((await requestFor({ session_id })).kind).toBe("browse");
  });

  it.each([
    ["blank", "   "],
    ["a non-string", 7],
  ])("treats %s query as absent", async (_label, query) => {
    expect((await requestFor({ query })).kind).toBe("browse");
  });

  it("treats a blank anchor as absent, degrading scroll to read", async () => {
    expect((await requestFor({ session_id: "sess_a", around_message_id: "  " })).kind).toBe("read");
  });

  it("drops a non-numeric window, limit and unknown sort", async () => {
    expect(
      await requestFor({ session_id: "sess_a", around_message_id: "evt_b", window: "10" }),
    ).toMatchObject({ window: undefined });
    expect(await requestFor({ query: "x", limit: "3", sort: "relevance" })).toMatchObject({
      limit: undefined,
      sort: undefined,
    });
  });

  it.each(["newest", "oldest"] as const)("passes the %s sort through", async (sort) => {
    expect(await requestFor({ query: "x", sort })).toMatchObject({ sort });
  });

  it("forwards a filters object verbatim to discover and browse", async () => {
    const filters = { type: "task", status: "failed", agent_id: "agent_x" };
    expect(await requestFor({ query: "x", filters })).toMatchObject({ filters });
    expect(await requestFor({ filters })).toMatchObject({ filters });
  });

  it.each([
    ["null", null],
    ["a string", "type:task"],
    ["missing", undefined],
  ])("drops %s filters", async (_label, filters) => {
    expect(await requestFor({ filters })).toMatchObject({ filters: undefined });
  });
});

describe("session_search caller scope", () => {
  it("passes the caller's agent, tier and current session to the service", async () => {
    const { tool, search } = makeTool();

    await tool.handler({ query: "auth" });

    expect(search.mock.calls[0]![1]).toEqual({
      callerAgentId: "agent_caller",
      hierarchyLevel: "team",
      currentSessionId: "sess_current",
    });
  });

  it("returns the service result unchanged on success", async () => {
    const payload = { results: [{ session: { id: "sess_a" } }] };
    const { tool } = makeTool(async () => payload);

    const result = await tool.handler({ query: "auth" });

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe(payload);
  });
});

describe("session_search error envelope", () => {
  it("reports a null result as not_found_or_forbidden rather than success", async () => {
    const { tool } = makeTool(async () => null);

    const result = await tool.handler({ session_id: "sess_someone_elses" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "not_found_or_forbidden" });
  });

  it("preserves a SessionSearchError's code", async () => {
    const { tool } = makeTool(async () => {
      throw new SessionSearchError("forbidden_agent_filter", "agent_x is out of scope");
    });

    const result = await tool.handler({ query: "x", filters: { agent_id: "agent_x" } });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "forbidden_agent_filter",
      message: "agent_x is out of scope",
    });
  });

  it("matches a SessionSearchError from another bundle by name", async () => {
    // Same class compiled into a second copy — `instanceof` fails, so
    // the handler falls back to the name check.
    const foreign = new Error("query is required");
    foreign.name = "SessionSearchError";
    (foreign as Error & { code: string }).code = "missing_query";
    const { tool } = makeTool(async () => {
      throw foreign;
    });

    const result = await tool.handler({ query: "x" });

    expect(result.content).toEqual({
      error: "missing_query",
      message: "query is required",
    });
  });

  it("wraps an unexpected throw as internal_error", async () => {
    const { tool } = makeTool(async () => {
      throw new Error("connection terminated unexpectedly");
    });

    const result = await tool.handler({ query: "x" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "internal_error",
      message: "connection terminated unexpectedly",
    });
  });

  it("stringifies a non-Error throw", async () => {
    const { tool } = makeTool(async () => {
      throw "pool drained";
    });

    const result = await tool.handler({ query: "x" });

    expect(result.content).toEqual({
      error: "internal_error",
      message: "pool drained",
    });
  });
});
