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
  sessionId: "sess_current",
};

/** Caller scope, as the tool hands it to the service. */
interface CallerScope {
  callerAgentId: string;
  hierarchyLevel: string;
  currentSessionId: string;
}

function fakeService(impl?: () => unknown) {
  // Typed args so the assertions below can read `mock.calls[n][0|1]`.
  const search = vi.fn(
    async (_req: SessionSearchRequest, _scope: CallerScope): Promise<unknown> =>
      impl ? impl() : { kind: "browse", sessions: [] },
  );
  return {
    search,
    sessionSearch: { search } as unknown as SessionSearchService,
  };
}

function build(ctx: Partial<SessionSearchToolContext> = {}, fake = fakeService()) {
  const tool = createSessionSearchTool({ ...CTX, ...ctx }, {
    sessionSearch: fake.sessionSearch,
  });
  return { tool, fake };
}

/** The request the service was handed on the most recent call. */
function lastRequest(fake: ReturnType<typeof fakeService>): SessionSearchRequest {
  const call = fake.search.mock.calls.at(-1);
  if (!call) throw new Error("service was never called");
  return call[0];
}

describe("session_search tool definition", () => {
  it("exposes the four calling shapes on its schema", () => {
    const { tool } = build();
    const props = tool.schema.properties as Record<string, unknown>;

    expect(tool.name).toBe("session_search");
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining([
        "query",
        "limit",
        "sort",
        "session_id",
        "around_message_id",
        "window",
        "filters",
      ]),
    );
    // No `required` — every shape, browse included, is a legal call.
    expect(tool.schema.required).toBeUndefined();
  });
});

describe("session_search shape inference", () => {
  it("infers scroll when session_id and around_message_id are both set", async () => {
    const { tool, fake } = build();

    await tool.handler({
      session_id: "sess_1",
      around_message_id: "evt_5",
      window: 10,
      // A query alongside a scroll is ignored — scroll wins.
      query: "ignored",
    });

    expect(lastRequest(fake)).toEqual({
      kind: "scroll",
      session_id: "sess_1",
      around_message_id: "evt_5",
      window: 10,
    });
  });

  it("trims the ids it infers a scroll from", async () => {
    const { tool, fake } = build();

    await tool.handler({
      session_id: "  sess_1  ",
      around_message_id: "  evt_5  ",
    });

    expect(lastRequest(fake)).toMatchObject({
      kind: "scroll",
      session_id: "sess_1",
      around_message_id: "evt_5",
    });
  });

  it("leaves window undefined when it is absent or not a number", async () => {
    const { tool, fake } = build();

    await tool.handler({ session_id: "sess_1", around_message_id: "evt_5" });
    expect(lastRequest(fake)).toMatchObject({ window: undefined });

    await tool.handler({
      session_id: "sess_1",
      around_message_id: "evt_5",
      window: "10",
    });
    expect(lastRequest(fake)).toMatchObject({ window: undefined });
  });

  it("infers read from a bare session_id", async () => {
    const { tool, fake } = build();

    await tool.handler({ session_id: "sess_1", limit: 5 });

    expect(lastRequest(fake)).toEqual({ kind: "read", session_id: "sess_1" });
  });

  it("infers read when around_message_id is blank", async () => {
    const { tool, fake } = build();

    await tool.handler({ session_id: "sess_1", around_message_id: "   " });

    expect(lastRequest(fake)).toEqual({ kind: "read", session_id: "sess_1" });
  });

  it("infers discover from a query, passing limit, sort and filters", async () => {
    const { tool, fake } = build();

    await tool.handler({
      query: "  auth refactor  ",
      limit: 3,
      sort: "newest",
      filters: { status: "failed" },
    });

    expect(lastRequest(fake)).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: 3,
      sort: "newest",
      filters: { status: "failed" },
    });
  });

  it("drops a sort that is not 'newest' or 'oldest'", async () => {
    const { tool, fake } = build();

    await tool.handler({ query: "x", sort: "relevance" });

    expect(lastRequest(fake)).toMatchObject({ kind: "discover", sort: undefined });
  });

  it("infers browse when nothing identifying is passed", async () => {
    const { tool, fake } = build();

    await tool.handler({});

    expect(lastRequest(fake)).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("infers browse when session_id and query are blank strings", async () => {
    const { tool, fake } = build();

    await tool.handler({ session_id: "  ", query: "  ", limit: 5 });

    expect(lastRequest(fake)).toMatchObject({ kind: "browse", limit: 5 });
  });

  it("drops a filters value that is not an object", async () => {
    const { tool, fake } = build();

    await tool.handler({ filters: "status:failed" });
    expect(lastRequest(fake)).toMatchObject({ filters: undefined });

    await tool.handler({ filters: null });
    expect(lastRequest(fake)).toMatchObject({ filters: undefined });
  });
});

describe("session_search caller scope", () => {
  it("forwards the caller's identity, tier and active session", async () => {
    const { tool, fake } = build();

    await tool.handler({ query: "x" });

    expect(fake.search.mock.calls[0]?.[1]).toEqual({
      callerAgentId: "agent_a",
      hierarchyLevel: "team",
      currentSessionId: "sess_current",
    });
  });
});

describe("session_search results and errors", () => {
  it("returns the service result verbatim", async () => {
    const payload = { kind: "read", session_id: "sess_1", messages: [{ id: "evt_1" }] };
    const { tool } = build({}, fakeService(() => payload));

    const result = await tool.handler({ session_id: "sess_1" });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual(payload);
  });

  it("maps a null result to not_found_or_forbidden", async () => {
    const { tool } = build({}, fakeService(() => null));

    const result = await tool.handler({ session_id: "sess_other" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "not_found_or_forbidden" });
  });

  it("surfaces a SessionSearchError's code", async () => {
    const { tool } = build(
      {},
      fakeService(() => {
        throw new SessionSearchError("forbidden_agent_filter", "out of scope");
      }),
    );

    const result = await tool.handler({ query: "x", filters: { agent_id: "agent_z" } });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "forbidden_agent_filter",
      message: "out of scope",
    });
  });

  it("surfaces the code of a structurally identical error from another bundle", async () => {
    // The api consumes core's dist/ while some scripts consume src/, so the
    // handler matches on `name` too. Simulate the cross-bundle instance.
    const foreign = new Error("query required");
    foreign.name = "SessionSearchError";
    (foreign as Error & { code: string }).code = "missing_query";

    const { tool } = build(
      {},
      fakeService(() => {
        throw foreign;
      }),
    );

    const result = await tool.handler({});

    expect(result.content).toEqual({
      error: "missing_query",
      message: "query required",
    });
  });

  it("wraps an unrelated throw as internal_error", async () => {
    const { tool } = build(
      {},
      fakeService(() => {
        throw new Error("pg down");
      }),
    );

    const result = await tool.handler({ query: "x" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "internal_error",
      message: "pg down",
    });
  });

  it("stringifies a non-Error throw", async () => {
    const { tool } = build(
      {},
      fakeService(() => {
        throw "boom";
      }),
    );

    const result = await tool.handler({ query: "x" });

    expect(result.content).toEqual({ error: "internal_error", message: "boom" });
  });
});
