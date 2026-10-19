/**
 * Mesh tool tests — tier gating (which tools each tier gets) plus the
 * handler layer of each of the six tools.
 *
 * The handlers are a thin projection over MeshServer / TaskService /
 * EscalationService: argument coercion, the required-field guards, and
 * the `{ error, ...meta, message }` envelope. The blocking round-trips
 * themselves (spawn the peer, park the promise, resolve on the reply)
 * belong to MeshServer and need live Postgres + CLI subprocesses, so
 * they stay with the m6/m7 e2e scripts. Fakes here; what's pinned is
 * the contract the agent sees.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedCaller } from "@beevibe/core/auth";
import { MeshMaxRoundsError } from "../mesh/types.js";
import {
  buildIcMeshTools,
  buildTeamMeshTools,
  type MeshToolContext,
  type MeshToolServices,
} from "./mesh.js";
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

// ── Handler layer ──────────────────────────────────────────────────────

type Mocked = Record<string, ReturnType<typeof vi.fn>>;

interface Harness {
  tools: Record<string, AgentTool>;
  mesh: Mocked;
  agentRepo: Mocked;
  taskService: Mocked;
  escalationService: Mocked;
  pool: Mocked;
}

function harness(ctx: MeshToolContext = fakeCtx): Harness {
  const mesh: Mocked = {
    sendAsk: vi.fn(async () => ({
      request_id: "req_1",
      from_agent_id: "agent_b",
      answer: "yes, feasible",
    })),
    respondAsk: vi.fn(),
    sendNegotiate: vi.fn(async () => ({
      negotiation_id: "neg_1",
      from_agent_id: "agent_b",
      decision: "counter" as const,
      message: "how about this",
      counter_proposal: "ship behind a flag",
    })),
    respondNegotiate: vi.fn(async () => null),
    reportBlocker: vi.fn(),
    unblockOnEscalate: vi.fn(),
  };
  const agentRepo: Mocked = {
    findParent: vi.fn(async () => ({ id: "agent_parent" })),
  };
  const taskService: Mocked = { markBlocked: vi.fn(async () => undefined) };
  const escalationService: Mocked = {
    create: vi.fn(async () => ({
      id: "esc_1",
      status: "open",
      negotiation_id: "neg_1",
    })),
  };
  const pool: Mocked = { query: vi.fn(async () => ({ rows: [] })) };

  const services = {
    mesh,
    agentRepo,
    taskService,
    escalationService,
    pool,
  } as unknown as MeshToolServices;

  return {
    tools: Object.fromEntries(
      buildTeamMeshTools(ctx, services).map((t) => [t.name, t]),
    ),
    mesh,
    agentRepo,
    taskService,
    escalationService,
    pool,
  };
}

describe("ask handler", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("sends the question and projects only request_id/from/answer", async () => {
    const res = await h.tools.ask!.handler({
      target_agent_id: "agent_b",
      question: "is X feasible?",
    });

    const [requestId, from, to, question] = h.mesh.sendAsk!.mock.calls[0]!;
    // The request id is minted here, not supplied by the agent.
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect([from, to, question]).toEqual(["agent_x", "agent_b", "is X feasible?"]);
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({
      request_id: "req_1",
      from_agent_id: "agent_b",
      answer: "yes, feasible",
    });
  });

  it("mints a fresh request id per call", async () => {
    await h.tools.ask!.handler({ target_agent_id: "agent_b", question: "q1" });
    await h.tools.ask!.handler({ target_agent_id: "agent_b", question: "q2" });
    const [first] = h.mesh.sendAsk!.mock.calls[0]!;
    const [second] = h.mesh.sendAsk!.mock.calls[1]!;
    expect(first).not.toBe(second);
  });

  it.each([
    ["no target", { question: "q" }],
    ["no question", { target_agent_id: "agent_b" }],
    ["empty target", { target_agent_id: "", question: "q" }],
    ["empty question", { target_agent_id: "agent_b", question: "" }],
  ])("rejects %s without spawning the target", async (_label, input) => {
    const res = await h.tools.ask!.handler(input);
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: "target_agent_id and question required" });
    expect(h.mesh.sendAsk).not.toHaveBeenCalled();
  });

  it("projects a CodedMeshError's code and meta", async () => {
    h.mesh.sendAsk!.mockRejectedValue(
      new MeshMaxRoundsError({
        negotiationId: "neg_1",
        rounds_completed: 5,
        max_rounds: 5,
      }),
    );
    const res = await h.tools.ask!.handler({
      target_agent_id: "agent_b",
      question: "q",
    });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("MAX_ROUNDS_EXCEEDED");
    expect(res.content.max_rounds).toBe(5);
    expect(res.content.message).toMatch(/escalate_to_humans/);
  });

  it("degrades a plain throw to the catch-all envelope", async () => {
    h.mesh.sendAsk!.mockRejectedValue(new Error("target offline"));
    const res = await h.tools.ask!.handler({
      target_agent_id: "agent_b",
      question: "q",
    });
    expect(res.content).toEqual({ error: "target offline" });
  });
});

describe("respond_ask handler", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("unblocks the asker with the caller as from_agent_id", async () => {
    const res = await h.tools.respond_ask!.handler({
      request_id: "req_9",
      answer: "here you go",
    });
    expect(h.mesh.respondAsk).toHaveBeenCalledWith("req_9", {
      request_id: "req_9",
      from_agent_id: "agent_x",
      answer: "here you go",
    });
    expect(res.content).toEqual({ responded: true, request_id: "req_9" });
  });

  it.each([
    ["no request_id", { answer: "a" }],
    ["no answer", { request_id: "req_9" }],
    ["blank answer", { request_id: "req_9", answer: "" }],
  ])("rejects %s without touching the resolver", async (_label, input) => {
    const res = await h.tools.respond_ask!.handler(input);
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: "request_id and answer required" });
    expect(h.mesh.respondAsk).not.toHaveBeenCalled();
  });

  it("envelopes a throw from the resolver", async () => {
    h.mesh.respondAsk!.mockImplementation(() => {
      throw new Error("no waiter for req_9");
    });
    const res = await h.tools.respond_ask!.handler({
      request_id: "req_9",
      answer: "a",
    });
    expect(res.content).toEqual({ error: "no waiter for req_9" });
  });
});

describe("negotiate handler", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("passes the task id and the caller's session id through", async () => {
    const res = await h.tools.negotiate!.handler({
      peer_id: "agent_b",
      proposal: "split the work",
      task_id: "task_1",
    });
    expect(h.mesh.sendNegotiate).toHaveBeenCalledWith(
      "agent_x",
      "agent_b",
      "split the work",
      { taskId: "task_1", initiatorSessionId: "ses_x" },
    );
    expect(res.content).toEqual({
      negotiation_id: "neg_1",
      from_agent_id: "agent_b",
      decision: "counter",
      message: "how about this",
      counter_proposal: "ship behind a flag",
    });
  });

  it("omits task_id when absent, blank, or not a string", async () => {
    for (const input of [
      { peer_id: "agent_b", proposal: "p" },
      { peer_id: "agent_b", proposal: "p", task_id: "" },
      { peer_id: "agent_b", proposal: "p", task_id: 7 },
    ]) {
      await h.tools.negotiate!.handler(input);
    }
    for (const call of h.mesh.sendNegotiate!.mock.calls) {
      expect(call[3]).toEqual({ taskId: undefined, initiatorSessionId: "ses_x" });
    }
  });

  it("projects the escalated sentinel through its own shape", async () => {
    h.mesh.sendNegotiate!.mockResolvedValue({
      decision: "escalated",
      escalation_id: "esc_7",
      negotiation_id: "neg_1",
      message: "peer escalated",
    });
    const res = await h.tools.negotiate!.handler({
      peer_id: "agent_b",
      proposal: "p",
    });
    expect(res.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_7",
      negotiation_id: "neg_1",
      message: "peer escalated",
    });
  });

  it.each([
    ["no peer", { proposal: "p" }],
    ["no proposal", { peer_id: "agent_b" }],
  ])("rejects %s", async (_label, input) => {
    const res = await h.tools.negotiate!.handler(input);
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: "peer_id and proposal required" });
    expect(h.mesh.sendNegotiate).not.toHaveBeenCalled();
  });
});

describe("respond_negotiate handler", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("reports terminal when the server returns null (accept / reject)", async () => {
    const res = await h.tools.respond_negotiate!.handler({
      negotiation_id: "neg_1",
      decision: "accept",
      message: "works for me",
    });
    // The round number is the server's business — not passed by the agent.
    expect(h.mesh.respondNegotiate).toHaveBeenCalledWith(
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
    expect(res.content).toEqual({
      negotiation_id: "neg_1",
      decision: "accept",
      terminal: true,
    });
  });

  it("projects the peer's next round when the exchange continues", async () => {
    h.mesh.respondNegotiate!.mockResolvedValue({
      negotiation_id: "neg_1",
      from_agent_id: "agent_b",
      decision: "counter",
      message: "nearly",
      counter_proposal: "two weeks",
    });
    const res = await h.tools.respond_negotiate!.handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "how about three weeks",
      counter_proposal: "three weeks",
    });
    expect(h.mesh.respondNegotiate!.mock.calls[0]![1].counter_proposal).toBe(
      "three weeks",
    );
    expect(res.content.decision).toBe("counter");
    expect(res.content.counter_proposal).toBe("two weeks");
  });

  it("projects the escalated sentinel when the peer escalated mid-round", async () => {
    h.mesh.respondNegotiate!.mockResolvedValue({
      decision: "escalated",
      escalation_id: "esc_7",
      negotiation_id: "neg_1",
      message: "submit your perspective",
    });
    const res = await h.tools.respond_negotiate!.handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "c",
    });
    expect(res.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_7",
      negotiation_id: "neg_1",
      message: "submit your perspective",
    });
  });

  it.each([
    ["no negotiation_id", { decision: "accept", message: "m" }],
    ["no message", { negotiation_id: "neg_1", decision: "accept" }],
  ])("rejects %s", async (_label, input) => {
    const res = await h.tools.respond_negotiate!.handler(input);
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: "negotiation_id and message required" });
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("rejects a decision outside counter/accept/reject", async () => {
    const res = await h.tools.respond_negotiate!.handler({
      negotiation_id: "neg_1",
      decision: "maybe",
      message: "m",
    });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe(
      "decision must be one of: counter, accept, reject",
    );
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("requires counter_proposal when the decision is counter", async () => {
    const res = await h.tools.respond_negotiate!.handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "counter_proposal required when decision='counter'",
    });
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("surfaces max_rounds_exceeded with its meta", async () => {
    h.mesh.respondNegotiate!.mockRejectedValue(
      new MeshMaxRoundsError({
        negotiationId: "neg_1",
        rounds_completed: 5,
        max_rounds: 5,
      }),
    );
    const res = await h.tools.respond_negotiate!.handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "c",
    });
    expect(res.content.error).toBe("MAX_ROUNDS_EXCEEDED");
    expect(res.content.rounds_completed).toBe(5);
  });
});

describe("report_blocker handler", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("marks the task blocked, then spawns the parent fire-and-forget", async () => {
    const res = await h.tools.report_blocker!.handler({
      task_id: "task_1",
      description: "the API key is missing",
    });

    expect(h.agentRepo.findParent).toHaveBeenCalledWith("agent_x");
    expect(h.taskService.markBlocked).toHaveBeenCalledWith(
      "task_1",
      "agent_x",
      "the API key is missing",
    );
    expect(h.mesh.reportBlocker).toHaveBeenCalledWith(
      "agent_parent",
      "agent_x",
      "task_1",
      "the API key is missing",
    );
    expect(res.content).toEqual({
      reported: true,
      parent_agent_id: "agent_parent",
      task_id: "task_1",
    });
  });

  it("refuses for a top-level agent and leaves the task alone", async () => {
    h.agentRepo.findParent!.mockResolvedValue(undefined);
    const res = await h.tools.report_blocker!.handler({
      task_id: "task_1",
      description: "stuck",
    });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("no_parent_to_block");
    expect(res.content.message).toMatch(/escalate_to_humans/);
    expect(h.taskService.markBlocked).not.toHaveBeenCalled();
    expect(h.mesh.reportBlocker).not.toHaveBeenCalled();
  });

  it.each([
    ["no task_id", { description: "d" }],
    ["no description", { task_id: "task_1" }],
  ])("rejects %s before looking up the parent", async (_label, input) => {
    const res = await h.tools.report_blocker!.handler(input);
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: "task_id and description required" });
    expect(h.agentRepo.findParent).not.toHaveBeenCalled();
  });

  it("envelopes a markBlocked failure without spawning the parent", async () => {
    h.taskService.markBlocked!.mockRejectedValue(new Error("task not found"));
    const res = await h.tools.report_blocker!.handler({
      task_id: "task_1",
      description: "d",
    });
    expect(res.content).toEqual({ error: "task not found" });
    expect(h.mesh.reportBlocker).not.toHaveBeenCalled();
  });
});

describe("escalate_to_humans handler", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("creates the escalation, unblocks the peer, then notifies", async () => {
    const proposals = [{ title: "A", description: "do A", tradeoffs: "slow" }];
    const res = await h.tools.escalate_to_humans!.handler({
      negotiation_id: "neg_1",
      summary: "we disagree on scope",
      proposals,
      open_questions: ["is the deadline firm?", 42],
    });

    expect(h.escalationService.create).toHaveBeenCalledWith({
      negotiationId: "neg_1",
      callerAgentId: "agent_x",
      summary: "we disagree on scope",
      proposals,
      // Non-string entries are dropped rather than forwarded.
      openQuestions: ["is the deadline firm?"],
    });
    expect(h.mesh.unblockOnEscalate).toHaveBeenCalledWith("neg_1", "esc_1");
    expect(h.pool.query).toHaveBeenCalledWith(
      `SELECT pg_notify('escalation_created', $1)`,
      ["esc_1"],
    );
    expect(res.content).toEqual({
      escalation_id: "esc_1",
      status: "open",
      negotiation_id: "neg_1",
    });
  });

  it("omits proposals / open_questions when they aren't arrays", async () => {
    await h.tools.escalate_to_humans!.handler({
      negotiation_id: "neg_1",
      summary: "s",
      proposals: "not an array",
      open_questions: { q: 1 },
    });
    const arg = h.escalationService.create!.mock.calls[0]![0];
    expect(arg.proposals).toBeUndefined();
    expect(arg.openQuestions).toBeUndefined();
  });

  it.each([
    ["no negotiation_id", { summary: "s" }],
    ["no summary", { negotiation_id: "neg_1" }],
  ])("rejects %s", async (_label, input) => {
    const res = await h.tools.escalate_to_humans!.handler(input);
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: "negotiation_id and summary required" });
    expect(h.escalationService.create).not.toHaveBeenCalled();
  });

  it("does not unblock the peer when the escalation insert fails", async () => {
    h.escalationService.create!.mockRejectedValue(
      new Error("negotiation already escalated"),
    );
    const res = await h.tools.escalate_to_humans!.handler({
      negotiation_id: "neg_1",
      summary: "s",
    });
    expect(res.content).toEqual({ error: "negotiation already escalated" });
    expect(h.mesh.unblockOnEscalate).not.toHaveBeenCalled();
    expect(h.pool.query).not.toHaveBeenCalled();
  });
});
