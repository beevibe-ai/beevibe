/**
 * session_search — unit tests with vitest fakes (no DB).
 *
 * The service and repo layers own scope resolution and the FTS queries
 * (covered by the Postgres-gated session-search-repo suite). What this
 * module owns, and what is tested here, is `inferRequest`: turning loose
 * MCP tool input into one of the four typed request shapes. The
 * precedence rules matter — scroll beats read beats discover beats
 * browse — because an agent that passes both `session_id` and `query`
 * must get a deterministic shape rather than whichever branch happens
 * to run first.
 *
 * Also pinned: the `null` → not_found_or_forbidden envelope, and the
 * name-based SessionSearchError match that keeps error codes intact
 * across the src/ vs dist/ bundle split.
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

// ── Fakes ────────────────────────────────────────────────────────────────

const RESULT = { kind: "browse", sessions: [] } as unknown as Awaited<
  ReturnType<SessionSearchService["search"]>
>;

function buildService(
  impl?: SessionSearchService["search"],
): { services: { sessionSearch: SessionSearchService }; search: ReturnType<typeof vi.fn> } {
  const search = (impl ?? vi.fn(async () => RESULT)) as ReturnType<typeof vi.fn>;
  return {
    services: { sessionSearch: { search } as unknown as SessionSearchService },
    search,
  };
}

const CTX: SessionSearchToolContext = {
  agentId: "agent_a",
  hierarchyLevel: "team",
  sessionId: "sess_current",
};

function tool(
  services = buildService().services,
  ctx: Partial<SessionSearchToolContext> = {},
) {
  return createSessionSearchTool({ ...CTX, ...ctx }, services);
}

/**
 * A flat view of every field across the four request shapes.
 * `SessionSearchRequest` is a discriminated union, so reading `.window` off
 * a value that might be a BrowseRequest doesn't typecheck — but these tests
 * are asserting exactly which fields the inference produced, including the
 * ones it left off. Keyed to the union so a renamed field still breaks here.
 */
type RequestView = {
  kind: SessionSearchRequest["kind"];
  query?: unknown;
  limit?: unknown;
  sort?: unknown;
  session_id?: unknown;
  around_message_id?: unknown;
  window?: unknown;
  filters?: unknown;
};

/** Run the handler and return the request the service was handed. */
async function requestFor(
  input: Record<string, unknown>,
): Promise<RequestView> {
  const { services, search } = buildService();
  await tool(services).handler(input);
  const args = search.mock.calls[0];
  if (!args) throw new Error("the service was never called");
  return args[0] as RequestView;
}

/** The context argument the service was handed on its first call. */
async function contextFor(
  input: Record<string, unknown>,
  ctx: Partial<SessionSearchToolContext> = {},
): Promise<Record<string, unknown>> {
  const { services, search } = buildService();
  await tool(services, ctx).handler(input);
  const args = search.mock.calls[0];
  if (!args) throw new Error("the service was never called");
  return args[1] as Record<string, unknown>;
}

// ── Shape ────────────────────────────────────────────────────────────────

describe("createSessionSearchTool", () => {
  it("is named session_search and leaves every property optional", () => {
    const t = tool();
    expect(t.name).toBe("session_search");
    // No `required` — the browse shape is a bare call with no args.
    expect((t.schema as Record<string, unknown>).required).toBeUndefined();
    const props = (t.schema as { properties: Record<string, unknown> })
      .properties;
    expect(Object.keys(props).sort()).toEqual([
      "around_message_id",
      "filters",
      "limit",
      "query",
      "session_id",
      "sort",
      "window",
    ]);
  });

  it("documents all four calling shapes in the agent-facing description", () => {
    // The description is the contract for this tool — it carries more
    // weight than the schema, so the shape list must not silently drop out.
    const d = tool().description;
    for (const shape of ["DISCOVERY", "SCROLL", "READ", "BROWSE"]) {
      expect(d).toContain(shape);
    }
  });
});

// ── Caller context ───────────────────────────────────────────────────────

describe("caller context", () => {
  it("forwards agent id, tier and current session to the service", async () => {
    // currentSessionId is what excludes the live conversation from its own
    // results; dropping it would make agents re-discover in-context turns.
    expect(await contextFor({})).toEqual({
      callerAgentId: "agent_a",
      hierarchyLevel: "team",
      currentSessionId: "sess_current",
    });
  });

  it("passes the ic tier through unchanged", async () => {
    const ctx = await contextFor({}, { hierarchyLevel: "ic" });
    expect(ctx.hierarchyLevel).toBe("ic");
  });
});

// ── Shape inference ──────────────────────────────────────────────────────

describe("inferRequest: browse", () => {
  it("treats a bare call as browse", async () => {
    expect(await requestFor({})).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("carries a numeric limit and filters", async () => {
    expect(
      await requestFor({ limit: 7, filters: { status: "failed" } }),
    ).toEqual({
      kind: "browse",
      limit: 7,
      filters: { status: "failed" },
    });
  });

  it("ignores a non-numeric limit", async () => {
    // Clamping is the service's job; the tool only refuses to forward a
    // value of the wrong type.
    expect((await requestFor({ limit: "7" })).limit).toBeUndefined();
  });

  it("browses when query and session_id are present but blank", async () => {
    expect((await requestFor({ query: "   ", session_id: "  " })).kind).toBe(
      "browse",
    );
  });
});

describe("inferRequest: discover", () => {
  it("picks discover for a bare query, trimmed", async () => {
    expect(await requestFor({ query: "  auth refactor  " })).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: undefined,
      sort: undefined,
      filters: undefined,
    });
  });

  it.each([["newest"], ["oldest"]])("accepts sort=%s", async (sort) => {
    expect((await requestFor({ query: "x", sort })).sort).toBe(sort);
  });

  it("drops an unrecognized sort instead of forwarding it", async () => {
    expect((await requestFor({ query: "x", sort: "relevance" })).sort).toBeUndefined();
  });

  it("carries limit and filters through", async () => {
    const req = await requestFor({
      query: "docker",
      limit: 10,
      filters: { session_type: "task", agent_id: "agent_b" },
    });
    expect(req).toMatchObject({
      kind: "discover",
      limit: 10,
      filters: { session_type: "task", agent_id: "agent_b" },
    });
  });

  it("ignores a non-string query and falls through to browse", async () => {
    expect((await requestFor({ query: 42 })).kind).toBe("browse");
  });
});

describe("inferRequest: read", () => {
  it("picks read for a bare session_id, trimmed", async () => {
    expect(await requestFor({ session_id: "  sess_7  " })).toEqual({
      kind: "read",
      session_id: "sess_7",
    });
  });

  it("read wins over discover when both session_id and query are given", async () => {
    // Precedence is deliberate: an explicit session id is a narrower
    // intent than a keyword, so it takes the wheel.
    const req = await requestFor({ session_id: "sess_7", query: "auth" });
    expect(req).toEqual({ kind: "read", session_id: "sess_7" });
  });

  it("drops window and limit, which read does not accept", async () => {
    expect(await requestFor({ session_id: "sess_7", window: 10, limit: 3 })).toEqual({
      kind: "read",
      session_id: "sess_7",
    });
  });
});

describe("inferRequest: scroll", () => {
  it("picks scroll when session_id and around_message_id are both set", async () => {
    expect(
      await requestFor({
        session_id: " sess_7 ",
        around_message_id: " evt_3 ",
        window: 10,
      }),
    ).toEqual({
      kind: "scroll",
      session_id: "sess_7",
      around_message_id: "evt_3",
      window: 10,
    });
  });

  it("leaves window undefined so the service applies its default", async () => {
    expect(
      (await requestFor({ session_id: "sess_7", around_message_id: "evt_3" })).window,
    ).toBeUndefined();
  });

  it("ignores a non-numeric window", async () => {
    const req = await requestFor({
      session_id: "sess_7",
      around_message_id: "evt_3",
      window: "10",
    });
    expect(req.window).toBeUndefined();
  });

  it("scroll outranks discover when a query is also present", async () => {
    const req = await requestFor({
      session_id: "sess_7",
      around_message_id: "evt_3",
      query: "auth",
    });
    expect(req.kind).toBe("scroll");
  });

  it("degrades to read when the anchor is blank", async () => {
    const req = await requestFor({
      session_id: "sess_7",
      around_message_id: "   ",
    });
    expect(req).toEqual({ kind: "read", session_id: "sess_7" });
  });

  it("accepts the synthetic user-turn anchor format", async () => {
    const req = await requestFor({
      session_id: "sess_7",
      around_message_id: "intent:sess_7",
    });
    expect(req).toMatchObject({
      kind: "scroll",
      around_message_id: "intent:sess_7",
    });
  });
});

describe("inferRequest: filters coercion", () => {
  it.each([
    ["a string", "status:failed"],
    ["a number", 3],
    ["null", null],
  ])("drops filters given as %s", async (_label, filters) => {
    expect((await requestFor({ filters })).filters).toBeUndefined();
  });

  it("forwards an array as-is — validation belongs to the service", async () => {
    // typeof [] === "object", so this reaches the service. Asserting it
    // documents the boundary rather than claiming the tool validates.
    expect((await requestFor({ filters: [] })).filters).toEqual([]);
  });
});

// ── Result + error envelopes ─────────────────────────────────────────────

describe("session_search result handling", () => {
  it("returns the service result verbatim", async () => {
    const payload = { kind: "read", messages: [{ id: "evt_1" }] };
    const { services } = buildService(
      vi.fn(async () => payload) as unknown as SessionSearchService["search"],
    );
    const res = await tool(services).handler({ session_id: "sess_7" });
    expect(res).toEqual({ content: payload });
    expect(res.isError).toBeUndefined();
  });

  it("maps a null result to not_found_or_forbidden", async () => {
    // null is the service's single answer for "out of scope", "no such
    // anchor" and "that's your own live conversation" — the tool must not
    // claim to distinguish them.
    const { services } = buildService(
      vi.fn(async () => null) as unknown as SessionSearchService["search"],
    );
    const res = await tool(services).handler({ session_id: "sess_other" });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("not_found_or_forbidden");
    expect(res.content.message).toContain("not in your scope");
  });

  it.each([
    ["missing_query"],
    ["missing_args"],
    ["forbidden_agent_filter"],
  ] as const)("preserves the %s error code", async (code) => {
    const { services } = buildService(
      vi.fn(async () => {
        throw new SessionSearchError(code, `nope: ${code}`);
      }) as unknown as SessionSearchService["search"],
    );
    const res = await tool(services).handler({ query: "x" });
    expect(res).toEqual({
      content: { error: code, message: `nope: ${code}` },
      isError: true,
    });
  });

  it("recognizes a SessionSearchError by name across a bundle boundary", async () => {
    // A src/-vs-dist/ split means two distinct classes; the handler falls
    // back to `err.name` so the structured code still survives.
    const foreign = Object.assign(new Error("out of scope"), {
      name: "SessionSearchError",
      code: "forbidden_agent_filter",
    });
    const { services } = buildService(
      vi.fn(async () => {
        throw foreign;
      }) as unknown as SessionSearchService["search"],
    );
    const res = await tool(services).handler({ query: "x" });
    expect(res.content).toEqual({
      error: "forbidden_agent_filter",
      message: "out of scope",
    });
  });

  it("wraps an unrelated Error as internal_error", async () => {
    const { services } = buildService(
      vi.fn(async () => {
        throw new Error("connection terminated");
      }) as unknown as SessionSearchService["search"],
    );
    const res = await tool(services).handler({ query: "x" });
    expect(res).toEqual({
      content: { error: "internal_error", message: "connection terminated" },
      isError: true,
    });
  });

  it("stringifies a non-Error throw", async () => {
    const { services } = buildService(
      vi.fn(async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "kaboom";
      }) as unknown as SessionSearchService["search"],
    );
    const res = await tool(services).handler({ query: "x" });
    expect(res.content).toEqual({ error: "internal_error", message: "kaboom" });
  });
});
