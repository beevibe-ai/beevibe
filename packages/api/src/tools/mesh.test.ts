/**
 * Mesh tool assembly tests — IC vs team tier gating — plus per-handler
 * behavior for all six tools.
 *
 * The tier inventory below locks the static surface each tier gets. The
 * handler suites that follow cover what the m6/m7 e2e scripts can't
 * reach cheaply (they need live Postgres + spawned CLI subprocesses):
 * argument validation, the projection applied to each MeshServer reply,
 * and the error envelope. `toolErrorFromThrown` keeps a CodedMeshError's
 * code + meta and degrades anything else to a bare message, which is
 * what an agent branches on when a peer is at capacity or a negotiation
 * blows its round cap — so both halves are pinned here.
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentRepository, TaskRepository } from "@beevibe/core";
import type { TaskService } from "@beevibe/core/services/task-service";
import type { EscalationService } from "@beevibe/core/services/escalation-service";
import type { Pool } from "@beevibe/core/adapters/postgres";
import type { ResolvedCaller } from "@beevibe/core/auth";
import { MeshCapacityError } from "../mesh/types.js";
import type { MeshServer } from "../mesh/server.js";
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
const fakeCtx: MeshToolContext = { caller: fakeCaller, beevibeSid: "ses_x" };

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

// ── Handler fixtures ─────────────────────────────────────────────────────

function makeServices(over: Partial<MeshToolServices> = {}): MeshToolServices {
  const mesh = {
    sendAsk: vi.fn(async () => ({
      request_id: "req_1",
      from_agent_id: "agent_peer",
      answer: "yes",
    })),
    respondAsk: vi.fn(),
    sendNegotiate: vi.fn(async () => ({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "accept",
      message: "deal",
      counter_proposal: undefined,
    })),
    respondNegotiate: vi.fn(async () => null),
    reportBlocker: vi.fn(),
    unblockOnEscalate: vi.fn(),
  } as unknown as MeshServer;
  const agentRepo = {
    findParent: vi.fn(async () => ({ id: "agent_parent" })),
  } as unknown as AgentRepository;
  // Declared on MeshToolServices but unused by these six handlers — the
  // blocker path goes through taskService.markBlocked, not the repo.
  const taskRepo = {} as unknown as TaskRepository;
  const taskService = { markBlocked: vi.fn(async () => undefined) } as unknown as TaskService;
  const escalationService = {
    create: vi.fn(async () => ({
      id: "esc_1",
      status: "open",
      negotiation_id: "neg_1",
    })),
  } as unknown as EscalationService;
  const pool = { query: vi.fn(async () => ({ rows: [] })) } as unknown as Pool;
  return { mesh, agentRepo, taskRepo, taskService, escalationService, pool, ...over };
}

/** Pull one tool out of the full team-tier set. */
function toolNamed(name: string, services: MeshToolServices): AgentTool {
  const tool = buildTeamMeshTools(fakeCtx, services).find((t) => t.name === name);
  if (!tool) throw new Error(`no such mesh tool: ${name}`);
  return tool;
}

// ── ask / respond_ask ────────────────────────────────────────────────────

describe("ask", () => {
  it("sends the ask under a fresh request id and projects the reply", async () => {
    const services = makeServices();
    const res = await toolNamed("ask", services).handler({
      target_agent_id: "agent_peer",
      question: "is X feasible?",
    });
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({
      request_id: "req_1",
      from_agent_id: "agent_peer",
      answer: "yes",
    });
    const call = (services.mesh.sendAsk as ReturnType<typeof vi.fn>).mock.calls[0];
    // (requestId, fromAgentId, targetAgentId, question)
    expect(call?.[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(call?.slice(1)).toEqual(["agent_x", "agent_peer", "is X feasible?"]);
  });

  it("requires both a target and a question", async () => {
    const services = makeServices();
    for (const input of [
      {},
      { target_agent_id: "agent_peer" },
      { question: "hi" },
      { target_agent_id: "", question: "hi" },
    ]) {
      const res = await toolNamed("ask", services).handler(input);
      expect(res.isError).toBe(true);
    }
    expect(services.mesh.sendAsk).not.toHaveBeenCalled();
  });

  it("keeps a CodedMeshError's code and meta on the wire", async () => {
    const services = makeServices();
    (services.mesh.sendAsk as ReturnType<typeof vi.fn>).mockRejectedValue(
      new MeshCapacityError("peer at capacity", {
        agentId: "agent_peer",
        running: 3,
        cap: 3,
      }),
    );
    const res = await toolNamed("ask", services).handler({
      target_agent_id: "agent_peer",
      question: "q",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({
      error: "MESH_CAPACITY_EXCEEDED",
      agentId: "agent_peer",
      running: 3,
      cap: 3,
      message: "peer at capacity",
    });
  });

  it("degrades a plain throw to the bare message envelope", async () => {
    const services = makeServices();
    (services.mesh.sendAsk as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("target not found"),
    );
    const res = await toolNamed("ask", services).handler({
      target_agent_id: "agent_ghost",
      question: "q",
    });
    expect(res.content).toEqual({ error: "target not found" });
  });
});

describe("respond_ask", () => {
  it("resolves the asker's pending request under the responder's id", async () => {
    const services = makeServices();
    const res = await toolNamed("respond_ask", services).handler({
      request_id: "req_1",
      answer: "yes, with caveats",
    });
    expect(res.content).toEqual({ responded: true, request_id: "req_1" });
    expect(services.mesh.respondAsk).toHaveBeenCalledWith("req_1", {
      request_id: "req_1",
      from_agent_id: "agent_x",
      answer: "yes, with caveats",
    });
  });

  it("requires both a request id and an answer", async () => {
    const services = makeServices();
    for (const input of [{}, { request_id: "req_1" }, { answer: "yes" }]) {
      const res = await toolNamed("respond_ask", services).handler(input);
      expect(res.isError).toBe(true);
    }
    expect(services.mesh.respondAsk).not.toHaveBeenCalled();
  });

  it("is present on the IC tier too", async () => {
    const services = makeServices();
    const icRespond = buildIcMeshTools(fakeCtx, services).find(
      (t) => t.name === "respond_ask",
    );
    await icRespond?.handler({ request_id: "req_1", answer: "ok" });
    expect(services.mesh.respondAsk).toHaveBeenCalled();
  });
});

// ── negotiate / respond_negotiate ────────────────────────────────────────

describe("negotiate", () => {
  it("opens round 1 with the caller's session as the originator", async () => {
    const services = makeServices();
    const res = await toolNamed("negotiate", services).handler({
      peer_id: "agent_peer",
      proposal: "split the work",
      task_id: "task_1",
    });
    expect(res.content).toMatchObject({
      negotiation_id: "neg_1",
      decision: "accept",
      message: "deal",
    });
    expect(services.mesh.sendNegotiate).toHaveBeenCalledWith(
      "agent_x",
      "agent_peer",
      "split the work",
      { taskId: "task_1", initiatorSessionId: "ses_x" },
    );
  });

  it("omits an empty or non-string task_id rather than forwarding it", async () => {
    const services = makeServices();
    await toolNamed("negotiate", services).handler({ peer_id: "p", proposal: "x" });
    await toolNamed("negotiate", services).handler({
      peer_id: "p",
      proposal: "x",
      task_id: "",
    });
    await toolNamed("negotiate", services).handler({
      peer_id: "p",
      proposal: "x",
      task_id: 7,
    });
    for (const call of (services.mesh.sendNegotiate as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[3].taskId).toBeUndefined();
    }
  });

  it("requires both a peer and a proposal", async () => {
    const services = makeServices();
    for (const input of [{}, { peer_id: "p" }, { proposal: "x" }]) {
      const res = await toolNamed("negotiate", services).handler(input);
      expect(res.isError).toBe(true);
    }
    expect(services.mesh.sendNegotiate).not.toHaveBeenCalled();
  });

  it("projects the escalated sentinel instead of a round reply", async () => {
    const services = makeServices();
    (services.mesh.sendNegotiate as ReturnType<typeof vi.fn>).mockResolvedValue({
      decision: "escalated",
      escalation_id: "esc_1",
      negotiation_id: "neg_1",
      message: "handed to humans",
    });
    const res = await toolNamed("negotiate", services).handler({
      peer_id: "agent_peer",
      proposal: "x",
    });
    expect(res.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_1",
      negotiation_id: "neg_1",
      message: "handed to humans",
    });
  });
});

describe("respond_negotiate", () => {
  it("reports terminal when the server has nothing further to return", async () => {
    const services = makeServices();
    const res = await toolNamed("respond_negotiate", services).handler({
      negotiation_id: "neg_1",
      decision: "accept",
      message: "works for me",
    });
    expect(res.content).toEqual({
      negotiation_id: "neg_1",
      decision: "accept",
      terminal: true,
    });
    expect(services.mesh.respondNegotiate).toHaveBeenCalledWith(
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
  });

  it("projects the peer's next round when the exchange continues", async () => {
    const services = makeServices();
    (services.mesh.respondNegotiate as ReturnType<typeof vi.fn>).mockResolvedValue({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "counter",
      message: "how about this",
      counter_proposal: "half now, half later",
    });
    const res = await toolNamed("respond_negotiate", services).handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "my turn",
      counter_proposal: "all now",
    });
    expect(res.content).toEqual({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "counter",
      message: "how about this",
      counter_proposal: "half now, half later",
    });
  });

  it("requires a negotiation id and a message", async () => {
    const services = makeServices();
    for (const input of [
      { decision: "accept", message: "m" },
      { negotiation_id: "neg_1", decision: "accept" },
    ]) {
      const res = await toolNamed("respond_negotiate", services).handler(input);
      expect(res.isError).toBe(true);
      expect(res.content.error).toContain("required");
    }
    expect(services.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("rejects a decision outside counter / accept / reject", async () => {
    const services = makeServices();
    const res = await toolNamed("respond_negotiate", services).handler({
      negotiation_id: "neg_1",
      decision: "maybe",
      message: "m",
    });
    expect(res.isError).toBe(true);
    expect(res.content.error).toContain("counter, accept, reject");
    expect(services.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("insists on a counter_proposal when countering", async () => {
    const services = makeServices();
    const res = await toolNamed("respond_negotiate", services).handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
    });
    expect(res.isError).toBe(true);
    expect(res.content.error).toContain("counter_proposal required");
    expect(services.mesh.respondNegotiate).not.toHaveBeenCalled();
  });
});

// ── report_blocker ───────────────────────────────────────────────────────

describe("report_blocker", () => {
  it("marks the task blocked, then spawns the parent", async () => {
    const services = makeServices();
    const res = await toolNamed("report_blocker", services).handler({
      task_id: "task_1",
      description: "the API key is missing",
    });
    expect(res.content).toEqual({
      reported: true,
      parent_agent_id: "agent_parent",
      task_id: "task_1",
    });
    expect(services.taskService.markBlocked).toHaveBeenCalledWith(
      "task_1",
      "agent_x",
      "the API key is missing",
    );
    expect(services.mesh.reportBlocker).toHaveBeenCalledWith(
      "agent_parent",
      "agent_x",
      "task_1",
      "the API key is missing",
    );
  });

  it("requires a task id and a description", async () => {
    const services = makeServices();
    for (const input of [{}, { task_id: "task_1" }, { description: "stuck" }]) {
      const res = await toolNamed("report_blocker", services).handler(input);
      expect(res.isError).toBe(true);
    }
    expect(services.agentRepo.findParent).not.toHaveBeenCalled();
  });

  it("refuses for a top-level agent and leaves the task untouched", async () => {
    const services = makeServices();
    (services.agentRepo.findParent as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const res = await toolNamed("report_blocker", services).handler({
      task_id: "task_1",
      description: "stuck",
    });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("no_parent_to_block");
    expect(services.taskService.markBlocked).not.toHaveBeenCalled();
    expect(services.mesh.reportBlocker).not.toHaveBeenCalled();
  });

  it("does not spawn the parent when marking the task blocked fails", async () => {
    const services = makeServices();
    (services.taskService.markBlocked as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("task not found"),
    );
    const res = await toolNamed("report_blocker", services).handler({
      task_id: "task_gone",
      description: "stuck",
    });
    expect(res.content).toEqual({ error: "task not found" });
    expect(services.mesh.reportBlocker).not.toHaveBeenCalled();
  });
});

// ── escalate_to_humans ───────────────────────────────────────────────────

describe("escalate_to_humans", () => {
  it("creates the escalation, unblocks the peer, and notifies listeners", async () => {
    const services = makeServices();
    const res = await toolNamed("escalate_to_humans", services).handler({
      negotiation_id: "neg_1",
      summary: "we are stuck on scope",
      proposals: [{ title: "A", description: "do A" }],
      open_questions: ["what is the deadline?", 42],
    });
    expect(res.content).toEqual({
      escalation_id: "esc_1",
      status: "open",
      negotiation_id: "neg_1",
    });
    expect(services.escalationService.create).toHaveBeenCalledWith({
      negotiationId: "neg_1",
      callerAgentId: "agent_x",
      summary: "we are stuck on scope",
      proposals: [{ title: "A", description: "do A" }],
      // The non-string open question is dropped, not forwarded.
      openQuestions: ["what is the deadline?"],
    });
    expect(services.mesh.unblockOnEscalate).toHaveBeenCalledWith("neg_1", "esc_1");
    expect(services.pool.query).toHaveBeenCalledWith(expect.stringContaining("pg_notify"), [
      "esc_1",
    ]);
  });

  it("omits proposals and open_questions when they aren't arrays", async () => {
    const services = makeServices();
    await toolNamed("escalate_to_humans", services).handler({
      negotiation_id: "neg_1",
      summary: "stuck",
      proposals: "A or B",
      open_questions: "when?",
    });
    expect(services.escalationService.create).toHaveBeenCalledWith(
      expect.objectContaining({ proposals: undefined, openQuestions: undefined }),
    );
  });

  it("requires a negotiation id and a summary", async () => {
    const services = makeServices();
    for (const input of [{}, { negotiation_id: "neg_1" }, { summary: "stuck" }]) {
      const res = await toolNamed("escalate_to_humans", services).handler(input);
      expect(res.isError).toBe(true);
    }
    expect(services.escalationService.create).not.toHaveBeenCalled();
  });

  it("leaves the peer blocked when the escalation itself fails", async () => {
    const services = makeServices();
    (services.escalationService.create as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("negotiation already resolved"),
    );
    const res = await toolNamed("escalate_to_humans", services).handler({
      negotiation_id: "neg_1",
      summary: "stuck",
    });
    expect(res.content).toEqual({ error: "negotiation already resolved" });
    expect(services.mesh.unblockOnEscalate).not.toHaveBeenCalled();
    expect(services.pool.query).not.toHaveBeenCalled();
  });
});
