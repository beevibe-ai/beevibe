import { describe, expect, it, vi } from "vitest";
import type {
  SessionSearchRequest,
  SessionSearchResult,
} from "@beevibe/core";
import {
  SessionSearchError,
  type SessionSearchService,
} from "@beevibe/core/services/session-search";
import {
  createSessionSearchTool,
  type SessionSearchToolContext,
} from "./session-search.js";

const OK = { kind: "browse", sessions: [] } as unknown as SessionSearchResult;

interface Harness {
  services: { sessionSearch: SessionSearchService };
  calls: Array<{ req: SessionSearchRequest; ctx: Record<string, unknown> }>;
}

function harness(
  overrides: { impl?: () => Promise<unknown> } = {},
): Harness {
  const calls: Array<{ req: SessionSearchRequest; ctx: Record<string, unknown> }> =
    [];
  const sessionSearch = {
    search: vi.fn(
      async (req: SessionSearchRequest, ctx: Record<string, unknown>) => {
        if (overrides.impl) return overrides.impl();
        calls.push({ req, ctx });
        return OK;
      },
    ),
  } as unknown as SessionSearchService;
  return { services: { sessionSearch }, calls };
}

const CTX: SessionSearchToolContext = {
  agentId: "agent_a",
  hierarchyLevel: "team",
  sessionId: "sess_current",
};

function tool(h: Harness, ctx: SessionSearchToolContext = CTX) {
  return createSessionSearchTool(ctx, h.services);
}

/** Run the handler and return the request the service actually received. */
async function requestFor(
  input: Record<string, unknown>,
): Promise<SessionSearchRequest> {
  const h = harness();
  await tool(h).handler(input);
  return h.calls[0]!.req;
}

describe("session_search tool", () => {
  describe("descriptor", () => {
    it("names the tool and declares no required fields (browse takes no args)", () => {
      const t = tool(harness());

      expect(t.name).toBe("session_search");
      expect(t.schema.required).toBeUndefined();
      expect(Object.keys(t.schema.properties as object)).toEqual([
        "query",
        "limit",
        "sort",
        "session_id",
        "around_message_id",
        "window",
        "filters",
      ]);
    });
  });

  describe("caller context", () => {
    it("passes the caller triple through to the service unchanged", async () => {
      const h = harness();
      await tool(h).handler({ query: "auth refactor" });

      expect(h.calls[0]?.ctx).toEqual({
        callerAgentId: "agent_a",
        hierarchyLevel: "team",
        currentSessionId: "sess_current",
      });
    });

    it("forwards the caller's own tier rather than inferring one", async () => {
      const h = harness();
      await tool(h, { ...CTX, hierarchyLevel: "ic" }).handler({ query: "x" });

      expect(h.calls[0]?.ctx.hierarchyLevel).toBe("ic");
    });
  });

  describe("shape inference", () => {
    it("infers browse from no arguments at all", async () => {
      expect(await requestFor({})).toEqual({
        kind: "browse",
        limit: undefined,
        filters: undefined,
      });
    });

    it("infers discover from a query", async () => {
      expect(await requestFor({ query: "auth refactor", limit: 5 })).toMatchObject(
        { kind: "discover", query: "auth refactor", limit: 5 },
      );
    });

    it("infers read from a bare session_id", async () => {
      expect(await requestFor({ session_id: "sess_9" })).toEqual({
        kind: "read",
        session_id: "sess_9",
      });
    });

    it("infers scroll when session_id and around_message_id are both set", async () => {
      expect(
        await requestFor({
          session_id: "sess_9",
          around_message_id: "evt_3",
          window: 10,
        }),
      ).toEqual({
        kind: "scroll",
        session_id: "sess_9",
        around_message_id: "evt_3",
        window: 10,
      });
    });

    it("lets scroll win over discover when a query is also present", async () => {
      const req = await requestFor({
        query: "ignored",
        session_id: "sess_9",
        around_message_id: "evt_3",
      });

      expect(req.kind).toBe("scroll");
    });

    it("lets read win over discover when a query is also present", async () => {
      const req = await requestFor({ query: "ignored", session_id: "sess_9" });

      expect(req.kind).toBe("read");
    });

    it("falls back to read when around_message_id is present but blank", async () => {
      const req = await requestFor({
        session_id: "sess_9",
        around_message_id: "   ",
      });

      expect(req).toEqual({ kind: "read", session_id: "sess_9" });
    });

    it("trims session_id and around_message_id", async () => {
      expect(
        await requestFor({
          session_id: "  sess_9  ",
          around_message_id: "  evt_3  ",
        }),
      ).toMatchObject({ session_id: "sess_9", around_message_id: "evt_3" });
    });

    it("trims the query and keeps it as the discover term", async () => {
      expect(await requestFor({ query: "  auth refactor  " })).toMatchObject({
        kind: "discover",
        query: "auth refactor",
      });
    });

    it.each([
      ["blank", "   "],
      ["a non-string", 42],
      ["null", null],
    ])("treats %s query as absent and browses instead", async (_l, query) => {
      expect((await requestFor({ query })).kind).toBe("browse");
    });

    it.each([
      ["blank", "   "],
      ["a non-string", 42],
    ])("treats %s session_id as absent and browses instead", async (_l, id) => {
      expect((await requestFor({ session_id: id })).kind).toBe("browse");
    });

    it("supports the synthetic user-turn anchor id format", async () => {
      expect(
        await requestFor({
          session_id: "sess_9",
          around_message_id: "intent:sess_9",
        }),
      ).toMatchObject({ kind: "scroll", around_message_id: "intent:sess_9" });
    });
  });

  describe("numeric passthrough", () => {
    it("forwards limit and window verbatim, leaving clamping to the service", async () => {
      expect(
        await requestFor({ query: "x", limit: 9999 }),
      ).toMatchObject({ limit: 9999 });
      expect(
        await requestFor({
          session_id: "s",
          around_message_id: "e",
          window: 9999,
        }),
      ).toMatchObject({ window: 9999 });
    });

    it("drops non-numeric limit and window so the service applies its defaults", async () => {
      expect(await requestFor({ query: "x", limit: "5" })).toMatchObject({
        limit: undefined,
      });
      expect(
        await requestFor({ session_id: "s", around_message_id: "e", window: "5" }),
      ).toMatchObject({ window: undefined });
    });
  });

  describe("sort", () => {
    it.each(["newest", "oldest"])("passes %s through", async (sort) => {
      expect(await requestFor({ query: "x", sort })).toMatchObject({ sort });
    });

    it.each([
      ["an unknown value", "relevance"],
      ["a non-string", 1],
      ["an omitted field", undefined],
    ])("drops %s", async (_l, sort) => {
      expect(await requestFor({ query: "x", sort })).toMatchObject({
        sort: undefined,
      });
    });
  });

  describe("filters", () => {
    it("forwards filters on discover", async () => {
      const filters = { status: "failed", session_type: "task" };
      expect(await requestFor({ query: "x", filters })).toMatchObject({
        filters,
      });
    });

    it("forwards filters on browse", async () => {
      const filters = { agent_id: "agent_b" };
      expect(await requestFor({ filters })).toMatchObject({ filters });
    });

    it.each([
      ["null", null],
      ["a non-object", "status:failed"],
      ["an omitted field", undefined],
    ])("drops %s filters", async (_l, filters) => {
      expect(await requestFor({ query: "x", filters })).toMatchObject({
        filters: undefined,
      });
    });

    it("does not attach filters to scroll or read", async () => {
      const filters = { status: "failed" };
      expect(await requestFor({ session_id: "s", filters })).not.toHaveProperty(
        "filters",
      );
      expect(
        await requestFor({ session_id: "s", around_message_id: "e", filters }),
      ).not.toHaveProperty("filters");
    });
  });

  describe("results", () => {
    it("returns the service result as the tool content", async () => {
      const h = harness();
      const result = await tool(h).handler({ query: "x" });

      expect(result.isError).toBeFalsy();
      expect(result.content).toBe(OK);
    });

    it("translates a null result into not_found_or_forbidden", async () => {
      const h = harness({ impl: async () => null });
      const result = await tool(h).handler({ session_id: "sess_other" });

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({
        error: "not_found_or_forbidden",
      });
    });
  });

  describe("error translation", () => {
    it.each([
      "forbidden_agent_filter",
      "missing_query",
      "missing_args",
    ] as const)("surfaces the %s code from a SessionSearchError", async (code) => {
      const h = harness({
        impl: async () => {
          throw new SessionSearchError(code, `bad: ${code}`);
        },
      });
      const result = await tool(h).handler({ query: "x" });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual({ error: code, message: `bad: ${code}` });
    });

    it("matches by error name too, so a cross-bundle copy still yields its code", async () => {
      // An src/-bundled SessionSearchError fails `instanceof` against the
      // dist/-bundled class the api imports; the name check is the fallback.
      class ForeignSessionSearchError extends Error {
        code = "forbidden_agent_filter";
        constructor(message: string) {
          super(message);
          this.name = "SessionSearchError";
        }
      }
      const h = harness({
        impl: async () => {
          throw new ForeignSessionSearchError("agent_b is outside your scope");
        },
      });
      const result = await tool(h).handler({ query: "x" });

      expect(result.content).toEqual({
        error: "forbidden_agent_filter",
        message: "agent_b is outside your scope",
      });
    });

    it("degrades an unrelated Error to internal_error", async () => {
      const h = harness({
        impl: async () => {
          throw new Error("connection terminated");
        },
      });
      const result = await tool(h).handler({ query: "x" });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual({
        error: "internal_error",
        message: "connection terminated",
      });
    });

    it("stringifies a thrown non-Error", async () => {
      const h = harness({
        impl: async () => {
          throw "pg down";
        },
      });
      const result = await tool(h).handler({ query: "x" });

      expect(result.content).toEqual({
        error: "internal_error",
        message: "pg down",
      });
    });
  });
});
