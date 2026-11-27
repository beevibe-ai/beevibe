/**
 * Mesh tool tests — tier gating, then per-handler behavior.
 *
 * Part 1 locks the static tier inventory: the exact tool *names* each
 * tier gets, so future skill-loader work can rely on the surface being
 * stable.
 *
 * Part 2 covers the six handlers. The m6/m7 e2e scripts exercise the
 * mesh end to end, but they need live Postgres plus spawned CLI
 * subprocesses, so none of that runs in CI — and the handlers each own
 * an arg gate, a response projection, and a shared error envelope worth
 * pinning on their own.
 */
import { describe, expect, it, vi } from "vitest";
import type { ResolvedCaller } from "@beevibe/core/auth";
import {
  buildIcMeshTools,
  buildTeamMeshTools,
  type MeshToolContext,
  type MeshToolServices,
} from "./mesh.js";
import {
  CannotNegotiateWithIcError,
  MeshCapacityError,
  MeshMaxRoundsError,
} from "../mesh/types.js";
import type { MeshServer } from "../mesh/server.js";
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

// ─────────────────────────────────────────────────────────────────────────
// Handler behavior.
//
// What's mocked is the MeshServer boundary — the blocking round-trips
// (sendAsk/sendNegotiate park until the peer responds) are exactly what
// can't run in a unit test. Everything on this side of it is real.
// ─────────────────────────────────────────────────────────────────────────

const CALLER_ID = "agent_caller";
const SID = "sess_caller";

type Mock = ReturnType<typeof vi.fn>;

interface MeshHarness {
  tools: AgentTool[];
  mesh: {
    sendAsk: Mock;
    respondAsk: Mock;
    sendNegotiate: Mock;
    respondNegotiate: Mock;
    reportBlocker: Mock;
    unblockOnEscalate: Mock;
  };
  findParent: ReturnType<typeof vi.fn>;
  markBlocked: ReturnType<typeof vi.fn>;
  createEscalation: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
}

function meshHarness(
  opts: {
    ask?: unknown;
    negotiate?: unknown;
    respondNegotiate?: unknown;
    parent?: { id: string } | undefined;
    escalation?: { id: string; status: string; negotiation_id: string };
    throws?: { method: string; error: unknown };
  } = {},
): MeshHarness {
  const maybeThrow = (method: string) => {
    if (opts.throws?.method === method) throw opts.throws.error;
  };

  const mesh = {
    sendAsk: vi.fn(async () => {
      maybeThrow("sendAsk");
      return (
        opts.ask ?? {
          request_id: "req_1",
          from_agent_id: "agent_target",
          answer: "yes, feasible",
        }
      );
    }),
    respondAsk: vi.fn(() => {
      maybeThrow("respondAsk");
    }),
    sendNegotiate: vi.fn(async () => {
      maybeThrow("sendNegotiate");
      return (
        opts.negotiate ?? {
          negotiation_id: "neg_1",
          from_agent_id: "agent_peer",
          decision: "accept",
          message: "works for me",
        }
      );
    }),
    respondNegotiate: vi.fn(async () => {
      maybeThrow("respondNegotiate");
      return "respondNegotiate" in opts ? opts.respondNegotiate : null;
    }),
    reportBlocker: vi.fn(() => {
      maybeThrow("reportBlocker");
    }),
    unblockOnEscalate: vi.fn(() => {
      maybeThrow("unblockOnEscalate");
    }),
  };

  const findParent = vi.fn(async () =>
    "parent" in opts ? opts.parent : { id: "agent_parent" },
  );
  const markBlocked = vi.fn(async () => {
    maybeThrow("markBlocked");
  });
  const createEscalation = vi.fn(async () => {
    maybeThrow("createEscalation");
    return (
      opts.escalation ?? { id: "esc_1", status: "open", negotiation_id: "neg_1" }
    );
  });
  const query = vi.fn(async () => {
    maybeThrow("query");
    return { rows: [] };
  });

  const services = {
    mesh: mesh as unknown as MeshServer,
    agentRepo: { findParent },
    taskRepo: {},
    taskService: { markBlocked },
    escalationService: { create: createEscalation },
    pool: { query },
  } as unknown as MeshToolServices;

  const ctx: MeshToolContext = {
    caller: { agentId: CALLER_ID, source: "agent", hierarchyLevel: "team" },
    beevibeSid: SID,
  };

  return {
    tools: buildTeamMeshTools(ctx, services),
    mesh,
    findParent,
    markBlocked,
    createEscalation,
    query,
  };
}

function pick(h: MeshHarness, name: string): AgentTool {
  const t = h.tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} missing`);
  return t;
}

describe("ask", () => {
  it("sends the question and projects only the three wire fields", async () => {
    const h = meshHarness({
      ask: {
        request_id: "req_7",
        from_agent_id: "agent_target",
        answer: "yes",
        internal_bookkeeping: "must not leak",
      },
    });
    const res = await pick(h, "ask").handler({
      target_agent_id: "agent_target",
      question: "is X feasible?",
    });

    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({
      request_id: "req_7",
      from_agent_id: "agent_target",
      answer: "yes",
    });
  });

  it("mints a fresh request id per call and sends from the ctx caller", async () => {
    const h = meshHarness();
    const tool = pick(h, "ask");
    await tool.handler({ target_agent_id: "agent_a", question: "q1" });
    await tool.handler({ target_agent_id: "agent_a", question: "q2" });

    const [first, second] = h.mesh.sendAsk.mock.calls as unknown[][];
    // (requestId, fromAgentId, targetAgentId, question)
    expect(first![0]).not.toBe(second![0]);
    expect(first![0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(first![1]).toBe(CALLER_ID);
    expect(first![2]).toBe("agent_a");
    expect(first![3]).toBe("q1");
  });

  it.each([
    ["target_agent_id", { question: "q" }],
    ["question", { target_agent_id: "agent_a" }],
    ["both", {}],
  ])("rejects a call missing %s", async (_l, input) => {
    const h = meshHarness();
    const res = await pick(h, "ask").handler(input);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("target_agent_id and question required");
    expect(h.mesh.sendAsk).not.toHaveBeenCalled();
  });
});

describe("respond_ask", () => {
  it("delivers the answer stamped with the responder's id", async () => {
    const h = meshHarness();
    const res = await pick(h, "respond_ask").handler({
      request_id: "req_1",
      answer: "here's the context",
    });

    expect(res.content).toEqual({ responded: true, request_id: "req_1" });
    expect(h.mesh.respondAsk).toHaveBeenCalledWith("req_1", {
      request_id: "req_1",
      // Stamped from ctx — a responder can't answer as someone else.
      from_agent_id: CALLER_ID,
      answer: "here's the context",
    });
  });

  it.each([
    ["request_id", { answer: "a" }],
    ["answer", { request_id: "req_1" }],
  ])("rejects a call missing %s", async (_l, input) => {
    const h = meshHarness();
    const res = await pick(h, "respond_ask").handler(input);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("request_id and answer required");
    expect(h.mesh.respondAsk).not.toHaveBeenCalled();
  });
});

describe("negotiate", () => {
  it("opens round 1 with the task and originating session attached", async () => {
    const h = meshHarness();
    const res = await pick(h, "negotiate").handler({
      peer_id: "agent_peer",
      proposal: "ship friday",
      task_id: "task_9",
    });

    expect(res.content).toMatchObject({ negotiation_id: "neg_1", decision: "accept" });
    expect(h.mesh.sendNegotiate).toHaveBeenCalledWith(
      CALLER_ID,
      "agent_peer",
      "ship friday",
      { taskId: "task_9", initiatorSessionId: SID },
    );
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["a non-string", 9],
  ])("omits a task_id that is %s", async (_l, taskId) => {
    const h = meshHarness();
    await pick(h, "negotiate").handler({
      peer_id: "agent_peer",
      proposal: "p",
      task_id: taskId,
    });
    expect(h.mesh.sendNegotiate.mock.calls[0]![3]).toEqual({
      taskId: undefined,
      initiatorSessionId: SID,
    });
  });

  it.each([
    ["peer_id", { proposal: "p" }],
    ["proposal", { peer_id: "agent_peer" }],
  ])("rejects a call missing %s", async (_l, input) => {
    const h = meshHarness();
    const res = await pick(h, "negotiate").handler(input);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("peer_id and proposal required");
    expect(h.mesh.sendNegotiate).not.toHaveBeenCalled();
  });

  it("projects a counter round, carrying the counter_proposal", async () => {
    const h = meshHarness({
      negotiate: {
        negotiation_id: "neg_2",
        from_agent_id: "agent_peer",
        decision: "counter",
        message: "friday is tight",
        counter_proposal: "ship monday",
      },
    });
    const res = await pick(h, "negotiate").handler({
      peer_id: "agent_peer",
      proposal: "ship friday",
    });
    expect(res.content).toEqual({
      negotiation_id: "neg_2",
      from_agent_id: "agent_peer",
      decision: "counter",
      message: "friday is tight",
      counter_proposal: "ship monday",
    });
  });

  // The escalated sentinel is a different shape with no from_agent_id —
  // projecting it like a normal response would hand the agent undefined
  // fields and hide the escalation_id it needs for add_to_escalation.
  it("projects the escalated sentinel through its own branch", async () => {
    const h = meshHarness({
      negotiate: {
        decision: "escalated",
        escalation_id: "esc_5",
        negotiation_id: "neg_3",
        message: "handed to humans",
      },
    });
    const res = await pick(h, "negotiate").handler({
      peer_id: "agent_peer",
      proposal: "p",
    });
    expect(res.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_5",
      negotiation_id: "neg_3",
      message: "handed to humans",
    });
    expect(res.content).not.toHaveProperty("from_agent_id");
  });
});

describe("respond_negotiate", () => {
  it("reports terminal when the server returns null (accept/reject)", async () => {
    const h = meshHarness({ respondNegotiate: null });
    const res = await pick(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "accept",
      message: "agreed",
    });
    expect(res.content).toEqual({
      negotiation_id: "neg_1",
      decision: "accept",
      terminal: true,
    });
  });

  it("projects the peer's next round when the exchange continues", async () => {
    const h = meshHarness({
      respondNegotiate: {
        negotiation_id: "neg_1",
        from_agent_id: "agent_peer",
        decision: "counter",
        message: "how about wednesday",
        counter_proposal: "ship wednesday",
      },
    });
    const res = await pick(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "monday then",
      counter_proposal: "ship monday",
    });
    expect(res.content).toMatchObject({
      from_agent_id: "agent_peer",
      decision: "counter",
      counter_proposal: "ship wednesday",
    });
  });

  it("sends the round stamped with the caller and session, no round number", async () => {
    const h = meshHarness({ respondNegotiate: null });
    await pick(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "reject",
      message: "no",
    });
    const [negId, payload, sid] = h.mesh.respondNegotiate.mock.calls[0]!;
    expect(negId).toBe("neg_1");
    expect(sid).toBe(SID);
    // The server computes the round from negotiation.rounds_completed.
    expect(payload).toEqual({
      negotiation_id: "neg_1",
      from_agent_id: CALLER_ID,
      decision: "reject",
      message: "no",
      counter_proposal: undefined,
    });
  });

  it.each([
    ["negotiation_id", { decision: "accept", message: "m" }],
    ["message", { negotiation_id: "neg_1", decision: "accept" }],
  ])("rejects a call missing %s", async (_l, input) => {
    const h = meshHarness();
    const res = await pick(h, "respond_negotiate").handler(input);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("negotiation_id and message required");
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown", "maybe"],
    ["wrong case", "Accept"],
    ["absent", undefined],
  ])("rejects a decision that is %s", async (_l, decision) => {
    const h = meshHarness();
    const res = await pick(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision,
      message: "m",
    });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("decision must be one of: counter, accept, reject");
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  // A counter with nothing to counter with would park the peer on an
  // empty proposal, so the gate is load-bearing, not cosmetic.
  it.each([
    ["absent", undefined],
    ["empty", ""],
  ])("rejects decision='counter' when counter_proposal is %s", async (_l, counter) => {
    const h = meshHarness();
    const res = await pick(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: counter,
    });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("counter_proposal required when decision='counter'");
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("allows accept/reject without a counter_proposal", async () => {
    const h = meshHarness({ respondNegotiate: null });
    for (const decision of ["accept", "reject"]) {
      const res = await pick(h, "respond_negotiate").handler({
        negotiation_id: "neg_1",
        decision,
        message: "m",
      });
      expect(res.isError).toBeUndefined();
    }
  });
});

describe("report_blocker", () => {
  it("marks the task blocked, then spawns the parent", async () => {
    const h = meshHarness({ parent: { id: "agent_boss" } });
    const res = await pick(h, "report_blocker").handler({
      task_id: "task_9",
      description: "npm registry unreachable",
    });

    expect(res.content).toEqual({
      reported: true,
      parent_agent_id: "agent_boss",
      task_id: "task_9",
    });
    expect(h.findParent).toHaveBeenCalledWith(CALLER_ID);
    expect(h.markBlocked).toHaveBeenCalledWith(
      "task_9",
      CALLER_ID,
      "npm registry unreachable",
    );
    expect(h.mesh.reportBlocker).toHaveBeenCalledWith(
      "agent_boss",
      CALLER_ID,
      "task_9",
      "npm registry unreachable",
    );
  });

  // A top-level agent has nobody to report to; blocking the task and
  // spawning nothing would strand it silently.
  it("refuses with no_parent_to_block when the caller is top-level", async () => {
    const h = meshHarness({ parent: undefined });
    const res = await pick(h, "report_blocker").handler({
      task_id: "task_9",
      description: "stuck",
    });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("no_parent_to_block");
    expect(res.content.message).toMatch(/escalate_to_humans/);
    // Crucially, the task is left alone.
    expect(h.markBlocked).not.toHaveBeenCalled();
    expect(h.mesh.reportBlocker).not.toHaveBeenCalled();
  });

  it.each([
    ["task_id", { description: "d" }],
    ["description", { task_id: "task_9" }],
  ])("rejects a call missing %s", async (_l, input) => {
    const h = meshHarness();
    const res = await pick(h, "report_blocker").handler(input);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("task_id and description required");
    expect(h.findParent).not.toHaveBeenCalled();
  });

  it("does not spawn the parent when markBlocked fails", async () => {
    const h = meshHarness({
      throws: { method: "markBlocked", error: new Error("task not found") },
    });
    const res = await pick(h, "report_blocker").handler({
      task_id: "task_gone",
      description: "stuck",
    });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("task not found");
    expect(h.mesh.reportBlocker).not.toHaveBeenCalled();
  });
});

describe("escalate_to_humans", () => {
  it("creates the escalation, unblocks the peer, then notifies", async () => {
    const h = meshHarness({
      escalation: { id: "esc_9", status: "open", negotiation_id: "neg_4" },
    });
    const res = await pick(h, "escalate_to_humans").handler({
      negotiation_id: "neg_4",
      summary: "stuck on scope",
      proposals: [{ title: "A", description: "do A" }],
      open_questions: ["who owns the budget?"],
    });

    expect(res.content).toEqual({
      escalation_id: "esc_9",
      status: "open",
      negotiation_id: "neg_4",
    });
    expect(h.createEscalation).toHaveBeenCalledWith({
      negotiationId: "neg_4",
      callerAgentId: CALLER_ID,
      summary: "stuck on scope",
      proposals: [{ title: "A", description: "do A" }],
      openQuestions: ["who owns the budget?"],
    });
    // The peer is parked in respond_negotiate; the sentinel is what
    // lets them call add_to_escalation instead of timing out.
    expect(h.mesh.unblockOnEscalate).toHaveBeenCalledWith("neg_4", "esc_9");
    expect(h.query).toHaveBeenCalledWith(
      expect.stringContaining("pg_notify('escalation_created'"),
      ["esc_9"],
    );
  });

  it.each([
    ["negotiation_id", { summary: "s" }],
    ["summary", { negotiation_id: "neg_4" }],
  ])("rejects a call missing %s", async (_l, input) => {
    const h = meshHarness();
    const res = await pick(h, "escalate_to_humans").handler(input);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("negotiation_id and summary required");
    expect(h.createEscalation).not.toHaveBeenCalled();
  });

  it.each([
    ["absent", undefined],
    ["not an array", "proposal A"],
  ])("omits proposals that are %s", async (_l, proposals) => {
    const h = meshHarness();
    await pick(h, "escalate_to_humans").handler({
      negotiation_id: "neg_4",
      summary: "s",
      proposals,
    });
    expect(h.createEscalation.mock.calls[0]![0].proposals).toBeUndefined();
  });

  it("drops non-string open_questions entries", async () => {
    const h = meshHarness();
    await pick(h, "escalate_to_humans").handler({
      negotiation_id: "neg_4",
      summary: "s",
      open_questions: ["real question", 7, null, "another"],
    });
    expect(h.createEscalation.mock.calls[0]![0].openQuestions).toEqual([
      "real question",
      "another",
    ]);
  });

  it("does not unblock the peer when the escalation insert fails", async () => {
    const h = meshHarness({
      throws: { method: "createEscalation", error: new Error("negotiation not found") },
    });
    const res = await pick(h, "escalate_to_humans").handler({
      negotiation_id: "neg_gone",
      summary: "s",
    });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("negotiation not found");
    // Unblocking with a sentinel pointing at no escalation would send
    // the peer to add_to_escalation on a row that doesn't exist.
    expect(h.mesh.unblockOnEscalate).not.toHaveBeenCalled();
  });
});

// Coded mesh errors exist so the agent can branch: MAX_ROUNDS_EXCEEDED
// means "call escalate_to_humans", CANNOT_NEGOTIATE_WITH_IC means "use
// ask or create_task", MESH_CAPACITY_EXCEEDED means "back off". The
// envelope must carry the code and the meta, not just the message.
describe("coded error envelopes", () => {
  it("preserves MeshMaxRoundsError's code and round counters", async () => {
    const err = new MeshMaxRoundsError({
      negotiationId: "neg_1",
      rounds_completed: 5,
      max_rounds: 5,
    });
    const h = meshHarness({ throws: { method: "respondNegotiate", error: err } });
    const res = await pick(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "c",
    });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("MAX_ROUNDS_EXCEEDED");
    expect(res.content.rounds_completed).toBe(5);
    expect(res.content.max_rounds).toBe(5);
    expect(res.content.message).toMatch(/escalate_to_humans/);
  });

  it("preserves CannotNegotiateWithIcError's code and the offending agent", async () => {
    const err = new CannotNegotiateWithIcError({ agentId: "agent_ic" });
    const h = meshHarness({ throws: { method: "sendNegotiate", error: err } });
    const res = await pick(h, "negotiate").handler({
      peer_id: "agent_ic",
      proposal: "p",
    });

    expect(res.content.error).toBe("CANNOT_NEGOTIATE_WITH_IC");
    expect(res.content.agentId).toBe("agent_ic");
  });

  it("preserves MeshCapacityError's code and the cap it hit", async () => {
    const err = new MeshCapacityError("too many running", {
      agentId: "agent_target",
      running: 5,
      cap: 5,
    });
    const h = meshHarness({ throws: { method: "sendAsk", error: err } });
    const res = await pick(h, "ask").handler({
      target_agent_id: "agent_target",
      question: "q",
    });

    expect(res.content.error).toBe("MESH_CAPACITY_EXCEEDED");
    expect(res.content).toMatchObject({ running: 5, cap: 5, message: "too many running" });
  });

  // The catch-all shape puts the human message in `error` (no code to
  // put there). That asymmetry is the documented wire contract.
  it("degrades an uncoded Error to the message-in-error shape", async () => {
    const h = meshHarness({ throws: { method: "sendAsk", error: new Error("socket hangup") } });
    const res = await pick(h, "ask").handler({
      target_agent_id: "agent_target",
      question: "q",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: "socket hangup" });
  });

  it("stringifies a non-Error throw", async () => {
    const h = meshHarness({ throws: { method: "respondAsk", error: "raw boom" } });
    const res = await pick(h, "respond_ask").handler({
      request_id: "req_1",
      answer: "a",
    });
    expect(res.content).toEqual({ error: "raw boom" });
  });
});
