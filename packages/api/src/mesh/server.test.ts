/**
 * MeshServer unit tests.
 *
 * Two halves:
 *
 *   1. The failure-propagation path — when a callee session terminates
 *      non-success, the caller's pending `ask`/`negotiate` promise must
 *      reject within a tick instead of sitting through the 5-minute
 *      resolver timeout (which surfaces to the MCP layer as a generic
 *      "transport dropped" error).
 *
 *   2. The A2A broker itself: the capacity gate, the intents handed to
 *      the spawned callee, the negotiation row/round bookkeeping, the
 *      exchange cap arithmetic, who gets unblocked on each
 *      respond_negotiate, and the escalation sentinel. These ran only
 *      under the m6/m7 live-Postgres e2e scripts before; the repos are
 *      narrow enough to fake, so the branch logic is pinned here.
 *
 * Every test fakes the clock-free paths only — the 5-minute resolver
 * timers are never reached, and each test either resolves or rejects the
 * resolvers it registers so vitest doesn't sit on a live handle.
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

// ── Harness ──────────────────────────────────────────────────────────────

interface DispatchCall {
  agentId: string;
  type: string;
  intent: string;
  sessionIdOverride?: string;
  callerAgentId?: string;
  reason: unknown;
}

interface MeshHarness {
  mesh: MeshServer;
  dispatchCalls: DispatchCall[];
  dispatchTask: ReturnType<typeof vi.fn>;
  agentFindById: ReturnType<typeof vi.fn>;
  countRunningByAgent: ReturnType<typeof vi.fn>;
  negCreate: ReturnType<typeof vi.fn>;
  negUpdate: ReturnType<typeof vi.fn>;
  negFindById: ReturnType<typeof vi.fn>;
  roundCreate: ReturnType<typeof vi.fn>;
}

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent_x",
    name: "X",
    owner_id: "per_1",
    hierarchy_level: "team",
    max_mesh_sessions: 5,
    max_negotiation_rounds: 5,
    runtime_config: { type: "claude" },
    created_at: new Date("2026-01-01"),
    updated_at: new Date("2026-01-01"),
    ...overrides,
  } as Agent;
}

function fakeNegotiation(overrides: Partial<Negotiation> = {}): Negotiation {
  return {
    id: "neg_1",
    initiator_agent_id: "agent_caller",
    initiator_session_id: "sess_initiator",
    counterparty_agent_id: "agent_callee",
    status: "active",
    rounds_completed: 1,
    max_rounds: 5,
    created_at: new Date("2026-01-01"),
    updated_at: new Date("2026-01-01"),
    ...overrides,
  } as Negotiation;
}

function makeMesh(
  opts: {
    agents?: (id: string) => Agent | null;
    running?: number;
    negotiation?: Negotiation | null;
    dispatchImpl?: () => Promise<unknown>;
  } = {},
): MeshHarness {
  const dispatchCalls: DispatchCall[] = [];
  const dispatchTask = vi.fn(async (o: DispatchCall) => {
    dispatchCalls.push(o);
    if (opts.dispatchImpl) return opts.dispatchImpl();
    // MeshServer discards the return via `void`, so the value is moot.
    return {} as Awaited<ReturnType<DispatchService["dispatchTask"]>>;
  });

  const agentFindById = vi.fn(async (id: string) =>
    opts.agents ? opts.agents(id) : fakeAgent({ id, name: id }),
  );
  const countRunningByAgent = vi.fn(async () => opts.running ?? 0);
  // MeshServer mints the negotiation id itself; pin it to a known value
  // so the tests can drive respondNegotiate against the same row.
  const negCreate = vi.fn(async (row: Partial<Negotiation>) =>
    fakeNegotiation({ ...row, id: "neg_1", rounds_completed: 0 }),
  );
  const negUpdate = vi.fn(async () => undefined);
  const negFindById = vi.fn(async () =>
    opts.negotiation === undefined ? fakeNegotiation() : opts.negotiation,
  );
  const roundCreate = vi.fn(async (row: unknown) => row);

  const mesh = new MeshServer({
    agentRepo: { findById: agentFindById } as unknown as AgentRepository,
    sessionRepo: { countRunningByAgent } as unknown as SessionRepository,
    sessionEventRepo: {} as SessionEventRepository,
    negotiationRepo: {
      create: negCreate,
      update: negUpdate,
      findById: negFindById,
    } as unknown as NegotiationRepository,
    negotiationRoundRepo: {
      create: roundCreate,
    } as unknown as NegotiationRoundRepository,
    workspaceManager: {} as WorkspaceManager,
    runtimeRegistry: {} as RuntimeRegistry,
    dispatchService: { dispatchTask } as unknown as DispatchService,
    makeMemoryAgent: () => ({}) as never,
  });

  return {
    mesh,
    dispatchCalls,
    dispatchTask,
    agentFindById,
    countRunningByAgent,
    negCreate,
    negUpdate,
    negFindById,
    roundCreate,
  };
}

/** The dispatch is fire-and-forget; let it reach the spy. */
const tick = () => new Promise((r) => setImmediate(r));

function counter(overrides: Partial<NegotiateResponse> = {}): NegotiateResponse {
  return {
    negotiation_id: "neg_1",
    from_agent_id: "agent_callee",
    decision: "counter",
    message: "how about Tuesday",
    ...overrides,
  };
}

// ── Capacity gate ────────────────────────────────────────────────────────

describe("MeshServer — capacity gate", () => {
  it("fails ask fast when the target is at its mesh cap", async () => {
    const h = makeMesh({ running: 5 });
    await expect(
      h.mesh.sendAsk("req_1", "agent_caller", "agent_callee", "hi?"),
    ).rejects.toThrow(MeshCapacityError);
    // Nothing spawned for a request that can't be served.
    expect(h.dispatchTask).not.toHaveBeenCalled();
  });

  it("reports the running/cap numbers on the error so the agent can retry sensibly", async () => {
    const h = makeMesh({ running: 7 });
    const err = await h.mesh
      .sendAsk("req_1", "agent_caller", "agent_callee", "hi?")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MeshCapacityError);
    expect((err as MeshCapacityError).meta).toEqual({
      agentId: "agent_callee",
      running: 7,
      cap: 5,
    });
  });

  it("defaults the cap to 3 when the agent row doesn't set one", async () => {
    const h = makeMesh({
      agents: (id) => fakeAgent({ id, max_mesh_sessions: undefined }),
      running: 3,
    });
    const err = await h.mesh
      .sendAsk("req_1", "agent_caller", "agent_callee", "hi?")
      .catch((e: unknown) => e);
    expect((err as MeshCapacityError).meta.cap).toBe(3);
  });

  it("counts only the three mesh session types toward the cap", async () => {
    const h = makeMesh();
    const ask = h.mesh.sendAsk("req_1", "agent_caller", "agent_callee", "hi?");
    await tick();
    expect(h.countRunningByAgent).toHaveBeenCalledWith("agent_callee", [
      "mesh_ask",
      "mesh_negotiate",
      "blocker",
    ]);
    h.mesh.failResolverForCalleeSession(
      h.dispatchCalls[0]!.sessionIdOverride!,
      "cleanup",
    );
    await expect(ask).rejects.toThrow();
  });

  it("rejects when the target agent row is missing", async () => {
    const h = makeMesh({ agents: () => null });
    await expect(
      h.mesh.sendAsk("req_1", "agent_caller", "agent_missing", "hi?"),
    ).rejects.toThrow(/target agent not found: agent_missing/);
  });
});

// ── ask ──────────────────────────────────────────────────────────────────

describe("MeshServer.sendAsk", () => {
  it("dispatches a mesh_ask carrying the request id, asker and respond_ask instruction", async () => {
    const h = makeMesh();
    const ask = h.mesh.sendAsk("req_9", "agent_caller", "agent_callee", "ship it?");
    await tick();
    const call = h.dispatchCalls[0]!;
    expect(call).toMatchObject({
      agentId: "agent_callee",
      type: "mesh_ask",
      callerAgentId: "agent_caller",
      reason: { kind: "fresh" },
    });
    expect(call.intent).toContain('<mesh-ask request_id="req_9" from="agent_caller">');
    expect(call.intent).toContain("ship it?");
    expect(call.intent).toContain('respond_ask(request_id="req_9"');
    expect(call.sessionIdOverride).toMatch(/^sess_/);

    h.mesh.failResolverForCalleeSession(call.sessionIdOverride!, "cleanup");
    await expect(ask).rejects.toThrow();
  });

  it("escapes XML-special characters in the ids it interpolates", async () => {
    const h = makeMesh();
    const ask = h.mesh.sendAsk('req_"evil', "agent_caller", "agent_callee", "q");
    await tick();
    const intent = h.dispatchCalls[0]!.intent;
    // The XML attribute must stay well-formed. (The same id also appears
    // raw inside the prose tool-call instruction, which isn't markup.)
    expect(intent).toContain('<mesh-ask request_id="req_&quot;evil"');

    h.mesh.failResolverForCalleeSession(
      h.dispatchCalls[0]!.sessionIdOverride!,
      "cleanup",
    );
    await expect(ask).rejects.toThrow();
  });

  it("respondAsk for an unknown request id is a no-op, not a throw", () => {
    const h = makeMesh();
    expect(() =>
      h.mesh.respondAsk("req_nobody", {
        request_id: "req_nobody",
        from_agent_id: "agent_callee",
        answer: "hi",
      }),
    ).not.toThrow();
  });

  it("logs and swallows a dispatch failure instead of rejecting the asker synchronously", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = makeMesh({
      dispatchImpl: async () => {
        throw new Error("no daemon");
      },
    });
    const ask = h.mesh.sendAsk("req_1", "agent_caller", "agent_callee", "hi?");
    await tick();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("[mesh] dispatch for agent_callee (mesh_ask) failed:"),
      "no daemon",
    );
    // The asker is still waiting — the session-terminal hook is what
    // eventually frees them.
    h.mesh.failResolverForCalleeSession(
      h.dispatchCalls[0]!.sessionIdOverride!,
      "spawn_failed",
    );
    await expect(ask).rejects.toThrow(/spawn_failed/);
    errSpy.mockRestore();
  });
});

// ── negotiate: round 1 ───────────────────────────────────────────────────

describe("MeshServer.sendNegotiate", () => {
  it("refuses an IC target before touching capacity or the negotiation table", async () => {
    const h = makeMesh({
      agents: (id) =>
        fakeAgent({ id, hierarchy_level: id === "agent_ic" ? "ic" : "team" }),
    });
    await expect(
      h.mesh.sendNegotiate("agent_caller", "agent_ic", "split the work", {
        initiatorSessionId: "sess_initiator",
      }),
    ).rejects.toThrow(CannotNegotiateWithIcError);
    expect(h.countRunningByAgent).not.toHaveBeenCalled();
    expect(h.negCreate).not.toHaveBeenCalled();
  });

  it("rejects a missing target agent", async () => {
    const h = makeMesh({ agents: () => null });
    await expect(
      h.mesh.sendNegotiate("agent_caller", "agent_gone", "p", {
        initiatorSessionId: "sess_initiator",
      }),
    ).rejects.toThrow(/target agent not found: agent_gone/);
  });

  it("rejects a missing initiator agent", async () => {
    const h = makeMesh({
      agents: (id) => (id === "agent_caller" ? null : fakeAgent({ id })),
    });
    await expect(
      h.mesh.sendNegotiate("agent_caller", "agent_callee", "p", {
        initiatorSessionId: "sess_initiator",
      }),
    ).rejects.toThrow(/initiator agent not found: agent_caller/);
  });

  it("creates the negotiation, inserts round 1 and dispatches the counterparty", async () => {
    const h = makeMesh();
    const neg = h.mesh.sendNegotiate("agent_caller", "agent_callee", "split 60/40", {
      initiatorSessionId: "sess_initiator",
      taskId: "task_7",
    });
    await tick();

    expect(h.negCreate.mock.calls[0]?.[0]).toMatchObject({
      initiator_agent_id: "agent_caller",
      initiator_session_id: "sess_initiator",
      counterparty_agent_id: "agent_callee",
      task_id: "task_7",
      max_rounds: 5,
    });
    expect(h.roundCreate.mock.calls[0]?.[0]).toMatchObject({
      negotiation_id: "neg_1",
      round_number: 1,
      from_agent_id: "agent_caller",
      decision: "propose",
      message: "split 60/40",
    });
    // rounds_completed is bumped in the same step so B's first
    // respond_negotiate computes round 2, not a duplicate round 1.
    expect(h.negUpdate).toHaveBeenCalledWith("neg_1", { rounds_completed: 1 });

    const call = h.dispatchCalls[0]!;
    expect(call).toMatchObject({ agentId: "agent_callee", type: "mesh_negotiate" });
    expect(call.intent).toContain('<mesh-negotiate negotiation_id="neg_1"');
    expect(call.intent).toContain('round="1"');
    expect(call.intent).toContain("split 60/40");
    expect(call.intent).toContain("respond_negotiate");

    h.mesh.failResolverForCalleeSession(call.sessionIdOverride!, "cleanup");
    await expect(neg).rejects.toThrow();
  });

  it("stamps the initiator's own max_negotiation_rounds on the row", async () => {
    const h = makeMesh({
      agents: (id) =>
        fakeAgent({
          id,
          max_negotiation_rounds: id === "agent_caller" ? 2 : 9,
        }),
    });
    const neg = h.mesh.sendNegotiate("agent_caller", "agent_callee", "p", {
      initiatorSessionId: "sess_initiator",
    });
    await tick();
    expect(h.negCreate.mock.calls[0]?.[0].max_rounds).toBe(2);
    h.mesh.failResolverForCalleeSession(
      h.dispatchCalls[0]!.sessionIdOverride!,
      "cleanup",
    );
    await expect(neg).rejects.toThrow();
  });

  it("defaults max_rounds to 5 when the initiator doesn't set one", async () => {
    const h = makeMesh({
      agents: (id) => fakeAgent({ id, max_negotiation_rounds: undefined }),
    });
    const neg = h.mesh.sendNegotiate("agent_caller", "agent_callee", "p", {
      initiatorSessionId: "sess_initiator",
    });
    await tick();
    expect(h.negCreate.mock.calls[0]?.[0].max_rounds).toBe(5);
    h.mesh.failResolverForCalleeSession(
      h.dispatchCalls[0]!.sessionIdOverride!,
      "cleanup",
    );
    await expect(neg).rejects.toThrow();
  });
});

// ── negotiate: respondNegotiate ──────────────────────────────────────────

describe("MeshServer.respondNegotiate", () => {
  it("rejects an unknown negotiation id", async () => {
    const h = makeMesh({ negotiation: null });
    await expect(
      h.mesh.respondNegotiate("neg_gone", counter(), "sess_responder"),
    ).rejects.toThrow(/negotiation neg_gone not found/);
  });

  it.each([["accepted"], ["rejected"], ["escalated"]])(
    "refuses to continue a negotiation already %s",
    async (status) => {
      const h = makeMesh({
        negotiation: fakeNegotiation({ status: status as Negotiation["status"] }),
      });
      await expect(
        h.mesh.respondNegotiate("neg_1", counter(), "sess_responder"),
      ).rejects.toThrow(new RegExp(`not active \\(status='${status}'\\)`));
      expect(h.roundCreate).not.toHaveBeenCalled();
    },
  );

  it("stamps the counterparty session id on B's first response", async () => {
    const h = makeMesh();
    const pending = h.mesh.respondNegotiate("neg_1", counter(), "sess_bside");
    await tick();
    expect(h.negUpdate).toHaveBeenCalledWith("neg_1", {
      counterparty_session_id: "sess_bside",
    });
    h.mesh.unblockOnEscalate("neg_1", "esc_1");
    await pending;
  });

  it("does not re-stamp it once set", async () => {
    const h = makeMesh({
      negotiation: fakeNegotiation({ counterparty_session_id: "sess_bside" }),
    });
    const pending = h.mesh.respondNegotiate("neg_1", counter(), "sess_bside");
    await tick();
    expect(
      h.negUpdate.mock.calls.filter(
        (c) => c[1] && "counterparty_session_id" in c[1],
      ),
    ).toHaveLength(0);
    h.mesh.unblockOnEscalate("neg_1", "esc_1");
    await pending;
  });

  it("does not stamp it when the responder isn't the counterparty (A's own reply)", async () => {
    const h = makeMesh();
    const pending = h.mesh.respondNegotiate(
      "neg_1",
      counter({ from_agent_id: "agent_caller" }),
      "sess_aside",
    );
    await tick();
    expect(
      h.negUpdate.mock.calls.filter(
        (c) => c[1] && "counterparty_session_id" in c[1],
      ),
    ).toHaveLength(0);
    h.mesh.unblockOnEscalate("neg_1", "esc_1");
    await pending;
  });

  it("persists the round under the next round number and bumps the counter", async () => {
    const h = makeMesh({ negotiation: fakeNegotiation({ rounds_completed: 3 }) });
    const pending = h.mesh.respondNegotiate("neg_1", counter(), "sess_bside");
    await tick();
    expect(h.roundCreate.mock.calls[0]?.[0]).toMatchObject({
      negotiation_id: "neg_1",
      round_number: 4,
      from_agent_id: "agent_callee",
      decision: "counter",
      message: "how about Tuesday",
    });
    expect(h.negUpdate).toHaveBeenCalledWith("neg_1", { rounds_completed: 4 });
    h.mesh.unblockOnEscalate("neg_1", "esc_1");
    await pending;
  });

  describe("terminal decisions", () => {
    it.each([
      ["accept", "accepted"],
      ["reject", "rejected"],
    ] as const)("closes the negotiation as %s → %s and returns null", async (decision, status) => {
      const h = makeMesh();
      const out = await h.mesh.respondNegotiate(
        "neg_1",
        counter({ decision }),
        "sess_bside",
      );
      expect(out).toBeNull();
      expect(h.negUpdate).toHaveBeenCalledWith("neg_1", { status });
    });

    it("resolves the initiator's blocked promise with the accepting response", async () => {
      const h = makeMesh();
      const neg = h.mesh.sendNegotiate("agent_caller", "agent_callee", "p", {
        initiatorSessionId: "sess_initiator",
      });
      await tick();
      const accept = counter({ decision: "accept", message: "deal" });
      await h.mesh.respondNegotiate("neg_1", accept, "sess_bside");
      await expect(neg).resolves.toEqual(accept);
    });
  });

  describe("the exchange cap", () => {
    // max_rounds caps A↔B exchanges; each exchange is two rows.
    it.each([
      [1, 1, false], // row 2 completes exchange 1
      [2, 1, true], //  row 3 would start exchange 2
      [3, 2, false], // row 4 completes exchange 2
      [4, 2, true], //  row 5 would start exchange 3
    ])(
      "rounds_completed=%i, max_rounds=%i → throws: %s",
      async (rounds_completed, max_rounds, shouldThrow) => {
        const h = makeMesh({
          negotiation: fakeNegotiation({ rounds_completed, max_rounds }),
        });
        const call = h.mesh.respondNegotiate(
          "neg_1",
          counter({ decision: "accept" }),
          "sess_bside",
        );
        if (shouldThrow) {
          await expect(call).rejects.toThrow(MeshMaxRoundsError);
          expect(h.roundCreate).not.toHaveBeenCalled();
        } else {
          await expect(call).resolves.toBeNull();
        }
      },
    );

    it("carries the counts on the error so the agent can escalate instead", async () => {
      const h = makeMesh({
        negotiation: fakeNegotiation({ rounds_completed: 4, max_rounds: 2 }),
      });
      const err = await h.mesh
        .respondNegotiate("neg_1", counter(), "sess_bside")
        .catch((e: unknown) => e);
      expect((err as MeshMaxRoundsError).meta).toEqual({
        negotiationId: "neg_1",
        rounds_completed: 4,
        max_rounds: 2,
      });
      expect((err as Error).message).toContain("escalate_to_humans");
    });
  });

  describe("who gets unblocked", () => {
    it("resolves the initiator and blocks B when B counters round 1", async () => {
      const h = makeMesh();
      const neg = h.mesh.sendNegotiate("agent_caller", "agent_callee", "p", {
        initiatorSessionId: "sess_initiator",
      });
      await tick();

      const bCounter = counter();
      const bPending = h.mesh.respondNegotiate("neg_1", bCounter, "sess_bside");
      // A's await is satisfied by B's counter...
      await expect(neg).resolves.toEqual(bCounter);

      // ...and B is now the blocked side, so A's own counter releases it
      // (and leaves A blocked in turn).
      const aCounter = counter({ from_agent_id: "agent_caller", message: "Wednesday" });
      const aPending = h.mesh.respondNegotiate("neg_1", aCounter, "sess_aside");
      await expect(bPending).resolves.toEqual(aCounter);

      h.mesh.unblockOnEscalate("neg_1", "esc_1");
      await aPending;
    });

    it("alternates the blocked side across three exchanges", async () => {
      const h = makeMesh({
        negotiation: fakeNegotiation({ rounds_completed: 1, max_rounds: 9 }),
      });
      const neg = h.mesh.sendNegotiate("agent_caller", "agent_callee", "p", {
        initiatorSessionId: "sess_initiator",
      });
      await tick();

      const b1 = counter({ message: "b1" });
      const bWait1 = h.mesh.respondNegotiate("neg_1", b1, "sess_bside");
      await expect(neg).resolves.toEqual(b1);

      const a1 = counter({ from_agent_id: "agent_caller", message: "a1" });
      const aWait1 = h.mesh.respondNegotiate("neg_1", a1, "sess_aside");
      await expect(bWait1).resolves.toEqual(a1);

      const b2 = counter({ message: "b2" });
      const bWait2 = h.mesh.respondNegotiate("neg_1", b2, "sess_bside");
      await expect(aWait1).resolves.toEqual(b2);

      // Leave nothing waiting on a 5-minute timer.
      h.mesh.unblockOnEscalate("neg_1", "esc_1");
      await bWait2;
    });
  });
});

// ── escalation sentinel ──────────────────────────────────────────────────

describe("MeshServer.unblockOnEscalate", () => {
  it("releases the blocked side with an add_to_escalation instruction", async () => {
    const h = makeMesh();
    const neg = h.mesh.sendNegotiate("agent_caller", "agent_callee", "p", {
      initiatorSessionId: "sess_initiator",
    });
    await tick();

    h.mesh.unblockOnEscalate("neg_1", "esc_7");
    await expect(neg).resolves.toEqual({
      decision: "escalated",
      message: expect.stringContaining('add_to_escalation(escalation_id="esc_7"'),
      escalation_id: "esc_7",
      negotiation_id: "neg_1",
    });
  });

  it("releases both sides when both happen to be registered", async () => {
    const h = makeMesh();
    const neg = h.mesh.sendNegotiate("agent_caller", "agent_callee", "p", {
      initiatorSessionId: "sess_initiator",
    });
    await tick();
    // B counters → A resolves, B registers on the responder key. Then A
    // counters → B resolves, A registers on the initiator key. Register
    // one more waiter so both keys are live at escalation time.
    const bWait = h.mesh.respondNegotiate("neg_1", counter(), "sess_bside");
    await neg;
    const aWait = h.mesh.respondNegotiate(
      "neg_1",
      counter({ from_agent_id: "agent_caller" }),
      "sess_aside",
    );
    await bWait;
    const bWait2 = h.mesh.respondNegotiate("neg_1", counter(), "sess_bside");
    await aWait;

    h.mesh.unblockOnEscalate("neg_1", "esc_7");
    expect(await bWait2).toMatchObject({ decision: "escalated" });
  });

  it("is a no-op when both sides already exited", () => {
    const h = makeMesh();
    expect(() => h.mesh.unblockOnEscalate("neg_nobody", "esc_1")).not.toThrow();
  });
});

// ── blocker (fire-and-forget) ────────────────────────────────────────────

describe("MeshServer.reportBlocker", () => {
  it("dispatches the parent a blocker session with the revise_task instruction", async () => {
    const h = makeMesh();
    h.mesh.reportBlocker("agent_parent", "agent_child", "task_3", "CI is red");
    await tick();
    const call = h.dispatchCalls[0]!;
    expect(call).toMatchObject({
      agentId: "agent_parent",
      type: "blocker",
      callerAgentId: "agent_child",
    });
    expect(call.intent).toContain(
      '<mesh-blocker from="agent_child" task_id="task_3">',
    );
    expect(call.intent).toContain("CI is red");
    expect(call.intent).toContain('revise_task(task_id="task_3"');
    // Fire-and-forget: no pre-minted session, nobody waiting on it.
    expect(call.sessionIdOverride).toBeUndefined();
  });

  it("does not gate on the parent's mesh capacity", async () => {
    // A blocked subordinate must always be able to report upward.
    const h = makeMesh({ running: 99 });
    expect(() =>
      h.mesh.reportBlocker("agent_parent", "agent_child", "task_3", "stuck"),
    ).not.toThrow();
    await tick();
    expect(h.dispatchTask).toHaveBeenCalledTimes(1);
  });

  it("swallows a dispatch failure", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = makeMesh({
      dispatchImpl: async () => {
        throw "not even an Error";
      },
    });
    h.mesh.reportBlocker("agent_parent", "agent_child", "task_3", "stuck");
    await tick();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("[mesh] dispatch for agent_parent (blocker) failed:"),
      "not even an Error",
    );
    errSpy.mockRestore();
  });
});

// ── callee-session failure propagation ───────────────────────────────────

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

  it("rejects a negotiate waiter on the same index", async () => {
    const { mesh, dispatchCalls } = makeMesh();
    const neg = mesh.sendNegotiate("agent_caller", "agent_callee", "p", {
      initiatorSessionId: "sess_initiator",
    });
    await tick();
    mesh.failResolverForCalleeSession(
      dispatchCalls[0]!.sessionIdOverride!,
      "reaped",
    );
    await expect(neg).rejects.toThrow(/mesh callee session failed: reaped/);
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
});
