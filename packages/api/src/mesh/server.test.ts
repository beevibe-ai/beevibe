/**
 * MeshServer unit tests.
 *
 * The broker is in-process, so the resolver map, the capacity gate and
 * the negotiation round machine are all reachable with fakes — no
 * Postgres and no spawned CLI. What the m6/m7 e2e scripts still own is
 * the far side of `spawnTargetSession`: a real daemon claiming the
 * pending row and a real agent calling back in.
 *
 * Two patterns recur below:
 *   - `ask`/`negotiate` return a promise that only settles when the
 *     peer responds, so tests hold the promise, drive the peer, then
 *     await. An unsettled one would hang for the 5-minute timeout.
 *   - the callee session id is pre-minted inside the server, so tests
 *     read it back off the dispatch spy after an event-loop tick.
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
  reason?: unknown;
}

function fakeNegotiation(overrides: Partial<Negotiation> = {}): Negotiation {
  return {
    id: "neg_1",
    initiator_agent_id: "agent_a",
    initiator_session_id: "sess_a",
    counterparty_agent_id: "agent_b",
    status: "active",
    rounds_completed: 1,
    max_rounds: 5,
    created_at: new Date("2026-04-01"),
    updated_at: new Date("2026-04-01"),
    ...overrides,
  } as Negotiation;
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
    findById: vi.fn(
      async (id: string) =>
        ({
          id,
          name: id,
          owner_id: "per_1",
          hierarchy_level: "team" as const,
          max_mesh_sessions: 5,
          max_negotiation_rounds: 5,
          runtime_config: { type: "claude" as const },
        }) as unknown as Agent,
    ),
    ...overrides.agentRepo,
  } as unknown as AgentRepository;

  const sessionRepo = {
    countRunningByAgent: vi.fn(async () => 0),
    ...overrides.sessionRepo,
  } as unknown as SessionRepository;

  const negotiationRepo = {
    // Pin the id: the server mints its own, but every resolver key in
    // these tests is built from `neg_1`.
    create: vi.fn(async (input: Partial<Negotiation>) =>
      fakeNegotiation({ ...input, id: "neg_1" }),
    ),
    findById: vi.fn(async () => fakeNegotiation()),
    update: vi.fn(async () => fakeNegotiation()),
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

  return {
    mesh,
    dispatchCalls,
    agentRepo,
    sessionRepo,
    negotiationRepo,
    negotiationRoundRepo,
  };
}

/** Let the server's pre-spawn awaits settle so the dispatch spy has run. */
const tick = () => new Promise((r) => setImmediate(r));

function negotiateResponse(
  overrides: Partial<NegotiateResponse> = {},
): NegotiateResponse {
  return {
    negotiation_id: "neg_1",
    from_agent_id: "agent_b",
    decision: "counter",
    message: "how about this",
    counter_proposal: "two phases",
    ...overrides,
  };
}

// ── Capacity gate ────────────────────────────────────────────────────────

describe("MeshServer — mesh capacity gate", () => {
  it("counts only mesh session types against the cap", async () => {
    const { mesh, sessionRepo } = makeMesh();
    const ask = mesh.sendAsk("req_1", "agent_a", "agent_b", "q");
    await tick();
    expect(sessionRepo.countRunningByAgent).toHaveBeenCalledWith("agent_b", [
      "mesh_ask",
      "mesh_negotiate",
      "blocker",
    ]);
    mesh.respondAsk("req_1", {
      request_id: "req_1",
      from_agent_id: "agent_b",
      answer: "a",
    });
    await ask;
  });

  it("rejects at the cap with the running count and cap in meta", async () => {
    const { mesh, dispatchCalls } = makeMesh({
      sessionRepo: { countRunningByAgent: vi.fn(async () => 5) },
    });
    const err = await mesh
      .sendAsk("req_1", "agent_a", "agent_b", "q")
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MeshCapacityError);
    expect((err as MeshCapacityError).meta).toEqual({
      agentId: "agent_b",
      running: 5,
      cap: 5,
    });
    // Fail-fast: nothing was spawned.
    expect(dispatchCalls).toHaveLength(0);
  });

  it("falls back to a cap of 3 when the agent sets none", async () => {
    const { mesh } = makeMesh({
      agentRepo: {
        findById: vi.fn(
          async (id: string) =>
            ({
              id,
              hierarchy_level: "team",
              max_mesh_sessions: null,
              runtime_config: { type: "claude" },
            }) as unknown as Agent,
        ),
      },
      sessionRepo: { countRunningByAgent: vi.fn(async () => 3) },
    });
    const err = await mesh
      .sendAsk("req_1", "agent_a", "agent_b", "q")
      .catch((e: unknown) => e);
    expect((err as MeshCapacityError).meta).toMatchObject({ cap: 3 });
  });

  it("admits the request one below the cap", async () => {
    const { mesh, dispatchCalls } = makeMesh({
      sessionRepo: { countRunningByAgent: vi.fn(async () => 4) },
    });
    const ask = mesh.sendAsk("req_1", "agent_a", "agent_b", "q");
    await tick();
    expect(dispatchCalls).toHaveLength(1);
    mesh.respondAsk("req_1", {
      request_id: "req_1",
      from_agent_id: "agent_b",
      answer: "a",
    });
    await ask;
  });

  it("errors when the target agent does not exist", async () => {
    const { mesh } = makeMesh({
      agentRepo: { findById: vi.fn(async () => undefined) },
    });
    await expect(
      mesh.sendAsk("req_1", "agent_a", "agent_gone", "q"),
    ).rejects.toThrow("target agent not found: agent_gone");
  });
});

// ── sendAsk spawn shape ──────────────────────────────────────────────────

describe("MeshServer.sendAsk — spawned session", () => {
  it("dispatches a mesh_ask carrying the request id and the responder's cue", async () => {
    const { mesh, dispatchCalls } = makeMesh();
    const ask = mesh.sendAsk("req_1", "agent_a", "agent_b", "is X feasible?");
    await tick();

    const call = dispatchCalls[0];
    expect(call).toMatchObject({
      agentId: "agent_b",
      type: "mesh_ask",
      callerAgentId: "agent_a",
      reason: { kind: "fresh" },
    });
    expect(call?.intent).toContain('<mesh-ask request_id="req_1"');
    expect(call?.intent).toContain("is X feasible?");
    // Without this instruction the callee answers in chat and the asker
    // waits out the full timeout.
    expect(call?.intent).toContain('respond_ask(request_id="req_1"');

    mesh.respondAsk("req_1", {
      request_id: "req_1",
      from_agent_id: "agent_b",
      answer: "a",
    });
    await ask;
  });

  it("escapes XML-significant characters in the ids", async () => {
    const { mesh, dispatchCalls } = makeMesh();
    const ask = mesh.sendAsk('req"1', 'agent"a', "agent_b", "q");
    await tick();
    // A raw quote in the attribute would close it early and corrupt the
    // tag. The `<context>` body interpolates the id unescaped — quotes
    // are legal in element text — so only the tag is checked here.
    const tag = dispatchCalls[0]?.intent.split("\n")[0];
    expect(tag).toBe('<mesh-ask request_id="req&quot;1" from="agent&quot;a">');

    mesh.respondAsk('req"1', {
      request_id: 'req"1',
      from_agent_id: "agent_b",
      answer: "a",
    });
    await ask;
  });

  it("swallows and logs a dispatch failure rather than rejecting the caller", async () => {
    // The caller awaits the resolver, not the spawn. A dispatch crash
    // must not turn into an unhandled rejection.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { mesh } = makeMesh({
      dispatchService: {
        dispatchTask: vi.fn(async () => {
          throw new Error("no runtime");
        }),
      },
    });
    const ask = mesh.sendAsk("req_1", "agent_a", "agent_b", "q");
    await tick();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("[mesh] dispatch for agent_b (mesh_ask) failed:"),
      "no runtime",
    );

    // The resolver is still live and still resolvable.
    mesh.respondAsk("req_1", {
      request_id: "req_1",
      from_agent_id: "agent_b",
      answer: "a",
    });
    await expect(ask).resolves.toMatchObject({ answer: "a" });
    errSpy.mockRestore();
  });

  it("ignores a respond_ask for an unknown request", () => {
    const { mesh } = makeMesh();
    expect(() =>
      mesh.respondAsk("req_nobody", {
        request_id: "req_nobody",
        from_agent_id: "agent_b",
        answer: "a",
      }),
    ).not.toThrow();
  });
});

// ── sendNegotiate ────────────────────────────────────────────────────────

describe("MeshServer.sendNegotiate", () => {
  it("refuses an IC target before creating any rows", async () => {
    const { mesh, negotiationRepo, dispatchCalls } = makeMesh({
      agentRepo: {
        findById: vi.fn(
          async (id: string) =>
            ({
              id,
              hierarchy_level: "ic",
              runtime_config: { type: "claude" },
            }) as unknown as Agent,
        ),
      },
    });
    const err = await mesh
      .sendNegotiate("agent_a", "agent_ic", "p", {
        initiatorSessionId: "sess_a",
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CannotNegotiateWithIcError);
    expect((err as CannotNegotiateWithIcError).meta).toEqual({
      agentId: "agent_ic",
    });
    // ICs have no respond_negotiate, so the negotiation would hang
    // forever — nothing must be persisted or spawned.
    expect(negotiationRepo.create).not.toHaveBeenCalled();
    expect(dispatchCalls).toHaveLength(0);
  });

  it("errors on an unknown target", async () => {
    const { mesh } = makeMesh({
      agentRepo: { findById: vi.fn(async () => undefined) },
    });
    await expect(
      mesh.sendNegotiate("agent_a", "agent_gone", "p", {
        initiatorSessionId: "sess_a",
      }),
    ).rejects.toThrow("target agent not found: agent_gone");
  });

  it("errors on an unknown initiator", async () => {
    const { mesh } = makeMesh({
      agentRepo: {
        findById: vi.fn(async (id: string) =>
          id === "agent_a"
            ? undefined
            : ({
                id,
                hierarchy_level: "team",
                max_mesh_sessions: 5,
                runtime_config: { type: "claude" },
              } as unknown as Agent),
        ),
      },
    });
    await expect(
      mesh.sendNegotiate("agent_a", "agent_b", "p", {
        initiatorSessionId: "sess_a",
      }),
    ).rejects.toThrow("initiator agent not found: agent_a");
  });

  it("creates the negotiation stamped with the initiator's max_rounds", async () => {
    const { mesh, negotiationRepo } = makeMesh();
    const neg = mesh.sendNegotiate("agent_a", "agent_b", "ship it", {
      taskId: "task_1",
      initiatorSessionId: "sess_a",
    });
    await tick();

    expect(negotiationRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        initiator_agent_id: "agent_a",
        initiator_session_id: "sess_a",
        counterparty_agent_id: "agent_b",
        task_id: "task_1",
        max_rounds: 5,
      }),
    );

    await mesh.respondNegotiate("neg_1", negotiateResponse({ decision: "accept" }), "sess_b");
    await neg;
  });

  it("defaults max_rounds to 5 when the initiator sets none", async () => {
    const { mesh, negotiationRepo } = makeMesh({
      agentRepo: {
        findById: vi.fn(
          async (id: string) =>
            ({
              id,
              hierarchy_level: "team",
              max_mesh_sessions: 5,
              max_negotiation_rounds: null,
              runtime_config: { type: "claude" },
            }) as unknown as Agent,
        ),
      },
    });
    const neg = mesh.sendNegotiate("agent_a", "agent_b", "p", {
      initiatorSessionId: "sess_a",
    });
    await tick();
    expect(negotiationRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ max_rounds: 5 }),
    );

    await mesh.respondNegotiate("neg_1", negotiateResponse({ decision: "accept" }), "sess_b");
    await neg;
  });

  it("inserts round 1 as a propose and advances rounds_completed to 1", async () => {
    const { mesh, negotiationRepo, negotiationRoundRepo } = makeMesh();
    const neg = mesh.sendNegotiate("agent_a", "agent_b", "ship it", {
      initiatorSessionId: "sess_a",
    });
    await tick();

    expect(negotiationRoundRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        negotiation_id: "neg_1",
        round_number: 1,
        from_agent_id: "agent_a",
        decision: "propose",
        message: "ship it",
      }),
    );
    // Without this bump B's first respond_negotiate retries round 1 and
    // trips the UNIQUE constraint on negotiation_round.
    expect(negotiationRepo.update).toHaveBeenCalledWith("neg_1", {
      rounds_completed: 1,
    });

    await mesh.respondNegotiate("neg_1", negotiateResponse({ decision: "accept" }), "sess_b");
    await neg;
  });

  it("dispatches a mesh_negotiate carrying round 1 and the response cue", async () => {
    const { mesh, dispatchCalls } = makeMesh();
    const neg = mesh.sendNegotiate("agent_a", "agent_b", "ship behind a flag", {
      initiatorSessionId: "sess_a",
    });
    await tick();

    expect(dispatchCalls[0]).toMatchObject({
      agentId: "agent_b",
      type: "mesh_negotiate",
      callerAgentId: "agent_a",
    });
    expect(dispatchCalls[0]?.intent).toContain('round="1"');
    expect(dispatchCalls[0]?.intent).toContain("ship behind a flag");
    expect(dispatchCalls[0]?.intent).toContain("respond_negotiate(");

    await mesh.respondNegotiate("neg_1", negotiateResponse({ decision: "accept" }), "sess_b");
    await neg;
  });

  it("resolves the initiator with B's first response", async () => {
    const { mesh } = makeMesh();
    const neg = mesh.sendNegotiate("agent_a", "agent_b", "p", {
      initiatorSessionId: "sess_a",
    });
    await tick();

    await mesh.respondNegotiate(
      "neg_1",
      negotiateResponse({ decision: "reject", message: "no" }),
      "sess_b",
    );
    await expect(neg).resolves.toMatchObject({
      decision: "reject",
      message: "no",
      from_agent_id: "agent_b",
    });
  });
});

// ── respondNegotiate ─────────────────────────────────────────────────────

describe("MeshServer.respondNegotiate — guards", () => {
  it("errors on an unknown negotiation", async () => {
    const { mesh } = makeMesh({
      negotiationRepo: { findById: vi.fn(async () => undefined) },
    });
    await expect(
      mesh.respondNegotiate("neg_404", negotiateResponse(), "sess_b"),
    ).rejects.toThrow("negotiation neg_404 not found");
  });

  it.each(["accepted", "rejected", "escalated"] as const)(
    "refuses to add a round to a %s negotiation",
    async (status) => {
      const { mesh, negotiationRoundRepo } = makeMesh({
        negotiationRepo: {
          findById: vi.fn(async () => fakeNegotiation({ status })),
        },
      });
      await expect(
        mesh.respondNegotiate("neg_1", negotiateResponse(), "sess_b"),
      ).rejects.toThrow(`negotiation neg_1 is not active (status='${status}')`);
      expect(negotiationRoundRepo.create).not.toHaveBeenCalled();
    },
  );
});

describe("MeshServer.respondNegotiate — counterparty session stamping", () => {
  it("stamps B's session id on B's first response", async () => {
    const { mesh, negotiationRepo } = makeMesh();
    await mesh.respondNegotiate(
      "neg_1",
      negotiateResponse({ from_agent_id: "agent_b", decision: "accept" }),
      "sess_b",
    );
    expect(negotiationRepo.update).toHaveBeenCalledWith("neg_1", {
      counterparty_session_id: "sess_b",
    });
  });

  it("does not re-stamp once the column is already set", async () => {
    const { mesh, negotiationRepo } = makeMesh({
      negotiationRepo: {
        findById: vi.fn(async () =>
          fakeNegotiation({ counterparty_session_id: "sess_b" }),
        ),
      },
    });
    await mesh.respondNegotiate(
      "neg_1",
      negotiateResponse({ from_agent_id: "agent_b", decision: "accept" }),
      "sess_b_other",
    );
    expect(negotiationRepo.update).not.toHaveBeenCalledWith(
      "neg_1",
      expect.objectContaining({ counterparty_session_id: "sess_b_other" }),
    );
  });

  it("does not stamp when the initiator is the one responding", async () => {
    const { mesh, negotiationRepo } = makeMesh();
    await mesh.respondNegotiate(
      "neg_1",
      negotiateResponse({ from_agent_id: "agent_a", decision: "accept" }),
      "sess_a",
    );
    expect(negotiationRepo.update).not.toHaveBeenCalledWith(
      "neg_1",
      expect.objectContaining({ counterparty_session_id: "sess_a" }),
    );
  });
});

describe("MeshServer.respondNegotiate — exchange cap", () => {
  // `rounds_completed` counts rows, but `max_rounds` caps A↔B exchanges;
  // one exchange is two rows. So the cap bites on the row that would
  // START an exchange beyond the limit — an odd next-round number.
  it.each([
    // [rounds_completed, max_rounds, next row, exchange it belongs to]
    [1, 5, 2, 1],
    [2, 5, 3, 2],
    [8, 5, 9, 5],
    [9, 5, 10, 5],
  ])(
    "allows row %i+1 when max_rounds=%i (row %i → exchange %i)",
    async (rounds_completed, max_rounds) => {
      const { mesh, negotiationRoundRepo } = makeMesh({
        negotiationRepo: {
          findById: vi.fn(async () =>
            fakeNegotiation({ rounds_completed, max_rounds }),
          ),
        },
      });
      await mesh.respondNegotiate(
        "neg_1",
        negotiateResponse({ decision: "accept" }),
        "sess_b",
      );
      expect(negotiationRoundRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ round_number: rounds_completed + 1 }),
      );
    },
  );

  it("throws MAX_ROUNDS_EXCEEDED on the row that would open exchange 6", async () => {
    const { mesh, negotiationRoundRepo } = makeMesh({
      negotiationRepo: {
        findById: vi.fn(async () =>
          fakeNegotiation({ rounds_completed: 10, max_rounds: 5 }),
        ),
      },
    });
    const err = await mesh
      .respondNegotiate("neg_1", negotiateResponse(), "sess_b")
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MeshMaxRoundsError);
    expect((err as MeshMaxRoundsError).meta).toEqual({
      negotiationId: "neg_1",
      rounds_completed: 10,
      max_rounds: 5,
    });
    expect(negotiationRoundRepo.create).not.toHaveBeenCalled();
  });

  it("never lets B's completing half of an exchange trip the cap", async () => {
    // rounds_completed=1 with max_rounds=1: B's reply completes exchange
    // 1, which is within the cap even though no further exchange is.
    const { mesh } = makeMesh({
      negotiationRepo: {
        findById: vi.fn(async () =>
          fakeNegotiation({ rounds_completed: 1, max_rounds: 1 }),
        ),
      },
    });
    await expect(
      mesh.respondNegotiate(
        "neg_1",
        negotiateResponse({ decision: "accept" }),
        "sess_b",
      ),
    ).resolves.toBeNull();
  });
});

describe("MeshServer.respondNegotiate — terminal decisions", () => {
  it.each([
    ["accept", "accepted"],
    ["reject", "rejected"],
  ] as const)("closes the negotiation as %s → %s", async (decision, status) => {
    const { mesh, negotiationRepo } = makeMesh();
    const result = await mesh.respondNegotiate(
      "neg_1",
      negotiateResponse({ decision }),
      "sess_b",
    );
    expect(result).toBeNull();
    expect(negotiationRepo.update).toHaveBeenCalledWith("neg_1", { status });
  });

  it("persists the round before closing out", async () => {
    const { mesh, negotiationRoundRepo } = makeMesh();
    await mesh.respondNegotiate(
      "neg_1",
      negotiateResponse({ decision: "accept", message: "agreed" }),
      "sess_b",
    );
    expect(negotiationRoundRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        round_number: 2,
        decision: "accept",
        message: "agreed",
      }),
    );
  });
});

describe("MeshServer.respondNegotiate — counter blocks the responder", () => {
  it("blocks B on the initiator key after B counters round 1", async () => {
    const { mesh } = makeMesh();
    // A is waiting on `neg_1:initiator` from sendNegotiate.
    const initiatorWait = mesh.sendNegotiate("agent_a", "agent_b", "p", {
      initiatorSessionId: "sess_a",
    });
    await tick();

    // B counters: A is resolved, and B now blocks in B's place.
    const bWait = mesh.respondNegotiate(
      "neg_1",
      negotiateResponse({ from_agent_id: "agent_b", decision: "counter" }),
      "sess_b",
    );
    await expect(initiatorWait).resolves.toMatchObject({ decision: "counter" });

    // A replies; that resolves B's wait.
    await mesh.respondNegotiate(
      "neg_1",
      negotiateResponse({
        from_agent_id: "agent_a",
        decision: "accept",
        message: "fine",
      }),
      "sess_a",
    );
    await expect(bWait).resolves.toMatchObject({
      from_agent_id: "agent_a",
      decision: "accept",
    });
  });

  it("alternates sides across a full counter round-trip", async () => {
    const { mesh, negotiationRepo } = makeMesh();
    let rounds = 1;
    vi.mocked(negotiationRepo.findById).mockImplementation(async () =>
      fakeNegotiation({ rounds_completed: rounds }),
    );
    vi.mocked(negotiationRepo.update).mockImplementation(
      async (_id: string, patch: Partial<Negotiation>) => {
        if (typeof patch.rounds_completed === "number") {
          rounds = patch.rounds_completed;
        }
        return fakeNegotiation({ rounds_completed: rounds });
      },
    );

    const aWait = mesh.sendNegotiate("agent_a", "agent_b", "p1", {
      initiatorSessionId: "sess_a",
    });
    await tick();

    const bWait = mesh.respondNegotiate(
      "neg_1",
      negotiateResponse({ from_agent_id: "agent_b", decision: "counter" }),
      "sess_b",
    );
    await aWait;

    const aWait2 = mesh.respondNegotiate(
      "neg_1",
      negotiateResponse({ from_agent_id: "agent_a", decision: "counter" }),
      "sess_a",
    );
    await bWait;

    await mesh.respondNegotiate(
      "neg_1",
      negotiateResponse({ from_agent_id: "agent_b", decision: "reject" }),
      "sess_b",
    );
    await expect(aWait2).resolves.toMatchObject({ decision: "reject" });

    // Rows 1-4: propose, counter, counter, reject.
    expect(rounds).toBe(4);
  });
});

// ── unblockOnEscalate ────────────────────────────────────────────────────

describe("MeshServer.unblockOnEscalate", () => {
  it("releases the blocked initiator with the escalated sentinel", async () => {
    const { mesh } = makeMesh();
    const aWait = mesh.sendNegotiate("agent_a", "agent_b", "p", {
      initiatorSessionId: "sess_a",
    });
    await tick();

    mesh.unblockOnEscalate("neg_1", "esc_7");
    const res = await aWait;
    expect(res).toMatchObject({
      decision: "escalated",
      escalation_id: "esc_7",
      negotiation_id: "neg_1",
    });
    // The sentinel has to name the next tool, or the agent just exits.
    expect(res.message).toContain('add_to_escalation(escalation_id="esc_7"');
  });

  it("releases a blocked responder too", async () => {
    const { mesh } = makeMesh();
    const aWait = mesh.sendNegotiate("agent_a", "agent_b", "p", {
      initiatorSessionId: "sess_a",
    });
    await tick();
    const bWait = mesh.respondNegotiate(
      "neg_1",
      negotiateResponse({ from_agent_id: "agent_b", decision: "counter" }),
      "sess_b",
    );
    await aWait;

    mesh.unblockOnEscalate("neg_1", "esc_7");
    await expect(bWait).resolves.toMatchObject({
      decision: "escalated",
      escalation_id: "esc_7",
    });
  });

  it("is a no-op when both sides have already exited", () => {
    const { mesh } = makeMesh();
    expect(() => mesh.unblockOnEscalate("neg_nobody", "esc_1")).not.toThrow();
  });

  it("is idempotent — a second call after the release does nothing", async () => {
    const { mesh } = makeMesh();
    const aWait = mesh.sendNegotiate("agent_a", "agent_b", "p", {
      initiatorSessionId: "sess_a",
    });
    await tick();
    mesh.unblockOnEscalate("neg_1", "esc_7");
    await aWait;
    expect(() => mesh.unblockOnEscalate("neg_1", "esc_7")).not.toThrow();
  });
});

// ── reportBlocker ────────────────────────────────────────────────────────

describe("MeshServer.reportBlocker", () => {
  it("spawns the parent with the blocker context and does not block", async () => {
    const { mesh, dispatchCalls } = makeMesh();
    // Returns void — fire-and-forget by contract.
    expect(
      mesh.reportBlocker("agent_parent", "agent_child", "task_1", "no API key"),
    ).toBeUndefined();
    await tick();

    const call = dispatchCalls[0];
    expect(call).toMatchObject({
      agentId: "agent_parent",
      type: "blocker",
      callerAgentId: "agent_child",
    });
    expect(call?.intent).toContain('<mesh-blocker from="agent_child"');
    expect(call?.intent).toContain("no API key");
    // The parent's way out is revise_task — name it explicitly.
    expect(call?.intent).toContain('revise_task(task_id="task_1"');
  });

  it("registers no resolver — nobody is waiting on the parent", async () => {
    const { mesh, dispatchCalls } = makeMesh();
    mesh.reportBlocker("agent_parent", "agent_child", "task_1", "d");
    await tick();
    const sid = dispatchCalls[0]?.sessionIdOverride;
    expect(sid).toBeUndefined();
    expect(mesh.hasPendingCalleeSession("whatever")).toBe(false);
  });

  it("skips the capacity gate — a blocker must always reach the parent", async () => {
    const { mesh, dispatchCalls } = makeMesh({
      sessionRepo: { countRunningByAgent: vi.fn(async () => 99) },
    });
    mesh.reportBlocker("agent_parent", "agent_child", "task_1", "d");
    await tick();
    expect(dispatchCalls).toHaveLength(1);
  });
});

// ── Failure propagation ──────────────────────────────────────────────────

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

  it("rejects a blocked negotiation waiter via B's resident session", async () => {
    const { mesh, dispatchCalls } = makeMesh();
    const aWait = mesh.sendNegotiate("agent_a", "agent_b", "p", {
      initiatorSessionId: "sess_a",
    });
    await tick();
    const calleeSid = dispatchCalls[0]?.sessionIdOverride;
    expect(calleeSid).toBeDefined();

    mesh.failResolverForCalleeSession(calleeSid!, "crashed");
    await expect(aWait).rejects.toThrow(/mesh callee session failed: crashed/);
  });
});
