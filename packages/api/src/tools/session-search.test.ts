/**
 * session_search tool — unit tests with vitest fakes (no DB).
 *
 * The tool's only logic is `inferRequest`: four calling shapes
 * (discover / scroll / read / browse) are disambiguated from a flat,
 * untyped MCP input bag. Picking the wrong shape sends the agent a
 * valid-looking answer to a different question, which is the failure
 * mode worth pinning. The rest is the error projection — the agent
 * branches on `error`, so each code is asserted literally.
 */
import { describe, expect, it, vi } from "vitest";
import type { HierarchyLevel, SessionSearchRequest } from "@beevibe/core";
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
  agentId: "agent_a",
  hierarchyLevel: "team",
  sessionId: "sess_current",
};

type Search = (
  req: SessionSearchRequest,
  ctx: SessionSearchContext,
) => Promise<unknown>;

function makeTool(
  result: unknown = { kind: "browse", sessions: [] },
  ctx: SessionSearchToolContext = CTX,
) {
  const search = vi.fn<Search>(async () => result);
  const tool = createSessionSearchTool(ctx, {
    sessionSearch: { search } as unknown as SessionSearchService,
  });
  return { tool, search };
}

/** The request `inferRequest` produced for a given input bag. */
async function inferred(
  input: Record<string, unknown>,
): Promise<SessionSearchRequest> {
  const { tool, search } = makeTool();
  await tool.handler(input);
  return search.mock.calls[0]![0];
}

describe("session_search surface", () => {
  it("is named session_search and takes every field as optional", () => {
    const { tool } = makeTool();
    expect(tool.name).toBe("session_search");
    // No `required` — the no-arg browse shape has to stay callable.
    expect(tool.schema.required).toBeUndefined();
    expect(Object.keys(tool.schema.properties as object)).toEqual([
      "query",
      "limit",
      "sort",
      "session_id",
      "around_message_id",
      "window",
      "filters",
    ]);
  });

  it("documents the four calling shapes in the agent-facing description", () => {
    const { tool } = makeTool();
    for (const shape of ["DISCOVERY", "SCROLL", "READ", "BROWSE"]) {
      expect(tool.description).toContain(shape);
    }
  });
});

describe("session_search caller scope", () => {
  it("passes the caller's agent id, tier and active session to the service", async () => {
    const { tool, search } = makeTool();
    await tool.handler({});

    expect(search.mock.calls[0]![1]).toEqual({
      callerAgentId: "agent_a",
      hierarchyLevel: "team",
      currentSessionId: "sess_current",
    });
  });

  it.each(["ic", "team", "org"] as const)(
    "forwards hierarchyLevel %s verbatim — scope resolution is the service's job",
    async (level: HierarchyLevel) => {
      const { tool, search } = makeTool(undefined, { ...CTX, hierarchyLevel: level });
      await tool.handler({ query: "auth" });

      expect(search.mock.calls[0]![1]).toMatchObject({
        hierarchyLevel: level,
      });
    },
  );
});

describe("session_search shape inference", () => {
  it("browses when called with no arguments", async () => {
    expect(await inferred({})).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("discovers when given a query", async () => {
    expect(await inferred({ query: "auth refactor", limit: 3 })).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: 3,
      sort: undefined,
      filters: undefined,
    });
  });

  it("reads when given a bare session_id", async () => {
    expect(await inferred({ session_id: "sess_7" })).toEqual({
      kind: "read",
      session_id: "sess_7",
    });
  });

  it("scrolls when given session_id plus around_message_id", async () => {
    expect(
      await inferred({
        session_id: "sess_7",
        around_message_id: "evt_3",
        window: 10,
      }),
    ).toEqual({
      kind: "scroll",
      session_id: "sess_7",
      around_message_id: "evt_3",
      window: 10,
    });
  });

  // Precedence is the part an agent can trip over by sending a stale
  // session_id alongside a fresh query.
  it("prefers scroll over read and discover when all three are present", async () => {
    const req = await inferred({
      query: "ignored",
      session_id: "sess_7",
      around_message_id: "evt_3",
    });

    expect(req.kind).toBe("scroll");
  });

  it("prefers read over discover when a session_id accompanies a query", async () => {
    const req = await inferred({ query: "ignored", session_id: "sess_7" });

    expect(req).toEqual({ kind: "read", session_id: "sess_7" });
  });

  it("falls back from scroll to read when only the anchor is blank", async () => {
    const req = await inferred({
      session_id: "sess_7",
      around_message_id: "   ",
    });

    expect(req).toEqual({ kind: "read", session_id: "sess_7" });
  });

  it("falls back from read to discover when only the session_id is blank", async () => {
    const req = await inferred({ session_id: "  ", query: "auth" });

    expect(req.kind).toBe("discover");
  });

  it("falls back to browse when every discriminator is blank", async () => {
    const req = await inferred({
      session_id: "  ",
      around_message_id: "  ",
      query: "   ",
    });

    expect(req.kind).toBe("browse");
  });

  it.each([
    ["a number", 7],
    ["null", null],
    ["an array", ["sess_7"]],
  ])("ignores a session_id that is %s", async (_label, session_id) => {
    expect((await inferred({ session_id })).kind).toBe("browse");
  });

  it("ignores a non-string query", async () => {
    expect((await inferred({ query: 42 })).kind).toBe("browse");
  });

  it("trims session_id, anchor and query before handing them over", async () => {
    expect(
      await inferred({
        session_id: "  sess_7  ",
        around_message_id: "\tevt_3\n",
      }),
    ).toMatchObject({ session_id: "sess_7", around_message_id: "evt_3" });

    expect(await inferred({ query: "  auth  " })).toMatchObject({
      query: "auth",
    });
  });

  it("passes a synthetic user-turn anchor through unchanged", async () => {
    expect(
      await inferred({
        session_id: "sess_7",
        around_message_id: "intent:sess_7",
      }),
    ).toMatchObject({ around_message_id: "intent:sess_7" });
  });
});

describe("session_search numeric and enum coercion", () => {
  it.each([
    ["a numeric string", "10"],
    ["null", null],
    ["absent", undefined],
  ])("drops a %s window so the service applies its default", async (_label, window) => {
    const req = await inferred({
      session_id: "sess_7",
      around_message_id: "evt_3",
      window,
    });

    expect((req as { window?: number }).window).toBeUndefined();
  });

  it.each([
    ["discover", { query: "auth" }],
    ["browse", {}],
  ])("drops a non-numeric limit on the %s shape", async (_label, input) => {
    const req = await inferred({ ...input, limit: "3" });

    expect((req as { limit?: number }).limit).toBeUndefined();
  });

  it.each(["newest", "oldest"] as const)("accepts sort=%s on discover", async (sort) => {
    expect(await inferred({ query: "auth", sort })).toMatchObject({ sort });
  });

  it.each([
    ["an unknown value", "relevance"],
    ["a non-string", 1],
  ])("drops sort when it is %s", async (_label, sort) => {
    expect((await inferred({ query: "auth", sort })).kind).toBe("discover");
    expect(
      (await inferred({ query: "auth", sort })) as { sort?: string },
    ).toMatchObject({ sort: undefined });
  });

  it("forwards a filters object on discover and browse", async () => {
    const filters = { status: "failed", session_type: "task" };

    expect(await inferred({ query: "auth", filters })).toMatchObject({ filters });
    expect(await inferred({ filters })).toMatchObject({ filters });
  });

  it.each([
    ["null", null],
    ["a string", "status=failed"],
    ["a number", 1],
  ])("drops filters that are %s", async (_label, filters) => {
    expect(
      (await inferred({ query: "auth", filters })) as { filters?: unknown },
    ).toMatchObject({ filters: undefined });
  });

  // An array is `typeof "object"` and non-null, so it reaches the service
  // as-is. Pinned as the current contract: the guard is a null/type check,
  // not a schema validation, and the service owns rejecting the content.
  it("passes an array of filters through to the service to reject", async () => {
    expect(await inferred({ query: "auth", filters: [] })).toMatchObject({
      filters: [],
    });
  });
});

describe("session_search result projection", () => {
  it("returns the service payload verbatim on success", async () => {
    const payload = {
      kind: "read",
      session: { id: "sess_7" },
      messages: [{ id: "evt_1", role: "user" }],
    };
    const { tool } = makeTool(payload);
    const result = await tool.handler({ session_id: "sess_7" });

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe(payload);
  });

  it("turns a null result into not_found_or_forbidden", async () => {
    const { tool } = makeTool(null);
    const result = await tool.handler({ session_id: "sess_elsewhere" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "not_found_or_forbidden",
    });
    expect(result.content.message).toContain("not in your scope");
  });
});

describe("session_search error projection", () => {
  function throwing(err: unknown) {
    const search = vi.fn<Search>(async () => {
      throw err;
    });
    return createSessionSearchTool(CTX, {
      sessionSearch: { search } as unknown as SessionSearchService,
    });
  }

  it.each([
    ["forbidden_agent_filter", "agent_z is outside your scope"],
    ["missing_query", "query is required for discovery"],
    ["missing_args", "pass a query or a session_id"],
  ] as const)("surfaces SessionSearchError code %s", async (code, message) => {
    const tool = throwing(new SessionSearchError(code, message));
    const result = await tool.handler({ query: "x" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: code, message });
  });

  // The api package consumes @beevibe/core from dist/ while integration
  // scripts consume src/, so the same class arrives as two constructors
  // and `instanceof` misses. The name check is what keeps the structured
  // code from degrading to internal_error across that boundary.
  it("recognizes a cross-bundle SessionSearchError by name alone", async () => {
    const impostor = Object.assign(new Error("agent_z is outside your scope"), {
      name: "SessionSearchError",
      code: "forbidden_agent_filter",
    });
    const result = await throwing(impostor).handler({ query: "x" });

    expect(result.content).toEqual({
      error: "forbidden_agent_filter",
      message: "agent_z is outside your scope",
    });
  });

  it("envelopes any other Error as internal_error", async () => {
    const result = await throwing(new Error("connection terminated")).handler({});

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "internal_error",
      message: "connection terminated",
    });
  });

  it("stringifies a non-Error throw under internal_error", async () => {
    const result = await throwing("pool drained").handler({});

    expect(result.content).toEqual({
      error: "internal_error",
      message: "pool drained",
    });
  });
});
