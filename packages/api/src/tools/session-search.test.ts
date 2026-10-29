/**
 * session_search — unit tests over a faked SessionSearchService (no DB).
 *
 * All the logic in this module is `inferRequest`: four calling shapes
 * discriminated from one flat input bag, with scroll winning over read
 * and read winning over discover. Get that precedence wrong and an
 * agent asking to scroll inside a session silently gets the whole
 * transcript instead. The rest is the error envelope — the `null`
 * return (out of scope / anchor gone) and the code-preserving
 * SessionSearchError branch, which matches by `name` as well as
 * `instanceof` so a cross-bundle import still yields a stable code.
 */
import { describe, expect, it, vi } from "vitest";
import type { HierarchyLevel, SessionSearchRequest } from "@beevibe/core";
import {
  SessionSearchError,
  type SessionSearchService,
} from "@beevibe/core/services/session-search";
import { createSessionSearchTool } from "./session-search.js";

const CTX = {
  agentId: "agent_caller",
  hierarchyLevel: "team" as HierarchyLevel,
  sessionId: "sess_current",
};

function harness(
  searchImpl?: (req: SessionSearchRequest, ctx: unknown) => Promise<unknown>,
) {
  const search = vi.fn(searchImpl ?? (async () => ({ kind: "browse", sessions: [] })));
  const tool = createSessionSearchTool(CTX, {
    sessionSearch: { search } as unknown as SessionSearchService,
  });
  return { tool, search };
}

/** The request `inferRequest` produced for `input`. */
async function inferred(input: Record<string, unknown>): Promise<SessionSearchRequest> {
  const { tool, search } = harness();
  await tool.handler(input);
  return search.mock.calls[0]?.[0] as SessionSearchRequest;
}

describe("session_search tool surface", () => {
  it("is named session_search and ships the four-shape contract in its description", () => {
    const { tool } = harness();
    expect(tool.name).toBe("session_search");
    for (const shape of ["DISCOVERY", "SCROLL", "READ", "BROWSE"]) {
      expect(tool.description).toContain(shape);
    }
  });

  it("declares no required args, since the bare call is the browse shape", () => {
    const { tool } = harness();
    expect((tool.schema as { required?: string[] }).required).toBeUndefined();
  });

  it("passes the caller context through on every call", async () => {
    const { tool, search } = harness();
    await tool.handler({});
    expect(search.mock.calls[0]?.[1]).toEqual({
      callerAgentId: "agent_caller",
      hierarchyLevel: "team",
      currentSessionId: "sess_current",
    });
  });
});

describe("shape inference", () => {
  it("infers browse from an empty input", async () => {
    expect(await inferred({})).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("infers discover from a query", async () => {
    expect(await inferred({ query: "auth refactor", limit: 3, sort: "newest" })).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: 3,
      sort: "newest",
      filters: undefined,
    });
  });

  it("infers read from a bare session_id", async () => {
    expect(await inferred({ session_id: "sess_past" })).toEqual({
      kind: "read",
      session_id: "sess_past",
    });
  });

  it("infers scroll when session_id and around_message_id are both set", async () => {
    expect(
      await inferred({ session_id: "sess_past", around_message_id: "evt_9", window: 10 }),
    ).toEqual({
      kind: "scroll",
      session_id: "sess_past",
      around_message_id: "evt_9",
      window: 10,
    });
  });

  it("lets scroll win over a query that is also present", async () => {
    const req = await inferred({
      query: "ignored",
      session_id: "sess_past",
      around_message_id: "evt_9",
    });
    expect(req.kind).toBe("scroll");
  });

  it("lets read win over a query that is also present", async () => {
    const req = await inferred({ query: "ignored", session_id: "sess_past" });
    expect(req).toEqual({ kind: "read", session_id: "sess_past" });
  });

  it("falls back to read when around_message_id is blank", async () => {
    expect(await inferred({ session_id: "sess_past", around_message_id: "   " })).toEqual({
      kind: "read",
      session_id: "sess_past",
    });
  });

  it("falls back to browse when every string arg is blank", async () => {
    const req = await inferred({ query: "  ", session_id: "   ", around_message_id: "  " });
    expect(req.kind).toBe("browse");
  });

  it("ignores non-string query / session_id / around_message_id", async () => {
    const req = await inferred({ query: 5, session_id: {}, around_message_id: [] });
    expect(req.kind).toBe("browse");
  });

  it("trims the query, session_id and anchor", async () => {
    expect(
      await inferred({ session_id: "  sess_past  ", around_message_id: "  evt_9  " }),
    ).toMatchObject({ session_id: "sess_past", around_message_id: "evt_9" });

    expect(await inferred({ query: "  spaced out  " })).toMatchObject({
      query: "spaced out",
    });
  });

  it("accepts the synthetic user-turn anchor id format", async () => {
    expect(
      await inferred({ session_id: "sess_past", around_message_id: "intent:sess_past" }),
    ).toMatchObject({ kind: "scroll", around_message_id: "intent:sess_past" });
  });
});

describe("numeric and enum coercion", () => {
  it("drops a non-numeric window, leaving the service default", async () => {
    expect(await inferred({ session_id: "s", around_message_id: "a", window: "10" })).toMatchObject(
      { window: undefined },
    );
  });

  it("drops a non-numeric limit on discover and on browse", async () => {
    expect(await inferred({ query: "x", limit: "3" })).toMatchObject({ limit: undefined });
    expect(await inferred({ limit: null })).toMatchObject({ limit: undefined });
  });

  it("keeps a numeric limit on the browse shape too", async () => {
    expect(await inferred({ limit: 7 })).toEqual({
      kind: "browse",
      limit: 7,
      filters: undefined,
    });
  });

  it("passes window and limit straight through without clamping them here", async () => {
    // Clamping is the service's job; the adapter must not pre-clamp or the
    // two layers can disagree about what the agent asked for.
    expect(await inferred({ session_id: "s", around_message_id: "a", window: 999 })).toMatchObject(
      { window: 999 },
    );
    expect(await inferred({ query: "x", limit: 999 })).toMatchObject({ limit: 999 });
  });

  it.each(["newest", "oldest"])("keeps sort=%s", async (sort) => {
    expect(await inferred({ query: "x", sort })).toMatchObject({ sort });
  });

  it.each([["an unknown value", "relevance"], ["a number", 1]])(
    "drops sort when it is %s",
    async (_label, sort) => {
      expect(await inferred({ query: "x", sort })).toMatchObject({ sort: undefined });
    },
  );
});

describe("filters", () => {
  it("forwards a filters object verbatim on discover and browse", async () => {
    const filters = { session_type: "task", status: "failed", since: "2026-01-01T00:00:00Z" };
    expect(await inferred({ query: "x", filters })).toMatchObject({ filters });
    expect(await inferred({ filters })).toMatchObject({ filters });
  });

  it.each([
    ["null", null],
    ["a string", "status:failed"],
    ["omitted", undefined],
  ])("drops filters that are %s", async (_label, filters) => {
    expect(await inferred({ query: "x", filters })).toMatchObject({ filters: undefined });
  });

  it("does not forward filters on the scroll or read shapes", async () => {
    const filters = { status: "failed" };
    expect(await inferred({ session_id: "s", filters })).toEqual({
      kind: "read",
      session_id: "s",
    });
    expect(await inferred({ session_id: "s", around_message_id: "a", filters })).not.toHaveProperty(
      "filters",
    );
  });
});

describe("results and errors", () => {
  it("returns the service result as the tool content", async () => {
    const result = { kind: "read", session: { id: "sess_past" }, messages: [] };
    const { tool } = harness(async () => result);

    const res = await tool.handler({ session_id: "sess_past" });

    expect(res.isError).toBeFalsy();
    expect(res.content).toBe(result);
  });

  it("maps a null result to not_found_or_forbidden", async () => {
    const { tool } = harness(async () => null);

    const res = await tool.handler({ session_id: "sess_other" });

    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "not_found_or_forbidden" });
    expect((res.content as { message: string }).message).toContain("not in your scope");
  });

  it.each(["forbidden_agent_filter", "missing_query", "missing_args"] as const)(
    "preserves the %s code from a SessionSearchError",
    async (code) => {
      const { tool } = harness(async () => {
        throw new SessionSearchError(code, `nope: ${code}`);
      });

      const res = await tool.handler({ query: "x" });

      expect(res.isError).toBe(true);
      expect(res.content).toEqual({ error: code, message: `nope: ${code}` });
    },
  );

  it("preserves the code of a cross-bundle SessionSearchError matched by name", async () => {
    // Same shape, different class identity — what an integration script
    // consuming core's src/ while the api consumes dist/ would throw.
    const foreign = Object.assign(new Error("out of scope"), {
      name: "SessionSearchError",
      code: "forbidden_agent_filter",
    });
    const { tool } = harness(async () => {
      throw foreign;
    });

    const res = await tool.handler({ query: "x" });

    expect(res.content).toEqual({
      error: "forbidden_agent_filter",
      message: "out of scope",
    });
  });

  it("degrades an unexpected Error to internal_error", async () => {
    const { tool } = harness(async () => {
      throw new Error("pool exhausted");
    });

    const res = await tool.handler({ query: "x" });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: "internal_error", message: "pool exhausted" });
  });

  it("stringifies a non-Error throw", async () => {
    const { tool } = harness(async () => {
      throw "boom";
    });

    expect((await tool.handler({ query: "x" })).content).toEqual({
      error: "internal_error",
      message: "boom",
    });
  });
});
