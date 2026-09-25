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
  sessionId: "sess_current",
};

type SearchFn = ReturnType<typeof vi.fn>;

function build(search: SearchFn = vi.fn(async () => ({ kind: "browse", sessions: [] }))) {
  const tool = createSessionSearchTool(CTX, {
    sessionSearch: { search } as unknown as SessionSearchService,
  });
  return { tool, search };
}

/** The request the handler inferred from a raw tool input. */
async function inferred(input: Record<string, unknown>): Promise<SessionSearchRequest> {
  const { tool, search } = build();
  await tool.handler(input);
  return search.mock.calls[0]?.[0] as SessionSearchRequest;
}

describe("session_search tool shape", () => {
  it("is named session_search and documents the four calling shapes", () => {
    const { tool } = build();
    expect(tool.name).toBe("session_search");
    for (const shape of ["DISCOVERY", "SCROLL", "READ", "BROWSE"]) {
      expect(tool.description).toContain(shape);
    }
  });

  it("declares nothing required — the bare call is the browse shape", () => {
    const { tool } = build();
    expect(tool.schema.required).toBeUndefined();
    expect(Object.keys(tool.schema.properties as object)).toEqual(
      expect.arrayContaining(["query", "session_id", "around_message_id", "window", "filters"]),
    );
  });
});

describe("session_search shape inference", () => {
  it("infers scroll when session_id and around_message_id are both present", async () => {
    expect(
      await inferred({
        session_id: " sess_x ",
        around_message_id: " evt_1 ",
        window: 10,
        // A query alongside the scroll args is ignored, per the description.
        query: "ignored",
      }),
    ).toEqual({
      kind: "scroll",
      session_id: "sess_x",
      around_message_id: "evt_1",
      window: 10,
    });
  });

  it("leaves window undefined when it is not a number, so the service default applies", async () => {
    expect(
      await inferred({ session_id: "sess_x", around_message_id: "evt_1", window: "10" }),
    ).toMatchObject({ kind: "scroll", window: undefined });
  });

  it("infers read from a bare session_id", async () => {
    expect(await inferred({ session_id: "sess_x" })).toEqual({
      kind: "read",
      session_id: "sess_x",
    });
  });

  it("infers read when the anchor is blank or not a string", async () => {
    expect(await inferred({ session_id: "sess_x", around_message_id: "  " })).toEqual({
      kind: "read",
      session_id: "sess_x",
    });
    expect(await inferred({ session_id: "sess_x", around_message_id: 7 })).toEqual({
      kind: "read",
      session_id: "sess_x",
    });
  });

  it("infers discover from a query, trimming it and passing limit/sort/filters", async () => {
    expect(
      await inferred({
        query: "  auth refactor  ",
        limit: 5,
        sort: "newest",
        filters: { status: "failed" },
      }),
    ).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: 5,
      sort: "newest",
      filters: { status: "failed" },
    });
  });

  it("drops a sort value outside the newest/oldest enum", async () => {
    expect(await inferred({ query: "x", sort: "relevance" })).toMatchObject({
      kind: "discover",
      sort: undefined,
    });
  });

  it("drops a non-numeric limit", async () => {
    expect(await inferred({ query: "x", limit: "5" })).toMatchObject({
      kind: "discover",
      limit: undefined,
    });
  });

  it("infers browse from no args at all", async () => {
    expect(await inferred({})).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("infers browse when the query and session_id are blank", async () => {
    expect(await inferred({ query: "   ", session_id: "  " })).toMatchObject({
      kind: "browse",
    });
  });

  it("carries limit and filters onto the browse shape", async () => {
    expect(await inferred({ limit: 8, filters: { session_type: "chat" } })).toEqual({
      kind: "browse",
      limit: 8,
      filters: { session_type: "chat" },
    });
  });

  it("drops a null or non-object filters value", async () => {
    expect(await inferred({ query: "x", filters: null })).toMatchObject({
      filters: undefined,
    });
    expect(await inferred({ query: "x", filters: "status:failed" })).toMatchObject({
      filters: undefined,
    });
  });
});

describe("session_search scope threading", () => {
  it("passes the caller agent id, tier and active session id as the scope", async () => {
    const { tool, search } = build();
    await tool.handler({ query: "x" });
    expect(search.mock.calls[0]?.[1]).toEqual({
      callerAgentId: "agent_caller",
      hierarchyLevel: "team",
      currentSessionId: "sess_current",
    });
  });

  it("returns the service result verbatim as the tool content", async () => {
    const payload = { kind: "read", session: { id: "sess_x" }, messages: [] };
    const { tool } = build(vi.fn(async () => payload));
    const result = await tool.handler({ session_id: "sess_x" });
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe(payload);
  });
});

describe("session_search error mapping", () => {
  it("reports not_found_or_forbidden when the service resolves null", async () => {
    const { tool } = build(vi.fn(async () => null));
    const result = await tool.handler({ session_id: "sess_other" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "not_found_or_forbidden" });
  });

  it("surfaces a SessionSearchError's code", async () => {
    const { tool } = build(
      vi.fn(async () => {
        throw new SessionSearchError("forbidden_agent_filter", "agent out of scope");
      }),
    );
    const result = await tool.handler({ query: "x", filters: { agent_id: "agent_other" } });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "forbidden_agent_filter",
      message: "agent out of scope",
    });
  });

  it("surfaces the code from a cross-bundle SessionSearchError matched by name", async () => {
    // Same class from a different bundle: instanceof fails, `name` matches.
    class ForeignSessionSearchError extends Error {
      code = "missing_query";
      constructor(message: string) {
        super(message);
        this.name = "SessionSearchError";
      }
    }
    const { tool } = build(
      vi.fn(async () => {
        throw new ForeignSessionSearchError("query required");
      }),
    );
    const result = await tool.handler({ query: "x" });
    expect(result.content).toEqual({ error: "missing_query", message: "query required" });
  });

  it("wraps any other throw as internal_error", async () => {
    const { tool } = build(
      vi.fn(async () => {
        throw new Error("pool exhausted");
      }),
    );
    const result = await tool.handler({ query: "x" });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "internal_error",
      message: "pool exhausted",
    });
  });

  it("stringifies a non-Error throw under internal_error", async () => {
    const { tool } = build(
      vi.fn(async () => {
        throw "db gone";
      }),
    );
    const result = await tool.handler({ query: "x" });
    expect(result.content).toEqual({ error: "internal_error", message: "db gone" });
  });
});
