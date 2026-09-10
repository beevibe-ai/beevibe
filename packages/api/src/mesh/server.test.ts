/**
 * MeshServer unit tests.
 *
 * Two halves:
 *   1. Failure propagation — when a callee session terminates non-success,
 *      the caller's pending `ask`/`negotiate` promise must reject within a
 *      tick instead of sitting through the 5-minute resolver timeout (which
 *      surfaces to the MCP layer as a generic "transport dropped" error).
 *   2. The ask / negotiate / blocker protocol itself: capacity gating, the
 *      round bookkeeping `respondNegotiate` does against `negotiation` +
 *      `negotiation_round`, the resolver hand-off that alternates which
 *      side is blocked each round, and the escalation sentinel.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentRepository,
  Negotiation,
  NegotiationRepository,
  NegotiationRound,
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

const ASK_TIMEOUT_MS = 5 * 60_000;
const NEGOTIATE_TIMEOUT_MS = 5 * 60_000;

type DispatchCall = {
  agentId: string;
  intent: string;
  type: string;
  sessionIdOverride?: string;
  callerAgentId?: string;
};

interface MeshFixtureOptions {
  /** Per-agent overrides keyed by agent id, merged over the default agent. */
  agents?: Record<string, Partial<Agent> | null>;
  /** Running mesh sessions reported by `countRunningByAgent`. */
  running?: number;
  /** Make every `dispatchTask` reject with this error. */
  dispatchError?: Error;
}

const DEFAULT_AGENT: Agent = {
  id: "agent_default",
  name: "Default",
  owner_id: "per_1",
  hierarchy_level: "team",
  max_mesh_sessions: 5,
  max_negotiation_rounds: 5,
  runtime_config: { type: "claude" },
} as unknown as Agent;

function makeMesh(options: MeshFixtureOptions = {}) {
  const dispatchCalls: DispatchCall[] = [];
  const dispatchService = {
    dispatchTask: vi.fn(async (opts: DispatchCall) => {
      dispatchCalls.push(opts);
      if (options.dispatchError) throw options.dispatchError;
      // MeshServer discards the return via `void`, so the value is inert.
      return {} as Awaited<ReturnType<DispatchService["dispatchTask"]>>;
    }),
  } as unknown as DispatchService;

  const agentRepo = {
    findById: vi.fn(async (id: string): Promise<Agent | undefined> => {
      const override = options.agents?.[id];
      if (override === null) return undefined;
      return { ...DEFAULT_AGENT, id, name: id, ...override };
    }),
  } as unknown as AgentRepository;

  // In-memory negotiation store: `update` mutates in place so a later
  // `findById` observes rounds_completed / status / counterparty_session_id
  // exactly as the Postgres adapter would.
  const negotiations = new Map<string, Negotiation>();
  const rounds: NegotiationRound[] = [];
  let negSeq = 0;

  const negotiationRepo = {
    findById: vi.fn(async (id: string) => negotiations.get(id)),
    create: vi.fn(async (input: Partial<Negotiation>) => {
      const row = {
        rounds_completed: 0,
        status: "active",
        created_at: new Date(0),
        updated_at: new Date(0),
        ...input,
        id: input.id ?? `neg_${++negSeq}`,
      } as Negotiation;
      negotiations.set(row.id, row);
      return row;
    }),
    update: vi.fn(async (id: string, patch: Partial<Negotiation>) => {
      const row = negotiations.get(id);
      if (!row) throw new Error(`no negotiation ${id}`);
      Object.assign(row, patch);
      return row;
    }),
  } as unknown as NegotiationRepository;

  const negotiationRoundRepo = {
    create: vi.fn(async (input: Omit<NegotiationRound, "sent_at">) => {
      const row = { ...input, sent_at: new Date(0) } as NegotiationRound;
      rounds.push(row);
      return row;
    }),
  } as unknown as NegotiationRoundRepository;

  const mesh = new MeshServer({
    agentRepo,
    sessionRepo: {
      countRunningByAgent: vi.fn(async () => options.running ?? 0),
    } as unknown as SessionRepository,
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
    agentRepo,
    negotiationRepo,
    negotiationRoundRepo,
    negotiations,
    rounds,
    /** Seed an active negotiation without going through `sendNegotiate`. */
    seedNegotiation(row: Partial<Negotiation>): Negotiation {
      const seeded = {
        id: "neg_seed",
        initiator_agent_id: "agent_a",
        initiator_session_id: "sess_a",
        counterparty_agent_id: "agent_b",
        max_rounds: 5,
        rounds_completed: 1,
        status: "active",
        created_at: new Date(0),
        updated_at: new Date(0),
        ...row,
      } as Negotiation;
      negotiations.set(seeded.id, seeded);
      return seeded;
    },
  };
}

/** Let the awaits inside sendAsk/sendNegotiate settle and the spawn fire. */
async function tick(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

function counter(
  negotiationId: string,
  fromAgentId: string,
  message = "how about this instead",
): NegotiateResponse {
  return {
    negotiation_id: negotiationId,
    from_agent_id: fromAgentId,
    decision: "counter",
    message,
    counter_proposal: message,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

  it("rejects a blocked respond_negotiate when the B-resident session dies", async () => {
    const f = makeMesh();
    const neg = f.seedNegotiation({ counterparty_session_id: "sess_bbb" });

    const blocked = f.mesh.respondNegotiate(neg.id, counter(neg.id, "agent_b"), "sess_bbb");
    await tick();
    expect(f.mesh.hasPendingCalleeSession("sess_bbb")).toBe(true);

    f.mesh.failResolverForCalleeSession("sess_bbb", "runtime_offline");
    await expect(blocked).rejects.toThrow(/mesh callee session failed: runtime_offline/);
  });
});

describe("MeshServer.sendAsk", () => {
  it("dispatches a mesh_ask carrying the caller id and the respond_ask contract", async () => {
    const { mesh, dispatchCalls } = makeMesh();
    void mesh.sendAsk("req_x", "agent_a", "agent_b", "what is the deploy story?");
    await tick();

    const call = dispatchCalls[0]!;
    expect(call.agentId).toBe("agent_b");
    expect(call.type).toBe("mesh_ask");
    expect(call.callerAgentId).toBe("agent_a");
    expect(call.sessionIdOverride).toMatch(/^sess_/);
    expect(call.intent).toContain('<mesh-ask request_id="req_x" from="agent_a">');
    expect(call.intent).toContain("what is the deploy story?");
    expect(call.intent).toContain('respond_ask(request_id="req_x"');
  });

  it("escapes XML metacharacters in the request id and caller id", async () => {
    const { mesh, dispatchCalls } = makeMesh();
    void mesh.sendAsk('req"1&<', "a<gent>", "agent_b", "q");
    await tick();

    expect(dispatchCalls[0]!.intent).toContain(
      '<mesh-ask request_id="req&quot;1&amp;&lt;" from="a&lt;gent&gt;">',
    );
  });

  it("throws MeshCapacityError without dispatching when the target is at cap", async () => {
    const { mesh, dispatchCalls } = makeMesh({
      running: 5,
      agents: { agent_b: { max_mesh_sessions: 5 } },
    });

    await expect(mesh.sendAsk("req_c", "agent_a", "agent_b", "q")).rejects.toBeInstanceOf(
      MeshCapacityError,
    );
    expect(dispatchCalls).toHaveLength(0);
  });

  it("falls back to a cap of 3 when the target has no max_mesh_sessions", async () => {
    const atDefaultCap = makeMesh({
      running: 3,
      agents: { agent_b: { max_mesh_sessions: undefined } },
    });
    await expect(
      atDefaultCap.mesh.sendAsk("req_d", "agent_a", "agent_b", "q"),
    ).rejects.toMatchObject({ meta: { agentId: "agent_b", running: 3, cap: 3 } });

    const underDefaultCap = makeMesh({
      running: 2,
      agents: { agent_b: { max_mesh_sessions: undefined } },
    });
    void underDefaultCap.mesh.sendAsk("req_e", "agent_a", "agent_b", "q");
    await tick();
    expect(underDefaultCap.dispatchCalls).toHaveLength(1);
  });

  it("throws when the target agent does not exist", async () => {
    const { mesh } = makeMesh({ agents: { agent_gone: null } });
    await expect(mesh.sendAsk("req_f", "agent_a", "agent_gone", "q")).rejects.toThrow(
      "target agent not found: agent_gone",
    );
  });

  it("logs and swallows a dispatch failure — the resolver stays armed", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { mesh } = makeMesh({ dispatchError: new Error("daemon offline") });

    const ask = mesh.sendAsk("req_g", "agent_a", "agent_b", "q");
    await tick();

    expect(consoleError).toHaveBeenCalledWith(
      "[mesh] dispatch for agent_b (mesh_ask) failed:",
      "daemon offline",
    );
    // The ask itself did not reject — it is still waiting on respond_ask.
    mesh.respondAsk("req_g", {
      request_id: "req_g",
      from_agent_id: "agent_b",
      answer: "late but fine",
    });
    await expect(ask).resolves.toMatchObject({ answer: "late but fine" });
  });

  it("rejects with a resolver timeout when respond_ask never arrives", async () => {
    vi.useFakeTimers();
    const { mesh } = makeMesh();
    const ask = mesh.sendAsk("req_h", "agent_a", "agent_b", "q");
    const assertion = expect(ask).rejects.toThrow(
      `mesh resolver timeout (${ASK_TIMEOUT_MS}ms) for req_h:asker`,
    );

    await vi.advanceTimersByTimeAsync(0); // arm the resolver
    await vi.advanceTimersByTimeAsync(ASK_TIMEOUT_MS);
    await assertion;
  });
});

describe("MeshServer.respondAsk", () => {
  it("is a no-op when no asker is blocked (B responded twice, or after a timeout)", () => {
    const { mesh } = makeMesh();
    expect(() =>
      mesh.respondAsk("req_unknown", {
        request_id: "req_unknown",
        from_agent_id: "agent_b",
        answer: "nobody home",
      }),
    ).not.toThrow();
  });
});

describe("MeshServer.sendNegotiate", () => {
  it("creates the negotiation, records round 1 and dispatches B", async () => {
    const f = makeMesh();
    void f.mesh.sendNegotiate("agent_a", "agent_b", "ship on Friday", {
      initiatorSessionId: "sess_initiator",
      taskId: "task_9",
    });
    await tick();

    const neg = [...f.negotiations.values()][0]!;
    expect(neg).toMatchObject({
      initiator_agent_id: "agent_a",
      initiator_session_id: "sess_initiator",
      counterparty_agent_id: "agent_b",
      task_id: "task_9",
      max_rounds: 5,
      // sendNegotiate bumps rounds_completed so B's first respond_negotiate
      // computes round_number=2 and doesn't collide on the UNIQUE index.
      rounds_completed: 1,
    });

    expect(f.rounds).toHaveLength(1);
    expect(f.rounds[0]).toMatchObject({
      negotiation_id: neg.id,
      round_number: 1,
      from_agent_id: "agent_a",
      decision: "propose",
      message: "ship on Friday",
    });

    const call = f.dispatchCalls[0]!;
    expect(call).toMatchObject({
      agentId: "agent_b",
      type: "mesh_negotiate",
      callerAgentId: "agent_a",
    });
    expect(call.sessionIdOverride).toMatch(/^sess_/);
    expect(call.intent).toContain(
      `<mesh-negotiate negotiation_id="${neg.id}" from="agent_a" round="1">`,
    );
    expect(call.intent).toContain("ship on Friday");
  });

  it("stamps max_rounds from the initiator, defaulting to 5", async () => {
    const custom = makeMesh({ agents: { agent_a: { max_negotiation_rounds: 2 } } });
    void custom.mesh.sendNegotiate("agent_a", "agent_b", "p", {
      initiatorSessionId: "s",
    });
    await tick();
    expect([...custom.negotiations.values()][0]!.max_rounds).toBe(2);

    const fallback = makeMesh({
      agents: { agent_a: { max_negotiation_rounds: undefined } },
    });
    void fallback.mesh.sendNegotiate("agent_a", "agent_b", "p", {
      initiatorSessionId: "s",
    });
    await tick();
    expect([...fallback.negotiations.values()][0]!.max_rounds).toBe(5);
  });

  it("rejects an IC target before touching capacity or the negotiation table", async () => {
    const f = makeMesh({ agents: { agent_ic: { hierarchy_level: "ic" } } });

    await expect(
      f.mesh.sendNegotiate("agent_a", "agent_ic", "p", { initiatorSessionId: "s" }),
    ).rejects.toBeInstanceOf(CannotNegotiateWithIcError);
    expect(f.negotiations.size).toBe(0);
    expect(f.dispatchCalls).toHaveLength(0);
  });

  it("throws when the target or the initiator does not exist", async () => {
    const noTarget = makeMesh({ agents: { agent_gone: null } });
    await expect(
      noTarget.mesh.sendNegotiate("agent_a", "agent_gone", "p", {
        initiatorSessionId: "s",
      }),
    ).rejects.toThrow("target agent not found: agent_gone");

    const noInitiator = makeMesh({ agents: { agent_gone: null } });
    await expect(
      noInitiator.mesh.sendNegotiate("agent_gone", "agent_b", "p", {
        initiatorSessionId: "s",
      }),
    ).rejects.toThrow("initiator agent not found: agent_gone");
    expect(noInitiator.negotiations.size).toBe(0);
  });

  it("capacity-gates the target before creating the negotiation row", async () => {
    const f = makeMesh({ running: 9, agents: { agent_b: { max_mesh_sessions: 1 } } });
    await expect(
      f.mesh.sendNegotiate("agent_a", "agent_b", "p", { initiatorSessionId: "s" }),
    ).rejects.toBeInstanceOf(MeshCapacityError);
    expect(f.negotiations.size).toBe(0);
  });

  it("rejects with a resolver timeout when B never responds", async () => {
    vi.useFakeTimers();
    const f = makeMesh();
    const neg = f.mesh.sendNegotiate("agent_a", "agent_b", "p", {
      initiatorSessionId: "s",
    });
    const assertion = expect(neg).rejects.toThrow(
      new RegExp(`mesh resolver timeout \\(${NEGOTIATE_TIMEOUT_MS}ms\\) for neg_\\w+:initiator`),
    );

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(NEGOTIATE_TIMEOUT_MS);
    await assertion;
  });
});

describe("MeshServer.respondNegotiate", () => {
  it("runs a full counter → accept exchange, alternating which side is blocked", async () => {
    const f = makeMesh();
    const initiatorPromise = f.mesh.sendNegotiate("agent_a", "agent_b", "ship Friday", {
      initiatorSessionId: "sess_a",
    });
    await tick();
    const negId = [...f.negotiations.keys()][0]!;
    const counterpartySid = f.dispatchCalls[0]!.sessionIdOverride!;

    // Round 2: B counters. A's sendNegotiate resolves with B's response and
    // B is now the blocked side.
    const bBlocked = f.mesh.respondNegotiate(
      negId,
      counter(negId, "agent_b", "ship Monday"),
      counterpartySid,
    );
    await expect(initiatorPromise).resolves.toMatchObject({
      from_agent_id: "agent_b",
      decision: "counter",
      message: "ship Monday",
    });
    await tick();

    // First response from the counterparty stamps its session id.
    expect(f.negotiations.get(negId)!.counterparty_session_id).toBe(counterpartySid);
    expect(f.negotiations.get(negId)!.rounds_completed).toBe(2);

    // Round 3: A accepts. B's blocked call resolves with A's response and
    // A's own call returns null (terminal).
    const aTerminal = await f.mesh.respondNegotiate(
      negId,
      {
        negotiation_id: negId,
        from_agent_id: "agent_a",
        decision: "accept",
        message: "Monday works",
      },
      "sess_a",
    );

    expect(aTerminal).toBeNull();
    await expect(bBlocked).resolves.toMatchObject({
      from_agent_id: "agent_a",
      decision: "accept",
    });
    expect(f.negotiations.get(negId)!.status).toBe("accepted");
    expect(f.negotiations.get(negId)!.rounds_completed).toBe(3);
    expect(f.rounds.map((r) => [r.round_number, r.from_agent_id, r.decision])).toEqual([
      [1, "agent_a", "propose"],
      [2, "agent_b", "counter"],
      [3, "agent_a", "accept"],
    ]);
  });

  it("closes the negotiation as rejected on a reject decision", async () => {
    const f = makeMesh();
    const neg = f.seedNegotiation({ id: "neg_rej" });

    const result = await f.mesh.respondNegotiate(
      neg.id,
      {
        negotiation_id: neg.id,
        from_agent_id: "agent_b",
        decision: "reject",
        message: "no",
      },
      "sess_b",
    );

    expect(result).toBeNull();
    expect(f.negotiations.get(neg.id)!.status).toBe("rejected");
  });

  it("stamps counterparty_session_id only on the counterparty's first response", async () => {
    const f = makeMesh();
    const neg = f.seedNegotiation({ id: "neg_stamp" });

    // The initiator responding first must NOT claim the counterparty slot.
    void f.mesh.respondNegotiate(neg.id, counter(neg.id, "agent_a"), "sess_a");
    await tick();
    expect(f.negotiations.get(neg.id)!.counterparty_session_id).toBeUndefined();

    void f.mesh.respondNegotiate(neg.id, counter(neg.id, "agent_b"), "sess_b_first");
    await tick();
    expect(f.negotiations.get(neg.id)!.counterparty_session_id).toBe("sess_b_first");

    // A later response from B is a no-op — the column is immutable.
    void f.mesh.respondNegotiate(neg.id, counter(neg.id, "agent_b"), "sess_b_second");
    await tick();
    expect(f.negotiations.get(neg.id)!.counterparty_session_id).toBe("sess_b_first");
  });

  it("throws when the negotiation is unknown or already terminal", async () => {
    const f = makeMesh();
    await expect(
      f.mesh.respondNegotiate("neg_nope", counter("neg_nope", "agent_b"), "s"),
    ).rejects.toThrow("negotiation neg_nope not found");

    const closed = f.seedNegotiation({ id: "neg_closed", status: "accepted" });
    await expect(
      f.mesh.respondNegotiate(closed.id, counter(closed.id, "agent_b"), "s"),
    ).rejects.toThrow("negotiation neg_closed is not active (status='accepted')");
  });

  it("caps on EXCHANGES, not rows — B completing exchange 1 is allowed at max_rounds=1", async () => {
    const f = makeMesh();
    const neg = f.seedNegotiation({
      id: "neg_cap",
      max_rounds: 1,
      rounds_completed: 1,
    });

    // Row 2 completes exchange 1 → still under the cap.
    void f.mesh.respondNegotiate(neg.id, counter(neg.id, "agent_b"), "sess_b");
    await tick();
    expect(f.negotiations.get(neg.id)!.rounds_completed).toBe(2);

    // Row 3 would open exchange 2 → over the cap.
    await expect(
      f.mesh.respondNegotiate(neg.id, counter(neg.id, "agent_a"), "sess_a"),
    ).rejects.toBeInstanceOf(MeshMaxRoundsError);
    expect(f.rounds).toHaveLength(1);
    expect(f.negotiations.get(neg.id)!.rounds_completed).toBe(2);
  });

  it("carries the round numbers into MeshMaxRoundsError so the tool can prompt an escalation", async () => {
    const f = makeMesh();
    const neg = f.seedNegotiation({
      id: "neg_over",
      max_rounds: 2,
      rounds_completed: 4,
    });

    await expect(
      f.mesh.respondNegotiate(neg.id, counter(neg.id, "agent_a"), "sess_a"),
    ).rejects.toMatchObject({
      code: "MAX_ROUNDS_EXCEEDED",
      meta: { negotiationId: "neg_over", rounds_completed: 4, max_rounds: 2 },
    });
  });

  it("blocks the initiator key when neither side is waiting (B's reply to round 1)", async () => {
    const f = makeMesh();
    const neg = f.seedNegotiation({ id: "neg_first", counterparty_session_id: "sess_b" });

    // No sendNegotiate ran, so no resolver is registered — the counter must
    // still park the responder on the initiator key rather than dropping it.
    const blocked = f.mesh.respondNegotiate(neg.id, counter(neg.id, "agent_b"), "sess_b");
    await tick();

    f.mesh.unblockOnEscalate(neg.id, "esc_1");
    await expect(blocked).resolves.toMatchObject({ decision: "escalated" });
  });
});

describe("MeshServer.unblockOnEscalate", () => {
  it("releases the blocked peer with an add_to_escalation sentinel", async () => {
    const f = makeMesh();
    const initiatorPromise = f.mesh.sendNegotiate("agent_a", "agent_b", "p", {
      initiatorSessionId: "sess_a",
    });
    await tick();
    const negId = [...f.negotiations.keys()][0]!;

    f.mesh.unblockOnEscalate(negId, "esc_42");

    await expect(initiatorPromise).resolves.toEqual({
      decision: "escalated",
      message:
        "Peer initiated escalation. Submit your perspective via " +
        'add_to_escalation(escalation_id="esc_42", proposals, open_questions), then exit.',
      escalation_id: "esc_42",
      negotiation_id: negId,
    });
  });

  it("releases the responder side once the rounds have flipped", async () => {
    const f = makeMesh();
    const initiatorPromise = f.mesh.sendNegotiate("agent_a", "agent_b", "p", {
      initiatorSessionId: "sess_a",
    });
    await tick();
    const negId = [...f.negotiations.keys()][0]!;
    const counterpartySid = f.dispatchCalls[0]!.sessionIdOverride!;

    // B's counter resolves the initiator and parks B on the responder key.
    const bBlocked = f.mesh.respondNegotiate(negId, counter(negId, "agent_b"), counterpartySid);
    await expect(initiatorPromise).resolves.toMatchObject({ decision: "counter" });
    await tick();

    f.mesh.unblockOnEscalate(negId, "esc_43");
    await expect(bBlocked).resolves.toMatchObject({
      decision: "escalated",
      escalation_id: "esc_43",
    });
  });

  it("is a no-op when both sides already exited", () => {
    const { mesh } = makeMesh();
    expect(() => mesh.unblockOnEscalate("neg_gone", "esc_1")).not.toThrow();
  });
});

describe("MeshServer.reportBlocker", () => {
  it("dispatches a fire-and-forget blocker session to the parent", async () => {
    const f = makeMesh();
    f.mesh.reportBlocker("agent_parent", "agent_child", "task_7", "creds missing");
    await tick();

    const call = f.dispatchCalls[0]!;
    expect(call).toMatchObject({
      agentId: "agent_parent",
      type: "blocker",
      callerAgentId: "agent_child",
    });
    // Fire-and-forget: no pre-minted session id, nothing to wait on.
    expect(call.sessionIdOverride).toBeUndefined();
    expect(call.intent).toContain('<mesh-blocker from="agent_child" task_id="task_7">');
    expect(call.intent).toContain("creds missing");
    expect(call.intent).toContain('revise_task(task_id="task_7"');
  });

  it("does not capacity-gate the parent — a blocker report must always land", async () => {
    const f = makeMesh({ running: 99, agents: { agent_parent: { max_mesh_sessions: 1 } } });
    f.mesh.reportBlocker("agent_parent", "agent_child", "task_7", "stuck");
    await tick();
    expect(f.dispatchCalls).toHaveLength(1);
  });

  it("logs a dispatch failure instead of raising an unhandled rejection", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = makeMesh({ dispatchError: new Error("no runtime") });

    expect(() =>
      f.mesh.reportBlocker("agent_parent", "agent_child", "task_7", "stuck"),
    ).not.toThrow();
    await tick();

    expect(consoleError).toHaveBeenCalledWith(
      "[mesh] dispatch for agent_parent (blocker) failed:",
      "no runtime",
    );
  });

  it("reports a non-Error dispatch rejection verbatim", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = makeMesh({ dispatchError: "boom" as unknown as Error });

    f.mesh.reportBlocker("agent_parent", "agent_child", "task_7", "stuck");
    await tick();

    expect(consoleError).toHaveBeenCalledWith(
      "[mesh] dispatch for agent_parent (blocker) failed:",
      "boom",
    );
  });
});
