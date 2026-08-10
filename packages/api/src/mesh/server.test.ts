/**
 * MeshServer unit tests.
 *
 * Two surfaces are covered here:
 *
 *   1. The negotiation state machine — round accounting, the max-rounds
 *      cap, which side is blocked after each `respond_negotiate`, and the
 *      escalation sentinel that releases whoever is waiting. This is the
 *      part with real logic: the "exchange" arithmetic (two DB rows per
 *      user-facing round) and the resolver key flip are both easy to get
 *      subtly wrong and impossible to see from the tool layer.
 *   2. Failure propagation — when a callee session terminates non-success,
 *      the caller's pending `ask`/`negotiate` promise must reject within a
 *      tick instead of sitting through the 5-minute resolver timeout
 *      (which surfaces to the MCP layer as a generic "transport dropped").
 *
 * Everything is driven through fakes; the live path needs Postgres plus a
 * spawned CLI subprocess, which the m6/m7 e2e scripts cover.
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
import {
  CannotNegotiateWithIcError,
  MeshCapacityError,
  MeshMaxRoundsError,
  type NegotiateResponse,
} from "./types.js";

interface DispatchCall {
  agentId: string;
  type: string;
  intent: string;
  sessionIdOverride?: string;
  callerAgentId?: string;
}

function fakeAgent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name: id,
    owner_id: "per_1",
    hierarchy_level: "team",
    max_mesh_sessions: 5,
    max_negotiation_rounds: 5,
    runtime_config: { type: "claude" },
    created_at: new Date("2026-04-01"),
    updated_at: new Date("2026-04-01"),
    ...overrides,
  } as Agent;
}

function fakeNegotiation(overrides: Partial<Negotiation> = {}): Negotiation {
  return {
    id: "neg_1",
    initiator_agent_id: "agent_a",
    initiator_session_id: "sess_a",
    counterparty_agent_id: "agent_b",
    max_rounds: 5,
    rounds_completed: 1,
    status: "active",
    created_at: new Date("2026-04-01"),
    updated_at: new Date("2026-04-01"),
    ...overrides,
  };
}

function makeMesh(
  opts: {
    /** Per-id agent overrides; anything unlisted gets the default team agent. */
    agents?: Record<string, Partial<Agent> | null>;
    /** Running mesh sessions reported for the capacity check. */
    running?: number;
    /** Seed row for negotiationRepo.findById. `null` stands for "not found". */
    negotiation?: Negotiation | null;
    /** Make the fire-and-forget dispatch reject. */
    dispatchRejects?: Error;
  } = {},
) {
  const dispatchCalls: DispatchCall[] = [];
  const dispatchService = {
    dispatchTask: vi.fn(async (call: DispatchCall) => {
      dispatchCalls.push(call);
      if (opts.dispatchRejects) throw opts.dispatchRejects;
      // Return a minimal shape that satisfies the type — MeshServer
      // discards the return via `void`, so values don't matter.
      return {} as Awaited<ReturnType<DispatchService["dispatchTask"]>>;
    }),
  } as unknown as DispatchService;

  const findById = vi.fn(async (id: string) => {
    const override = opts.agents?.[id];
    if (override === null) return undefined;
    return fakeAgent(id, override ?? {});
  });

  // Mutable copy so `update` is observable the way the real row is.
  let negRow = opts.negotiation === undefined ? fakeNegotiation() : opts.negotiation;
  const negotiationRepo = {
    findById: vi.fn(async () => negRow ?? undefined),
    create: vi.fn(async (input: Partial<Negotiation>) => {
      negRow = fakeNegotiation({ ...input, rounds_completed: 0 });
      return negRow;
    }),
    update: vi.fn(async (_id: string, patch: Partial<Negotiation>) => {
      if (negRow) negRow = { ...negRow, ...patch };
      return negRow!;
    }),
  } as unknown as NegotiationRepository;

  const negotiationRoundRepo = {
    create: vi.fn(async (input: Record<string, unknown>) => input),
  } as unknown as NegotiationRoundRepository;

  const countRunningByAgent = vi.fn(async () => opts.running ?? 0);

  const mesh = new MeshServer({
    agentRepo: { findById } as unknown as AgentRepository,
    sessionRepo: { countRunningByAgent } as unknown as SessionRepository,
    sessionEventRepo: {} as SessionEventRepository,
    negotiationRepo,
    negotiationRoundRepo,
    workspaceManager: {} as WorkspaceManager,
    runtimeRegistry: {} as RuntimeRegistry,
    dispatchService,
    makeMemoryAgent: () => ({}) as never,
  });

  return {
    mesh,
    dispatchCalls,
    dispatchService,
    negotiationRepo,
    negotiationRoundRepo,
    countRunningByAgent,
    findById,
    /** The current state of the seeded/created negotiation row. */
    row: () => negRow,
  };
}

/** Let the pre-spawn awaits inside sendAsk/sendNegotiate settle. */
const tick = () => new Promise((r) => setImmediate(r));

function counter(overrides: Partial<NegotiateResponse> = {}): NegotiateResponse {
  return {
    negotiation_id: "neg_1",
    from_agent_id: "agent_b",
    decision: "counter",
    message: "how about X instead",
    ...overrides,
  };
}

// ── ask ──────────────────────────────────────────────────────────────────

describe("MeshServer.sendAsk", () => {
  it("dispatches a mesh_ask session carrying the question and caller", async () => {
    const { mesh, dispatchCalls } = makeMesh();
    const ask = mesh.sendAsk("req_1", "agent_caller", "agent_callee", "why is CI red?");
    await tick();

    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0]).toMatchObject({
      agentId: "agent_callee",
      type: "mesh_ask",
      callerAgentId: "agent_caller",
    });
    expect(dispatchCalls[0]!.intent).toContain("why is CI red?");
    expect(dispatchCalls[0]!.intent).toContain('request_id="req_1"');

    mesh.respondAsk("req_1", {
      request_id: "req_1",
      from_agent_id: "agent_callee",
      answer: "flaky test",
    });
    await expect(ask).resolves.toMatchObject({ answer: "flaky test" });
  });

  it("escapes XML-significant characters in the intent attributes", async () => {
    const { mesh, dispatchCalls } = makeMesh();
    const ask = mesh.sendAsk('req"1', "agent_caller", 'agent<"callee', "q");
    await tick();

    // The `<mesh-ask>` attributes are escaped so a quote in an id can't
    // break out of the tag. (The prose in the `<context>` block below it
    // echoes the id verbatim on purpose — that is the literal string the
    // agent has to pass back to respond_ask.)
    const openTag = dispatchCalls[0]!.intent.split("\n")[0];
    expect(openTag).toBe('<mesh-ask request_id="req&quot;1" from="agent_caller">');

    mesh.respondAsk('req"1', {
      request_id: 'req"1',
      from_agent_id: "agent_callee",
      answer: "a",
    });
    await ask;
  });

  it("throws MeshCapacityError when the target is already at its mesh cap", async () => {
    const { mesh, dispatchCalls } = makeMesh({
      agents: { agent_callee: { max_mesh_sessions: 2 } },
      running: 2,
    });

    await expect(
      mesh.sendAsk("req_1", "agent_caller", "agent_callee", "q"),
    ).rejects.toBeInstanceOf(MeshCapacityError);
    expect(dispatchCalls).toHaveLength(0);
  });

  it("falls back to the default cap when the target sets none", async () => {
    // Default is 3; 3 running is at the cap.
    const { mesh } = makeMesh({
      agents: { agent_callee: { max_mesh_sessions: undefined } },
      running: 3,
    });

    await expect(
      mesh.sendAsk("req_1", "agent_caller", "agent_callee", "q"),
    ).rejects.toThrow(/mesh capacity \(3\/3\)/);
  });

  it("throws when the target agent does not exist", async () => {
    const { mesh } = makeMesh({ agents: { ghost: null } });

    await expect(mesh.sendAsk("req_1", "agent_caller", "ghost", "q")).rejects.toThrow(
      /target agent not found: ghost/,
    );
  });

  it("respondAsk for an unknown request id is a no-op", () => {
    const { mesh } = makeMesh();
    expect(() =>
      mesh.respondAsk("req_nobody_waits_on", {
        request_id: "req_nobody_waits_on",
        from_agent_id: "agent_b",
        answer: "…",
      }),
    ).not.toThrow();
  });

  it("rejects with a timeout once the resolver window elapses", async () => {
    vi.useFakeTimers();
    try {
      const { mesh } = makeMesh();
      const ask = mesh.sendAsk("req_slow", "agent_caller", "agent_callee", "q");
      const assertion = expect(ask).rejects.toThrow(/mesh resolver timeout \(300000ms\)/);
      await vi.advanceTimersByTimeAsync(300_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs but does not reject when the fire-and-forget dispatch fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { mesh } = makeMesh({ dispatchRejects: new Error("no runtime online") });

    const ask = mesh.sendAsk("req_1", "agent_caller", "agent_callee", "q");
    await tick();

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("[mesh] dispatch for agent_callee (mesh_ask) failed:"),
      "no runtime online",
    );
    // The caller stays blocked on the resolver — a dead spawn is surfaced
    // by the session-terminal hook, not by the dispatch promise.
    mesh.respondAsk("req_1", { request_id: "req_1", from_agent_id: "b", answer: "a" });
    await expect(ask).resolves.toBeDefined();
    consoleError.mockRestore();
  });
});

// ── negotiate: round 1 ───────────────────────────────────────────────────

describe("MeshServer.sendNegotiate", () => {
  it("creates the negotiation, records round 1, and dispatches B", async () => {
    const h = makeMesh({ negotiation: null });
    const neg = h.mesh.sendNegotiate("agent_a", "agent_b", "let's split the API", {
      initiatorSessionId: "sess_a",
      taskId: "task_1",
    });
    await tick();

    expect(h.negotiationRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        initiator_agent_id: "agent_a",
        initiator_session_id: "sess_a",
        counterparty_agent_id: "agent_b",
        task_id: "task_1",
        max_rounds: 5,
      }),
    );
    expect(h.negotiationRoundRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        round_number: 1,
        from_agent_id: "agent_a",
        decision: "propose",
        message: "let's split the API",
      }),
    );
    // rounds_completed is bumped in the same logical step so B's first
    // respond_negotiate computes round 2, not a duplicate round 1.
    expect(h.negotiationRepo.update).toHaveBeenCalledWith(
      expect.any(String),
      { rounds_completed: 1 },
    );
    expect(h.dispatchCalls[0]).toMatchObject({
      agentId: "agent_b",
      type: "mesh_negotiate",
      callerAgentId: "agent_a",
    });
    expect(h.dispatchCalls[0]!.sessionIdOverride).toBeDefined();

    // Release the initiator so the test doesn't leave a dangling timer.
    const id = h.row()!.id;
    await h.mesh.respondNegotiate(id, counter({ negotiation_id: id, decision: "accept" }), "sess_b");
    await expect(neg).resolves.toMatchObject({ decision: "accept" });
  });

  it("stamps max_rounds from the initiator, defaulting when unset", async () => {
    const h = makeMesh({
      negotiation: null,
      agents: { agent_a: { max_negotiation_rounds: undefined } },
    });
    void h.mesh.sendNegotiate("agent_a", "agent_b", "p", { initiatorSessionId: "sess_a" });
    await tick();

    expect(h.negotiationRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ max_rounds: 5 }),
    );
  });

  it("refuses to negotiate with an IC — they have no respond_negotiate", async () => {
    const h = makeMesh({ agents: { agent_ic: { hierarchy_level: "ic" } } });

    await expect(
      h.mesh.sendNegotiate("agent_a", "agent_ic", "p", { initiatorSessionId: "sess_a" }),
    ).rejects.toBeInstanceOf(CannotNegotiateWithIcError);
    expect(h.dispatchCalls).toHaveLength(0);
    expect(h.negotiationRepo.create).not.toHaveBeenCalled();
  });

  it("throws when the target agent does not exist", async () => {
    const h = makeMesh({ agents: { ghost: null } });

    await expect(
      h.mesh.sendNegotiate("agent_a", "ghost", "p", { initiatorSessionId: "sess_a" }),
    ).rejects.toThrow(/target agent not found: ghost/);
  });

  it("throws when the initiator agent does not exist", async () => {
    const h = makeMesh({ agents: { ghost: null } });

    await expect(
      h.mesh.sendNegotiate("ghost", "agent_b", "p", { initiatorSessionId: "sess_a" }),
    ).rejects.toThrow(/initiator agent not found: ghost/);
    expect(h.negotiationRepo.create).not.toHaveBeenCalled();
  });

  it("capacity-gates before writing any negotiation rows", async () => {
    const h = makeMesh({ agents: { agent_b: { max_mesh_sessions: 1 } }, running: 1 });

    await expect(
      h.mesh.sendNegotiate("agent_a", "agent_b", "p", { initiatorSessionId: "sess_a" }),
    ).rejects.toBeInstanceOf(MeshCapacityError);
    expect(h.negotiationRepo.create).not.toHaveBeenCalled();
  });
});

// ── negotiate: subsequent rounds ─────────────────────────────────────────

describe("MeshServer.respondNegotiate", () => {
  it("throws on an unknown negotiation", async () => {
    const h = makeMesh({ negotiation: null });

    await expect(h.mesh.respondNegotiate("neg_x", counter(), "sess_b")).rejects.toThrow(
      /negotiation neg_x not found/,
    );
  });

  it.each(["accepted", "escalated", "cancelled"] as const)(
    "refuses to add a round to a %s negotiation",
    async (status) => {
      const h = makeMesh({ negotiation: fakeNegotiation({ status }) });

      await expect(h.mesh.respondNegotiate("neg_1", counter(), "sess_b")).rejects.toThrow(
        new RegExp(`is not active \\(status='${status}'\\)`),
      );
      expect(h.negotiationRoundRepo.create).not.toHaveBeenCalled();
    },
  );

  it("stamps counterparty_session_id on B's first response only", async () => {
    const h = makeMesh();

    await h.mesh.respondNegotiate("neg_1", counter({ decision: "accept" }), "sess_b");

    expect(h.negotiationRepo.update).toHaveBeenCalledWith("neg_1", {
      counterparty_session_id: "sess_b",
    });
    expect(h.row()!.counterparty_session_id).toBe("sess_b");
  });

  it("does not restamp the session id once it is set", async () => {
    const h = makeMesh({
      negotiation: fakeNegotiation({ counterparty_session_id: "sess_b_original" }),
    });

    await h.mesh.respondNegotiate("neg_1", counter({ decision: "accept" }), "sess_b_new");

    expect(h.negotiationRepo.update).not.toHaveBeenCalledWith("neg_1", {
      counterparty_session_id: "sess_b_new",
    });
  });

  it("does not stamp the session id for a response from the initiator side", async () => {
    const h = makeMesh();

    await h.mesh.respondNegotiate(
      "neg_1",
      counter({ from_agent_id: "agent_a", decision: "reject" }),
      "sess_a",
    );

    expect(h.negotiationRepo.update).not.toHaveBeenCalledWith("neg_1", {
      counterparty_session_id: "sess_a",
    });
  });

  it.each([
    ["accept", "accepted"],
    ["reject", "rejected"],
  ] as const)("closes the negotiation on %s and returns null", async (decision, status) => {
    const h = makeMesh();

    const result = await h.mesh.respondNegotiate("neg_1", counter({ decision }), "sess_b");

    expect(result).toBeNull();
    expect(h.negotiationRepo.update).toHaveBeenCalledWith("neg_1", { status });
  });

  it("records the round and bumps rounds_completed", async () => {
    const h = makeMesh({ negotiation: fakeNegotiation({ rounds_completed: 3 }) });

    await h.mesh.respondNegotiate(
      "neg_1",
      counter({ decision: "accept", message: "deal" }),
      "sess_b",
    );

    expect(h.negotiationRoundRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        negotiation_id: "neg_1",
        round_number: 4,
        from_agent_id: "agent_b",
        decision: "accept",
        message: "deal",
      }),
    );
    expect(h.negotiationRepo.update).toHaveBeenCalledWith("neg_1", { rounds_completed: 4 });
  });

  it("blocks the responder on the opposite key after a counter, then releases it", async () => {
    const h = makeMesh();

    // B counters round 1. Nobody is registered on either key here (the
    // initiator's resolver lives in sendNegotiate, which we skipped), so
    // B blocks on the initiator key.
    const bBlocked = h.mesh.respondNegotiate("neg_1", counter(), "sess_b");
    await tick();

    // A replies — that fires B's waiter.
    const aReply = counter({ from_agent_id: "agent_a", decision: "accept", message: "ok" });
    await h.mesh.respondNegotiate("neg_1", aReply, "sess_a");

    await expect(bBlocked).resolves.toMatchObject({ from_agent_id: "agent_a", decision: "accept" });
  });

  it("alternates which side is blocked across a full counter exchange", async () => {
    const h = makeMesh({ negotiation: fakeNegotiation({ max_rounds: 10 }) });

    const bFirst = h.mesh.respondNegotiate("neg_1", counter(), "sess_b");
    await tick();

    // A counters: this resolves B (registered on the initiator key) and
    // parks A on the responder key.
    const aCounter = h.mesh.respondNegotiate(
      "neg_1",
      counter({ from_agent_id: "agent_a", message: "or Y" }),
      "sess_a",
    );
    await expect(bFirst).resolves.toMatchObject({ from_agent_id: "agent_a" });
    await tick();

    // B accepts: resolves A's parked promise.
    await h.mesh.respondNegotiate(
      "neg_1",
      counter({ decision: "accept", message: "fine" }),
      "sess_b",
    );
    await expect(aCounter).resolves.toMatchObject({ decision: "accept" });
  });

  it("throws MeshMaxRoundsError when the next row would start an exchange past the cap", async () => {
    // max_rounds counts A↔B exchanges (two rows each). 10 rows completed
    // means exchange 5 is done; row 11 would open exchange 6.
    const h = makeMesh({ negotiation: fakeNegotiation({ rounds_completed: 10, max_rounds: 5 }) });

    await expect(h.mesh.respondNegotiate("neg_1", counter(), "sess_b")).rejects.toBeInstanceOf(
      MeshMaxRoundsError,
    );
    expect(h.negotiationRoundRepo.create).not.toHaveBeenCalled();
  });

  it("lets B complete the final exchange rather than capping it early", async () => {
    // 9 rows completed → row 10 closes exchange 5, still within the cap.
    const h = makeMesh({ negotiation: fakeNegotiation({ rounds_completed: 9, max_rounds: 5 }) });

    const result = await h.mesh.respondNegotiate(
      "neg_1",
      counter({ decision: "accept" }),
      "sess_b",
    );

    expect(result).toBeNull();
    expect(h.negotiationRoundRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ round_number: 10 }),
    );
  });
});

// ── escalation sentinel ──────────────────────────────────────────────────

describe("MeshServer.unblockOnEscalate", () => {
  it("releases the blocked side with the escalated sentinel", async () => {
    const h = makeMesh();
    const blocked = h.mesh.respondNegotiate("neg_1", counter(), "sess_b");
    await tick();

    h.mesh.unblockOnEscalate("neg_1", "esc_9");

    await expect(blocked).resolves.toEqual({
      decision: "escalated",
      message: expect.stringContaining('add_to_escalation(escalation_id="esc_9"'),
      escalation_id: "esc_9",
      negotiation_id: "neg_1",
    });
  });

  it("releases the initiator when it is the side parked on the responder key", async () => {
    const h = makeMesh({ negotiation: fakeNegotiation({ max_rounds: 10 }) });

    // B counters first (parks on the initiator key), then A counters —
    // which resolves B and parks A on the *responder* key.
    const bFirst = h.mesh.respondNegotiate("neg_1", counter(), "sess_b");
    await tick();
    const aParked = h.mesh.respondNegotiate(
      "neg_1",
      counter({ from_agent_id: "agent_a" }),
      "sess_a",
    );
    await bFirst;
    await tick();

    h.mesh.unblockOnEscalate("neg_1", "esc_9");

    await expect(aParked).resolves.toMatchObject({
      decision: "escalated",
      escalation_id: "esc_9",
    });
  });

  it("is a no-op when both sides have already exited", () => {
    const h = makeMesh();
    expect(() => h.mesh.unblockOnEscalate("neg_none", "esc_9")).not.toThrow();
  });
});

// ── report_blocker ───────────────────────────────────────────────────────

describe("MeshServer.reportBlocker", () => {
  it("dispatches a blocker session to the parent without blocking the caller", () => {
    const h = makeMesh();

    const returned = h.mesh.reportBlocker("agent_parent", "agent_child", "task_7", "creds missing");

    expect(returned).toBeUndefined();
    expect(h.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent_parent",
        type: "blocker",
        callerAgentId: "agent_child",
        // Fire-and-forget: no pre-minted session id to correlate.
        sessionIdOverride: undefined,
      }),
    );
    const intent = h.dispatchCalls[0]!.intent;
    expect(intent).toContain("creds missing");
    expect(intent).toContain('revise_task(task_id="task_7"');
  });

  it("does not capacity-gate — a blocker report must always reach the parent", () => {
    const h = makeMesh({ running: 99 });

    h.mesh.reportBlocker("agent_parent", "agent_child", "task_7", "stuck");

    expect(h.dispatchService.dispatchTask).toHaveBeenCalled();
    expect(h.countRunningByAgent).not.toHaveBeenCalled();
  });
});

// ── failure propagation ──────────────────────────────────────────────────

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

  it("rejects a blocked respond_negotiate waiter tied to the B-resident session", async () => {
    const h = makeMesh({ negotiation: fakeNegotiation({ counterparty_session_id: "sess_b" }) });
    const blocked = h.mesh.respondNegotiate("neg_1", counter(), "sess_b");
    await tick();

    expect(h.mesh.hasPendingCalleeSession("sess_b")).toBe(true);
    h.mesh.failResolverForCalleeSession("sess_b", "cli_exited");

    await expect(blocked).rejects.toThrow(/mesh callee session failed: cli_exited/);
    expect(h.mesh.hasPendingCalleeSession("sess_b")).toBe(false);
  });
});
