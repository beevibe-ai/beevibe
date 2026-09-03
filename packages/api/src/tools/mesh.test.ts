/**
 * Mesh tool tests — tier gating plus per-handler adapter behavior.
 *
 * The end-to-end mesh flows (real spawns, real blocking round-trips) are
 * covered by the m6/m7 e2e scripts, which need live Postgres and spawned
 * CLI subprocesses. What those scripts can't reach is the adapter layer
 * in this module: the argument validation each handler does before it
 * calls MeshServer, the projection of the server's reply down to the
 * fields the agent sees, and the coded-error envelope. Those are unit
 * tested here against a fake MeshServer, alongside the static tier
 * inventory that future skill-loader work relies on.
 */
import { describe, expect, it, vi } from "vitest";
import type { Agent, AgentRepository, TaskRepository } from "@beevibe/core";
import type { ResolvedCaller } from "@beevibe/core/auth";
import type { Pool } from "@beevibe/core/adapters/postgres";
import type { EscalationService } from "@beevibe/core/services/escalation-service";
import type { TaskService } from "@beevibe/core/services/task-service";
import { buildIcMeshTools, buildTeamMeshTools, type MeshToolServices } from "./mesh.js";
import {
  CannotNegotiateWithIcError,
  MeshCapacityError,
  MeshMaxRoundsError,
} from "../mesh/types.js";
import type { MeshServer } from "../mesh/server.js";

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

// ── Handler-level tests ──────────────────────────────────────────────────

interface MeshHarness {
  services: MeshToolServices;
  mesh: {
    sendAsk: ReturnType<typeof vi.fn>;
    respondAsk: ReturnType<typeof vi.fn>;
    sendNegotiate: ReturnType<typeof vi.fn>;
    respondNegotiate: ReturnType<typeof vi.fn>;
    unblockOnEscalate: ReturnType<typeof vi.fn>;
    reportBlocker: ReturnType<typeof vi.fn>;
  };
  findParent: ReturnType<typeof vi.fn>;
  markBlocked: ReturnType<typeof vi.fn>;
  createEscalation: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
}

const PARENT: Agent = {
  id: "agent_parent",
  name: "Parent",
  owner_id: "user_1",
  hierarchy_level: "team",
  runtime_config: {} as Agent["runtime_config"],
  created_at: new Date("2025-01-01T00:00:00Z"),
  updated_at: new Date("2025-01-01T00:00:00Z"),
};

function meshHarness(): MeshHarness {
  const mesh = {
    sendAsk: vi.fn(async (requestId: string, _from: string, to: string) => ({
      request_id: requestId,
      from_agent_id: to,
      answer: "yes, feasible",
    })),
    respondAsk: vi.fn(),
    sendNegotiate: vi.fn(async () => ({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "counter",
      message: "how about this instead",
      counter_proposal: "ship behind a flag",
    })),
    respondNegotiate: vi.fn(async () => null),
    unblockOnEscalate: vi.fn(),
    reportBlocker: vi.fn(),
  };
  const findParent = vi.fn(async () => PARENT as Agent | undefined);
  const markBlocked = vi.fn(async () => undefined);
  const createEscalation = vi.fn(async () => ({
    id: "esc_1",
    status: "open",
    negotiation_id: "neg_1",
  }));
  const query = vi.fn(async () => ({ rows: [] }));

  const services = {
    mesh: mesh as unknown as MeshServer,
    agentRepo: { findParent } as unknown as AgentRepository,
    taskRepo: {} as unknown as TaskRepository,
    taskService: { markBlocked } as unknown as TaskService,
    escalationService: { create: createEscalation } as unknown as EscalationService,
    pool: { query } as unknown as Pool,
  } satisfies MeshToolServices;

  return { services, mesh, findParent, markBlocked, createEscalation, query };
}

function toolNamed(h: MeshHarness, name: string) {
  const tool = buildTeamMeshTools(fakeCtx, h.services).find((t) => t.name === name);
  if (!tool) throw new Error(`no mesh tool named ${name}`);
  return tool;
}

describe("ask", () => {
  it("mints a request id and projects only the three agent-visible fields", async () => {
    const h = meshHarness();
    const result = await toolNamed(h, "ask").handler({
      target_agent_id: "agent_peer",
      question: "is X feasible?",
    });

    const [requestId, from, to, question] = h.mesh.sendAsk.mock.calls[0]!;
    expect(requestId).toEqual(expect.any(String));
    expect([from, to, question]).toEqual(["agent_x", "agent_peer", "is X feasible?"]);
    expect(result.isError).toBeFalsy();
    // The server's reply may carry more; the agent sees exactly these.
    expect(result.content).toEqual({
      request_id: requestId,
      from_agent_id: "agent_peer",
      answer: "yes, feasible",
    });
  });

  it("mints a fresh request id per call", async () => {
    const h = meshHarness();
    const tool = toolNamed(h, "ask");
    await tool.handler({ target_agent_id: "agent_peer", question: "q1" });
    await tool.handler({ target_agent_id: "agent_peer", question: "q2" });

    expect(h.mesh.sendAsk.mock.calls[0]![0]).not.toBe(
      h.mesh.sendAsk.mock.calls[1]![0],
    );
  });

  it.each([
    ["target_agent_id", { question: "q" }],
    ["question", { target_agent_id: "agent_peer" }],
    ["both", {}],
  ])("rejects a call missing %s without spawning the target", async (_l, input) => {
    const h = meshHarness();
    const result = await toolNamed(h, "ask").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "target_agent_id and question required",
    });
    expect(h.mesh.sendAsk).not.toHaveBeenCalled();
  });

  it("projects a capacity refusal as its coded envelope", async () => {
    const h = meshHarness();
    h.mesh.sendAsk.mockRejectedValueOnce(
      new MeshCapacityError("at capacity", {
        agentId: "agent_peer",
        running: 3,
        cap: 3,
      }),
    );
    const result = await toolNamed(h, "ask").handler({
      target_agent_id: "agent_peer",
      question: "q",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "MESH_CAPACITY_EXCEEDED",
      agentId: "agent_peer",
      running: 3,
      cap: 3,
      message: "at capacity",
    });
  });

  it("degrades an uncoded throw to the catch-all envelope", async () => {
    const h = meshHarness();
    h.mesh.sendAsk.mockRejectedValueOnce(new Error("target never responded"));
    const result = await toolNamed(h, "ask").handler({
      target_agent_id: "agent_peer",
      question: "q",
    });

    expect(result.content).toEqual({ error: "target never responded" });
  });
});

describe("respond_ask", () => {
  it("unblocks the asker with the caller as from_agent_id", async () => {
    const h = meshHarness();
    const result = await toolNamed(h, "respond_ask").handler({
      request_id: "req_1",
      answer: "here you go",
    });

    expect(h.mesh.respondAsk).toHaveBeenCalledWith("req_1", {
      request_id: "req_1",
      from_agent_id: "agent_x",
      answer: "here you go",
    });
    expect(result.content).toEqual({ responded: true, request_id: "req_1" });
  });

  it.each([
    ["request_id", { answer: "a" }],
    ["answer", { request_id: "req_1" }],
  ])("rejects a call missing %s", async (_l, input) => {
    const h = meshHarness();
    const result = await toolNamed(h, "respond_ask").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "request_id and answer required",
    });
    expect(h.mesh.respondAsk).not.toHaveBeenCalled();
  });

  it("envelopes a synchronous throw from the server", async () => {
    const h = meshHarness();
    h.mesh.respondAsk.mockImplementationOnce(() => {
      throw new Error("no waiter for req_1");
    });
    const result = await toolNamed(h, "respond_ask").handler({
      request_id: "req_1",
      answer: "a",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "no waiter for req_1" });
  });
});

describe("negotiate", () => {
  it("stamps the task and the initiator's session on the negotiation", async () => {
    const h = meshHarness();
    const result = await toolNamed(h, "negotiate").handler({
      peer_id: "agent_peer",
      proposal: "let's ship monday",
      task_id: "task_7",
    });

    expect(h.mesh.sendNegotiate).toHaveBeenCalledWith(
      "agent_x",
      "agent_peer",
      "let's ship monday",
      { taskId: "task_7", initiatorSessionId: "ses_x" },
    );
    expect(result.content).toEqual({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "counter",
      message: "how about this instead",
      counter_proposal: "ship behind a flag",
    });
  });

  it.each([
    ["omitted", undefined],
    ["empty", ""],
    ["a non-string", 7],
  ])("sends no taskId when task_id is %s", async (_l, taskId) => {
    const h = meshHarness();
    await toolNamed(h, "negotiate").handler({
      peer_id: "agent_peer",
      proposal: "p",
      ...(taskId === undefined ? {} : { task_id: taskId }),
    });

    expect(h.mesh.sendNegotiate.mock.calls[0]![3]).toEqual({
      taskId: undefined,
      initiatorSessionId: "ses_x",
    });
  });

  it.each([
    ["peer_id", { proposal: "p" }],
    ["proposal", { peer_id: "agent_peer" }],
  ])("rejects a call missing %s", async (_l, input) => {
    const h = meshHarness();
    const result = await toolNamed(h, "negotiate").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "peer_id and proposal required" });
    expect(h.mesh.sendNegotiate).not.toHaveBeenCalled();
  });

  it("keeps the IC guardrail's code so the agent can branch to ask/create_task", async () => {
    const h = meshHarness();
    h.mesh.sendNegotiate.mockRejectedValueOnce(
      new CannotNegotiateWithIcError({ agentId: "agent_ic" }),
    );
    const result = await toolNamed(h, "negotiate").handler({
      peer_id: "agent_ic",
      proposal: "p",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "CANNOT_NEGOTIATE_WITH_IC",
      agentId: "agent_ic",
    });
  });

  it("projects the escalated sentinel, not the ordinary response shape", async () => {
    const h = meshHarness();
    h.mesh.sendNegotiate.mockResolvedValueOnce({
      decision: "escalated",
      escalation_id: "esc_9",
      negotiation_id: "neg_1",
      message: "peer escalated to humans",
    });
    const result = await toolNamed(h, "negotiate").handler({
      peer_id: "agent_peer",
      proposal: "p",
    });

    expect(result.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_9",
      negotiation_id: "neg_1",
      message: "peer escalated to humans",
    });
  });
});

describe("respond_negotiate", () => {
  it("reports terminal when the server has nothing more to send back", async () => {
    const h = meshHarness();
    const result = await toolNamed(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "accept",
      message: "agreed",
    });

    expect(h.mesh.respondNegotiate).toHaveBeenCalledWith(
      "neg_1",
      {
        negotiation_id: "neg_1",
        from_agent_id: "agent_x",
        decision: "accept",
        message: "agreed",
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

  it("projects the peer's reply when the exchange continues", async () => {
    const h = meshHarness();
    h.mesh.respondNegotiate.mockResolvedValueOnce({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "counter",
      message: "not quite",
      counter_proposal: "tuesday",
    });
    const result = await toolNamed(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "monday",
      counter_proposal: "monday am",
    });

    expect(result.content).toMatchObject({
      from_agent_id: "agent_peer",
      counter_proposal: "tuesday",
    });
  });

  it.each([
    ["negotiation_id", { decision: "accept", message: "m" }],
    ["message", { negotiation_id: "neg_1", decision: "accept" }],
  ])("rejects a call missing %s", async (_l, input) => {
    const h = meshHarness();
    const result = await toolNamed(h, "respond_negotiate").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "negotiation_id and message required",
    });
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("rejects a decision outside counter|accept|reject", async () => {
    const h = meshHarness();
    const result = await toolNamed(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "maybe",
      message: "m",
    });

    expect(result.isError).toBe(true);
    expect(String(result.content.error)).toContain("counter, accept, reject");
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("requires counter_proposal when countering", async () => {
    const h = meshHarness();
    const result = await toolNamed(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "counter_proposal required when decision='counter'",
    });
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("surfaces the max-rounds cap with its meta so the agent can escalate", async () => {
    const h = meshHarness();
    h.mesh.respondNegotiate.mockRejectedValueOnce(
      new MeshMaxRoundsError({
        negotiationId: "neg_1",
        rounds_completed: 5,
        max_rounds: 5,
      }),
    );
    const result = await toolNamed(h, "respond_negotiate").handler({
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
  });
});

describe("report_blocker", () => {
  it("marks the task blocked, then spawns the derived parent", async () => {
    const h = meshHarness();
    const result = await toolNamed(h, "report_blocker").handler({
      task_id: "task_7",
      description: "the API key is missing",
    });

    // The parent is derived server-side from the caller's hierarchy —
    // the agent never gets to name it.
    expect(h.findParent).toHaveBeenCalledWith("agent_x");
    expect(h.markBlocked).toHaveBeenCalledWith(
      "task_7",
      "agent_x",
      "the API key is missing",
    );
    expect(h.mesh.reportBlocker).toHaveBeenCalledWith(
      "agent_parent",
      "agent_x",
      "task_7",
      "the API key is missing",
    );
    expect(result.content).toEqual({
      reported: true,
      parent_agent_id: "agent_parent",
      task_id: "task_7",
    });
  });

  it("refuses for a top-level agent and leaves the task alone", async () => {
    const h = meshHarness();
    h.findParent.mockResolvedValueOnce(undefined);
    const result = await toolNamed(h, "report_blocker").handler({
      task_id: "task_7",
      description: "stuck",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "no_parent_to_block" });
    expect(h.markBlocked).not.toHaveBeenCalled();
    expect(h.mesh.reportBlocker).not.toHaveBeenCalled();
  });

  it.each([
    ["task_id", { description: "d" }],
    ["description", { task_id: "task_7" }],
  ])("rejects a call missing %s before any lookup", async (_l, input) => {
    const h = meshHarness();
    const result = await toolNamed(h, "report_blocker").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "task_id and description required" });
    expect(h.findParent).not.toHaveBeenCalled();
  });

  it("does not claim the blocker was reported when marking it blocked fails", async () => {
    const h = meshHarness();
    h.markBlocked.mockRejectedValueOnce(new Error("task task_7 not found"));
    const result = await toolNamed(h, "report_blocker").handler({
      task_id: "task_7",
      description: "stuck",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "task task_7 not found" });
    expect(h.mesh.reportBlocker).not.toHaveBeenCalled();
  });
});

describe("escalate_to_humans", () => {
  it("creates the escalation, unblocks the peer, then notifies subscribers", async () => {
    const h = meshHarness();
    const result = await toolNamed(h, "escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "We disagree on the rollout order.",
      proposals: [{ title: "A", description: "ship first" }],
      open_questions: ["when is the customer demo?", 42],
    });

    expect(h.createEscalation).toHaveBeenCalledWith({
      negotiationId: "neg_1",
      callerAgentId: "agent_x",
      summary: "We disagree on the rollout order.",
      proposals: [{ title: "A", description: "ship first" }],
      // Non-string open questions are filtered out.
      openQuestions: ["when is the customer demo?"],
    });
    expect(h.mesh.unblockOnEscalate).toHaveBeenCalledWith("neg_1", "esc_1");
    expect(h.query).toHaveBeenCalledWith(
      expect.stringContaining("escalation_created"),
      ["esc_1"],
    );
    expect(result.content).toEqual({
      escalation_id: "esc_1",
      status: "open",
      negotiation_id: "neg_1",
    });
  });

  it.each([
    ["proposals", "proposals"],
    ["open questions", "open_questions"],
  ])("omits %s when the arg is not an array", async (_l, key) => {
    const h = meshHarness();
    await toolNamed(h, "escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "s",
      [key]: "not an array",
    });

    const camel = key === "proposals" ? "proposals" : "openQuestions";
    expect(h.createEscalation.mock.calls[0]![0]).toMatchObject({
      [camel]: undefined,
    });
  });

  it.each([
    ["negotiation_id", { summary: "s" }],
    ["summary", { negotiation_id: "neg_1" }],
  ])("rejects a call missing %s", async (_l, input) => {
    const h = meshHarness();
    const result = await toolNamed(h, "escalate_to_humans").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "negotiation_id and summary required",
    });
    expect(h.createEscalation).not.toHaveBeenCalled();
  });

  it("does not unblock the peer when the escalation could not be created", async () => {
    const h = meshHarness();
    h.createEscalation.mockRejectedValueOnce(new Error("negotiation already resolved"));
    const result = await toolNamed(h, "escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "s",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "negotiation already resolved" });
    expect(h.mesh.unblockOnEscalate).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
  });
});
