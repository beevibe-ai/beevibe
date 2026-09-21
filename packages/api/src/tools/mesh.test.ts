/**
 * Mesh tool tests — tier inventory plus per-handler behavior.
 *
 * The full mesh round-trips (spawn a peer, block, resolve) need live
 * Postgres and spawned CLI subprocesses and stay in the m6/m7 e2e
 * scripts. What's testable here in isolation is everything the tool
 * layer owns on top of MeshServer: argument validation, the projection
 * of a server response into the agent-facing envelope, and the
 * CodedMeshError passthrough that lets agents branch on `error`.
 */
import { describe, expect, it, vi } from "vitest";
import type { ResolvedCaller } from "@beevibe/core/auth";
import type { AgentRepository, TaskRepository } from "@beevibe/core";
import type { TaskService } from "@beevibe/core/services/task-service";
import type { EscalationService } from "@beevibe/core/services/escalation-service";
import type { Pool } from "@beevibe/core/adapters/postgres";
import {
  MeshCapacityError,
  MeshMaxRoundsError,
  CannotNegotiateWithIcError,
} from "../mesh/types.js";
import type { MeshServer } from "../mesh/server.js";
import { buildIcMeshTools, buildTeamMeshTools, type MeshToolServices } from "./mesh.js";
import type { AgentTool } from "./types.js";

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

// ── Handler harness ───────────────────────────────────────────────────────

interface MeshStub {
  sendAsk: ReturnType<typeof vi.fn>;
  respondAsk: ReturnType<typeof vi.fn>;
  sendNegotiate: ReturnType<typeof vi.fn>;
  respondNegotiate: ReturnType<typeof vi.fn>;
  reportBlocker: ReturnType<typeof vi.fn>;
  unblockOnEscalate: ReturnType<typeof vi.fn>;
}

interface Harness {
  tool: (name: string) => AgentTool;
  mesh: MeshStub;
  findParent: ReturnType<typeof vi.fn>;
  markBlocked: ReturnType<typeof vi.fn>;
  escalationCreate: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
}

function harness(
  overrides: {
    parent?: { id: string } | null;
    escalation?: Record<string, unknown>;
  } = {},
): Harness {
  const mesh: MeshStub = {
    sendAsk: vi.fn(async (requestId: string, _from: string, to: string) => ({
      request_id: requestId,
      from_agent_id: to,
      answer: "yes, feasible",
    })),
    respondAsk: vi.fn(),
    sendNegotiate: vi.fn(async (_from: string, to: string) => ({
      negotiation_id: "neg_1",
      from_agent_id: to,
      decision: "counter",
      message: "how about half",
      counter_proposal: "ship half now",
    })),
    respondNegotiate: vi.fn(async () => ({
      negotiation_id: "neg_1",
      from_agent_id: "agent_b",
      decision: "counter",
      message: "still no",
      counter_proposal: "two thirds",
    })),
    reportBlocker: vi.fn(),
    unblockOnEscalate: vi.fn(),
  };

  const parent =
    overrides.parent === undefined ? { id: "agent_parent" } : overrides.parent;
  const findParent = vi.fn(async () => parent);
  const markBlocked = vi.fn(async () => undefined);
  const escalationCreate = vi.fn(async () => ({
    id: "esc_1",
    status: "open",
    negotiation_id: "neg_1",
    ...overrides.escalation,
  }));
  const query = vi.fn(async () => ({ rows: [] }));

  const services = {
    mesh: mesh as unknown as MeshServer,
    agentRepo: { findParent } as unknown as AgentRepository,
    taskRepo: {} as unknown as TaskRepository,
    taskService: { markBlocked } as unknown as TaskService,
    escalationService: { create: escalationCreate } as unknown as EscalationService,
    pool: { query } as unknown as Pool,
  } satisfies MeshToolServices;

  const tools = buildTeamMeshTools(fakeCtx, services);
  return {
    tool: (name) => {
      const t = tools.find((x) => x.name === name);
      if (!t) throw new Error(`tool ${name} not built`);
      return t;
    },
    mesh,
    findParent,
    markBlocked,
    escalationCreate,
    query,
  };
}

// ── ask ───────────────────────────────────────────────────────────────────

describe("ask handler", () => {
  it("sends the ask under a fresh request id and projects the response", async () => {
    const h = harness();

    const result = await h
      .tool("ask")
      .handler({ target_agent_id: "agent_b", question: "is X feasible?" });

    expect(h.mesh.sendAsk).toHaveBeenCalledTimes(1);
    const [requestId, from, to, question] = h.mesh.sendAsk.mock.calls[0] ?? [];
    expect(typeof requestId).toBe("string");
    expect(requestId).not.toHaveLength(0);
    expect([from, to, question]).toEqual(["agent_x", "agent_b", "is X feasible?"]);
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      request_id: requestId,
      from_agent_id: "agent_b",
      answer: "yes, feasible",
    });
  });

  it("mints a distinct request id per call", async () => {
    const h = harness();

    await h.tool("ask").handler({ target_agent_id: "agent_b", question: "q1" });
    await h.tool("ask").handler({ target_agent_id: "agent_b", question: "q2" });

    const [first] = h.mesh.sendAsk.mock.calls[0] ?? [];
    const [second] = h.mesh.sendAsk.mock.calls[1] ?? [];
    expect(first).not.toBe(second);
  });

  it("requires both target_agent_id and question", async () => {
    const h = harness();

    for (const input of [
      {},
      { target_agent_id: "agent_b" },
      { question: "q" },
      { target_agent_id: "", question: "q" },
    ]) {
      const result = await h.tool("ask").handler(input);
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({
        error: "target_agent_id and question required",
      });
    }
    expect(h.mesh.sendAsk).not.toHaveBeenCalled();
  });

  it("passes a MeshCapacityError's code and meta straight through", async () => {
    const h = harness();
    h.mesh.sendAsk.mockRejectedValueOnce(
      new MeshCapacityError("agent_b is at mesh cap", {
        agentId: "agent_b",
        running: 3,
        cap: 3,
      }),
    );

    const result = await h
      .tool("ask")
      .handler({ target_agent_id: "agent_b", question: "q" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "MESH_CAPACITY_EXCEEDED",
      agentId: "agent_b",
      running: 3,
      cap: 3,
      message: "agent_b is at mesh cap",
    });
  });

  it("degrades an uncoded throw to the catch-all envelope", async () => {
    const h = harness();
    h.mesh.sendAsk.mockRejectedValueOnce(new Error("ask timed out"));

    const result = await h
      .tool("ask")
      .handler({ target_agent_id: "agent_b", question: "q" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "ask timed out" });
  });
});

// ── respond_ask ───────────────────────────────────────────────────────────

describe("respond_ask handler", () => {
  it("fires the asker's resolver with the caller as the responder", async () => {
    const h = harness();

    const result = await h
      .tool("respond_ask")
      .handler({ request_id: "req_1", answer: "42" });

    expect(h.mesh.respondAsk).toHaveBeenCalledWith("req_1", {
      request_id: "req_1",
      from_agent_id: "agent_x",
      answer: "42",
    });
    expect(result.content).toEqual({ responded: true, request_id: "req_1" });
  });

  it("requires both request_id and answer", async () => {
    const h = harness();

    for (const input of [{}, { request_id: "req_1" }, { answer: "42" }]) {
      const result = await h.tool("respond_ask").handler(input);
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({
        error: "request_id and answer required",
      });
    }
    expect(h.mesh.respondAsk).not.toHaveBeenCalled();
  });

  it("envelopes a throw from the server", async () => {
    const h = harness();
    h.mesh.respondAsk.mockImplementationOnce(() => {
      throw new Error("no such resolver");
    });

    const result = await h
      .tool("respond_ask")
      .handler({ request_id: "req_1", answer: "42" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "no such resolver" });
  });
});

// ── negotiate ─────────────────────────────────────────────────────────────

describe("negotiate handler", () => {
  it("opens round 1 with the caller's session as the initiator session", async () => {
    const h = harness();

    const result = await h.tool("negotiate").handler({
      peer_id: "agent_b",
      proposal: "ship it friday",
      task_id: "task_1",
    });

    expect(h.mesh.sendNegotiate).toHaveBeenCalledWith(
      "agent_x",
      "agent_b",
      "ship it friday",
      { taskId: "task_1", initiatorSessionId: "ses_x" },
    );
    expect(result.content).toEqual({
      negotiation_id: "neg_1",
      from_agent_id: "agent_b",
      decision: "counter",
      message: "how about half",
      counter_proposal: "ship half now",
    });
  });

  it("omits an absent or blank task_id", async () => {
    const h = harness();

    await h.tool("negotiate").handler({ peer_id: "agent_b", proposal: "p" });
    await h
      .tool("negotiate")
      .handler({ peer_id: "agent_b", proposal: "p", task_id: "" });

    for (const call of h.mesh.sendNegotiate.mock.calls) {
      expect(call[3]).toMatchObject({ taskId: undefined });
    }
  });

  it("requires both peer_id and proposal", async () => {
    const h = harness();

    for (const input of [{}, { peer_id: "agent_b" }, { proposal: "p" }]) {
      const result = await h.tool("negotiate").handler(input);
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({
        error: "peer_id and proposal required",
      });
    }
    expect(h.mesh.sendNegotiate).not.toHaveBeenCalled();
  });

  it("projects the escalated sentinel rather than a negotiate response", async () => {
    const h = harness();
    h.mesh.sendNegotiate.mockResolvedValueOnce({
      decision: "escalated",
      escalation_id: "esc_7",
      negotiation_id: "neg_1",
      message: "peer escalated to humans",
    });

    const result = await h
      .tool("negotiate")
      .handler({ peer_id: "agent_b", proposal: "p" });

    expect(result.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_7",
      negotiation_id: "neg_1",
      message: "peer escalated to humans",
    });
  });

  it("surfaces CANNOT_NEGOTIATE_WITH_IC with its meta", async () => {
    const h = harness();
    h.mesh.sendNegotiate.mockRejectedValueOnce(
      new CannotNegotiateWithIcError({ agentId: "agent_ic" }),
    );

    const result = await h
      .tool("negotiate")
      .handler({ peer_id: "agent_ic", proposal: "p" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "CANNOT_NEGOTIATE_WITH_IC",
      agentId: "agent_ic",
    });
  });
});

// ── respond_negotiate ─────────────────────────────────────────────────────

describe("respond_negotiate handler", () => {
  it("forwards a counter with the caller's session id and projects the peer's reply", async () => {
    const h = harness();

    const result = await h.tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "not quite",
      counter_proposal: "three quarters",
    });

    expect(h.mesh.respondNegotiate).toHaveBeenCalledWith(
      "neg_1",
      {
        negotiation_id: "neg_1",
        from_agent_id: "agent_x",
        decision: "counter",
        message: "not quite",
        counter_proposal: "three quarters",
      },
      "ses_x",
    );
    expect(result.content).toMatchObject({
      negotiation_id: "neg_1",
      decision: "counter",
      counter_proposal: "two thirds",
    });
  });

  it("reports terminal when the server returns null (accept / reject)", async () => {
    const h = harness();
    h.mesh.respondNegotiate.mockResolvedValueOnce(null);

    const result = await h.tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "accept",
      message: "deal",
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      negotiation_id: "neg_1",
      decision: "accept",
      terminal: true,
    });
  });

  it("requires negotiation_id and message", async () => {
    const h = harness();

    for (const input of [
      { decision: "accept", message: "ok" },
      { negotiation_id: "neg_1", decision: "accept" },
    ]) {
      const result = await h.tool("respond_negotiate").handler(input);
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({
        error: "negotiation_id and message required",
      });
    }
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("rejects a decision outside counter / accept / reject", async () => {
    const h = harness();

    const result = await h.tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "maybe",
      message: "hmm",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "decision must be one of: counter, accept, reject",
    });
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("requires counter_proposal when the decision is counter", async () => {
    const h = harness();

    const result = await h.tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "not quite",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "counter_proposal required when decision='counter'",
    });
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("projects the escalated sentinel when the peer escalated mid-round", async () => {
    const h = harness();
    h.mesh.respondNegotiate.mockResolvedValueOnce({
      decision: "escalated",
      escalation_id: "esc_7",
      negotiation_id: "neg_1",
      message: "peer escalated",
    });

    const result = await h.tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "c",
    });

    expect(result.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_7",
      negotiation_id: "neg_1",
      message: "peer escalated",
    });
  });

  it("surfaces MAX_ROUNDS_EXCEEDED with the round counters", async () => {
    const h = harness();
    h.mesh.respondNegotiate.mockRejectedValueOnce(
      new MeshMaxRoundsError({
        negotiationId: "neg_1",
        rounds_completed: 5,
        max_rounds: 5,
      }),
    );

    const result = await h.tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "c",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "MAX_ROUNDS_EXCEEDED",
      rounds_completed: 5,
      max_rounds: 5,
    });
  });
});

// ── report_blocker ────────────────────────────────────────────────────────

describe("report_blocker handler", () => {
  it("marks the task blocked and spawns the parent", async () => {
    const h = harness();

    const result = await h
      .tool("report_blocker")
      .handler({ task_id: "task_1", description: "no credentials" });

    expect(h.findParent).toHaveBeenCalledWith("agent_x");
    expect(h.markBlocked).toHaveBeenCalledWith(
      "task_1",
      "agent_x",
      "no credentials",
    );
    expect(h.mesh.reportBlocker).toHaveBeenCalledWith(
      "agent_parent",
      "agent_x",
      "task_1",
      "no credentials",
    );
    expect(result.content).toEqual({
      reported: true,
      parent_agent_id: "agent_parent",
      task_id: "task_1",
    });
  });

  it("requires task_id and description", async () => {
    const h = harness();

    for (const input of [{}, { task_id: "task_1" }, { description: "d" }]) {
      const result = await h.tool("report_blocker").handler(input);
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({
        error: "task_id and description required",
      });
    }
    expect(h.findParent).not.toHaveBeenCalled();
  });

  it("refuses with no_parent_to_block for a top-level agent, without blocking the task", async () => {
    const h = harness({ parent: null });

    const result = await h
      .tool("report_blocker")
      .handler({ task_id: "task_1", description: "stuck" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "no_parent_to_block" });
    expect(h.markBlocked).not.toHaveBeenCalled();
    expect(h.mesh.reportBlocker).not.toHaveBeenCalled();
  });

  it("does not spawn the parent when marking the task blocked fails", async () => {
    const h = harness();
    h.markBlocked.mockRejectedValueOnce(new Error("task not found"));

    const result = await h
      .tool("report_blocker")
      .handler({ task_id: "task_gone", description: "stuck" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "task not found" });
    expect(h.mesh.reportBlocker).not.toHaveBeenCalled();
  });
});

// ── escalate_to_humans ────────────────────────────────────────────────────

describe("escalate_to_humans handler", () => {
  it("creates the escalation, unblocks the peer, then notifies listeners", async () => {
    const h = harness();

    const result = await h.tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "stuck on the rollout date",
      proposals: [{ title: "ship friday", description: "cut scope" }],
      open_questions: ["is the customer waiting?"],
    });

    expect(h.escalationCreate).toHaveBeenCalledWith({
      negotiationId: "neg_1",
      callerAgentId: "agent_x",
      summary: "stuck on the rollout date",
      proposals: [{ title: "ship friday", description: "cut scope" }],
      openQuestions: ["is the customer waiting?"],
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

  it("leaves proposals and open_questions undefined when they aren't arrays", async () => {
    const h = harness();

    await h.tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "s",
      proposals: "one option",
      open_questions: { a: 1 },
    });

    expect(h.escalationCreate.mock.calls[0]?.[0]).toMatchObject({
      proposals: undefined,
      openQuestions: undefined,
    });
  });

  it("drops non-string open_questions entries", async () => {
    const h = harness();

    await h.tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "s",
      open_questions: ["real question", 5, null],
    });

    expect(h.escalationCreate.mock.calls[0]?.[0]).toMatchObject({
      openQuestions: ["real question"],
    });
  });

  it("requires negotiation_id and summary", async () => {
    const h = harness();

    for (const input of [{}, { negotiation_id: "neg_1" }, { summary: "s" }]) {
      const result = await h.tool("escalate_to_humans").handler(input);
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({
        error: "negotiation_id and summary required",
      });
    }
    expect(h.escalationCreate).not.toHaveBeenCalled();
  });

  it("does not unblock the peer when the escalation fails to create", async () => {
    const h = harness();
    h.escalationCreate.mockRejectedValueOnce(
      new Error("caller is not a party to this negotiation"),
    );

    const result = await h
      .tool("escalate_to_humans")
      .handler({ negotiation_id: "neg_1", summary: "s" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "caller is not a party to this negotiation",
    });
    expect(h.mesh.unblockOnEscalate).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
  });
});
