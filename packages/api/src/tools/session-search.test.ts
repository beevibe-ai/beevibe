/**
 * `createSessionSearchTool` — shape inference and the handler's error
 * mapping, with a fake `SessionSearchService` (no DB, no FTS).
 *
 * The interesting logic is `inferRequest`: four request shapes picked
 * from one flat input bag, each with its own optional-field coercion.
 * It isn't exported, so it is exercised through the handler and read
 * back off the service spy. The handler's three result shapes (ok,
 * null → not_found_or_forbidden, throw → structured code) round it out.
 */
import { describe, expect, it, vi } from "vitest";
import type { SessionSearchRequest } from "@beevibe/core";
import { SessionSearchError } from "@beevibe/core/services/session-search";
import type { SessionSearchService } from "@beevibe/core/services/session-search";
import { createSessionSearchTool } from "./session-search.js";

const CTX = {
  agentId: "agent_caller01",
  hierarchyLevel: "team" as const,
  sessionId: "sess_current0001",
};

function makeTool(searchImpl?: SessionSearchService["search"]) {
  const search = vi.fn(searchImpl ?? (async () => ({ results: [] })));
  const tool = createSessionSearchTool(CTX, {
    sessionSearch: { search } as unknown as SessionSearchService,
  });
  return { tool, search };
}

/** Run the handler and hand back the request `inferRequest` produced. */
async function requestFor(input: Record<string, unknown>): Promise<SessionSearchRequest> {
  const { tool, search } = makeTool();
  await tool.handler(input);
  return search.mock.calls[0]![0] as SessionSearchRequest;
}

describe("tool definition", () => {
  it("exposes the name, a non-empty description and a schema", () => {
    const { tool } = makeTool();
    expect(tool.name).toBe("session_search");
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.schema).toMatchObject({ type: "object" });
  });
});

describe("inferRequest — shape selection", () => {
  it("scrolls when both session_id and around_message_id are set", async () => {
    expect(
      await requestFor({ session_id: "sess_target00001", around_message_id: "ev_42" }),
    ).toEqual({
      kind: "scroll",
      session_id: "sess_target00001",
      around_message_id: "ev_42",
      window: undefined,
    });
  });

  it("prefers scroll over discover when a query is also present", async () => {
    const req = await requestFor({
      session_id: "sess_target00001",
      around_message_id: "ev_42",
      query: "ignored",
    });
    expect(req.kind).toBe("scroll");
  });

  it("reads when only session_id is set, even alongside a query", async () => {
    expect(await requestFor({ session_id: "sess_target00001", query: "ignored" })).toEqual({
      kind: "read",
      session_id: "sess_target00001",
    });
  });

  it("discovers on a bare query", async () => {
    expect(await requestFor({ query: "postgres migration" })).toEqual({
      kind: "discover",
      query: "postgres migration",
      limit: undefined,
      sort: undefined,
      filters: undefined,
    });
  });

  it("browses when nothing identifying is supplied", async () => {
    expect(await requestFor({})).toEqual({ kind: "browse", limit: undefined, filters: undefined });
  });

  it("falls back to browse when an anchor is given with no session_id", async () => {
    expect(await requestFor({ around_message_id: "ev_42" })).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });
});

describe("inferRequest — input coercion", () => {
  it("trims the session id, anchor and query", async () => {
    expect(await requestFor({ session_id: "  sess_target00001  " })).toMatchObject({
      session_id: "sess_target00001",
    });
    expect(
      await requestFor({ session_id: " sess_t ", around_message_id: "  ev_42 " }),
    ).toMatchObject({ session_id: "sess_t", around_message_id: "ev_42" });
    expect(await requestFor({ query: "  spaced  " })).toMatchObject({ query: "spaced" });
  });

  it.each([
    ["whitespace-only", "   "],
    ["empty", ""],
    ["a non-string", 7],
  ])("treats %s identifying fields as absent", async (_label, value) => {
    const req = await requestFor({ session_id: value, around_message_id: value, query: value });
    expect(req.kind).toBe("browse");
  });

  it("passes a numeric window, limit and a valid sort through", async () => {
    expect(
      await requestFor({ session_id: "sess_a", around_message_id: "ev_1", window: 25 }),
    ).toMatchObject({ window: 25 });
    expect(await requestFor({ query: "x", limit: 5, sort: "oldest" })).toMatchObject({
      limit: 5,
      sort: "oldest",
    });
    expect(await requestFor({ query: "x", sort: "newest" })).toMatchObject({ sort: "newest" });
    expect(await requestFor({ limit: 3 })).toMatchObject({ kind: "browse", limit: 3 });
  });

  it("drops a non-numeric window/limit and an unrecognized sort", async () => {
    expect(
      await requestFor({ session_id: "sess_a", around_message_id: "ev_1", window: "25" }),
    ).toMatchObject({ window: undefined });
    expect(await requestFor({ query: "x", limit: "5", sort: "sideways" })).toMatchObject({
      limit: undefined,
      sort: undefined,
    });
  });

  it("forwards a filters object on discover and browse", async () => {
    const filters = { agent_ids: ["agent_x"], type: "task" };
    expect(await requestFor({ query: "x", filters })).toMatchObject({ filters });
    expect(await requestFor({ filters })).toMatchObject({ kind: "browse", filters });
  });

  it.each([
    ["null", null],
    ["a string", "agent_x"],
    ["absent", undefined],
  ])("drops filters that are %s", async (_label, filters) => {
    expect(await requestFor({ query: "x", filters })).toMatchObject({ filters: undefined });
  });
});

describe("handler — caller scope and results", () => {
  it("passes the caller context through to the service", async () => {
    const { tool, search } = makeTool();

    await tool.handler({ query: "x" });

    expect(search).toHaveBeenCalledWith(expect.anything(), {
      callerAgentId: "agent_caller01",
      hierarchyLevel: "team",
      currentSessionId: "sess_current0001",
    });
  });

  it("returns the service result unwrapped and unflagged", async () => {
    const payload = { results: [{ session_id: "sess_hit" }], total: 1 };
    const { tool } = makeTool(async () => payload as never);

    const res = await tool.handler({ query: "x" });

    expect(res).toEqual({ content: payload });
    expect(res.isError).toBeUndefined();
  });

  it("maps a null result to not_found_or_forbidden", async () => {
    const { tool } = makeTool(async () => null as never);

    const res = await tool.handler({ session_id: "sess_notmine0001" });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("not_found_or_forbidden");
  });
});

describe("handler — error mapping", () => {
  it.each(["forbidden_agent_filter", "missing_query", "missing_args"] as const)(
    "surfaces the %s code from a SessionSearchError",
    async (code) => {
      const { tool } = makeTool(async () => {
        throw new SessionSearchError(code, `rejected: ${code}`);
      });

      const res = await tool.handler({ query: "x" });

      expect(res).toEqual({
        content: { error: code, message: `rejected: ${code}` },
        isError: true,
      });
    },
  );

  it("matches a cross-bundle SessionSearchError by name, not instanceof", async () => {
    // A copy of the class loaded from src/ rather than dist/ fails
    // `instanceof` but still carries the name and code.
    const foreign = Object.assign(new Error("other bundle"), {
      name: "SessionSearchError",
      code: "missing_query",
    });
    const { tool } = makeTool(async () => {
      throw foreign;
    });

    const res = await tool.handler({ query: "x" });

    expect(res).toEqual({
      content: { error: "missing_query", message: "other bundle" },
      isError: true,
    });
  });

  it("wraps an unrelated Error as internal_error", async () => {
    const { tool } = makeTool(async () => {
      throw new Error("connection terminated unexpectedly");
    });

    const res = await tool.handler({ query: "x" });

    expect(res).toEqual({
      content: { error: "internal_error", message: "connection terminated unexpectedly" },
      isError: true,
    });
  });

  it("stringifies a non-Error throw", async () => {
    const { tool } = makeTool(async () => {
      throw "pg went away";
    });

    const res = await tool.handler({ query: "x" });

    expect(res.content).toEqual({ error: "internal_error", message: "pg went away" });
  });
});
