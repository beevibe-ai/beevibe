/**
 * Mesh tool tests — IC vs team tier gating, plus each handler's
 * argument coercion, guards and response projection.
 *
 * The *flows* (a real spawn, a real block-until-response round trip)
 * need live Postgres + spawned CLI subprocesses and stay in the m6/m7
 * e2e scripts. Everything the handlers do on either side of the
 * MeshServer call is plain in-process logic, so it's covered here
 * against a fake server: the tier inventory, the required-arg checks,
 * what gets forwarded, and how a thrown CodedMeshError is projected.
 */
import { describe, expect, it, vi } from "vitest";
import type { ResolvedCaller } from "@beevibe/core/auth";
import type { Agent, AgentRepository, TaskRepository } from "@beevibe/core";
import type { TaskService } from "@beevibe/core/services/task-service";
import type { EscalationService } from "@beevibe/core/services/escalation-service";
import type { Pool } from "@beevibe/core/adapters/postgres";
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

/**
 * A fake for every collaborator a mesh handler touches. Each entry is
 * overridable so a test can make one call throw or return a specific
 * shape without restating the rest.
 */
function meshServices(overrides: Partial<Record<string, unknown>> = {}) {
  const mesh = {
    sendAsk: vi.fn(async () => ({
      request_id: "req_1",
      from_agent_id: "agent_target",
      answer: "yes, feasible",
    })),
    respondAsk: vi.fn(),
    sendNegotiate: vi.fn(async () => ({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "counter" as const,
      message: "how about this",
      counter_proposal: "ship behind a flag",
    })),
    respondNegotiate: vi.fn(async () => null),
    reportBlocker: vi.fn(),
    unblockOnEscalate: vi.fn(),
    ...overrides,
  } as unknown as MeshServer;

  const agentRepo = {
    findParent: vi.fn(async () => ({ id: "agent_parent" }) as unknown as Agent),
  } as unknown as AgentRepository;

  const taskService = {
    markBlocked: vi.fn(async () => undefined),
  } as unknown as TaskService;

  const escalationService = {
    create: vi.fn(async () => ({
      id: "esc_1",
      status: "open",
      negotiation_id: "neg_1",
    })),
  } as unknown as EscalationService;

  const pool = {
    query: vi.fn(async () => ({ rows: [] })),
  } as unknown as Pool;

  const services = {
    mesh,
    agentRepo,
    taskRepo: {} as unknown as TaskRepository,
    taskService,
    escalationService,
    pool,
  } as MeshToolServices;

  return { services, mesh, agentRepo, taskService, escalationService, pool };
}

/** Pull one tool out of the team-tier set by name. */
function teamTool(name: string, services: MeshToolServices) {
  const found = buildTeamMeshTools(fakeCtx, services).find((t) => t.name === name);
  if (!found) throw new Error(`no such mesh tool: ${name}`);
  return found;
}

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

describe("ask", () => {
  it("mints a request id and forwards caller + target + question", async () => {
    const { services, mesh } = meshServices();
    const result = await teamTool("ask", services).handler({
      target_agent_id: "agent_target",
      question: "is X feasible?",
    });

    expect(mesh.sendAsk).toHaveBeenCalledTimes(1);
    const [requestId, from, to, question] = vi.mocked(mesh.sendAsk).mock.calls[0]!;
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect([from, to, question]).toEqual([
      "agent_x",
      "agent_target",
      "is X feasible?",
    ]);
    expect(result.isError).toBeFalsy();
  });

  // The projection is narrower than AskResponse on purpose — the asker
  // gets the answer, not the responder's internal bookkeeping.
  it("projects only request_id, from_agent_id and answer", async () => {
    const { services, mesh } = meshServices();
    vi.mocked(mesh.sendAsk).mockResolvedValue({
      request_id: "req_1",
      from_agent_id: "agent_target",
      answer: "yes",
      ...({ internal: "leak me" } as Record<string, unknown>),
    });
    const result = await teamTool("ask", services).handler({
      target_agent_id: "agent_target",
      question: "is X feasible?",
    });

    expect(result.content).toEqual({
      request_id: "req_1",
      from_agent_id: "agent_target",
      answer: "yes",
    });
  });

  it.each([
    ["no target", { question: "q" }],
    ["no question", { target_agent_id: "agent_target" }],
    ["a blank target", { target_agent_id: "", question: "q" }],
    ["a blank question", { target_agent_id: "agent_target", question: "" }],
  ])("refuses a call with %s without spawning", async (_label, input) => {
    const { services, mesh } = meshServices();
    const result = await teamTool("ask", services).handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "target_agent_id and question required",
    });
    expect(mesh.sendAsk).not.toHaveBeenCalled();
  });

  it("projects a CodedMeshError's code and meta rather than its message alone", async () => {
    const { services, mesh } = meshServices();
    vi.mocked(mesh.sendAsk).mockRejectedValue(
      new MeshCapacityError("at cap", { agentId: "agent_target", running: 3, cap: 3 }),
    );
    const result = await teamTool("ask", services).handler({
      target_agent_id: "agent_target",
      question: "q",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "MESH_CAPACITY_EXCEEDED",
      agentId: "agent_target",
      running: 3,
      cap: 3,
      message: "at cap",
    });
  });

  it("degrades an uncoded throw to the catch-all envelope", async () => {
    const { services, mesh } = meshServices();
    vi.mocked(mesh.sendAsk).mockRejectedValue(new Error("target offline"));
    const result = await teamTool("ask", services).handler({
      target_agent_id: "agent_target",
      question: "q",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "target offline" });
  });
});

describe("respond_ask", () => {
  it("stamps the responder's own agent id on the response", async () => {
    const { services, mesh } = meshServices();
    const result = await teamTool("respond_ask", services).handler({
      request_id: "req_1",
      answer: "yes, feasible",
    });

    expect(mesh.respondAsk).toHaveBeenCalledWith("req_1", {
      request_id: "req_1",
      from_agent_id: "agent_x",
      answer: "yes, feasible",
    });
    expect(result.content).toEqual({ responded: true, request_id: "req_1" });
  });

  it("is available to ICs with the same behavior", async () => {
    const { services, mesh } = meshServices();
    const icTool = buildIcMeshTools(fakeCtx, services).find(
      (t) => t.name === "respond_ask",
    )!;
    await icTool.handler({ request_id: "req_1", answer: "a" });
    expect(mesh.respondAsk).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no request_id", { answer: "a" }],
    ["no answer", { request_id: "req_1" }],
  ])("refuses a call with %s", async (_label, input) => {
    const { services, mesh } = meshServices();
    const result = await teamTool("respond_ask", services).handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "request_id and answer required",
    });
    expect(mesh.respondAsk).not.toHaveBeenCalled();
  });

  it("envelopes a throw from the unblock", async () => {
    const { services, mesh } = meshServices();
    vi.mocked(mesh.respondAsk).mockImplementation(() => {
      throw new Error("no waiter for req_1");
    });
    const result = await teamTool("respond_ask", services).handler({
      request_id: "req_1",
      answer: "a",
    });
    expect(result.content).toEqual({ error: "no waiter for req_1" });
  });
});

describe("negotiate", () => {
  it("forwards the peer, proposal, optional task id and initiator session", async () => {
    const { services, mesh } = meshServices();
    await teamTool("negotiate", services).handler({
      peer_id: "agent_peer",
      proposal: "split the migration",
      task_id: "tsk_1",
    });

    expect(mesh.sendNegotiate).toHaveBeenCalledWith(
      "agent_x",
      "agent_peer",
      "split the migration",
      { taskId: "tsk_1", initiatorSessionId: "ses_x" },
    );
  });

  it.each([
    ["omitted", {}],
    ["blank", { task_id: "" }],
    ["a non-string", { task_id: 7 }],
  ])("sends taskId undefined when task_id is %s", async (_label, extra) => {
    const { services, mesh } = meshServices();
    await teamTool("negotiate", services).handler({
      peer_id: "agent_peer",
      proposal: "p",
      ...extra,
    });

    expect(vi.mocked(mesh.sendNegotiate).mock.calls[0]![3]).toEqual({
      taskId: undefined,
      initiatorSessionId: "ses_x",
    });
  });

  it("projects a counter round for the initiator", async () => {
    const { services } = meshServices();
    const result = await teamTool("negotiate", services).handler({
      peer_id: "agent_peer",
      proposal: "p",
    });

    expect(result.content).toEqual({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "counter",
      message: "how about this",
      counter_proposal: "ship behind a flag",
    });
  });

  // The escalated sentinel is a different shape, not a decision value —
  // the projection has to branch on it or the escalation_id is dropped.
  it("projects the escalated sentinel instead of a negotiation round", async () => {
    const { services, mesh } = meshServices();
    vi.mocked(mesh.sendNegotiate).mockResolvedValue({
      decision: "escalated",
      escalation_id: "esc_1",
      negotiation_id: "neg_1",
      message: "handed to humans",
    });
    const result = await teamTool("negotiate", services).handler({
      peer_id: "agent_peer",
      proposal: "p",
    });

    expect(result.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_1",
      negotiation_id: "neg_1",
      message: "handed to humans",
    });
  });

  it.each([
    ["no peer_id", { proposal: "p" }],
    ["no proposal", { peer_id: "agent_peer" }],
  ])("refuses a call with %s without spawning", async (_label, input) => {
    const { services, mesh } = meshServices();
    const result = await teamTool("negotiate", services).handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "peer_id and proposal required",
    });
    expect(mesh.sendNegotiate).not.toHaveBeenCalled();
  });
});

describe("respond_negotiate", () => {
  it("forwards the round with the responder's id and their session", async () => {
    const { services, mesh } = meshServices();
    await teamTool("respond_negotiate", services).handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "not quite",
      counter_proposal: "two phases instead",
    });

    expect(mesh.respondNegotiate).toHaveBeenCalledWith(
      "neg_1",
      {
        negotiation_id: "neg_1",
        from_agent_id: "agent_x",
        decision: "counter",
        message: "not quite",
        counter_proposal: "two phases instead",
      },
      "ses_x",
    );
  });

  // A null return means accept/reject settled it; the caller needs
  // `terminal` to know it should exit rather than keep waiting.
  it.each(["accept", "reject"] as const)(
    "reports a %s round as terminal",
    async (decision) => {
      const { services } = meshServices();
      const result = await teamTool("respond_negotiate", services).handler({
        negotiation_id: "neg_1",
        decision,
        message: "done",
      });

      expect(result.isError).toBeFalsy();
      expect(result.content).toEqual({
        negotiation_id: "neg_1",
        decision,
        terminal: true,
      });
    },
  );

  it("projects the peer's next round when the negotiation continues", async () => {
    const { services, mesh } = meshServices();
    vi.mocked(mesh.respondNegotiate).mockResolvedValue({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "counter",
      message: "still no",
      counter_proposal: "three phases",
    });
    const result = await teamTool("respond_negotiate", services).handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "c",
    });

    expect(result.content).toMatchObject({
      from_agent_id: "agent_peer",
      counter_proposal: "three phases",
    });
  });

  it("projects the escalated sentinel when the peer escalated mid-round", async () => {
    const { services, mesh } = meshServices();
    vi.mocked(mesh.respondNegotiate).mockResolvedValue({
      decision: "escalated",
      escalation_id: "esc_1",
      negotiation_id: "neg_1",
      message: "peer escalated",
    });
    const result = await teamTool("respond_negotiate", services).handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "c",
    });

    expect(result.content).toMatchObject({
      decision: "escalated",
      escalation_id: "esc_1",
    });
  });

  it.each([
    ["no negotiation_id", { decision: "accept", message: "m" }],
    ["no message", { negotiation_id: "neg_1", decision: "accept" }],
  ])("refuses a call with %s", async (_label, input) => {
    const { services, mesh } = meshServices();
    const result = await teamTool("respond_negotiate", services).handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "negotiation_id and message required",
    });
    expect(mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it.each([
    ["omitted", undefined],
    ["unknown", "escalate"],
  ])("refuses a %s decision and lists the valid ones", async (_label, decision) => {
    const { services, mesh } = meshServices();
    const result = await teamTool("respond_negotiate", services).handler({
      negotiation_id: "neg_1",
      message: "m",
      ...(decision === undefined ? {} : { decision }),
    });

    expect(result.isError).toBe(true);
    expect(String(result.content.error)).toContain("counter, accept, reject");
    expect(mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  // Countering without an alternative would leave the peer nothing to
  // respond to, so it's rejected before the round is recorded.
  it("refuses decision='counter' with no counter_proposal", async () => {
    const { services, mesh } = meshServices();
    const result = await teamTool("respond_negotiate", services).handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "counter_proposal required when decision='counter'",
    });
    expect(mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("envelopes a coded max-rounds failure with its meta", async () => {
    const { services, mesh } = meshServices();
    vi.mocked(mesh.respondNegotiate).mockRejectedValue(
      new MeshCapacityError("at cap", { agentId: "agent_peer", running: 2, cap: 2 }),
    );
    const result = await teamTool("respond_negotiate", services).handler({
      negotiation_id: "neg_1",
      decision: "accept",
      message: "m",
    });

    expect(result.content).toMatchObject({
      error: "MESH_CAPACITY_EXCEEDED",
      cap: 2,
    });
  });
});

describe("report_blocker", () => {
  it("marks the task blocked, then spawns the derived parent", async () => {
    const { services, mesh, agentRepo, taskService } = meshServices();
    const result = await teamTool("report_blocker", services).handler({
      task_id: "tsk_1",
      description: "the migration needs a prod credential I don't have",
    });

    expect(agentRepo.findParent).toHaveBeenCalledWith("agent_x");
    expect(taskService.markBlocked).toHaveBeenCalledWith(
      "tsk_1",
      "agent_x",
      "the migration needs a prod credential I don't have",
    );
    expect(mesh.reportBlocker).toHaveBeenCalledWith(
      "agent_parent",
      "agent_x",
      "tsk_1",
      "the migration needs a prod credential I don't have",
    );
    expect(result.content).toEqual({
      reported: true,
      parent_agent_id: "agent_parent",
      task_id: "tsk_1",
    });
  });

  it("marks blocked before spawning so the parent sees the blocked task", async () => {
    const order: string[] = [];
    const { services, mesh, taskService } = meshServices();
    vi.mocked(taskService.markBlocked).mockImplementation((async () => {
      order.push("markBlocked");
    }) as never);
    vi.mocked(mesh.reportBlocker).mockImplementation(() => {
      order.push("spawn");
    });

    await teamTool("report_blocker", services).handler({
      task_id: "tsk_1",
      description: "d",
    });
    expect(order).toEqual(["markBlocked", "spawn"]);
  });

  // A top-level agent has nobody to escalate to; blocking the task
  // anyway would strand it, so the guard runs before markBlocked.
  it("refuses with no_parent_to_block and leaves the task alone", async () => {
    const { services, mesh, agentRepo, taskService } = meshServices();
    vi.mocked(agentRepo.findParent).mockResolvedValue(undefined);
    const result = await teamTool("report_blocker", services).handler({
      task_id: "tsk_1",
      description: "d",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "no_parent_to_block" });
    expect(String(result.content.message)).toContain("escalate_to_humans");
    expect(taskService.markBlocked).not.toHaveBeenCalled();
    expect(mesh.reportBlocker).not.toHaveBeenCalled();
  });

  it.each([
    ["no task_id", { description: "d" }],
    ["no description", { task_id: "tsk_1" }],
  ])("refuses a call with %s before any lookup", async (_label, input) => {
    const { services, agentRepo } = meshServices();
    const result = await teamTool("report_blocker", services).handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "task_id and description required",
    });
    expect(agentRepo.findParent).not.toHaveBeenCalled();
  });

  it("envelopes a markBlocked failure instead of spawning the parent", async () => {
    const { services, mesh, taskService } = meshServices();
    vi.mocked(taskService.markBlocked).mockRejectedValue(
      new Error("task not found"),
    );
    const result = await teamTool("report_blocker", services).handler({
      task_id: "tsk_gone",
      description: "d",
    });

    expect(result.content).toEqual({ error: "task not found" });
    expect(mesh.reportBlocker).not.toHaveBeenCalled();
  });
});

describe("escalate_to_humans", () => {
  const INPUT = {
    negotiation_id: "neg_1",
    summary: "We're stuck on the rollout order.",
    proposals: [{ title: "Phase it", description: "two deploys" }],
    open_questions: ["is there a freeze window?"],
  };

  it("creates the escalation, unblocks the peer, then notifies", async () => {
    const { services, mesh, escalationService, pool } = meshServices();
    const result = await teamTool("escalate_to_humans", services).handler(INPUT);

    expect(escalationService.create).toHaveBeenCalledWith({
      negotiationId: "neg_1",
      callerAgentId: "agent_x",
      summary: INPUT.summary,
      proposals: INPUT.proposals,
      openQuestions: ["is there a freeze window?"],
    });
    expect(mesh.unblockOnEscalate).toHaveBeenCalledWith("neg_1", "esc_1");
    expect(vi.mocked(pool.query).mock.calls[0]![1]).toEqual(["esc_1"]);
    expect(String(vi.mocked(pool.query).mock.calls[0]![0])).toContain(
      "escalation_created",
    );
    expect(result.content).toEqual({
      escalation_id: "esc_1",
      status: "open",
      negotiation_id: "neg_1",
    });
  });

  it("unblocks the peer before the notify, so a notify failure still frees them", async () => {
    const { services, mesh, pool } = meshServices();
    vi.mocked(pool.query).mockRejectedValue(new Error("pool closed"));
    const result = await teamTool("escalate_to_humans", services).handler(INPUT);

    expect(mesh.unblockOnEscalate).toHaveBeenCalledWith("neg_1", "esc_1");
    expect(result.content).toEqual({ error: "pool closed" });
  });

  it.each([
    ["omitted", {}],
    ["a non-array", { proposals: "phase it", open_questions: "when?" }],
  ])("sends %s proposals/questions as undefined", async (_label, extra) => {
    const { services, escalationService } = meshServices();
    await teamTool("escalate_to_humans", services).handler({
      negotiation_id: "neg_1",
      summary: "s",
      ...extra,
    });

    expect(escalationService.create).toHaveBeenCalledWith(
      expect.objectContaining({ proposals: undefined, openQuestions: undefined }),
    );
  });

  it("drops non-string open questions but keeps the array", async () => {
    const { services, escalationService } = meshServices();
    await teamTool("escalate_to_humans", services).handler({
      negotiation_id: "neg_1",
      summary: "s",
      open_questions: ["real question", 42, null],
    });

    expect(escalationService.create).toHaveBeenCalledWith(
      expect.objectContaining({ openQuestions: ["real question"] }),
    );
  });

  it.each([
    ["no negotiation_id", { summary: "s" }],
    ["no summary", { negotiation_id: "neg_1" }],
  ])("refuses a call with %s", async (_label, input) => {
    const { services, escalationService } = meshServices();
    const result = await teamTool("escalate_to_humans", services).handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "negotiation_id and summary required",
    });
    expect(escalationService.create).not.toHaveBeenCalled();
  });

  it("envelopes a create failure without unblocking the peer", async () => {
    const { services, mesh, escalationService } = meshServices();
    vi.mocked(escalationService.create).mockRejectedValue(
      new Error("negotiation neg_1 already has an escalation"),
    );
    const result = await teamTool("escalate_to_humans", services).handler(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "negotiation neg_1 already has an escalation",
    });
    expect(mesh.unblockOnEscalate).not.toHaveBeenCalled();
  });
});
