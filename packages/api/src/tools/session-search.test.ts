/**
 * session_search MCP tool — unit tests with a fake SessionSearchService.
 *
 * The service (scope resolution, FTS, windowing) has its own suite; what
 * this file pins is the tool's two jobs:
 *
 *   1. `inferRequest` — mapping loose MCP input onto one of the four
 *      request shapes. The precedence (scroll > read > discover >
 *      browse) is the agent-facing contract documented in the tool
 *      description, and nothing else asserts it.
 *   2. The result envelope — the `null` → not_found_or_forbidden
 *      translation, and SessionSearchError's structured code surviving
 *      both `instanceof` and the name-match fallback used when api
 *      consumes dist/ while a script consumes src/.
 */
import { describe, expect, it, vi } from "vitest";
import type { HierarchyLevel, SessionSearchRequest } from "@beevibe/core";
import {
  SessionSearchError,
  type SessionSearchService,
} from "@beevibe/core/services/session-search";
import { createSessionSearchTool } from "./session-search.js";
import type { AgentTool, AgentToolResult } from "./types.js";

// ── Fakes ────────────────────────────────────────────────────────────────

const AGENT_ID = "agent_searcher";
const SESSION_ID = "sess_current";

interface Harness {
  tool: AgentTool;
  search: ReturnType<typeof vi.fn>;
}

function harness(
  opts: { impl?: () => unknown; hierarchyLevel?: HierarchyLevel } = {},
): Harness {
  const search = vi
    .fn()
    .mockImplementation(opts.impl ?? (async () => ({ kind: "browse", sessions: [] })));
  const tool = createSessionSearchTool(
    {
      agentId: AGENT_ID,
      hierarchyLevel: opts.hierarchyLevel ?? "team",
      sessionId: SESSION_ID,
    },
    { sessionSearch: { search } as unknown as SessionSearchService },
  );
  return { tool, search };
}

/**
 * The request the tool inferred from `input`. Widened over the four
 * shapes' optional fields so a test can assert on, say, `limit` without
 * first narrowing by `kind`.
 */
type InferredRequest = SessionSearchRequest & {
  limit?: number;
  sort?: string;
  filters?: Record<string, unknown>;
  window?: number;
};

async function inferred(
  input: Record<string, unknown>,
): Promise<InferredRequest> {
  const h = harness();
  await h.tool.handler(input);
  return h.search.mock.calls[0]?.[0] as InferredRequest;
}

// ── Static surface ───────────────────────────────────────────────────────

describe("createSessionSearchTool — surface", () => {
  it("is named session_search and takes no required args", () => {
    const { tool } = harness();
    expect(tool.name).toBe("session_search");
    // Every shape is optional — a bare call is the browse shape.
    expect((tool.schema as { required?: string[] }).required).toBeUndefined();
  });

  it("documents all four calling shapes in the agent-facing description", () => {
    const { tool } = harness();
    for (const shape of ["DISCOVERY", "SCROLL", "READ", "BROWSE"]) {
      expect(tool.description).toContain(shape);
    }
  });
});

// ── Caller context threading ─────────────────────────────────────────────

describe("createSessionSearchTool — caller context", () => {
  it("passes the caller's agent id, tier and active session through to the service", async () => {
    const h = harness({ hierarchyLevel: "org" });
    await h.tool.handler({});
    expect(h.search.mock.calls[0]?.[1]).toEqual({
      callerAgentId: AGENT_ID,
      hierarchyLevel: "org",
      currentSessionId: SESSION_ID,
    });
  });
});

// ── Shape inference ──────────────────────────────────────────────────────

describe("inferRequest — browse", () => {
  it("treats a bare call as browse", async () => {
    expect(await inferred({})).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("carries limit and filters into browse", async () => {
    expect(
      await inferred({ limit: 7, filters: { status: "failed" } }),
    ).toEqual({ kind: "browse", limit: 7, filters: { status: "failed" } });
  });

  it("drops a non-numeric limit so the service applies its default", async () => {
    expect((await inferred({ limit: "7" })).limit).toBeUndefined();
  });

  it("treats a whitespace-only query as no query at all", async () => {
    expect((await inferred({ query: "   " })).kind).toBe("browse");
  });
});

describe("inferRequest — discover", () => {
  it("infers discover from a query and trims it", async () => {
    expect(await inferred({ query: "  auth refactor " })).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: undefined,
      sort: undefined,
      filters: undefined,
    });
  });

  it.each([["newest"], ["oldest"]])("passes sort=%s through", async (sort) => {
    expect((await inferred({ query: "q", sort })).sort).toBe(sort);
  });

  it("drops an unknown sort value", async () => {
    expect((await inferred({ query: "q", sort: "relevance" })).sort).toBeUndefined();
  });

  it("carries filters into discover", async () => {
    const filters = { session_type: "task", since: "2026-01-01T00:00:00Z" };
    expect((await inferred({ query: "q", filters })).filters).toEqual(filters);
  });

  it("ignores a null filters value rather than forwarding it", async () => {
    expect((await inferred({ query: "q", filters: null })).filters).toBeUndefined();
  });

  it("ignores a non-object filters value", async () => {
    expect((await inferred({ query: "q", filters: "status:failed" })).filters).toBeUndefined();
  });
});

describe("inferRequest — read", () => {
  it("infers read from a bare session_id and trims it", async () => {
    expect(await inferred({ session_id: " sess_abc " })).toEqual({
      kind: "read",
      session_id: "sess_abc",
    });
  });

  it("prefers read over discover when both session_id and query are set", async () => {
    expect((await inferred({ session_id: "sess_abc", query: "auth" })).kind).toBe(
      "read",
    );
  });

  it("falls back to the query when session_id is blank", async () => {
    expect((await inferred({ session_id: "  ", query: "auth" })).kind).toBe(
      "discover",
    );
  });
});

describe("inferRequest — scroll", () => {
  it("infers scroll from session_id + around_message_id", async () => {
    expect(
      await inferred({ session_id: "sess_abc", around_message_id: " evt_1 " }),
    ).toEqual({
      kind: "scroll",
      session_id: "sess_abc",
      around_message_id: "evt_1",
      window: undefined,
    });
  });

  it("wins over discover when a query is also present", async () => {
    const req = await inferred({
      session_id: "sess_abc",
      around_message_id: "evt_1",
      query: "auth",
    });
    expect(req.kind).toBe("scroll");
  });

  it("passes window through and leaves clamping to the service", async () => {
    // The tool deliberately does not clamp — [1,20] is enforced in one
    // place so the tool and HTTP callers can't disagree.
    const req = await inferred({
      session_id: "sess_abc",
      around_message_id: "evt_1",
      window: 999,
    });
    expect(req.window).toBe(999);
  });

  it("drops a non-numeric window", async () => {
    const req = await inferred({
      session_id: "sess_abc",
      around_message_id: "evt_1",
      window: "10",
    });
    expect(req.window).toBeUndefined();
  });

  it("degrades to read when the anchor is blank", async () => {
    const req = await inferred({ session_id: "sess_abc", around_message_id: " " });
    expect(req).toEqual({ kind: "read", session_id: "sess_abc" });
  });
});

// ── Result envelope ──────────────────────────────────────────────────────

describe("createSessionSearchTool — result envelope", () => {
  it("returns the service payload verbatim on success", async () => {
    const payload = { kind: "read", session: { id: "sess_abc" }, messages: [] };
    const h = harness({ impl: async () => payload });
    const res = await h.tool.handler({ session_id: "sess_abc" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toBe(payload);
  });

  it("maps a null result onto one not_found_or_forbidden envelope", async () => {
    // Out-of-scope session, missing anchor and self-anchor all collapse
    // to null on purpose — the tool must not leak which it was.
    const h = harness({ impl: async () => null });
    const res = await h.tool.handler({ session_id: "sess_other" });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("not_found_or_forbidden");
    expect(String(res.content.message)).toContain("not in your scope");
  });
});

// ── Error mapping ────────────────────────────────────────────────────────

describe("createSessionSearchTool — error mapping", () => {
  it.each([
    ["forbidden_agent_filter"],
    ["missing_query"],
    ["missing_args"],
  ] as const)("surfaces SessionSearchError code %s", async (code) => {
    const h = harness({
      impl: () => {
        throw new SessionSearchError(code, `nope: ${code}`);
      },
    });
    const res = await h.tool.handler({ query: "q" });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: code, message: `nope: ${code}` });
  });

  it("matches by error name too, for the src/dist cross-bundle case", async () => {
    // Same shape, different class identity — what an integration script
    // importing src/ while the api consumes dist/ actually throws.
    class ForeignSessionSearchError extends Error {
      code = "forbidden_agent_filter";
      constructor(message: string) {
        super(message);
        this.name = "SessionSearchError";
      }
    }
    const h = harness({
      impl: () => {
        throw new ForeignSessionSearchError("out of scope");
      },
    });
    const res = await h.tool.handler({ query: "q", filters: { agent_id: "agent_x" } });
    expect(res.content).toEqual({
      error: "forbidden_agent_filter",
      message: "out of scope",
    });
  });

  it("degrades an unrelated Error to internal_error", async () => {
    const h = harness({
      impl: () => {
        throw new Error("connection terminated unexpectedly");
      },
    });
    const res = await h.tool.handler({ query: "q" });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "internal_error",
      message: "connection terminated unexpectedly",
    });
  });

  it("stringifies a non-Error throw", async () => {
    const h = harness({
      impl: () => {
        throw "boom";
      },
    });
    const res: AgentToolResult = await h.tool.handler({});
    expect(res.content).toEqual({ error: "internal_error", message: "boom" });
  });
});
