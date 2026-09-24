/**
 * session_search MCP tool — unit tests with a fake SessionSearchService.
 *
 * All of the tool's own logic lives in `inferRequest`: four calling
 * shapes distinguished only by which arguments are present, plus the
 * coercions that keep a sloppy agent call from reaching the service as
 * garbage (blank strings, a stringified `limit`, an out-of-enum `sort`).
 * Shape inference is what an agent gets wrong, and a mis-inferred shape
 * fails silently — a `read` where a `scroll` was meant still returns
 * plausible-looking messages — so each shape is pinned explicitly.
 *
 * The rest is the error envelope: `null` from the service means "not in
 * your scope", and SessionSearchError has to keep its code even when
 * only the name matches (src/ vs dist/ dual-loading).
 */
import { describe, expect, it, vi } from "vitest";
import { SessionSearchError } from "@beevibe/core/services/session-search";
import type { SessionSearchService } from "@beevibe/core/services/session-search";
import { createSessionSearchTool, type SessionSearchToolContext } from "./session-search.js";

const CTX: SessionSearchToolContext = {
  agentId: "agent_a",
  hierarchyLevel: "team",
  sessionId: "sess_current",
};

const CALLER = {
  callerAgentId: "agent_a",
  hierarchyLevel: "team",
  currentSessionId: "sess_current",
};

function makeTool(searchImpl?: SessionSearchService["search"]) {
  const search = vi.fn(searchImpl ?? (async () => ({ kind: "browse", sessions: [] })));
  const sessionSearch = { search } as unknown as SessionSearchService;
  return { tool: createSessionSearchTool(CTX, { sessionSearch }), search };
}

/**
 * The request the tool inferred from one handler call, widened to a bag
 * of fields so a test can assert on a key the *other* shapes don't
 * declare (that a scroll drops `limit` is exactly the point).
 */
async function inferred(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { tool, search } = makeTool();
  await tool.handler(input);
  return search.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
}

describe("session_search tool definition", () => {
  it("has no required arguments — the bare call is the browse shape", () => {
    const { tool } = makeTool();
    expect(tool.name).toBe("session_search");
    expect(tool.schema.required).toBeUndefined();
  });

  it("documents the four shapes in its description", () => {
    const { tool } = makeTool();
    for (const shape of ["DISCOVERY", "SCROLL", "READ", "BROWSE"]) {
      expect(tool.description).toContain(shape);
    }
  });
});

describe("shape inference", () => {
  it("browses on a bare call", async () => {
    expect(await inferred({})).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("discovers when only a query is given", async () => {
    expect(await inferred({ query: "  auth refactor  ", limit: 7, sort: "newest" })).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: 7,
      sort: "newest",
      filters: undefined,
    });
  });

  it("reads when only a session_id is given", async () => {
    expect(await inferred({ session_id: "  sess_x  " })).toEqual({
      kind: "read",
      session_id: "sess_x",
    });
  });

  it("scrolls when session_id and around_message_id are both given", async () => {
    expect(
      await inferred({
        session_id: "sess_x",
        around_message_id: " evt_1 ",
        window: 10,
      }),
    ).toEqual({
      kind: "scroll",
      session_id: "sess_x",
      around_message_id: "evt_1",
      window: 10,
    });
  });

  it("lets scroll win over a query passed alongside it", async () => {
    const req = await inferred({
      query: "ignored",
      session_id: "sess_x",
      around_message_id: "evt_1",
    });
    expect(req.kind).toBe("scroll");
  });

  it("lets read win over a query passed alongside it", async () => {
    expect((await inferred({ query: "ignored", session_id: "sess_x" })).kind).toBe("read");
  });

  it("treats blank strings as absent, falling back to browse", async () => {
    const req = await inferred({ query: "   ", session_id: "  ", around_message_id: "  " });
    expect(req.kind).toBe("browse");
  });

  it("falls back to browse when session_id is blank but an anchor is present", async () => {
    // A scroll without a session is not a scroll — and a blank id must
    // not reach the repo as a literal "" lookup.
    const req = await inferred({ session_id: "", around_message_id: "evt_1" });
    expect(req.kind).toBe("browse");
  });

  it("drops a non-number window / limit rather than forwarding it", async () => {
    const scroll = await inferred({
      session_id: "sess_x",
      around_message_id: "evt_1",
      window: "10",
    });
    expect(scroll.window).toBeUndefined();
    const discover = await inferred({ query: "x", limit: "5" });
    expect(discover.limit).toBeUndefined();
  });

  it("drops a sort value outside the enum", async () => {
    expect((await inferred({ query: "x", sort: "relevance" })).sort).toBeUndefined();
    expect((await inferred({ query: "x", sort: "oldest" })).sort).toBe("oldest");
  });

  it("forwards filters on the discover and browse shapes", async () => {
    const filters = { session_type: "task", status: "failed" };
    expect((await inferred({ query: "x", filters })).filters).toEqual(filters);
    expect((await inferred({ filters })).filters).toEqual(filters);
  });

  it("ignores a non-object filters value", async () => {
    expect((await inferred({ query: "x", filters: "status:failed" })).filters).toBeUndefined();
    expect((await inferred({ query: "x", filters: null })).filters).toBeUndefined();
  });
});

describe("caller scope", () => {
  it("passes the caller's agent, tier and active session to the service", async () => {
    const { tool, search } = makeTool();
    await tool.handler({ query: "x" });
    expect(search.mock.calls[0]?.[1]).toEqual(CALLER);
  });
});

describe("result envelope", () => {
  it("returns the service payload verbatim on success", async () => {
    const payload = { kind: "read", messages: [{ id: "evt_1", role: "user" }] };
    const { tool } = makeTool(async () => payload as never);
    const res = await tool.handler({ session_id: "sess_x" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual(payload);
  });

  it("turns a null result into the out-of-scope error", async () => {
    const { tool } = makeTool(async () => null as never);
    const res = await tool.handler({ session_id: "sess_x" });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("not_found_or_forbidden");
  });

  it("keeps a SessionSearchError's code", async () => {
    const { tool } = makeTool(async () => {
      throw new SessionSearchError("forbidden_agent_filter", "agent outside your scope");
    });
    const res = await tool.handler({ query: "x", filters: { agent_id: "agent_other" } });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "forbidden_agent_filter",
      message: "agent outside your scope",
    });
  });

  it("keeps the code for a cross-bundle SessionSearchError matched by name", async () => {
    // src/ and dist/ copies of the class fail `instanceof`; the handler
    // falls back to the `name` check so the code still survives.
    const lookalike = Object.assign(new Error("query is required"), {
      name: "SessionSearchError",
      code: "missing_query",
    });
    const { tool } = makeTool(async () => {
      throw lookalike;
    });
    const res = await tool.handler({ query: "x" });
    expect(res.content).toEqual({ error: "missing_query", message: "query is required" });
  });

  it("degrades an unrelated throw to internal_error", async () => {
    const { tool } = makeTool(async () => {
      throw new Error("connection terminated");
    });
    const res = await tool.handler({ query: "x" });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "internal_error",
      message: "connection terminated",
    });
  });

  it("stringifies a non-Error throw", async () => {
    const { tool } = makeTool(async () => {
      throw "pg exploded";
    });
    const res = await tool.handler({ query: "x" });
    expect(res.content).toEqual({ error: "internal_error", message: "pg exploded" });
  });
});
