/**
 * session_search handler tests.
 *
 * The module's real logic is `inferRequest` — the shape inference that
 * turns loose MCP input into one of four typed SessionSearchRequests.
 * It isn't exported, so it's exercised through the handler with a stub
 * service that records the request it was handed. The service itself
 * (scope resolution, FTS, windowing) is covered by
 * core/src/services/session-search.test.ts.
 *
 * The other half here is the error envelope: SessionSearchError keeps
 * its structured `code`, and the null return — out of scope, or a
 * missing anchor — becomes not_found_or_forbidden rather than an empty
 * success.
 */
import { describe, expect, it, vi } from "vitest";
import type { SessionSearchRequest } from "@beevibe/core";
import {
  SessionSearchError,
  type SessionSearchContext,
  type SessionSearchService,
} from "@beevibe/core/services/session-search";
import {
  createSessionSearchTool,
  type SessionSearchToolContext,
} from "./session-search.js";

const ctx: SessionSearchToolContext = {
  agentId: "agent_1",
  hierarchyLevel: "team",
  sessionId: "ses_current",
};

/** Captures the (request, context) pair the tool builds. */
function harness(result: unknown = { kind: "browse", sessions: [] }) {
  const search = vi.fn(
    async (_req: SessionSearchRequest, _ctx: SessionSearchContext) => result,
  );
  const tool = createSessionSearchTool(ctx, {
    sessionSearch: { search } as unknown as SessionSearchService,
  });
  const req = () => search.mock.calls[0]![0];
  return { tool, search, req };
}

function throwingHarness(err: unknown) {
  const search = vi.fn(async () => {
    throw err;
  });
  return createSessionSearchTool(ctx, {
    sessionSearch: { search } as unknown as SessionSearchService,
  });
}

describe("session_search tool definition", () => {
  it("is named session_search and takes no required args", () => {
    const { tool } = harness();
    expect(tool.name).toBe("session_search");
    // Every shape is optional — bare session_search() is the browse call.
    expect(tool.schema.required).toBeUndefined();
  });

  it("advertises the sort enum the description documents", () => {
    const { tool } = harness();
    const props = tool.schema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.sort!.enum).toEqual(["newest", "oldest"]);
  });
});

describe("shape inference", () => {
  it("infers browse from no arguments", async () => {
    const { tool, req } = harness();
    await tool.handler({});

    expect(req()).toEqual({ kind: "browse", limit: undefined, filters: undefined });
  });

  it("infers discover from a query", async () => {
    const { tool, req } = harness();
    await tool.handler({ query: "auth refactor", limit: 5, sort: "newest" });

    expect(req()).toMatchObject({
      kind: "discover",
      query: "auth refactor",
      limit: 5,
      sort: "newest",
    });
  });

  it("infers read from a bare session_id", async () => {
    const { tool, req } = harness();
    await tool.handler({ session_id: "ses_9" });

    expect(req()).toEqual({ kind: "read", session_id: "ses_9" });
  });

  it("infers scroll from session_id + around_message_id", async () => {
    const { tool, req } = harness();
    await tool.handler({
      session_id: "ses_9",
      around_message_id: "evt_3",
      window: 10,
    });

    expect(req()).toEqual({
      kind: "scroll",
      session_id: "ses_9",
      around_message_id: "evt_3",
      window: 10,
    });
  });

  // Precedence is documented in the tool description: scroll beats read
  // beats discover beats browse. An agent that passes a stale `query`
  // alongside a scroll anchor must still get the scroll.
  it("prefers scroll over discover when a query tags along", async () => {
    const { tool, req } = harness();
    await tool.handler({
      session_id: "ses_9",
      around_message_id: "evt_3",
      query: "ignored",
    });

    expect(req().kind).toBe("scroll");
  });

  it("prefers read over discover when a query tags along", async () => {
    const { tool, req } = harness();
    await tool.handler({ session_id: "ses_9", query: "ignored" });

    expect(req()).toEqual({ kind: "read", session_id: "ses_9" });
  });

  it("falls back to browse when an anchor arrives without a session_id", async () => {
    const { tool, req } = harness();
    await tool.handler({ around_message_id: "evt_3" });

    expect(req().kind).toBe("browse");
  });

  it("keeps the synthetic user-turn anchor id intact", async () => {
    const { tool, req } = harness();
    await tool.handler({
      session_id: "ses_9",
      around_message_id: "intent:ses_9",
    });

    expect(req()).toMatchObject({ around_message_id: "intent:ses_9" });
  });
});

describe("input coercion", () => {
  it("trims session_id, anchor and query", async () => {
    const { tool, req } = harness();
    await tool.handler({ session_id: "  ses_9  ", around_message_id: " evt_3 " });

    expect(req()).toMatchObject({
      session_id: "ses_9",
      around_message_id: "evt_3",
    });
  });

  it("trims the discover query", async () => {
    const { tool, req } = harness();
    await tool.handler({ query: "  docker networking  " });

    expect(req()).toMatchObject({ query: "docker networking" });
  });

  // Whitespace-only strings are absent, not present-and-empty — a blank
  // session_id must not turn a browse into a read of "".
  it.each([
    ["blank", "   "],
    ["empty", ""],
  ])("treats a %s session_id as absent", async (_label, session_id) => {
    const { tool, req } = harness();
    await tool.handler({ session_id });

    expect(req().kind).toBe("browse");
  });

  it("treats a blank query as absent", async () => {
    const { tool, req } = harness();
    await tool.handler({ query: "   " });

    expect(req().kind).toBe("browse");
  });

  it.each([
    ["session_id", { session_id: 5 }, "browse"],
    ["query", { query: 5 }, "browse"],
    // A non-string anchor demotes scroll to read, not to browse — the
    // session_id is still good.
    ["around_message_id", { session_id: "ses_9", around_message_id: 5 }, "read"],
  ])("ignores a non-string %s", async (_label, input, kind) => {
    const { tool, req } = harness();
    await tool.handler(input as Record<string, unknown>);

    expect(req().kind).toBe(kind);
  });

  it("drops a non-numeric limit, leaving the service default", async () => {
    const { tool, req } = harness();
    await tool.handler({ query: "x", limit: "3" });

    expect(req()).toMatchObject({ kind: "discover", limit: undefined });
  });

  // Browse carries its own limit (default 5, where discover defaults to 3),
  // so it has to forward the caller's number rather than fall through.
  it("forwards a numeric limit on the browse shape", async () => {
    const { tool, req } = harness();
    await tool.handler({ limit: 8 });

    expect(req()).toMatchObject({ kind: "browse", limit: 8 });
  });

  it("drops a non-numeric window on the scroll shape", async () => {
    const { tool, req } = harness();
    await tool.handler({
      session_id: "ses_9",
      around_message_id: "evt_3",
      window: "10",
    });

    expect(req()).toMatchObject({ window: undefined });
  });

  it("drops an unrecognized sort value", async () => {
    const { tool, req } = harness();
    await tool.handler({ query: "x", sort: "relevance" });

    expect(req()).toMatchObject({ sort: undefined });
  });

  it("forwards filters on discover and browse, but not on read", async () => {
    const filters = { status: "failed" as const };

    const discover = harness();
    await discover.tool.handler({ query: "x", filters });
    expect(discover.req()).toMatchObject({ filters });

    const browse = harness();
    await browse.tool.handler({ filters });
    expect(browse.req()).toMatchObject({ filters });

    const read = harness();
    await read.tool.handler({ session_id: "ses_9", filters });
    expect(read.req()).toEqual({ kind: "read", session_id: "ses_9" });
  });

  it.each([
    ["null", null],
    ["a string", "status:failed"],
  ])("treats %s filters as absent", async (_label, filters) => {
    const { tool, req } = harness();
    await tool.handler({ query: "x", filters });

    expect(req()).toMatchObject({ filters: undefined });
  });
});

describe("caller context", () => {
  it("passes agent id, tier and the active session through to the service", async () => {
    const { tool, search } = harness();
    await tool.handler({ query: "x" });

    // currentSessionId is how the service excludes the caller's own live
    // conversation from its own results.
    expect(search.mock.calls[0]![1]).toEqual({
      callerAgentId: "agent_1",
      hierarchyLevel: "team",
      currentSessionId: "ses_current",
    });
  });
});

describe("results and errors", () => {
  it("returns the service result verbatim on success", async () => {
    const result = { kind: "read", messages: [{ id: "evt_1" }] };
    const { tool } = harness(result);

    const res = await tool.handler({ session_id: "ses_9" });

    expect(res.isError).toBeUndefined();
    expect(res.content).toBe(result);
  });

  // A null return covers three distinct causes the agent can't
  // distinguish, so the message names all of them.
  it("maps a null result to not_found_or_forbidden", async () => {
    const { tool } = harness(null);

    const res = await tool.handler({ session_id: "ses_other" });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("not_found_or_forbidden");
    expect(res.content.message).toContain("not in your scope");
  });

  it.each([
    "forbidden_agent_filter",
    "missing_query",
    "missing_args",
  ] as const)("preserves the %s code from a SessionSearchError", async (code) => {
    const tool = throwingHarness(new SessionSearchError(code, `bad: ${code}`));

    const res = await tool.handler({ query: "x" });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: code, message: `bad: ${code}` });
  });

  // The api consumes core's dist/ while integration scripts consume
  // src/, so the same error class can arrive as a different constructor.
  // Name matching is what keeps the code from degrading to
  // internal_error across that boundary.
  it("recognizes a SessionSearchError from another bundle by name", async () => {
    const impostor = new Error("cross-bundle") as Error & { code: string };
    impostor.name = "SessionSearchError";
    impostor.code = "missing_query";
    const tool = throwingHarness(impostor);

    const res = await tool.handler({ query: "x" });

    expect(res.content).toEqual({
      error: "missing_query",
      message: "cross-bundle",
    });
  });

  it("wraps an unexpected Error as internal_error", async () => {
    const tool = throwingHarness(new Error("pool timeout"));

    const res = await tool.handler({ query: "x" });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "internal_error",
      message: "pool timeout",
    });
  });

  it("stringifies a non-Error throw as internal_error", async () => {
    const tool = throwingHarness("kaboom");

    const res = await tool.handler({ query: "x" });

    expect(res.content).toEqual({ error: "internal_error", message: "kaboom" });
  });

  // A plain Error whose name happens not to be SessionSearchError must
  // not smuggle its `code` into the envelope.
  it("does not treat an arbitrary error with a code as a SessionSearchError", async () => {
    const err = new Error("nope") as Error & { code: string };
    err.code = "ENOTFOUND";
    const tool = throwingHarness(err);

    const res = await tool.handler({ query: "x" });

    expect(res.content.error).toBe("internal_error");
  });
});
