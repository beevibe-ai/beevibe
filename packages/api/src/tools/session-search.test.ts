/**
 * session_search MCP tool — unit tests with a fake SessionSearchService.
 *
 * The tool's real work is `inferRequest`: it turns the loose,
 * four-shapes-in-one-signature MCP input into one of the four typed
 * `SessionSearchRequest` variants. The shape ladder is order-sensitive
 * (scroll beats read beats discover beats browse), and the whole thing
 * is reachable only through the handler, so these tests drive the
 * handler and assert on what the service was handed.
 *
 * The service is faked — its scoping and FTS behaviour belong to
 * `core/src/services/session-search.test.ts`, which needs a real
 * Postgres. What's left here is the mapping plus two failure surfaces:
 * the `null` return (out of scope / bad anchor) and the
 * SessionSearchError code passthrough, including the name-matched
 * branch that exists for cross-bundle (src vs dist) imports.
 */
import { describe, expect, it, vi } from "vitest";
import { SessionSearchError } from "@beevibe/core/services/session-search";
import type { SessionSearchService } from "@beevibe/core/services/session-search";
import { createSessionSearchTool, type SessionSearchToolContext } from "./session-search.js";

const CTX: SessionSearchToolContext = {
  agentId: "agent_team",
  hierarchyLevel: "team",
  sessionId: "sess_current0001",
};

function makeService(result: unknown = { kind: "browse", sessions: [] }) {
  return {
    search: vi.fn().mockResolvedValue(result),
  } as unknown as SessionSearchService & { search: ReturnType<typeof vi.fn> };
}

function build(service = makeService(), ctx: Partial<SessionSearchToolContext> = {}) {
  return { tool: createSessionSearchTool({ ...CTX, ...ctx }, { sessionSearch: service }), service };
}

/** Drive the handler and hand back the request the service received. */
async function requestFor(input: Record<string, unknown>) {
  const { tool, service } = build();
  await tool.handler(input);
  return service.search.mock.calls[0]![0];
}

describe("createSessionSearchTool", () => {
  it("exposes the session_search name and a thick agent-facing description", () => {
    const { tool } = build();
    expect(tool.name).toBe("session_search");
    // The description is the contract; it has to spell out all four shapes.
    for (const shape of ["DISCOVERY", "SCROLL", "READ", "BROWSE"]) {
      expect(tool.description).toContain(shape);
    }
  });

  it("passes the caller context through on every call", async () => {
    const { tool, service } = build();
    await tool.handler({ query: "auth refactor" });

    expect(service.search.mock.calls[0]![1]).toEqual({
      callerAgentId: "agent_team",
      hierarchyLevel: "team",
      currentSessionId: "sess_current0001",
    });
  });
});

describe("session_search — shape inference", () => {
  it("infers scroll when session_id and around_message_id are both set", async () => {
    expect(
      await requestFor({
        session_id: "sess_a",
        around_message_id: "evt_1",
        window: 10,
      }),
    ).toEqual({
      kind: "scroll",
      session_id: "sess_a",
      around_message_id: "evt_1",
      window: 10,
    });
  });

  it("leaves window undefined on scroll when it isn't a number — the service clamps", async () => {
    expect(
      await requestFor({ session_id: "sess_a", around_message_id: "evt_1", window: "10" }),
    ).toMatchObject({ kind: "scroll", window: undefined });
  });

  it("infers read from a bare session_id", async () => {
    expect(await requestFor({ session_id: "sess_a" })).toEqual({
      kind: "read",
      session_id: "sess_a",
    });
  });

  it("falls back to read when the anchor is present but blank", async () => {
    expect(await requestFor({ session_id: "sess_a", around_message_id: "   " })).toEqual({
      kind: "read",
      session_id: "sess_a",
    });
  });

  it("infers discover from a query, carrying limit, sort and filters", async () => {
    expect(
      await requestFor({
        query: "auth refactor",
        limit: 3,
        sort: "oldest",
        filters: { type: "chat", status: "failed" },
      }),
    ).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: 3,
      sort: "oldest",
      filters: { type: "chat", status: "failed" },
    });
  });

  it("drops an unrecognized sort rather than passing it down", async () => {
    expect(await requestFor({ query: "auth", sort: "relevance" })).toMatchObject({
      kind: "discover",
      sort: undefined,
    });
  });

  it("infers browse when nothing identifying is passed", async () => {
    expect(await requestFor({})).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("keeps limit and filters on the browse shape", async () => {
    expect(await requestFor({ limit: 5, filters: { agent_id: "agent_ic" } })).toEqual({
      kind: "browse",
      limit: 5,
      filters: { agent_id: "agent_ic" },
    });
  });

  it("prefers scroll over discover when a query is passed alongside an anchor", async () => {
    // Ambiguous input from the agent — the ladder resolves it, and this
    // pins which way.
    expect(
      await requestFor({ session_id: "sess_a", around_message_id: "evt_1", query: "auth" }),
    ).toMatchObject({ kind: "scroll" });
  });

  it("prefers read over discover when a query is passed alongside a session_id", async () => {
    expect(await requestFor({ session_id: "sess_a", query: "auth" })).toMatchObject({
      kind: "read",
    });
  });

  it.each([
    ["blank strings", { session_id: "  ", query: "  " }],
    ["non-strings", { session_id: 1, around_message_id: 2, query: 3 }],
    ["null filters", { filters: null }],
  ])("treats %s as browse", async (_label, input) => {
    expect(await requestFor(input)).toMatchObject({ kind: "browse" });
  });

  it("trims the identifying strings before handing them to the service", async () => {
    expect(await requestFor({ session_id: "  sess_a  ", around_message_id: " evt_1 " })).toEqual({
      kind: "scroll",
      session_id: "sess_a",
      around_message_id: "evt_1",
      window: undefined,
    });
    expect(await requestFor({ query: "  auth refactor  " })).toMatchObject({
      query: "auth refactor",
    });
  });
});

describe("session_search — results and failures", () => {
  it("returns the service result verbatim on success", async () => {
    const result = { kind: "discover", results: [{ session: { id: "sess_a" } }] };
    const { tool } = build(makeService(result));

    const res = await tool.handler({ query: "auth" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual(result);
  });

  it("maps a null result onto not_found_or_forbidden", async () => {
    // The service returns null for three distinct causes; the tool
    // deliberately collapses them into one message so a probing agent
    // can't distinguish "doesn't exist" from "not yours".
    const { tool } = build(makeService(null));

    const res = await tool.handler({ session_id: "sess_someone_else" });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("not_found_or_forbidden");
    expect(res.content.message).toMatch(/not in your scope/);
  });

  it.each(["forbidden_agent_filter", "missing_query", "missing_args"] as const)(
    "passes a SessionSearchError's %s code straight through",
    async (code) => {
      const service = makeService();
      service.search.mockRejectedValue(new SessionSearchError(code, `bad: ${code}`));
      const { tool } = build(service);

      const res = await tool.handler({ query: "auth" });
      expect(res.isError).toBe(true);
      expect(res.content).toEqual({ error: code, message: `bad: ${code}` });
    },
  );

  it("recognizes a SessionSearchError by name across bundle boundaries", async () => {
    // An integration script consuming core's src/ while the api consumes
    // dist/ throws a structurally identical but not `instanceof`-equal
    // error. The name check is what keeps the code from degrading to
    // internal_error.
    class ForeignSessionSearchError extends Error {
      code = "missing_query";
      constructor() {
        super("query is required");
        this.name = "SessionSearchError";
      }
    }
    const service = makeService();
    service.search.mockRejectedValue(new ForeignSessionSearchError());
    const { tool } = build(service);

    const res = await tool.handler({ query: "auth" });
    expect(res.content).toEqual({ error: "missing_query", message: "query is required" });
  });

  it("wraps an unexpected throw as internal_error", async () => {
    const service = makeService();
    service.search.mockRejectedValue(new Error("connection terminated"));
    const { tool } = build(service);

    const res = await tool.handler({ query: "auth" });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "internal_error",
      message: "connection terminated",
    });
  });

  it("stringifies a non-Error throw", async () => {
    const service = makeService();
    service.search.mockRejectedValue("nope");
    const { tool } = build(service);

    expect((await tool.handler({})).content).toEqual({
      error: "internal_error",
      message: "nope",
    });
  });
});
