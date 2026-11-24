/**
 * Mesh tool tests — tier gating (assembly) plus per-handler behavior.
 *
 * The handlers are closures over (ctx, services) and every collaborator
 * they touch is an injected port, so the argument marshalling, the
 * validation branches and the response projection all unit-test against
 * fakes. Only the *blocking* half of the mesh — a real spawned CLI on the
 * other end of `sendAsk` / `sendNegotiate` — needs the m6/m7 e2e scripts;
 * what those scripts cannot pin cheaply is the error surface, which is
 * where agents actually branch.
 */
import { describe, expect, it, vi } from "vitest";
import type { Agent, AgentRepository, TaskRepository } from "@beevibe/core";
import type { ResolvedCaller } from "@beevibe/core/auth";
import type { TaskService } from "@beevibe/core/services/task-service";
import type { EscalationService } from "@beevibe/core/services/escalation-service";
import type { Pool } from "@beevibe/core/adapters/postgres";
import {
  CannotNegotiateWithIcError,
  MeshCapacityError,
  MeshMaxRoundsError,
} from "../mesh/types.js";
import type { MeshServer } from "../mesh/server.js";
import { buildIcMeshTools, buildTeamMeshTools, type MeshToolServices } from "./mesh.js";
import type { AgentTool, AgentToolResult } from "./types.js";

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

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent_parent",
    name: "Parent",
    owner_id: "person_1",
    hierarchy_level: "team",
    runtime_config: { type: "claude" },
    created_at: new Date("2026-04-01"),
    updated_at: new Date("2026-04-01"),
    ...overrides,
  } as Agent;
}

function buildServices(
  overrides: {
    mesh?: Partial<MeshServer>;
    agentRepo?: Partial<AgentRepository>;
    taskService?: Partial<TaskService>;
    escalationService?: Partial<EscalationService>;
  } = {},
) {
  const mesh = {
    sendAsk: vi.fn(async (requestId: string, _from: string, to: string) => ({
      request_id: requestId,
      from_agent_id: to,
      answer: "42",
    })),
    respondAsk: vi.fn(() => {}),
    sendNegotiate: vi.fn(async (_from: string, to: string) => ({
      negotiation_id: "neg_1",
      from_agent_id: to,
      decision: "accept" as const,
      message: "deal",
    })),
    respondNegotiate: vi.fn(async () => null),
    unblockOnEscalate: vi.fn(() => {}),
    reportBlocker: vi.fn(() => {}),
    ...overrides.mesh,
  } as unknown as MeshServer;

  const agentRepo = {
    findById: vi.fn(async () => undefined),
    findParent: vi.fn(async () => fakeAgent()),
    ...overrides.agentRepo,
  } as unknown as AgentRepository;

  const taskRepo = {
    findById: vi.fn(async () => undefined),
  } as unknown as TaskRepository;

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
  } as unknown as Pool;

  return { mesh, agentRepo, taskRepo, taskService, escalationService, pool };
}

function findTool(tools: AgentTool[], name: string): AgentTool {
  const t = tools.find((t) => t.name === name);
  if (!t) throw new Error(`tool ${name} missing from set`);
  return t;
}

/** Build the team set over `services` and invoke one handler. */
async function call(
  services: ReturnType<typeof buildServices>,
  name: string,
  input: Record<string, unknown> = {},
  ctx = fakeCtx,
): Promise<AgentToolResult> {
  const tools = buildTeamMeshTools(ctx, services as unknown as MeshToolServices);
  return findTool(tools, name).handler(input);
}

// ── ask ──────────────────────────────────────────────────────────────────

describe("ask handler", () => {
  it("mints a request id, forwards caller + target, and projects the answer", async () => {
    const services = buildServices();
    const result = await call(services, "ask", {
      target_agent_id: "agent_peer",
      question: "is X feasible?",
    });

    expect(result.isError).toBeFalsy();
    expect(services.mesh.sendAsk).toHaveBeenCalledTimes(1);
    const [requestId, from, to, question] = vi.mocked(services.mesh.sendAsk).mock.calls[0]!;
    // The tool owns id generation — the agent never supplies one.
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(from).toBe("agent_x");
    expect(to).toBe("agent_peer");
    expect(question).toBe("is X feasible?");

    // Projection is a whitelist: only these three fields reach the agent.
    expect(Object.keys(result.content).sort()).toEqual([
      "answer",
      "from_agent_id",
      "request_id",
    ]);
  });

  it.each([
    ["missing target", { question: "q" }],
    ["missing question", { target_agent_id: "agent_peer" }],
    ["empty target", { target_agent_id: "", question: "q" }],
    ["empty question", { target_agent_id: "agent_peer", question: "" }],
  ])("rejects %s without spawning the target", async (_label, input) => {
    const services = buildServices();
    const result = await call(services, "ask", input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "target_agent_id and question required" });
    expect(services.mesh.sendAsk).not.toHaveBeenCalled();
  });

  it("projects a coded mesh error's code and meta, not just its message", async () => {
    const services = buildServices({
      mesh: {
        sendAsk: vi.fn(async () => {
          throw new MeshCapacityError("too many running", {
            agentId: "agent_peer",
            running: 3,
            cap: 3,
          });
        }),
      },
    });

    const result = await call(services, "ask", {
      target_agent_id: "agent_peer",
      question: "q",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "MESH_CAPACITY_EXCEEDED",
      agentId: "agent_peer",
      running: 3,
      cap: 3,
      message: "too many running",
    });
  });

  it("degrades an uncoded throw to the catch-all envelope", async () => {
    const services = buildServices({
      mesh: {
        sendAsk: vi.fn(async () => {
          throw new Error("socket hung up");
        }),
      },
    });

    const result = await call(services, "ask", {
      target_agent_id: "agent_peer",
      question: "q",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "socket hung up" });
  });
});

// ── respond_ask ──────────────────────────────────────────────────────────

describe("respond_ask handler", () => {
  it("stamps the responder's own agent id on the reply", async () => {
    const services = buildServices();
    const result = await call(services, "respond_ask", {
      request_id: "req_1",
      answer: "yes, behind a flag",
    });

    expect(result.isError).toBeFalsy();
    // from_agent_id comes from the caller context, never from input —
    // otherwise an agent could answer in someone else's name.
    expect(services.mesh.respondAsk).toHaveBeenCalledWith("req_1", {
      request_id: "req_1",
      from_agent_id: "agent_x",
      answer: "yes, behind a flag",
    });
    expect(result.content).toEqual({ responded: true, request_id: "req_1" });
  });

  it("ignores a spoofed from_agent_id in the input", async () => {
    const services = buildServices();
    await call(services, "respond_ask", {
      request_id: "req_1",
      answer: "a",
      from_agent_id: "agent_victim",
    });

    expect(vi.mocked(services.mesh.respondAsk).mock.calls[0]![1]).toMatchObject({
      from_agent_id: "agent_x",
    });
  });

  it.each([
    ["missing request_id", { answer: "a" }],
    ["missing answer", { request_id: "req_1" }],
  ])("rejects %s without resolving the asker", async (_label, input) => {
    const services = buildServices();
    const result = await call(services, "respond_ask", input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "request_id and answer required" });
    expect(services.mesh.respondAsk).not.toHaveBeenCalled();
  });

  it("envelopes a throw from the resolver — the asker may have given up", async () => {
    const services = buildServices({
      mesh: {
        respondAsk: vi.fn(() => {
          throw new Error("no pending resolver for req_stale");
        }),
      },
    });

    const result = await call(services, "respond_ask", {
      request_id: "req_stale",
      answer: "a",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "no pending resolver for req_stale" });
  });

  it("is the one mesh tool ICs can use to answer", async () => {
    const services = buildServices();
    const tools = buildIcMeshTools(fakeCtx, services as unknown as MeshToolServices);
    const result = await findTool(tools, "respond_ask").handler({
      request_id: "req_1",
      answer: "a",
    });

    expect(result.isError).toBeFalsy();
    expect(services.mesh.respondAsk).toHaveBeenCalledTimes(1);
  });
});

// ── negotiate ────────────────────────────────────────────────────────────

describe("negotiate handler", () => {
  it("passes the caller's session id through as the initiator session", async () => {
    const services = buildServices();
    const result = await call(services, "negotiate", {
      peer_id: "agent_peer",
      proposal: "ship behind a flag",
      task_id: "task_7",
    });

    expect(result.isError).toBeFalsy();
    expect(services.mesh.sendNegotiate).toHaveBeenCalledWith(
      "agent_x",
      "agent_peer",
      "ship behind a flag",
      { taskId: "task_7", initiatorSessionId: "ses_x" },
    );
  });

  it("treats an absent or blank task_id as undefined rather than an empty string", async () => {
    const services = buildServices();
    await call(services, "negotiate", { peer_id: "agent_peer", proposal: "p" });
    expect(vi.mocked(services.mesh.sendNegotiate).mock.calls[0]![3]).toEqual({
      taskId: undefined,
      initiatorSessionId: "ses_x",
    });

    const second = buildServices();
    await call(second, "negotiate", {
      peer_id: "agent_peer",
      proposal: "p",
      task_id: "",
    });
    expect(vi.mocked(second.mesh.sendNegotiate).mock.calls[0]![3]).toMatchObject({
      taskId: undefined,
    });
  });

  it.each([
    ["missing peer_id", { proposal: "p" }],
    ["missing proposal", { peer_id: "agent_peer" }],
  ])("rejects %s without spawning the peer", async (_label, input) => {
    const services = buildServices();
    const result = await call(services, "negotiate", input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "peer_id and proposal required" });
    expect(services.mesh.sendNegotiate).not.toHaveBeenCalled();
  });

  it("surfaces the IC-target guardrail with its code", async () => {
    const services = buildServices({
      mesh: {
        sendNegotiate: vi.fn(async () => {
          throw new CannotNegotiateWithIcError({ agentId: "agent_ic" });
        }),
      },
    });

    const result = await call(services, "negotiate", {
      peer_id: "agent_ic",
      proposal: "p",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "CANNOT_NEGOTIATE_WITH_IC",
      agentId: "agent_ic",
    });
  });

  it("projects an escalated sentinel through the escalation shape, not the round shape", async () => {
    const services = buildServices({
      mesh: {
        sendNegotiate: vi.fn(async () => ({
          decision: "escalated" as const,
          escalation_id: "esc_9",
          negotiation_id: "neg_1",
          message: "peer escalated",
        })),
      },
    });

    const result = await call(services, "negotiate", {
      peer_id: "agent_peer",
      proposal: "p",
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_9",
      negotiation_id: "neg_1",
      message: "peer escalated",
    });
    // The round-shaped fields must be absent, not undefined-valued keys.
    expect(result.content).not.toHaveProperty("counter_proposal");
    expect(result.content).not.toHaveProperty("from_agent_id");
  });

  it("projects a normal round response with the peer's counter proposal", async () => {
    const services = buildServices({
      mesh: {
        sendNegotiate: vi.fn(async () => ({
          negotiation_id: "neg_1",
          from_agent_id: "agent_peer",
          decision: "counter" as const,
          message: "not quite",
          counter_proposal: "ship next sprint",
        })),
      },
    });

    const result = await call(services, "negotiate", {
      peer_id: "agent_peer",
      proposal: "p",
    });

    expect(result.content).toEqual({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "counter",
      message: "not quite",
      counter_proposal: "ship next sprint",
    });
  });
});

// ── respond_negotiate ────────────────────────────────────────────────────

describe("respond_negotiate handler", () => {
  it("reports accept/reject as terminal when the server returns null", async () => {
    const services = buildServices();
    const result = await call(services, "respond_negotiate", {
      negotiation_id: "neg_1",
      decision: "accept",
      message: "agreed",
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      negotiation_id: "neg_1",
      decision: "accept",
      terminal: true,
    });
  });

  it("does not pass a round number — the server derives it", async () => {
    const services = buildServices();
    await call(services, "respond_negotiate", {
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "alt",
      round: 99,
    });

    const [negId, response, sid] = vi.mocked(services.mesh.respondNegotiate).mock.calls[0]!;
    expect(negId).toBe("neg_1");
    expect(sid).toBe("ses_x");
    expect(response).toEqual({
      negotiation_id: "neg_1",
      from_agent_id: "agent_x",
      decision: "counter",
      message: "m",
      counter_proposal: "alt",
    });
    expect(response).not.toHaveProperty("round");
  });

  it("requires a counter_proposal when the decision is counter", async () => {
    const services = buildServices();
    const result = await call(services, "respond_negotiate", {
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "counter_proposal required when decision='counter'",
    });
    expect(services.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("does not require a counter_proposal for accept or reject", async () => {
    for (const decision of ["accept", "reject"]) {
      const services = buildServices();
      const result = await call(services, "respond_negotiate", {
        negotiation_id: "neg_1",
        decision,
        message: "m",
      });
      expect(result.isError).toBeFalsy();
      expect(vi.mocked(services.mesh.respondNegotiate).mock.calls[0]![1]).toMatchObject({
        counter_proposal: undefined,
      });
    }
  });

  it("rejects a decision outside the enum", async () => {
    const services = buildServices();
    const result = await call(services, "respond_negotiate", {
      negotiation_id: "neg_1",
      decision: "maybe",
      message: "m",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "decision must be one of: counter, accept, reject",
    });
    expect(services.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it.each([
    ["missing negotiation_id", { decision: "accept", message: "m" }],
    ["missing message", { negotiation_id: "neg_1", decision: "accept" }],
  ])("rejects %s before validating the decision", async (_label, input) => {
    const services = buildServices();
    const result = await call(services, "respond_negotiate", input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "negotiation_id and message required",
    });
    expect(services.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("projects the peer's next round when the negotiation continues", async () => {
    const services = buildServices({
      mesh: {
        respondNegotiate: vi.fn(async () => ({
          negotiation_id: "neg_1",
          from_agent_id: "agent_peer",
          decision: "counter" as const,
          message: "still no",
          counter_proposal: "half now",
        })),
      },
    });

    const result = await call(services, "respond_negotiate", {
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "alt",
    });

    expect(result.content).toMatchObject({
      decision: "counter",
      counter_proposal: "half now",
    });
    expect(result.content).not.toHaveProperty("terminal");
  });

  it("surfaces max_rounds_exceeded with the round meta the agent needs", async () => {
    const services = buildServices({
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

    const result = await call(services, "respond_negotiate", {
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "alt",
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

describe("report_blocker handler", () => {
  it("marks the task blocked, then spawns the resolved parent", async () => {
    const services = buildServices({
      agentRepo: { findParent: vi.fn(async () => fakeAgent({ id: "agent_boss" })) },
    });

    const result = await call(services, "report_blocker", {
      task_id: "task_7",
      description: "the migration needs a prod secret",
    });

    expect(result.isError).toBeFalsy();
    expect(services.taskService.markBlocked).toHaveBeenCalledWith(
      "task_7",
      "agent_x",
      "the migration needs a prod secret",
    );
    // Parent comes from the hierarchy, never from the agent's input.
    expect(services.mesh.reportBlocker).toHaveBeenCalledWith(
      "agent_boss",
      "agent_x",
      "task_7",
      "the migration needs a prod secret",
    );
    expect(result.content).toEqual({
      reported: true,
      parent_agent_id: "agent_boss",
      task_id: "task_7",
    });
  });

  it("refuses a top-level agent with no parent and leaves the task alone", async () => {
    const services = buildServices({
      agentRepo: { findParent: vi.fn(async () => undefined) },
    });

    const result = await call(services, "report_blocker", {
      task_id: "task_7",
      description: "stuck",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "no_parent_to_block" });
    // The guard fires before any state change — the task must not be
    // left blocked with no one spawned to unblock it.
    expect(services.taskService.markBlocked).not.toHaveBeenCalled();
    expect(services.mesh.reportBlocker).not.toHaveBeenCalled();
  });

  it.each([
    ["missing task_id", { description: "d" }],
    ["missing description", { task_id: "task_7" }],
  ])("rejects %s without touching the hierarchy", async (_label, input) => {
    const services = buildServices();
    const result = await call(services, "report_blocker", input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "task_id and description required" });
    expect(services.agentRepo.findParent).not.toHaveBeenCalled();
  });

  it("does not spawn the parent when markBlocked fails", async () => {
    const services = buildServices({
      taskService: {
        markBlocked: vi.fn(async () => {
          throw new Error("task is already done");
        }),
      },
    });

    const result = await call(services, "report_blocker", {
      task_id: "task_7",
      description: "stuck",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "task is already done" });
    expect(services.mesh.reportBlocker).not.toHaveBeenCalled();
  });
});

// ── escalate_to_humans ───────────────────────────────────────────────────

describe("escalate_to_humans handler", () => {
  it("creates the escalation, unblocks the peer, then notifies listeners", async () => {
    const services = buildServices();
    const result = await call(services, "escalate_to_humans", {
      negotiation_id: "neg_1",
      summary: "stuck on rollout order",
      proposals: [{ title: "A", description: "do A" }],
      open_questions: ["who owns the flag?"],
    });

    expect(result.isError).toBeFalsy();
    expect(services.escalationService.create).toHaveBeenCalledWith({
      negotiationId: "neg_1",
      callerAgentId: "agent_x",
      summary: "stuck on rollout order",
      proposals: [{ title: "A", description: "do A" }],
      openQuestions: ["who owns the flag?"],
    });
    expect(services.mesh.unblockOnEscalate).toHaveBeenCalledWith("neg_1", "esc_1");
    expect(services.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("pg_notify('escalation_created'"),
      ["esc_1"],
    );
    expect(result.content).toEqual({
      escalation_id: "esc_1",
      status: "pending",
      negotiation_id: "neg_1",
    });
  });

  it("drops non-array proposals and open_questions rather than passing them through", async () => {
    const services = buildServices();
    await call(services, "escalate_to_humans", {
      negotiation_id: "neg_1",
      summary: "s",
      proposals: "just one idea",
      open_questions: "a question",
    });

    expect(services.escalationService.create).toHaveBeenCalledWith(
      expect.objectContaining({ proposals: undefined, openQuestions: undefined }),
    );
  });

  it("filters non-string entries out of open_questions", async () => {
    const services = buildServices();
    await call(services, "escalate_to_humans", {
      negotiation_id: "neg_1",
      summary: "s",
      open_questions: ["real question", 42, null, "another"],
    });

    expect(services.escalationService.create).toHaveBeenCalledWith(
      expect.objectContaining({ openQuestions: ["real question", "another"] }),
    );
  });

  it.each([
    ["missing negotiation_id", { summary: "s" }],
    ["missing summary", { negotiation_id: "neg_1" }],
  ])("rejects %s without creating a row", async (_label, input) => {
    const services = buildServices();
    const result = await call(services, "escalate_to_humans", input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "negotiation_id and summary required" });
    expect(services.escalationService.create).not.toHaveBeenCalled();
  });

  it("leaves the peer blocked if the escalation row itself cannot be created", async () => {
    const services = buildServices({
      escalationService: {
        create: vi.fn(async () => {
          throw new Error("negotiation not found");
        }),
      },
    });

    const result = await call(services, "escalate_to_humans", {
      negotiation_id: "neg_missing",
      summary: "s",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "negotiation not found" });
    // No escalation id exists yet, so there is nothing to unblock with.
    expect(services.mesh.unblockOnEscalate).not.toHaveBeenCalled();
    expect(services.pool.query).not.toHaveBeenCalled();
  });
});
