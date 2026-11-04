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

/**
 * The tool's own logic is `inferRequest` — which of the four calling
 * shapes a raw MCP input maps to — plus the caller-context passthrough
 * and the error envelope. All three are observable through the handler,
 * so the fake just records what the service was asked for.
 */
interface Harness {
  tool: ReturnType<typeof createSessionSearchTool>;
  requests: SessionSearchRequest[];
  contexts: SessionSearchContext[];
}

const ctx: SessionSearchToolContext = {
  agentId: "agent_a",
  hierarchyLevel: "team",
  sessionId: "sess_current",
};

function harness(
  search?: (req: SessionSearchRequest) => Promise<unknown>,
  context: SessionSearchToolContext = ctx,
): Harness {
  const requests: SessionSearchRequest[] = [];
  const contexts: SessionSearchContext[] = [];
  const sessionSearch = {
    search: vi.fn(async (req: SessionSearchRequest, c: SessionSearchContext) => {
      requests.push(req);
      contexts.push(c);
      if (search) return search(req);
      return { kind: req.kind, results: [] };
    }),
  } as unknown as SessionSearchService;
  return {
    tool: createSessionSearchTool(context, { sessionSearch }),
    requests,
    contexts,
  };
}

describe("createSessionSearchTool", () => {
  it("exposes the session_search name and an object schema", () => {
    const { tool } = harness();
    expect(tool.name).toBe("session_search");
    expect(tool.schema).toMatchObject({ type: "object" });
  });

  it("documents all four calling shapes for the agent", () => {
    const { tool } = harness();
    expect(tool.description).toContain("DISCOVERY");
    expect(tool.description).toContain("FOUR CALLING SHAPES");
  });

  it("forwards the caller's identity, tier and current session", async () => {
    const { tool, contexts } = harness();

    await tool.handler({ query: "deploy failure" });

    expect(contexts[0]).toEqual({
      callerAgentId: "agent_a",
      hierarchyLevel: "team",
      currentSessionId: "sess_current",
    });
  });
});

describe("session_search shape inference", () => {
  it("scrolls when session_id and around_message_id are both present", async () => {
    const { tool, requests } = harness();

    await tool.handler({
      session_id: "sess_1",
      around_message_id: "msg_7",
      window: 12,
    });

    expect(requests[0]).toEqual({
      kind: "scroll",
      session_id: "sess_1",
      around_message_id: "msg_7",
      window: 12,
    });
  });

  it("leaves window unset when it is not a number", async () => {
    const { tool, requests } = harness();

    await tool.handler({
      session_id: "sess_1",
      around_message_id: "msg_7",
      window: "12",
    });

    expect(requests[0]).toMatchObject({ kind: "scroll", window: undefined });
  });

  it("prefers scroll over discover when a query is also supplied", async () => {
    const { tool, requests } = harness();

    await tool.handler({
      session_id: "sess_1",
      around_message_id: "msg_7",
      query: "deploy",
    });

    expect(requests[0]?.kind).toBe("scroll");
  });

  it("reads a whole session when only session_id is given", async () => {
    const { tool, requests } = harness();

    await tool.handler({ session_id: "sess_1" });

    expect(requests[0]).toEqual({ kind: "read", session_id: "sess_1" });
  });

  it("prefers read over discover when a query is also supplied", async () => {
    const { tool, requests } = harness();

    await tool.handler({ session_id: "sess_1", query: "deploy" });

    expect(requests[0]).toEqual({ kind: "read", session_id: "sess_1" });
  });

  it("discovers when a query is given, carrying limit, sort and filters", async () => {
    const { tool, requests } = harness();

    await tool.handler({
      query: "deploy failure",
      limit: 5,
      sort: "oldest",
      filters: { status: "failed" },
    });

    expect(requests[0]).toEqual({
      kind: "discover",
      query: "deploy failure",
      limit: 5,
      sort: "oldest",
      filters: { status: "failed" },
    });
  });

  it.each([
    ["an unknown sort", "relevance"],
    ["a non-string sort", 1],
    ["a missing sort", undefined],
  ])("drops %s so the service default applies", async (_label, sort) => {
    const { tool, requests } = harness();

    await tool.handler({ query: "deploy", sort });

    expect(requests[0]).toMatchObject({ kind: "discover", sort: undefined });
  });

  it("accepts the newest sort", async () => {
    const { tool, requests } = harness();

    await tool.handler({ query: "deploy", sort: "newest" });

    expect(requests[0]).toMatchObject({ sort: "newest" });
  });

  it("browses when nothing identifying is given", async () => {
    const { tool, requests } = harness();

    await tool.handler({});

    expect(requests[0]).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("browses with limit and filters", async () => {
    const { tool, requests } = harness();

    await tool.handler({ limit: 3, filters: { type: "chat" } });

    expect(requests[0]).toEqual({
      kind: "browse",
      limit: 3,
      filters: { type: "chat" },
    });
  });

  it.each([
    ["a whitespace-only session_id", { session_id: "   " }],
    ["a non-string session_id", { session_id: 9 }],
    ["a whitespace-only query", { query: "  " }],
  ])("treats %s as absent and browses", async (_label, input) => {
    const { tool, requests } = harness();

    await tool.handler(input as Record<string, unknown>);

    expect(requests[0]?.kind).toBe("browse");
  });

  it("reads rather than scrolls when the anchor is blank", async () => {
    const { tool, requests } = harness();

    await tool.handler({ session_id: "sess_1", around_message_id: "  " });

    expect(requests[0]).toEqual({ kind: "read", session_id: "sess_1" });
  });

  it("trims the ids and the query before dispatching", async () => {
    const { tool, requests } = harness();

    await tool.handler({
      session_id: "  sess_1  ",
      around_message_id: "  msg_7  ",
    });
    await tool.handler({ query: "  deploy failure  " });

    expect(requests[0]).toMatchObject({
      session_id: "sess_1",
      around_message_id: "msg_7",
    });
    expect(requests[1]).toMatchObject({ query: "deploy failure" });
  });

  it.each([
    ["null", null],
    ["a scalar", "status:failed"],
    ["a missing value", undefined],
  ])("drops %s filters", async (_label, filters) => {
    const { tool, requests } = harness();

    await tool.handler({ query: "deploy", filters });

    expect(requests[0]).toMatchObject({ filters: undefined });
  });
});

describe("session_search results and errors", () => {
  it("returns the service payload verbatim", async () => {
    const payload = { kind: "read", messages: [{ id: "msg_1", text: "hi" }] };
    const { tool } = harness(async () => payload);

    const result = await tool.handler({ session_id: "sess_1" });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual(payload);
  });

  it("converts a null result into not_found_or_forbidden", async () => {
    const { tool } = harness(async () => null);

    const result = await tool.handler({ session_id: "sess_other" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "not_found_or_forbidden" });
    expect(String(result.content.message)).toContain("scope");
  });

  it.each([
    ["forbidden_agent_filter"],
    ["missing_query"],
    ["missing_args"],
  ] as const)("surfaces the %s code from a SessionSearchError", async (code) => {
    const { tool } = harness(async () => {
      throw new SessionSearchError(code, `rejected: ${code}`);
    });

    const result = await tool.handler({ query: "deploy" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: code, message: `rejected: ${code}` });
  });

  it("matches a SessionSearchError by name across bundle boundaries", async () => {
    // An error raised by a *different* copy of the module (src vs dist)
    // fails instanceof, so the handler falls back to a name check.
    class ForeignSessionSearchError extends Error {
      code = "missing_query";
      constructor(message: string) {
        super(message);
        this.name = "SessionSearchError";
      }
    }
    const { tool } = harness(async () => {
      throw new ForeignSessionSearchError("query is required");
    });

    const result = await tool.handler({ query: "deploy" });

    expect(result.content).toEqual({
      error: "missing_query",
      message: "query is required",
    });
  });

  it("wraps an unexpected Error as internal_error", async () => {
    const { tool } = harness(async () => {
      throw new Error("connection terminated");
    });

    const result = await tool.handler({ query: "deploy" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "internal_error",
      message: "connection terminated",
    });
  });

  it("stringifies a non-Error throw as internal_error", async () => {
    const { tool } = harness(async () => {
      throw "tsvector blew up";
    });

    const result = await tool.handler({ query: "deploy" });

    expect(result.content).toEqual({
      error: "internal_error",
      message: "tsvector blew up",
    });
  });

  it("does not mistake a plain Error carrying a code for a SessionSearchError", async () => {
    const { tool } = harness(async () => {
      const err = new Error("nope") as Error & { code: string };
      err.code = "forbidden_agent_filter";
      throw err;
    });

    const result = await tool.handler({ query: "deploy" });

    expect(result.content).toEqual({
      error: "internal_error",
      message: "nope",
    });
  });
});
