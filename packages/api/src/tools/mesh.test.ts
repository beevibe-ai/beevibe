/**
 * Mesh tool tests — tier gating plus per-handler behavior.
 *
 * The tier inventory block locks the exact tool *names* each tier gets,
 * so future skill-loader work can rely on the surface being stable.
 *
 * The handler blocks below use fakes for MeshServer and the repos/
 * services. Each handler is a closure over (ctx, services), so argument
 * validation, the projection of each wire response, and the coded-error
 * envelope are all reachable without Postgres or a spawned CLI. What
 * still needs the m6/m7 e2e scripts is the blocking round-trip itself —
 * the resolver bookkeeping inside MeshServer, not these adapters.
 */
import { describe, expect, it, vi } from "vitest";
import type { ResolvedCaller } from "@beevibe/core/auth";
import type { Agent, AgentRepository, TaskRepository } from "@beevibe/core";
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
import type { AgentTool, AgentToolResult } from "./types.js";

// ── Fakes ────────────────────────────────────────────────────────────────

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
    pool?: Partial<Pool>;
  } = {},
) {
  const mesh = {
    sendAsk: vi.fn(async (requestId: string, _from: string, to: string) => ({
      request_id: requestId,
      from_agent_id: to,
      answer: "yes, feasible",
    })),
    respondAsk: vi.fn(),
    sendNegotiate: vi.fn(async (_from: string, peer: string) => ({
      negotiation_id: "neg_1",
      from_agent_id: peer,
      decision: "counter" as const,
      message: "how about this",
      counter_proposal: "do it in two phases",
    })),
    respondNegotiate: vi.fn(async () => null),
    unblockOnEscalate: vi.fn(),
    reportBlocker: vi.fn(),
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
    ...overrides.pool,
  } as unknown as Pool;

  return {
    mesh,
    agentRepo,
    taskRepo,
    taskService,
    escalationService,
    pool,
  } as unknown as MeshToolServices;
}

const fakeCaller: ResolvedCaller = {
  agentId: "agent_x",
  source: "agent",
  hierarchyLevel: "team",
};
const fakeCtx: MeshToolContext = { caller: fakeCaller, beevibeSid: "ses_x" };

function call(
  tools: AgentTool[],
  name: string,
  input: Record<string, unknown> = {},
): Promise<AgentToolResult> {
  const t = tools.find((t) => t.name === name);
  if (!t) throw new Error(`tool ${name} missing from set`);
  return t.handler(input);
}

/** Team tier gets all six tools, so it's the harness for handler tests. */
function teamTools(services: MeshToolServices = buildServices()): {
  tools: AgentTool[];
  services: MeshToolServices;
} {
  return { tools: buildTeamMeshTools(fakeCtx, services), services };
}

// ── Tier gating ──────────────────────────────────────────────────────────

describe("buildIcMeshTools (M9.1)", () => {
  // Exact set, not a superset: ICs are responders, not initiators, so the
  // absences matter as much as the presences. No `respond_negotiate`
  // (M9.1 dropped it — ICs are workers, not deciders) and none of the
  // initiator-side surface (`ask`, `negotiate`, `escalate_to_humans`).
  it("gets exactly respond_ask + report_blocker", () => {
    const tools = buildIcMeshTools(fakeCtx, buildServices());
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["report_blocker", "respond_ask"]);
  });
});

describe("buildTeamMeshTools", () => {
  it("gets the full mesh surface — initiator and responder sides both", () => {
    const tools = buildTeamMeshTools(fakeCtx, buildServices());
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

// ── ask ──────────────────────────────────────────────────────────────────

describe("ask", () => {
  it("mints a request id, sends, and projects the answer", async () => {
    const { tools, services } = teamTools();
    const res = await call(tools, "ask", {
      target_agent_id: "agent_b",
      question: "is X feasible?",
    });

    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({
      request_id: expect.any(String),
      from_agent_id: "agent_b",
      answer: "yes, feasible",
    });
    // The server never receives a caller-supplied request id — the tool
    // mints a UUID so two asks can't collide on one resolver slot.
    expect(services.mesh.sendAsk).toHaveBeenCalledWith(
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      ),
      "agent_x",
      "agent_b",
      "is X feasible?",
    );
  });

  it("mints a distinct request id per call", async () => {
    const { tools, services } = teamTools();
    await call(tools, "ask", { target_agent_id: "b", question: "q1" });
    await call(tools, "ask", { target_agent_id: "b", question: "q2" });
    const ids = vi
      .mocked(services.mesh.sendAsk)
      .mock.calls.map((c) => c[0]);
    expect(new Set(ids).size).toBe(2);
  });

  it.each([
    ["both missing", {}],
    ["no question", { target_agent_id: "agent_b" }],
    ["no target", { question: "is X feasible?" }],
    ["blank target", { target_agent_id: "", question: "q" }],
    ["blank question", { target_agent_id: "agent_b", question: "" }],
  ])("rejects %s without calling the server", async (_label, input) => {
    const { tools, services } = teamTools();
    const res = await call(tools, "ask", input);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("target_agent_id and question required");
    expect(services.mesh.sendAsk).not.toHaveBeenCalled();
  });

  it("projects a coded capacity error with its meta", async () => {
    const { tools } = teamTools(
      buildServices({
        mesh: {
          sendAsk: vi.fn(async () => {
            throw new MeshCapacityError("at capacity", {
              agentId: "agent_b",
              running: 3,
              cap: 3,
            });
          }),
        },
      }),
    );
    const res = await call(tools, "ask", {
      target_agent_id: "agent_b",
      question: "q",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "MESH_CAPACITY_EXCEEDED",
      agentId: "agent_b",
      running: 3,
      cap: 3,
      message: "at capacity",
    });
  });

  it("degrades an uncoded throw to the catch-all envelope", async () => {
    const { tools } = teamTools(
      buildServices({
        mesh: {
          sendAsk: vi.fn(async () => {
            throw new Error("target offline");
          }),
        },
      }),
    );
    const res = await call(tools, "ask", {
      target_agent_id: "agent_b",
      question: "q",
    });
    expect(res.content).toEqual({ error: "target offline" });
  });
});

// ── respond_ask ──────────────────────────────────────────────────────────

describe("respond_ask", () => {
  it("resolves the asker's pending request with the caller as responder", async () => {
    const { tools, services } = teamTools();
    const res = await call(tools, "respond_ask", {
      request_id: "req_1",
      answer: "no, blocked on auth",
    });

    expect(res.content).toEqual({ responded: true, request_id: "req_1" });
    expect(services.mesh.respondAsk).toHaveBeenCalledWith("req_1", {
      request_id: "req_1",
      // Stamped server-side from the caller's token, not from input.
      from_agent_id: "agent_x",
      answer: "no, blocked on auth",
    });
  });

  it.each([
    ["both missing", {}],
    ["no answer", { request_id: "req_1" }],
    ["no request id", { answer: "a" }],
    ["blank answer", { request_id: "req_1", answer: "" }],
  ])("rejects %s", async (_label, input) => {
    const { tools, services } = teamTools();
    const res = await call(tools, "respond_ask", input);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("request_id and answer required");
    expect(services.mesh.respondAsk).not.toHaveBeenCalled();
  });

  it("envelopes a throw from the server", async () => {
    const { tools } = teamTools(
      buildServices({
        mesh: {
          respondAsk: vi.fn(() => {
            throw new Error("no such pending request");
          }),
        },
      }),
    );
    const res = await call(tools, "respond_ask", {
      request_id: "req_gone",
      answer: "a",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: "no such pending request" });
  });

  it("is the one mesh tool an IC also gets", async () => {
    const services = buildServices();
    const tools = buildIcMeshTools(fakeCtx, services);
    const res = await call(tools, "respond_ask", {
      request_id: "req_1",
      answer: "a",
    });
    expect(res.content).toMatchObject({ responded: true });
  });
});

// ── negotiate ────────────────────────────────────────────────────────────

describe("negotiate", () => {
  it("sends round 1 and projects the peer's counter", async () => {
    const { tools, services } = teamTools();
    const res = await call(tools, "negotiate", {
      peer_id: "agent_b",
      proposal: "ship behind a flag",
    });

    expect(res.content).toEqual({
      negotiation_id: "neg_1",
      from_agent_id: "agent_b",
      decision: "counter",
      message: "how about this",
      counter_proposal: "do it in two phases",
    });
    expect(services.mesh.sendNegotiate).toHaveBeenCalledWith(
      "agent_x",
      "agent_b",
      "ship behind a flag",
      // The caller's own session is the originator metadata; task_id is
      // optional and absent here.
      { taskId: undefined, initiatorSessionId: "ses_x" },
    );
  });

  it("stamps task_id when supplied", async () => {
    const { tools, services } = teamTools();
    await call(tools, "negotiate", {
      peer_id: "agent_b",
      proposal: "p",
      task_id: "task_7",
    });
    expect(services.mesh.sendNegotiate).toHaveBeenCalledWith(
      "agent_x",
      "agent_b",
      "p",
      { taskId: "task_7", initiatorSessionId: "ses_x" },
    );
  });

  it.each([
    ["an empty string", ""],
    ["a non-string", 7],
  ])("ignores a task_id that is %s", async (_label, task_id) => {
    const { tools, services } = teamTools();
    await call(tools, "negotiate", {
      peer_id: "agent_b",
      proposal: "p",
      task_id,
    });
    expect(services.mesh.sendNegotiate).toHaveBeenCalledWith(
      "agent_x",
      "agent_b",
      "p",
      { taskId: undefined, initiatorSessionId: "ses_x" },
    );
  });

  it.each([
    ["both missing", {}],
    ["no proposal", { peer_id: "agent_b" }],
    ["no peer", { proposal: "p" }],
    ["blank proposal", { peer_id: "agent_b", proposal: "" }],
  ])("rejects %s", async (_label, input) => {
    const { tools, services } = teamTools();
    const res = await call(tools, "negotiate", input);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("peer_id and proposal required");
    expect(services.mesh.sendNegotiate).not.toHaveBeenCalled();
  });

  it("surfaces CANNOT_NEGOTIATE_WITH_IC when the target is a worker", async () => {
    const { tools } = teamTools(
      buildServices({
        mesh: {
          sendNegotiate: vi.fn(async () => {
            throw new CannotNegotiateWithIcError({ agentId: "agent_ic" });
          }),
        },
      }),
    );
    const res = await call(tools, "negotiate", {
      peer_id: "agent_ic",
      proposal: "p",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({
      error: "CANNOT_NEGOTIATE_WITH_IC",
      agentId: "agent_ic",
    });
    expect(String(res.content.message)).toContain("ask()");
  });

  it("projects the escalated sentinel shape when the peer escalated", async () => {
    const { tools } = teamTools(
      buildServices({
        mesh: {
          sendNegotiate: vi.fn(async () => ({
            decision: "escalated" as const,
            escalation_id: "esc_4",
            negotiation_id: "neg_1",
            message: "handed to humans",
          })),
        },
      }),
    );
    const res = await call(tools, "negotiate", {
      peer_id: "agent_b",
      proposal: "p",
    });
    // The sentinel branch projects a different key set — no
    // from_agent_id, no counter_proposal.
    expect(res.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_4",
      negotiation_id: "neg_1",
      message: "handed to humans",
    });
  });
});

// ── respond_negotiate ────────────────────────────────────────────────────

describe("respond_negotiate", () => {
  it("reports terminal when the server returns null (accept/reject)", async () => {
    const { tools, services } = teamTools();
    const res = await call(tools, "respond_negotiate", {
      negotiation_id: "neg_1",
      decision: "accept",
      message: "agreed",
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
        message: "agreed",
        counter_proposal: undefined,
      },
      "ses_x",
    );
  });

  it("projects the peer's next round when the server returns one", async () => {
    const { tools } = teamTools(
      buildServices({
        mesh: {
          respondNegotiate: vi.fn(async () => ({
            negotiation_id: "neg_1",
            from_agent_id: "agent_b",
            decision: "counter" as const,
            message: "still no",
            counter_proposal: "split it",
          })),
        },
      }),
    );
    const res = await call(tools, "respond_negotiate", {
      negotiation_id: "neg_1",
      decision: "counter",
      message: "how about",
      counter_proposal: "phase it",
    });
    expect(res.content).toEqual({
      negotiation_id: "neg_1",
      from_agent_id: "agent_b",
      decision: "counter",
      message: "still no",
      counter_proposal: "split it",
    });
  });

  it("forwards the counter_proposal on a counter", async () => {
    const { tools, services } = teamTools();
    await call(tools, "respond_negotiate", {
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "phase it",
    });
    expect(services.mesh.respondNegotiate).toHaveBeenCalledWith(
      "neg_1",
      expect.objectContaining({ counter_proposal: "phase it" }),
      "ses_x",
    );
  });

  it.each([
    ["no negotiation id", { decision: "accept", message: "m" }],
    ["blank negotiation id", { negotiation_id: "", decision: "accept", message: "m" }],
    ["no message", { negotiation_id: "neg_1", decision: "accept" }],
    ["blank message", { negotiation_id: "neg_1", decision: "accept", message: "" }],
  ])("rejects %s", async (_label, input) => {
    const { tools, services } = teamTools();
    const res = await call(tools, "respond_negotiate", input);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("negotiation_id and message required");
    expect(services.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["unknown", "maybe"],
    ["a non-string", 1],
    // "escalated" is a server-produced sentinel, never a caller input.
    ["the escalated sentinel", "escalated"],
  ])("rejects a decision that is %s", async (_label, decision) => {
    const { tools, services } = teamTools();
    const res = await call(tools, "respond_negotiate", {
      negotiation_id: "neg_1",
      decision,
      message: "m",
    });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe(
      "decision must be one of: counter, accept, reject",
    );
    expect(services.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("requires a counter_proposal when the decision is counter", async () => {
    const { tools, services } = teamTools();
    const res = await call(tools, "respond_negotiate", {
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
    });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe(
      "counter_proposal required when decision='counter'",
    );
    expect(services.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it.each(["accept", "reject"] as const)(
    "does not require a counter_proposal on %s",
    async (decision) => {
      const { tools } = teamTools();
      const res = await call(tools, "respond_negotiate", {
        negotiation_id: "neg_1",
        decision,
        message: "m",
      });
      expect(res.isError).toBeUndefined();
    },
  );

  it("surfaces MAX_ROUNDS_EXCEEDED with the round counters", async () => {
    const { tools } = teamTools(
      buildServices({
        mesh: {
          respondNegotiate: vi.fn(async () => {
            throw new MeshMaxRoundsError({
              negotiationId: "neg_1",
              rounds_completed: 5,
              max_rounds: 5,
            });
          }),
        },
      }),
    );
    const res = await call(tools, "respond_negotiate", {
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "c",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({
      error: "MAX_ROUNDS_EXCEEDED",
      negotiationId: "neg_1",
      rounds_completed: 5,
      max_rounds: 5,
    });
    // The message is the agent's cue to switch tools.
    expect(String(res.content.message)).toContain("escalate_to_humans");
  });

  it("projects the escalated sentinel when the peer escalated mid-round", async () => {
    const { tools } = teamTools(
      buildServices({
        mesh: {
          respondNegotiate: vi.fn(async () => ({
            decision: "escalated" as const,
            escalation_id: "esc_4",
            negotiation_id: "neg_1",
            message: "peer escalated",
          })),
        },
      }),
    );
    const res = await call(tools, "respond_negotiate", {
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "c",
    });
    expect(res.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_4",
      negotiation_id: "neg_1",
      message: "peer escalated",
    });
  });
});

// ── report_blocker ───────────────────────────────────────────────────────

describe("report_blocker", () => {
  it("marks the task blocked then spawns the parent", async () => {
    const { tools, services } = teamTools();
    const res = await call(tools, "report_blocker", {
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
    // Parent is derived from the caller's hierarchy, never from input.
    expect(services.agentRepo.findParent).toHaveBeenCalledWith("agent_x");
    expect(services.mesh.reportBlocker).toHaveBeenCalledWith(
      "agent_parent",
      "agent_x",
      "task_1",
      "the API key is missing",
    );
  });

  it.each([
    ["both missing", {}],
    ["no description", { task_id: "task_1" }],
    ["no task id", { description: "d" }],
    ["blank description", { task_id: "task_1", description: "" }],
  ])("rejects %s before any lookup", async (_label, input) => {
    const { tools, services } = teamTools();
    const res = await call(tools, "report_blocker", input);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("task_id and description required");
    expect(services.agentRepo.findParent).not.toHaveBeenCalled();
    expect(services.taskService.markBlocked).not.toHaveBeenCalled();
  });

  it("refuses for a top-level agent and points at the alternatives", async () => {
    const { tools, services } = teamTools(
      buildServices({ agentRepo: { findParent: vi.fn(async () => undefined) } }),
    );
    const res = await call(tools, "report_blocker", {
      task_id: "task_1",
      description: "d",
    });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("no_parent_to_block");
    expect(String(res.content.message)).toContain("escalate_to_humans");
    // Crucially the task is NOT marked blocked — nobody would unblock it.
    expect(services.taskService.markBlocked).not.toHaveBeenCalled();
    expect(services.mesh.reportBlocker).not.toHaveBeenCalled();
  });

  it("does not spawn the parent when marking the task blocked fails", async () => {
    const { tools, services } = teamTools(
      buildServices({
        taskService: {
          markBlocked: vi.fn(async () => {
            throw new Error("task not found");
          }),
        },
      }),
    );
    const res = await call(tools, "report_blocker", {
      task_id: "task_gone",
      description: "d",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: "task not found" });
    expect(services.mesh.reportBlocker).not.toHaveBeenCalled();
  });

  it("is available to ICs — escalating upward is their one initiator path", async () => {
    const services = buildServices();
    const tools = buildIcMeshTools(fakeCtx, services);
    const res = await call(tools, "report_blocker", {
      task_id: "task_1",
      description: "d",
    });
    expect(res.content).toMatchObject({ reported: true });
  });
});

// ── escalate_to_humans ───────────────────────────────────────────────────

describe("escalate_to_humans", () => {
  it("creates the escalation, unblocks the peer, then notifies", async () => {
    const { tools, services } = teamTools();
    const res = await call(tools, "escalate_to_humans", {
      negotiation_id: "neg_1",
      summary: "We're stuck on X; root disagreement is Y.",
      proposals: [{ title: "A", description: "do A" }],
      open_questions: ["who owns this?"],
    });

    expect(res.content).toEqual({
      escalation_id: "esc_1",
      status: "pending",
      negotiation_id: "neg_1",
    });
    expect(services.escalationService.create).toHaveBeenCalledWith({
      negotiationId: "neg_1",
      callerAgentId: "agent_x",
      summary: "We're stuck on X; root disagreement is Y.",
      proposals: [{ title: "A", description: "do A" }],
      openQuestions: ["who owns this?"],
    });
    // The peer's blocked respond_negotiate has to be released with the
    // real escalation id, or it hangs until timeout.
    expect(services.mesh.unblockOnEscalate).toHaveBeenCalledWith(
      "neg_1",
      "esc_1",
    );
    expect(services.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("pg_notify('escalation_created'"),
      ["esc_1"],
    );
  });

  it.each([
    ["both missing", {}],
    ["no summary", { negotiation_id: "neg_1" }],
    ["no negotiation id", { summary: "s" }],
    ["blank summary", { negotiation_id: "neg_1", summary: "" }],
  ])("rejects %s", async (_label, input) => {
    const { tools, services } = teamTools();
    const res = await call(tools, "escalate_to_humans", input);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("negotiation_id and summary required");
    expect(services.escalationService.create).not.toHaveBeenCalled();
  });

  it.each([
    ["absent", undefined],
    ["not an array", { title: "A" }],
    ["a string", "A"],
  ])("sends no proposals when they are %s", async (_label, proposals) => {
    const { tools, services } = teamTools();
    await call(tools, "escalate_to_humans", {
      negotiation_id: "neg_1",
      summary: "s",
      proposals,
    });
    expect(services.escalationService.create).toHaveBeenCalledWith(
      expect.objectContaining({ proposals: undefined }),
    );
  });

  it("filters non-string open_questions", async () => {
    const { tools, services } = teamTools();
    await call(tools, "escalate_to_humans", {
      negotiation_id: "neg_1",
      summary: "s",
      open_questions: ["real?", 42, null, "also real?"],
    });
    expect(services.escalationService.create).toHaveBeenCalledWith(
      expect.objectContaining({ openQuestions: ["real?", "also real?"] }),
    );
  });

  it("sends no open_questions when they are not an array", async () => {
    const { tools, services } = teamTools();
    await call(tools, "escalate_to_humans", {
      negotiation_id: "neg_1",
      summary: "s",
      open_questions: "just one",
    });
    expect(services.escalationService.create).toHaveBeenCalledWith(
      expect.objectContaining({ openQuestions: undefined }),
    );
  });

  it("leaves the peer blocked-but-recoverable when create fails", async () => {
    const { tools, services } = teamTools(
      buildServices({
        escalationService: {
          create: vi.fn(async () => {
            throw new Error("negotiation already escalated");
          }),
        },
      }),
    );
    const res = await call(tools, "escalate_to_humans", {
      negotiation_id: "neg_1",
      summary: "s",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: "negotiation already escalated" });
    // No escalation id exists, so there is nothing to unblock with.
    expect(services.mesh.unblockOnEscalate).not.toHaveBeenCalled();
    expect(services.pool.query).not.toHaveBeenCalled();
  });

  it("envelopes a pg_notify failure after the escalation already landed", async () => {
    const { tools, services } = teamTools(
      buildServices({
        pool: {
          query: vi.fn(async () => {
            throw new Error("pg down");
          }),
        },
      }),
    );
    const res = await call(tools, "escalate_to_humans", {
      negotiation_id: "neg_1",
      summary: "s",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: "pg down" });
    // The peer was still released — that side effect precedes the notify.
    expect(services.mesh.unblockOnEscalate).toHaveBeenCalledOnce();
  });
});
