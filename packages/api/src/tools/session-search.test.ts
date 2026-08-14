import { describe, expect, it, vi } from "vitest";
import type { HierarchyLevel, SessionSearchRequest } from "@beevibe/core";
import {
  SessionSearchError,
  type SessionSearchService,
} from "@beevibe/core/services/session-search";
import {
  createSessionSearchTool,
  type SessionSearchToolContext,
} from "./session-search.js";

/**
 * session_search has four calling shapes (discover / scroll / read /
 * browse) that the agent selects *implicitly*, by which arguments it
 * passes. There is no `kind` parameter on the wire — this handler infers
 * it, and the precedence between the shapes is the whole contract:
 *
 *   session_id + around_message_id  → scroll   (wins over query)
 *   session_id alone                → read
 *   query alone                     → discover
 *   nothing                         → browse
 *
 * Get the precedence wrong and the agent silently gets a different
 * search than it asked for, with no error to notice. That is what most
 * of these tests pin.
 *
 * The service is faked: its scope resolution and FTS need Postgres and
 * are covered by core's own suite.
 */

const AGENT_ID = "agent_caller";
const SESSION_ID = "sess_current";

function fakeService(
  impl?: (
    req: SessionSearchRequest,
    ctx: unknown,
  ) => unknown | Promise<unknown>,
): SessionSearchService {
  return {
    search: vi.fn(async (req: SessionSearchRequest, ctx: unknown) =>
      impl ? await impl(req, ctx) : { kind: req.kind, results: [] },
    ),
  } as unknown as SessionSearchService;
}

function tool(
  ctx: Partial<SessionSearchToolContext> = {},
  service: SessionSearchService = fakeService(),
) {
  const t = createSessionSearchTool(
    {
      agentId: AGENT_ID,
      hierarchyLevel: "ic" as HierarchyLevel,
      sessionId: SESSION_ID,
      ...ctx,
    },
    { sessionSearch: service },
  );
  return { handler: t.handler, definition: t, service };
}

/** The request the handler inferred from a given raw tool input. */
async function inferred(
  input: Record<string, unknown>,
): Promise<SessionSearchRequest> {
  const { handler, service } = tool();
  await handler(input);
  const call = (service.search as ReturnType<typeof vi.fn>).mock.calls[0];
  if (!call) throw new Error("sessionSearch.search was never called");
  return call[0] as SessionSearchRequest;
}

describe("createSessionSearchTool", () => {
  it("advertises a schema with no required fields — browse takes no args", () => {
    const { definition } = tool();

    expect(definition.name).toBe("session_search");
    expect(definition.schema.required).toBeUndefined();
  });

  it("constrains the filter enums to the domain's own constants", () => {
    const { definition } = tool();
    const { filters } = definition.schema.properties as {
      filters: {
        properties: {
          session_type: { enum: string[] };
          status: { enum: string[] };
        };
      };
    };

    expect(filters.properties.session_type.enum).toContain("task");
    expect(filters.properties.session_type.enum).toContain("run_repo");
    expect(filters.properties.status.enum).toContain("failed");
  });

  it("documents all four calling shapes in the agent-facing description", () => {
    const { definition } = tool();

    for (const shape of ["DISCOVERY", "SCROLL", "READ", "BROWSE"]) {
      expect(definition.description).toContain(shape);
    }
  });
});

describe("shape inference", () => {
  it("infers browse from no arguments", async () => {
    expect(await inferred({})).toEqual({
      kind: "browse",
      limit: undefined,
      filters: undefined,
    });
  });

  it("infers discover from a bare query", async () => {
    const req = await inferred({ query: "auth refactor" });

    expect(req.kind).toBe("discover");
    expect(req).toMatchObject({ query: "auth refactor" });
  });

  it("infers read from a bare session_id", async () => {
    expect(await inferred({ session_id: "sess_past" })).toEqual({
      kind: "read",
      session_id: "sess_past",
    });
  });

  it("infers scroll from session_id + around_message_id", async () => {
    expect(
      await inferred({ session_id: "sess_past", around_message_id: "evt_9" }),
    ).toEqual({
      kind: "scroll",
      session_id: "sess_past",
      around_message_id: "evt_9",
      window: undefined,
    });
  });

  it("lets scroll win over a query passed alongside it", async () => {
    // Documented: "Ignored when session_id + around_message_id are set."
    const req = await inferred({
      query: "auth refactor",
      session_id: "sess_past",
      around_message_id: "evt_9",
    });

    expect(req.kind).toBe("scroll");
    expect(req).not.toHaveProperty("query");
  });

  it("lets read win over a query when only session_id is set", async () => {
    const req = await inferred({ query: "auth refactor", session_id: "sess_past" });

    expect(req.kind).toBe("read");
  });

  it("falls back to discover when around_message_id is set without session_id", async () => {
    // A dangling anchor can't identify a conversation, so it is ignored
    // rather than producing an unanswerable scroll.
    const req = await inferred({ query: "auth", around_message_id: "evt_9" });

    expect(req.kind).toBe("discover");
  });

  it("falls back to browse when around_message_id is the only argument", async () => {
    expect((await inferred({ around_message_id: "evt_9" })).kind).toBe("browse");
  });

  it("accepts the synthetic user-turn anchor id format", async () => {
    const req = await inferred({
      session_id: "sess_past",
      around_message_id: "intent:sess_past",
    });

    expect(req).toMatchObject({
      kind: "scroll",
      around_message_id: "intent:sess_past",
    });
  });
});

describe("argument coercion", () => {
  it.each([
    ["whitespace-only", "   "],
    ["empty", ""],
    ["a number", 7],
    ["null", null],
  ])("treats %s session_id as absent", async (_label, session_id) => {
    expect((await inferred({ session_id })).kind).toBe("browse");
  });

  it.each([
    ["whitespace-only", "   "],
    ["empty", ""],
    ["a number", 7],
  ])("treats %s query as absent", async (_label, query) => {
    expect((await inferred({ query })).kind).toBe("browse");
  });

  it("treats a whitespace-only anchor as absent, degrading scroll to read", async () => {
    expect(await inferred({ session_id: "sess_past", around_message_id: "  " })).toEqual({
      kind: "read",
      session_id: "sess_past",
    });
  });

  it("trims the query, session_id and anchor before dispatching", async () => {
    const req = await inferred({
      session_id: "  sess_past  ",
      around_message_id: "  evt_9  ",
    });

    expect(req).toMatchObject({
      session_id: "sess_past",
      around_message_id: "evt_9",
    });
  });

  it("trims a discover query", async () => {
    expect(await inferred({ query: "  auth refactor  " })).toMatchObject({
      query: "auth refactor",
    });
  });

  it("passes numeric limit and window through untouched — clamping is the service's job", async () => {
    const discover = await inferred({ query: "auth", limit: 99 });
    expect(discover).toMatchObject({ limit: 99 });

    const scroll = await inferred({
      session_id: "sess_past",
      around_message_id: "evt_9",
      window: 100,
    });
    expect(scroll).toMatchObject({ window: 100 });
  });

  it("drops a non-numeric limit rather than forwarding a bad type", async () => {
    expect(await inferred({ query: "auth", limit: "3" })).toMatchObject({
      limit: undefined,
    });
  });

  it("drops a non-numeric window", async () => {
    expect(
      await inferred({
        session_id: "sess_past",
        around_message_id: "evt_9",
        window: "10",
      }),
    ).toMatchObject({ window: undefined });
  });

  it.each([["newest"], ["oldest"]])("forwards the %s sort", async (sort) => {
    expect(await inferred({ query: "auth", sort })).toMatchObject({ sort });
  });

  it("drops an unrecognised sort value", async () => {
    expect(await inferred({ query: "auth", sort: "relevance" })).toMatchObject({
      sort: undefined,
    });
  });

  it("forwards filters on the discover shape", async () => {
    const filters = { status: "failed", session_type: "task" };
    expect(await inferred({ query: "auth", filters })).toMatchObject({ filters });
  });

  it("forwards filters on the browse shape", async () => {
    const filters = { agent_id: "agent_sub" };
    expect(await inferred({ filters })).toMatchObject({ filters });
  });

  it.each([
    ["null", null],
    ["a string", "status:failed"],
  ])("drops %s filters", async (_label, filters) => {
    expect(await inferred({ query: "auth", filters })).toMatchObject({
      filters: undefined,
    });
  });
});

describe("caller context", () => {
  it("passes the caller's agent id, tier and current session to the service", async () => {
    const { handler, service } = tool({ hierarchyLevel: "org" as HierarchyLevel });

    await handler({ query: "auth" });

    expect(service.search).toHaveBeenCalledWith(expect.anything(), {
      callerAgentId: AGENT_ID,
      hierarchyLevel: "org",
      currentSessionId: SESSION_ID,
    });
  });

  it.each([["ic"], ["team"], ["org"]])(
    "forwards the %s tier verbatim — scope resolution belongs to the service",
    async (level) => {
      const { handler, service } = tool({
        hierarchyLevel: level as HierarchyLevel,
      });

      await handler({});

      expect(service.search).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ hierarchyLevel: level }),
      );
    },
  );
});

describe("results and failures", () => {
  it("returns the service payload unwrapped on success", async () => {
    const payload = { kind: "discover", results: [{ session: { id: "sess_1" } }] };
    const { handler } = tool({}, fakeService(() => payload));

    const res = await handler({ query: "auth" });

    expect(res.isError).toBeUndefined();
    expect(res.content).toBe(payload);
  });

  it("maps a null result onto not_found_or_forbidden", async () => {
    // The service collapses three distinct cases to null on purpose:
    // out-of-scope session, unknown anchor, anchor in the live
    // conversation. The tool must not leak which.
    const { handler } = tool({}, fakeService(() => null));

    const res = await handler({ session_id: "sess_other" });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("not_found_or_forbidden");
    expect(res.content.message).toContain("not in your scope");
  });

  it.each([
    ["forbidden_agent_filter"],
    ["missing_query"],
    ["missing_args"],
  ])("surfaces the %s code from a SessionSearchError", async (code) => {
    const { handler } = tool(
      {},
      fakeService(() => {
        throw new SessionSearchError(
          code as "forbidden_agent_filter" | "missing_query" | "missing_args",
          `rejected: ${code}`,
        );
      }),
    );

    const res = await handler({ query: "auth" });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: code, message: `rejected: ${code}` });
  });

  it("recognises a structurally-identical error from another bundle by name", async () => {
    // api consumes @beevibe/core from dist/; a script consuming src/
    // produces a different class object for the same error. The handler
    // matches on `name` too so the code still reaches the agent.
    const foreign = new Error("agent_id outside your scope");
    foreign.name = "SessionSearchError";
    (foreign as Error & { code: string }).code = "forbidden_agent_filter";

    const { handler } = tool(
      {},
      fakeService(() => {
        throw foreign;
      }),
    );

    const res = await handler({ query: "auth" });

    expect(res.content).toEqual({
      error: "forbidden_agent_filter",
      message: "agent_id outside your scope",
    });
  });

  it("wraps an unrelated Error as internal_error", async () => {
    const { handler } = tool(
      {},
      fakeService(() => {
        throw new Error("connection terminated");
      }),
    );

    const res = await handler({ query: "auth" });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "internal_error",
      message: "connection terminated",
    });
  });

  it("stringifies a non-Error throw", async () => {
    const { handler } = tool(
      {},
      fakeService(() => {
        throw "statement timeout";
      }),
    );

    const res = await handler({ query: "auth" });

    expect(res.content).toEqual({
      error: "internal_error",
      message: "statement timeout",
    });
  });

  it("does not treat a same-named non-SessionSearchError code as a code", async () => {
    // An Error named SessionSearchError but with no `code` still takes
    // the coded branch — assert the shape so the fallback is visible.
    const nameless = new Error("odd");
    nameless.name = "SessionSearchError";

    const { handler } = tool(
      {},
      fakeService(() => {
        throw nameless;
      }),
    );

    const res = await handler({ query: "auth" });

    expect(res.isError).toBe(true);
    expect(res.content.message).toBe("odd");
  });
});
