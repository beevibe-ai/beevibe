/**
 * session_search handler tests.
 *
 * The retrieval itself is SessionSearchService's (and its repo's) job,
 * covered against live Postgres in core. What lives here is the shape
 * inference — four calling shapes collapsed out of one flat argument
 * bag — plus the caller scope that gets attached and the error
 * projection. A fake service records what the handler inferred.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionSearchError } from "@beevibe/core/services/session-search";
import {
  createSessionSearchTool,
  type SessionSearchToolContext,
} from "./session-search.js";
import type { AgentTool } from "./types.js";

const ctx: SessionSearchToolContext = {
  agentId: "agent_a",
  hierarchyLevel: "team",
  sessionId: "sess_current",
};

function harness(context: SessionSearchToolContext = ctx): {
  tool: AgentTool;
  search: ReturnType<typeof vi.fn>;
} {
  const search = vi.fn(async () => ({ results: [] }));
  const tool = createSessionSearchTool(context, {
    sessionSearch: { search } as never,
  });
  return { tool, search };
}

/** The request object the handler inferred from the raw tool input. */
async function inferred(
  input: Record<string, unknown>,
  context?: SessionSearchToolContext,
) {
  const { tool, search } = harness(context);
  await tool.handler(input);
  return search.mock.calls[0]![0];
}

describe("session_search tool definition", () => {
  it("has no required arguments — the bare call is the browse shape", () => {
    const { tool } = harness();
    expect(tool.name).toBe("session_search");
    expect(tool.schema.required).toBeUndefined();
  });

  it("enumerates the sort options", () => {
    const { tool } = harness();
    const props = tool.schema.properties as Record<string, Record<string, unknown>>;
    expect(props.sort!.enum).toEqual(["newest", "oldest"]);
  });
});

describe("shape inference", () => {
  it("infers browse from an empty call", async () => {
    expect(await inferred({})).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("infers discover from a query", async () => {
    expect(
      await inferred({ query: "auth refactor", limit: 5, sort: "newest" }),
    ).toEqual({
      kind: "discover",
      query: "auth refactor",
      limit: 5,
      sort: "newest",
      filters: undefined,
    });
  });

  it("infers read from a bare session_id", async () => {
    expect(await inferred({ session_id: "sess_1" })).toEqual({
      kind: "read",
      session_id: "sess_1",
    });
  });

  it("infers scroll when session_id and around_message_id are both set", async () => {
    expect(
      await inferred({
        session_id: "sess_1",
        around_message_id: "evt_9",
        window: 10,
      }),
    ).toEqual({
      kind: "scroll",
      session_id: "sess_1",
      around_message_id: "evt_9",
      window: 10,
    });
  });

  it("lets scroll win over a query passed alongside it", async () => {
    const req = await inferred({
      query: "ignored",
      session_id: "sess_1",
      around_message_id: "evt_9",
    });
    expect(req.kind).toBe("scroll");
  });

  it("lets read win over a query passed alongside it", async () => {
    const req = await inferred({ query: "ignored", session_id: "sess_1" });
    expect(req.kind).toBe("read");
  });

  it("falls back to discover when the anchor is present but session_id is not", async () => {
    const req = await inferred({ query: "q", around_message_id: "evt_9" });
    expect(req.kind).toBe("discover");
  });

  it("accepts the synthetic user-turn anchor id format", async () => {
    const req = await inferred({
      session_id: "sess_1",
      around_message_id: "intent:sess_1",
    });
    expect(req).toMatchObject({
      kind: "scroll",
      around_message_id: "intent:sess_1",
    });
  });

  it("trims session_id, anchor and query", async () => {
    expect(
      await inferred({ session_id: "  sess_1  ", around_message_id: "  evt_9  " }),
    ).toMatchObject({ session_id: "sess_1", around_message_id: "evt_9" });
    expect(await inferred({ query: "  spaced  " })).toMatchObject({
      query: "spaced",
    });
  });

  it.each([
    ["blank", "   "],
    ["non-string", 7],
  ])("treats a %s session_id as absent", async (_label, sessionIdValue) => {
    const req = await inferred({ session_id: sessionIdValue, query: "q" });
    expect(req.kind).toBe("discover");
  });

  it.each([
    ["blank", "   "],
    ["non-string", 7],
  ])("treats a %s query as absent, falling through to browse", async (_l, query) => {
    const req = await inferred({ query });
    expect(req.kind).toBe("browse");
  });

  it("drops a non-numeric limit, window and an unknown sort", async () => {
    expect(await inferred({ query: "q", limit: "5", sort: "random" })).toMatchObject(
      { limit: undefined, sort: undefined },
    );
    expect(
      await inferred({
        session_id: "sess_1",
        around_message_id: "evt_9",
        window: "10",
      }),
    ).toMatchObject({ window: undefined });
  });

  it("forwards a filters object on discover and browse", async () => {
    const filters = { status: "failed", session_type: "task" };
    expect(await inferred({ query: "q", filters })).toMatchObject({ filters });
    expect(await inferred({ filters })).toMatchObject({ kind: "browse", filters });
  });

  it("drops filters that are not an object", async () => {
    expect(await inferred({ query: "q", filters: "failed" })).toMatchObject({
      filters: undefined,
    });
    expect(await inferred({ query: "q", filters: null })).toMatchObject({
      filters: undefined,
    });
  });
});

describe("caller scope", () => {
  it("attaches the caller's agent id, tier and active session", async () => {
    const { tool, search } = harness();
    await tool.handler({ query: "q" });
    expect(search.mock.calls[0]![1]).toEqual({
      callerAgentId: "agent_a",
      hierarchyLevel: "team",
      currentSessionId: "sess_current",
    });
  });

  it("passes an ic caller's tier through unchanged", async () => {
    const { tool, search } = harness({ ...ctx, hierarchyLevel: "ic" });
    await tool.handler({});
    expect(search.mock.calls[0]![1].hierarchyLevel).toBe("ic");
  });
});

describe("result projection", () => {
  it("returns the service result as the tool content", async () => {
    const { tool, search } = harness();
    const result = { results: [{ session: { id: "sess_1" } }] };
    search.mockResolvedValue(result);
    const res = await tool.handler({ query: "q" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toBe(result);
  });

  it("maps a null result to not_found_or_forbidden", async () => {
    const { tool, search } = harness();
    search.mockResolvedValue(null);
    const res = await tool.handler({ session_id: "sess_other" });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("not_found_or_forbidden");
    expect(res.content.message).toMatch(/not in your scope/);
  });
});

describe("error projection", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it.each(["forbidden_agent_filter", "missing_query", "missing_args"] as const)(
    "surfaces a SessionSearchError's %s code",
    async (code) => {
      h.search.mockRejectedValue(new SessionSearchError(code, `bad: ${code}`));
      const res = await h.tool.handler({ query: "q" });
      expect(res.isError).toBe(true);
      expect(res.content).toEqual({ error: code, message: `bad: ${code}` });
    },
  );

  it("matches a cross-bundle SessionSearchError by name", async () => {
    // An integration script consuming src/ while the api consumes dist/
    // produces an error that fails instanceof but keeps the name.
    const err = Object.assign(new Error("out of scope"), {
      name: "SessionSearchError",
      code: "forbidden_agent_filter",
    });
    h.search.mockRejectedValue(err);
    const res = await h.tool.handler({ query: "q" });
    expect(res.content).toEqual({
      error: "forbidden_agent_filter",
      message: "out of scope",
    });
  });

  it("falls back to internal_error for anything else", async () => {
    h.search.mockRejectedValue(new Error("pool exhausted"));
    const res = await h.tool.handler({ query: "q" });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "internal_error",
      message: "pool exhausted",
    });
  });

  it("stringifies a non-Error throw under internal_error", async () => {
    h.search.mockRejectedValue("boom");
    const res = await h.tool.handler({ query: "q" });
    expect(res.content).toEqual({ error: "internal_error", message: "boom" });
  });
});
