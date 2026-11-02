/**
 * session_search tool tests.
 *
 * The service does the scoping, the FTS and the repo dispatch. What this
 * module owns — and what these tests cover — is `inferRequest`: turning a
 * loose MCP input bag into one of four typed request shapes. The
 * precedence rules there are easy to break and invisible when broken
 * (a scroll silently degrading into a read returns plausible-looking
 * data), so each branch and each tie-break gets a case.
 *
 * Also covered: the null -> not_found_or_forbidden envelope and the
 * structured-error mapping, including the by-name fallback that exists
 * for src/-vs-dist/ cross-bundle callers.
 *
 * The service is faked; no Postgres required.
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
  sessionId: "ses_current",
};

function harness(opts: { result?: unknown; throws?: unknown } = {}) {
  // Params are declared so `search.mock.calls[n]` is a real 2-tuple —
  // these tests assert on both the request and the caller context.
  const search = vi.fn(
    async (
      _req: SessionSearchRequest,
      _ctx: {
        callerAgentId: string;
        hierarchyLevel: string;
        currentSessionId: string;
      },
    ): Promise<unknown> => {
      if (opts.throws !== undefined) throw opts.throws;
      return "result" in opts ? opts.result : { kind: "browse", sessions: [] };
    },
  );
  const sessionSearch = { search } as unknown as SessionSearchService;
  return {
    search,
    tool: createSessionSearchTool(CTX, { sessionSearch }),
  };
}

/** The request shape the tool handed the service on its first call. */
async function requestFor(
  input: Record<string, unknown>,
): Promise<SessionSearchRequest> {
  const { tool, search } = harness();
  await tool.handler(input);
  return search.mock.calls[0]?.[0] as unknown as SessionSearchRequest;
}

describe("session_search surface", () => {
  it("is named session_search and takes no required args", () => {
    const { tool } = harness();
    expect(tool.name).toBe("session_search");
    // Browse is the no-arg shape, so nothing may be required.
    expect(tool.schema.required).toBeUndefined();
  });

  it("documents the four calling shapes in the description", () => {
    const { tool } = harness();
    // The description IS the agent-facing contract for this tool; the
    // shape names are what the prompt guidance refers to.
    for (const shape of ["DISCOVERY", "SCROLL", "READ", "BROWSE"]) {
      expect(tool.description).toContain(shape);
    }
  });

  it("constrains sort to newest/oldest", () => {
    const { tool } = harness();
    const props = tool.schema.properties as Record<string, { enum?: string[] }>;
    expect(props.sort?.enum).toEqual(["newest", "oldest"]);
  });
});

describe("shape inference: scroll", () => {
  it("picks scroll when session_id and around_message_id are both set", async () => {
    expect(
      await requestFor({ session_id: "ses_1", around_message_id: "evt_9" }),
    ).toEqual({
      kind: "scroll",
      session_id: "ses_1",
      around_message_id: "evt_9",
      window: undefined,
    });
  });

  it("forwards a numeric window and leaves clamping to the service", async () => {
    const req = await requestFor({
      session_id: "ses_1",
      around_message_id: "evt_9",
      window: 10,
    });
    expect(req).toMatchObject({ kind: "scroll", window: 10 });
  });

  it("drops a non-numeric window", async () => {
    const req = await requestFor({
      session_id: "ses_1",
      around_message_id: "evt_9",
      window: "10",
    });
    expect(req).toMatchObject({ kind: "scroll", window: undefined });
  });

  it("trims both ids", async () => {
    expect(
      await requestFor({
        session_id: "  ses_1 ",
        around_message_id: "  evt_9  ",
      }),
    ).toMatchObject({ session_id: "ses_1", around_message_id: "evt_9" });
  });

  it("accepts a synthetic user-turn anchor id", async () => {
    const req = await requestFor({
      session_id: "ses_1",
      around_message_id: "intent:ses_1",
    });
    expect(req).toMatchObject({
      kind: "scroll",
      around_message_id: "intent:ses_1",
    });
  });

  // The documented tie-break: scroll beats discover when all three are
  // present. Getting this backwards would quietly ignore the anchor.
  it("wins over query when all three args are present", async () => {
    const req = await requestFor({
      session_id: "ses_1",
      around_message_id: "evt_9",
      query: "auth refactor",
    });
    expect(req.kind).toBe("scroll");
  });
});

describe("shape inference: read", () => {
  it("picks read for a bare session_id", async () => {
    expect(await requestFor({ session_id: "ses_1" })).toEqual({
      kind: "read",
      session_id: "ses_1",
    });
  });

  it("picks read when around_message_id is blank", async () => {
    const req = await requestFor({ session_id: "ses_1", around_message_id: "   " });
    expect(req).toEqual({ kind: "read", session_id: "ses_1" });
  });

  it("picks read when around_message_id is not a string", async () => {
    const req = await requestFor({ session_id: "ses_1", around_message_id: 7 });
    expect(req.kind).toBe("read");
  });

  it("wins over query", async () => {
    const req = await requestFor({ session_id: "ses_1", query: "auth" });
    expect(req.kind).toBe("read");
  });

  it("ignores filters, which the read shape does not carry", async () => {
    const req = await requestFor({
      session_id: "ses_1",
      filters: { status: "failed" },
    });
    expect(req).toEqual({ kind: "read", session_id: "ses_1" });
  });
});

describe("shape inference: discover", () => {
  it("picks discover for a bare query", async () => {
    expect(await requestFor({ query: "auth refactor" })).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: undefined,
      sort: undefined,
      filters: undefined,
    });
  });

  it("trims the query", async () => {
    expect(await requestFor({ query: "  auth  " })).toMatchObject({
      query: "auth",
    });
  });

  it("forwards limit, sort and filters", async () => {
    const req = await requestFor({
      query: "auth",
      limit: 7,
      sort: "newest",
      filters: { status: "failed", session_type: "task" },
    });
    expect(req).toEqual({
      kind: "discover",
      query: "auth",
      limit: 7,
      sort: "newest",
      filters: { status: "failed", session_type: "task" },
    });
  });

  it("drops an unrecognized sort", async () => {
    const req = await requestFor({ query: "auth", sort: "relevance" });
    expect(req).toMatchObject({ sort: undefined });
  });

  it("drops a non-numeric limit", async () => {
    const req = await requestFor({ query: "auth", limit: "7" });
    expect(req).toMatchObject({ limit: undefined });
  });

  it("drops a null filters bag", async () => {
    // typeof null === "object", so the null guard is a real branch.
    const req = await requestFor({ query: "auth", filters: null });
    expect(req).toMatchObject({ filters: undefined });
  });

  it("drops a non-object filters bag", async () => {
    const req = await requestFor({ query: "auth", filters: "status:failed" });
    expect(req).toMatchObject({ filters: undefined });
  });
});

describe("shape inference: browse", () => {
  it("picks browse with no args at all", async () => {
    expect(await requestFor({})).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("picks browse when every arg is blank or wrongly typed", async () => {
    const req = await requestFor({
      query: "   ",
      session_id: "  ",
      around_message_id: "",
    });
    expect(req.kind).toBe("browse");
  });

  it("carries limit and filters", async () => {
    const req = await requestFor({ limit: 5, filters: { since: "2026-01-01" } });
    expect(req).toEqual({
      kind: "browse",
      limit: 5,
      filters: { since: "2026-01-01" },
    });
  });
});

describe("caller context", () => {
  it("passes the context agent, tier and current session to the service", async () => {
    const { tool, search } = harness();
    await tool.handler({ query: "auth" });
    expect(search.mock.calls[0]?.[1]).toEqual({
      callerAgentId: "agent_a",
      hierarchyLevel: "team",
      currentSessionId: "ses_current",
    });
  });

  it("ignores caller identity supplied in the input", async () => {
    const { tool, search } = harness();
    await tool.handler({
      query: "auth",
      callerAgentId: "agent_other",
      hierarchyLevel: "org",
    });
    // Tier drives scope resolution, so it must come from the resolved
    // token context only — never from arguments the agent controls.
    expect(search.mock.calls[0]?.[1]).toMatchObject({
      callerAgentId: "agent_a",
      hierarchyLevel: "team",
    });
  });
});

describe("result envelope", () => {
  it("returns the service result verbatim on success", async () => {
    const payload = { kind: "read", session: { id: "ses_1" }, messages: [] };
    const { tool } = harness({ result: payload });
    const res = await tool.handler({ session_id: "ses_1" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe(payload);
  });

  // null is the service's "out of scope, or no such anchor" signal. It
  // deliberately does not distinguish the two, so the agent can't probe
  // for the existence of sessions outside its tier.
  it("turns a null result into not_found_or_forbidden", async () => {
    const { tool } = harness({ result: null });
    const res = await tool.handler({ session_id: "ses_elsewhere" });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("not_found_or_forbidden");
    expect(String(res.content.message)).toContain("scope");
  });
});

describe("error mapping", () => {
  it("surfaces a SessionSearchError's code and message", async () => {
    const { tool } = harness({
      throws: new SessionSearchError(
        "forbidden_agent_filter",
        "agent_b is outside your scope",
      ),
    });
    const res = await tool.handler({ query: "auth", filters: { agent_id: "agent_b" } });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "forbidden_agent_filter",
      message: "agent_b is outside your scope",
    });
  });

  it("surfaces the missing_args code", async () => {
    const { tool } = harness({
      throws: new SessionSearchError("missing_args", "nothing to search"),
    });
    const res = await tool.handler({});
    expect(res.content).toMatchObject({ error: "missing_args" });
  });

  // The by-name fallback: an integration script importing core from src/
  // while the api imports dist/ produces two distinct class objects, so
  // instanceof fails. Name matching keeps the structured code.
  it("matches a structurally identical error by name across bundles", async () => {
    class ForeignSessionSearchError extends Error {
      code = "missing_query";
      constructor(message: string) {
        super(message);
        this.name = "SessionSearchError";
      }
    }
    const { tool } = harness({
      throws: new ForeignSessionSearchError("query required"),
    });
    const res = await tool.handler({ query: "auth" });
    expect(res.content).toEqual({
      error: "missing_query",
      message: "query required",
    });
  });

  it("wraps an unrelated Error as internal_error", async () => {
    const { tool } = harness({ throws: new Error("pg connection lost") });
    const res = await tool.handler({ query: "auth" });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "internal_error",
      message: "pg connection lost",
    });
  });

  it("does not name-match an error that merely has a code", async () => {
    const other = Object.assign(new Error("nope"), { code: "weird" });
    const { tool } = harness({ throws: other });
    const res = await tool.handler({ query: "auth" });
    expect(res.content).toMatchObject({ error: "internal_error" });
  });

  it("stringifies a non-Error throw", async () => {
    const { tool } = harness({ throws: "exploded" });
    const res = await tool.handler({ query: "auth" });
    expect(res.content).toEqual({ error: "internal_error", message: "exploded" });
  });
});
