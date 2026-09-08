/**
 * Mesh tools — tier gating plus per-handler behavior, with vitest fakes
 * (no DB, no spawned CLI).
 *
 * The tier inventory locks the exact tool *names* each tier gets, so
 * future skill-loader work can rely on the surface being stable. The
 * handler tests below cover what the m6/m7 e2e scripts can't cheaply
 * reach: the argument coercion each handler does before it touches the
 * MeshServer, the ordering the escalation path depends on (create →
 * sentinel-unblock → pg_notify), and the coded-error envelope agents
 * branch on — a MAX_ROUNDS_EXCEEDED that degrades to the generic shape
 * sends the agent back into a negotiation the server will refuse.
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentRepository, TaskRepository } from "@beevibe/core";
import type { ResolvedCaller } from "@beevibe/core/auth";
import type { Pool } from "@beevibe/core/adapters/postgres";
import type { EscalationService } from "@beevibe/core/services/escalation-service";
import type { TaskService } from "@beevibe/core/services/task-service";
import type { MeshServer } from "../mesh/server.js";
import {
  CannotNegotiateWithIcError,
  MeshCapacityError,
  MeshMaxRoundsError,
} from "../mesh/types.js";
import { buildIcMeshTools, buildTeamMeshTools, type MeshToolServices } from "./mesh.js";
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

// ── Handler fakes ────────────────────────────────────────────────────────

interface Overrides {
  mesh?: Partial<MeshServer>;
  agentRepo?: Partial<AgentRepository>;
  taskService?: Partial<TaskService>;
  escalationService?: Partial<EscalationService>;
  pool?: Partial<Pool>;
}

function buildServices(overrides: Overrides = {}) {
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
      decision: "counter" as const,
      message: "how about this",
      counter_proposal: "do it next sprint",
    })),
    respondNegotiate: vi.fn(async () => null),
    unblockOnEscalate: vi.fn(),
    reportBlocker: vi.fn(),
    ...overrides.mesh,
  } as unknown as MeshServer;

  const agentRepo = {
    findParent: vi.fn(async () => ({ id: "agent_parent" })),
    ...overrides.agentRepo,
  } as unknown as AgentRepository;

  const taskService = {
    markBlocked: vi.fn(async () => undefined),
    ...overrides.taskService,
  } as unknown as TaskService;

  const escalationService = {
    create: vi.fn(async () => ({
      id: "esc_1",
      status: "pending",
      negotiation_id: "neg_1",
    })),
    ...overrides.escalationService,
  } as unknown as EscalationService;

  const pool = {
    query: vi.fn(async () => ({ rows: [] })),
    ...overrides.pool,
  } as unknown as Pool;

  return {
    mesh,
    agentRepo,
    taskRepo: {} as unknown as TaskRepository,
    taskService,
    escalationService,
    pool,
  } satisfies MeshToolServices;
}

function build(overrides: Overrides = {}) {
  const services = buildServices(overrides);
  const tools = buildTeamMeshTools(fakeCtx, services);
  const tool = (name: string): AgentTool => {
    const found = tools.find((t) => t.name === name);
    if (!found) throw new Error(`no tool named ${name}`);
    return found;
  };
  return { services, tool };
}

// ── ask / respond_ask ────────────────────────────────────────────────────

describe("ask", () => {
  it("mints a request id, forwards the question and projects the answer", async () => {
    const { services, tool } = build();

    const result = await tool("ask").handler({
      target_agent_id: "agent_peer",
      question: "is X feasible?",
    });

    const [requestId, from, to, question] = vi.mocked(services.mesh.sendAsk).mock
      .calls[0]!;
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect([from, to, question]).toEqual(["agent_x", "agent_peer", "is X feasible?"]);
    expect(result.isError).toBeFalsy();
    // Only the three wire fields — no internal state leaks to the agent.
    expect(result.content).toEqual({
      request_id: requestId,
      from_agent_id: "agent_peer",
      answer: "yes, feasible",
    });
  });

  it.each([
    ["a missing target", { question: "q" }],
    ["a missing question", { target_agent_id: "agent_peer" }],
    ["an empty target", { target_agent_id: "", question: "q" }],
  ])("rejects %s without spawning the peer", async (_label, input) => {
    const { services, tool } = build();

    const result = await tool("ask").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "target_agent_id and question required",
    });
    expect(services.mesh.sendAsk).not.toHaveBeenCalled();
  });

  it("projects a MeshCapacityError with its code and meta", async () => {
    const { tool } = build({
      mesh: {
        sendAsk: vi.fn(async () => {
          throw new MeshCapacityError("at capacity", {
            agentId: "agent_peer",
            running: 3,
            cap: 3,
          });
        }),
      },
    });

    const result = await tool("ask").handler({
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
});

describe("respond_ask", () => {
  it("unblocks the asker with the caller as the responder", async () => {
    const { services, tool } = build();

    const result = await tool("respond_ask").handler({
      request_id: "req_1",
      answer: "yes",
    });

    expect(services.mesh.respondAsk).toHaveBeenCalledWith("req_1", {
      request_id: "req_1",
      from_agent_id: "agent_x",
      answer: "yes",
    });
    expect(result.content).toEqual({ responded: true, request_id: "req_1" });
  });

  it.each([
    ["a missing request_id", { answer: "yes" }],
    ["a missing answer", { request_id: "req_1" }],
  ])("rejects %s", async (_label, input) => {
    const { services, tool } = build();

    const result = await tool("respond_ask").handler(input);

    expect(result.isError).toBe(true);
    expect(services.mesh.respondAsk).not.toHaveBeenCalled();
  });

  it("wraps a throw from the server in the generic error envelope", async () => {
    const { tool } = build({
      mesh: {
        respondAsk: vi.fn(() => {
          throw new Error("no waiter for req_1");
        }),
      },
    });

    const result = await tool("respond_ask").handler({
      request_id: "req_1",
      answer: "yes",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "no waiter for req_1" });
  });
});

// ── negotiate / respond_negotiate ────────────────────────────────────────

describe("negotiate", () => {
  it("passes the optional task_id and the caller's session as originator metadata", async () => {
    const { services, tool } = build();

    const result = await tool("negotiate").handler({
      peer_id: "agent_peer",
      proposal: "ship friday",
      task_id: "task_1",
    });

    expect(services.mesh.sendNegotiate).toHaveBeenCalledWith(
      "agent_x",
      "agent_peer",
      "ship friday",
      { taskId: "task_1", initiatorSessionId: "ses_x" },
    );
    expect(result.content).toEqual({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "counter",
      message: "how about this",
      counter_proposal: "do it next sprint",
    });
  });

  it("omits an empty or non-string task_id rather than passing it through", async () => {
    const { services, tool } = build();

    await tool("negotiate").handler({ peer_id: "p", proposal: "x", task_id: "" });
    await tool("negotiate").handler({ peer_id: "p", proposal: "x", task_id: 7 });

    for (const call of vi.mocked(services.mesh.sendNegotiate).mock.calls) {
      expect(call[3]).toEqual({ taskId: undefined, initiatorSessionId: "ses_x" });
    }
  });

  it.each([
    ["a missing peer", { proposal: "x" }],
    ["a missing proposal", { peer_id: "agent_peer" }],
  ])("rejects %s without spawning the peer", async (_label, input) => {
    const { services, tool } = build();

    const result = await tool("negotiate").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "peer_id and proposal required" });
    expect(services.mesh.sendNegotiate).not.toHaveBeenCalled();
  });

  it("projects the escalated sentinel shape when the peer escalated first", async () => {
    const { tool } = build({
      mesh: {
        sendNegotiate: vi.fn(async () => ({
          decision: "escalated" as const,
          escalation_id: "esc_7",
          negotiation_id: "neg_1",
          message: "handed to humans",
        })),
      },
    });

    const result = await tool("negotiate").handler({ peer_id: "p", proposal: "x" });

    expect(result.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_7",
      negotiation_id: "neg_1",
      message: "handed to humans",
    });
  });

  it("projects CannotNegotiateWithIcError with its code", async () => {
    const { tool } = build({
      mesh: {
        sendNegotiate: vi.fn(async () => {
          throw new CannotNegotiateWithIcError({ agentId: "agent_ic" });
        }),
      },
    });

    const result = await tool("negotiate").handler({ peer_id: "agent_ic", proposal: "x" });

    expect(result.content).toMatchObject({
      error: "CANNOT_NEGOTIATE_WITH_IC",
      agentId: "agent_ic",
    });
  });
});

describe("respond_negotiate", () => {
  it("reports terminal when the server has nothing further to return", async () => {
    const { services, tool } = build();

    const result = await tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "accept",
      message: "agreed",
    });

    expect(services.mesh.respondNegotiate).toHaveBeenCalledWith(
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

  it("projects the peer's reply when the round continues", async () => {
    const { tool } = build({
      mesh: {
        respondNegotiate: vi.fn(async () => ({
          negotiation_id: "neg_1",
          from_agent_id: "agent_peer",
          decision: "counter" as const,
          message: "not yet",
          counter_proposal: "next sprint",
        })),
      },
    });

    const result = await tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "ship friday",
      counter_proposal: "or monday",
    });

    expect(result.content).toMatchObject({
      from_agent_id: "agent_peer",
      decision: "counter",
      counter_proposal: "next sprint",
    });
  });

  it.each([
    ["a missing negotiation_id", { decision: "accept", message: "ok" }],
    ["a missing message", { negotiation_id: "neg_1", decision: "accept" }],
  ])("rejects %s", async (_label, input) => {
    const { services, tool } = build();

    const result = await tool("respond_negotiate").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "negotiation_id and message required",
    });
    expect(services.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("rejects a decision outside counter/accept/reject", async () => {
    const { services, tool } = build();

    const result = await tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "maybe",
      message: "hmm",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "decision must be one of: counter, accept, reject",
    });
    expect(services.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("requires a counter_proposal when countering", async () => {
    const { services, tool } = build();

    const result = await tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "not this",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "counter_proposal required when decision='counter'",
    });
    expect(services.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("surfaces MAX_ROUNDS_EXCEEDED with the round counts so the agent escalates", async () => {
    const { tool } = build({
      mesh: {
        respondNegotiate: vi.fn(async () => {
          throw new MeshMaxRoundsError({
            negotiationId: "neg_1",
            rounds_completed: 5,
            max_rounds: 5,
          });
        }),
      },
    });

    const result = await tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "again",
      counter_proposal: "or this",
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
  it("marks the task blocked, then spawns the parent", async () => {
    const { services, tool } = build();
    const order: string[] = [];
    vi.mocked(services.taskService.markBlocked).mockImplementation(async () => {
      order.push("markBlocked");
      return undefined as never;
    });
    vi.mocked(services.mesh.reportBlocker).mockImplementation(() => {
      order.push("reportBlocker");
    });

    const result = await tool("report_blocker").handler({
      task_id: "task_1",
      description: "creds missing",
    });

    expect(services.agentRepo.findParent).toHaveBeenCalledWith("agent_x");
    expect(services.taskService.markBlocked).toHaveBeenCalledWith(
      "task_1",
      "agent_x",
      "creds missing",
    );
    expect(services.mesh.reportBlocker).toHaveBeenCalledWith(
      "agent_parent",
      "agent_x",
      "task_1",
      "creds missing",
    );
    // The task has to be blocked before the parent's session can read it.
    expect(order).toEqual(["markBlocked", "reportBlocker"]);
    expect(result.content).toEqual({
      reported: true,
      parent_agent_id: "agent_parent",
      task_id: "task_1",
    });
  });

  it.each([
    ["a missing task_id", { description: "creds missing" }],
    ["a missing description", { task_id: "task_1" }],
  ])("rejects %s before looking up the parent", async (_label, input) => {
    const { services, tool } = build();

    const result = await tool("report_blocker").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "task_id and description required" });
    expect(services.agentRepo.findParent).not.toHaveBeenCalled();
  });

  it("refuses for a top-level agent and leaves the task alone", async () => {
    const { services, tool } = build({
      agentRepo: { findParent: vi.fn(async () => undefined) },
    });

    const result = await tool("report_blocker").handler({
      task_id: "task_1",
      description: "creds missing",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "no_parent_to_block" });
    expect(services.taskService.markBlocked).not.toHaveBeenCalled();
    expect(services.mesh.reportBlocker).not.toHaveBeenCalled();
  });

  it("wraps a markBlocked failure rather than reporting success", async () => {
    const { services, tool } = build({
      taskService: {
        markBlocked: vi.fn(async () => {
          throw new Error("task task_1 not found");
        }),
      },
    });

    const result = await tool("report_blocker").handler({
      task_id: "task_1",
      description: "creds missing",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "task task_1 not found" });
    expect(services.mesh.reportBlocker).not.toHaveBeenCalled();
  });
});

// ── escalate_to_humans ───────────────────────────────────────────────────

describe("escalate_to_humans", () => {
  it("creates the escalation, unblocks the peer, then notifies listeners", async () => {
    const { services, tool } = build();
    const order: string[] = [];
    vi.mocked(services.escalationService.create).mockImplementation(async () => {
      order.push("create");
      return { id: "esc_1", status: "pending", negotiation_id: "neg_1" } as never;
    });
    vi.mocked(services.mesh.unblockOnEscalate).mockImplementation(() => {
      order.push("unblock");
    });
    vi.mocked(services.pool.query).mockImplementation((async () => {
      order.push("notify");
      return { rows: [] };
    }) as never);

    const result = await tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "stuck on X",
      proposals: [{ title: "A", description: "do A" }],
      open_questions: ["who owns X?", 7],
    });

    expect(services.escalationService.create).toHaveBeenCalledWith({
      negotiationId: "neg_1",
      callerAgentId: "agent_x",
      summary: "stuck on X",
      proposals: [{ title: "A", description: "do A" }],
      // Non-string questions are dropped, not forwarded.
      openQuestions: ["who owns X?"],
    });
    expect(services.mesh.unblockOnEscalate).toHaveBeenCalledWith("neg_1", "esc_1");
    expect(services.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("pg_notify('escalation_created'"),
      ["esc_1"],
    );
    expect(order).toEqual(["create", "unblock", "notify"]);
    expect(result.content).toEqual({
      escalation_id: "esc_1",
      status: "pending",
      negotiation_id: "neg_1",
    });
  });

  it("omits proposals and open_questions when they are not arrays", async () => {
    const { services, tool } = build();

    await tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "stuck",
      proposals: "A or B",
      open_questions: "who owns X?",
    });

    expect(services.escalationService.create).toHaveBeenCalledWith(
      expect.objectContaining({ proposals: undefined, openQuestions: undefined }),
    );
  });

  it.each([
    ["a missing negotiation_id", { summary: "stuck" }],
    ["a missing summary", { negotiation_id: "neg_1" }],
  ])("rejects %s without creating an escalation", async (_label, input) => {
    const { services, tool } = build();

    const result = await tool("escalate_to_humans").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "negotiation_id and summary required",
    });
    expect(services.escalationService.create).not.toHaveBeenCalled();
  });

  it("wraps a create failure and leaves the peer blocked for the server to time out", async () => {
    const { services, tool } = build({
      escalationService: {
        create: vi.fn(async () => {
          throw new Error("negotiation already escalated");
        }),
      },
    });

    const result = await tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "stuck",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "negotiation already escalated" });
    expect(services.mesh.unblockOnEscalate).not.toHaveBeenCalled();
    expect(services.pool.query).not.toHaveBeenCalled();
  });
});
