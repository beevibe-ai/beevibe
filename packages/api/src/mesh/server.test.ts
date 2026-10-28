/**
 * MeshServer unit tests — the in-process A2A broker behind the mesh tool
 * surface. All fakes, no DB: the repos are in-memory maps and
 * `dispatchService.dispatchTask` records its calls instead of spawning.
 *
 * What's pinned here:
 *   - ASK: the spawned intent's wire shape, the pre-minted callee session
 *     id, and the capacity gate.
 *   - NEGOTIATE: the IC fast-reject, round-1 persistence, the
 *     exchange-vs-row cap arithmetic, the initiator/responder resolver
 *     flip that keeps the two sides blocked on alternating rounds, and
 *     the terminal accept/reject close-out.
 *   - Escalation sentinel-unblock, and the fire-and-forget blocker report.
 *   - Failure propagation: when a callee session dies, the caller's
 *     `ask`/`negotiate` promise must reject within a tick instead of
 *     sitting through the 5-minute resolver timeout (which surfaces to
 *     the MCP layer as a generic "transport dropped" error).
 *
 * Every test settles the promises it opens — a live resolver holds a
 * 5-minute timer and would keep the worker alive past teardown.
 */

import { describe, expect, it, vi } from "vitest";
import type {
  AgentRepository,
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

/** Let the awaited repo/capacity calls ahead of a spawn drain. */
const tick = () => new Promise((r) => setImmediate(r));

/** Fields merged under every `agentRepo.findById` hit. */
const DEFAULT_AGENT = {
  owner_id: "per_1",
  hierarchy_level: "team" as const,
  max_mesh_sessions: 5,
  max_negotiation_rounds: 5,
  runtime_config: { type: "claude" as const },
};

interface DispatchCall {
  agentId: string;
  intent: string;
  type: string;
  sessionIdOverride?: string;
  callerAgentId?: string;
}

interface HarnessOptions {
  /**
   * Per-agent-id overrides merged over DEFAULT_AGENT. An explicit `null`
   * makes `findById` miss, so the "agent not found" guards are reachable.
   */
  agents?: Record<string, Record<string, unknown> | null>;
  /** What `countRunningByAgent` reports for every agent. */
  running?: number;
  /** Makes the fire-and-forget dispatch reject, to reach its catch. */
  dispatchError?: Error;
}

type SeededNegotiation = Record<string, unknown> & { id: string };

function makeMesh(opts: HarnessOptions = {}) {
  const dispatchCalls: DispatchCall[] = [];
  const negotiations = new Map<string, SeededNegotiation>();
  const rounds: Array<Record<string, unknown>> = [];

  const dispatchTask = vi.fn(async (o: DispatchCall) => {
    dispatchCalls.push(o);
    if (opts.dispatchError) throw opts.dispatchError;
    // MeshServer discards the return via `void`, so the value is unused.
    return {} as Awaited<ReturnType<DispatchService["dispatchTask"]>>;
  });
  const dispatchService = { dispatchTask } as unknown as DispatchService;

  const findById = vi.fn(async (id: string) => {
    const override = opts.agents?.[id];
    if (override === null) return undefined;
    return { id, name: id, ...DEFAULT_AGENT, ...override };
  });

  const countRunningByAgent = vi.fn(async () => opts.running ?? 0);

  const negotiationRepo = {
    create: vi.fn(async (input: { id: string } & Record<string, unknown>) => {
      const neg = {
        ...input,
        rounds_completed: 0,
        status: "active",
        created_at: new Date(),
        updated_at: new Date(),
      } as SeededNegotiation;
      negotiations.set(neg.id, neg);
      return neg;
    }),
    findById: vi.fn(async (id: string) => negotiations.get(id)),
    update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      const current = negotiations.get(id);
      if (!current) throw new Error(`fake negotiationRepo: no row ${id}`);
      const next = { ...current, ...patch } as SeededNegotiation;
      negotiations.set(id, next);
      return next;
    }),
  };

  const negotiationRoundRepo = {
    create: vi.fn(async (input: Record<string, unknown>) => {
      rounds.push(input);
      return { ...input, sent_at: new Date() };
    }),
  };

  const mesh = new MeshServer({
    agentRepo: { findById } as unknown as AgentRepository,
    sessionRepo: { countRunningByAgent } as unknown as SessionRepository,
    sessionEventRepo: {} as SessionEventRepository,
    negotiationRepo: negotiationRepo as unknown as NegotiationRepository,
    negotiationRoundRepo: negotiationRoundRepo as unknown as NegotiationRoundRepository,
    workspaceManager: {} as WorkspaceManager,
    runtimeRegistry: {} as RuntimeRegistry,
    dispatchService,
    makeMemoryAgent: () => ({}) as never,
  });

  /** Drop a negotiation straight into the store, bypassing sendNegotiate. */
  function seedNegotiation(over: Record<string, unknown> = {}): SeededNegotiation {
    const neg = {
      id: "neg_seed",
      initiator_agent_id: "agent_a",
      initiator_session_id: "sess_a",
      counterparty_agent_id: "agent_b",
      max_rounds: 5,
      rounds_completed: 1,
      status: "active",
      created_at: new Date(),
      updated_at: new Date(),
      ...over,
    } as SeededNegotiation;
    negotiations.set(neg.id, neg);
    return neg;
  }

  return {
    mesh,
    dispatchCalls,
    negotiations,
    rounds,
    negotiationRepo,
    negotiationRoundRepo,
    countRunningByAgent,
    seedNegotiation,
  };
}

function counter(from: string, negotiationId = "neg_seed"): NegotiateResponse {
  return {
    negotiation_id: negotiationId,
    from_agent_id: from,
    decision: "counter",
    message: `counter from ${from}`,
  };
}

// ── ASK ───────────────────────────────────────────────────────────────────

describe("MeshServer.sendAsk", () => {
  it("dispatches a mesh_ask carrying the request id, asker and question", async () => {
    const { mesh, dispatchCalls } = makeMesh();
    const ask = mesh.sendAsk("req_1", "agent_caller", "agent_callee", "where is the spec?");
    await tick();

    const call = dispatchCalls[0];
    expect(call?.agentId).toBe("agent_callee");
    expect(call?.type).toBe("mesh_ask");
    // caller_agent_id is what lets the UI draw the ask edge (Phase 10).
    expect(call?.callerAgentId).toBe("agent_caller");
    expect(call?.intent).toContain('<mesh-ask request_id="req_1" from="agent_caller">');
    expect(call?.intent).toContain("where is the spec?");
    // The answer only reaches the asker through respond_ask, so the
    // intent has to say so — chat-only replies silently hang the caller.
    expect(call?.intent).toContain('respond_ask(request_id="req_1"');

    mesh.respondAsk("req_1", {
      request_id: "req_1",
      from_agent_id: "agent_callee",
      answer: "in docs/",
    });
    await expect(ask).resolves.toMatchObject({ answer: "in docs/" });
  });

  it("escapes the interpolated ids in the intent's XML attributes", async () => {
    const { mesh, dispatchCalls } = makeMesh();
    const ask = mesh.sendAsk('req_"1', 'a&b<c', "agent_callee", "q?");
    await tick();

    expect(dispatchCalls[0]?.intent).toContain(
      '<mesh-ask request_id="req_&quot;1" from="a&amp;b&lt;c">',
    );

    mesh.respondAsk('req_"1', {
      request_id: 'req_"1',
      from_agent_id: "agent_callee",
      answer: "a",
    });
    await expect(ask).resolves.toBeDefined();
  });

  it("pre-mints the callee session id and stamps it on the dispatch", async () => {
    const { mesh, dispatchCalls } = makeMesh();
    const ask = mesh.sendAsk("req_2", "agent_caller", "agent_callee", "q?");
    await tick();

    const sid = dispatchCalls[0]?.sessionIdOverride;
    expect(sid).toMatch(/^sess_/);
    // Pre-minting is what makes the reverse index possible before the
    // spawn has actually created the row.
    expect(mesh.hasPendingCalleeSession(sid!)).toBe(true);

    mesh.failResolverForCalleeSession(sid!, "cleanup");
    await expect(ask).rejects.toThrow();
  });

  it("fails fast with MeshCapacityError when the target is at its mesh cap", async () => {
    const { mesh, dispatchCalls, countRunningByAgent } = makeMesh({ running: 5 });

    await expect(
      mesh.sendAsk("req_3", "agent_caller", "agent_callee", "q?"),
    ).rejects.toBeInstanceOf(MeshCapacityError);
    // Gate is before the spawn: a capped target must not be dispatched to.
    expect(dispatchCalls).toHaveLength(0);
    // Only mesh-ish session types count toward the cap — a busy agent
    // running chats or tasks is still reachable over the mesh.
    expect(countRunningByAgent).toHaveBeenCalledWith("agent_callee", [
      "mesh_ask",
      "mesh_negotiate",
      "blocker",
    ]);
  });

  it("carries the running/cap counts on the capacity error for the tool envelope", async () => {
    const { mesh } = makeMesh({ running: 7, agents: { agent_callee: { max_mesh_sessions: 6 } } });

    await expect(
      mesh.sendAsk("req_4", "agent_caller", "agent_callee", "q?"),
    ).rejects.toMatchObject({
      code: "MESH_CAPACITY_EXCEEDED",
      meta: { agentId: "agent_callee", running: 7, cap: 6 },
    });
  });

  it("falls back to a cap of 3 when the agent has no max_mesh_sessions", async () => {
    const { mesh } = makeMesh({ running: 3, agents: { agent_callee: { max_mesh_sessions: null } } });

    await expect(
      mesh.sendAsk("req_5", "agent_caller", "agent_callee", "q?"),
    ).rejects.toMatchObject({ meta: { cap: 3 } });
  });

  it("rejects when the target agent does not exist", async () => {
    const { mesh } = makeMesh({ agents: { agent_ghost: null } });

    await expect(
      mesh.sendAsk("req_6", "agent_caller", "agent_ghost", "q?"),
    ).rejects.toThrow(/target agent not found: agent_ghost/);
  });

  it("swallows a dispatch failure rather than rejecting the caller", async () => {
    const boom = new Error("daemon unreachable");
    const { mesh, dispatchCalls } = makeMesh({ dispatchError: boom });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const ask = mesh.sendAsk("req_7", "agent_caller", "agent_callee", "q?");
      await tick();

      expect(errSpy).toHaveBeenCalledWith(
        "[mesh] dispatch for agent_callee (mesh_ask) failed:",
        "daemon unreachable",
      );
      // The spawn is fire-and-forget: the resolver, not the dispatch,
      // owns the caller's promise, so it stays open for respond_ask.
      expect(dispatchCalls).toHaveLength(1);
      mesh.respondAsk("req_7", {
        request_id: "req_7",
        from_agent_id: "agent_callee",
        answer: "late but fine",
      });
      await expect(ask).resolves.toMatchObject({ answer: "late but fine" });
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("MeshServer.respondAsk", () => {
  it("is a no-op for a request id nobody is waiting on", () => {
    const { mesh } = makeMesh();
    expect(() =>
      mesh.respondAsk("req_nobody", {
        request_id: "req_nobody",
        from_agent_id: "agent_callee",
        answer: "x",
      }),
    ).not.toThrow();
  });
});

// ── NEGOTIATE ─────────────────────────────────────────────────────────────

describe("MeshServer.sendNegotiate", () => {
  it("opens the negotiation, records round 1 and dispatches B", async () => {
    const { mesh, dispatchCalls, negotiations, rounds, negotiationRepo } = makeMesh();
    const negotiate = mesh.sendNegotiate("agent_a", "agent_b", "you take the API half", {
      initiatorSessionId: "sess_a",
      taskId: "task_1",
    });
    await tick();

    const neg = [...negotiations.values()][0]!;
    expect(neg).toMatchObject({
      initiator_agent_id: "agent_a",
      initiator_session_id: "sess_a",
      counterparty_agent_id: "agent_b",
      task_id: "task_1",
      // Stamped from the *initiator's* allowance, not the target's.
      max_rounds: 5,
      status: "active",
    });

    // Round 1 is the initiator's proposal, and rounds_completed is bumped
    // in the same step — otherwise B's first respond_negotiate recomputes
    // round_number=1 and trips the UNIQUE constraint.
    expect(rounds).toEqual([
      expect.objectContaining({
        negotiation_id: neg.id,
        round_number: 1,
        from_agent_id: "agent_a",
        decision: "propose",
        message: "you take the API half",
      }),
    ]);
    expect(negotiationRepo.update).toHaveBeenCalledWith(neg.id, { rounds_completed: 1 });

    const call = dispatchCalls[0];
    expect(call?.agentId).toBe("agent_b");
    expect(call?.type).toBe("mesh_negotiate");
    expect(call?.callerAgentId).toBe("agent_a");
    expect(call?.sessionIdOverride).toMatch(/^sess_/);
    expect(call?.intent).toContain(`<mesh-negotiate negotiation_id="${neg.id}" from="agent_a" round="1">`);
    expect(call?.intent).toContain("you take the API half");

    mesh.unblockOnEscalate(neg.id, "esc_cleanup");
    await expect(negotiate).resolves.toMatchObject({ decision: "escalated" });
  });

  it("takes max_rounds from the initiator, defaulting to 5", async () => {
    const { mesh, negotiations } = makeMesh({
      agents: {
        agent_a: { max_negotiation_rounds: null },
        agent_b: { max_negotiation_rounds: 99 },
      },
    });
    const negotiate = mesh.sendNegotiate("agent_a", "agent_b", "p", {
      initiatorSessionId: "sess_a",
    });
    await tick();

    const neg = [...negotiations.values()][0]!;
    expect(neg.max_rounds).toBe(5);

    mesh.unblockOnEscalate(neg.id, "esc_cleanup");
    await expect(negotiate).resolves.toBeDefined();
  });

  it("rejects an IC target before touching the DB or spawning", async () => {
    const { mesh, dispatchCalls, negotiations } = makeMesh({
      agents: { agent_ic: { hierarchy_level: "ic" } },
    });

    // ICs have no respond_negotiate (M9.1), so the negotiation would
    // otherwise hang until the 5-minute resolver timeout.
    await expect(
      mesh.sendNegotiate("agent_a", "agent_ic", "p", { initiatorSessionId: "sess_a" }),
    ).rejects.toBeInstanceOf(CannotNegotiateWithIcError);
    expect(negotiations.size).toBe(0);
    expect(dispatchCalls).toHaveLength(0);
  });

  it("tags the IC rejection with a machine-readable code and the target id", async () => {
    const { mesh } = makeMesh({ agents: { agent_ic: { hierarchy_level: "ic" } } });

    await expect(
      mesh.sendNegotiate("agent_a", "agent_ic", "p", { initiatorSessionId: "sess_a" }),
    ).rejects.toMatchObject({
      code: "CANNOT_NEGOTIATE_WITH_IC",
      meta: { agentId: "agent_ic" },
    });
  });

  it("rejects an unknown target, and an unknown initiator", async () => {
    const missingTarget = makeMesh({ agents: { agent_ghost: null } });
    await expect(
      missingTarget.mesh.sendNegotiate("agent_a", "agent_ghost", "p", {
        initiatorSessionId: "sess_a",
      }),
    ).rejects.toThrow(/target agent not found: agent_ghost/);

    const missingInitiator = makeMesh({ agents: { agent_ghost: null } });
    await expect(
      missingInitiator.mesh.sendNegotiate("agent_ghost", "agent_b", "p", {
        initiatorSessionId: "sess_a",
      }),
    ).rejects.toThrow(/initiator agent not found: agent_ghost/);
    expect(missingInitiator.negotiations.size).toBe(0);
  });

  it("applies the capacity gate before creating the negotiation row", async () => {
    const { mesh, negotiations, dispatchCalls } = makeMesh({ running: 5 });

    await expect(
      mesh.sendNegotiate("agent_a", "agent_b", "p", { initiatorSessionId: "sess_a" }),
    ).rejects.toBeInstanceOf(MeshCapacityError);
    // A capped target must leave no half-open negotiation behind.
    expect(negotiations.size).toBe(0);
    expect(dispatchCalls).toHaveLength(0);
  });
});

describe("MeshServer.respondNegotiate", () => {
  it("rejects an unknown negotiation", async () => {
    const { mesh } = makeMesh();
    await expect(
      mesh.respondNegotiate("neg_missing", counter("agent_b", "neg_missing"), "sess_b"),
    ).rejects.toThrow(/negotiation neg_missing not found/);
  });

  it("rejects once the negotiation is no longer active", async () => {
    const { mesh, seedNegotiation, rounds } = makeMesh();
    seedNegotiation({ status: "accepted" });

    await expect(mesh.respondNegotiate("neg_seed", counter("agent_b"), "sess_b")).rejects.toThrow(
      /negotiation neg_seed is not active \(status='accepted'\)/,
    );
    expect(rounds).toHaveLength(0);
  });

  it("stamps the counterparty session id on B's first response", async () => {
    const { mesh, negotiations, seedNegotiation } = makeMesh();
    seedNegotiation();

    // A `counter` turn blocks awaiting the peer, so settle it at the end
    // rather than awaiting the call itself.
    const bTurn = mesh.respondNegotiate("neg_seed", counter("agent_b"), "sess_b_real");
    await tick();
    expect(negotiations.get("neg_seed")?.counterparty_session_id).toBe("sess_b_real");

    mesh.unblockOnEscalate("neg_seed", "esc_cleanup");
    await expect(bTurn).resolves.toMatchObject({ decision: "escalated" });
  });

  it("does not stamp the counterparty session id from the initiator's own turn", async () => {
    const { mesh, negotiations, seedNegotiation, negotiationRepo } = makeMesh();
    seedNegotiation();

    // A responding on its own turn must not claim B's slot on the row.
    const aTurn = mesh.respondNegotiate("neg_seed", counter("agent_a"), "sess_a");
    await tick();
    expect(negotiations.get("neg_seed")?.counterparty_session_id).toBeUndefined();
    for (const [, patch] of negotiationRepo.update.mock.calls) {
      expect(patch).not.toHaveProperty("counterparty_session_id");
    }

    mesh.unblockOnEscalate("neg_seed", "esc_cleanup");
    await expect(aTurn).resolves.toMatchObject({ decision: "escalated" });
  });

  it("does not re-stamp a counterparty session id that is already set", async () => {
    const { mesh, negotiations, seedNegotiation } = makeMesh();
    seedNegotiation({ counterparty_session_id: "sess_b_first" });

    const bTurn = mesh.respondNegotiate("neg_seed", counter("agent_b"), "sess_b_second");
    await tick();
    expect(negotiations.get("neg_seed")?.counterparty_session_id).toBe("sess_b_first");

    mesh.unblockOnEscalate("neg_seed", "esc_cleanup");
    await expect(bTurn).resolves.toBeDefined();
  });

  it("persists the round and bumps rounds_completed", async () => {
    const { mesh, rounds, negotiations, seedNegotiation } = makeMesh();
    seedNegotiation({ rounds_completed: 3 });

    const turn = mesh.respondNegotiate("neg_seed", counter("agent_b"), "sess_b");
    await tick();

    expect(rounds).toEqual([
      expect.objectContaining({
        negotiation_id: "neg_seed",
        round_number: 4,
        from_agent_id: "agent_b",
        decision: "counter",
      }),
    ]);
    expect(negotiations.get("neg_seed")?.rounds_completed).toBe(4);

    mesh.unblockOnEscalate("neg_seed", "esc_cleanup");
    await expect(turn).resolves.toBeDefined();
  });

  it("lets B complete the first exchange even when max_rounds is 1", async () => {
    const { mesh, rounds, seedNegotiation } = makeMesh();
    // max_rounds caps A↔B *exchanges*, not rows. Row 2 (B's reply)
    // completes exchange 1, so B never trips a cap of 1.
    seedNegotiation({ max_rounds: 1, rounds_completed: 1 });

    const turn = mesh.respondNegotiate("neg_seed", counter("agent_b"), "sess_b");
    await tick();
    expect(rounds).toHaveLength(1);

    mesh.unblockOnEscalate("neg_seed", "esc_cleanup");
    await expect(turn).resolves.toBeDefined();
  });

  it("throws MeshMaxRoundsError when the next row would start an exchange past the cap", async () => {
    const { mesh, rounds, negotiations, seedNegotiation } = makeMesh();
    // Row 3 would start exchange 2, which is past a cap of 1.
    seedNegotiation({ max_rounds: 1, rounds_completed: 2 });

    await expect(
      mesh.respondNegotiate("neg_seed", counter("agent_a"), "sess_a"),
    ).rejects.toBeInstanceOf(MeshMaxRoundsError);
    // The cap check comes before the insert, so nothing is persisted and
    // the negotiation stays active for escalate_to_humans to close.
    expect(rounds).toHaveLength(0);
    expect(negotiations.get("neg_seed")?.rounds_completed).toBe(2);
    expect(negotiations.get("neg_seed")?.status).toBe("active");
  });

  it("carries the round counts on the max-rounds error", async () => {
    const { mesh, seedNegotiation } = makeMesh();
    seedNegotiation({ max_rounds: 2, rounds_completed: 4 });

    await expect(
      mesh.respondNegotiate("neg_seed", counter("agent_a"), "sess_a"),
    ).rejects.toMatchObject({
      code: "MAX_ROUNDS_EXCEEDED",
      meta: { negotiationId: "neg_seed", rounds_completed: 4, max_rounds: 2 },
    });
  });

  it("closes the negotiation as accepted and returns null on accept", async () => {
    const { mesh, negotiations, seedNegotiation } = makeMesh();
    seedNegotiation();

    const result = await mesh.respondNegotiate(
      "neg_seed",
      { ...counter("agent_b"), decision: "accept", message: "deal" },
      "sess_b",
    );

    // null is the terminal signal — there is no peer reply to wait for.
    expect(result).toBeNull();
    expect(negotiations.get("neg_seed")?.status).toBe("accepted");
  });

  it("closes the negotiation as rejected and returns null on reject", async () => {
    const { mesh, negotiations, seedNegotiation } = makeMesh();
    seedNegotiation();

    const result = await mesh.respondNegotiate(
      "neg_seed",
      { ...counter("agent_b"), decision: "reject", message: "no" },
      "sess_b",
    );

    expect(result).toBeNull();
    expect(negotiations.get("neg_seed")?.status).toBe("rejected");
  });

  it("hands B's counter to the blocked initiator and blocks B in their place", async () => {
    const { mesh, negotiations } = makeMesh();
    const aTurn = mesh.sendNegotiate("agent_a", "agent_b", "take the API half", {
      initiatorSessionId: "sess_a",
    });
    await tick();
    const negId = [...negotiations.keys()][0]!;

    // B counters: A's sendNegotiate resolves, and B now holds the
    // responder slot waiting on A.
    const bTurn = mesh.respondNegotiate(negId, counter("agent_b", negId), "sess_b");
    await expect(aTurn).resolves.toMatchObject({
      from_agent_id: "agent_b",
      decision: "counter",
    });

    // A accepts: B's pending turn resolves with A's response, and A's own
    // call is terminal.
    await expect(
      mesh.respondNegotiate(
        negId,
        { negotiation_id: negId, from_agent_id: "agent_a", decision: "accept", message: "ok" },
        "sess_a",
      ),
    ).resolves.toBeNull();
    await expect(bTurn).resolves.toMatchObject({
      from_agent_id: "agent_a",
      decision: "accept",
    });
    expect(negotiations.get(negId)?.status).toBe("accepted");
  });

  it("alternates the blocked side across a multi-round counter exchange", async () => {
    const { mesh, negotiations, rounds } = makeMesh();
    const aTurn = mesh.sendNegotiate("agent_a", "agent_b", "p", {
      initiatorSessionId: "sess_a",
    });
    await tick();
    const negId = [...negotiations.keys()][0]!;

    const bTurn1 = mesh.respondNegotiate(negId, counter("agent_b", negId), "sess_b");
    await expect(aTurn).resolves.toMatchObject({ from_agent_id: "agent_b" });

    // A counters back: B's first turn resolves, A takes the blocked slot.
    const aTurn2 = mesh.respondNegotiate(negId, counter("agent_a", negId), "sess_a");
    await expect(bTurn1).resolves.toMatchObject({ from_agent_id: "agent_a" });

    // B counters again: A's second turn resolves, B is blocked once more.
    const bTurn2 = mesh.respondNegotiate(negId, counter("agent_b", negId), "sess_b");
    await expect(aTurn2).resolves.toMatchObject({ from_agent_id: "agent_b" });

    // Four rows: propose, B, A, B — i.e. two full exchanges.
    expect(rounds.map((r) => r.round_number)).toEqual([1, 2, 3, 4]);

    mesh.unblockOnEscalate(negId, "esc_cleanup");
    await expect(bTurn2).resolves.toMatchObject({ decision: "escalated" });
  });
});

describe("MeshServer.unblockOnEscalate", () => {
  it("releases the blocked initiator with an escalated sentinel", async () => {
    const { mesh, negotiations } = makeMesh();
    const aTurn = mesh.sendNegotiate("agent_a", "agent_b", "p", {
      initiatorSessionId: "sess_a",
    });
    await tick();
    const negId = [...negotiations.keys()][0]!;

    mesh.unblockOnEscalate(negId, "esc_1");

    // The sentinel is the blocked side's cue to file its perspective and
    // exit, rather than sitting out the 5-minute resolver timeout.
    await expect(aTurn).resolves.toEqual({
      decision: "escalated",
      message: expect.stringContaining('add_to_escalation(escalation_id="esc_1"'),
      escalation_id: "esc_1",
      negotiation_id: negId,
    });
  });

  it("releases the blocked responder too", async () => {
    const { mesh, negotiations } = makeMesh();
    const aTurn = mesh.sendNegotiate("agent_a", "agent_b", "p", {
      initiatorSessionId: "sess_a",
    });
    await tick();
    const negId = [...negotiations.keys()][0]!;

    const bTurn = mesh.respondNegotiate(negId, counter("agent_b", negId), "sess_b");
    await expect(aTurn).resolves.toBeDefined();

    mesh.unblockOnEscalate(negId, "esc_2");
    await expect(bTurn).resolves.toMatchObject({
      decision: "escalated",
      escalation_id: "esc_2",
    });
  });

  it("is a no-op when both sides have already exited", () => {
    const { mesh } = makeMesh();
    // Escalation can land after the negotiation is over; that must not throw.
    expect(() => mesh.unblockOnEscalate("neg_gone", "esc_3")).not.toThrow();
  });
});

// ── BLOCKER ───────────────────────────────────────────────────────────────

describe("MeshServer.reportBlocker", () => {
  it("dispatches the parent a blocker intent with the unblock options", () => {
    const { mesh, dispatchCalls } = makeMesh();

    mesh.reportBlocker("agent_parent", "agent_child", "task_7", "the API key is missing");

    const call = dispatchCalls[0];
    expect(call?.agentId).toBe("agent_parent");
    expect(call?.type).toBe("blocker");
    expect(call?.callerAgentId).toBe("agent_child");
    expect(call?.intent).toContain('<mesh-blocker from="agent_child" task_id="task_7">');
    expect(call?.intent).toContain("the API key is missing");
    expect(call?.intent).toContain('revise_task(task_id="task_7"');
    // Fire-and-forget: no session id is pre-minted because nobody blocks
    // on the parent's reply.
    expect(call?.sessionIdOverride).toBeUndefined();
  });

  it("escapes the ids it interpolates into the blocker attributes", () => {
    const { mesh, dispatchCalls } = makeMesh();

    mesh.reportBlocker("agent_parent", 'a"b', "t<1", "desc");

    expect(dispatchCalls[0]?.intent).toContain(
      '<mesh-blocker from="a&quot;b" task_id="t&lt;1">',
    );
  });
});

// ── failure propagation ───────────────────────────────────────────────────

describe("MeshServer.failResolverForCalleeSession", () => {
  it("rejects an ask waiter as soon as the callee session is marked failed", async () => {
    const { mesh, dispatchCalls } = makeMesh();
    const ask = mesh.sendAsk("req_1", "agent_caller", "agent_callee", "hello?");

    // sendAsk awaits capacity checks before kicking off the spawn — wait
    // a full event-loop tick so the pre-minted sessionId reaches the spy.
    await tick();
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
    await tick();
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

    await tick();
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

  it("rejects the waiter on its own when the resolver timeout elapses", async () => {
    vi.useFakeTimers();
    try {
      const { mesh } = makeMesh();
      // Fold the rejection into a value up front: the timer fires inside
      // `advanceTimersByTimeAsync`, so attaching the handler afterwards
      // would surface as an unhandled rejection.
      const ask = mesh
        .sendAsk("req_slow", "agent_caller", "agent_callee", "q?")
        .then(() => undefined)
        .catch((e: unknown) => (e as Error).message);
      // Settle the capacity/spawn microtasks the fake clock doesn't drive.
      await vi.advanceTimersByTimeAsync(0);

      // Backstop for a callee that never answers and never reports a
      // terminal state, so no session-failure hook ever fires.
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await expect(ask).resolves.toMatch(
        /^mesh resolver timeout \(300000ms\) for req_slow:asker$/,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects the negotiate waiter when B's resident session dies", async () => {
    const { mesh, dispatchCalls } = makeMesh();
    const negotiate = mesh.sendNegotiate("agent_a", "agent_b", "p", {
      initiatorSessionId: "sess_a",
    });
    await tick();
    const calleeSid = dispatchCalls[0]?.sessionIdOverride;

    mesh.failResolverForCalleeSession(calleeSid!, "spawn_failed");

    await expect(negotiate).rejects.toThrow(/mesh callee session failed: spawn_failed/);
  });
});
