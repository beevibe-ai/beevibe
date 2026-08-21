/**
 * session_search tool tests.
 *
 * The whole point of this adapter is shape inference: one flat tool
 * input has to become one of four typed SessionSearchRequests, and the
 * precedence between them (scroll beats read beats discover beats
 * browse) is the contract the tool description promises the agent. That
 * gets exhaustive coverage here, along with the two failure envelopes —
 * the `null` return (out of scope / bad anchor) and the SessionSearchError
 * projection, including the by-name match that keeps working when core is
 * consumed from src/ on one side and dist/ on the other.
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
  agentId: "agent_caller",
  hierarchyLevel: "team",
  sessionId: "ses_current",
};

/** Same arity as SessionSearchService.search, so `mock.calls` stays typed. */
type SearchStub = (
  req: SessionSearchRequest,
  scope: {
    callerAgentId: string;
    hierarchyLevel: string;
    currentSessionId: string;
  },
) => Promise<unknown>;

function harness(
  search: SearchStub = async () => ({ kind: "browse", sessions: [] }),
  ctx: SessionSearchToolContext = CTX,
) {
  const spy = vi.fn(search);
  const tool = createSessionSearchTool(ctx, {
    sessionSearch: { search: spy } as unknown as SessionSearchService,
  });
  return { tool, spy };
}

function requestFrom(spy: ReturnType<typeof vi.fn>): SessionSearchRequest {
  return spy.mock.calls[0]?.[0] as SessionSearchRequest;
}

describe("session_search tool descriptor", () => {
  it("is named session_search and documents the four calling shapes", () => {
    const { tool } = harness();
    expect(tool.name).toBe("session_search");
    for (const shape of ["DISCOVERY", "SCROLL", "READ", "BROWSE"]) {
      expect(tool.description).toContain(shape);
    }
  });

  it("takes no required fields, so the bare browse call is valid", () => {
    const { tool } = harness();
    expect(tool.schema.required).toBeUndefined();
  });
});

describe("caller scope", () => {
  it("passes the caller's agent id, tier and active session to the service", async () => {
    const { tool, spy } = harness();
    await tool.handler({});

    expect(spy.mock.calls[0]?.[1]).toEqual({
      callerAgentId: "agent_caller",
      hierarchyLevel: "team",
      currentSessionId: "ses_current",
    });
  });

  it("forwards an ic caller's tier unchanged", async () => {
    const { tool, spy } = harness(undefined, { ...CTX, hierarchyLevel: "ic" });
    await tool.handler({});

    expect(spy.mock.calls[0]?.[1]).toMatchObject({ hierarchyLevel: "ic" });
  });
});

describe("shape inference", () => {
  it("infers browse from an empty input", async () => {
    const { tool, spy } = harness();
    await tool.handler({});

    expect(requestFrom(spy)).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("infers browse with a limit when only limit is given", async () => {
    const { tool, spy } = harness();
    await tool.handler({ limit: 7 });

    expect(requestFrom(spy)).toMatchObject({ kind: "browse", limit: 7 });
  });

  it("infers discover from a query", async () => {
    const { tool, spy } = harness();
    await tool.handler({ query: "  auth refactor  ", limit: 3, sort: "newest" });

    expect(requestFrom(spy)).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: 3,
      sort: "newest",
      filters: undefined,
    });
  });

  it("infers read from a bare session_id", async () => {
    const { tool, spy } = harness();
    await tool.handler({ session_id: "  ses_old  " });

    expect(requestFrom(spy)).toEqual({ kind: "read", session_id: "ses_old" });
  });

  it("infers scroll from session_id + around_message_id", async () => {
    const { tool, spy } = harness();
    await tool.handler({
      session_id: "  ses_old  ",
      around_message_id: "  evt_9  ",
      window: 10,
    });

    expect(requestFrom(spy)).toEqual({
      kind: "scroll",
      session_id: "ses_old",
      around_message_id: "evt_9",
      window: 10,
    });
  });

  it("lets scroll win over a query supplied alongside it", async () => {
    const { tool, spy } = harness();
    await tool.handler({
      session_id: "ses_old",
      around_message_id: "evt_9",
      query: "ignored",
    });

    expect(requestFrom(spy)).toMatchObject({ kind: "scroll" });
  });

  it("lets read win over a query supplied alongside it", async () => {
    const { tool, spy } = harness();
    await tool.handler({ session_id: "ses_old", query: "ignored" });

    expect(requestFrom(spy)).toMatchObject({ kind: "read" });
  });

  it("falls back to discover when the anchor is blank but a query is present", async () => {
    const { tool, spy } = harness();
    await tool.handler({ around_message_id: "   ", query: "auth" });

    expect(requestFrom(spy)).toMatchObject({ kind: "discover", query: "auth" });
  });

  it.each([
    ["whitespace-only", "   "],
    ["empty", ""],
    ["a non-string", 12],
  ])("treats %s session_id as absent", async (_label, session_id) => {
    const { tool, spy } = harness();
    await tool.handler({ session_id });

    expect(requestFrom(spy)).toMatchObject({ kind: "browse" });
  });

  it.each([
    ["whitespace-only", "   "],
    ["a non-string", 12],
  ])("treats %s query as absent", async (_label, query) => {
    const { tool, spy } = harness();
    await tool.handler({ query });

    expect(requestFrom(spy)).toMatchObject({ kind: "browse" });
  });

  it("drops a non-numeric window rather than passing it through", async () => {
    const { tool, spy } = harness();
    await tool.handler({
      session_id: "ses_old",
      around_message_id: "evt_9",
      window: "10",
    });

    expect(requestFrom(spy)).toMatchObject({ window: undefined });
  });

  it.each([
    ["a bogus value", "closest"],
    ["a non-string", 1],
  ])("drops %s for sort", async (_label, sort) => {
    const { tool, spy } = harness();
    await tool.handler({ query: "auth", sort });

    expect(requestFrom(spy)).toMatchObject({ sort: undefined });
  });

  it("keeps 'oldest' as a valid sort", async () => {
    const { tool, spy } = harness();
    await tool.handler({ query: "auth", sort: "oldest" });

    expect(requestFrom(spy)).toMatchObject({ sort: "oldest" });
  });
});

describe("filters", () => {
  it("passes a filters object through to discover", async () => {
    const { tool, spy } = harness();
    const filters = { session_type: "task", status: "failed" };
    await tool.handler({ query: "auth", filters });

    expect(requestFrom(spy)).toMatchObject({ filters });
  });

  it("passes a filters object through to browse", async () => {
    const { tool, spy } = harness();
    const filters = { agent_id: "agent_sub" };
    await tool.handler({ filters });

    expect(requestFrom(spy)).toMatchObject({ kind: "browse", filters });
  });

  it.each([
    ["null", null],
    ["a string", "status:failed"],
    ["absent", undefined],
  ])("treats %s filters as undefined", async (_label, filters) => {
    const { tool, spy } = harness();
    await tool.handler({ query: "auth", filters });

    expect(requestFrom(spy)).toMatchObject({ filters: undefined });
  });
});

describe("result handling", () => {
  it("returns the service payload verbatim on success", async () => {
    const payload = { kind: "read", session: { id: "ses_old" }, messages: [] };
    const { tool } = harness(async () => payload);

    const result = await tool.handler({ session_id: "ses_old" });

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe(payload);
  });

  it("maps a null result onto not_found_or_forbidden", async () => {
    const { tool } = harness(async () => null);

    const result = await tool.handler({
      session_id: "ses_other",
      around_message_id: "evt_1",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "not_found_or_forbidden" });
    expect(String(result.content.message)).toContain("not in your scope");
  });

  it.each([
    "forbidden_agent_filter",
    "missing_query",
    "missing_args",
  ] as const)("projects SessionSearchError code %s", async (code) => {
    const { tool } = harness(async () => {
      throw new SessionSearchError(code, `bad: ${code}`);
    });

    const result = await tool.handler({ query: "auth" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: code, message: `bad: ${code}` });
  });

  it("projects a cross-bundle SessionSearchError matched by name", async () => {
    // Same class from a different module instance: instanceof fails, so
    // the name check is what keeps the structured code from degrading.
    class ForeignSessionSearchError extends Error {
      code = "forbidden_agent_filter";
      constructor(message: string) {
        super(message);
        this.name = "SessionSearchError";
      }
    }
    const { tool } = harness(async () => {
      throw new ForeignSessionSearchError("out of scope");
    });

    const result = await tool.handler({ query: "auth" });

    expect(result.content).toEqual({
      error: "forbidden_agent_filter",
      message: "out of scope",
    });
  });

  it("wraps an unexpected Error as internal_error", async () => {
    const { tool } = harness(async () => {
      throw new Error("connection terminated");
    });

    const result = await tool.handler({});

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "internal_error",
      message: "connection terminated",
    });
  });

  it("stringifies a non-Error throw", async () => {
    const { tool } = harness(async () => {
      throw "pool exhausted";
    });

    const result = await tool.handler({});

    expect(result.content).toEqual({
      error: "internal_error",
      message: "pool exhausted",
    });
  });
});
