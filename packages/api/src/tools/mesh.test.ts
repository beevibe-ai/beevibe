/**
 * Mesh tool tests — tier gating plus each handler's own share of the work.
 *
 * The end-to-end flows (spawning the peer's CLI, blocking on their reply)
 * need live Postgres and subprocesses and stay in the m6/m7 e2e scripts.
 * What's unit-testable, and tested here, is everything the handler does on
 * either side of the MeshServer call: argument coercion, the guards that
 * short-circuit before any spawn, the projection of the response onto the
 * agent-facing wire shape, and the coded-error envelope.
 */
import { describe, expect, it, vi } from "vitest";
import type { Agent, AgentRepository } from "@beevibe/core";
import type { ResolvedCaller } from "@beevibe/core/auth";
import type { Pool } from "@beevibe/core/adapters/postgres";
import type { EscalationService } from "@beevibe/core/services/escalation-service";
import type { TaskService } from "@beevibe/core/services/task-service";
import { buildIcMeshTools, buildTeamMeshTools, type MeshToolServices } from "./mesh.js";
import type { AgentTool } from "./types.js";
import type { MeshServer } from "../mesh/server.js";
import {
  CannotNegotiateWithIcError,
  MeshCapacityError,
  MeshMaxRoundsError,
} from "../mesh/types.js";

// Fake services — the assembly itself doesn't invoke handlers, so the
// dependencies just need to be the right shape.
const fakeServices = {} as unknown as MeshToolServices;

const fakeCaller: ResolvedCaller = {
  agentId: "agent_x",
  source: "agent",
  hierarchyLevel: "team",
};
const fakeCtx = { caller: fakeCaller, beevibeSid: "ses_x" };

describe("buildIcMeshTools (M9.1)", () => {
  // Exact set, not a superset: ICs are responders, not initiators, so the
  // absences matter as much as the presences. No `respond_negotiate`
  // (M9.1 dropped it — ICs are workers, not deciders) and none of the
  // initiator-side surface (`ask`, `negotiate`, `escalate_to_humans`).
  it("gets exactly respond_ask + report_blocker", () => {
    const tools = buildIcMeshTools(fakeCtx, fakeServices);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["report_blocker", "respond_ask"]);
  });
});

describe("buildTeamMeshTools", () => {
  it("gets the full mesh surface — initiator and responder sides both", () => {
    const tools = buildTeamMeshTools(fakeCtx, fakeServices);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "ask",
      "escalate_to_humans",
      "negotiate",
      "report_blocker",
      "respond_ask",
      "respond_negotiate",
    ]);
  });
});

// ── Handler tests ────────────────────────────────────────────────────────

interface MeshStub {
  sendAsk: ReturnType<typeof vi.fn>;
  respondAsk: ReturnType<typeof vi.fn>;
  sendNegotiate: ReturnType<typeof vi.fn>;
  respondNegotiate: ReturnType<typeof vi.fn>;
  reportBlocker: ReturnType<typeof vi.fn>;
  unblockOnEscalate: ReturnType<typeof vi.fn>;
}

interface Harness {
  services: MeshToolServices;
  mesh: MeshStub;
  markBlocked: ReturnType<typeof vi.fn>;
  escalationCreate: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  tool: (name: string) => AgentTool;
}

function harness(
  opts: {
    parent?: Agent | null;
    askResponse?: unknown;
    negotiateResponse?: unknown;
    respondNegotiateResponse?: unknown;
    escalation?: unknown;
    throws?: unknown;
  } = {},
): Harness {
  const boom = (): never => {
    throw opts.throws;
  };
  const maybeThrow = <T>(value: T): T => (opts.throws ? boom() : value);

  const mesh: MeshStub = {
    sendAsk: vi.fn(async () =>
      maybeThrow(
        opts.askResponse ?? {
          request_id: "req_1",
          from_agent_id: "agent_target",
          answer: "yes, feasible",
        },
      ),
    ),
    respondAsk: vi.fn(() => maybeThrow(undefined)),
    sendNegotiate: vi.fn(async () =>
      maybeThrow(
        opts.negotiateResponse ?? {
          negotiation_id: "neg_1",
          from_agent_id: "agent_peer",
          decision: "counter",
          message: "how about Tuesday",
          counter_proposal: "ship Tuesday",
        },
      ),
    ),
    respondNegotiate: vi.fn(async () =>
      maybeThrow(
        opts.respondNegotiateResponse === undefined
          ? {
              negotiation_id: "neg_1",
              from_agent_id: "agent_peer",
              decision: "counter",
              message: "still no",
              counter_proposal: "ship Wednesday",
            }
          : opts.respondNegotiateResponse,
      ),
    ),
    reportBlocker: vi.fn(),
    unblockOnEscalate: vi.fn(),
  };

  const parent = opts.parent === undefined ? ({ id: "agent_parent" } as Agent) : opts.parent;
  const agentRepo = {
    findParent: vi.fn(async () => maybeThrow(parent ?? undefined)),
  } as unknown as AgentRepository;

  const markBlocked = vi.fn(async () => maybeThrow(undefined));
  const taskService = { markBlocked } as unknown as TaskService;

  const escalationCreate = vi.fn(async () =>
    maybeThrow(
      opts.escalation ?? {
        id: "esc_1",
        status: "open",
        negotiation_id: "neg_1",
      },
    ),
  );
  const escalationService = { create: escalationCreate } as unknown as EscalationService;

  const query = vi.fn(async () => ({ rows: [] }));
  const pool = { query } as unknown as Pool;

  const services = {
    mesh: mesh as unknown as MeshServer,
    agentRepo,
    taskRepo: {} as MeshToolServices["taskRepo"],
    taskService,
    escalationService,
    pool,
  };

  const built = buildTeamMeshTools(fakeCtx, services);
  return {
    services,
    mesh,
    markBlocked,
    escalationCreate,
    query,
    tool: (name) => {
      const found = built.find((t) => t.name === name);
      if (!found) throw new Error(`no such mesh tool: ${name}`);
      return found;
    },
  };
}

describe("ask", () => {
  it("mints a request id, forwards the caller as sender, and projects the response", async () => {
    const h = harness();

    const result = await h
      .tool("ask")
      .handler({ target_agent_id: "agent_target", question: "is X feasible?" });

    const [requestId, from, to, question] = h.mesh.sendAsk.mock.calls[0] as string[];
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect([from, to, question]).toEqual([
      "agent_x",
      "agent_target",
      "is X feasible?",
    ]);
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      request_id: "req_1",
      from_agent_id: "agent_target",
      answer: "yes, feasible",
    });
  });

  it("mints a fresh request id per call", async () => {
    const h = harness();
    const input = { target_agent_id: "agent_target", question: "q" };

    await h.tool("ask").handler(input);
    await h.tool("ask").handler(input);

    const [first] = h.mesh.sendAsk.mock.calls[0] as string[];
    const [second] = h.mesh.sendAsk.mock.calls[1] as string[];
    expect(first).not.toBe(second);
  });

  it.each([
    ["a missing target", { question: "q" }],
    ["a missing question", { target_agent_id: "agent_target" }],
    ["an empty target", { target_agent_id: "", question: "q" }],
  ])("rejects %s without spawning the peer", async (_label, input) => {
    const h = harness();

    const result = await h.tool("ask").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "target_agent_id and question required",
    });
    expect(h.mesh.sendAsk).not.toHaveBeenCalled();
  });
});

describe("respond_ask", () => {
  it("resolves the asker's pending request with the caller as responder", async () => {
    const h = harness();

    const result = await h
      .tool("respond_ask")
      .handler({ request_id: "req_1", answer: "here you go" });

    expect(h.mesh.respondAsk).toHaveBeenCalledWith("req_1", {
      request_id: "req_1",
      from_agent_id: "agent_x",
      answer: "here you go",
    });
    expect(result.content).toEqual({ responded: true, request_id: "req_1" });
  });

  it.each([
    ["a missing request_id", { answer: "a" }],
    ["a missing answer", { request_id: "req_1" }],
  ])("rejects %s", async (_label, input) => {
    const h = harness();

    const result = await h.tool("respond_ask").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "request_id and answer required" });
    expect(h.mesh.respondAsk).not.toHaveBeenCalled();
  });
});

describe("negotiate", () => {
  it("forwards the proposal with the caller's session as initiator metadata", async () => {
    const h = harness();

    const result = await h.tool("negotiate").handler({
      peer_id: "agent_peer",
      proposal: "ship Monday",
      task_id: "task_1",
    });

    expect(h.mesh.sendNegotiate).toHaveBeenCalledWith(
      "agent_x",
      "agent_peer",
      "ship Monday",
      { taskId: "task_1", initiatorSessionId: "ses_x" },
    );
    expect(result.content).toEqual({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "counter",
      message: "how about Tuesday",
      counter_proposal: "ship Tuesday",
    });
  });

  it.each([
    ["absent", undefined],
    ["an empty string", ""],
    ["a non-string", 7],
  ])("drops a task_id that is %s", async (_label, task_id) => {
    const h = harness();

    await h
      .tool("negotiate")
      .handler({ peer_id: "agent_peer", proposal: "p", task_id });

    expect(h.mesh.sendNegotiate.mock.calls[0]?.[3]).toEqual({
      taskId: undefined,
      initiatorSessionId: "ses_x",
    });
  });

  it("projects the escalated sentinel onto its own wire shape", async () => {
    const h = harness({
      negotiateResponse: {
        decision: "escalated",
        escalation_id: "esc_7",
        negotiation_id: "neg_1",
        message: "peer escalated",
      },
    });

    const result = await h
      .tool("negotiate")
      .handler({ peer_id: "agent_peer", proposal: "p" });

    // No from_agent_id / counter_proposal on this branch — the sentinel is
    // not a peer response, it's a state change.
    expect(result.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_7",
      negotiation_id: "neg_1",
      message: "peer escalated",
    });
  });

  it.each([
    ["a missing peer_id", { proposal: "p" }],
    ["a missing proposal", { peer_id: "agent_peer" }],
  ])("rejects %s without spawning the peer", async (_label, input) => {
    const h = harness();

    const result = await h.tool("negotiate").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "peer_id and proposal required" });
    expect(h.mesh.sendNegotiate).not.toHaveBeenCalled();
  });
});

describe("respond_negotiate", () => {
  it("sends a counter and projects the peer's next round", async () => {
    const h = harness();

    const result = await h.tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "not quite",
      counter_proposal: "ship Thursday",
    });

    expect(h.mesh.respondNegotiate).toHaveBeenCalledWith(
      "neg_1",
      {
        negotiation_id: "neg_1",
        from_agent_id: "agent_x",
        decision: "counter",
        message: "not quite",
        counter_proposal: "ship Thursday",
      },
      "ses_x",
    );
    expect(result.content).toMatchObject({
      negotiation_id: "neg_1",
      decision: "counter",
      counter_proposal: "ship Wednesday",
    });
  });

  it.each(["accept", "reject"] as const)(
    "reports %s as terminal when the server returns null",
    async (decision) => {
      const h = harness({ respondNegotiateResponse: null });

      const result = await h
        .tool("respond_negotiate")
        .handler({ negotiation_id: "neg_1", decision, message: "done" });

      expect(result.isError).toBeFalsy();
      expect(result.content).toEqual({
        negotiation_id: "neg_1",
        decision,
        terminal: true,
      });
    },
  );

  it("passes counter_proposal as undefined when it isn't a string", async () => {
    const h = harness({ respondNegotiateResponse: null });

    await h.tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "accept",
      message: "ok",
      counter_proposal: 3,
    });

    expect(h.mesh.respondNegotiate.mock.calls[0]?.[1]).toMatchObject({
      counter_proposal: undefined,
    });
  });

  it("projects an escalated sentinel returned mid-round", async () => {
    const h = harness({
      respondNegotiateResponse: {
        decision: "escalated",
        escalation_id: "esc_2",
        negotiation_id: "neg_1",
        message: "peer escalated",
      },
    });

    const result = await h
      .tool("respond_negotiate")
      .handler({ negotiation_id: "neg_1", decision: "counter", message: "m", counter_proposal: "c" });

    expect(result.content).toMatchObject({
      decision: "escalated",
      escalation_id: "esc_2",
    });
  });

  it.each([
    ["a missing negotiation_id", { decision: "accept", message: "m" }],
    ["a missing message", { negotiation_id: "neg_1", decision: "accept" }],
  ])("rejects %s", async (_label, input) => {
    const h = harness();

    const result = await h.tool("respond_negotiate").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "negotiation_id and message required",
    });
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("rejects a decision outside counter/accept/reject", async () => {
    const h = harness();

    const result = await h
      .tool("respond_negotiate")
      .handler({ negotiation_id: "neg_1", decision: "maybe", message: "m" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "decision must be one of: counter, accept, reject",
    });
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("requires counter_proposal when countering", async () => {
    const h = harness();

    const result = await h
      .tool("respond_negotiate")
      .handler({ negotiation_id: "neg_1", decision: "counter", message: "m" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "counter_proposal required when decision='counter'",
    });
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });
});

describe("report_blocker", () => {
  it("marks the task blocked, then spawns the parent fire-and-forget", async () => {
    const h = harness();

    const result = await h
      .tool("report_blocker")
      .handler({ task_id: "task_1", description: "npm registry is down" });

    expect(h.markBlocked).toHaveBeenCalledWith(
      "task_1",
      "agent_x",
      "npm registry is down",
    );
    expect(h.mesh.reportBlocker).toHaveBeenCalledWith(
      "agent_parent",
      "agent_x",
      "task_1",
      "npm registry is down",
    );
    expect(result.content).toEqual({
      reported: true,
      parent_agent_id: "agent_parent",
      task_id: "task_1",
    });
  });

  it("refuses for a top-level agent and leaves the task untouched", async () => {
    const h = harness({ parent: null });

    const result = await h
      .tool("report_blocker")
      .handler({ task_id: "task_1", description: "stuck" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "no_parent_to_block" });
    expect(h.markBlocked).not.toHaveBeenCalled();
    expect(h.mesh.reportBlocker).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing task_id", { description: "d" }],
    ["a missing description", { task_id: "task_1" }],
  ])("rejects %s before the parent lookup", async (_label, input) => {
    const h = harness();

    const result = await h.tool("report_blocker").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "task_id and description required" });
    expect(h.markBlocked).not.toHaveBeenCalled();
  });
});

describe("escalate_to_humans", () => {
  it("creates the escalation, unblocks the peer, then notifies listeners", async () => {
    const h = harness();
    const proposals = [{ title: "A", description: "do A" }];

    const result = await h.tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "stuck on scheduling",
      proposals,
      open_questions: ["what's the deadline?", 42],
    });

    expect(h.escalationCreate).toHaveBeenCalledWith({
      negotiationId: "neg_1",
      callerAgentId: "agent_x",
      summary: "stuck on scheduling",
      proposals,
      // Non-string questions are filtered out rather than passed through.
      openQuestions: ["what's the deadline?"],
    });
    expect(h.mesh.unblockOnEscalate).toHaveBeenCalledWith("neg_1", "esc_1");
    expect(h.query).toHaveBeenCalledWith(
      expect.stringContaining("pg_notify('escalation_created'"),
      ["esc_1"],
    );
    expect(result.content).toEqual({
      escalation_id: "esc_1",
      status: "open",
      negotiation_id: "neg_1",
    });
  });

  it("omits proposals and open_questions when they aren't arrays", async () => {
    const h = harness();

    await h.tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "stuck",
      proposals: "A or B",
      open_questions: "when?",
    });

    expect(h.escalationCreate.mock.calls[0]?.[0]).toMatchObject({
      proposals: undefined,
      openQuestions: undefined,
    });
  });

  it.each([
    ["a missing negotiation_id", { summary: "s" }],
    ["a missing summary", { negotiation_id: "neg_1" }],
  ])("rejects %s without creating an escalation", async (_label, input) => {
    const h = harness();

    const result = await h.tool("escalate_to_humans").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "negotiation_id and summary required",
    });
    expect(h.escalationCreate).not.toHaveBeenCalled();
  });
});

describe("error envelopes", () => {
  // Every mesh handler funnels throws through toolErrorFromThrown, so a
  // coded error has to survive with its code and meta intact on all of
  // them — that's what the agent branches on.
  const invocations: Array<[string, Record<string, unknown>]> = [
    ["ask", { target_agent_id: "agent_t", question: "q" }],
    ["respond_ask", { request_id: "req_1", answer: "a" }],
    ["negotiate", { peer_id: "agent_p", proposal: "p" }],
    [
      "respond_negotiate",
      { negotiation_id: "neg_1", decision: "accept", message: "m" },
    ],
    ["report_blocker", { task_id: "task_1", description: "d" }],
    ["escalate_to_humans", { negotiation_id: "neg_1", summary: "s" }],
  ];

  it.each(invocations)("%s degrades a plain Error to the catch-all shape", async (name, input) => {
    const h = harness({ throws: new Error("mesh offline") });

    const result = await h.tool(name).handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "mesh offline" });
  });

  it.each(invocations)("%s stringifies a non-Error throw", async (name, input) => {
    const h = harness({ throws: "raw string" });

    const result = await h.tool(name).handler(input);

    expect(result.content).toEqual({ error: "raw string" });
  });

  it("keeps MeshCapacityError's code and meta on ask", async () => {
    const h = harness({
      throws: new MeshCapacityError("at capacity", {
        agentId: "agent_t",
        running: 3,
        cap: 3,
      }),
    });

    const result = await h
      .tool("ask")
      .handler({ target_agent_id: "agent_t", question: "q" });

    expect(result.content).toEqual({
      error: "MESH_CAPACITY_EXCEEDED",
      agentId: "agent_t",
      running: 3,
      cap: 3,
      message: "at capacity",
    });
  });

  it("keeps CannotNegotiateWithIcError's code on negotiate", async () => {
    const h = harness({
      throws: new CannotNegotiateWithIcError({ agentId: "agent_ic" }),
    });

    const result = await h
      .tool("negotiate")
      .handler({ peer_id: "agent_ic", proposal: "p" });

    expect(result.content).toMatchObject({
      error: "CANNOT_NEGOTIATE_WITH_IC",
      agentId: "agent_ic",
    });
  });

  it("keeps MeshMaxRoundsError's round counters on respond_negotiate", async () => {
    const h = harness({
      throws: new MeshMaxRoundsError({
        negotiationId: "neg_1",
        rounds_completed: 5,
        max_rounds: 5,
      }),
    });

    const result = await h
      .tool("respond_negotiate")
      .handler({ negotiation_id: "neg_1", decision: "accept", message: "m" });

    expect(result.content).toMatchObject({
      error: "MAX_ROUNDS_EXCEEDED",
      rounds_completed: 5,
      max_rounds: 5,
    });
  });
});
