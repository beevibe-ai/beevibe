/**
 * Mesh tool tests — tier gating, plus the argument validation and
 * response projection each handler does around the MeshServer call.
 *
 * The mesh *protocol* (spawning the peer, blocking on their reply, round
 * accounting) needs live Postgres + spawned CLI subprocesses and stays in
 * the m6/m7 e2e scripts. What runs here is everything on this side of
 * that boundary: the tier inventory, the required-argument checks that
 * short-circuit before a session is ever spawned, the projection that
 * decides which server fields reach the agent, and the coded-error
 * envelope agents branch on.
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentRepository, TaskRepository } from "@beevibe/core";
import type { ResolvedCaller } from "@beevibe/core/auth";
import type { EscalationService } from "@beevibe/core/services/escalation-service";
import type { TaskService } from "@beevibe/core/services/task-service";
import type { Pool } from "@beevibe/core/adapters/postgres";
import type { MeshServer } from "../mesh/server.js";
import {
  CannotNegotiateWithIcError,
  MeshCapacityError,
  MeshMaxRoundsError,
} from "../mesh/types.js";
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

type Spy = ReturnType<typeof vi.fn>;

interface MeshHarness {
  services: MeshToolServices;
  // Spelled out rather than Record<string, …> so indexing stays
  // non-optional under noUncheckedIndexedAccess.
  mesh: {
    sendAsk: Spy;
    respondAsk: Spy;
    sendNegotiate: Spy;
    respondNegotiate: Spy;
    reportBlocker: Spy;
    unblockOnEscalate: Spy;
  };
  agentRepo: { findParent: ReturnType<typeof vi.fn> };
  taskService: { markBlocked: ReturnType<typeof vi.fn> };
  escalationService: { create: ReturnType<typeof vi.fn> };
  pool: { query: ReturnType<typeof vi.fn> };
}

function meshHarness(): MeshHarness {
  const mesh = {
    sendAsk: vi.fn(async () => ({
      request_id: "req_1",
      from_agent_id: "agent_b",
      answer: "yes, feasible",
      // Extra server-side fields the projection must drop.
      internal_session_id: "sess_leak",
    })),
    respondAsk: vi.fn(() => undefined),
    sendNegotiate: vi.fn(async () => ({
      negotiation_id: "neg_1",
      from_agent_id: "agent_b",
      decision: "counter",
      message: "how about half",
      counter_proposal: "split it",
      internal_round: 2,
    })),
    respondNegotiate: vi.fn(async () => null),
    reportBlocker: vi.fn(() => undefined),
    unblockOnEscalate: vi.fn(() => undefined),
  };

  const agentRepo = { findParent: vi.fn(async () => ({ id: "agent_parent" })) };
  const taskService = { markBlocked: vi.fn(async () => ({ id: "task_1" })) };
  const escalationService = {
    create: vi.fn(async () => ({
      id: "esc_1",
      status: "open",
      negotiation_id: "neg_1",
    })),
  };
  const pool = { query: vi.fn(async () => ({ rows: [] })) };

  return {
    services: {
      mesh: mesh as unknown as MeshServer,
      agentRepo: agentRepo as unknown as AgentRepository,
      taskRepo: {} as unknown as TaskRepository,
      taskService: taskService as unknown as TaskService,
      escalationService: escalationService as unknown as EscalationService,
      pool: pool as unknown as Pool,
    },
    mesh,
    agentRepo,
    taskService,
    escalationService,
    pool,
  };
}

function teamTool(h: MeshHarness, name: string): AgentTool {
  const tool = buildTeamMeshTools(fakeCtx, h.services).find((t) => t.name === name);
  if (!tool) throw new Error(`no such mesh tool: ${name}`);
  return tool;
}

// ── ask / respond_ask ────────────────────────────────────────────────────

describe("ask", () => {
  it("sends the question with a minted request id and projects the answer", async () => {
    const h = meshHarness();
    const result = await teamTool(h, "ask").handler({
      target_agent_id: "agent_b",
      question: "is X feasible?",
    });

    expect(h.mesh.sendAsk).toHaveBeenCalledTimes(1);
    const [requestId, from, to, question] = h.mesh.sendAsk.mock.calls[0]!;
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect([from, to, question]).toEqual(["agent_x", "agent_b", "is X feasible?"]);

    // Projection is a whitelist — server-internal fields must not leak.
    expect(result.content).toEqual({
      request_id: "req_1",
      from_agent_id: "agent_b",
      answer: "yes, feasible",
    });
  });

  it("mints a fresh request id per call", async () => {
    const h = meshHarness();
    const ask = teamTool(h, "ask");
    await ask.handler({ target_agent_id: "agent_b", question: "q1" });
    await ask.handler({ target_agent_id: "agent_b", question: "q2" });

    expect(h.mesh.sendAsk.mock.calls[0]![0]).not.toBe(
      h.mesh.sendAsk.mock.calls[1]![0],
    );
  });

  it.each([
    ["target_agent_id", { question: "q" }],
    ["question", { target_agent_id: "agent_b" }],
    ["both", {}],
  ])("refuses to spawn a session when %s is missing", async (_label, input) => {
    const h = meshHarness();
    const result = await teamTool(h, "ask").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "target_agent_id and question required" });
    expect(h.mesh.sendAsk).not.toHaveBeenCalled();
  });

  it("surfaces a capacity error with its code and meta", async () => {
    const h = meshHarness();
    h.mesh.sendAsk.mockRejectedValue(
      new MeshCapacityError("at cap", { agentId: "agent_b", running: 3, cap: 3 }),
    );

    const result = await teamTool(h, "ask").handler({
      target_agent_id: "agent_b",
      question: "q",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "MESH_CAPACITY_EXCEEDED",
      agentId: "agent_b",
      running: 3,
      cap: 3,
      message: "at cap",
    });
  });
});

describe("respond_ask", () => {
  it("stamps the responder's agent id onto the response", async () => {
    const h = meshHarness();
    const result = await teamTool(h, "respond_ask").handler({
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
  ])("rejects a call missing %s", async (_label, input) => {
    const h = meshHarness();
    const result = await teamTool(h, "respond_ask").handler(input);

    expect(result.isError).toBe(true);
    expect(h.mesh.respondAsk).not.toHaveBeenCalled();
  });

  it("envelopes a plain throw from the server", async () => {
    const h = meshHarness();
    h.mesh.respondAsk.mockImplementation(() => {
      throw new Error("no such pending ask");
    });

    const result = await teamTool(h, "respond_ask").handler({
      request_id: "req_gone",
      answer: "a",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "no such pending ask" });
  });
});

// ── negotiate / respond_negotiate ────────────────────────────────────────

describe("negotiate", () => {
  it("passes the caller's session id as initiator and projects the reply", async () => {
    const h = meshHarness();
    const result = await teamTool(h, "negotiate").handler({
      peer_id: "agent_b",
      proposal: "ship on friday",
      task_id: "task_1",
    });

    expect(h.mesh.sendNegotiate).toHaveBeenCalledWith(
      "agent_x",
      "agent_b",
      "ship on friday",
      { taskId: "task_1", initiatorSessionId: "ses_x" },
    );
    expect(result.content).toEqual({
      negotiation_id: "neg_1",
      from_agent_id: "agent_b",
      decision: "counter",
      message: "how about half",
      counter_proposal: "split it",
    });
  });

  it("omits task_id when absent or empty rather than passing a blank string", async () => {
    const h = meshHarness();
    const negotiate = teamTool(h, "negotiate");

    await negotiate.handler({ peer_id: "agent_b", proposal: "p" });
    expect(h.mesh.sendNegotiate.mock.calls[0]![3]).toEqual({
      taskId: undefined,
      initiatorSessionId: "ses_x",
    });

    await negotiate.handler({ peer_id: "agent_b", proposal: "p", task_id: "" });
    expect(h.mesh.sendNegotiate.mock.calls[1]![3]).toMatchObject({
      taskId: undefined,
    });
  });

  it.each([
    ["peer_id", { proposal: "p" }],
    ["proposal", { peer_id: "agent_b" }],
  ])("rejects a call missing %s", async (_label, input) => {
    const h = meshHarness();
    const result = await teamTool(h, "negotiate").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "peer_id and proposal required" });
    expect(h.mesh.sendNegotiate).not.toHaveBeenCalled();
  });

  it("projects the escalated sentinel through its own branch", async () => {
    const h = meshHarness();
    h.mesh.sendNegotiate.mockResolvedValue({
      decision: "escalated",
      escalation_id: "esc_1",
      negotiation_id: "neg_1",
      message: "handed to humans",
    });

    const result = await teamTool(h, "negotiate").handler({
      peer_id: "agent_b",
      proposal: "p",
    });

    expect(result.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_1",
      negotiation_id: "neg_1",
      message: "handed to humans",
    });
  });

  it("surfaces CANNOT_NEGOTIATE_WITH_IC so the agent can switch to ask()", async () => {
    const h = meshHarness();
    h.mesh.sendNegotiate.mockRejectedValue(
      new CannotNegotiateWithIcError({ agentId: "agent_ic" }),
    );

    const result = await teamTool(h, "negotiate").handler({
      peer_id: "agent_ic",
      proposal: "p",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "CANNOT_NEGOTIATE_WITH_IC",
      agentId: "agent_ic",
    });
  });
});

describe("respond_negotiate", () => {
  it("forwards the round and reports terminal when the server returns null", async () => {
    const h = meshHarness();
    const result = await teamTool(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "accept",
      message: "deal",
    });

    expect(h.mesh.respondNegotiate).toHaveBeenCalledWith(
      "neg_1",
      {
        negotiation_id: "neg_1",
        from_agent_id: "agent_x",
        decision: "accept",
        message: "deal",
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
    const h = meshHarness();
    h.mesh.respondNegotiate.mockResolvedValue({
      negotiation_id: "neg_1",
      from_agent_id: "agent_b",
      decision: "counter",
      message: "not quite",
      counter_proposal: "thursday",
    });

    const result = await teamTool(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "friday then",
      counter_proposal: "friday",
    });

    expect(result.content).toMatchObject({
      from_agent_id: "agent_b",
      decision: "counter",
      counter_proposal: "thursday",
    });
  });

  it("requires a counter_proposal when the decision is counter", async () => {
    const h = meshHarness();
    const result = await teamTool(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "not quite",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "counter_proposal required when decision='counter'",
    });
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it.each([
    ["negotiation_id", { decision: "accept", message: "m" }],
    ["message", { negotiation_id: "neg_1", decision: "accept" }],
  ])("rejects a call missing %s", async (_label, input) => {
    const h = meshHarness();
    const result = await teamTool(h, "respond_negotiate").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "negotiation_id and message required",
    });
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("rejects a decision outside counter/accept/reject", async () => {
    const h = meshHarness();
    const result = await teamTool(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "maybe",
      message: "m",
    });

    expect(result.isError).toBe(true);
    expect(String(result.content.error)).toContain("decision must be one of");
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("surfaces MAX_ROUNDS_EXCEEDED with its round accounting", async () => {
    const h = meshHarness();
    h.mesh.respondNegotiate.mockRejectedValue(
      new MeshMaxRoundsError({
        negotiationId: "neg_1",
        rounds_completed: 5,
        max_rounds: 5,
      }),
    );

    const result = await teamTool(h, "respond_negotiate").handler({
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

// ── report_blocker ───────────────────────────────────────────────────────

describe("report_blocker", () => {
  it("marks the task blocked, then wakes the parent with the same context", async () => {
    const h = meshHarness();
    const result = await teamTool(h, "report_blocker").handler({
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
    expect(result.content).toEqual({
      reported: true,
      parent_agent_id: "agent_parent",
      task_id: "task_1",
    });
  });

  it("refuses for a top-level agent and leaves the task unblocked", async () => {
    const h = meshHarness();
    h.agentRepo.findParent.mockResolvedValue(undefined);

    const result = await teamTool(h, "report_blocker").handler({
      task_id: "task_1",
      description: "stuck",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "no_parent_to_block" });
    expect(h.taskService.markBlocked).not.toHaveBeenCalled();
    expect(h.mesh.reportBlocker).not.toHaveBeenCalled();
  });

  it.each([
    ["task_id", { description: "d" }],
    ["description", { task_id: "task_1" }],
  ])("rejects a call missing %s before any lookup", async (_label, input) => {
    const h = meshHarness();
    const result = await teamTool(h, "report_blocker").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "task_id and description required" });
    expect(h.agentRepo.findParent).not.toHaveBeenCalled();
  });

  it("does not spawn the parent when markBlocked fails", async () => {
    const h = meshHarness();
    h.taskService.markBlocked.mockRejectedValue(new Error("task not found"));

    const result = await teamTool(h, "report_blocker").handler({
      task_id: "task_gone",
      description: "stuck",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "task not found" });
    expect(h.mesh.reportBlocker).not.toHaveBeenCalled();
  });

  it("is the same handler on the IC tier", async () => {
    const h = meshHarness();
    const icTool = buildIcMeshTools(fakeCtx, h.services).find(
      (t) => t.name === "report_blocker",
    )!;

    const result = await icTool.handler({ task_id: "task_1", description: "d" });

    expect(result.content).toMatchObject({ parent_agent_id: "agent_parent" });
  });
});

// ── escalate_to_humans ───────────────────────────────────────────────────

describe("escalate_to_humans", () => {
  it("creates the escalation, unblocks the peer, and notifies listeners", async () => {
    const h = meshHarness();
    const result = await teamTool(h, "escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "we disagree on the deadline",
      proposals: [{ title: "ship friday", description: "cut scope" }],
      open_questions: ["is friday a hard date?"],
    });

    expect(h.escalationService.create).toHaveBeenCalledWith({
      negotiationId: "neg_1",
      callerAgentId: "agent_x",
      summary: "we disagree on the deadline",
      proposals: [{ title: "ship friday", description: "cut scope" }],
      openQuestions: ["is friday a hard date?"],
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

  it("passes undefined rather than [] when proposals/open_questions are absent", async () => {
    const h = meshHarness();
    await teamTool(h, "escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "stuck",
    });

    expect(h.escalationService.create).toHaveBeenCalledWith(
      expect.objectContaining({ proposals: undefined, openQuestions: undefined }),
    );
  });

  it("drops non-string open_questions", async () => {
    const h = meshHarness();
    await teamTool(h, "escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "stuck",
      open_questions: ["real question", 42, null],
    });

    expect(h.escalationService.create).toHaveBeenCalledWith(
      expect.objectContaining({ openQuestions: ["real question"] }),
    );
  });

  it("ignores a non-array proposals value", async () => {
    const h = meshHarness();
    await teamTool(h, "escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "stuck",
      proposals: "just ship it",
    });

    expect(h.escalationService.create).toHaveBeenCalledWith(
      expect.objectContaining({ proposals: undefined }),
    );
  });

  it.each([
    ["negotiation_id", { summary: "s" }],
    ["summary", { negotiation_id: "neg_1" }],
  ])("rejects a call missing %s", async (_label, input) => {
    const h = meshHarness();
    const result = await teamTool(h, "escalate_to_humans").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "negotiation_id and summary required" });
    expect(h.escalationService.create).not.toHaveBeenCalled();
  });

  it("does not unblock the peer when the escalation insert fails", async () => {
    const h = meshHarness();
    h.escalationService.create.mockRejectedValue(
      new Error("negotiation neg_1 already has an escalation"),
    );

    const result = await teamTool(h, "escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "stuck",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "negotiation neg_1 already has an escalation",
    });
    expect(h.mesh.unblockOnEscalate).not.toHaveBeenCalled();
    expect(h.pool.query).not.toHaveBeenCalled();
  });
});
