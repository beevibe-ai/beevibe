/**
 * session_search handler tests.
 *
 * The service (scope resolution, FTS, bookends) is covered against a real
 * Postgres in core. The adapter's own job is shape inference — turning a
 * loose `Record<string, unknown>` of MCP input into one of the four
 * `SessionSearchRequest` kinds — plus the error envelope. Both are pure,
 * so a fake service that records the request it was handed is enough.
 *
 * Shape inference is worth locking down precisely: the precedence rules
 * (scroll beats read beats discover beats browse) are what decide
 * whether an agent passing both `query` and `session_id` gets an FTS
 * search or a transcript dump.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { SessionSearchRequest } from "@beevibe/core";
import {
  SessionSearchError,
  type SessionSearchService,
} from "@beevibe/core/services/session-search";
import {
  createSessionSearchTool,
  type SessionSearchToolContext,
} from "./session-search.js";
import type { AgentTool } from "./types.js";

type SearchCtx = {
  callerAgentId: string;
  hierarchyLevel: string;
  currentSessionId: string;
};

class FakeSessionSearch {
  requests: SessionSearchRequest[] = [];
  contexts: SearchCtx[] = [];
  /** Resolved value; `null` models not-found-or-out-of-scope. */
  result: unknown = { kind: "browse", sessions: [] };
  throws: unknown = null;

  async search(req: SessionSearchRequest, ctx: SearchCtx): Promise<unknown> {
    this.requests.push(req);
    this.contexts.push(ctx);
    if (this.throws) throw this.throws;
    return this.result;
  }
}

let fake: FakeSessionSearch;

function tool(ctx: Partial<SessionSearchToolContext> = {}): AgentTool {
  return createSessionSearchTool(
    {
      agentId: "agent_1",
      hierarchyLevel: "team",
      sessionId: "ses_current",
      ...ctx,
    },
    { sessionSearch: fake as unknown as SessionSearchService },
  );
}

/** Run the handler and return the request the service received. */
async function requestFor(
  input: Record<string, unknown>,
): Promise<SessionSearchRequest> {
  await tool().handler(input);
  return fake.requests.at(-1)!;
}

beforeEach(() => {
  fake = new FakeSessionSearch();
});

describe("createSessionSearchTool", () => {
  it("is named session_search and takes no required args", () => {
    const t = tool();
    expect(t.name).toBe("session_search");
    // Every shape is optional — the bare call is the browse shape.
    expect((t.schema as { required?: string[] }).required).toBeUndefined();
  });

  it("passes the caller's identity and tier through as search context", async () => {
    await tool({
      agentId: "agent_9",
      hierarchyLevel: "org",
      sessionId: "ses_9",
    }).handler({});

    expect(fake.contexts).toEqual([
      {
        callerAgentId: "agent_9",
        hierarchyLevel: "org",
        currentSessionId: "ses_9",
      },
    ]);
  });

  it("returns the service result verbatim", async () => {
    fake.result = { kind: "read", messages: [{ id: "evt_1" }] };

    const res = await tool().handler({ session_id: "ses_x" });

    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({ kind: "read", messages: [{ id: "evt_1" }] });
  });
});

describe("shape inference", () => {
  it("infers browse from no arguments", async () => {
    expect(await requestFor({})).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("carries a numeric limit onto the browse shape", async () => {
    expect(await requestFor({ limit: 10 })).toEqual({
      kind: "browse",
      limit: 10,
      filters: undefined,
    });
  });

  it("infers discover from a query", async () => {
    expect(
      await requestFor({ query: "  auth refactor  ", limit: 7, sort: "newest" }),
    ).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: 7,
      sort: "newest",
      filters: undefined,
    });
  });

  it("infers read from a bare session_id", async () => {
    expect(await requestFor({ session_id: "  ses_x  " })).toEqual({
      kind: "read",
      session_id: "ses_x",
    });
  });

  it("infers scroll from session_id + around_message_id", async () => {
    expect(
      await requestFor({
        session_id: "ses_x",
        around_message_id: "  evt_7  ",
        window: 12,
      }),
    ).toEqual({
      kind: "scroll",
      session_id: "ses_x",
      around_message_id: "evt_7",
      window: 12,
    });
  });

  it("lets scroll win over discover when a query is also present", async () => {
    // The tool description promises `query` is ignored once the scroll
    // args are set; an agent that pastes both should still get the window.
    const req = await requestFor({
      query: "auth",
      session_id: "ses_x",
      around_message_id: "evt_7",
    });
    expect(req.kind).toBe("scroll");
  });

  it("lets read win over discover when both session_id and query are present", async () => {
    const req = await requestFor({ query: "auth", session_id: "ses_x" });
    expect(req.kind).toBe("read");
  });

  it("falls back to browse when the query is blank or not a string", async () => {
    expect((await requestFor({ query: "   " })).kind).toBe("browse");
    expect((await requestFor({ query: 42 })).kind).toBe("browse");
  });

  it("ignores a blank session_id rather than reading an empty id", async () => {
    expect((await requestFor({ session_id: "   " })).kind).toBe("browse");
    expect((await requestFor({ session_id: "  ", query: "auth" })).kind).toBe(
      "discover",
    );
  });

  it("ignores a blank anchor, degrading scroll to read", async () => {
    const req = await requestFor({
      session_id: "ses_x",
      around_message_id: "   ",
    });
    expect(req).toEqual({ kind: "read", session_id: "ses_x" });
  });

  it("drops non-numeric limit and window instead of forwarding them", async () => {
    expect((await requestFor({ query: "a", limit: "5" })).kind).toBe("discover");
    expect(fake.requests.at(-1)).toMatchObject({ limit: undefined });

    await requestFor({
      session_id: "s",
      around_message_id: "m",
      window: "10",
    });
    expect(fake.requests.at(-1)).toMatchObject({ window: undefined });
  });

  it("drops an unrecognized sort value", async () => {
    await requestFor({ query: "a", sort: "relevance" });
    expect(fake.requests.at(-1)).toMatchObject({ sort: undefined });
  });

  it("forwards filters on discover and browse, and only when object-shaped", async () => {
    const filters = { session_type: "task", status: "failed" };

    await requestFor({ query: "a", filters });
    expect(fake.requests.at(-1)).toMatchObject({ kind: "discover", filters });

    await requestFor({ filters });
    expect(fake.requests.at(-1)).toMatchObject({ kind: "browse", filters });

    // `null` is typeof "object" — the guard has to reject it explicitly.
    await requestFor({ filters: null });
    expect(fake.requests.at(-1)).toMatchObject({ filters: undefined });

    await requestFor({ filters: "session_type=task" });
    expect(fake.requests.at(-1)).toMatchObject({ filters: undefined });
  });
});

describe("error envelope", () => {
  it("turns a null result into not_found_or_forbidden", async () => {
    fake.result = null;

    const res = await tool().handler({ session_id: "ses_other" });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("not_found_or_forbidden");
    expect(res.content.message).toMatch(/not in your scope/);
  });

  it("surfaces a SessionSearchError's code", async () => {
    fake.throws = new SessionSearchError(
      "forbidden_agent_filter",
      "agent_z is outside your scope",
    );

    const res = await tool().handler({ query: "a" });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "forbidden_agent_filter",
      message: "agent_z is outside your scope",
    });
  });

  it("matches a cross-bundle SessionSearchError by name", async () => {
    // src/ and dist/ copies of core produce distinct classes, so
    // `instanceof` alone would drop the code to internal_error.
    const impostor = new Error("query is required for discovery");
    impostor.name = "SessionSearchError";
    (impostor as Error & { code: string }).code = "missing_query";
    fake.throws = impostor;

    const res = await tool().handler({ query: "a" });

    expect(res.content).toEqual({
      error: "missing_query",
      message: "query is required for discovery",
    });
  });

  it("wraps an unrelated Error as internal_error", async () => {
    fake.throws = new Error("connection terminated");

    const res = await tool().handler({});

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "internal_error",
      message: "connection terminated",
    });
  });

  it("stringifies a non-Error throw", async () => {
    fake.throws = { code: 42 };

    const res = await tool().handler({});

    expect(res.content).toEqual({
      error: "internal_error",
      message: "[object Object]",
    });
  });
});
