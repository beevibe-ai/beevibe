/**
 * `createSessionSearchTool` — Layer-3 memory's MCP surface.
 *
 * The service does the scoping and the SQL; the tool's own job is
 * `inferRequest` — picking one of four calling shapes out of whatever
 * loosely-typed bag the agent sent — plus the error envelope. Both are
 * pinned here against a `vi.fn()` service.
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
  agentId: "agent_a",
  hierarchyLevel: "team",
  sessionId: "sess_current0001",
};

function makeService(impl?: SessionSearchService["search"]): SessionSearchService {
  return {
    search: vi.fn(impl ?? (async () => ({ results: [] }))),
  } as unknown as SessionSearchService;
}

function makeTool(service: SessionSearchService = makeService()) {
  return createSessionSearchTool(CTX, { sessionSearch: service });
}

/** The request the tool inferred from a given raw input bag. */
async function inferred(input: Record<string, unknown>): Promise<SessionSearchRequest> {
  const service = makeService();
  await makeTool(service).handler(input);
  return vi.mocked(service.search).mock.calls[0]![0] as SessionSearchRequest;
}

describe("session_search tool definition", () => {
  it("is named session_search and documents the four shapes", () => {
    const tool = makeTool();
    expect(tool.name).toBe("session_search");
    expect(tool.description).toContain("FOUR CALLING SHAPES");
  });

  it("declares no required fields — the bare call is the browse shape", () => {
    expect(makeTool().schema.required).toBeUndefined();
  });
});

describe("shape inference", () => {
  it("browses when given nothing", async () => {
    expect(await inferred({})).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("discovers when given a query", async () => {
    expect(await inferred({ query: "  auth refactor  ", limit: 7, sort: "newest" })).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: 7,
      sort: "newest",
      filters: undefined,
    });
  });

  it("reads when given a bare session_id", async () => {
    expect(await inferred({ session_id: "  sess_x  " })).toEqual({
      kind: "read",
      session_id: "sess_x",
    });
  });

  it("scrolls when given session_id + around_message_id", async () => {
    expect(
      await inferred({
        session_id: "sess_x",
        around_message_id: "  evt_1  ",
        window: 10,
      }),
    ).toEqual({
      kind: "scroll",
      session_id: "sess_x",
      around_message_id: "evt_1",
      window: 10,
    });
  });

  it("prefers scroll over discover when a query is also present", async () => {
    const req = await inferred({
      session_id: "sess_x",
      around_message_id: "evt_1",
      query: "ignored",
    });
    expect(req.kind).toBe("scroll");
  });

  it("prefers read over discover when a query is also present", async () => {
    const req = await inferred({ session_id: "sess_x", query: "ignored" });
    expect(req.kind).toBe("read");
  });

  it("treats a blank query as no query and browses", async () => {
    expect((await inferred({ query: "   " })).kind).toBe("browse");
  });

  it("treats a blank session_id as absent", async () => {
    expect((await inferred({ session_id: "  ", query: "x" })).kind).toBe("discover");
  });

  it("treats a blank around_message_id as absent, falling back to read", async () => {
    expect((await inferred({ session_id: "sess_x", around_message_id: " " })).kind).toBe(
      "read",
    );
  });

  it("ignores non-string ids and queries", async () => {
    expect((await inferred({ session_id: 42, query: { a: 1 } })).kind).toBe("browse");
  });

  it("drops a non-numeric window, limit and unknown sort rather than passing them on", async () => {
    const scroll = await inferred({
      session_id: "sess_x",
      around_message_id: "evt_1",
      window: "10",
    });
    expect(scroll).toMatchObject({ window: undefined });

    const discover = await inferred({ query: "x", limit: "3", sort: "sideways" });
    expect(discover).toMatchObject({ limit: undefined, sort: undefined });
  });

  it("passes sort=oldest through", async () => {
    expect(await inferred({ query: "x", sort: "oldest" })).toMatchObject({ sort: "oldest" });
  });

  it("forwards a filters object on the discover and browse shapes", async () => {
    const filters = { status: "failed", session_type: "task" };
    expect(await inferred({ query: "x", filters })).toMatchObject({ filters });
    expect(await inferred({ filters })).toMatchObject({ filters });
  });

  it("ignores a non-object filters value", async () => {
    expect(await inferred({ query: "x", filters: "status:failed" })).toMatchObject({
      filters: undefined,
    });
    expect(await inferred({ query: "x", filters: null })).toMatchObject({
      filters: undefined,
    });
  });
});

describe("scope threading", () => {
  it("passes the caller's agent, tier and active session to the service", async () => {
    const service = makeService();
    await makeTool(service).handler({ query: "x" });
    expect(service.search).toHaveBeenCalledWith(expect.anything(), {
      callerAgentId: "agent_a",
      hierarchyLevel: "team",
      currentSessionId: "sess_current0001",
    });
  });
});

describe("result envelope", () => {
  it("returns the service result verbatim on success", async () => {
    const payload = { results: [{ session: { id: "sess_1" } }] };
    const res = await makeTool(makeService(async () => payload as never)).handler({});
    expect(res.isError).toBeUndefined();
    expect(res.content).toBe(payload);
  });

  it("maps a null result to not_found_or_forbidden", async () => {
    const res = await makeTool(makeService(async () => null as never)).handler({
      session_id: "sess_someone_elses",
    });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("not_found_or_forbidden");
  });

  it("surfaces a SessionSearchError's code", async () => {
    const res = await makeTool(
      makeService(async () => {
        throw new SessionSearchError("forbidden_agent_filter", "agent_b is out of scope");
      }),
    ).handler({ query: "x", filters: { agent_id: "agent_b" } });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("forbidden_agent_filter");
    expect(res.content.message).toBe("agent_b is out of scope");
  });

  it("recognizes a cross-bundle SessionSearchError by name", async () => {
    // A duplicate class identity (src/ vs dist/ copies of core) fails
    // `instanceof`; the name check is what keeps the code structured.
    const impostor = new Error("missing query");
    impostor.name = "SessionSearchError";
    (impostor as Error & { code: string }).code = "missing_query";
    const res = await makeTool(
      makeService(async () => {
        throw impostor;
      }),
    ).handler({ query: "x" });
    expect(res.content.error).toBe("missing_query");
  });

  it("wraps an unrelated Error as internal_error", async () => {
    const res = await makeTool(
      makeService(async () => {
        throw new Error("pg: connection reset");
      }),
    ).handler({});
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("internal_error");
    expect(res.content.message).toBe("pg: connection reset");
  });

  it("stringifies a non-Error throw", async () => {
    const res = await makeTool(
      makeService(async () => {
        throw "kaboom";
      }),
    ).handler({});
    expect(res.content.error).toBe("internal_error");
    expect(res.content.message).toBe("kaboom");
  });
});
