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

/**
 * The service does the scope resolution and the SQL; the tool's own logic
 * is shape inference (`inferRequest`) plus the error envelope. Both are
 * exercised through the public handler, with the service faked so each
 * assertion is about the request the tool built.
 */
function harness(
  ctx: Partial<SessionSearchToolContext> = {},
  behaviour: { search?: () => Promise<unknown> } = {},
) {
  const requests: SessionSearchRequest[] = [];
  const scopes: Array<Record<string, unknown>> = [];

  const sessionSearch = {
    search: vi.fn(
      async (req: SessionSearchRequest, scope: Record<string, unknown>) => {
        requests.push(req);
        scopes.push(scope);
        if (behaviour.search) return behaviour.search();
        return { results: [] };
      },
    ),
  } as unknown as SessionSearchService;

  const tool = createSessionSearchTool(
    {
      agentId: "agent_a",
      hierarchyLevel: "ic",
      sessionId: "sess_current",
      ...ctx,
    },
    { sessionSearch },
  );
  return { tool, requests, scopes };
}

describe("session_search tool", () => {
  describe("descriptor", () => {
    it("names the tool and documents the four shapes", () => {
      const { tool } = harness();
      expect(tool.name).toBe("session_search");
      expect(tool.description).toContain("DISCOVERY");
      expect(tool.description).toContain("SCROLL");
      expect(tool.description).toContain("READ");
      expect(tool.description).toContain("BROWSE");
    });

    it("declares no required fields, since browse takes no args", () => {
      const { tool } = harness();
      expect(tool.schema.required).toBeUndefined();
    });
  });

  describe("caller scope", () => {
    it("passes the caller agent, tier and active session to the service", async () => {
      const { tool, scopes } = harness({
        agentId: "agent_team",
        hierarchyLevel: "team",
        sessionId: "sess_live",
      });

      await tool.handler({});

      expect(scopes[0]).toEqual({
        callerAgentId: "agent_team",
        hierarchyLevel: "team",
        currentSessionId: "sess_live",
      });
    });
  });

  describe("shape inference", () => {
    it("infers browse from no arguments", async () => {
      const { tool, requests } = harness();

      await tool.handler({});

      expect(requests[0]).toMatchObject({ kind: "browse" });
    });

    it("infers discover from a query", async () => {
      const { tool, requests } = harness();

      await tool.handler({ query: "auth refactor", limit: 7, sort: "newest" });

      expect(requests[0]).toMatchObject({
        kind: "discover",
        query: "auth refactor",
        limit: 7,
        sort: "newest",
      });
    });

    it("infers read from a bare session_id", async () => {
      const { tool, requests } = harness();

      await tool.handler({ session_id: "sess_past" });

      expect(requests[0]).toEqual({ kind: "read", session_id: "sess_past" });
    });

    it("infers scroll from session_id plus around_message_id", async () => {
      const { tool, requests } = harness();

      await tool.handler({
        session_id: "sess_past",
        around_message_id: "evt_9",
        window: 10,
      });

      expect(requests[0]).toEqual({
        kind: "scroll",
        session_id: "sess_past",
        around_message_id: "evt_9",
        window: 10,
      });
    });

    it("prefers scroll over discover when a query is also present", async () => {
      const { tool, requests } = harness();

      await tool.handler({
        session_id: "sess_past",
        around_message_id: "evt_9",
        query: "ignored",
      });

      expect(requests[0]).toMatchObject({ kind: "scroll" });
    });

    it("prefers read over discover when a query is also present", async () => {
      const { tool, requests } = harness();

      await tool.handler({ session_id: "sess_past", query: "ignored" });

      expect(requests[0]).toEqual({ kind: "read", session_id: "sess_past" });
    });

    it("trims the string inputs it infers on", async () => {
      const { tool, requests } = harness();

      await tool.handler({
        session_id: "  sess_past  ",
        around_message_id: "  evt_9  ",
      });

      expect(requests[0]).toMatchObject({
        kind: "scroll",
        session_id: "sess_past",
        around_message_id: "evt_9",
      });
    });

    it.each([
      ["blank", "   "],
      ["a non-string", 42],
    ])("treats a session_id that is %s as absent", async (_label, session_id) => {
      const { tool, requests } = harness();

      await tool.handler({ session_id, query: "topic" });

      expect(requests[0]).toMatchObject({ kind: "discover", query: "topic" });
    });

    it.each([
      ["blank", "   "],
      ["a non-string", 42],
    ])("treats a query that is %s as absent", async (_label, query) => {
      const { tool, requests } = harness();

      await tool.handler({ query });

      expect(requests[0]).toMatchObject({ kind: "browse" });
    });

    it("falls back to read when around_message_id is blank", async () => {
      const { tool, requests } = harness();

      await tool.handler({ session_id: "sess_past", around_message_id: "  " });

      expect(requests[0]).toEqual({ kind: "read", session_id: "sess_past" });
    });

    it("leaves a non-numeric window undefined for the service to default", async () => {
      const { tool, requests } = harness();

      await tool.handler({
        session_id: "sess_past",
        around_message_id: "evt_9",
        window: "10",
      });

      expect(requests[0]).toMatchObject({ window: undefined });
    });

    it.each([
      ["discover", { query: "topic", limit: "3" }],
      ["browse", { limit: "3" }],
    ])("leaves a non-numeric limit undefined in %s", async (_label, input) => {
      const { tool, requests } = harness();

      await tool.handler(input);

      expect(requests[0]).toMatchObject({ limit: undefined });
    });

    it("ignores a sort value outside the allowed pair", async () => {
      const { tool, requests } = harness();

      await tool.handler({ query: "topic", sort: "sideways" });

      expect(requests[0]).toMatchObject({ sort: undefined });
    });
  });

  describe("filters", () => {
    it("forwards filters on discover", async () => {
      const { tool, requests } = harness();
      const filters = { session_type: "task", status: "failed" };

      await tool.handler({ query: "topic", filters });

      expect(requests[0]).toMatchObject({ kind: "discover", filters });
    });

    it("forwards filters on browse", async () => {
      const { tool, requests } = harness();
      const filters = { agent_id: "agent_b" };

      await tool.handler({ filters });

      expect(requests[0]).toMatchObject({ kind: "browse", filters });
    });

    it.each([
      ["null", null],
      ["not an object", "task"],
      ["absent", undefined],
    ])("drops filters that are %s", async (_label, filters) => {
      const { tool, requests } = harness();

      await tool.handler({ filters });

      expect(requests[0]).toMatchObject({ filters: undefined });
    });
  });

  describe("results", () => {
    it("returns the service payload unchanged on success", async () => {
      const payload = { results: [{ session: { id: "sess_1" } }] };
      const { tool } = harness({}, { search: async () => payload });

      const result = await tool.handler({ query: "topic" });

      expect(result.isError).toBeFalsy();
      expect(result.content).toBe(payload);
    });

    it("maps a null result to not_found_or_forbidden", async () => {
      const { tool } = harness({}, { search: async () => null });

      const result = await tool.handler({ session_id: "sess_other" });

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({
        error: "not_found_or_forbidden",
      });
    });
  });

  describe("error mapping", () => {
    it.each([
      ["forbidden_agent_filter"],
      ["missing_query"],
      ["missing_args"],
    ] as const)("surfaces the %s code from a SessionSearchError", async (code) => {
      const { tool } = harness(
        {},
        {
          search: () =>
            Promise.reject(new SessionSearchError(code, "nope")),
        },
      );

      const result = await tool.handler({ query: "topic" });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual({ error: code, message: "nope" });
    });

    it("matches by name too, so a cross-bundle error keeps its code", async () => {
      // src/ and dist/ copies of the class fail `instanceof`; the name
      // check is what keeps the structured code from degrading.
      const impostor = Object.assign(new Error("scope violation"), {
        name: "SessionSearchError",
        code: "forbidden_agent_filter",
      });
      const { tool } = harness({}, { search: () => Promise.reject(impostor) });

      const result = await tool.handler({ query: "topic" });

      expect(result.content).toEqual({
        error: "forbidden_agent_filter",
        message: "scope violation",
      });
    });

    it("degrades an unrelated Error to internal_error", async () => {
      const { tool } = harness(
        {},
        { search: () => Promise.reject(new Error("connection reset")) },
      );

      const result = await tool.handler({ query: "topic" });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual({
        error: "internal_error",
        message: "connection reset",
      });
    });

    it("stringifies a non-Error rejection", async () => {
      const { tool } = harness({}, { search: () => Promise.reject("weird") });

      const result = await tool.handler({ query: "topic" });

      expect(result.content).toEqual({
        error: "internal_error",
        message: "weird",
      });
    });
  });
});
