/**
 * Mesh tool tests — tier assembly, then per-handler behavior.
 *
 * The first half locks the static tier inventory: the exact tool *names*
 * each tier gets, so future skill-loader work can rely on the surface
 * being stable.
 *
 * The second half covers the handlers. The m6/m7 e2e scripts exercise
 * them end to end (live Postgres + spawned CLI subprocesses); what's
 * locked here is the part those scripts can't isolate — the
 * required-argument checks, the counter-proposal rule, the
 * terminal-vs-continuing branch in respond_negotiate, the escalated
 * sentinel projection, the response projections (which decide what the
 * agent is *not* shown), and the ordering in report_blocker /
 * escalate_to_humans.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentRepository, Task, TaskRepository } from "@beevibe/core";
import type { ResolvedCaller } from "@beevibe/core/auth";
import type { Pool } from "@beevibe/core/adapters/postgres";
import type { EscalationService } from "@beevibe/core/services/escalation-service";
import type { TaskService } from "@beevibe/core/services/task-service";
import { MeshCapacityError } from "../mesh/types.js";
import type { MeshServer } from "../mesh/server.js";
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

// ── Handler behavior ──────────────────────────────────────────────────────

const CALLER = "agent_caller";
const SID = "ses_caller";

interface MeshHarness {
  services: MeshToolServices;
  mesh: {
    sendAsk: ReturnType<typeof vi.fn>;
    respondAsk: ReturnType<typeof vi.fn>;
    sendNegotiate: ReturnType<typeof vi.fn>;
    respondNegotiate: ReturnType<typeof vi.fn>;
    reportBlocker: ReturnType<typeof vi.fn>;
    unblockOnEscalate: ReturnType<typeof vi.fn>;
  };
  agentRepo: { findParent: ReturnType<typeof vi.fn> };
  taskService: { markBlocked: ReturnType<typeof vi.fn> };
  escalationService: { create: ReturnType<typeof vi.fn> };
  query: ReturnType<typeof vi.fn>;
  order: string[];
  tools: Map<string, ReturnType<typeof buildTeamMeshTools>[number]>;
}

function meshHarness(): MeshHarness {
  const order: string[] = [];

  const mesh = {
    sendAsk: vi.fn(async (requestId: string, _from: string, _to: string) => ({
      request_id: requestId,
      from_agent_id: "agent_target",
      answer: "yes, feasible",
      // Extra fields the projection must drop.
      internal_session_id: "ses_target",
    })),
    respondAsk: vi.fn(() => {
      order.push("respondAsk");
    }),
    sendNegotiate: vi.fn(async () => ({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "counter" as const,
      message: "how about this",
      counter_proposal: "split the work",
    })),
    respondNegotiate: vi.fn(async () => null),
    reportBlocker: vi.fn(() => {
      order.push("reportBlocker");
    }),
    unblockOnEscalate: vi.fn(() => {
      order.push("unblockOnEscalate");
    }),
  };

  const agentRepo = {
    findParent: vi.fn(async () => ({ id: "agent_parent" }) as unknown as Agent),
  };
  const taskService = {
    markBlocked: vi.fn(async () => {
      order.push("markBlocked");
      return {} as unknown as Task;
    }),
  };
  const escalationService = {
    create: vi.fn(async () => {
      order.push("escalationCreate");
      return {
        id: "esc_1",
        status: "open",
        negotiation_id: "neg_1",
      };
    }),
  };
  const query = vi.fn(async () => {
    order.push("pg_notify");
    return { rows: [] };
  });

  const services = {
    mesh: mesh as unknown as MeshServer,
    agentRepo: agentRepo as unknown as AgentRepository,
    taskRepo: {} as unknown as TaskRepository,
    taskService: taskService as unknown as TaskService,
    escalationService: escalationService as unknown as EscalationService,
    pool: { query } as unknown as Pool,
  } satisfies MeshToolServices;

  const caller: ResolvedCaller = {
    agentId: CALLER,
    source: "agent",
    hierarchyLevel: "team",
  };
  const tools = new Map(
    buildTeamMeshTools({ caller, beevibeSid: SID }, services).map((t) => [t.name, t]),
  );

  return {
    services,
    mesh,
    agentRepo,
    taskService,
    escalationService,
    query,
    order,
    tools,
  };
}

let h: MeshHarness;
beforeEach(() => {
  h = meshHarness();
});

function call(name: string, input: Record<string, unknown>) {
  const tool = h.tools.get(name);
  if (!tool) throw new Error(`${name} not assembled`);
  return tool.handler(input);
}

describe("ask", () => {
  it("mints a request id, forwards caller + target, and projects only the agent-facing fields", async () => {
    const result = await call("ask", {
      target_agent_id: "agent_target",
      question: "is X feasible?",
    });

    expect(h.mesh.sendAsk).toHaveBeenCalledTimes(1);
    const [requestId, from, to, question] = h.mesh.sendAsk.mock.calls[0] as string[];
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect([from, to, question]).toEqual([CALLER, "agent_target", "is X feasible?"]);

    // Exactly three keys — the responder's internal session id must not leak.
    expect(result.content).toEqual({
      request_id: requestId,
      from_agent_id: "agent_target",
      answer: "yes, feasible",
    });
    expect(result.isError).toBeFalsy();
  });

  it("mints a fresh request id per call", async () => {
    await call("ask", { target_agent_id: "a", question: "q" });
    await call("ask", { target_agent_id: "a", question: "q" });
    const [first] = h.mesh.sendAsk.mock.calls[0] as string[];
    const [second] = h.mesh.sendAsk.mock.calls[1] as string[];
    expect(first).not.toBe(second);
  });

  it("requires both target_agent_id and question", async () => {
    for (const input of [
      {},
      { target_agent_id: "agent_target" },
      { question: "q" },
      { target_agent_id: "", question: "q" },
      { target_agent_id: "agent_target", question: "" },
    ]) {
      const result = await call("ask", input);
      expect(result.isError).toBe(true);
      expect(result.content).toEqual({ error: "target_agent_id and question required" });
      expect(h.mesh.sendAsk).not.toHaveBeenCalled();
    }
  });

  it("keeps a CodedMeshError's code and meta so the agent can branch on capacity", async () => {
    h.mesh.sendAsk.mockRejectedValue(
      new MeshCapacityError("too many running", {
        agentId: "agent_target",
        running: 3,
        cap: 3,
      }),
    );
    const result = await call("ask", {
      target_agent_id: "agent_target",
      question: "q",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "MESH_CAPACITY_EXCEEDED",
      agentId: "agent_target",
      running: 3,
      cap: 3,
      message: "too many running",
    });
  });

  it("degrades an uncoded throw to the catch-all envelope", async () => {
    h.mesh.sendAsk.mockRejectedValue(new Error("target offline"));
    const result = await call("ask", {
      target_agent_id: "agent_target",
      question: "q",
    });
    expect(result.content).toEqual({ error: "target offline" });
  });
});

describe("respond_ask", () => {
  it("stamps the responder's own agent id on the response", async () => {
    const result = await call("respond_ask", {
      request_id: "req_1",
      answer: "here is the context",
    });
    expect(h.mesh.respondAsk).toHaveBeenCalledWith("req_1", {
      request_id: "req_1",
      from_agent_id: CALLER,
      answer: "here is the context",
    });
    expect(result.content).toEqual({ responded: true, request_id: "req_1" });
  });

  it("requires both request_id and answer", async () => {
    for (const input of [{}, { request_id: "req_1" }, { answer: "a" }]) {
      const result = await call("respond_ask", input);
      expect(result.isError).toBe(true);
      expect(result.content).toEqual({ error: "request_id and answer required" });
      expect(h.mesh.respondAsk).not.toHaveBeenCalled();
    }
  });

  it("envelopes a throw from the broker", async () => {
    h.mesh.respondAsk.mockImplementation(() => {
      throw new Error("no such resolver");
    });
    const result = await call("respond_ask", { request_id: "req_1", answer: "a" });
    expect(result.content).toEqual({ error: "no such resolver" });
  });
});

describe("negotiate", () => {
  it("passes the task id and initiator session as options and projects the counter", async () => {
    const result = await call("negotiate", {
      peer_id: "agent_peer",
      proposal: "you take the API",
      task_id: "task_7",
    });
    expect(h.mesh.sendNegotiate).toHaveBeenCalledWith(
      CALLER,
      "agent_peer",
      "you take the API",
      { taskId: "task_7", initiatorSessionId: SID },
    );
    expect(result.content).toEqual({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "counter",
      message: "how about this",
      counter_proposal: "split the work",
    });
  });

  it("omits task_id when blank or not a string", async () => {
    for (const task_id of [undefined, "", 7]) {
      const fresh = meshHarness();
      h = fresh;
      await call("negotiate", { peer_id: "agent_peer", proposal: "p", task_id });
      expect(h.mesh.sendNegotiate.mock.calls[0]?.[3]).toEqual({
        taskId: undefined,
        initiatorSessionId: SID,
      });
    }
  });

  it("requires both peer_id and proposal", async () => {
    for (const input of [{}, { peer_id: "agent_peer" }, { proposal: "p" }]) {
      const result = await call("negotiate", input);
      expect(result.isError).toBe(true);
      expect(result.content).toEqual({ error: "peer_id and proposal required" });
      expect(h.mesh.sendNegotiate).not.toHaveBeenCalled();
    }
  });

  it("projects the escalated sentinel into its own shape, not a negotiation round", async () => {
    h.mesh.sendNegotiate.mockResolvedValue({
      decision: "escalated",
      escalation_id: "esc_9",
      negotiation_id: "neg_1",
      message: "handed to humans",
    });
    const result = await call("negotiate", { peer_id: "agent_peer", proposal: "p" });
    expect(result.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_9",
      negotiation_id: "neg_1",
      message: "handed to humans",
    });
    // No from_agent_id / counter_proposal keys on the sentinel branch.
    expect(result.content).not.toHaveProperty("from_agent_id");
  });

  it("surfaces max_rounds_exceeded style coded errors intact", async () => {
    h.mesh.sendNegotiate.mockRejectedValue(
      new MeshCapacityError("cap", { agentId: "agent_peer", running: 1, cap: 1 }),
    );
    const result = await call("negotiate", { peer_id: "agent_peer", proposal: "p" });
    expect(result.content).toMatchObject({ error: "MESH_CAPACITY_EXCEEDED" });
  });
});

describe("respond_negotiate", () => {
  it("reports terminal when the broker returns null (accept / reject)", async () => {
    const result = await call("respond_negotiate", {
      negotiation_id: "neg_1",
      decision: "accept",
      message: "agreed",
    });
    expect(h.mesh.respondNegotiate).toHaveBeenCalledWith(
      "neg_1",
      {
        negotiation_id: "neg_1",
        from_agent_id: CALLER,
        decision: "accept",
        message: "agreed",
        counter_proposal: undefined,
      },
      SID,
    );
    expect(result.content).toEqual({
      negotiation_id: "neg_1",
      decision: "accept",
      terminal: true,
    });
  });

  it("projects the peer's reply when the negotiation continues", async () => {
    h.mesh.respondNegotiate.mockResolvedValue({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "counter",
      message: "not quite",
      counter_proposal: "try this",
    });
    const result = await call("respond_negotiate", {
      negotiation_id: "neg_1",
      decision: "counter",
      message: "my counter",
      counter_proposal: "mine",
    });
    expect(result.content).toEqual({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "counter",
      message: "not quite",
      counter_proposal: "try this",
    });
  });

  it("projects an escalated sentinel returned mid-round", async () => {
    h.mesh.respondNegotiate.mockResolvedValue({
      decision: "escalated",
      escalation_id: "esc_2",
      negotiation_id: "neg_1",
      message: "peer escalated",
    });
    const result = await call("respond_negotiate", {
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "c",
    });
    expect(result.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_2",
      negotiation_id: "neg_1",
      message: "peer escalated",
    });
  });

  it("requires negotiation_id and message", async () => {
    for (const input of [
      { decision: "accept", message: "m" },
      { negotiation_id: "neg_1", decision: "accept" },
    ]) {
      const result = await call("respond_negotiate", input);
      expect(result.isError).toBe(true);
      expect(result.content).toEqual({ error: "negotiation_id and message required" });
      expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
    }
  });

  it("rejects a decision outside counter / accept / reject", async () => {
    for (const decision of [undefined, "maybe", "ACCEPT", 1]) {
      const fresh = meshHarness();
      h = fresh;
      const result = await call("respond_negotiate", {
        negotiation_id: "neg_1",
        decision,
        message: "m",
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual({
        error: "decision must be one of: counter, accept, reject",
      });
      expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
    }
  });

  it("requires counter_proposal when countering", async () => {
    const result = await call("respond_negotiate", {
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "counter_proposal required when decision='counter'",
    });
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("does not require counter_proposal for accept or reject", async () => {
    for (const decision of ["accept", "reject"]) {
      const fresh = meshHarness();
      h = fresh;
      const result = await call("respond_negotiate", {
        negotiation_id: "neg_1",
        decision,
        message: "m",
      });
      expect(result.isError).toBeFalsy();
      expect(result.content).toMatchObject({ decision, terminal: true });
    }
  });

  it("envelopes a throw from the broker", async () => {
    h.mesh.respondNegotiate.mockRejectedValue(new Error("max_rounds_exceeded"));
    const result = await call("respond_negotiate", {
      negotiation_id: "neg_1",
      decision: "accept",
      message: "m",
    });
    expect(result.content).toEqual({ error: "max_rounds_exceeded" });
  });
});

describe("report_blocker", () => {
  it("derives the parent from the caller, marks the task blocked, then spawns the parent", async () => {
    const result = await call("report_blocker", {
      task_id: "task_7",
      description: "the API key is missing",
    });

    expect(h.agentRepo.findParent).toHaveBeenCalledWith(CALLER);
    expect(h.taskService.markBlocked).toHaveBeenCalledWith(
      "task_7",
      CALLER,
      "the API key is missing",
    );
    expect(h.mesh.reportBlocker).toHaveBeenCalledWith(
      "agent_parent",
      CALLER,
      "task_7",
      "the API key is missing",
    );
    // The task must be blocked before the parent is woken, or the parent
    // reads a task that still looks healthy.
    expect(h.order).toEqual(["markBlocked", "reportBlocker"]);
    expect(result.content).toEqual({
      reported: true,
      parent_agent_id: "agent_parent",
      task_id: "task_7",
    });
  });

  it("refuses for a top-level agent and leaves the task untouched", async () => {
    h.agentRepo.findParent.mockResolvedValue(undefined);
    const result = await call("report_blocker", {
      task_id: "task_7",
      description: "stuck",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "no_parent_to_block" });
    expect(result.content.message).toContain("escalate_to_humans");
    expect(h.taskService.markBlocked).not.toHaveBeenCalled();
    expect(h.mesh.reportBlocker).not.toHaveBeenCalled();
  });

  it("requires task_id and description before looking up the parent", async () => {
    for (const input of [{}, { task_id: "task_7" }, { description: "stuck" }]) {
      const result = await call("report_blocker", input);
      expect(result.isError).toBe(true);
      expect(result.content).toEqual({ error: "task_id and description required" });
      expect(h.agentRepo.findParent).not.toHaveBeenCalled();
    }
  });

  it("does not spawn the parent when marking the task blocked fails", async () => {
    h.taskService.markBlocked.mockRejectedValue(new Error("task not found"));
    const result = await call("report_blocker", {
      task_id: "task_missing",
      description: "stuck",
    });
    expect(result.content).toEqual({ error: "task not found" });
    expect(h.mesh.reportBlocker).not.toHaveBeenCalled();
  });

  it("is available to ICs — escalating upward is the one initiation they get", () => {
    const names = buildIcMeshTools(
      { caller: fakeCaller, beevibeSid: SID },
      {} as unknown as MeshToolServices,
    ).map((t) => t.name);
    expect(names).toContain("report_blocker");
  });
});

describe("escalate_to_humans", () => {
  it("creates the escalation, unblocks the peer, then notifies — in that order", async () => {
    const result = await call("escalate_to_humans", {
      negotiation_id: "neg_1",
      summary: "We're stuck on X; root disagreement is Y.",
      proposals: [{ title: "A", description: "do A" }],
      open_questions: ["who owns the budget?"],
    });

    expect(h.escalationService.create).toHaveBeenCalledWith({
      negotiationId: "neg_1",
      callerAgentId: CALLER,
      summary: "We're stuck on X; root disagreement is Y.",
      proposals: [{ title: "A", description: "do A" }],
      openQuestions: ["who owns the budget?"],
    });
    expect(h.mesh.unblockOnEscalate).toHaveBeenCalledWith("neg_1", "esc_1");
    expect(h.query).toHaveBeenCalledWith(
      expect.stringContaining("pg_notify('escalation_created'"),
      ["esc_1"],
    );
    // The peer must be unblocked before (or at least independently of) the
    // notify; the escalation row has to exist first either way.
    expect(h.order).toEqual(["escalationCreate", "unblockOnEscalate", "pg_notify"]);
    expect(result.content).toEqual({
      escalation_id: "esc_1",
      status: "open",
      negotiation_id: "neg_1",
    });
  });

  it("passes undefined for proposals / open_questions that aren't arrays", async () => {
    await call("escalate_to_humans", {
      negotiation_id: "neg_1",
      summary: "s",
      proposals: "A then B",
      open_questions: "who?",
    });
    expect(h.escalationService.create).toHaveBeenCalledWith({
      negotiationId: "neg_1",
      callerAgentId: CALLER,
      summary: "s",
      proposals: undefined,
      openQuestions: undefined,
    });
  });

  it("filters non-string open_questions entries", async () => {
    await call("escalate_to_humans", {
      negotiation_id: "neg_1",
      summary: "s",
      open_questions: ["who?", 42, null, "when?"],
    });
    expect(h.escalationService.create.mock.calls[0]?.[0]).toMatchObject({
      openQuestions: ["who?", "when?"],
    });
  });

  it("requires negotiation_id and summary", async () => {
    for (const input of [{}, { negotiation_id: "neg_1" }, { summary: "s" }]) {
      const result = await call("escalate_to_humans", input);
      expect(result.isError).toBe(true);
      expect(result.content).toEqual({ error: "negotiation_id and summary required" });
      expect(h.escalationService.create).not.toHaveBeenCalled();
    }
  });

  it("does not unblock the peer or notify when the escalation can't be created", async () => {
    h.escalationService.create.mockRejectedValue(
      new Error("negotiation neg_1 already has an escalation; use add_to_escalation"),
    );
    const result = await call("escalate_to_humans", {
      negotiation_id: "neg_1",
      summary: "s",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: expect.stringContaining("already has an escalation"),
    });
    expect(h.mesh.unblockOnEscalate).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
  });
});
