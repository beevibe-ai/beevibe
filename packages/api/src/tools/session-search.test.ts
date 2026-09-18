/**
 * session_search handler tests.
 *
 * The tool is shape inference plus an error envelope: raw MCP input maps
 * to one of four SessionSearchRequest kinds, the caller triple is threaded
 * through from ctx, and SessionSearchError is projected onto its code. A
 * fake SessionSearchService captures the request it was handed, keeping
 * this off Postgres FTS — the repo/service behavior has its own
 * DB-backed suites in core.
 */
import { describe, expect, it, vi } from "vitest";
import type { SessionSearchRequest, SessionSearchResult } from "@beevibe/core";
import {
  SessionSearchError,
  type SessionSearchService,
} from "@beevibe/core/services/session-search";
import {
  createSessionSearchTool,
  type SessionSearchToolContext,
} from "./session-search.js";

const ctx: SessionSearchToolContext = {
  agentId: "agent_a",
  hierarchyLevel: "team",
  sessionId: "ses_current",
};

const OK = { kind: "browse", sessions: [] } as unknown as SessionSearchResult;

function harness(
  search: ReturnType<typeof vi.fn> = vi.fn(async () => OK),
  c: SessionSearchToolContext = ctx,
) {
  const sessionSearch = { search } as unknown as SessionSearchService;
  return { tool: createSessionSearchTool(c, { sessionSearch }), search };
}

/** The request the fake service was handed on the first (or only) call. */
function requestFrom(search: ReturnType<typeof vi.fn>): SessionSearchRequest {
  return search.mock.calls[0]?.[0] as SessionSearchRequest;
}

describe("session_search shape inference", () => {
  it("infers discover from a query", async () => {
    const { tool, search } = harness();

    await tool.handler({ query: "  auth refactor  ", limit: 7, sort: "newest" });

    expect(requestFrom(search)).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: 7,
      sort: "newest",
      filters: undefined,
    });
  });

  it("infers read from a bare session_id", async () => {
    const { tool, search } = harness();

    await tool.handler({ session_id: "  ses_7  " });

    expect(requestFrom(search)).toEqual({ kind: "read", session_id: "ses_7" });
  });

  it("infers scroll when session_id and around_message_id are both present", async () => {
    const { tool, search } = harness();

    await tool.handler({
      session_id: "ses_7",
      around_message_id: "  evt_3  ",
      window: 12,
    });

    expect(requestFrom(search)).toEqual({
      kind: "scroll",
      session_id: "ses_7",
      around_message_id: "evt_3",
      window: 12,
    });
  });

  it("infers browse from no arguments at all", async () => {
    const { tool, search } = harness();

    await tool.handler({});

    expect(requestFrom(search)).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("carries a numeric limit into the browse shape", async () => {
    const { tool, search } = harness();

    await tool.handler({ limit: 9 });

    expect(requestFrom(search)).toEqual({
      kind: "browse",
      limit: 9,
      filters: undefined,
    });
  });

  it("lets scroll win over discover when a query is also present", async () => {
    // The description promises `query` is ignored once session_id +
    // around_message_id are set; an agent replaying a hit often passes
    // all three back.
    const { tool, search } = harness();

    await tool.handler({
      query: "auth refactor",
      session_id: "ses_7",
      around_message_id: "evt_3",
    });

    expect(requestFrom(search).kind).toBe("scroll");
  });

  it("lets read win over discover when a bare session_id is present", async () => {
    const { tool, search } = harness();

    await tool.handler({ query: "auth refactor", session_id: "ses_7" });

    expect(requestFrom(search).kind).toBe("read");
  });

  it("falls back to browse when every string argument is blank", async () => {
    const { tool, search } = harness();

    await tool.handler({ query: "   ", session_id: "  ", around_message_id: "  " });

    expect(requestFrom(search).kind).toBe("browse");
  });

  it("falls back to browse when the arguments are the wrong types", async () => {
    const { tool, search } = harness();

    await tool.handler({ query: 42, session_id: null, around_message_id: [] });

    expect(requestFrom(search).kind).toBe("browse");
  });

  it("drops a non-numeric limit, sort, and window rather than forwarding them", async () => {
    const { tool, search } = harness();

    await tool.handler({ query: "x", limit: "3", sort: "sideways" });
    await tool.handler({ session_id: "ses_7", around_message_id: "evt_1", window: "12" });

    expect(search.mock.calls[0]?.[0]).toMatchObject({
      limit: undefined,
      sort: undefined,
    });
    expect(search.mock.calls[1]?.[0]).toMatchObject({ window: undefined });
  });

  it("forwards filters on discover and browse", async () => {
    const { tool, search } = harness();
    const filters = { session_type: "task", status: "failed", agent_id: "agent_b" };

    await tool.handler({ query: "deploy", filters });
    await tool.handler({ filters });

    expect(search.mock.calls[0]?.[0]).toMatchObject({ kind: "discover", filters });
    expect(search.mock.calls[1]?.[0]).toMatchObject({ kind: "browse", filters });
  });

  it("treats a non-object filters value as absent", async () => {
    const { tool, search } = harness();

    await tool.handler({ query: "deploy", filters: "status:failed" });

    expect(requestFrom(search)).toMatchObject({ filters: undefined });
  });
});

describe("session_search caller context", () => {
  it("threads agentId, tier, and the active session into every call", async () => {
    const { tool, search } = harness();

    await tool.handler({ query: "anything" });

    expect(search.mock.calls[0]?.[1]).toEqual({
      callerAgentId: "agent_a",
      hierarchyLevel: "team",
      currentSessionId: "ses_current",
    });
  });

  it("passes the caller's own tier through, not a fixed one", async () => {
    const { tool, search } = harness(undefined, { ...ctx, hierarchyLevel: "ic" });

    await tool.handler({});

    expect(search.mock.calls[0]?.[1]).toMatchObject({ hierarchyLevel: "ic" });
  });
});

describe("session_search results and errors", () => {
  it("returns the service result verbatim on success", async () => {
    const result = { kind: "read", messages: [{ id: "evt_1" }] };
    const { tool } = harness(vi.fn(async () => result as unknown as SessionSearchResult));

    const out = await tool.handler({ session_id: "ses_7" });

    expect(out.isError).toBeFalsy();
    expect(out.content).toBe(result);
  });

  it("maps a null result to not_found_or_forbidden", async () => {
    const { tool } = harness(vi.fn(async () => null));

    const out = await tool.handler({ session_id: "ses_missing" });

    expect(out.isError).toBe(true);
    expect(out.content).toMatchObject({ error: "not_found_or_forbidden" });
    expect(out.content.message).toContain("scope");
  });

  it.each(["forbidden_agent_filter", "missing_query", "missing_args"] as const)(
    "surfaces the %s code from a SessionSearchError",
    async (code) => {
      const { tool } = harness(
        vi.fn(async () => {
          throw new SessionSearchError(code, `nope: ${code}`);
        }),
      );

      const out = await tool.handler({ query: "x" });

      expect(out.isError).toBe(true);
      expect(out.content).toEqual({ error: code, message: `nope: ${code}` });
    },
  );

  it("matches a SessionSearchError by name too, for cross-bundle src/dist imports", async () => {
    // An integration script consuming core's src/ raises a *different*
    // class object than the api's dist/ import, so `instanceof` misses.
    // The name check is what keeps the structured code from degrading to
    // internal_error on that path.
    const impostor = Object.assign(new Error("out of scope"), {
      name: "SessionSearchError",
      code: "forbidden_agent_filter",
    });
    const { tool } = harness(
      vi.fn(async () => {
        throw impostor;
      }),
    );

    const out = await tool.handler({ query: "x" });

    expect(out.content).toEqual({
      error: "forbidden_agent_filter",
      message: "out of scope",
    });
  });

  it("degrades an unrelated Error to internal_error with its message", async () => {
    const { tool } = harness(
      vi.fn(async () => {
        throw new Error("connection terminated");
      }),
    );

    const out = await tool.handler({ query: "x" });

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({
      error: "internal_error",
      message: "connection terminated",
    });
  });

  it("stringifies a non-Error throw", async () => {
    const { tool } = harness(
      vi.fn(async () => {
        throw "raw blowup";
      }),
    );

    const out = await tool.handler({ query: "x" });

    expect(out.content).toEqual({ error: "internal_error", message: "raw blowup" });
  });
});

describe("session_search tool surface", () => {
  it("has no required arguments — the bare call is the browse shape", () => {
    const { tool } = harness();

    expect(tool.name).toBe("session_search");
    expect(tool.schema.required).toBeUndefined();
  });

  it("advertises the sort and filter enums the description promises", () => {
    const { tool } = harness();
    const props = tool.schema.properties as Record<string, Record<string, unknown>>;
    const filterProps = props.filters?.properties as Record<
      string,
      Record<string, unknown>
    >;

    expect(props.sort?.enum).toEqual(["newest", "oldest"]);
    expect(filterProps.session_type?.enum).toContain("task");
    expect(filterProps.status?.enum).toContain("failed");
  });
});
