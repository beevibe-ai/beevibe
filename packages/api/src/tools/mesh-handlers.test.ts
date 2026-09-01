/**
 * Mesh tool *handler* behavior — the half `mesh.test.ts` leaves out.
 *
 * That file locks the per-tier tool inventory; the handlers themselves
 * were only exercised by the m6/m7 e2e scripts (live Postgres + spawned
 * CLIs), so none of the argument validation, response projection, or
 * error enveloping ran in CI. Every branch here is a distinct wire shape
 * an agent branches on, and all of it is reachable with a fake
 * MeshServer — the tools are thin adapters by design.
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentRepository } from "@beevibe/core";
import type { TaskService } from "@beevibe/core/services/task-service";
import type { EscalationService } from "@beevibe/core/services/escalation-service";
import type { Pool } from "@beevibe/core/adapters/postgres";
import {
  CannotNegotiateWithIcError,
  MeshCapacityError,
  MeshMaxRoundsError,
} from "../mesh/types.js";
import type { MeshServer } from "../mesh/server.js";
import {
  buildIcMeshTools,
  buildTeamMeshTools,
  type MeshToolContext,
  type MeshToolServices,
} from "./mesh.js";
import type { AgentTool } from "./types.js";

const CALLER = "agent_caller";
const SID = "sess_caller";

interface Harness {
  services: MeshToolServices;
  mesh: {
    sendAsk: ReturnType<typeof vi.fn>;
    respondAsk: ReturnType<typeof vi.fn>;
    sendNegotiate: ReturnType<typeof vi.fn>;
    respondNegotiate: ReturnType<typeof vi.fn>;
    reportBlocker: ReturnType<typeof vi.fn>;
    unblockOnEscalate: ReturnType<typeof vi.fn>;
  };
  agentRepo: AgentRepository;
  taskService: TaskService;
  escalationService: EscalationService;
  pool: Pool;
  tool: (name: string) => AgentTool;
}

function harness(): Harness {
  const mesh = {
    sendAsk: vi.fn(),
    respondAsk: vi.fn(),
    sendNegotiate: vi.fn(),
    respondNegotiate: vi.fn(),
    reportBlocker: vi.fn(),
    unblockOnEscalate: vi.fn(),
  };
  const agentRepo = { findParent: vi.fn() } as unknown as AgentRepository;
  const taskService = { markBlocked: vi.fn() } as unknown as TaskService;
  const escalationService = { create: vi.fn() } as unknown as EscalationService;
  const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Pool;

  const services = {
    mesh: mesh as unknown as MeshServer,
    agentRepo,
    taskRepo: {} as MeshToolServices["taskRepo"],
    taskService,
    escalationService,
    pool,
  } satisfies MeshToolServices;

  const ctx: MeshToolContext = {
    caller: { source: "agent", agentId: CALLER, hierarchyLevel: "team" },
    beevibeSid: SID,
  };
  const tools = buildTeamMeshTools(ctx, services);

  return {
    services,
    mesh,
    agentRepo,
    taskService,
    escalationService,
    pool,
    tool: (name) => {
      const t = tools.find((x) => x.name === name);
      if (!t) throw new Error(`no such tool: ${name}`);
      return t;
    },
  };
}

// ── ask ──────────────────────────────────────────────────────────────────

describe("ask", () => {
  it("projects only request_id / from_agent_id / answer back to the caller", async () => {
    const h = harness();
    h.mesh.sendAsk.mockResolvedValue({
      request_id: "req_1",
      from_agent_id: "agent_target",
      answer: "yes, feasible",
      // Server-side extras must not leak into the agent-visible payload.
      internal_session_id: "sess_secret",
    });

    const res = await h.tool("ask").handler({
      target_agent_id: "agent_target",
      question: "is X feasible?",
    });

    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({
      request_id: "req_1",
      from_agent_id: "agent_target",
      answer: "yes, feasible",
    });
  });

  it("mints a fresh request id per call and passes the caller as sender", async () => {
    const h = harness();
    h.mesh.sendAsk.mockResolvedValue({ request_id: "x", from_agent_id: "y", answer: "z" });

    await h.tool("ask").handler({ target_agent_id: "agent_t", question: "q1" });
    await h.tool("ask").handler({ target_agent_id: "agent_t", question: "q2" });

    const [first, second] = h.mesh.sendAsk.mock.calls;
    expect(first?.[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(first?.[0]).not.toBe(second?.[0]);
    expect(first?.slice(1)).toEqual([CALLER, "agent_t", "q1"]);
  });

  it.each([
    ["target_agent_id", { question: "q" }],
    ["question", { target_agent_id: "agent_t" }],
    ["both", {}],
  ])("rejects a call missing %s without touching the mesh", async (_label, input) => {
    const h = harness();
    const res = await h.tool("ask").handler(input);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("target_agent_id and question required");
    expect(h.mesh.sendAsk).not.toHaveBeenCalled();
  });

  it("projects a coded mesh error with its code and meta intact", async () => {
    const h = harness();
    h.mesh.sendAsk.mockRejectedValue(
      new MeshCapacityError("target at capacity", {
        agentId: "agent_target",
        running: 3,
        cap: 3,
      }),
    );

    const res = await h.tool("ask").handler({
      target_agent_id: "agent_target",
      question: "q",
    });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "MESH_CAPACITY_EXCEEDED",
      agentId: "agent_target",
      running: 3,
      cap: 3,
      message: "target at capacity",
    });
  });

  it("degrades an uncoded throw to the catch-all envelope", async () => {
    const h = harness();
    h.mesh.sendAsk.mockRejectedValue(new Error("ask timed out"));
    const res = await h.tool("ask").handler({ target_agent_id: "a", question: "q" });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: "ask timed out" });
  });
});

// ── respond_ask ──────────────────────────────────────────────────────────

describe("respond_ask", () => {
  it("stamps the responder's own agent id on the response", async () => {
    const h = harness();
    const res = await h.tool("respond_ask").handler({
      request_id: "req_1",
      answer: "42",
      // A responder cannot forge who the answer came from.
      from_agent_id: "agent_someone_else",
    });

    expect(res.content).toEqual({ responded: true, request_id: "req_1" });
    expect(h.mesh.respondAsk).toHaveBeenCalledWith("req_1", {
      request_id: "req_1",
      from_agent_id: CALLER,
      answer: "42",
    });
  });

  it.each([
    ["request_id", { answer: "a" }],
    ["answer", { request_id: "req_1" }],
  ])("rejects a call missing %s", async (_label, input) => {
    const h = harness();
    const res = await h.tool("respond_ask").handler(input);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("request_id and answer required");
    expect(h.mesh.respondAsk).not.toHaveBeenCalled();
  });

  it("envelopes a throw from the mesh (e.g. nobody waiting on that id)", async () => {
    const h = harness();
    h.mesh.respondAsk.mockImplementation(() => {
      throw new Error("no resolver for req_gone");
    });
    const res = await h.tool("respond_ask").handler({
      request_id: "req_gone",
      answer: "a",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: "no resolver for req_gone" });
  });

  it("is available to IC agents too", () => {
    const ic = buildIcMeshTools(
      {
        caller: { source: "agent", agentId: CALLER, hierarchyLevel: "ic" },
        beevibeSid: SID,
      },
      harness().services,
    );
    expect(ic.map((t) => t.name)).toContain("respond_ask");
  });
});

// ── negotiate ────────────────────────────────────────────────────────────

describe("negotiate", () => {
  it("forwards the proposal with the caller's session id as originator", async () => {
    const h = harness();
    h.mesh.sendNegotiate.mockResolvedValue({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "counter",
      message: "how about this",
      counter_proposal: "do it next sprint",
    });

    const res = await h.tool("negotiate").handler({
      peer_id: "agent_peer",
      proposal: "ship friday",
      task_id: "tsk_1",
    });

    expect(h.mesh.sendNegotiate).toHaveBeenCalledWith(CALLER, "agent_peer", "ship friday", {
      taskId: "tsk_1",
      initiatorSessionId: SID,
    });
    expect(res.content).toEqual({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "counter",
      message: "how about this",
      counter_proposal: "do it next sprint",
    });
  });

  it("treats an empty task_id as absent", async () => {
    const h = harness();
    h.mesh.sendNegotiate.mockResolvedValue({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "accept",
      message: "ok",
    });

    await h.tool("negotiate").handler({ peer_id: "p", proposal: "x", task_id: "" });
    expect(h.mesh.sendNegotiate).toHaveBeenCalledWith(
      CALLER,
      "p",
      "x",
      expect.objectContaining({ taskId: undefined }),
    );
  });

  it.each([
    ["peer_id", { proposal: "p" }],
    ["proposal", { peer_id: "agent_peer" }],
  ])("rejects a call missing %s", async (_label, input) => {
    const h = harness();
    const res = await h.tool("negotiate").handler(input);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("peer_id and proposal required");
    expect(h.mesh.sendNegotiate).not.toHaveBeenCalled();
  });

  it("projects the escalated sentinel through its own shape", async () => {
    const h = harness();
    h.mesh.sendNegotiate.mockResolvedValue({
      decision: "escalated",
      escalation_id: "esc_1",
      negotiation_id: "neg_1",
      message: "peer escalated to humans",
    });

    const res = await h.tool("negotiate").handler({ peer_id: "p", proposal: "x" });
    expect(res.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_1",
      negotiation_id: "neg_1",
      message: "peer escalated to humans",
    });
    // No from_agent_id / counter_proposal keys on the sentinel branch.
    expect(res.content).not.toHaveProperty("from_agent_id");
  });

  it("surfaces the IC-target guardrail as its coded error", async () => {
    const h = harness();
    h.mesh.sendNegotiate.mockRejectedValue(
      new CannotNegotiateWithIcError({ agentId: "agent_ic" }),
    );

    const res = await h.tool("negotiate").handler({ peer_id: "agent_ic", proposal: "x" });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("CANNOT_NEGOTIATE_WITH_IC");
    expect(res.content.agentId).toBe("agent_ic");
  });
});

// ── respond_negotiate ────────────────────────────────────────────────────

describe("respond_negotiate", () => {
  it("returns the terminal shape when the server reports no continuation", async () => {
    const h = harness();
    h.mesh.respondNegotiate.mockResolvedValue(null);

    const res = await h.tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "accept",
      message: "deal",
    });

    expect(res.content).toEqual({
      negotiation_id: "neg_1",
      decision: "accept",
      terminal: true,
    });
    expect(h.mesh.respondNegotiate).toHaveBeenCalledWith(
      "neg_1",
      {
        negotiation_id: "neg_1",
        from_agent_id: CALLER,
        decision: "accept",
        message: "deal",
        counter_proposal: undefined,
      },
      SID,
    );
  });

  it("returns the peer's next round when the negotiation continues", async () => {
    const h = harness();
    h.mesh.respondNegotiate.mockResolvedValue({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "counter",
      message: "not quite",
      counter_proposal: "wednesday",
    });

    const res = await h.tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "tuesday?",
      counter_proposal: "tuesday",
    });

    expect(res.content).toMatchObject({
      from_agent_id: "agent_peer",
      decision: "counter",
      counter_proposal: "wednesday",
    });
  });

  it.each([
    ["negotiation_id", { decision: "accept", message: "m" }],
    ["message", { negotiation_id: "neg_1", decision: "accept" }],
  ])("rejects a call missing %s", async (_label, input) => {
    const h = harness();
    const res = await h.tool("respond_negotiate").handler(input);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("negotiation_id and message required");
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("rejects an out-of-enum decision", async () => {
    const h = harness();
    const res = await h.tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "maybe",
      message: "m",
    });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("decision must be one of: counter, accept, reject");
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("requires counter_proposal when countering", async () => {
    const h = harness();
    const res = await h.tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "not this",
    });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("counter_proposal required when decision='counter'");
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("surfaces MAX_ROUNDS_EXCEEDED with the round counters the agent needs", async () => {
    const h = harness();
    h.mesh.respondNegotiate.mockRejectedValue(
      new MeshMaxRoundsError({
        negotiationId: "neg_1",
        rounds_completed: 5,
        max_rounds: 5,
      }),
    );

    const res = await h.tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "again",
      counter_proposal: "again",
    });

    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({
      error: "MAX_ROUNDS_EXCEEDED",
      negotiationId: "neg_1",
      rounds_completed: 5,
      max_rounds: 5,
    });
    expect(String(res.content.message)).toContain("escalate_to_humans");
  });
});

// ── report_blocker ───────────────────────────────────────────────────────

describe("report_blocker", () => {
  it("marks the task blocked, then spawns the parent fire-and-forget", async () => {
    const h = harness();
    vi.mocked(h.agentRepo.findParent).mockResolvedValue({ id: "agent_parent" } as never);

    const res = await h.tool("report_blocker").handler({
      task_id: "tsk_1",
      description: "the API key is missing",
    });

    expect(res.content).toEqual({
      reported: true,
      parent_agent_id: "agent_parent",
      task_id: "tsk_1",
    });
    expect(h.taskService.markBlocked).toHaveBeenCalledWith(
      "tsk_1",
      CALLER,
      "the API key is missing",
    );
    expect(h.mesh.reportBlocker).toHaveBeenCalledWith(
      "agent_parent",
      CALLER,
      "tsk_1",
      "the API key is missing",
    );
  });

  it("refuses for a top-level agent and names the alternatives", async () => {
    const h = harness();
    vi.mocked(h.agentRepo.findParent).mockResolvedValue(undefined);

    const res = await h.tool("report_blocker").handler({
      task_id: "tsk_1",
      description: "stuck",
    });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("no_parent_to_block");
    expect(String(res.content.message)).toContain("escalate_to_humans");
    // Nothing was mutated on the way out.
    expect(h.taskService.markBlocked).not.toHaveBeenCalled();
    expect(h.mesh.reportBlocker).not.toHaveBeenCalled();
  });

  it.each([
    ["task_id", { description: "d" }],
    ["description", { task_id: "tsk_1" }],
  ])("rejects a call missing %s before looking up the parent", async (_label, input) => {
    const h = harness();
    const res = await h.tool("report_blocker").handler(input);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("task_id and description required");
    expect(h.agentRepo.findParent).not.toHaveBeenCalled();
  });

  it("does not spawn the parent when marking the task blocked fails", async () => {
    const h = harness();
    vi.mocked(h.agentRepo.findParent).mockResolvedValue({ id: "agent_parent" } as never);
    vi.mocked(h.taskService.markBlocked).mockRejectedValue(new Error("task not found"));

    const res = await h.tool("report_blocker").handler({
      task_id: "tsk_gone",
      description: "stuck",
    });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: "task not found" });
    expect(h.mesh.reportBlocker).not.toHaveBeenCalled();
  });
});

// ── escalate_to_humans ───────────────────────────────────────────────────

describe("escalate_to_humans", () => {
  const ESCALATION = {
    id: "esc_1",
    status: "open",
    negotiation_id: "neg_1",
  };

  it("creates the escalation, unblocks the peer, then notifies listeners", async () => {
    const h = harness();
    vi.mocked(h.escalationService.create).mockResolvedValue(ESCALATION as never);

    const res = await h.tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "we disagree on the deadline",
      proposals: [{ title: "Ship friday", description: "cut scope" }],
      open_questions: ["is the demo date fixed?", 7],
    });

    expect(res.content).toEqual({
      escalation_id: "esc_1",
      status: "open",
      negotiation_id: "neg_1",
    });
    expect(h.escalationService.create).toHaveBeenCalledWith({
      negotiationId: "neg_1",
      callerAgentId: CALLER,
      summary: "we disagree on the deadline",
      proposals: [{ title: "Ship friday", description: "cut scope" }],
      // Non-string open questions are dropped, not passed through.
      openQuestions: ["is the demo date fixed?"],
    });
    expect(h.mesh.unblockOnEscalate).toHaveBeenCalledWith("neg_1", "esc_1");
    expect(h.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("pg_notify('escalation_created'"),
      ["esc_1"],
    );
  });

  it("passes undefined for proposals / open_questions when they aren't arrays", async () => {
    const h = harness();
    vi.mocked(h.escalationService.create).mockResolvedValue(ESCALATION as never);

    await h.tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "s",
      proposals: "not an array",
    });

    expect(h.escalationService.create).toHaveBeenCalledWith(
      expect.objectContaining({ proposals: undefined, openQuestions: undefined }),
    );
  });

  it.each([
    ["negotiation_id", { summary: "s" }],
    ["summary", { negotiation_id: "neg_1" }],
  ])("rejects a call missing %s", async (_label, input) => {
    const h = harness();
    const res = await h.tool("escalate_to_humans").handler(input);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("negotiation_id and summary required");
    expect(h.escalationService.create).not.toHaveBeenCalled();
  });

  it("does not unblock the peer when the escalation itself fails to create", async () => {
    const h = harness();
    vi.mocked(h.escalationService.create).mockRejectedValue(
      new Error("negotiation already escalated"),
    );

    const res = await h.tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "s",
    });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: "negotiation already escalated" });
    expect(h.mesh.unblockOnEscalate).not.toHaveBeenCalled();
    expect(h.pool.query).not.toHaveBeenCalled();
  });

  it("reports the failure when the pg_notify write throws", async () => {
    const h = harness();
    vi.mocked(h.escalationService.create).mockResolvedValue(ESCALATION as never);
    vi.mocked(h.pool.query).mockRejectedValue(new Error("connection terminated"));

    const res = await h.tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "s",
    });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: "connection terminated" });
    // The peer was still unblocked — that happens before the notify.
    expect(h.mesh.unblockOnEscalate).toHaveBeenCalled();
  });
});
