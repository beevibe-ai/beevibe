/**
 * session_search handler tests.
 *
 * The tool's real work is shape inference: four calling shapes are
 * distinguished by which args are present, and the precedence between
 * them (scroll beats read beats discover beats browse) is what decides
 * whether an agent gets a message window or a whole transcript. The
 * service behind it needs Postgres FTS; the inference and the error
 * envelopes don't, so they're pinned here against a fake.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  HierarchyLevel,
  SessionSearchRequest,
  SessionSearchResult,
} from "@beevibe/core";
import {
  SessionSearchError,
  type SessionSearchService,
} from "@beevibe/core/services/session-search";
import { createSessionSearchTool } from "./session-search.js";

const CTX = {
  agentId: "agent_a",
  hierarchyLevel: "team" as HierarchyLevel,
  sessionId: "ses_current",
};

type SearchArgs = Parameters<SessionSearchService["search"]>;

function harness(behavior: { result?: unknown; throws?: unknown } = {}) {
  const search = vi.fn(async (..._args: SearchArgs) => {
    if ("throws" in behavior) throw behavior.throws;
    const fallback = { kind: "browse", sessions: [] };
    return ("result" in behavior
      ? behavior.result
      : fallback) as SessionSearchResult | null;
  });
  const sessionSearch = { search } as unknown as SessionSearchService;
  return { tool: createSessionSearchTool(CTX, { sessionSearch }), search };
}

/** The request the tool inferred from a given raw tool input. */
async function inferred(
  input: Record<string, unknown>,
): Promise<SessionSearchRequest> {
  const h = harness();
  await h.tool.handler(input);
  const req = h.search.mock.calls[0]?.[0];
  if (!req) throw new Error("sessionSearch.search was never called");
  return req;
}

describe("session_search — shape inference", () => {
  it("browses when nothing is passed", async () => {
    expect(await inferred({})).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("discovers when a query is passed", async () => {
    expect(await inferred({ query: "auth refactor", limit: 5, sort: "newest" })).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: 5,
      sort: "newest",
      filters: undefined,
    });
  });

  it("reads when a bare session_id is passed", async () => {
    expect(await inferred({ session_id: "ses_9" })).toEqual({
      kind: "read",
      session_id: "ses_9",
    });
  });

  it("scrolls when session_id and around_message_id are both passed", async () => {
    expect(
      await inferred({
        session_id: "ses_9",
        around_message_id: "evt_3",
        window: 10,
      }),
    ).toEqual({
      kind: "scroll",
      session_id: "ses_9",
      around_message_id: "evt_3",
      window: 10,
    });
  });

  it("lets scroll win over discover when a query tags along", async () => {
    // The tool description promises `query` is ignored once
    // session_id + around_message_id are set.
    expect(
      await inferred({
        query: "auth refactor",
        session_id: "ses_9",
        around_message_id: "evt_3",
      }),
    ).toMatchObject({ kind: "scroll" });
  });

  it("lets read win over discover when a query tags along", async () => {
    expect(
      await inferred({ query: "auth refactor", session_id: "ses_9" }),
    ).toMatchObject({ kind: "read", session_id: "ses_9" });
  });

  it("accepts the synthetic user-turn anchor id format", async () => {
    expect(
      await inferred({ session_id: "ses_9", around_message_id: "intent:ses_9" }),
    ).toMatchObject({ kind: "scroll", around_message_id: "intent:ses_9" });
  });
});

describe("session_search — argument normalization", () => {
  it("trims the string args", async () => {
    expect(
      await inferred({ session_id: "  ses_9  ", around_message_id: "  evt_3  " }),
    ).toMatchObject({ session_id: "ses_9", around_message_id: "evt_3" });
    expect(await inferred({ query: "  auth  " })).toMatchObject({
      query: "auth",
    });
  });

  it.each([
    ["whitespace-only", "   "],
    ["empty", ""],
    ["a non-string", 42],
  ])("treats a %s session_id as absent, falling back to browse", async (_l, sessionId) => {
    expect(await inferred({ session_id: sessionId })).toMatchObject({
      kind: "browse",
    });
  });

  it("treats a whitespace-only anchor as absent, degrading scroll to read", async () => {
    expect(
      await inferred({ session_id: "ses_9", around_message_id: "   " }),
    ).toMatchObject({ kind: "read" });
  });

  it("treats a whitespace-only query as absent, degrading discover to browse", async () => {
    expect(await inferred({ query: "   " })).toMatchObject({ kind: "browse" });
  });

  it.each([
    ["a numeric string", "10"],
    ["null", null],
  ])("drops a %s limit so the service default applies", async (_l, limit) => {
    expect(await inferred({ query: "x", limit })).toMatchObject({
      limit: undefined,
    });
  });

  it("drops a non-numeric window so the service clamp default applies", async () => {
    expect(
      await inferred({ session_id: "s", around_message_id: "m", window: "10" }),
    ).toMatchObject({ window: undefined });
  });

  it("drops a sort value outside newest|oldest", async () => {
    expect(await inferred({ query: "x", sort: "relevance" })).toMatchObject({
      sort: undefined,
    });
    expect(await inferred({ query: "x", sort: "oldest" })).toMatchObject({
      sort: "oldest",
    });
  });

  it("passes filters through on both the discover and browse shapes", async () => {
    const filters = { status: "failed", session_type: "task" };
    expect(await inferred({ query: "x", filters })).toMatchObject({ filters });
    expect(await inferred({ filters })).toMatchObject({ filters });
  });

  it.each([
    ["null", null],
    ["a string", "status=failed"],
  ])("drops %s filters", async (_l, filters) => {
    expect(await inferred({ filters })).toMatchObject({ filters: undefined });
  });
});

describe("session_search — caller context", () => {
  it("passes the caller's tier and active session to the service", async () => {
    const h = harness();
    await h.tool.handler({ query: "x" });

    expect(h.search.mock.calls[0]?.[1]).toEqual({
      callerAgentId: "agent_a",
      hierarchyLevel: "team",
      currentSessionId: "ses_current",
    });
  });

  it("returns the service result verbatim", async () => {
    const payload = { kind: "read", session: { id: "ses_9" }, messages: [] };
    const h = harness({ result: payload });
    const result = await h.tool.handler({ session_id: "ses_9" });

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe(payload);
  });
});

describe("session_search — error envelopes", () => {
  it("maps a null result to not_found_or_forbidden", async () => {
    const h = harness({ result: null });
    const result = await h.tool.handler({ session_id: "ses_other" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "not_found_or_forbidden" });
  });

  it("keeps a SessionSearchError's structured code", async () => {
    const h = harness({
      throws: new SessionSearchError(
        "forbidden_agent_filter",
        "agent_z is outside your scope",
      ),
    });
    const result = await h.tool.handler({
      query: "x",
      filters: { agent_id: "agent_z" },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "forbidden_agent_filter",
      message: "agent_z is outside your scope",
    });
  });

  it("matches a cross-bundle SessionSearchError by name, not just instanceof", async () => {
    // src/ and dist/ copies of core produce distinct classes, so the
    // handler falls back to the error name. Simulate the src-side twin.
    const twin = Object.assign(new Error("query is required"), {
      name: "SessionSearchError",
      code: "missing_query",
    });
    const h = harness({ throws: twin });
    const result = await h.tool.handler({ query: "x" });

    expect(result.content).toEqual({
      error: "missing_query",
      message: "query is required",
    });
  });

  it("wraps an unexpected Error as internal_error", async () => {
    const h = harness({ throws: new Error("connection terminated") });
    const result = await h.tool.handler({ query: "x" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "internal_error",
      message: "connection terminated",
    });
  });

  it("stringifies a non-Error throw", async () => {
    const h = harness({ throws: { code: 42 } });
    const result = await h.tool.handler({ query: "x" });

    expect(result.content).toMatchObject({ error: "internal_error" });
    expect(typeof result.content.message).toBe("string");
  });
});

describe("session_search — tool surface", () => {
  it("has no required args, since browse is the no-arg shape", () => {
    const { tool } = harness();
    expect(tool.name).toBe("session_search");
    expect(tool.schema.required).toBeUndefined();
  });

  it("enumerates the session type and status filters from the domain constants", () => {
    const { tool } = harness();
    const filters = (
      tool.schema.properties as {
        filters: {
          properties: {
            session_type: { enum: string[] };
            status: { enum: string[] };
          };
        };
      }
    ).filters.properties;

    expect(filters.session_type.enum).toEqual(
      expect.arrayContaining(["task", "chat", "run_repo"]),
    );
    expect(filters.status.enum).toEqual(
      expect.arrayContaining(["failed", "succeeded"]),
    );
  });
});
