/**
 * session_search MCP tool — unit tests with vitest fakes (no DB).
 *
 * The tool's own logic is `inferRequest`: four calling shapes
 * discriminated from one flat input bag, with a documented precedence
 * (session_id + anchor → scroll beats bare session_id → read beats
 * query → discover beats nothing → browse). Everything else is
 * delegation to SessionSearchService plus the error envelope, including
 * the deliberate name-based SessionSearchError match that keeps the
 * structured code when src/ and dist/ copies of the class are both in
 * play.
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
  agentId: "agent_a",
  hierarchyLevel: "team",
  sessionId: "sess_current1",
};

type SearchFn = SessionSearchService["search"];

function makeService(impl?: SearchFn) {
  const search = vi.fn(
    impl ?? (async () => ({ kind: "browse", sessions: [] }) as never),
  ) as unknown as SearchFn;
  return {
    service: { search } as unknown as SessionSearchService,
    search: search as unknown as ReturnType<typeof vi.fn>,
  };
}

function tool(service: SessionSearchService, ctx: SessionSearchToolContext = CTX) {
  return createSessionSearchTool(ctx, { sessionSearch: service });
}

/** Run the handler and hand back the request inferRequest produced. */
async function requestFor(
  input: Record<string, unknown>,
): Promise<SessionSearchRequest> {
  const { service, search } = makeService();
  await tool(service).handler(input);
  return search.mock.calls[0]?.[0] as SessionSearchRequest;
}

// ── shape inference ──────────────────────────────────────────────────────

describe("session_search shape inference", () => {
  it("infers browse from an empty input", async () => {
    expect(await requestFor({})).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("infers discover from a query", async () => {
    expect(await requestFor({ query: "auth refactor" })).toMatchObject({
      kind: "discover",
      query: "auth refactor",
    });
  });

  it("infers read from a bare session_id", async () => {
    expect(await requestFor({ session_id: "sess_abc" })).toEqual({
      kind: "read",
      session_id: "sess_abc",
    });
  });

  it("infers scroll when session_id and around_message_id are both present", async () => {
    expect(
      await requestFor({ session_id: "sess_abc", around_message_id: "evt_9" }),
    ).toEqual({
      kind: "scroll",
      session_id: "sess_abc",
      around_message_id: "evt_9",
      window: undefined,
    });
  });

  it("lets scroll win over read and discover when all three fields are set", async () => {
    const req = await requestFor({
      session_id: "sess_abc",
      around_message_id: "evt_9",
      query: "ignored",
    });
    expect(req.kind).toBe("scroll");
  });

  it("lets read win over discover when session_id and query are both set", async () => {
    const req = await requestFor({ session_id: "sess_abc", query: "ignored" });
    expect(req.kind).toBe("read");
  });

  it("falls back to read when around_message_id is blank", async () => {
    const req = await requestFor({ session_id: "sess_abc", around_message_id: "   " });
    expect(req.kind).toBe("read");
  });

  it("trims session_id, anchor and query", async () => {
    expect(
      await requestFor({ session_id: "  sess_abc  ", around_message_id: "  evt_9  " }),
    ).toMatchObject({ session_id: "sess_abc", around_message_id: "evt_9" });
    expect(await requestFor({ query: "  auth  " })).toMatchObject({ query: "auth" });
  });

  it.each([
    ["blank", "   "],
    ["empty", ""],
    ["a non-string", 42],
  ])("treats a %s session_id as absent and browses", async (_label, sessionId) => {
    const req = await requestFor({ session_id: sessionId });
    expect(req.kind).toBe("browse");
  });

  it.each([
    ["blank", "   "],
    ["empty", ""],
    ["a non-string", 42],
  ])("treats a %s query as absent and browses", async (_label, query) => {
    const req = await requestFor({ query });
    expect(req.kind).toBe("browse");
  });

  it("accepts an anchor in the intent:<session_id> form for a user turn", async () => {
    expect(
      await requestFor({ session_id: "sess_abc", around_message_id: "intent:sess_abc" }),
    ).toMatchObject({ kind: "scroll", around_message_id: "intent:sess_abc" });
  });
});

// ── optional parameter passthrough ───────────────────────────────────────

describe("session_search optional parameters", () => {
  it("passes a numeric window on scroll and drops a non-numeric one", async () => {
    expect(
      await requestFor({ session_id: "s", around_message_id: "e", window: 12 }),
    ).toMatchObject({ window: 12 });
    expect(
      await requestFor({ session_id: "s", around_message_id: "e", window: "12" }),
    ).toMatchObject({ window: undefined });
  });

  it("passes a numeric limit on discover and browse, dropping a non-numeric one", async () => {
    expect(await requestFor({ query: "x", limit: 7 })).toMatchObject({ limit: 7 });
    expect(await requestFor({ limit: 7 })).toMatchObject({ limit: 7 });
    expect(await requestFor({ query: "x", limit: "7" })).toMatchObject({
      limit: undefined,
    });
  });

  it.each(["newest", "oldest"])("passes sort=%s through on discover", async (sort) => {
    expect(await requestFor({ query: "x", sort })).toMatchObject({ sort });
  });

  it("drops an unrecognized sort rather than forwarding it", async () => {
    expect(await requestFor({ query: "x", sort: "relevance" })).toMatchObject({
      sort: undefined,
    });
  });

  it("forwards a filters object on discover and browse", async () => {
    const filters = { type: "chat", status: "failed", agent_id: "agent_b" };
    expect(await requestFor({ query: "x", filters })).toMatchObject({ filters });
    expect(await requestFor({ filters })).toMatchObject({ filters });
  });

  it("drops a null or non-object filters", async () => {
    expect(await requestFor({ query: "x", filters: null })).toMatchObject({
      filters: undefined,
    });
    expect(await requestFor({ query: "x", filters: "chat" })).toMatchObject({
      filters: undefined,
    });
  });

  it("ignores filters on the scroll and read shapes", async () => {
    const scroll = await requestFor({
      session_id: "s",
      around_message_id: "e",
      filters: { type: "chat" },
    });
    expect(scroll).not.toHaveProperty("filters");
    const read = await requestFor({ session_id: "s", filters: { type: "chat" } });
    expect(read).toEqual({ kind: "read", session_id: "s" });
  });
});

// ── caller context + results ─────────────────────────────────────────────

describe("session_search delegation", () => {
  it("threads the caller's agent id, tier and current session into the scope context", async () => {
    const { service, search } = makeService();

    await tool(service).handler({ query: "x" });

    expect(search.mock.calls[0]?.[1]).toEqual({
      callerAgentId: "agent_a",
      hierarchyLevel: "team",
      currentSessionId: "sess_current1",
    });
  });

  it("returns the service result verbatim as the tool content", async () => {
    const payload = { kind: "read", session: { id: "sess_abc" }, messages: [] };
    const { service } = makeService(async () => payload as never);

    const result = await tool(service).handler({ session_id: "sess_abc" });

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe(payload);
  });

  it("maps a null result to not_found_or_forbidden", async () => {
    const { service } = makeService(async () => null as never);

    const result = await tool(service).handler({ session_id: "sess_other" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "not_found_or_forbidden" });
    expect(String((result.content as Record<string, unknown>).message)).toContain("scope");
  });

  it("names itself session_search and ships a schema the MCP client can read", () => {
    const built = tool(makeService().service);
    expect(built.name).toBe("session_search");
    expect(built.description.length).toBeGreaterThan(100);
    expect((built.schema as { type: string }).type).toBe("object");
  });
});

// ── error envelope ───────────────────────────────────────────────────────

describe("session_search error envelope", () => {
  it.each([
    "forbidden_agent_filter",
    "missing_query",
    "missing_args",
  ] as const)("surfaces a SessionSearchError's %s code", async (code) => {
    const { service } = makeService(async () => {
      throw new SessionSearchError(code, `failed: ${code}`);
    });

    const result = await tool(service).handler({ query: "x" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: code, message: `failed: ${code}` });
  });

  it("still surfaces the code for a cross-bundle error matched by name only", async () => {
    // An Error from another copy of the class fails `instanceof`; the
    // handler matches on `.name` so the agent keeps its branchable code.
    const foreign = Object.assign(new Error("not your agent"), {
      name: "SessionSearchError",
      code: "forbidden_agent_filter",
    });
    const { service } = makeService(async () => {
      throw foreign;
    });

    const result = await tool(service).handler({ query: "x" });

    expect(result.content).toEqual({
      error: "forbidden_agent_filter",
      message: "not your agent",
    });
  });

  it("wraps an unexpected Error as internal_error", async () => {
    const { service } = makeService(async () => {
      throw new Error("tsquery syntax error");
    });

    const result = await tool(service).handler({ query: "x" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "internal_error",
      message: "tsquery syntax error",
    });
  });

  it("stringifies a non-Error throw as internal_error", async () => {
    const { service } = makeService(async () => {
      throw "boom";
    });

    const result = await tool(service).handler({});

    expect(result.content).toEqual({ error: "internal_error", message: "boom" });
  });
});
