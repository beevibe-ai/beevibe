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

interface Harness {
  services: { sessionSearch: SessionSearchService };
  requests: SessionSearchRequest[];
  contexts: Array<Record<string, unknown>>;
}

function harness(
  opts: { result?: unknown; throws?: unknown } = {},
): Harness {
  const requests: SessionSearchRequest[] = [];
  const contexts: Array<Record<string, unknown>> = [];

  const sessionSearch = {
    search: vi.fn(
      async (req: SessionSearchRequest, ctx: Record<string, unknown>) => {
        if (opts.throws) throw opts.throws;
        requests.push(req);
        contexts.push(ctx);
        return opts.result === undefined ? { results: [] } : opts.result;
      },
    ),
  } as unknown as SessionSearchService;

  return { services: { sessionSearch }, requests, contexts };
}

const CTX: SessionSearchToolContext = {
  agentId: "agent_a",
  hierarchyLevel: "team",
  sessionId: "sess_current",
};

function tool(h: Harness, ctx: SessionSearchToolContext = CTX) {
  return createSessionSearchTool(ctx, h.services);
}

describe("session_search tool", () => {
  describe("descriptor", () => {
    it("exposes the tool name and an object schema", () => {
      const t = tool(harness());
      expect(t.name).toBe("session_search");
      expect(t.schema.type).toBe("object");
    });

    it("takes no required arguments, so the bare browse call is legal", () => {
      const t = tool(harness());
      expect(t.schema.required).toBeUndefined();
    });

    it("documents all four calling shapes in the agent-facing description", () => {
      const t = tool(harness());
      for (const shape of ["DISCOVERY", "SCROLL", "READ", "BROWSE"]) {
        expect(t.description).toContain(shape);
      }
    });
  });

  describe("caller context", () => {
    it("passes caller agent, tier and current session to the service", async () => {
      const h = harness();
      await tool(h).handler({});

      expect(h.contexts[0]).toEqual({
        callerAgentId: "agent_a",
        hierarchyLevel: "team",
        currentSessionId: "sess_current",
      });
    });

    it("forwards the caller's own tier verbatim", async () => {
      const h = harness();
      await tool(h, { ...CTX, hierarchyLevel: "ic" }).handler({});

      expect(h.contexts[0]?.hierarchyLevel).toBe("ic");
    });
  });

  describe("shape inference", () => {
    it("infers browse from no arguments", async () => {
      const h = harness();
      await tool(h).handler({});

      expect(h.requests[0]).toEqual({
        kind: "browse",
        limit: undefined,
        filters: undefined,
      });
    });

    it("infers discover from a query", async () => {
      const h = harness();
      await tool(h).handler({ query: "auth refactor", limit: 5, sort: "newest" });

      expect(h.requests[0]).toMatchObject({
        kind: "discover",
        query: "auth refactor",
        limit: 5,
        sort: "newest",
      });
    });

    it("infers read from a bare session_id", async () => {
      const h = harness();
      await tool(h).handler({ session_id: "sess_42" });

      expect(h.requests[0]).toEqual({ kind: "read", session_id: "sess_42" });
    });

    it("infers scroll from session_id + around_message_id", async () => {
      const h = harness();
      await tool(h).handler({
        session_id: "sess_42",
        around_message_id: "evt_7",
        window: 10,
      });

      expect(h.requests[0]).toEqual({
        kind: "scroll",
        session_id: "sess_42",
        around_message_id: "evt_7",
        window: 10,
      });
    });

    it("lets scroll win over discover when a query is also present", async () => {
      const h = harness();
      await tool(h).handler({
        query: "ignored",
        session_id: "sess_42",
        around_message_id: "evt_7",
      });

      expect(h.requests[0]).toMatchObject({ kind: "scroll" });
    });

    it("lets read win over discover when a query is also present", async () => {
      const h = harness();
      await tool(h).handler({ query: "ignored", session_id: "sess_42" });

      expect(h.requests[0]).toEqual({ kind: "read", session_id: "sess_42" });
    });

    it("accepts the synthetic user-turn anchor id format", async () => {
      const h = harness();
      await tool(h).handler({
        session_id: "sess_42",
        around_message_id: "intent:sess_42",
      });

      expect(h.requests[0]).toMatchObject({
        kind: "scroll",
        around_message_id: "intent:sess_42",
      });
    });
  });

  describe("argument coercion", () => {
    it("trims session_id, around_message_id and query", async () => {
      const h = harness();
      await tool(h).handler({
        session_id: "  sess_42  ",
        around_message_id: "  evt_7  ",
      });
      await tool(h).handler({ query: "  auth  " });

      expect(h.requests[0]).toMatchObject({
        session_id: "sess_42",
        around_message_id: "evt_7",
      });
      expect(h.requests[1]).toMatchObject({ query: "auth" });
    });

    it.each([
      ["whitespace-only", "   "],
      ["empty", ""],
      ["a non-string", 42],
    ])("treats %s session_id as absent, falling back to browse", async (_l, session_id) => {
      const h = harness();
      await tool(h).handler({ session_id });

      expect(h.requests[0]).toMatchObject({ kind: "browse" });
    });

    it.each([
      ["whitespace-only", "   "],
      ["a non-string", 42],
    ])("treats %s query as absent, falling back to browse", async (_l, query) => {
      const h = harness();
      await tool(h).handler({ query });

      expect(h.requests[0]).toMatchObject({ kind: "browse" });
    });

    it("degrades scroll to read when the anchor is blank", async () => {
      const h = harness();
      await tool(h).handler({ session_id: "sess_42", around_message_id: "  " });

      expect(h.requests[0]).toEqual({ kind: "read", session_id: "sess_42" });
    });

    it.each([
      ["a string", "10"],
      ["null", null],
    ])("drops %s limit rather than forwarding it", async (_label, limit) => {
      const h = harness();
      await tool(h).handler({ query: "x", limit });

      expect((h.requests[0] as { limit?: number }).limit).toBeUndefined();
    });

    it("drops a non-numeric window rather than forwarding it", async () => {
      const h = harness();
      await tool(h).handler({
        session_id: "s",
        around_message_id: "m",
        window: "10",
      });

      expect((h.requests[0] as { window?: number }).window).toBeUndefined();
    });

    it.each([
      ["an unknown sort", "relevance"],
      ["a non-string sort", 1],
    ])("drops %s", async (_label, sort) => {
      const h = harness();
      await tool(h).handler({ query: "x", sort });

      expect((h.requests[0] as { sort?: string }).sort).toBeUndefined();
    });

    it("accepts both documented sort values", async () => {
      const h = harness();
      await tool(h).handler({ query: "x", sort: "newest" });
      await tool(h).handler({ query: "x", sort: "oldest" });

      expect((h.requests[0] as { sort?: string }).sort).toBe("newest");
      expect((h.requests[1] as { sort?: string }).sort).toBe("oldest");
    });

    it("forwards filters verbatim on discover and browse", async () => {
      const h = harness();
      const filters = {
        session_type: "task",
        status: "failed",
        agent_id: "agent_b",
        task_id: "task_9",
        since: "2026-01-01T00:00:00Z",
        until: "2026-02-01T00:00:00Z",
      };

      await tool(h).handler({ query: "x", filters });
      await tool(h).handler({ filters });

      expect((h.requests[0] as { filters?: unknown }).filters).toEqual(filters);
      expect((h.requests[1] as { filters?: unknown }).filters).toEqual(filters);
    });

    it.each([
      ["null", null],
      ["a string", "session_type=task"],
    ])("drops %s filters", async (_label, filters) => {
      const h = harness();
      await tool(h).handler({ query: "x", filters });

      expect((h.requests[0] as { filters?: unknown }).filters).toBeUndefined();
    });
  });

  describe("results", () => {
    it("returns the service payload unwrapped", async () => {
      const payload = { results: [{ session: { session_id: "sess_1" } }] };
      const h = harness({ result: payload });

      const result = await tool(h).handler({ query: "x" });

      expect(result.isError).toBeFalsy();
      expect(result.content).toEqual(payload);
    });

    it("turns a null result into not_found_or_forbidden", async () => {
      const h = harness({ result: null });
      const result = await tool(h).handler({ session_id: "sess_other" });

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "not_found_or_forbidden" });
    });
  });

  describe("error mapping", () => {
    it.each([
      ["forbidden_agent_filter"],
      ["missing_query"],
      ["missing_args"],
    ] as const)("surfaces the %s code from a SessionSearchError", async (code) => {
      const h = harness({ throws: new SessionSearchError(code, `bad: ${code}`) });
      const result = await tool(h).handler({ query: "x" });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual({ error: code, message: `bad: ${code}` });
    });

    it("matches by error name too, so a cross-bundle import still maps", async () => {
      // An integration script consuming core's src/ while the api consumes
      // dist/ yields a structurally identical error that fails instanceof.
      const impostor = Object.assign(new Error("out of scope"), {
        name: "SessionSearchError",
        code: "forbidden_agent_filter",
      });
      const h = harness({ throws: impostor });

      const result = await tool(h).handler({ query: "x" });

      expect(result.content).toEqual({
        error: "forbidden_agent_filter",
        message: "out of scope",
      });
    });

    it("wraps an unexpected Error as internal_error", async () => {
      const h = harness({ throws: new Error("pg exploded") });
      const result = await tool(h).handler({ query: "x" });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual({
        error: "internal_error",
        message: "pg exploded",
      });
    });

    it("stringifies a non-Error throw", async () => {
      const h = harness({ throws: "kaboom" });
      const result = await tool(h).handler({ query: "x" });

      expect(result.content).toEqual({
        error: "internal_error",
        message: "kaboom",
      });
    });
  });
});
