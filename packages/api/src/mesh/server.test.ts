/**
 * MeshServer unit tests. Focused on the failure-propagation path —
 * when a callee session terminates non-success, the caller's pending
 * `ask`/`negotiate` promise must reject within a tick instead of sitting
 * through the 5-minute resolver timeout (which surfaces to the MCP layer
 * as a generic "transport dropped" error).
 */

import { describe, expect, it, vi } from "vitest";
import type {
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
import {
  CannotNegotiateWithIcError,
  MeshCapacityError,
  MeshMaxRoundsError,
  type NegotiateResponse,
} from "./types.js";

type DispatchCall = {
  agentId: string;
  type?: string;
  intent?: string;
  sessionIdOverride?: string;
  callerAgentId?: string;
};

function fakeNegotiation(overrides: Partial<Negotiation> = {}): Negotiation {
  return {
    id: "neg_1",
    initiator_agent_id: "agent_a",
    initiator_session_id: "sess_a",
    counterparty_agent_id: "agent_b",
    max_rounds: 5,
    rounds_completed: 1,
    status: "active",
    created_at: new Date("2026-05-01"),
    updated_at: new Date("2026-05-01"),
    ...overrides,
  };
}

function makeMesh(
  overrides: {
    agentRepo?: Partial<AgentRepository>;
    sessionRepo?: Partial<SessionRepository>;
    negotiationRepo?: Partial<NegotiationRepository>;
    negotiationRoundRepo?: Partial<NegotiationRoundRepository>;
    dispatchService?: Partial<DispatchService>;
  } = {},
) {
  const dispatchCalls: DispatchCall[] = [];
  const dispatchService = {
    dispatchTask: vi.fn(async (opts: DispatchCall) => {
      dispatchCalls.push(opts);
      // Return a minimal shape that satisfies the type — MeshServer
      // discards the return via `void`, so values don't matter.
      return {} as Awaited<ReturnType<DispatchService["dispatchTask"]>>;
    }),
    ...overrides.dispatchService,
  } as unknown as DispatchService;

  const agentRepo = {
    findById: vi.fn(async (id: string) => ({
      id,
      name: id,
      owner_id: "per_1",
      hierarchy_level: "team" as const,
      max_mesh_sessions: 5,
      max_negotiation_rounds: 5,
      runtime_config: { type: "claude" as const },
    })),
    ...overrides.agentRepo,
  } as unknown as AgentRepository;

  const sessionRepo = {
    countRunningByAgent: vi.fn(async () => 0),
    ...overrides.sessionRepo,
  } as unknown as SessionRepository;

  const negotiationRepo = {
    findById: vi.fn(async () => fakeNegotiation()),
    create: vi.fn(async (input: { id: string }) => fakeNegotiation(input as Partial<Negotiation>)),
    update: vi.fn(async (id: string, patch: Partial<Negotiation>) =>
      fakeNegotiation({ id, ...patch }),
    ),
    ...overrides.negotiationRepo,
  } as unknown as NegotiationRepository;

  const negotiationRoundRepo = {
    create: vi.fn(async (input: unknown) => input),
    ...overrides.negotiationRoundRepo,
  } as unknown as NegotiationRoundRepository;

  const mesh = new MeshServer({
    agentRepo,
    sessionRepo,
    sessionEventRepo: {} as SessionEventRepository,
    negotiationRepo,
    negotiationRoundRepo,
    workspaceManager: {} as WorkspaceManager,
    runtimeRegistry: {} as RuntimeRegistry,
    dispatchService,
    makeMemoryAgent: () => ({}) as never,
  });

  return { mesh, dispatchCalls, agentRepo, sessionRepo, negotiationRepo, negotiationRoundRepo };
}

/** Lets the spawned dispatch land before the test inspects the call log. */
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

// ── Capacity gate ────────────────────────────────────────────────────────
//
// The fail-fast in front of every spawn. Without it a hot agent accrues
// unbounded mesh sessions, each one a real CLI subprocess.

describe("MeshServer capacity gate", () => {
  it("refuses an ask once the target is at its mesh cap", async () => {
    const { mesh, dispatchCalls } = makeMesh({
      agentRepo: {
        findById: vi.fn(async (id: string) => ({ id, max_mesh_sessions: 2 })),
      } as unknown as Partial<AgentRepository>,
      sessionRepo: { countRunningByAgent: vi.fn(async () => 2) },
    });

    await expect(mesh.sendAsk("req_1", "agent_a", "agent_b", "q?")).rejects.toThrow(
      MeshCapacityError,
    );
    // The gate is in front of the spawn, not beside it.
    expect(dispatchCalls).toHaveLength(0);
  });

  it("carries the running/cap numbers on the error for the tool envelope", async () => {
    const { mesh } = makeMesh({
      agentRepo: {
        findById: vi.fn(async (id: string) => ({ id, max_mesh_sessions: 3 })),
      } as unknown as Partial<AgentRepository>,
      sessionRepo: { countRunningByAgent: vi.fn(async () => 4) },
    });

    await expect(mesh.sendAsk("req_1", "agent_a", "agent_b", "q?")).rejects.toMatchObject({
      code: "MESH_CAPACITY_EXCEEDED",
      meta: { agentId: "agent_b", running: 4, cap: 3 },
    });
  });

  it("defaults the cap to 3 when the agent row doesn't set one", async () => {
    const { mesh, sessionRepo } = makeMesh({
      agentRepo: {
        findById: vi.fn(async (id: string) => ({ id, max_mesh_sessions: undefined })),
      } as unknown as Partial<AgentRepository>,
      sessionRepo: { countRunningByAgent: vi.fn(async () => 3) },
    });

    await expect(mesh.sendAsk("req_1", "agent_a", "agent_b", "q?")).rejects.toMatchObject({
      meta: { cap: 3 },
    });
    // Only the three mesh session types count — a long chat or task
    // session must not block an ask.
    expect(sessionRepo.countRunningByAgent).toHaveBeenCalledWith("agent_b", [
      "mesh_ask",
      "mesh_negotiate",
      "blocker",
    ]);
  });

  it("errors when the target agent doesn't exist", async () => {
    const { mesh } = makeMesh({
      agentRepo: { findById: vi.fn(async () => undefined) },
    });
    await expect(mesh.sendAsk("req_1", "agent_a", "agent_ghost", "q?")).rejects.toThrow(
      /target agent not found: agent_ghost/,
    );
  });
});

// ── ASK spawn shape ──────────────────────────────────────────────────────

describe("MeshServer.sendAsk", () => {
  it("spawns the target with an intent that names the responding tool", async () => {
    const { mesh, dispatchCalls } = makeMesh();
    void mesh.sendAsk("req_1", "agent_a", "agent_b", "where does retry live?");
    await tick();

    expect(dispatchCalls).toHaveLength(1);
    const call = dispatchCalls[0]!;
    expect(call).toMatchObject({
      agentId: "agent_b",
      type: "mesh_ask",
      callerAgentId: "agent_a",
    });
    // The question and the request id have to survive into the intent —
    // B answers by calling respond_ask with that exact id, and an answer
    // posted in chat alone never reaches the asker.
    expect(call.intent).toContain("where does retry live?");
    expect(call.intent).toContain('request_id="req_1"');
    expect(call.intent).toContain("respond_ask");
  });

  it("escapes the ids it interpolates into intent attributes", async () => {
    const { mesh, dispatchCalls } = makeMesh();
    void mesh.sendAsk('req"><x', "agent_a", "agent_b", "q?");
    await tick();

    // The attribute value must not be able to close its own attribute.
    const intent = dispatchCalls[0]!.intent!;
    const attr = intent.match(/request_id="([^"]*)"/)![1]!;
    expect(attr).not.toContain('"');
    expect(attr).toContain("&quot;");
  });

  it("logs and swallows a dispatch failure rather than rejecting unhandled", async () => {
    // The spawn is fire-and-forget (`void`), so a throwing dispatch would
    // otherwise surface as an unhandled rejection and take the api process
    // down under Node's default policy.
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const { mesh } = makeMesh({
      dispatchService: {
        dispatchTask: vi.fn(async () => {
          throw new Error("no runtime online");
        }),
      },
    });

    void mesh.sendAsk("req_1", "agent_a", "agent_b", "q?");
    await tick();

    expect(consoleErr).toHaveBeenCalledWith(
      expect.stringContaining("[mesh] dispatch for agent_b (mesh_ask) failed:"),
      "no runtime online",
    );
    consoleErr.mockRestore();
  });

  it("times out the resolver when the callee never responds", async () => {
    vi.useFakeTimers();
    try {
      const { mesh } = makeMesh();
      const ask = mesh.sendAsk("req_slow", "agent_a", "agent_b", "q?");
      // Attach the rejection handler before the clock moves — the timer
      // fires inside advanceTimersByTimeAsync, and an unhandled reject
      // there fails the run even though the assertion would pass.
      const rejected = expect(ask).rejects.toThrow(
        /mesh resolver timeout \(300000ms\) for req_slow:asker/,
      );
      // Let the pre-spawn awaits settle so the resolver is registered.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await rejected;
      // The timed-out resolver is gone, so a late respond_ask is a no-op.
      expect(() =>
        mesh.respondAsk("req_slow", {
          request_id: "req_slow",
          from_agent_id: "agent_b",
          answer: "late",
        }),
      ).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── NEGOTIATE: round 1 ───────────────────────────────────────────────────

describe("MeshServer.sendNegotiate", () => {
  function icTarget() {
    return makeMesh({
      agentRepo: {
        findById: vi.fn(async (id: string) => ({
          id,
          hierarchy_level: id === "agent_ic" ? ("ic" as const) : ("team" as const),
          max_mesh_sessions: 5,
          max_negotiation_rounds: 5,
        })),
      } as unknown as Partial<AgentRepository>,
    });
  }

  it("refuses an IC target before creating any row", async () => {
    // M9.1 dropped respond_negotiate from the IC tool set, so a
    // negotiation against an IC would block for the full 5-minute
    // timeout with nothing able to answer it.
    const { mesh, negotiationRepo, dispatchCalls } = icTarget();

    await expect(
      mesh.sendNegotiate("agent_a", "agent_ic", "split the work", {
        initiatorSessionId: "sess_a",
      }),
    ).rejects.toThrow(CannotNegotiateWithIcError);
    expect(negotiationRepo.create).not.toHaveBeenCalled();
    expect(dispatchCalls).toHaveLength(0);
  });

  it("errors on an unknown target or unknown initiator", async () => {
    const missingTarget = makeMesh({ agentRepo: { findById: vi.fn(async () => undefined) } });
    await expect(
      missingTarget.mesh.sendNegotiate("agent_a", "agent_ghost", "p", {
        initiatorSessionId: "sess_a",
      }),
    ).rejects.toThrow(/target agent not found: agent_ghost/);

    const missingInitiator = makeMesh({
      agentRepo: {
        findById: vi.fn(async (id: string) =>
          id === "agent_b" ? { id, hierarchy_level: "team" as const, max_mesh_sessions: 5 } : undefined,
        ),
      } as unknown as Partial<AgentRepository>,
    });
    await expect(
      missingInitiator.mesh.sendNegotiate("agent_ghost", "agent_b", "p", {
        initiatorSessionId: "sess_a",
      }),
    ).rejects.toThrow(/initiator agent not found: agent_ghost/);
  });

  it("creates the negotiation, inserts round 1 and bumps rounds_completed", async () => {
    const { mesh, negotiationRepo, negotiationRoundRepo, dispatchCalls } = makeMesh();
    void mesh.sendNegotiate("agent_a", "agent_b", "ship behind a flag", {
      initiatorSessionId: "sess_a",
      taskId: "task_7",
    });
    await tick();

    expect(negotiationRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        initiator_agent_id: "agent_a",
        initiator_session_id: "sess_a",
        counterparty_agent_id: "agent_b",
        task_id: "task_7",
        max_rounds: 5,
      }),
    );
    // Round 1 is the initiator's proposal, and rounds_completed must move
    // with it — otherwise B's first respond_negotiate retries
    // round_number=1 and trips the UNIQUE constraint on negotiation_round.
    expect(negotiationRoundRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        round_number: 1,
        from_agent_id: "agent_a",
        decision: "propose",
        message: "ship behind a flag",
      }),
    );
    expect(negotiationRepo.update).toHaveBeenCalledWith(expect.any(String), {
      rounds_completed: 1,
    });

    expect(dispatchCalls[0]).toMatchObject({
      agentId: "agent_b",
      type: "mesh_negotiate",
      callerAgentId: "agent_a",
    });
    expect(dispatchCalls[0]!.intent).toContain("ship behind a flag");
    expect(dispatchCalls[0]!.intent).toContain('round="1"');
  });

  it("stamps the initiator's own max_negotiation_rounds, defaulting to 5", async () => {
    const custom = makeMesh({
      agentRepo: {
        findById: vi.fn(async (id: string) => ({
          id,
          hierarchy_level: "team" as const,
          max_mesh_sessions: 5,
          max_negotiation_rounds: id === "agent_a" ? 2 : 9,
        })),
      } as unknown as Partial<AgentRepository>,
    });
    void custom.mesh.sendNegotiate("agent_a", "agent_b", "p", { initiatorSessionId: "sess_a" });
    await tick();
    // The cap comes from whoever opened the negotiation, not the target.
    expect(custom.negotiationRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ max_rounds: 2 }),
    );

    const unset = makeMesh({
      agentRepo: {
        findById: vi.fn(async (id: string) => ({
          id,
          hierarchy_level: "team" as const,
          max_mesh_sessions: 5,
          max_negotiation_rounds: undefined,
        })),
      } as unknown as Partial<AgentRepository>,
    });
    void unset.mesh.sendNegotiate("agent_a", "agent_b", "p", { initiatorSessionId: "sess_a" });
    await tick();
    expect(unset.negotiationRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ max_rounds: 5 }),
    );
  });

  it("blocks the initiator until the responder's first respond_negotiate", async () => {
    const { mesh, negotiationRepo } = makeMesh();
    const pending = mesh.sendNegotiate("agent_a", "agent_b", "p", {
      initiatorSessionId: "sess_a",
    });
    await tick();

    // sendNegotiate mints the id, so the resolver key is only knowable
    // from the row it created.
    const negId = (
      vi.mocked(negotiationRepo.create).mock.calls[0]![0] as { id: string }
    ).id;
    vi.mocked(negotiationRepo.findById).mockResolvedValue(
      fakeNegotiation({ id: negId, counterparty_session_id: undefined }),
    );

    const bReply: NegotiateResponse = {
      negotiation_id: negId,
      from_agent_id: "agent_b",
      decision: "accept",
      message: "works for me",
    };
    void mesh.respondNegotiate(negId, bReply, "sess_b");

    await expect(pending).resolves.toEqual(bReply);
  });
});

// ── NEGOTIATE: rounds 2..n ───────────────────────────────────────────────
//
// After round 1 both sides call respondNegotiate, and the server has to
// work out which side is currently blocked, whether this reply ends the
// negotiation, and whether the next insert would exceed the exchange cap.

describe("MeshServer.respondNegotiate", () => {
  const reply = (overrides: Partial<NegotiateResponse> = {}): NegotiateResponse => ({
    negotiation_id: "neg_1",
    from_agent_id: "agent_b",
    decision: "counter",
    message: "how about this instead",
    ...overrides,
  });

  it("rejects an unknown negotiation", async () => {
    const { mesh } = makeMesh({ negotiationRepo: { findById: vi.fn(async () => undefined) } });
    await expect(mesh.respondNegotiate("neg_404", reply(), "sess_b")).rejects.toThrow(
      /negotiation neg_404 not found/,
    );
  });

  it("rejects a negotiation that has already closed", async () => {
    // Without this an accepted negotiation could take further rounds and
    // keep inserting rows after both sides believed it settled.
    for (const status of ["accepted", "rejected", "escalated"] as const) {
      const { mesh, negotiationRoundRepo } = makeMesh({
        negotiationRepo: { findById: vi.fn(async () => fakeNegotiation({ status })) },
      });
      await expect(mesh.respondNegotiate("neg_1", reply(), "sess_b")).rejects.toThrow(
        new RegExp(`not active \\(status='${status}'\\)`),
      );
      expect(negotiationRoundRepo.create).not.toHaveBeenCalled();
    }
  });

  it("stamps the counterparty session id on B's first reply only", async () => {
    const { mesh, negotiationRepo } = makeMesh({
      negotiationRepo: {
        findById: vi.fn(async () => fakeNegotiation({ counterparty_session_id: undefined })),
      },
    });

    await mesh.respondNegotiate("neg_1", reply({ decision: "accept" }), "sess_b");

    expect(negotiationRepo.update).toHaveBeenCalledWith("neg_1", {
      counterparty_session_id: "sess_b",
    });
  });

  it("does not re-stamp once the column is set, nor for the initiator's replies", async () => {
    const alreadySet = makeMesh({
      negotiationRepo: {
        findById: vi.fn(async () => fakeNegotiation({ counterparty_session_id: "sess_b" })),
      },
    });
    await alreadySet.mesh.respondNegotiate("neg_1", reply({ decision: "accept" }), "sess_b2");
    expect(vi.mocked(alreadySet.negotiationRepo.update).mock.calls).not.toContainEqual([
      "neg_1",
      { counterparty_session_id: "sess_b2" },
    ]);

    // A's own reply must never write its session into the counterparty
    // column — the FK would point at the wrong side of the negotiation.
    const fromInitiator = makeMesh({
      negotiationRepo: {
        findById: vi.fn(async () => fakeNegotiation({ counterparty_session_id: undefined })),
      },
    });
    await fromInitiator.mesh.respondNegotiate(
      "neg_1",
      reply({ from_agent_id: "agent_a", decision: "accept" }),
      "sess_a",
    );
    expect(vi.mocked(fromInitiator.negotiationRepo.update).mock.calls).not.toContainEqual([
      "neg_1",
      { counterparty_session_id: "sess_a" },
    ]);
  });

  it("counts two rows per user-facing exchange and caps on the exchange, not the row", async () => {
    // rows: 1 A-propose, 2 B-respond → exchange 1; 3 A-counter → exchange 2.
    // With max_rounds=2 the 5th row would open exchange 3 and must refuse,
    // while the 4th (completing exchange 2) must still go through.
    const allowed = makeMesh({
      negotiationRepo: {
        findById: vi.fn(async () => fakeNegotiation({ max_rounds: 2, rounds_completed: 3 })),
      },
    });
    await expect(
      allowed.mesh.respondNegotiate("neg_1", reply({ decision: "accept" }), "sess_b"),
    ).resolves.toBeNull();
    expect(allowed.negotiationRoundRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ round_number: 4 }),
    );

    const capped = makeMesh({
      negotiationRepo: {
        findById: vi.fn(async () => fakeNegotiation({ max_rounds: 2, rounds_completed: 4 })),
      },
    });
    await expect(
      capped.mesh.respondNegotiate("neg_1", reply(), "sess_b"),
    ).rejects.toThrow(MeshMaxRoundsError);
    // Nothing is persisted on the refusal — the agent is expected to
    // escalate instead, and a half-inserted round would skew the count.
    expect(capped.negotiationRoundRepo.create).not.toHaveBeenCalled();
  });

  it("carries the round numbers on MeshMaxRoundsError so the agent can explain itself", async () => {
    const { mesh } = makeMesh({
      negotiationRepo: {
        findById: vi.fn(async () => fakeNegotiation({ max_rounds: 3, rounds_completed: 6 })),
      },
    });
    await expect(mesh.respondNegotiate("neg_1", reply(), "sess_b")).rejects.toMatchObject({
      code: "MAX_ROUNDS_EXCEEDED",
      meta: { negotiationId: "neg_1", rounds_completed: 6, max_rounds: 3 },
    });
  });

  it("persists the round and advances rounds_completed", async () => {
    const { mesh, negotiationRepo, negotiationRoundRepo } = makeMesh({
      negotiationRepo: {
        findById: vi.fn(async () =>
          fakeNegotiation({ rounds_completed: 2, counterparty_session_id: "sess_b" }),
        ),
      },
    });

    await mesh.respondNegotiate(
      "neg_1",
      reply({ from_agent_id: "agent_a", decision: "reject", message: "no" }),
      "sess_a",
    );

    expect(negotiationRoundRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        negotiation_id: "neg_1",
        round_number: 3,
        from_agent_id: "agent_a",
        decision: "reject",
        message: "no",
      }),
    );
    expect(negotiationRepo.update).toHaveBeenCalledWith("neg_1", { rounds_completed: 3 });
  });

  it("closes the negotiation on accept and on reject, returning null", async () => {
    for (const [decision, status] of [
      ["accept", "accepted"],
      ["reject", "rejected"],
    ] as const) {
      const { mesh, negotiationRepo } = makeMesh({
        negotiationRepo: {
          findById: vi.fn(async () => fakeNegotiation({ counterparty_session_id: "sess_b" })),
        },
      });
      // null is the terminal signal — the caller exits rather than
      // blocking for a peer reply that will never come.
      await expect(mesh.respondNegotiate("neg_1", reply({ decision }), "sess_b")).resolves.toBeNull();
      expect(negotiationRepo.update).toHaveBeenCalledWith("neg_1", { status });
    }
  });

  it("on counter, resolves the blocked peer and blocks the responder on the opposite key", async () => {
    const { mesh, negotiationRepo } = makeMesh();
    // Put A in the blocked state sendNegotiate would leave them in.
    const aPending = mesh.sendNegotiate("agent_a", "agent_b", "p", {
      initiatorSessionId: "sess_a",
    });
    await tick();
    const negId = (vi.mocked(negotiationRepo.create).mock.calls[0]![0] as { id: string }).id;
    vi.mocked(negotiationRepo.findById).mockResolvedValue(
      fakeNegotiation({ id: negId, rounds_completed: 1, counterparty_session_id: "sess_b" }),
    );

    const bCounter = reply({ negotiation_id: negId, decision: "counter" });
    const bPending = mesh.respondNegotiate(negId, bCounter, "sess_b");

    // A's blocked call returns B's counter...
    await expect(aPending).resolves.toEqual(bCounter);

    // ...and B is now the blocked side. A's next reply releases it.
    vi.mocked(negotiationRepo.findById).mockResolvedValue(
      fakeNegotiation({ id: negId, rounds_completed: 2, counterparty_session_id: "sess_b" }),
    );
    const aAccept = reply({
      negotiation_id: negId,
      from_agent_id: "agent_a",
      decision: "accept",
      message: "deal",
    });
    await mesh.respondNegotiate(negId, aAccept, "sess_a");
    await expect(bPending).resolves.toEqual(aAccept);
  });
});

// ── Escalation sentinel ──────────────────────────────────────────────────

describe("MeshServer.unblockOnEscalate", () => {
  it("releases the blocked side with a sentinel that names the next call", async () => {
    const { mesh, negotiationRepo } = makeMesh();
    const aPending = mesh.sendNegotiate("agent_a", "agent_b", "p", {
      initiatorSessionId: "sess_a",
    });
    await tick();
    const negId = (vi.mocked(negotiationRepo.create).mock.calls[0]![0] as { id: string }).id;

    mesh.unblockOnEscalate(negId, "esc_9");

    const settled = await aPending;
    expect(settled).toEqual({
      decision: "escalated",
      message: expect.stringContaining('add_to_escalation(escalation_id="esc_9"'),
      escalation_id: "esc_9",
      negotiation_id: negId,
    });
  });

  it("is a no-op when neither side is blocked", () => {
    // escalate_to_humans can land after both agents have already exited.
    const { mesh } = makeMesh();
    expect(() => mesh.unblockOnEscalate("neg_gone", "esc_1")).not.toThrow();
  });

  it("releases the responder when it is the waiting side", async () => {
    const { mesh, negotiationRepo } = makeMesh();
    const aPending = mesh.sendNegotiate("agent_a", "agent_b", "p", {
      initiatorSessionId: "sess_a",
    });
    await tick();
    const negId = (vi.mocked(negotiationRepo.create).mock.calls[0]![0] as { id: string }).id;
    vi.mocked(negotiationRepo.findById).mockResolvedValue(
      fakeNegotiation({ id: negId, rounds_completed: 1, counterparty_session_id: "sess_b" }),
    );

    // B counters: A unblocks, B becomes the blocked side.
    const bPending = mesh.respondNegotiate(
      negId,
      { negotiation_id: negId, from_agent_id: "agent_b", decision: "counter", message: "c" },
      "sess_b",
    );
    await aPending;

    mesh.unblockOnEscalate(negId, "esc_9");
    await expect(bPending).resolves.toMatchObject({
      decision: "escalated",
      escalation_id: "esc_9",
    });
  });
});

// ── report_blocker ───────────────────────────────────────────────────────

describe("MeshServer.reportBlocker", () => {
  it("dispatches the parent with the two unblock options spelled out", async () => {
    const { mesh, dispatchCalls } = makeMesh();
    mesh.reportBlocker("agent_parent", "agent_ic", "task_5", "the migration won't apply");
    await tick();

    expect(dispatchCalls).toHaveLength(1);
    const call = dispatchCalls[0]!;
    expect(call).toMatchObject({
      agentId: "agent_parent",
      type: "blocker",
      callerAgentId: "agent_ic",
    });
    expect(call.intent).toContain("the migration won't apply");
    // revise_task is the canonical unblock path, so the blocker intent has
    // to point the parent at it with the right task id already filled in.
    expect(call.intent).toContain('revise_task(task_id="task_5"');
  });

  it("is fire-and-forget: it neither awaits a resolver nor gates on capacity", async () => {
    // A blocked subordinate must be able to report upward even when the
    // parent is already at mesh capacity — otherwise the blocker is lost.
    const { mesh, dispatchCalls, sessionRepo } = makeMesh({
      sessionRepo: { countRunningByAgent: vi.fn(async () => 99) },
    });
    expect(mesh.reportBlocker("agent_parent", "agent_ic", "task_5", "x")).toBeUndefined();
    await tick();
    expect(dispatchCalls).toHaveLength(1);
    expect(sessionRepo.countRunningByAgent).not.toHaveBeenCalled();
    // No pre-minted callee session, so nothing is indexed as a waiter.
    expect(dispatchCalls[0]!.sessionIdOverride).toBeUndefined();
  });
});

// ── Resolver bookkeeping edge cases ──────────────────────────────────────

describe("MeshServer resolver edge cases", () => {
  it("blocks a counter on the initiator key when no side is currently waiting", async () => {
    // Reachable when the initiator's resolver already timed out (or the
    // api restarted and lost the map) and B counters anyway. B must still
    // park on a key the peer's next reply can find.
    const { mesh, negotiationRepo } = makeMesh({
      negotiationRepo: {
        findById: vi.fn(async () =>
          fakeNegotiation({ rounds_completed: 1, counterparty_session_id: "sess_b" }),
        ),
      },
    });

    const bPending = mesh.respondNegotiate(
      "neg_1",
      { negotiation_id: "neg_1", from_agent_id: "agent_b", decision: "counter", message: "c" },
      "sess_b",
    );
    await tick();

    // Only the initiator key is live now, so A's reply releases B.
    const aReply: NegotiateResponse = {
      negotiation_id: "neg_1",
      from_agent_id: "agent_a",
      decision: "accept",
      message: "ok",
    };
    vi.mocked(negotiationRepo.findById).mockResolvedValue(
      fakeNegotiation({ rounds_completed: 2, counterparty_session_id: "sess_b" }),
    );
    await mesh.respondNegotiate("neg_1", aReply, "sess_a");
    await expect(bPending).resolves.toEqual(aReply);
  });

  it("registers no callee index when the negotiation has no counterparty session yet", async () => {
    const { mesh } = makeMesh({
      negotiationRepo: {
        findById: vi.fn(async () =>
          fakeNegotiation({ rounds_completed: 1, counterparty_session_id: undefined }),
        ),
      },
    });

    void mesh.respondNegotiate(
      "neg_1",
      { negotiation_id: "neg_1", from_agent_id: "agent_a", decision: "counter", message: "c" },
      "sess_a",
    );
    await tick();

    // Nothing to key the reverse index by, so no session-failure fast-path
    // exists for this waiter — it falls back to the 5-minute timeout.
    expect(mesh.hasPendingCalleeSession("sess_a")).toBe(false);
    expect(mesh.hasPendingCalleeSession("sess_b")).toBe(false);
  });

  it("logs a non-Error dispatch rejection without stringifying undefined", async () => {
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const { mesh } = makeMesh({
      dispatchService: {
        // A rejected non-Error (a string here) has no `.message`, so the
        // log would print `undefined` if it assumed Error.
        dispatchTask: vi.fn(async () => Promise.reject("ECONNREFUSED")),
      },
    });

    void mesh.sendAsk("req_1", "agent_a", "agent_b", "q?");
    await tick();

    expect(consoleErr).toHaveBeenCalledWith(
      expect.stringContaining("[mesh] dispatch for agent_b (mesh_ask) failed:"),
      "ECONNREFUSED",
    );
    consoleErr.mockRestore();
  });
});
