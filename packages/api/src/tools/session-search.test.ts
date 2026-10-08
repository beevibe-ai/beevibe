/**
 * session_search MCP tool — unit tests with vitest fakes (no DB).
 *
 * The tool's own logic is the shape inference in `inferRequest`: four
 * request kinds (scroll / read / discover / browse) picked from a loose
 * input bag, with scroll winning when both `session_id` and
 * `around_message_id` are present. That precedence ladder is the thing
 * most likely to regress, so every rung gets a test driven through the
 * handler (inferRequest isn't exported).
 *
 * The caller scope it forwards — agent id, tier, current session — is
 * what the service uses to enforce visibility, so the tests pin that it
 * comes from the tool context and never from the agent-supplied input.
 * `SessionSearchService` is faked; its scoping and FTS behaviour is
 * covered by `session-search-repo.test.ts` against a real DB.
 */
import { describe, expect, it, vi } from "vitest";
import type { HierarchyLevel, SessionSearchRequest } from "@beevibe/core";
import {
  SessionSearchError,
  type SessionSearchService,
} from "@beevibe/core/services/session-search";
import { createSessionSearchTool } from "./session-search.js";

const AGENT = "agent_ic";
const SESSION = "sess_current0001";

function makeTool(
  opts: { result?: unknown; throws?: unknown } = {},
  ctx: { hierarchyLevel?: "ic" | "team" | "org" } = {},
) {
  const search = vi.fn(async (
    _req: SessionSearchRequest,
    _ctx: {
      callerAgentId: string;
      hierarchyLevel: HierarchyLevel;
      currentSessionId: string;
    },
  ) => {
    if (opts.throws !== undefined) throw opts.throws;
    return opts.result === undefined ? { sessions: [] } : opts.result;
  });
  const tool = createSessionSearchTool(
    {
      agentId: AGENT,
      hierarchyLevel: ctx.hierarchyLevel ?? "ic",
      sessionId: SESSION,
    },
    { sessionSearch: { search } as unknown as SessionSearchService },
  );
  return { tool, search };
}

/** The request the handler inferred from a given input bag. */
async function inferred(input: Record<string, unknown>): Promise<SessionSearchRequest> {
  const { tool, search } = makeTool();
  await tool.handler(input);
  return search.mock.calls[0]![0];
}

describe("session_search tool shape", () => {
  it("is named session_search and carries the agent-facing description", () => {
    const { tool } = makeTool();
    expect(tool.name).toBe("session_search");
    expect(tool.description.length).toBeGreaterThan(200);
    expect(tool.schema.type).toBe("object");
  });
});

describe("session_search request inference", () => {
  it("infers browse when nothing useful is supplied", async () => {
    expect(await inferred({})).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("infers discover from a query", async () => {
    expect(await inferred({ query: "  migration rollback  " })).toMatchObject({
      kind: "discover",
      query: "migration rollback",
    });
  });

  it("infers read from a bare session_id", async () => {
    expect(await inferred({ session_id: " sess_other00001 " })).toEqual({
      kind: "read",
      session_id: "sess_other00001",
    });
  });

  it("infers scroll when both session_id and an anchor are supplied", async () => {
    expect(await inferred({ session_id: "sess_other00001", around_message_id: "msg_7" })).toEqual(
      { kind: "scroll", session_id: "sess_other00001", around_message_id: "msg_7", window: undefined },
    );
  });

  it("prefers scroll over read and discover when all three are supplied", async () => {
    const req = await inferred({
      session_id: "sess_other00001",
      around_message_id: "msg_7",
      query: "ignored",
    });
    expect(req.kind).toBe("scroll");
  });

  it("prefers read over discover when a session_id and a query are supplied", async () => {
    const req = await inferred({ session_id: "sess_other00001", query: "ignored" });
    expect(req.kind).toBe("read");
  });

  it.each([
    ["blank", "   "],
    ["a non-string", 7],
    ["null", null],
  ])("treats %s session_id as absent", async (_label, session_id) => {
    expect((await inferred({ session_id, query: "q" })).kind).toBe("discover");
  });

  it.each([
    ["blank", "   "],
    ["a non-string", 7],
  ])("treats %s around_message_id as absent, falling back to read", async (_label, anchor) => {
    const req = await inferred({ session_id: "sess_other00001", around_message_id: anchor });
    expect(req.kind).toBe("read");
  });

  it.each([
    ["blank", "   "],
    ["a non-string", 7],
  ])("treats %s query as absent, falling back to browse", async (_label, query) => {
    expect((await inferred({ query })).kind).toBe("browse");
  });

  it("passes window through on scroll only when numeric", async () => {
    const withWindow = await inferred({
      session_id: "sess_other00001",
      around_message_id: "msg_7",
      window: 20,
    });
    expect(withWindow).toMatchObject({ window: 20 });

    const badWindow = await inferred({
      session_id: "sess_other00001",
      around_message_id: "msg_7",
      window: "20",
    });
    expect(badWindow).toMatchObject({ window: undefined });
  });

  it("passes limit through on discover and browse only when numeric", async () => {
    expect(await inferred({ query: "q", limit: 5 })).toMatchObject({ limit: 5 });
    expect(await inferred({ query: "q", limit: "5" })).toMatchObject({ limit: undefined });
    expect(await inferred({ limit: 9 })).toMatchObject({ kind: "browse", limit: 9 });
  });

  it.each(["newest", "oldest"])("accepts sort=%s on discover", async (sort) => {
    expect(await inferred({ query: "q", sort })).toMatchObject({ sort });
  });

  it("drops an unrecognized sort", async () => {
    expect(await inferred({ query: "q", sort: "relevance" })).toMatchObject({
      sort: undefined,
    });
  });

  it("forwards a filters object on discover and browse", async () => {
    const filters = { type: "chat", status: "succeeded" };
    expect(await inferred({ query: "q", filters })).toMatchObject({ filters });
    expect(await inferred({ filters })).toMatchObject({ kind: "browse", filters });
  });

  it.each([
    ["a non-object", "chat"],
    ["null", null],
  ])("drops %s filters", async (_label, filters) => {
    expect(await inferred({ query: "q", filters })).toMatchObject({
      filters: undefined,
    });
  });
});

describe("session_search caller scope", () => {
  it("takes the caller identity from the tool context, not the input", async () => {
    const { tool, search } = makeTool({}, { hierarchyLevel: "team" });
    await tool.handler({
      query: "q",
      agent_id: "agent_someone_else",
      session_id: undefined,
    });
    expect(search.mock.calls[0]![1]).toEqual({
      callerAgentId: AGENT,
      hierarchyLevel: "team",
      currentSessionId: SESSION,
    });
  });

  it("returns the service result verbatim on success", async () => {
    const result = { sessions: [{ id: "sess_hit000000001", snippet: "…" }], total: 1 };
    const { tool } = makeTool({ result });
    const res = await tool.handler({ query: "q" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual(result);
  });
});

describe("session_search error mapping", () => {
  it("maps a null result onto not_found_or_forbidden", async () => {
    const { tool } = makeTool({ result: null });
    const res = await tool.handler({ session_id: "sess_other00001" });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("not_found_or_forbidden");
    expect(res.content.message).toContain("not in your scope");
  });

  it.each(["forbidden_agent_filter", "missing_query", "missing_args"] as const)(
    "surfaces the %s service error code",
    async (code) => {
      const { tool } = makeTool({ throws: new SessionSearchError(code, `bad: ${code}`) });
      const res = await tool.handler({ query: "q" });
      expect(res.isError).toBe(true);
      expect(res.content).toEqual({ error: code, message: `bad: ${code}` });
    },
  );

  it("matches a cross-bundle SessionSearchError by name, not just instanceof", async () => {
    // An integration script consuming core's src/ while api consumes
    // dist/ throws a structurally identical but non-instanceof error.
    const alien = Object.assign(new Error("filter not allowed"), {
      name: "SessionSearchError",
      code: "forbidden_agent_filter",
    });
    const { tool } = makeTool({ throws: alien });
    const res = await tool.handler({ query: "q" });
    expect(res.content).toEqual({
      error: "forbidden_agent_filter",
      message: "filter not allowed",
    });
  });

  it("wraps any other throw as internal_error", async () => {
    const { tool } = makeTool({ throws: new Error("pg connection reset") });
    const res = await tool.handler({ query: "q" });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "internal_error",
      message: "pg connection reset",
    });
  });

  it("stringifies a non-Error throw under internal_error", async () => {
    const { tool } = makeTool({ throws: "boom" });
    const res = await tool.handler({ query: "q" });
    expect(res.content).toEqual({ error: "internal_error", message: "boom" });
  });
});
