/**
 * Mesh tool *handlers* — unit tests with vitest fakes.
 *
 * `mesh.test.ts` locks the per-tier tool inventory; this file covers
 * what each handler does when an agent calls it. The handlers were
 * previously exercised only by the m6/m7 e2e scripts, which need live
 * Postgres and real spawned CLI subprocesses — so in a normal test run
 * nothing checked the argument coercion, the required-field refusals,
 * or the response projections, all of which are pure functions over
 * injected services.
 *
 * The projections matter because they are the agent-facing wire
 * contract: `respond_negotiate` returning `terminal: true` versus a
 * peer's counter is how a negotiating agent decides whether to keep
 * talking or exit.
 */

import { describe, expect, it, vi } from "vitest";
import type { AgentRepository, TaskRepository } from "@beevibe/core";
import type { ResolvedCaller } from "@beevibe/core/auth";
import type { TaskService } from "@beevibe/core/services/task-service";
import type { EscalationService } from "@beevibe/core/services/escalation-service";
import type { Pool } from "@beevibe/core/adapters/postgres";
import { MeshCapacityError, MeshMaxRoundsError } from "../mesh/types.js";
import type { MeshServer } from "../mesh/server.js";
import {
  buildIcMeshTools,
  buildTeamMeshTools,
  type MeshToolContext,
  type MeshToolServices,
} from "./mesh.js";
import type { AgentTool } from "./types.js";

const CALLER: ResolvedCaller = {
  agentId: "agent_caller",
  source: "agent",
  hierarchyLevel: "team",
};
const CTX: MeshToolContext = { caller: CALLER, beevibeSid: "sess_caller0001" };

interface Harness {
  tools: Map<string, AgentTool>;
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
  pool: { query: ReturnType<typeof vi.fn> };
}

function harness(): Harness {
  const mesh = {
    sendAsk: vi.fn(async () => ({
      request_id: "req_1",
      from_agent_id: "agent_peer",
      answer: "yes, feasible",
    })),
    respondAsk: vi.fn(() => undefined),
    sendNegotiate: vi.fn(async () => ({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "counter" as const,
      message: "how about this",
      counter_proposal: "do it in two phases",
    })),
    respondNegotiate: vi.fn(async () => null),
    reportBlocker: vi.fn(() => undefined),
    unblockOnEscalate: vi.fn(() => undefined),
  };
  const agentRepo = {
    findParent: vi.fn(async () => ({ id: "agent_parent" })),
  };
  const taskService = { markBlocked: vi.fn(async () => undefined) };
  const escalationService = {
    create: vi.fn(async () => ({
      id: "esc_1",
      status: "open",
      negotiation_id: "neg_1",
    })),
  };
  const pool = { query: vi.fn(async () => ({ rows: [] })) };

  const services = {
    mesh: mesh as unknown as MeshServer,
    agentRepo: agentRepo as unknown as AgentRepository,
    taskRepo: {} as TaskRepository,
    taskService: taskService as unknown as TaskService,
    escalationService: escalationService as unknown as EscalationService,
    pool: pool as unknown as Pool,
  } satisfies MeshToolServices;

  const tools = new Map(
    buildTeamMeshTools(CTX, services).map((t) => [t.name, t]),
  );
  return { tools, mesh, agentRepo, taskService, escalationService, pool };
}

function tool(h: Harness, name: string): AgentTool {
  return h.tools.get(name)!;
}

describe("ask", () => {
  it("forwards the caller, target and question with a minted request id", async () => {
    const h = harness();
    const result = await tool(h, "ask").handler({
      target_agent_id: "agent_peer",
      question: "is X feasible?",
    });

    expect(h.mesh.sendAsk).toHaveBeenCalledTimes(1);
    const [requestId, from, target, question] = h.mesh.sendAsk.mock.calls[0]!;
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(from).toBe("agent_caller");
    expect(target).toBe("agent_peer");
    expect(question).toBe("is X feasible?");
    expect(result.isError).toBeFalsy();
  });

  it("mints a fresh request id per call", async () => {
    const h = harness();
    await tool(h, "ask").handler({ target_agent_id: "p", question: "q" });
    await tool(h, "ask").handler({ target_agent_id: "p", question: "q" });

    expect(h.mesh.sendAsk.mock.calls[0]![0]).not.toBe(
      h.mesh.sendAsk.mock.calls[1]![0],
    );
  });

  it("projects only the three wire fields of the answer", async () => {
    const h = harness();
    h.mesh.sendAsk.mockResolvedValueOnce({
      request_id: "req_9",
      from_agent_id: "agent_peer",
      answer: "no",
      // Anything else the server happens to carry stays server-side.
      internal_note: "leak me",
    });

    const result = await tool(h, "ask").handler({
      target_agent_id: "agent_peer",
      question: "q",
    });

    expect(result.content).toEqual({
      request_id: "req_9",
      from_agent_id: "agent_peer",
      answer: "no",
    });
  });

  it.each([
    ["target_agent_id", { question: "q" }],
    ["question", { target_agent_id: "agent_peer" }],
    ["both", {}],
  ])("refuses when %s is missing", async (_label, input) => {
    const h = harness();
    const result = await tool(h, "ask").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "target_agent_id and question required",
    });
    expect(h.mesh.sendAsk).not.toHaveBeenCalled();
  });

  it("projects a capacity error with its code and meta", async () => {
    const h = harness();
    h.mesh.sendAsk.mockRejectedValueOnce(
      new MeshCapacityError("peer is at capacity", {
        agentId: "agent_peer",
        running: 5,
        cap: 5,
      }),
    );

    const result = await tool(h, "ask").handler({
      target_agent_id: "agent_peer",
      question: "q",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "MESH_CAPACITY_EXCEEDED",
      agentId: "agent_peer",
      running: 5,
      cap: 5,
      message: "peer is at capacity",
    });
  });

  it("degrades an uncoded throw to the catch-all envelope", async () => {
    const h = harness();
    h.mesh.sendAsk.mockRejectedValueOnce(new Error("transport dropped"));

    const result = await tool(h, "ask").handler({
      target_agent_id: "agent_peer",
      question: "q",
    });

    expect(result.content).toEqual({ error: "transport dropped" });
  });
});

describe("respond_ask", () => {
  it("resolves the asker's pending request with the caller as responder", async () => {
    const h = harness();
    const result = await tool(h, "respond_ask").handler({
      request_id: "req_1",
      answer: "here you go",
    });

    expect(h.mesh.respondAsk).toHaveBeenCalledWith("req_1", {
      request_id: "req_1",
      from_agent_id: "agent_caller",
      answer: "here you go",
    });
    expect(result.content).toEqual({ responded: true, request_id: "req_1" });
  });

  it.each([
    ["request_id", { answer: "a" }],
    ["answer", { request_id: "req_1" }],
  ])("refuses when %s is missing", async (_label, input) => {
    const h = harness();
    const result = await tool(h, "respond_ask").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "request_id and answer required" });
    expect(h.mesh.respondAsk).not.toHaveBeenCalled();
  });

  it("envelopes a throw from the resolver", async () => {
    const h = harness();
    h.mesh.respondAsk.mockImplementationOnce(() => {
      throw new Error("no resolver waiting");
    });

    const result = await tool(h, "respond_ask").handler({
      request_id: "req_1",
      answer: "a",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "no resolver waiting" });
  });

  it("is available to IC agents", () => {
    const names = buildIcMeshTools(CTX, {} as MeshToolServices).map((t) => t.name);
    expect(names).toContain("respond_ask");
  });
});

describe("negotiate", () => {
  it("opens round one with the caller's session as the initiator", async () => {
    const h = harness();
    await tool(h, "negotiate").handler({
      peer_id: "agent_peer",
      proposal: "split the work",
      task_id: "task_1",
    });

    expect(h.mesh.sendNegotiate).toHaveBeenCalledWith(
      "agent_caller",
      "agent_peer",
      "split the work",
      { taskId: "task_1", initiatorSessionId: "sess_caller0001" },
    );
  });

  it.each([
    ["absent", undefined],
    ["an empty string", ""],
    ["a non-string", 7],
  ])("omits a task_id that is %s", async (_label, taskId) => {
    const h = harness();
    await tool(h, "negotiate").handler({
      peer_id: "agent_peer",
      proposal: "p",
      task_id: taskId,
    });

    expect(h.mesh.sendNegotiate.mock.calls[0]![3].taskId).toBeUndefined();
  });

  it("projects the peer's counter, counter_proposal included", async () => {
    const h = harness();
    const result = await tool(h, "negotiate").handler({
      peer_id: "agent_peer",
      proposal: "p",
    });

    expect(result.content).toEqual({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "counter",
      message: "how about this",
      counter_proposal: "do it in two phases",
    });
  });

  it("projects the escalated sentinel into its own shape", async () => {
    const h = harness();
    h.mesh.sendNegotiate.mockResolvedValueOnce({
      decision: "escalated",
      message: "handed to humans",
      escalation_id: "esc_7",
      negotiation_id: "neg_1",
    });

    const result = await tool(h, "negotiate").handler({
      peer_id: "agent_peer",
      proposal: "p",
    });

    // No from_agent_id / counter_proposal on this branch — the peer isn't
    // the author of an escalation sentinel.
    expect(result.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_7",
      negotiation_id: "neg_1",
      message: "handed to humans",
    });
  });

  it.each([
    ["peer_id", { proposal: "p" }],
    ["proposal", { peer_id: "agent_peer" }],
  ])("refuses when %s is missing", async (_label, input) => {
    const h = harness();
    const result = await tool(h, "negotiate").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "peer_id and proposal required" });
    expect(h.mesh.sendNegotiate).not.toHaveBeenCalled();
  });
});

describe("respond_negotiate", () => {
  it("reports terminal when the server has nothing further to return", async () => {
    const h = harness();
    const result = await tool(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "accept",
      message: "deal",
    });

    expect(h.mesh.respondNegotiate).toHaveBeenCalledWith(
      "neg_1",
      {
        negotiation_id: "neg_1",
        from_agent_id: "agent_caller",
        decision: "accept",
        message: "deal",
        counter_proposal: undefined,
      },
      "sess_caller0001",
    );
    expect(result.content).toEqual({
      negotiation_id: "neg_1",
      decision: "accept",
      terminal: true,
    });
  });

  it("projects the peer's reply when the negotiation continues", async () => {
    const h = harness();
    h.mesh.respondNegotiate.mockResolvedValueOnce({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "counter",
      message: "not quite",
      counter_proposal: "try this",
    });

    const result = await tool(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "my turn",
      counter_proposal: "mine",
    });

    expect(result.content).toMatchObject({
      from_agent_id: "agent_peer",
      decision: "counter",
      counter_proposal: "try this",
    });
  });

  it("projects an escalated sentinel arriving mid-negotiation", async () => {
    const h = harness();
    h.mesh.respondNegotiate.mockResolvedValueOnce({
      decision: "escalated",
      message: "peer escalated",
      escalation_id: "esc_3",
      negotiation_id: "neg_1",
    });

    const result = await tool(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "c",
    });

    expect(result.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_3",
      negotiation_id: "neg_1",
      message: "peer escalated",
    });
  });

  it.each([
    ["negotiation_id", { decision: "accept", message: "m" }],
    ["message", { negotiation_id: "neg_1", decision: "accept" }],
  ])("refuses when %s is missing", async (_label, input) => {
    const h = harness();
    const result = await tool(h, "respond_negotiate").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "negotiation_id and message required",
    });
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it.each([["approve"], [""], [undefined]])(
    "refuses the unknown decision %s",
    async (decision) => {
      const h = harness();
      const result = await tool(h, "respond_negotiate").handler({
        negotiation_id: "neg_1",
        decision,
        message: "m",
      });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual({
        error: "decision must be one of: counter, accept, reject",
      });
      expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
    },
  );

  it("refuses a counter with no counter_proposal", async () => {
    const h = harness();
    const result = await tool(h, "respond_negotiate").handler({
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

  it("allows accept and reject without a counter_proposal", async () => {
    const h = harness();
    for (const decision of ["accept", "reject"]) {
      const result = await tool(h, "respond_negotiate").handler({
        negotiation_id: "neg_1",
        decision,
        message: "m",
      });
      expect(result.isError).toBeFalsy();
    }
    expect(h.mesh.respondNegotiate).toHaveBeenCalledTimes(2);
  });

  it("surfaces the max-rounds error with its structured meta", async () => {
    const h = harness();
    h.mesh.respondNegotiate.mockRejectedValueOnce(
      new MeshMaxRoundsError({
        negotiationId: "neg_1",
        rounds_completed: 5,
        max_rounds: 5,
      }),
    );

    const result = await tool(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "c",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "MAX_ROUNDS_EXCEEDED",
      negotiationId: "neg_1",
      rounds_completed: 5,
      max_rounds: 5,
    });
    // The message is what tells the agent to escalate instead of retrying.
    expect(result.content.message).toContain("escalate_to_humans");
  });
});

describe("report_blocker", () => {
  it("marks the task blocked and spawns the direct parent", async () => {
    const h = harness();
    const result = await tool(h, "report_blocker").handler({
      task_id: "task_1",
      description: "the API key is missing",
    });

    expect(h.agentRepo.findParent).toHaveBeenCalledWith("agent_caller");
    expect(h.taskService.markBlocked).toHaveBeenCalledWith(
      "task_1",
      "agent_caller",
      "the API key is missing",
    );
    expect(h.mesh.reportBlocker).toHaveBeenCalledWith(
      "agent_parent",
      "agent_caller",
      "task_1",
      "the API key is missing",
    );
    expect(result.content).toEqual({
      reported: true,
      parent_agent_id: "agent_parent",
      task_id: "task_1",
    });
  });

  it("refuses for a top-level agent with no parent", async () => {
    const h = harness();
    h.agentRepo.findParent.mockResolvedValueOnce(undefined);

    const result = await tool(h, "report_blocker").handler({
      task_id: "task_1",
      description: "stuck",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "no_parent_to_block" });
    // Nothing is mutated on the refusal path.
    expect(h.taskService.markBlocked).not.toHaveBeenCalled();
    expect(h.mesh.reportBlocker).not.toHaveBeenCalled();
  });

  it.each([
    ["task_id", { description: "d" }],
    ["description", { task_id: "task_1" }],
  ])("refuses when %s is missing", async (_label, input) => {
    const h = harness();
    const result = await tool(h, "report_blocker").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "task_id and description required" });
    expect(h.agentRepo.findParent).not.toHaveBeenCalled();
  });

  it("does not spawn the parent when marking the task blocked fails", async () => {
    const h = harness();
    h.taskService.markBlocked.mockRejectedValueOnce(new Error("task not found"));

    const result = await tool(h, "report_blocker").handler({
      task_id: "task_1",
      description: "stuck",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "task not found" });
    expect(h.mesh.reportBlocker).not.toHaveBeenCalled();
  });
});

describe("escalate_to_humans", () => {
  const INPUT = {
    negotiation_id: "neg_1",
    summary: "we disagree on the rollout order",
  };

  it("creates the escalation, unblocks the peer, then notifies", async () => {
    const h = harness();
    const result = await tool(h, "escalate_to_humans").handler(INPUT);

    expect(h.escalationService.create).toHaveBeenCalledWith({
      negotiationId: "neg_1",
      callerAgentId: "agent_caller",
      summary: "we disagree on the rollout order",
      proposals: undefined,
      openQuestions: undefined,
    });
    expect(h.mesh.unblockOnEscalate).toHaveBeenCalledWith("neg_1", "esc_1");
    expect(h.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("pg_notify('escalation_created'"),
      ["esc_1"],
    );
    expect(result.content).toEqual({
      escalation_id: "esc_1",
      status: "open",
      negotiation_id: "neg_1",
    });
  });

  it("passes proposals and open questions through", async () => {
    const h = harness();
    await tool(h, "escalate_to_humans").handler({
      ...INPUT,
      proposals: [{ title: "A", description: "do A" }],
      open_questions: ["who owns the rollout?"],
    });

    expect(h.escalationService.create.mock.calls[0]![0]).toMatchObject({
      proposals: [{ title: "A", description: "do A" }],
      openQuestions: ["who owns the rollout?"],
    });
  });

  it("drops non-string entries from open_questions", async () => {
    const h = harness();
    await tool(h, "escalate_to_humans").handler({
      ...INPUT,
      open_questions: ["real question", 42, null],
    });

    expect(h.escalationService.create.mock.calls[0]![0].openQuestions).toEqual([
      "real question",
    ]);
  });

  it.each([
    ["proposals", "not an array"],
    ["open_questions", { a: 1 }],
  ])("ignores a non-array %s", async (field, value) => {
    const h = harness();
    await tool(h, "escalate_to_humans").handler({ ...INPUT, [field]: value });

    const arg = h.escalationService.create.mock.calls[0]![0];
    expect(arg.proposals).toBeUndefined();
    expect(arg.openQuestions).toBeUndefined();
  });

  it.each([
    ["negotiation_id", { summary: "s" }],
    ["summary", { negotiation_id: "neg_1" }],
  ])("refuses when %s is missing", async (_label, input) => {
    const h = harness();
    const result = await tool(h, "escalate_to_humans").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "negotiation_id and summary required",
    });
    expect(h.escalationService.create).not.toHaveBeenCalled();
  });

  it("does not unblock the peer when creating the escalation fails", async () => {
    const h = harness();
    h.escalationService.create.mockRejectedValueOnce(
      new Error("negotiation already escalated"),
    );

    const result = await tool(h, "escalate_to_humans").handler(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "negotiation already escalated" });
    expect(h.mesh.unblockOnEscalate).not.toHaveBeenCalled();
    expect(h.pool.query).not.toHaveBeenCalled();
  });

  it("envelopes a pg_notify failure rather than throwing out of the tool", async () => {
    const h = harness();
    h.pool.query.mockRejectedValueOnce(new Error("connection terminated"));

    const result = await tool(h, "escalate_to_humans").handler(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "connection terminated" });
  });
});
