import { describe, expect, it, vi } from "vitest";
import { SESSION_STATUSES, SESSION_TYPES } from "@beevibe/core";
import type { SessionSearchRequest } from "@beevibe/core";
import {
  SessionSearchError,
  type SessionSearchService,
} from "@beevibe/core/services/session-search";
import {
  createSessionSearchTool,
  type SessionSearchToolContext,
  type SessionSearchToolServices,
} from "./session-search.js";

interface Harness {
  services: SessionSearchToolServices;
  requests: SessionSearchRequest[];
  scopes: Array<Record<string, unknown>>;
}

function harness(
  opts: { result?: unknown; throws?: unknown } = {},
): Harness {
  const requests: SessionSearchRequest[] = [];
  const scopes: Array<Record<string, unknown>> = [];

  const sessionSearch = {
    search: vi.fn(
      async (req: SessionSearchRequest, scope: Record<string, unknown>) => {
        requests.push(req);
        scopes.push(scope);
        if (opts.throws !== undefined) throw opts.throws;
        return "result" in opts ? opts.result : { kind: "ok", results: [] };
      },
    ),
  } as unknown as SessionSearchService;

  return { services: { sessionSearch }, requests, scopes };
}

const CTX: SessionSearchToolContext = {
  agentId: "agent_lead",
  hierarchyLevel: "team",
  sessionId: "sess_current",
};

function tool(h: Harness, ctx: SessionSearchToolContext = CTX) {
  return createSessionSearchTool(ctx, h.services);
}

describe("session_search tool surface", () => {
  it("is named session_search and ships the agent-facing contract", () => {
    const t = tool(harness());
    expect(t.name).toBe("session_search");
    for (const shape of ["DISCOVERY", "SCROLL", "READ", "BROWSE"]) {
      expect(t.description).toContain(shape);
    }
    expect(t.description).toContain("websearch_to_tsquery");
  });

  it("derives the filter enums from the domain constants", () => {
    const schema = tool(harness()).schema as {
      properties: {
        filters: {
          properties: {
            session_type: { enum: string[] };
            status: { enum: string[] };
          };
        };
        sort: { enum: string[] };
      };
    };
    expect(schema.properties.filters.properties.session_type.enum).toEqual([
      ...SESSION_TYPES,
    ]);
    expect(schema.properties.filters.properties.status.enum).toEqual([
      ...SESSION_STATUSES,
    ]);
    expect(schema.properties.sort.enum).toEqual(["newest", "oldest"]);
  });

  it("declares no required properties — the browse shape takes no args", () => {
    expect(tool(harness()).schema).not.toHaveProperty("required");
  });
});

describe("session_search shape inference", () => {
  it("threads the caller context into the scope on every call", async () => {
    const h = harness();
    await tool(h).handler({});

    expect(h.scopes[0]).toEqual({
      callerAgentId: "agent_lead",
      hierarchyLevel: "team",
      currentSessionId: "sess_current",
    });
  });

  describe("browse", () => {
    it("is the shape for no arguments at all", async () => {
      const h = harness();
      await tool(h).handler({});
      expect(h.requests[0]).toEqual({
        kind: "browse",
        limit: undefined,
        filters: undefined,
      });
    });

    it("carries limit and filters", async () => {
      const h = harness();
      await tool(h).handler({ limit: 7, filters: { status: "failed" } });
      expect(h.requests[0]).toEqual({
        kind: "browse",
        limit: 7,
        filters: { status: "failed" },
      });
    });

    it("drops a non-numeric limit", async () => {
      const h = harness();
      await tool(h).handler({ limit: "7" });
      expect((h.requests[0] as { limit?: number }).limit).toBeUndefined();
    });
  });

  describe("discover", () => {
    it("is the shape when only query is given", async () => {
      const h = harness();
      await tool(h).handler({ query: "auth refactor" });
      expect(h.requests[0]).toEqual({
        kind: "discover",
        query: "auth refactor",
        limit: undefined,
        sort: undefined,
        filters: undefined,
      });
    });

    it("passes a numeric limit through and drops a non-numeric one", async () => {
      const h = harness();
      await tool(h).handler({ query: "x", limit: 9 });
      expect((h.requests[0] as { limit?: number }).limit).toBe(9);

      await tool(h).handler({ query: "x", limit: "9" });
      expect((h.requests[1] as { limit?: number }).limit).toBeUndefined();
    });

    it("trims the query", async () => {
      const h = harness();
      await tool(h).handler({ query: "  docker networking  " });
      expect((h.requests[0] as { query: string }).query).toBe("docker networking");
    });

    it.each([["newest"], ["oldest"]])("passes sort=%s through", async (sort) => {
      const h = harness();
      await tool(h).handler({ query: "x", sort });
      expect((h.requests[0] as { sort?: string }).sort).toBe(sort);
    });

    it.each([
      ["an unknown value", "relevance"],
      ["a number", 1],
      ["wrong case", "Newest"],
    ])("drops sort given as %s", async (_label, sort) => {
      const h = harness();
      await tool(h).handler({ query: "x", sort });
      expect((h.requests[0] as { sort?: string }).sort).toBeUndefined();
    });

    it("forwards the full filter set verbatim", async () => {
      const h = harness();
      const filters = {
        session_type: "task",
        status: "failed",
        agent_id: "agent_sub",
        task_id: "task_1",
        since: "2026-01-01T00:00:00Z",
        until: "2026-02-01T00:00:00Z",
      };
      await tool(h).handler({ query: "x", filters });
      expect((h.requests[0] as { filters?: unknown }).filters).toEqual(filters);
    });

    it.each([
      ["null", null],
      ["an array", []],
      ["a string", "status:failed"],
    ])("treats filters given as %s as absent", async (_label, filters) => {
      const h = harness();
      await tool(h).handler({ query: "x", filters });
      const got = (h.requests[0] as { filters?: unknown }).filters;
      // An array is an object, so it survives; null and strings do not.
      if (Array.isArray(filters)) expect(got).toEqual([]);
      else expect(got).toBeUndefined();
    });

    it.each([
      ["empty", ""],
      ["whitespace only", "   "],
      ["a number", 5],
    ])("falls back to browse when query is %s", async (_label, query) => {
      const h = harness();
      await tool(h).handler({ query });
      expect((h.requests[0] as { kind: string }).kind).toBe("browse");
    });
  });

  describe("read", () => {
    it("is the shape for a bare session_id", async () => {
      const h = harness();
      await tool(h).handler({ session_id: "sess_past" });
      expect(h.requests[0]).toEqual({ kind: "read", session_id: "sess_past" });
    });

    it("trims the session_id", async () => {
      const h = harness();
      await tool(h).handler({ session_id: "  sess_past  " });
      expect(h.requests[0]).toEqual({ kind: "read", session_id: "sess_past" });
    });

    it("wins over query — session_id is the more specific shape", async () => {
      const h = harness();
      await tool(h).handler({ session_id: "sess_past", query: "auth" });
      expect(h.requests[0]).toEqual({ kind: "read", session_id: "sess_past" });
    });

    it("ignores a blank anchor and stays a read", async () => {
      const h = harness();
      await tool(h).handler({ session_id: "sess_past", around_message_id: "  " });
      expect(h.requests[0]).toEqual({ kind: "read", session_id: "sess_past" });
    });

    it.each([
      ["whitespace only", "   "],
      ["a number", 1],
    ])("falls through when session_id is %s", async (_label, sessionIdInput) => {
      const h = harness();
      await tool(h).handler({ session_id: sessionIdInput, query: "auth" });
      expect((h.requests[0] as { kind: string }).kind).toBe("discover");
    });
  });

  describe("scroll", () => {
    it("is the shape when session_id and around_message_id are both set", async () => {
      const h = harness();
      await tool(h).handler({
        session_id: "sess_past",
        around_message_id: "evt_42",
        window: 10,
      });
      expect(h.requests[0]).toEqual({
        kind: "scroll",
        session_id: "sess_past",
        around_message_id: "evt_42",
        window: 10,
      });
    });

    it("trims both ids and leaves window undefined when absent", async () => {
      const h = harness();
      await tool(h).handler({
        session_id: " sess_past ",
        around_message_id: " evt_42 ",
      });
      expect(h.requests[0]).toEqual({
        kind: "scroll",
        session_id: "sess_past",
        around_message_id: "evt_42",
        window: undefined,
      });
    });

    it("accepts the synthetic user-turn anchor id", async () => {
      const h = harness();
      await tool(h).handler({
        session_id: "sess_past",
        around_message_id: "intent:sess_past",
      });
      expect(h.requests[0]).toMatchObject({
        kind: "scroll",
        around_message_id: "intent:sess_past",
      });
    });

    it("drops a non-numeric window rather than passing a string on", async () => {
      const h = harness();
      await tool(h).handler({
        session_id: "sess_past",
        around_message_id: "evt_42",
        window: "10",
      });
      expect((h.requests[0] as { window?: number }).window).toBeUndefined();
    });

    it("beats discover when a query is also supplied", async () => {
      const h = harness();
      await tool(h).handler({
        session_id: "sess_past",
        around_message_id: "evt_42",
        query: "auth",
      });
      expect((h.requests[0] as { kind: string }).kind).toBe("scroll");
    });
  });
});

describe("session_search results and failures", () => {
  it("returns the service payload untouched", async () => {
    const payload = { kind: "discover", results: [{ session: { id: "sess_1" } }] };
    const h = harness({ result: payload });
    const result = await tool(h).handler({ query: "auth" });

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe(payload);
  });

  it("turns a null result into one message covering all three causes", async () => {
    const h = harness({ result: null });
    const result = await tool(h).handler({ session_id: "sess_other" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "not_found_or_forbidden" });
    const message = (result.content as { message: string }).message;
    expect(message).toContain("not in your scope");
    expect(message).toContain("anchor message id does not");
    expect(message).toContain("active conversation");
  });

  it.each([
    ["forbidden_agent_filter"],
    ["missing_query"],
    ["missing_args"],
  ] as const)("surfaces the %s code from a SessionSearchError", async (code) => {
    const h = harness({ throws: new SessionSearchError(code, `nope: ${code}`) });
    const result = await tool(h).handler({ query: "auth" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: code, message: `nope: ${code}` });
  });

  it("matches a SessionSearchError from another bundle by name", async () => {
    // src/ and dist/ copies of core are different classes, so instanceof
    // alone would degrade this to internal_error.
    const foreign = Object.assign(new Error("agent out of scope"), {
      name: "SessionSearchError",
      code: "forbidden_agent_filter",
    });
    const h = harness({ throws: foreign });
    const result = await tool(h).handler({ query: "auth" });

    expect(result.content).toEqual({
      error: "forbidden_agent_filter",
      message: "agent out of scope",
    });
  });

  it("does not mistake a same-named non-Error throw for a SessionSearchError", async () => {
    const h = harness({ throws: { name: "SessionSearchError", code: "missing_query" } });
    const result = await tool(h).handler({ query: "auth" });

    expect(result.content).toMatchObject({ error: "internal_error" });
  });

  it("wraps any other Error as internal_error", async () => {
    const h = harness({ throws: new TypeError("pool exhausted") });
    const result = await tool(h).handler({ query: "auth" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "internal_error",
      message: "pool exhausted",
    });
  });

  it("stringifies a thrown primitive", async () => {
    const h = harness({ throws: "db gone" });
    const result = await tool(h).handler({ query: "auth" });

    expect(result.content).toEqual({ error: "internal_error", message: "db gone" });
  });
});
