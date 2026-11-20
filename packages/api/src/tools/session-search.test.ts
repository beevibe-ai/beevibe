/**
 * session_search handler tests.
 *
 * All the logic the tool owns is in `inferRequest` — the mapping from
 * loose MCP tool input to one of four typed request shapes (discover /
 * scroll / read / browse). The precedence rules are implicit in the
 * if-chain and invisible at the call site: `session_id` + an anchor wins
 * over `query`, a bare `session_id` beats `query`, and an input with
 * nothing usable degrades to browse rather than erroring. An agent that
 * passes both a query and a session_id gets a different shape than it
 * probably expected, so these are worth pinning.
 *
 * The rest is the error envelope: a `null` service result (out of scope
 * / bad anchor) becomes `not_found_or_forbidden`, a SessionSearchError
 * keeps its structured `code`, and anything else degrades to
 * `internal_error`. The by-name branch exists because an integration
 * script consuming `src/` and the api consuming `dist/` end up with two
 * distinct SessionSearchError classes — `instanceof` fails across that
 * boundary, so the duck-typed check is load-bearing and tested here.
 */
import { describe, expect, it, vi } from "vitest";
import type { SessionSearchRequest } from "@beevibe/core";
import {
  SessionSearchError,
  type SessionSearchContext,
  type SessionSearchService,
} from "@beevibe/core/services/session-search";
import {
  createSessionSearchTool,
  type SessionSearchToolContext,
} from "./session-search.js";

const CTX: SessionSearchToolContext = {
  agentId: "agent_team",
  hierarchyLevel: "team",
  sessionId: "ses_active",
};

function harness(
  impl?: (req: SessionSearchRequest) => unknown,
  ctx: Partial<SessionSearchToolContext> = {},
) {
  // `_ctx` is declared so the caller-scope argument stays typed on
  // `mock.calls[0][1]`; the fake itself only reads the request.
  const search = vi.fn(
    async (req: SessionSearchRequest, _ctx: SessionSearchContext) =>
      impl ? impl(req) : { kind: req.kind, results: [] },
  );
  const sessionSearch = { search } as unknown as SessionSearchService;
  const t = createSessionSearchTool({ ...CTX, ...ctx }, { sessionSearch });
  return { tool: t, search };
}

/** The request object the handler built, for shape-inference assertions. */
async function requestFor(input: Record<string, unknown>) {
  const { tool, search } = harness();
  await tool.handler(input);
  return search.mock.calls[0]?.[0] as SessionSearchRequest;
}

describe("session_search tool descriptor", () => {
  it("is named session_search and declares no required inputs", () => {
    const { tool } = harness();
    expect(tool.name).toBe("session_search");
    // Browse is the zero-arg shape, so nothing is required.
    expect(tool.schema.required).toBeUndefined();
  });

  it("documents the four calling shapes in the agent-facing description", () => {
    const { tool } = harness();
    for (const shape of ["DISCOVERY", "SCROLL", "READ", "BROWSE"]) {
      expect(tool.description).toContain(shape);
    }
  });

  it("generates the filter enums from the domain constants", () => {
    const { tool } = harness();
    const filters = (
      tool.schema.properties as {
        filters: { properties: Record<string, { enum?: string[] }> };
      }
    ).filters;
    // Guards against a domain-level session type or status being added
    // without reaching the agent-visible surface.
    expect(filters.properties.session_type?.enum).toContain("run_repo");
    expect(filters.properties.status?.enum).toContain("failed");
  });
});

describe("session_search caller scope", () => {
  it("passes the caller's identity, tier and active session to the service", async () => {
    const { tool, search } = harness();
    await tool.handler({ query: "auth refactor" });

    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]?.[1]).toEqual({
      callerAgentId: "agent_team",
      hierarchyLevel: "team",
      // The active conversation is excluded server-side so the agent
      // never re-discovers messages already in its context.
      currentSessionId: "ses_active",
    });
  });

  it("forwards an ic tier unchanged", async () => {
    const { tool, search } = harness(undefined, { hierarchyLevel: "ic" });
    await tool.handler({});
    expect(search.mock.calls[0]?.[1]).toMatchObject({ hierarchyLevel: "ic" });
  });
});

describe("session_search shape inference", () => {
  it("infers browse from no arguments", async () => {
    expect(await requestFor({})).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("infers discover from a query", async () => {
    expect(await requestFor({ query: "auth refactor" })).toMatchObject({
      kind: "discover",
      query: "auth refactor",
    });
  });

  it("infers read from a bare session_id", async () => {
    expect(await requestFor({ session_id: "ses_1" })).toEqual({
      kind: "read",
      session_id: "ses_1",
    });
  });

  it("infers scroll from session_id + around_message_id", async () => {
    expect(
      await requestFor({
        session_id: "ses_1",
        around_message_id: "evt_9",
        window: 10,
      }),
    ).toEqual({
      kind: "scroll",
      session_id: "ses_1",
      around_message_id: "evt_9",
      window: 10,
    });
  });

  it("prefers scroll over discover when a query is also present", async () => {
    // Documented in the tool description: "Ignored when session_id +
    // around_message_id are set."
    expect(
      await requestFor({
        query: "ignored",
        session_id: "ses_1",
        around_message_id: "evt_9",
      }),
    ).toMatchObject({ kind: "scroll" });
  });

  it("prefers read over discover when a bare session_id is present", async () => {
    expect(
      await requestFor({ query: "ignored", session_id: "ses_1" }),
    ).toMatchObject({ kind: "read", session_id: "ses_1" });
  });

  it("falls back to read when the anchor is blank", async () => {
    expect(
      await requestFor({ session_id: "ses_1", around_message_id: "   " }),
    ).toEqual({ kind: "read", session_id: "ses_1" });
  });

  it("falls back to discover when session_id is blank", async () => {
    expect(
      await requestFor({ session_id: "  ", query: "auth" }),
    ).toMatchObject({ kind: "discover", query: "auth" });
  });

  it("falls back to browse when the query is blank", async () => {
    expect(await requestFor({ query: "   " })).toMatchObject({
      kind: "browse",
    });
  });

  it("ignores a non-string session_id, anchor and query", async () => {
    expect(
      await requestFor({ session_id: 1, around_message_id: 2, query: 3 }),
    ).toMatchObject({ kind: "browse" });
  });

  it("trims session_id, anchor and query", async () => {
    expect(
      await requestFor({
        session_id: "  ses_1  ",
        around_message_id: "  evt_9  ",
      }),
    ).toMatchObject({ session_id: "ses_1", around_message_id: "evt_9" });
    expect(await requestFor({ query: "  auth  " })).toMatchObject({
      query: "auth",
    });
  });

  it("accepts a synthetic user-turn anchor id", async () => {
    // User turns have no event row; their anchor is `intent:<session_id>`.
    expect(
      await requestFor({
        session_id: "ses_1",
        around_message_id: "intent:ses_1",
      }),
    ).toMatchObject({ kind: "scroll", around_message_id: "intent:ses_1" });
  });
});

describe("session_search optional parameter passthrough", () => {
  it("passes a numeric limit and sort through on discover", async () => {
    expect(
      await requestFor({ query: "auth", limit: 7, sort: "newest" }),
    ).toMatchObject({ limit: 7, sort: "newest" });
  });

  it("passes a numeric limit through on browse", async () => {
    expect(await requestFor({ limit: 5 })).toMatchObject({
      kind: "browse",
      limit: 5,
    });
  });

  it("drops a non-numeric limit so the service default applies", async () => {
    // Clamping lives in the service; the tool only refuses to forward a
    // value of the wrong type.
    expect(await requestFor({ query: "auth", limit: "7" })).toMatchObject({
      limit: undefined,
    });
  });

  it("drops a non-numeric window so the service default applies", async () => {
    expect(
      await requestFor({
        session_id: "ses_1",
        around_message_id: "evt_9",
        window: "10",
      }),
    ).toMatchObject({ window: undefined });
  });

  it.each([
    ["an unknown sort value", "relevance"],
    ["a non-string sort", 1],
  ])("drops %s", async (_label, sort) => {
    expect(await requestFor({ query: "auth", sort })).toMatchObject({
      sort: undefined,
    });
  });

  it("forwards sort: oldest", async () => {
    expect(await requestFor({ query: "auth", sort: "oldest" })).toMatchObject({
      sort: "oldest",
    });
  });

  it("forwards a filters object verbatim on discover", async () => {
    const filters = { status: "failed", session_type: "task" };
    expect(await requestFor({ query: "auth", filters })).toMatchObject({
      filters,
    });
  });

  it("forwards a filters object verbatim on browse", async () => {
    const filters = { agent_id: "agent_sub" };
    expect(await requestFor({ filters })).toMatchObject({ filters });
  });

  it.each([
    ["null", null],
    ["a non-object", "status:failed"],
  ])("drops filters that are %s", async (_label, filters) => {
    expect(await requestFor({ query: "auth", filters })).toMatchObject({
      filters: undefined,
    });
  });
});

describe("session_search result and error envelopes", () => {
  it("returns the service result as the tool content", async () => {
    const payload = { kind: "read", session: { id: "ses_1" }, messages: [] };
    const { tool } = harness(() => payload);

    const result = await tool.handler({ session_id: "ses_1" });

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe(payload);
  });

  it("maps a null result to not_found_or_forbidden", async () => {
    // One code covers three causes: out of tier scope, nonexistent
    // anchor, or an anchor inside the caller's own active conversation.
    const { tool } = harness(() => null);

    const result = await tool.handler({ session_id: "ses_other" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "not_found_or_forbidden" });
    expect(String((result.content as { message: string }).message)).toContain(
      "not in your scope",
    );
  });

  it.each(["forbidden_agent_filter", "missing_query", "missing_args"] as const)(
    "preserves the %s code from a thrown SessionSearchError",
    async (code) => {
      const { tool } = harness(() => {
        throw new SessionSearchError(code, `nope: ${code}`);
      });

      const result = await tool.handler({ query: "auth" });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual({ error: code, message: `nope: ${code}` });
    },
  );

  it("recognizes a SessionSearchError from a different module instance by name", async () => {
    // Simulates the src/-vs-dist/ duplicate-class case: same name and
    // shape, fails `instanceof`. The duck-typed branch has to catch it,
    // or the agent sees `internal_error` instead of the real code.
    class ForeignSessionSearchError extends Error {
      code = "forbidden_agent_filter";
      constructor(message: string) {
        super(message);
        this.name = "SessionSearchError";
      }
    }
    const { tool } = harness(() => {
      throw new ForeignSessionSearchError("cross-bundle");
    });

    const result = await tool.handler({ query: "auth" });

    expect(result.content).toEqual({
      error: "forbidden_agent_filter",
      message: "cross-bundle",
    });
  });

  it("degrades an unrelated Error to internal_error", async () => {
    const { tool } = harness(() => {
      throw new Error("connection terminated unexpectedly");
    });

    const result = await tool.handler({ query: "auth" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "internal_error",
      message: "connection terminated unexpectedly",
    });
  });

  it("stringifies a non-Error throw", async () => {
    const { tool } = harness(() => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "pg gone";
    });

    const result = await tool.handler({ query: "auth" });

    expect(result.content).toEqual({
      error: "internal_error",
      message: "pg gone",
    });
  });
});
