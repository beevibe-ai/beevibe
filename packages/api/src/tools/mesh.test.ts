/**
 * Mesh tool tests — tier gating plus the per-tool handler contracts.
 *
 * The *flows* (a real spawn, a real block-until-response round trip) need
 * live Postgres + spawned CLI subprocesses and stay with the m6/m7 e2e
 * scripts. What is unit-testable, and covered here, is everything the
 * handler does either side of the MeshServer call: argument coercion and
 * validation, the projection of each response shape onto the MCP wire
 * envelope, and the error envelope for a thrown CodedMeshError.
 *
 * The first section locks the static tier inventory — the exact tool
 * *names* each tier gets, so future skill-loader work can rely on the
 * surface being stable.
 */
import { describe, expect, it, vi } from "vitest";
import type { ResolvedCaller } from "@beevibe/core/auth";
import type { AgentRepository, TaskRepository } from "@beevibe/core";
import type { EscalationService } from "@beevibe/core/services/escalation-service";
import type { TaskService } from "@beevibe/core/services/task-service";
import type { Pool } from "@beevibe/core/adapters/postgres";
import {
  CannotNegotiateWithIcError,
  MeshCapacityError,
  MeshMaxRoundsError,
} from "../mesh/types.js";
import type { MeshServer } from "../mesh/server.js";
import type { AgentTool } from "./types.js";
import { buildIcMeshTools, buildTeamMeshTools, type MeshToolServices } from "./mesh.js";

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

// ── Handler harness ──────────────────────────────────────────────────────

interface MeshStubs {
  sendAsk: ReturnType<typeof vi.fn>;
  respondAsk: ReturnType<typeof vi.fn>;
  sendNegotiate: ReturnType<typeof vi.fn>;
  respondNegotiate: ReturnType<typeof vi.fn>;
  reportBlocker: ReturnType<typeof vi.fn>;
  unblockOnEscalate: ReturnType<typeof vi.fn>;
  findParent: ReturnType<typeof vi.fn>;
  markBlocked: ReturnType<typeof vi.fn>;
  createEscalation: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
}

function harness(): { services: MeshToolServices; stubs: MeshStubs; tool: (n: string) => AgentTool } {
  const stubs: MeshStubs = {
    sendAsk: vi.fn(async () => ({
      request_id: "req_1",
      from_agent_id: "agent_target",
      answer: "yes, feasible",
    })),
    respondAsk: vi.fn(),
    sendNegotiate: vi.fn(async () => ({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "counter",
      message: "how about Tuesday",
      counter_proposal: "ship Tuesday",
    })),
    respondNegotiate: vi.fn(async () => null),
    reportBlocker: vi.fn(),
    unblockOnEscalate: vi.fn(),
    findParent: vi.fn(async () => ({ id: "agent_parent" })),
    markBlocked: vi.fn(async () => undefined),
    createEscalation: vi.fn(async () => ({
      id: "esc_1",
      status: "open",
      negotiation_id: "neg_1",
    })),
    query: vi.fn(async () => ({ rows: [] })),
  };

  const services = {
    mesh: {
      sendAsk: stubs.sendAsk,
      respondAsk: stubs.respondAsk,
      sendNegotiate: stubs.sendNegotiate,
      respondNegotiate: stubs.respondNegotiate,
      reportBlocker: stubs.reportBlocker,
      unblockOnEscalate: stubs.unblockOnEscalate,
    } as unknown as MeshServer,
    agentRepo: { findParent: stubs.findParent } as unknown as AgentRepository,
    taskRepo: {} as unknown as TaskRepository,
    taskService: { markBlocked: stubs.markBlocked } as unknown as TaskService,
    escalationService: { create: stubs.createEscalation } as unknown as EscalationService,
    pool: { query: stubs.query } as unknown as Pool,
  };

  const tools = buildTeamMeshTools(fakeCtx, services);
  const tool = (name: string): AgentTool => {
    const found = tools.find((t) => t.name === name);
    if (!found) throw new Error(`no such mesh tool: ${name}`);
    return found;
  };
  return { services, stubs, tool };
}

describe("ask", () => {
  it("sends the ask under a fresh request id and projects the response", async () => {
    const { tool, stubs } = harness();
    const result = await tool("ask").handler({
      target_agent_id: "agent_target",
      question: "is X feasible?",
    });

    expect(stubs.sendAsk).toHaveBeenCalledOnce();
    const [requestId, from, to, question] = stubs.sendAsk.mock.calls[0]!;
    expect(typeof requestId).toBe("string");
    expect(requestId).not.toHaveLength(0);
    expect([from, to, question]).toEqual(["agent_x", "agent_target", "is X feasible?"]);

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      request_id: "req_1",
      from_agent_id: "agent_target",
      answer: "yes, feasible",
    });
  });

  it("mints a distinct request id per call", async () => {
    const { tool, stubs } = harness();
    await tool("ask").handler({ target_agent_id: "a", question: "q" });
    await tool("ask").handler({ target_agent_id: "a", question: "q" });

    expect(stubs.sendAsk.mock.calls[0]![0]).not.toBe(stubs.sendAsk.mock.calls[1]![0]);
  });

  it.each([
    ["no target", { question: "q" }],
    ["no question", { target_agent_id: "a" }],
    ["an empty target", { target_agent_id: "", question: "q" }],
    ["an empty question", { target_agent_id: "a", question: "" }],
  ])("refuses %s without reaching the mesh", async (_label, input) => {
    const { tool, stubs } = harness();
    const result = await tool("ask").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "target_agent_id and question required" });
    expect(stubs.sendAsk).not.toHaveBeenCalled();
  });

  it("projects a CodedMeshError with its code and meta", async () => {
    const { tool, stubs } = harness();
    stubs.sendAsk.mockRejectedValueOnce(
      new MeshCapacityError("at capacity", { agentId: "agent_target", running: 3, cap: 3 }),
    );
    const result = await tool("ask").handler({ target_agent_id: "a", question: "q" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "MESH_CAPACITY_EXCEEDED",
      agentId: "agent_target",
      running: 3,
      cap: 3,
      message: "at capacity",
    });
  });

  it("degrades a plain Error to the catch-all envelope", async () => {
    const { tool, stubs } = harness();
    stubs.sendAsk.mockRejectedValueOnce(new Error("target offline"));
    const result = await tool("ask").handler({ target_agent_id: "a", question: "q" });

    expect(result.content).toEqual({ error: "target offline" });
  });
});

describe("respond_ask", () => {
  it("resolves the waiting ask with the responder's identity", async () => {
    const { tool, stubs } = harness();
    const result = await tool("respond_ask").handler({
      request_id: "req_1",
      answer: "no, blocked on Y",
    });

    expect(stubs.respondAsk).toHaveBeenCalledWith("req_1", {
      request_id: "req_1",
      from_agent_id: "agent_x",
      answer: "no, blocked on Y",
    });
    expect(result.content).toEqual({ responded: true, request_id: "req_1" });
  });

  it.each([
    ["no request_id", { answer: "a" }],
    ["no answer", { request_id: "req_1" }],
  ])("refuses %s", async (_label, input) => {
    const { tool, stubs } = harness();
    const result = await tool("respond_ask").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "request_id and answer required" });
    expect(stubs.respondAsk).not.toHaveBeenCalled();
  });

  it("envelopes a synchronous throw from the mesh", async () => {
    const { tool, stubs } = harness();
    stubs.respondAsk.mockImplementationOnce(() => {
      throw new Error("no waiter for req_1");
    });
    const result = await tool("respond_ask").handler({ request_id: "req_1", answer: "a" });

    expect(result.content).toEqual({ error: "no waiter for req_1" });
  });
});

describe("negotiate", () => {
  it("opens round 1 with the caller's session as originator and projects the counter", async () => {
    const { tool, stubs } = harness();
    const result = await tool("negotiate").handler({
      peer_id: "agent_peer",
      proposal: "ship Monday",
      task_id: "tsk_1",
    });

    expect(stubs.sendNegotiate).toHaveBeenCalledWith("agent_x", "agent_peer", "ship Monday", {
      taskId: "tsk_1",
      initiatorSessionId: "ses_x",
    });
    expect(result.content).toEqual({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "counter",
      message: "how about Tuesday",
      counter_proposal: "ship Tuesday",
    });
  });

  it("omits task_id when it is absent or empty", async () => {
    const { tool, stubs } = harness();
    await tool("negotiate").handler({ peer_id: "p", proposal: "x", task_id: "" });
    expect(stubs.sendNegotiate.mock.calls[0]![3]).toMatchObject({ taskId: undefined });
  });

  it.each([
    ["no peer", { proposal: "x" }],
    ["no proposal", { peer_id: "p" }],
  ])("refuses %s without reaching the mesh", async (_label, input) => {
    const { tool, stubs } = harness();
    const result = await tool("negotiate").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "peer_id and proposal required" });
    expect(stubs.sendNegotiate).not.toHaveBeenCalled();
  });

  it("projects the escalated sentinel rather than a normal round", async () => {
    const { tool, stubs } = harness();
    stubs.sendNegotiate.mockResolvedValueOnce({
      decision: "escalated",
      escalation_id: "esc_1",
      negotiation_id: "neg_1",
      message: "handed to humans",
    });
    const result = await tool("negotiate").handler({ peer_id: "p", proposal: "x" });

    expect(result.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_1",
      negotiation_id: "neg_1",
      message: "handed to humans",
    });
  });

  it("surfaces CANNOT_NEGOTIATE_WITH_IC with the offending agent id", async () => {
    const { tool, stubs } = harness();
    stubs.sendNegotiate.mockRejectedValueOnce(
      new CannotNegotiateWithIcError({ agentId: "agent_ic" }),
    );
    const result = await tool("negotiate").handler({ peer_id: "agent_ic", proposal: "x" });

    expect(result.content).toMatchObject({
      error: "CANNOT_NEGOTIATE_WITH_IC",
      agentId: "agent_ic",
    });
  });
});

describe("respond_negotiate", () => {
  it("forwards the round and reports terminal when the server returns null", async () => {
    const { tool, stubs } = harness();
    const result = await tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "accept",
      message: "works for me",
    });

    expect(stubs.respondNegotiate).toHaveBeenCalledWith(
      "neg_1",
      {
        negotiation_id: "neg_1",
        from_agent_id: "agent_x",
        decision: "accept",
        message: "works for me",
        counter_proposal: undefined,
      },
      "ses_x",
    );
    expect(result.content).toEqual({
      negotiation_id: "neg_1",
      decision: "accept",
      terminal: true,
    });
  });

  it("projects the peer's next round when the server returns one", async () => {
    const { tool, stubs } = harness();
    stubs.respondNegotiate.mockResolvedValueOnce({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "reject",
      message: "no",
      counter_proposal: undefined,
    });
    const result = await tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "how about Wednesday",
      counter_proposal: "ship Wednesday",
    });

    expect(result.content).toMatchObject({ from_agent_id: "agent_peer", decision: "reject" });
  });

  it.each([
    ["no negotiation_id", { decision: "accept", message: "m" }],
    ["no message", { negotiation_id: "neg_1", decision: "accept" }],
  ])("refuses %s", async (_label, input) => {
    const { tool, stubs } = harness();
    const result = await tool("respond_negotiate").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "negotiation_id and message required" });
    expect(stubs.respondNegotiate).not.toHaveBeenCalled();
  });

  it("refuses a decision outside the enum and names the valid ones", async () => {
    const { tool, stubs } = harness();
    const result = await tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "maybe",
      message: "m",
    });

    expect(result.isError).toBe(true);
    expect(result.content.error).toBe("decision must be one of: counter, accept, reject");
    expect(stubs.respondNegotiate).not.toHaveBeenCalled();
  });

  it("refuses a counter with no counter_proposal", async () => {
    const { tool, stubs } = harness();
    const result = await tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "counter_proposal required when decision='counter'",
    });
    expect(stubs.respondNegotiate).not.toHaveBeenCalled();
  });

  it("surfaces MAX_ROUNDS_EXCEEDED with the round counters", async () => {
    const { tool, stubs } = harness();
    stubs.respondNegotiate.mockRejectedValueOnce(
      new MeshMaxRoundsError({
        negotiationId: "neg_1",
        rounds_completed: 5,
        max_rounds: 5,
      }),
    );
    const result = await tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "c",
    });

    expect(result.content).toMatchObject({
      error: "MAX_ROUNDS_EXCEEDED",
      rounds_completed: 5,
      max_rounds: 5,
    });
  });
});

describe("report_blocker", () => {
  it("marks the task blocked, then spawns the parent, and returns the parent id", async () => {
    const { tool, stubs } = harness();
    const result = await tool("report_blocker").handler({
      task_id: "tsk_1",
      description: "credentials missing",
    });

    expect(stubs.findParent).toHaveBeenCalledWith("agent_x");
    expect(stubs.markBlocked).toHaveBeenCalledWith("tsk_1", "agent_x", "credentials missing");
    expect(stubs.reportBlocker).toHaveBeenCalledWith(
      "agent_parent",
      "agent_x",
      "tsk_1",
      "credentials missing",
    );
    expect(result.content).toEqual({
      reported: true,
      parent_agent_id: "agent_parent",
      task_id: "tsk_1",
    });
  });

  it.each([
    ["no task_id", { description: "d" }],
    ["no description", { task_id: "tsk_1" }],
  ])("refuses %s before looking up the parent", async (_label, input) => {
    const { tool, stubs } = harness();
    const result = await tool("report_blocker").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "task_id and description required" });
    expect(stubs.findParent).not.toHaveBeenCalled();
  });

  it("returns no_parent_to_block for a top-level agent, leaving the task alone", async () => {
    const { tool, stubs } = harness();
    stubs.findParent.mockResolvedValueOnce(null);
    const result = await tool("report_blocker").handler({ task_id: "tsk_1", description: "d" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "no_parent_to_block" });
    expect(stubs.markBlocked).not.toHaveBeenCalled();
    expect(stubs.reportBlocker).not.toHaveBeenCalled();
  });

  it("does not spawn the parent when marking the task blocked fails", async () => {
    const { tool, stubs } = harness();
    stubs.markBlocked.mockRejectedValueOnce(new Error("task not found"));
    const result = await tool("report_blocker").handler({ task_id: "tsk_1", description: "d" });

    expect(result.content).toEqual({ error: "task not found" });
    expect(stubs.reportBlocker).not.toHaveBeenCalled();
  });

  it("is available to ICs too — escalating upward is the one thing they initiate", async () => {
    const { services, stubs } = harness();
    const icTools = buildIcMeshTools(
      { caller: { ...fakeCaller, hierarchyLevel: "ic" }, beevibeSid: "ses_ic" },
      services,
    );
    const blocker = icTools.find((t) => t.name === "report_blocker")!;
    await blocker.handler({ task_id: "tsk_1", description: "d" });

    expect(stubs.reportBlocker).toHaveBeenCalledOnce();
  });
});

describe("escalate_to_humans", () => {
  it("creates the escalation, unblocks the peer, and notifies listeners", async () => {
    const { tool, stubs } = harness();
    const result = await tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "stuck on the rollout date",
      proposals: [{ title: "Monday", description: "ship early" }],
      open_questions: ["is the customer flexible?", 42],
    });

    expect(stubs.createEscalation).toHaveBeenCalledWith({
      negotiationId: "neg_1",
      callerAgentId: "agent_x",
      summary: "stuck on the rollout date",
      proposals: [{ title: "Monday", description: "ship early" }],
      // non-string open questions are dropped, not forwarded
      openQuestions: ["is the customer flexible?"],
    });
    expect(stubs.unblockOnEscalate).toHaveBeenCalledWith("neg_1", "esc_1");
    expect(stubs.query).toHaveBeenCalledWith(expect.stringContaining("pg_notify"), ["esc_1"]);
    expect(result.content).toEqual({
      escalation_id: "esc_1",
      status: "open",
      negotiation_id: "neg_1",
    });
  });

  it("leaves proposals and open_questions undefined when they are not arrays", async () => {
    const { tool, stubs } = harness();
    await tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "s",
      proposals: "one option",
      open_questions: "a question",
    });

    expect(stubs.createEscalation.mock.calls[0]![0]).toMatchObject({
      proposals: undefined,
      openQuestions: undefined,
    });
  });

  it.each([
    ["no negotiation_id", { summary: "s" }],
    ["no summary", { negotiation_id: "neg_1" }],
  ])("refuses %s without creating anything", async (_label, input) => {
    const { tool, stubs } = harness();
    const result = await tool("escalate_to_humans").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "negotiation_id and summary required" });
    expect(stubs.createEscalation).not.toHaveBeenCalled();
  });

  it("does not unblock the peer when the escalation fails to create", async () => {
    const { tool, stubs } = harness();
    stubs.createEscalation.mockRejectedValueOnce(new Error("negotiation not found"));
    const result = await tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "s",
    });

    expect(result.content).toEqual({ error: "negotiation not found" });
    expect(stubs.unblockOnEscalate).not.toHaveBeenCalled();
    expect(stubs.query).not.toHaveBeenCalled();
  });
});
