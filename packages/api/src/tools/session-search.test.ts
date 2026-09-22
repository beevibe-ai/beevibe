/**
 * session_search handler tests.
 *
 * Two things live in this module and nowhere else: the shape inference
 * that turns loose tool input into one of four typed requests, and the
 * error mapping the agent branches on. `inferRequest` isn't exported, so
 * it's exercised through the handler with a recording fake service —
 * which is also how the real agent reaches it.
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
  agentId: "agent_1",
  hierarchyLevel: "team",
  sessionId: "ses_current",
};

function harness(
  search: SessionSearchService["search"] = vi.fn().mockResolvedValue({ ok: true }),
  ctx: Partial<SessionSearchToolContext> = {},
) {
  const spy = vi.fn(search);
  const tool = createSessionSearchTool({ ...CTX, ...ctx }, {
    sessionSearch: { search: spy } as unknown as SessionSearchService,
  });
  return { tool, spy };
}

/** The request the handler inferred from a given raw input. */
async function inferred(input: Record<string, unknown>): Promise<SessionSearchRequest> {
  const h = harness();
  await h.tool.handler(input);
  return h.spy.mock.calls[0]![0] as SessionSearchRequest;
}

describe("shape inference", () => {
  it("infers browse when nothing identifying is passed", async () => {
    expect(await inferred({})).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("infers discover from a query", async () => {
    expect(await inferred({ query: "auth refactor", limit: 3 })).toMatchObject({
      kind: "discover",
      query: "auth refactor",
      limit: 3,
    });
  });

  it("infers read from a bare session_id", async () => {
    expect(await inferred({ session_id: "ses_9" })).toEqual({
      kind: "read",
      session_id: "ses_9",
    });
  });

  it("infers scroll when session_id and around_message_id are both present", async () => {
    expect(
      await inferred({ session_id: "ses_9", around_message_id: "msg_4", window: 3 }),
    ).toEqual({
      kind: "scroll",
      session_id: "ses_9",
      around_message_id: "msg_4",
      window: 3,
    });
  });

  it("lets scroll win over discover when a query is also passed", async () => {
    // Documented precedence: the most specific shape the input supports.
    const req = await inferred({
      session_id: "ses_9",
      around_message_id: "msg_4",
      query: "ignored",
    });
    expect(req.kind).toBe("scroll");
  });

  it("lets read win over discover when a query is also passed", async () => {
    const req = await inferred({ session_id: "ses_9", query: "ignored" });
    expect(req.kind).toBe("read");
  });

  it("falls back to discover when around_message_id arrives without a session_id", async () => {
    // A bare anchor can't identify a conversation, so it can't be scroll.
    const req = await inferred({ around_message_id: "msg_4", query: "auth" });
    expect(req.kind).toBe("discover");
  });

  it("falls back to browse when an anchor arrives with neither session nor query", async () => {
    const req = await inferred({ around_message_id: "msg_4" });
    expect(req.kind).toBe("browse");
  });

  it("trims the identifying strings", async () => {
    expect(
      await inferred({ session_id: "  ses_9  ", around_message_id: "  msg_4  " }),
    ).toMatchObject({ session_id: "ses_9", around_message_id: "msg_4" });

    expect(await inferred({ query: "  auth  " })).toMatchObject({ query: "auth" });
  });

  it.each([
    ["whitespace-only", "   "],
    ["empty", ""],
    ["not a string", 42],
  ])("treats a %s session_id as absent", async (_label, sessionId) => {
    const req = await inferred({ session_id: sessionId, query: "auth" });
    expect(req.kind).toBe("discover");
  });

  it.each([
    ["whitespace-only", "   "],
    ["empty", ""],
    ["not a string", 42],
  ])("treats a %s query as absent", async (_label, query) => {
    const req = await inferred({ query });
    expect(req.kind).toBe("browse");
  });

  it("drops a non-numeric window, limit and sort rather than forwarding them", async () => {
    const scroll = await inferred({
      session_id: "ses_9",
      around_message_id: "msg_4",
      window: "3",
    });
    expect(scroll).toMatchObject({ window: undefined });

    const discover = await inferred({ query: "a", limit: "3", sort: "sideways" });
    expect(discover).toMatchObject({ limit: undefined, sort: undefined });
  });

  it.each(["newest", "oldest"])("keeps the %s sort on discovery", async (sort) => {
    expect(await inferred({ query: "a", sort })).toMatchObject({ sort });
  });

  it("forwards filters on discover and browse", async () => {
    const filters = { session_type: "chat", status: "failed" };
    expect(await inferred({ query: "a", filters })).toMatchObject({ filters });
    expect(await inferred({ filters })).toMatchObject({ filters });
  });

  it.each([
    ["null", null],
    ["not an object", "chat"],
  ])("drops %s filters", async (_label, filters) => {
    expect(await inferred({ filters })).toMatchObject({ filters: undefined });
  });
});

describe("caller context", () => {
  it("passes the caller's identity, tier and current session to the service", async () => {
    const h = harness(vi.fn().mockResolvedValue({ ok: true }), {
      agentId: "agent_42",
      hierarchyLevel: "ic",
      sessionId: "ses_live",
    });

    await h.tool.handler({ query: "a" });

    expect(h.spy.mock.calls[0]![1]).toEqual({
      callerAgentId: "agent_42",
      hierarchyLevel: "ic",
      currentSessionId: "ses_live",
    });
  });

  it("returns the service result verbatim on success", async () => {
    const result = { kind: "browse", sessions: [{ id: "ses_1" }] };
    const h = harness(vi.fn().mockResolvedValue(result));

    const res = await h.tool.handler({});

    expect(res.isError).toBeUndefined();
    expect(res.content).toBe(result);
  });
});

describe("error mapping", () => {
  it("turns a null result into one not_found_or_forbidden envelope", async () => {
    // The service deliberately collapses "doesn't exist", "out of scope"
    // and "anchor is in your live conversation" into null so the tool
    // can't be used to probe for session ids outside the caller's tier.
    const h = harness(vi.fn().mockResolvedValue(null));

    const res = await h.tool.handler({ session_id: "ses_other" });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("not_found_or_forbidden");
  });

  it.each([
    "forbidden_agent_filter",
    "missing_query",
    "missing_args",
  ] as const)("surfaces the %s code from a SessionSearchError", async (code) => {
    const h = harness(
      vi.fn().mockRejectedValue(new SessionSearchError(code, `nope: ${code}`)),
    );

    const res = await h.tool.handler({ query: "a" });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: code, message: `nope: ${code}` });
  });

  it("recognizes a SessionSearchError from another bundle by name", async () => {
    // An integration script consuming core's src/ while api consumes
    // dist/ produces a structurally identical error that fails
    // `instanceof`. The name check is what keeps the code from
    // degrading to internal_error in that setup.
    const foreign = new Error("cross-bundle");
    foreign.name = "SessionSearchError";
    (foreign as Error & { code: string }).code = "missing_query";
    const h = harness(vi.fn().mockRejectedValue(foreign));

    const res = await h.tool.handler({ query: "a" });

    expect(res.content).toEqual({ error: "missing_query", message: "cross-bundle" });
  });

  it("does not mistake an unrelated Error for a search error", async () => {
    const h = harness(vi.fn().mockRejectedValue(new Error("pool timeout")));

    const res = await h.tool.handler({ query: "a" });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "internal_error",
      message: "pool timeout",
    });
  });

  it("stringifies a non-Error throw", async () => {
    const h = harness(vi.fn().mockRejectedValue("pg died"));

    const res = await h.tool.handler({ query: "a" });

    expect(res.content).toEqual({ error: "internal_error", message: "pg died" });
  });
});
