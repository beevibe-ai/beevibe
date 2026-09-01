/**
 * MeshServer's broker half — capacity gate, spawn dispatch, negotiation
 * round bookkeeping and the resolver handoff.
 *
 * `server.test.ts` covers one slice (failure propagation from a callee
 * session). The rest of the class was only exercised by the m6/m7 e2e
 * scripts, which need live Postgres plus spawned CLIs, so none of it ran
 * in CI. It is all in-process state machinery over four repos, though,
 * so fakes reach every branch — including the exchange-cap arithmetic,
 * which is the one piece of real logic in here (`max_rounds` counts A↔B
 * exchanges while the DB column counts rows) and the easiest to break.
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

const A = "agent_initiator";
const B = "agent_peer";

function fakeAgent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name: id,
    owner_id: "person_1",
    hierarchy_level: "team",
    runtime_config: { type: "claude" },
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as Agent;
}

function fakeNegotiation(overrides: Partial<Negotiation> = {}): Negotiation {
  return {
    id: "neg_1",
    initiator_agent_id: A,
    initiator_session_id: "sess_a",
    counterparty_agent_id: B,
    max_rounds: 5,
    rounds_completed: 1,
    status: "active",
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function harness(opts: { agents?: Record<string, Agent>; running?: number } = {}) {
  const agents = opts.agents ?? { [A]: fakeAgent(A), [B]: fakeAgent(B) };

  const agentRepo = {
    findById: vi.fn(async (id: string) => agents[id]),
  } as unknown as AgentRepository;

  const sessionRepo = {
    countRunningByAgent: vi.fn(async () => opts.running ?? 0),
  } as unknown as SessionRepository;

  let negotiation = fakeNegotiation();
  const negotiationRepo = {
    findById: vi.fn(async () => negotiation),
    create: vi.fn(async (input: Partial<Negotiation>) => {
      negotiation = fakeNegotiation({ ...input, rounds_completed: 0 });
      return negotiation;
    }),
    update: vi.fn(async (_id: string, patch: Partial<Negotiation>) => {
      negotiation = { ...negotiation, ...patch };
      return negotiation;
    }),
  } as unknown as NegotiationRepository;

  const negotiationRoundRepo = {
    create: vi.fn(async (input: Partial<NegotiationRound>) => input as NegotiationRound),
  } as unknown as NegotiationRoundRepository;

  const dispatchService = {
    dispatchTask: vi.fn().mockResolvedValue({ session: {}, runtime_id: null }),
  } as unknown as DispatchService;

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

  return {
    mesh,
    agentRepo,
    sessionRepo,
    negotiationRepo,
    negotiationRoundRepo,
    dispatchService,
    /** Current state of the single negotiation the fake repo holds. */
    negotiation: () => negotiation,
    setNegotiation: (patch: Partial<Negotiation>) => {
      negotiation = { ...negotiation, ...patch };
    },
    /** Latest dispatch call's payload. */
    lastDispatch: () =>
      vi.mocked(dispatchService.dispatchTask).mock.calls.at(-1)?.[0] as
        | Record<string, unknown>
        | undefined,
  };
}

/** Let the fire-and-forget spawn microtasks settle. */
const settle = () => new Promise((r) => setImmediate(r));

afterEach(() => {
  vi.useRealTimers();
});

// ── capacity gate ────────────────────────────────────────────────────────

describe("mesh capacity gate", () => {
  it("throws MeshCapacityError with the counts once the target is at cap", async () => {
    const h = harness({
      agents: { [A]: fakeAgent(A), [B]: fakeAgent(B, { max_mesh_sessions: 2 }) },
      running: 2,
    });

    await expect(h.mesh.sendAsk("req_1", A, B, "q")).rejects.toBeInstanceOf(
      MeshCapacityError,
    );
    expect(h.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("falls back to the default cap of 3 when the agent sets none", async () => {
    const h = harness({ running: 3 });
    const err = await h.mesh.sendAsk("req_1", A, B, "q").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MeshCapacityError);
    expect((err as MeshCapacityError).meta).toEqual({ agentId: B, running: 3, cap: 3 });
  });

  it("counts only the three mesh session types toward the cap", async () => {
    const h = harness();
    void h.mesh.sendAsk("req_1", A, B, "q");
    await settle();
    expect(h.sessionRepo.countRunningByAgent).toHaveBeenCalledWith(B, [
      "mesh_ask",
      "mesh_negotiate",
      "blocker",
    ]);
  });

  it("throws a plain error when the target agent does not exist", async () => {
    const h = harness({ agents: { [A]: fakeAgent(A) } });
    await expect(h.mesh.sendAsk("req_1", A, "agent_ghost", "q")).rejects.toThrow(
      "target agent not found: agent_ghost",
    );
  });
});

// ── ask ──────────────────────────────────────────────────────────────────

describe("sendAsk / respondAsk", () => {
  it("dispatches a mesh_ask session and resolves when respond_ask fires", async () => {
    const h = harness();
    const pending = h.mesh.sendAsk("req_1", A, B, "is X feasible?");
    await settle();

    const dispatched = h.lastDispatch();
    expect(dispatched).toMatchObject({
      agentId: B,
      type: "mesh_ask",
      reason: { kind: "fresh" },
      callerAgentId: A,
    });
    expect(String(dispatched?.intent)).toContain('<mesh-ask request_id="req_1" from="agent_initiator">');
    expect(String(dispatched?.intent)).toContain("is X feasible?");
    // The callee session id is pre-minted so the failure path can find it.
    expect(String(dispatched?.sessionIdOverride)).toMatch(/^sess_/);
    expect(h.mesh.hasPendingCalleeSession(String(dispatched?.sessionIdOverride))).toBe(true);

    h.mesh.respondAsk("req_1", { request_id: "req_1", from_agent_id: B, answer: "yes" });
    await expect(pending).resolves.toEqual({
      request_id: "req_1",
      from_agent_id: B,
      answer: "yes",
    });
    // Reverse index drained once the waiter resolved.
    expect(h.mesh.hasPendingCalleeSession(String(dispatched?.sessionIdOverride))).toBe(false);
  });

  it("escapes XML-significant characters in the ask intent attributes", async () => {
    const h = harness();
    void h.mesh.sendAsk('req"1', A, B, "q");
    await settle();
    const intent = String(h.lastDispatch()?.intent);
    expect(intent).toContain('request_id="req&quot;1"');
  });

  it("ignores a respond_ask for a request nobody is waiting on", () => {
    const h = harness();
    expect(() =>
      h.mesh.respondAsk("req_unknown", {
        request_id: "req_unknown",
        from_agent_id: B,
        answer: "a",
      }),
    ).not.toThrow();
  });

  it("rejects the asker when the resolver times out", async () => {
    vi.useFakeTimers();
    const h = harness();
    const pending = h.mesh.sendAsk("req_1", A, B, "q");
    const assertion = expect(pending).rejects.toThrow(/mesh resolver timeout/);
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    await assertion;
  });

  it("swallows a dispatch failure — the resolver, not the spawn, is awaited", async () => {
    const h = harness();
    vi.mocked(h.dispatchService.dispatchTask).mockRejectedValue(new Error("no runtime"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const pending = h.mesh.sendAsk("req_1", A, B, "q");
    await settle();
    expect(spy).toHaveBeenCalled();

    // The caller is still blocked on the resolver, not rejected by the spawn.
    h.mesh.respondAsk("req_1", { request_id: "req_1", from_agent_id: B, answer: "a" });
    await expect(pending).resolves.toMatchObject({ answer: "a" });
    spy.mockRestore();
  });
});

// ── negotiate: round 1 ───────────────────────────────────────────────────

describe("sendNegotiate", () => {
  it("creates the negotiation, records round 1, and spawns the peer", async () => {
    const h = harness();
    void h.mesh.sendNegotiate(A, B, "ship friday", {
      taskId: "tsk_1",
      initiatorSessionId: "sess_a",
    });
    await settle();

    expect(h.negotiationRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        initiator_agent_id: A,
        initiator_session_id: "sess_a",
        counterparty_agent_id: B,
        task_id: "tsk_1",
        max_rounds: 5,
      }),
    );
    expect(h.negotiationRoundRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        round_number: 1,
        from_agent_id: A,
        decision: "propose",
        message: "ship friday",
      }),
    );
    // rounds_completed is bumped in the same logical step so B's first
    // respond_negotiate lands on round 2 rather than colliding on 1.
    expect(h.negotiationRepo.update).toHaveBeenCalledWith(
      expect.any(String),
      { rounds_completed: 1 },
    );
    expect(h.lastDispatch()).toMatchObject({ agentId: B, type: "mesh_negotiate" });
  });

  it("stamps max_rounds from the initiator's own configuration", async () => {
    const h = harness({
      agents: {
        [A]: fakeAgent(A, { max_negotiation_rounds: 2 }),
        [B]: fakeAgent(B),
      },
    });
    void h.mesh.sendNegotiate(A, B, "p", { initiatorSessionId: "sess_a" });
    await settle();
    expect(h.negotiationRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ max_rounds: 2 }),
    );
  });

  it("refuses an IC target before touching capacity or the DB", async () => {
    const h = harness({
      agents: { [A]: fakeAgent(A), [B]: fakeAgent(B, { hierarchy_level: "ic" }) },
    });

    await expect(
      h.mesh.sendNegotiate(A, B, "p", { initiatorSessionId: "sess_a" }),
    ).rejects.toBeInstanceOf(CannotNegotiateWithIcError);
    expect(h.sessionRepo.countRunningByAgent).not.toHaveBeenCalled();
    expect(h.negotiationRepo.create).not.toHaveBeenCalled();
  });

  it("throws when the initiator agent row is missing", async () => {
    const h = harness({ agents: { [B]: fakeAgent(B) } });
    await expect(
      h.mesh.sendNegotiate("agent_ghost", B, "p", { initiatorSessionId: "sess_a" }),
    ).rejects.toThrow("initiator agent not found: agent_ghost");
  });

  it("resolves the initiator when the peer's first respond_negotiate lands", async () => {
    const h = harness();
    const pending = h.mesh.sendNegotiate(A, B, "p", { initiatorSessionId: "sess_a" });
    await settle();

    const reply: NegotiateResponse = {
      negotiation_id: h.negotiation().id,
      from_agent_id: B,
      decision: "accept",
      message: "deal",
    };
    await h.mesh.respondNegotiate(h.negotiation().id, reply, "sess_b");

    await expect(pending).resolves.toEqual(reply);
  });
});

// ── negotiate: subsequent rounds ─────────────────────────────────────────

describe("respondNegotiate", () => {
  it("throws when the negotiation does not exist", async () => {
    const h = harness();
    vi.mocked(h.negotiationRepo.findById).mockResolvedValue(undefined);
    await expect(
      h.mesh.respondNegotiate(
        "neg_gone",
        { negotiation_id: "neg_gone", from_agent_id: B, decision: "accept", message: "m" },
        "sess_b",
      ),
    ).rejects.toThrow("negotiation neg_gone not found");
  });

  it.each(["accepted", "rejected", "escalated"] as const)(
    "refuses to add a round to a %s negotiation",
    async (status) => {
      const h = harness();
      h.setNegotiation({ status });
      await expect(
        h.mesh.respondNegotiate(
          "neg_1",
          { negotiation_id: "neg_1", from_agent_id: B, decision: "accept", message: "m" },
          "sess_b",
        ),
      ).rejects.toThrow(`is not active (status='${status}')`);
      expect(h.negotiationRoundRepo.create).not.toHaveBeenCalled();
    },
  );

  it("stamps counterparty_session_id on the peer's first response", async () => {
    const h = harness();
    await h.mesh.respondNegotiate(
      "neg_1",
      { negotiation_id: "neg_1", from_agent_id: B, decision: "accept", message: "ok" },
      "sess_b",
    );
    expect(h.negotiationRepo.update).toHaveBeenCalledWith("neg_1", {
      counterparty_session_id: "sess_b",
    });
  });

  it("does not re-stamp the session id on later rounds", async () => {
    const h = harness();
    h.setNegotiation({ counterparty_session_id: "sess_b" });
    await h.mesh.respondNegotiate(
      "neg_1",
      { negotiation_id: "neg_1", from_agent_id: B, decision: "accept", message: "ok" },
      "sess_b_other",
    );
    expect(h.negotiationRepo.update).not.toHaveBeenCalledWith(
      "neg_1",
      expect.objectContaining({ counterparty_session_id: expect.anything() }),
    );
  });

  it("does not stamp the session id for a response from the initiator's side", async () => {
    const h = harness();
    await h.mesh.respondNegotiate(
      "neg_1",
      { negotiation_id: "neg_1", from_agent_id: A, decision: "accept", message: "ok" },
      "sess_a",
    );
    expect(h.negotiationRepo.update).not.toHaveBeenCalledWith(
      "neg_1",
      expect.objectContaining({ counterparty_session_id: expect.anything() }),
    );
  });

  it.each([
    ["accept", "accepted"],
    ["reject", "rejected"],
  ] as const)("closes the negotiation as %s → %s and returns null", async (decision, status) => {
    const h = harness();
    const result = await h.mesh.respondNegotiate(
      "neg_1",
      { negotiation_id: "neg_1", from_agent_id: B, decision, message: "m" },
      "sess_b",
    );
    expect(result).toBeNull();
    expect(h.negotiationRepo.update).toHaveBeenCalledWith("neg_1", { status });
  });

  it("persists each round under the next round number", async () => {
    const h = harness();
    h.setNegotiation({ rounds_completed: 3 });
    await h.mesh.respondNegotiate(
      "neg_1",
      { negotiation_id: "neg_1", from_agent_id: B, decision: "accept", message: "m" },
      "sess_b",
    );
    expect(h.negotiationRoundRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ round_number: 4, from_agent_id: B, decision: "accept" }),
    );
    expect(h.negotiationRepo.update).toHaveBeenCalledWith("neg_1", {
      rounds_completed: 4,
    });
  });

  it("blocks the responder on a counter, and resolves it on the peer's reply", async () => {
    const h = harness();
    h.setNegotiation({ counterparty_session_id: "sess_b" });

    // B counters → B blocks on the initiator key (nobody was waiting).
    const bWaiting = h.mesh.respondNegotiate(
      "neg_1",
      {
        negotiation_id: "neg_1",
        from_agent_id: B,
        decision: "counter",
        message: "not friday",
        counter_proposal: "wednesday",
      },
      "sess_b",
    );
    await settle();
    // The waiter is tied to B's resident session so a failure reaches it.
    expect(h.mesh.hasPendingCalleeSession("sess_b")).toBe(true);

    // A replies with accept → resolves B's pending promise, terminal for A.
    const aReply: NegotiateResponse = {
      negotiation_id: "neg_1",
      from_agent_id: A,
      decision: "accept",
      message: "fine, wednesday",
    };
    await expect(h.mesh.respondNegotiate("neg_1", aReply, "sess_a")).resolves.toBeNull();
    await expect(bWaiting).resolves.toEqual(aReply);
  });

  describe("max-rounds cap", () => {
    // max_rounds counts A↔B exchanges; the column counts rows. Row N
    // belongs to exchange ceil(N/2), so with a cap of 2 the first row
    // that opens exchange 3 is row 5 — i.e. rounds_completed = 4.
    it.each([
      [1, false],
      [2, false],
      [3, false],
      [4, true],
      [5, true],
    ])("rounds_completed=%i → throws: %s", async (completed, shouldThrow) => {
      const h = harness();
      h.setNegotiation({ rounds_completed: completed, max_rounds: 2 });
      const call = h.mesh.respondNegotiate(
        "neg_1",
        {
          negotiation_id: "neg_1",
          from_agent_id: B,
          decision: "accept",
          message: "m",
        },
        "sess_b",
      );
      if (shouldThrow) {
        await expect(call).rejects.toBeInstanceOf(MeshMaxRoundsError);
      } else {
        await expect(call).resolves.toBeNull();
      }
    });

    it("carries the counters the agent needs to decide to escalate", async () => {
      const h = harness();
      h.setNegotiation({ rounds_completed: 10, max_rounds: 5 });
      const err = await h.mesh
        .respondNegotiate(
          "neg_1",
          { negotiation_id: "neg_1", from_agent_id: B, decision: "accept", message: "m" },
          "sess_b",
        )
        .catch((e: unknown) => e);

      expect((err as MeshMaxRoundsError).meta).toEqual({
        negotiationId: "neg_1",
        rounds_completed: 10,
        max_rounds: 5,
      });
      // No round was written on the rejected path.
      expect(h.negotiationRoundRepo.create).not.toHaveBeenCalled();
    });
  });
});

// ── escalation sentinel ──────────────────────────────────────────────────

describe("unblockOnEscalate", () => {
  it("releases whichever side is blocked with the escalated sentinel", async () => {
    const h = harness();
    h.setNegotiation({ counterparty_session_id: "sess_b" });
    const bWaiting = h.mesh.respondNegotiate(
      "neg_1",
      {
        negotiation_id: "neg_1",
        from_agent_id: B,
        decision: "counter",
        message: "m",
        counter_proposal: "c",
      },
      "sess_b",
    );
    await settle();

    h.mesh.unblockOnEscalate("neg_1", "esc_1");

    const sentinel = await bWaiting;
    expect(sentinel).toMatchObject({
      decision: "escalated",
      escalation_id: "esc_1",
      negotiation_id: "neg_1",
    });
    expect(String((sentinel as { message: string }).message)).toContain("add_to_escalation");
  });

  it("releases the initiator still waiting on round 1", async () => {
    const h = harness();
    const pending = h.mesh.sendNegotiate(A, B, "p", { initiatorSessionId: "sess_a" });
    await settle();

    h.mesh.unblockOnEscalate(h.negotiation().id, "esc_1");
    await expect(pending).resolves.toMatchObject({ decision: "escalated" });
  });

  it("is a no-op when both sides have already exited", () => {
    const h = harness();
    expect(() => h.mesh.unblockOnEscalate("neg_nobody", "esc_1")).not.toThrow();
  });
});

// ── blocker ──────────────────────────────────────────────────────────────

describe("reportBlocker", () => {
  it("dispatches a blocker session to the parent with revise_task guidance", async () => {
    const h = harness();
    h.mesh.reportBlocker("agent_parent", B, "tsk_1", "the API key is missing");
    await settle();

    const dispatched = h.lastDispatch();
    expect(dispatched).toMatchObject({
      agentId: "agent_parent",
      type: "blocker",
      callerAgentId: B,
      // Fire-and-forget: no pre-minted session id to wait on.
      sessionIdOverride: undefined,
    });
    const intent = String(dispatched?.intent);
    expect(intent).toContain('<mesh-blocker from="agent_peer" task_id="tsk_1">');
    expect(intent).toContain("the API key is missing");
    expect(intent).toContain('revise_task(task_id="tsk_1"');
  });

  it("returns synchronously even when the dispatch rejects", async () => {
    const h = harness();
    vi.mocked(h.dispatchService.dispatchTask).mockRejectedValue(new Error("offline"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => h.mesh.reportBlocker("agent_parent", B, "tsk_1", "d")).not.toThrow();
    await settle();
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[mesh] dispatch for agent_parent (blocker) failed:"),
      "offline",
    );
    spy.mockRestore();
  });
});
