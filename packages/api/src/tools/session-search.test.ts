/**
 * session_search MCP tool — unit tests with a faked SessionSearchService.
 *
 * The service (and its scope resolution) has its own tests; what lives
 * only here is `inferRequest`, the shape inference that decides which
 * of the four calling shapes an LLM-written call meant. Getting that
 * wrong silently changes what the agent reads — a missing
 * `around_message_id` turning a scroll into a whole-conversation read,
 * say — so each precedence rule gets a case.
 *
 * Also pinned: the null → `not_found_or_forbidden` mapping (the service
 * deliberately returns one shape for "doesn't exist" and "not yours"),
 * and the duck-typed `SessionSearchError` branch, which exists so a
 * src/-vs-dist/ double import still yields the structured code.
 */
import { describe, expect, it, vi } from "vitest";
import {
  SessionSearchError,
  type SessionSearchService,
} from "@beevibe/core/services/session-search";
import { createSessionSearchTool } from "./session-search.js";

const AGENT = "agent_a";
const SESSION = "sess_current001";

function makeService(
  search: SessionSearchService["search"] = vi.fn(async () => ({ results: [] })) as unknown as SessionSearchService["search"],
): SessionSearchService {
  return { search } as unknown as SessionSearchService;
}

function makeTool(service: SessionSearchService, level: "ic" | "team" | "org" = "team") {
  return createSessionSearchTool(
    { agentId: AGENT, hierarchyLevel: level, sessionId: SESSION },
    { sessionSearch: service },
  );
}

/** The request `inferRequest` produced for this input. */
async function requestFor(input: Record<string, unknown>) {
  const service = makeService();
  await makeTool(service).handler(input);
  return vi.mocked(service.search).mock.calls[0]![0];
}

describe("createSessionSearchTool", () => {
  it("exposes the session_search name, schema and agent-facing description", () => {
    const tool = makeTool(makeService());
    expect(tool.name).toBe("session_search");
    expect(tool.schema).toMatchObject({ type: "object" });
    // The description is the contract for all four shapes.
    for (const shape of ["DISCOVERY", "SCROLL", "READ", "BROWSE"]) {
      expect(tool.description).toContain(shape);
    }
  });

  it("passes the caller's identity and current session through as context", async () => {
    const service = makeService();
    await makeTool(service, "ic").handler({ query: "auth" });
    expect(vi.mocked(service.search).mock.calls[0]![1]).toEqual({
      callerAgentId: AGENT,
      hierarchyLevel: "ic",
      currentSessionId: SESSION,
    });
  });
});

describe("session_search shape inference", () => {
  it("session_id + around_message_id means scroll", async () => {
    expect(
      await requestFor({
        session_id: "sess_target001",
        around_message_id: "evt_1",
        window: 10,
      }),
    ).toEqual({
      kind: "scroll",
      session_id: "sess_target001",
      around_message_id: "evt_1",
      window: 10,
    });
  });

  it("scroll wins over a query passed alongside it", async () => {
    const req = await requestFor({
      session_id: "sess_target001",
      around_message_id: "evt_1",
      query: "ignored",
    });
    expect(req.kind).toBe("scroll");
  });

  it("leaves window undefined when it is absent or non-numeric (service clamps)", async () => {
    for (const window of [undefined, "10", null]) {
      const req = await requestFor({
        session_id: "sess_target001",
        around_message_id: "evt_1",
        ...(window === undefined ? {} : { window }),
      });
      expect(req).toMatchObject({ kind: "scroll", window: undefined });
    }
  });

  it("a bare session_id means read the whole conversation", async () => {
    expect(await requestFor({ session_id: "sess_target001" })).toEqual({
      kind: "read",
      session_id: "sess_target001",
    });
  });

  it("read wins over a query passed alongside it", async () => {
    expect((await requestFor({ session_id: "sess_target001", query: "auth" })).kind).toBe(
      "read",
    );
  });

  it("a query alone means discover, with limit, sort and filters forwarded", async () => {
    expect(
      await requestFor({
        query: "  auth refactor  ",
        limit: 3,
        sort: "oldest",
        filters: { type: ["task"] },
      }),
    ).toEqual({
      kind: "discover",
      // Trimmed.
      query: "auth refactor",
      limit: 3,
      sort: "oldest",
      filters: { type: ["task"] },
    });
  });

  it("drops a sort value that isn't newest or oldest", async () => {
    for (const sort of ["relevance", 1, null]) {
      const req = await requestFor({ query: "auth", sort });
      expect(req).toMatchObject({ kind: "discover", sort: undefined });
    }
    expect(await requestFor({ query: "auth", sort: "newest" })).toMatchObject({
      sort: "newest",
    });
  });

  it("nothing usable means browse recent activity", async () => {
    for (const input of [
      {},
      { query: "   " },
      { query: 42 },
      { session_id: "   " },
      // An anchor with no session_id can't scroll — falls through to browse.
      { around_message_id: "evt_1" },
    ]) {
      const req = await requestFor(input);
      expect(req.kind, JSON.stringify(input)).toBe("browse");
    }
  });

  it("carries limit and filters onto a browse too, and ignores a non-object filters", async () => {
    expect(await requestFor({ limit: 20, filters: { status: ["failed"] } })).toEqual({
      kind: "browse",
      limit: 20,
      filters: { status: ["failed"] },
    });
    for (const filters of ["all", 7, null]) {
      expect(await requestFor({ filters })).toMatchObject({ filters: undefined });
    }
  });
});

describe("session_search results and errors", () => {
  it("returns the service result verbatim", async () => {
    const result = { kind: "read", session: { id: "sess_target001" }, messages: [] };
    const service = makeService(vi.fn(async () => result) as unknown as SessionSearchService["search"]);

    const res = await makeTool(service).handler({ session_id: "sess_target001" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toBe(result);
  });

  it("maps a null result onto not_found_or_forbidden", async () => {
    const service = makeService(vi.fn(async () => null) as unknown as SessionSearchService["search"]);

    const res = await makeTool(service).handler({ session_id: "sess_other0001" });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("not_found_or_forbidden");
    // One message for all three causes — the agent must not be able to
    // tell "doesn't exist" from "not yours".
    expect(res.content.message).toContain("not in your scope");
  });

  it("surfaces a SessionSearchError's structured code", async () => {
    for (const code of ["forbidden_agent_filter", "missing_query", "missing_args"] as const) {
      const service = makeService(
        vi.fn(async () => {
          throw new SessionSearchError(code, `nope: ${code}`);
        }) as unknown as SessionSearchService["search"],
      );
      const res = await makeTool(service).handler({ query: "auth" });
      expect(res.isError).toBe(true);
      expect(res.content).toEqual({ error: code, message: `nope: ${code}` });
    }
  });

  it("recognizes a SessionSearchError from another module instance by name", async () => {
    // What a src/-consuming script sees when api consumes dist/:
    // structurally identical, but `instanceof` is false.
    const impostor = Object.assign(new Error("different copy of the class"), {
      name: "SessionSearchError",
      code: "missing_query",
    });
    const service = makeService(
      vi.fn(async () => {
        throw impostor;
      }) as unknown as SessionSearchService["search"],
    );

    const res = await makeTool(service).handler({ query: "auth" });
    expect(res.content).toEqual({
      error: "missing_query",
      message: "different copy of the class",
    });
  });

  it("degrades anything else to internal_error", async () => {
    const boom = makeService(
      vi.fn(async () => {
        throw new Error("pg down");
      }) as unknown as SessionSearchService["search"],
    );
    expect((await makeTool(boom).handler({ query: "auth" })).content).toEqual({
      error: "internal_error",
      message: "pg down",
    });

    const thrownString = makeService(
      vi.fn(async () => {
        throw "pool exhausted";
      }) as unknown as SessionSearchService["search"],
    );
    expect((await makeTool(thrownString).handler({ query: "auth" })).content).toEqual({
      error: "internal_error",
      message: "pool exhausted",
    });
  });
});
