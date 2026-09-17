/**
 * MeshServer unit tests.
 *
 * The failure-propagation block is the original focus — when a callee
 * session terminates non-success, the caller's pending `ask`/`negotiate`
 * promise must reject within a tick instead of sitting through the
 * 5-minute resolver timeout (which surfaces to the MCP layer as a
 * generic "transport dropped" error).
 *
 * The rest covers the spawn + round bookkeeping the mesh tools sit on:
 * the capacity gate, the IC guardrail, the negotiation row/round writes,
 * the exchange-based max-rounds arithmetic, and which side's resolver
 * each path unblocks. Every dependency is a fake, so no Postgres and no
 * spawned CLI is involved.
 */

import { describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentRepository,
  Negotiation,
  NegotiationRepository,
  NegotiationRoundRepository,
  RuntimeRegistry,
  SessionEventRepository,
  SessionRepository,
  WorkspaceManager,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import { MeshServer } from "./server.js";

interface DispatchCall {
  agentId: string;
  type?: string;
  intent?: string;
  callerAgentId?: string;
  sessionIdOverride?: string;
}

interface MeshOverrides {
  /** Per-agent-id stub; falls back to a generic team agent. */
  agents?: Record<string, Partial<Agent> | null>;
  /** Running mesh sessions for the capacity check. */
  running?: number;
  negotiation?: Partial<Negotiation> | null;
  dispatchError?: Error;
}

function makeMesh(overrides: MeshOverrides = {}) {
  const dispatchCalls: DispatchCall[] = [];
  const dispatchService = {
    dispatchTask: vi.fn(async (opts: DispatchCall) => {
      dispatchCalls.push(opts);
      if (overrides.dispatchError) throw overrides.dispatchError;
      // Return a minimal shape that satisfies the type — MeshServer
      // discards the return via `void`, so values don't matter.
      return {} as Awaited<ReturnType<DispatchService["dispatchTask"]>>;
    }),
  } as unknown as DispatchService;

  const negotiationRepo = {
    create: vi.fn(async (input: Partial<Negotiation>) => ({
      status: "active",
      rounds_completed: 0,
      ...input,
      // Pin the id so resolver keys are predictable across the fakes;
      // the real repo echoes back the minted one.
      id: "neg_1",
    })),
    update: vi.fn(async () => ({}) as Negotiation),
    findById: vi.fn(async () =>
      overrides.negotiation === undefined
        ? {
            id: "neg_1",
            status: "active",
            rounds_completed: 1,
            max_rounds: 5,
            initiator_agent_id: "agent_a",
            counterparty_agent_id: "agent_b",
          }
        : overrides.negotiation,
    ),
  } as unknown as NegotiationRepository;

  const negotiationRoundRepo = {
    create: vi.fn(async (input: Record<string, unknown>) => input),
  } as unknown as NegotiationRoundRepository;

  const agentRepo = {
    findById: vi.fn(async (id: string) => {
      const stub = overrides.agents?.[id];
      if (stub === null) return undefined;
      return {
        id,
        name: id,
        owner_id: "per_1",
        hierarchy_level: "team" as const,
        max_mesh_sessions: 5,
        max_negotiation_rounds: 5,
        runtime_config: { type: "claude" as const },
        ...stub,
      };
    }),
  } as unknown as AgentRepository;

  const mesh = new MeshServer({
    agentRepo,
    sessionRepo: {
      countRunningByAgent: vi.fn(async () => overrides.running ?? 0),
    } as unknown as SessionRepository,
    sessionEventRepo: {} as SessionEventRepository,
    negotiationRepo,
    negotiationRoundRepo,
    workspaceManager: {} as WorkspaceManager,
    runtimeRegistry: {} as RuntimeRegistry,
    dispatchService,
    makeMemoryAgent: () => ({}) as never,
  });

  return { mesh, dispatchCalls, negotiationRepo, negotiationRoundRepo, agentRepo };
}

/** Let the pre-spawn awaits settle so the pre-minted session id lands. */
const tick = () => new Promise((r) => setImmediate(r));

describe("MeshServer.failResolverForCalleeSession", () => {
  it("rejects an ask waiter as soon as the callee session is marked failed", async () => {
    const { mesh, dispatchCalls } = makeMesh();
    const ask = mesh.sendAsk("req_1", "agent_caller", "agent_callee", "hello?");

    // sendAsk awaits capacity checks before kicking off the spawn — wait
    // a full event-loop tick so the pre-minted sessionId reaches the spy.
    await new Promise((r) => setImmediate(r));
    const calleeSid = dispatchCalls[0]?.sessionIdOverride;
    expect(calleeSid).toBeDefined();

    mesh.failResolverForCalleeSession(calleeSid!, "process_lost");

    await expect(ask).rejects.toThrow(/mesh callee session failed: process_lost/);
  });

  it("is a no-op when the callee session has no pending waiter", () => {
    const { mesh } = makeMesh();
    // Should not throw; no resolver is registered for this id.
    expect(() => mesh.failResolverForCalleeSession("sess_unknown", "x")).not.toThrow();
  });

  it("hasPendingCalleeSession tracks the in-flight reverse index", async () => {
    const { mesh, dispatchCalls } = makeMesh();
    expect(mesh.hasPendingCalleeSession("sess_unknown")).toBe(false);

    const ask = mesh.sendAsk("req_3", "agent_caller", "agent_callee", "yo?");
    await new Promise((r) => setImmediate(r));
    const calleeSid = dispatchCalls[0]?.sessionIdOverride;
    expect(calleeSid).toBeDefined();
    expect(mesh.hasPendingCalleeSession(calleeSid!)).toBe(true);

    // Drains on fast-fail.
    mesh.failResolverForCalleeSession(calleeSid!, "x");
    await expect(ask).rejects.toThrow();
    expect(mesh.hasPendingCalleeSession(calleeSid!)).toBe(false);
  });

  it("does not interfere with the success path", async () => {
    const { mesh, dispatchCalls } = makeMesh();
    const ask = mesh.sendAsk("req_2", "agent_caller", "agent_callee", "ping?");

    await new Promise((r) => setImmediate(r));
    const calleeSid = dispatchCalls[0]?.sessionIdOverride;
    expect(calleeSid).toBeDefined();

    mesh.respondAsk("req_2", {
      request_id: "req_2",
      from_agent_id: "agent_callee",
      answer: "pong",
    });

    await expect(ask).resolves.toEqual({
      request_id: "req_2",
      from_agent_id: "agent_callee",
      answer: "pong",
    });

    // After the success path drains the reverse index, a stale failure
    // signal for the same session is a no-op (idempotency).
    expect(() => mesh.failResolverForCalleeSession(calleeSid!, "late")).not.toThrow();
  });
});

describe("MeshServer.sendAsk", () => {
  it("dispatches a mesh_ask session carrying the request id and the asker", async () => {
    const { mesh, dispatchCalls } = makeMesh();
    void mesh.sendAsk("req_1", "agent_a", "agent_b", "is X feasible?");
    await tick();

    const call = dispatchCalls[0]!;
    expect(call).toMatchObject({
      agentId: "agent_b",
      type: "mesh_ask",
      callerAgentId: "agent_a",
    });
    expect(call.intent).toContain('request_id="req_1"');
    expect(call.intent).toContain('from="agent_a"');
    expect(call.intent).toContain("is X feasible?");
    // The callee is told the exact tool call that unblocks the asker.
    expect(call.intent).toContain('respond_ask(request_id="req_1"');
  });

  it("escapes attribute-breaking characters in the intent envelope", async () => {
    const { mesh, dispatchCalls } = makeMesh();
    void mesh.sendAsk('req"1', "agent_a", "agent_b", "q");
    await tick();

    expect(dispatchCalls[0]!.intent).toContain('request_id="req&quot;1"');
  });

  it("refuses to spawn when the target is at mesh capacity", async () => {
    const { mesh, dispatchCalls } = makeMesh({ running: 5 });
    await expect(mesh.sendAsk("req_1", "agent_a", "agent_b", "q")).rejects.toMatchObject({
      code: "MESH_CAPACITY_EXCEEDED",
      meta: { agentId: "agent_b", running: 5, cap: 5 },
    });
    expect(dispatchCalls).toHaveLength(0);
  });

  it("falls back to the default cap when the agent has none set", async () => {
    // Default is 3; two running sessions leave room for one more.
    const { mesh, dispatchCalls } = makeMesh({
      agents: { agent_b: { max_mesh_sessions: undefined } },
      running: 2,
    });
    void mesh.sendAsk("req_1", "agent_a", "agent_b", "q");
    await tick();
    expect(dispatchCalls).toHaveLength(1);
  });

  it("rejects when the target agent does not exist", async () => {
    const { mesh } = makeMesh({ agents: { agent_gone: null } });
    await expect(
      mesh.sendAsk("req_1", "agent_a", "agent_gone", "q"),
    ).rejects.toThrow(/target agent not found: agent_gone/);
  });

  it("swallows a dispatch failure rather than crashing the server", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { mesh } = makeMesh({ dispatchError: new Error("daemon offline") });
    // The asker stays blocked on the resolver; the rejection is logged,
    // not thrown into the event loop as an unhandled rejection.
    void mesh.sendAsk("req_1", "agent_a", "agent_b", "q");
    await tick();

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("[mesh] dispatch for agent_b (mesh_ask) failed:"),
      "daemon offline",
    );
    consoleError.mockRestore();
  });

  it("ignores a respond_ask for a request nobody is waiting on", () => {
    const { mesh } = makeMesh();
    expect(() =>
      mesh.respondAsk("req_unknown", {
        request_id: "req_unknown",
        from_agent_id: "agent_b",
        answer: "hello?",
      }),
    ).not.toThrow();
  });
});

describe("MeshServer.sendNegotiate", () => {
  const options = { initiatorSessionId: "ses_a" };

  it("creates the negotiation, inserts round 1, and spawns the peer", async () => {
    const { mesh, dispatchCalls, negotiationRepo, negotiationRoundRepo } = makeMesh();
    void mesh.sendNegotiate("agent_a", "agent_b", "ship Monday", {
      ...options,
      taskId: "task_7",
    });
    await tick();

    expect(negotiationRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        initiator_agent_id: "agent_a",
        initiator_session_id: "ses_a",
        counterparty_agent_id: "agent_b",
        task_id: "task_7",
        max_rounds: 5,
      }),
    );
    expect(negotiationRoundRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        round_number: 1,
        from_agent_id: "agent_a",
        decision: "propose",
        message: "ship Monday",
      }),
    );
    // rounds_completed is bumped in the same logical step so B's first
    // reply computes round 2 instead of re-attempting round 1.
    expect(negotiationRepo.update).toHaveBeenCalledWith("neg_1", {
      rounds_completed: 1,
    });
    expect(dispatchCalls[0]).toMatchObject({
      agentId: "agent_b",
      type: "mesh_negotiate",
      callerAgentId: "agent_a",
    });
    expect(dispatchCalls[0]!.intent).toContain('round="1"');
  });

  it("stamps the initiator's configured max_negotiation_rounds", async () => {
    const { mesh, negotiationRepo } = makeMesh({
      agents: { agent_a: { max_negotiation_rounds: 2 } },
    });
    void mesh.sendNegotiate("agent_a", "agent_b", "p", options);
    await tick();

    expect(negotiationRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ max_rounds: 2 }),
    );
  });

  it("falls back to the default cap when the initiator has none set", async () => {
    const { mesh, negotiationRepo } = makeMesh({
      agents: { agent_a: { max_negotiation_rounds: undefined } },
    });
    void mesh.sendNegotiate("agent_a", "agent_b", "p", options);
    await tick();

    expect(negotiationRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ max_rounds: 5 }),
    );
  });

  it("refuses an IC target before touching the negotiation tables", async () => {
    const { mesh, negotiationRepo, dispatchCalls } = makeMesh({
      agents: { agent_ic: { hierarchy_level: "ic" } },
    });
    await expect(
      mesh.sendNegotiate("agent_a", "agent_ic", "p", options),
    ).rejects.toMatchObject({
      code: "CANNOT_NEGOTIATE_WITH_IC",
      meta: { agentId: "agent_ic" },
    });
    expect(negotiationRepo.create).not.toHaveBeenCalled();
    expect(dispatchCalls).toHaveLength(0);
  });

  it("rejects an unknown target", async () => {
    const { mesh } = makeMesh({ agents: { agent_gone: null } });
    await expect(
      mesh.sendNegotiate("agent_a", "agent_gone", "p", options),
    ).rejects.toThrow(/target agent not found/);
  });

  it("rejects an unknown initiator", async () => {
    const { mesh } = makeMesh({ agents: { agent_gone: null } });
    await expect(
      mesh.sendNegotiate("agent_gone", "agent_b", "p", options),
    ).rejects.toThrow(/initiator agent not found/);
  });

  it("checks capacity before writing any rows", async () => {
    const { mesh, negotiationRepo } = makeMesh({ running: 5 });
    await expect(
      mesh.sendNegotiate("agent_a", "agent_b", "p", options),
    ).rejects.toMatchObject({ code: "MESH_CAPACITY_EXCEEDED" });
    expect(negotiationRepo.create).not.toHaveBeenCalled();
  });
});

describe("MeshServer.respondNegotiate", () => {
  function reply(overrides: Record<string, unknown> = {}) {
    return {
      negotiation_id: "neg_1",
      from_agent_id: "agent_b",
      decision: "accept" as const,
      message: "deal",
      ...overrides,
    };
  }

  it("persists the round and closes an accepted negotiation", async () => {
    const { mesh, negotiationRepo, negotiationRoundRepo } = makeMesh();
    const result = await mesh.respondNegotiate("neg_1", reply(), "ses_b");

    expect(result).toBeNull();
    expect(negotiationRoundRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        round_number: 2,
        from_agent_id: "agent_b",
        decision: "accept",
      }),
    );
    expect(negotiationRepo.update).toHaveBeenCalledWith("neg_1", {
      rounds_completed: 2,
    });
    expect(negotiationRepo.update).toHaveBeenCalledWith("neg_1", {
      status: "accepted",
    });
  });

  it("closes a rejected negotiation as rejected", async () => {
    const { mesh, negotiationRepo } = makeMesh();
    await mesh.respondNegotiate("neg_1", reply({ decision: "reject" }), "ses_b");
    expect(negotiationRepo.update).toHaveBeenCalledWith("neg_1", {
      status: "rejected",
    });
  });

  it("stamps the counterparty session id on the first reply from B", async () => {
    const { mesh, negotiationRepo } = makeMesh();
    await mesh.respondNegotiate("neg_1", reply(), "ses_b");
    expect(negotiationRepo.update).toHaveBeenCalledWith("neg_1", {
      counterparty_session_id: "ses_b",
    });
  });

  it("does not re-stamp the session id once it is set", async () => {
    const { mesh, negotiationRepo } = makeMesh({
      negotiation: {
        id: "neg_1",
        status: "active",
        rounds_completed: 1,
        max_rounds: 5,
        initiator_agent_id: "agent_a",
        counterparty_agent_id: "agent_b",
        counterparty_session_id: "ses_b",
      } as Partial<Negotiation>,
    });
    await mesh.respondNegotiate("neg_1", reply(), "ses_b_other");

    const updates = (negotiationRepo.update as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[1],
    );
    expect(updates).not.toContainEqual(
      expect.objectContaining({ counterparty_session_id: expect.anything() }),
    );
  });

  it("does not stamp the session id for a reply from the initiator", async () => {
    const { mesh, negotiationRepo } = makeMesh();
    await mesh.respondNegotiate("neg_1", reply({ from_agent_id: "agent_a" }), "ses_a");

    const updates = (negotiationRepo.update as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[1],
    );
    expect(updates).not.toContainEqual(
      expect.objectContaining({ counterparty_session_id: expect.anything() }),
    );
  });

  it("resolves the initiator waiting on round 1", async () => {
    const { mesh } = makeMesh();
    const initiator = mesh.sendNegotiate("agent_a", "agent_b", "p", {
      initiatorSessionId: "ses_a",
    });
    await tick();

    const counter = reply({ decision: "counter", counter_proposal: "Tuesday" });
    void mesh.respondNegotiate("neg_1", counter, "ses_b");

    await expect(initiator).resolves.toMatchObject({
      decision: "counter",
      counter_proposal: "Tuesday",
    });
  });

  it("blocks the countering side until the peer replies", async () => {
    const { mesh } = makeMesh();
    const initiator = mesh.sendNegotiate("agent_a", "agent_b", "p", {
      initiatorSessionId: "ses_a",
    });
    await tick();

    // B counters — resolves A, and B is now the blocked side.
    const bWaiting = mesh.respondNegotiate(
      "neg_1",
      reply({ decision: "counter", counter_proposal: "Tuesday" }),
      "ses_b",
    );
    await initiator;
    await tick();

    // A replies; B's pending promise resolves with A's message.
    void mesh.respondNegotiate(
      "neg_1",
      reply({ from_agent_id: "agent_a", decision: "accept", message: "fine" }),
      "ses_a",
    );
    await expect(bWaiting).resolves.toMatchObject({
      from_agent_id: "agent_a",
      decision: "accept",
    });
  });

  it("rejects an unknown negotiation", async () => {
    const { mesh } = makeMesh({ negotiation: null });
    await expect(mesh.respondNegotiate("neg_x", reply(), "ses_b")).rejects.toThrow(
      /negotiation neg_x not found/,
    );
  });

  it.each(["accepted", "rejected", "escalated"])(
    "rejects a reply on a %s negotiation",
    async (status) => {
      const { mesh } = makeMesh({
        negotiation: {
          id: "neg_1",
          status,
          rounds_completed: 2,
          max_rounds: 5,
        } as unknown as Partial<Negotiation>,
      });
      await expect(mesh.respondNegotiate("neg_1", reply(), "ses_b")).rejects.toThrow(
        new RegExp(`is not active \\(status='${status}'\\)`),
      );
    },
  );

  it("lets B complete the final exchange without tripping the cap", async () => {
    // max_rounds 2 = 4 rows. Row 4 is B completing exchange 2.
    const { mesh, negotiationRoundRepo } = makeMesh({
      negotiation: {
        id: "neg_1",
        status: "active",
        rounds_completed: 3,
        max_rounds: 2,
        initiator_agent_id: "agent_a",
        counterparty_agent_id: "agent_b",
        counterparty_session_id: "ses_b",
      } as Partial<Negotiation>,
    });
    await mesh.respondNegotiate("neg_1", reply(), "ses_b");
    expect(negotiationRoundRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ round_number: 4 }),
    );
  });

  it("throws MAX_ROUNDS_EXCEEDED when the next row would start a new exchange past the cap", async () => {
    // rounds_completed 4 → row 5 starts exchange 3, past a cap of 2.
    const { mesh, negotiationRoundRepo } = makeMesh({
      negotiation: {
        id: "neg_1",
        status: "active",
        rounds_completed: 4,
        max_rounds: 2,
        initiator_agent_id: "agent_a",
        counterparty_agent_id: "agent_b",
        counterparty_session_id: "ses_b",
      } as Partial<Negotiation>,
    });
    await expect(
      mesh.respondNegotiate("neg_1", reply({ from_agent_id: "agent_a" }), "ses_a"),
    ).rejects.toMatchObject({
      code: "MAX_ROUNDS_EXCEEDED",
      meta: { negotiationId: "neg_1", rounds_completed: 4, max_rounds: 2 },
    });
    expect(negotiationRoundRepo.create).not.toHaveBeenCalled();
  });
});

describe("MeshServer.unblockOnEscalate", () => {
  it("hands the blocked initiator the escalated sentinel", async () => {
    const { mesh } = makeMesh();
    const initiator = mesh.sendNegotiate("agent_a", "agent_b", "p", {
      initiatorSessionId: "ses_a",
    });
    await tick();

    mesh.unblockOnEscalate("neg_1", "esc_9");

    await expect(initiator).resolves.toMatchObject({
      decision: "escalated",
      escalation_id: "esc_9",
      negotiation_id: "neg_1",
    });
  });

  it("tells the unblocked side exactly which tool to call next", async () => {
    const { mesh } = makeMesh();
    const initiator = mesh.sendNegotiate("agent_a", "agent_b", "p", {
      initiatorSessionId: "ses_a",
    });
    await tick();
    mesh.unblockOnEscalate("neg_1", "esc_9");

    const sentinel = (await initiator) as { message: string };
    expect(sentinel.message).toContain('add_to_escalation(escalation_id="esc_9"');
  });

  it("is a no-op when both sides have already exited", () => {
    const { mesh } = makeMesh();
    expect(() => mesh.unblockOnEscalate("neg_none", "esc_9")).not.toThrow();
  });
});

describe("MeshServer.reportBlocker", () => {
  it("spawns the parent with the blocker context, fire-and-forget", async () => {
    const { mesh, dispatchCalls } = makeMesh();
    mesh.reportBlocker("agent_parent", "agent_child", "task_7", "vendor API is down");
    await tick();

    const call = dispatchCalls[0]!;
    expect(call).toMatchObject({
      agentId: "agent_parent",
      type: "blocker",
      callerAgentId: "agent_child",
    });
    expect(call.intent).toContain('from="agent_child"');
    expect(call.intent).toContain('task_id="task_7"');
    expect(call.intent).toContain("vendor API is down");
    // The parent is pointed at the canonical unblock path.
    expect(call.intent).toContain('revise_task(task_id="task_7"');
  });

  it("does not pre-mint a session id — nobody is waiting on the parent", async () => {
    const { mesh, dispatchCalls } = makeMesh();
    mesh.reportBlocker("agent_parent", "agent_child", "task_7", "stuck");
    await tick();
    expect(dispatchCalls[0]!.sessionIdOverride).toBeUndefined();
  });

  it("skips the capacity check — blockers must always reach the parent", async () => {
    const { mesh, dispatchCalls } = makeMesh({ running: 99 });
    mesh.reportBlocker("agent_parent", "agent_child", "task_7", "stuck");
    await tick();
    expect(dispatchCalls).toHaveLength(1);
  });
});
