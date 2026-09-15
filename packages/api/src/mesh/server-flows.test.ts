/**
 * MeshServer flow tests — capacity gating, the negotiation state
 * machine, and the spawn intents.
 *
 * `server.test.ts` covers one narrow path (failResolverForCalleeSession
 * draining waiters when a callee session dies). This file covers the
 * rest of the public surface. Every collaborator is injected, so the
 * whole thing runs without Postgres or a spawned CLI.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
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
} from "./types.js";

type AgentOverrides = Partial<{
  hierarchy_level: "ic" | "team" | "org";
  max_mesh_sessions: number | null;
  max_negotiation_rounds: number | null;
}>;

type NegotiationRow = {
  id: string;
  status: string;
  rounds_completed: number;
  max_rounds: number;
  counterparty_agent_id: string;
  counterparty_session_id: string | null;
};

function makeMesh(
  opts: {
    agents?: Record<string, AgentOverrides | null>;
    running?: number;
    negotiation?: NegotiationRow | null;
  } = {},
) {
  const dispatchCalls: Array<{
    agentId: string;
    type: string;
    intent: string;
    sessionIdOverride?: string;
    callerAgentId?: string;
  }> = [];

  const dispatchTask = vi.fn(async (o: (typeof dispatchCalls)[number]) => {
    dispatchCalls.push(o);
    return {} as Awaited<ReturnType<DispatchService["dispatchTask"]>>;
  });

  const findById = vi.fn(async (id: string) => {
    const over = opts.agents ? opts.agents[id] : undefined;
    if (over === null) return undefined;
    return {
      id,
      name: id,
      owner_id: "per_1",
      hierarchy_level: "team",
      max_mesh_sessions: 5,
      max_negotiation_rounds: 5,
      runtime_config: { type: "claude" },
      ...(over ?? {}),
    };
  });

  const negotiationCreate = vi.fn(
    async (n: Record<string, unknown>): Promise<Record<string, unknown>> => ({
      ...n,
      status: "active",
      rounds_completed: 0,
      counterparty_session_id: null,
    }),
  );
  const negotiationUpdate = vi.fn(async () => undefined);
  const negotiationFindById = vi.fn(async () =>
    opts.negotiation === undefined ? null : opts.negotiation,
  );
  const roundCreate = vi.fn(async (r: Record<string, unknown>) => r);
  const countRunningByAgent = vi.fn(
    async (_agentId: string, _types: readonly string[]) => opts.running ?? 0,
  );

  const mesh = new MeshServer({
    agentRepo: { findById } as unknown as AgentRepository,
    sessionRepo: { countRunningByAgent } as unknown as SessionRepository,
    sessionEventRepo: {} as SessionEventRepository,
    negotiationRepo: {
      create: negotiationCreate,
      update: negotiationUpdate,
      findById: negotiationFindById,
    } as unknown as NegotiationRepository,
    negotiationRoundRepo: { create: roundCreate } as unknown as NegotiationRoundRepository,
    workspaceManager: {} as WorkspaceManager,
    runtimeRegistry: {} as RuntimeRegistry,
    dispatchService: { dispatchTask } as unknown as DispatchService,
    makeMemoryAgent: () => ({}) as never,
  });

  return {
    mesh,
    dispatchCalls,
    dispatchTask,
    findById,
    countRunningByAgent,
    negotiationCreate,
    negotiationUpdate,
    negotiationFindById,
    roundCreate,
  };
}

/** Let the pre-spawn awaits settle so dispatch has been called. */
const tick = () => new Promise((r) => setImmediate(r));

/** Keep an intentionally-unsettled promise from tripping the runner. */
function ignore(p: Promise<unknown>) {
  p.catch(() => {});
  return p;
}

const activeNegotiation = (over: Partial<NegotiationRow> = {}): NegotiationRow => ({
  id: "neg_1",
  status: "active",
  rounds_completed: 1,
  max_rounds: 5,
  counterparty_agent_id: "agent_b",
  counterparty_session_id: null,
  ...over,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mesh capacity", () => {
  it("rejects an ask when the target is at its cap, naming the numbers", async () => {
    const { mesh, dispatchCalls } = makeMesh({ running: 5 });

    const err = await mesh
      .sendAsk("req_1", "agent_a", "agent_b", "hi")
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MeshCapacityError);
    expect((err as MeshCapacityError).meta).toEqual({
      agentId: "agent_b",
      running: 5,
      cap: 5,
    });
    expect(dispatchCalls).toHaveLength(0);
  });

  it("allows an ask when the target is one under its cap", async () => {
    const { mesh, dispatchCalls } = makeMesh({ running: 4 });
    ignore(mesh.sendAsk("req_1", "agent_a", "agent_b", "hi"));
    await tick();

    expect(dispatchCalls).toHaveLength(1);
  });

  it("honors a per-agent cap override", async () => {
    const { mesh } = makeMesh({
      agents: { agent_b: { max_mesh_sessions: 2 } },
      running: 2,
    });

    const err = await mesh
      .sendAsk("req_1", "agent_a", "agent_b", "hi")
      .catch((e: unknown) => e);

    expect((err as MeshCapacityError).meta).toMatchObject({ cap: 2 });
  });

  it("falls back to the default cap when the agent has none set", async () => {
    const { mesh } = makeMesh({
      agents: { agent_b: { max_mesh_sessions: null } },
      running: 100,
    });

    const err = await mesh
      .sendAsk("req_1", "agent_a", "agent_b", "hi")
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MeshCapacityError);
    expect((err as MeshCapacityError).meta.cap).toBeGreaterThan(0);
  });

  it("counts only mesh session types against the cap", async () => {
    const { mesh, countRunningByAgent } = makeMesh();
    ignore(mesh.sendAsk("req_1", "agent_a", "agent_b", "hi"));
    await tick();

    const [agentId, types] = countRunningByAgent.mock.calls[0]!;
    expect(agentId).toBe("agent_b");
    expect(types).toEqual(expect.arrayContaining(["mesh_ask", "mesh_negotiate"]));
  });

  it("rejects when the target agent does not exist", async () => {
    const { mesh } = makeMesh({ agents: { agent_gone: null } });

    await expect(mesh.sendAsk("req_1", "agent_a", "agent_gone", "hi")).rejects.toThrow(
      /target agent not found: agent_gone/,
    );
  });
});

describe("sendAsk spawn", () => {
  it("dispatches a mesh_ask session for the target, attributed to the asker", async () => {
    const { mesh, dispatchCalls } = makeMesh();
    ignore(mesh.sendAsk("req_1", "agent_a", "agent_b", "is X feasible?"));
    await tick();

    expect(dispatchCalls[0]).toMatchObject({
      agentId: "agent_b",
      type: "mesh_ask",
      callerAgentId: "agent_a",
    });
    expect(dispatchCalls[0]?.sessionIdOverride).toMatch(/^sess_/);
  });

  it("builds an intent carrying the question and the respond_ask instruction", async () => {
    const { mesh, dispatchCalls } = makeMesh();
    ignore(mesh.sendAsk("req_1", "agent_a", "agent_b", "is X feasible?"));
    await tick();

    const intent = dispatchCalls[0]!.intent;
    expect(intent).toContain('<mesh-ask request_id="req_1" from="agent_a">');
    expect(intent).toContain("is X feasible?");
    expect(intent).toContain('respond_ask(request_id="req_1"');
  });

  it("escapes attribute-breaking characters in the ids", async () => {
    const { mesh, dispatchCalls } = makeMesh();
    ignore(mesh.sendAsk('r"1', "a&b", "agent_b", "q"));
    await tick();

    const intent = dispatchCalls[0]!.intent;
    expect(intent).toContain('request_id="r&quot;1"');
    expect(intent).toContain('from="a&amp;b"');
  });

  it("logs rather than rejecting when the spawn dispatch fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { mesh, dispatchTask } = makeMesh();
    dispatchTask.mockRejectedValue(new Error("no runtime"));

    // The ask stays pending on its resolver; the dispatch failure is
    // reported out-of-band so it can't reject the awaiting caller here.
    const ask = ignore(mesh.sendAsk("req_1", "agent_a", "agent_b", "q"));
    await tick();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[mesh] dispatch for agent_b (mesh_ask) failed:"),
      "no runtime",
    );
    mesh.failResolverForCalleeSession("noop", "x");
    await expect(Promise.race([ask, Promise.resolve("pending")])).resolves.toBe(
      "pending",
    );
  });
});

describe("sendNegotiate", () => {
  const OPTS = { initiatorSessionId: "sess_a" };

  it("refuses an IC target before touching capacity or the DB", async () => {
    const { mesh, countRunningByAgent, negotiationCreate } = makeMesh({
      agents: { agent_ic: { hierarchy_level: "ic" } },
    });

    const err = await mesh
      .sendNegotiate("agent_a", "agent_ic", "proposal", OPTS)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CannotNegotiateWithIcError);
    expect((err as CannotNegotiateWithIcError).meta).toMatchObject({
      agentId: "agent_ic",
    });
    expect(countRunningByAgent).not.toHaveBeenCalled();
    expect(negotiationCreate).not.toHaveBeenCalled();
  });

  it.each([["team"], ["org"]] as const)("allows a %s target", async (level) => {
    const { mesh, negotiationCreate } = makeMesh({
      agents: { agent_b: { hierarchy_level: level } },
    });
    ignore(mesh.sendNegotiate("agent_a", "agent_b", "proposal", OPTS));
    await tick();

    expect(negotiationCreate).toHaveBeenCalled();
  });

  it("rejects when the target does not exist", async () => {
    const { mesh } = makeMesh({ agents: { agent_gone: null } });

    await expect(
      mesh.sendNegotiate("agent_a", "agent_gone", "p", OPTS),
    ).rejects.toThrow(/target agent not found/);
  });

  it("rejects when the initiator does not exist", async () => {
    const { mesh, negotiationCreate } = makeMesh({ agents: { agent_gone: null } });

    await expect(
      mesh.sendNegotiate("agent_gone", "agent_b", "p", OPTS),
    ).rejects.toThrow(/initiator agent not found/);
    expect(negotiationCreate).not.toHaveBeenCalled();
  });

  it("creates the negotiation row stamped with the initiator's round cap", async () => {
    const { mesh, negotiationCreate } = makeMesh({
      agents: { agent_a: { max_negotiation_rounds: 3 } },
    });
    ignore(mesh.sendNegotiate("agent_a", "agent_b", "p", { ...OPTS, taskId: "task_7" }));
    await tick();

    expect(negotiationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        initiator_agent_id: "agent_a",
        initiator_session_id: "sess_a",
        counterparty_agent_id: "agent_b",
        task_id: "task_7",
        max_rounds: 3,
      }),
    );
  });

  it("falls back to the default round cap when the initiator has none", async () => {
    const { mesh, negotiationCreate } = makeMesh({
      agents: { agent_a: { max_negotiation_rounds: null } },
    });
    ignore(mesh.sendNegotiate("agent_a", "agent_b", "p", OPTS));
    await tick();

    const maxRounds = negotiationCreate.mock.calls[0]![0].max_rounds as number;
    expect(maxRounds).toBeGreaterThan(0);
  });

  it("inserts round 1 as the initiator's proposal", async () => {
    const { mesh, roundCreate } = makeMesh();
    ignore(mesh.sendNegotiate("agent_a", "agent_b", "ship on friday", OPTS));
    await tick();

    expect(roundCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        round_number: 1,
        from_agent_id: "agent_a",
        decision: "propose",
      }),
    );
  });

  it("dispatches a mesh_negotiate session carrying the round-1 proposal", async () => {
    const { mesh, dispatchCalls } = makeMesh();
    ignore(mesh.sendNegotiate("agent_a", "agent_b", "ship on friday", OPTS));
    await tick();

    expect(dispatchCalls[0]).toMatchObject({
      agentId: "agent_b",
      type: "mesh_negotiate",
      callerAgentId: "agent_a",
    });
    expect(dispatchCalls[0]!.intent).toContain("ship on friday");
    expect(dispatchCalls[0]!.intent).toContain('round="1"');
  });
});

describe("respondNegotiate", () => {
  const reply = (over: Record<string, unknown> = {}) => ({
    negotiation_id: "neg_1",
    from_agent_id: "agent_b",
    decision: "accept" as const,
    message: "agreed",
    ...over,
  });

  it("rejects an unknown negotiation", async () => {
    const { mesh } = makeMesh({ negotiation: null });

    await expect(mesh.respondNegotiate("neg_1", reply(), "sess_b")).rejects.toThrow(
      /negotiation neg_1 not found/,
    );
  });

  it.each([["accepted"], ["rejected"], ["escalated"]])(
    "rejects a negotiation already in status '%s'",
    async (status) => {
      const { mesh, roundCreate } = makeMesh({
        negotiation: activeNegotiation({ status }),
      });

      await expect(mesh.respondNegotiate("neg_1", reply(), "sess_b")).rejects.toThrow(
        new RegExp(`not active \\(status='${status}'\\)`),
      );
      expect(roundCreate).not.toHaveBeenCalled();
    },
  );

  it("stamps the counterparty session id on the counterparty's first reply", async () => {
    const { mesh, negotiationUpdate } = makeMesh({
      negotiation: activeNegotiation({ counterparty_session_id: null }),
    });

    await mesh.respondNegotiate("neg_1", reply(), "sess_b");

    expect(negotiationUpdate).toHaveBeenCalledWith("neg_1", {
      counterparty_session_id: "sess_b",
    });
  });

  it("does not re-stamp once the counterparty session id is set", async () => {
    const { mesh, negotiationUpdate } = makeMesh({
      negotiation: activeNegotiation({ counterparty_session_id: "sess_b" }),
    });

    await mesh.respondNegotiate("neg_1", reply(), "sess_other");

    expect(negotiationUpdate).not.toHaveBeenCalledWith(
      "neg_1",
      expect.objectContaining({ counterparty_session_id: expect.anything() }),
    );
  });

  it("does not stamp when the responder is the initiator, not the counterparty", async () => {
    const { mesh, negotiationUpdate } = makeMesh({
      negotiation: activeNegotiation({ counterparty_session_id: null }),
    });

    await mesh.respondNegotiate(
      "neg_1",
      reply({ from_agent_id: "agent_a" }),
      "sess_a",
    );

    expect(negotiationUpdate).not.toHaveBeenCalledWith(
      "neg_1",
      expect.objectContaining({ counterparty_session_id: expect.anything() }),
    );
  });

  it("persists the round at rounds_completed + 1 and advances the counter", async () => {
    const { mesh, roundCreate, negotiationUpdate } = makeMesh({
      negotiation: activeNegotiation({ rounds_completed: 3 }),
    });

    await mesh.respondNegotiate("neg_1", reply({ message: "ok" }), "sess_b");

    expect(roundCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        negotiation_id: "neg_1",
        round_number: 4,
        from_agent_id: "agent_b",
        decision: "accept",
        message: "ok",
      }),
    );
    expect(negotiationUpdate).toHaveBeenCalledWith("neg_1", { rounds_completed: 4 });
  });

  describe("max-rounds cap (two rows per user-facing exchange)", () => {
    // rows 1-2 = exchange 1, rows 3-4 = exchange 2, ... With max_rounds=2
    // the cap bites when a row would start exchange 3, i.e. row 5.
    it.each([
      ["row 2 completes exchange 1", 1],
      ["row 3 starts exchange 2", 2],
      ["row 4 completes exchange 2", 3],
    ])("allows a reply when %s", async (_label, rounds_completed) => {
      const { mesh } = makeMesh({
        negotiation: activeNegotiation({ rounds_completed, max_rounds: 2 }),
      });

      await expect(
        mesh.respondNegotiate("neg_1", reply(), "sess_b"),
      ).resolves.toBeNull();
    });

    it("refuses the reply that would start an exchange past the cap", async () => {
      const { mesh, roundCreate } = makeMesh({
        negotiation: activeNegotiation({ rounds_completed: 4, max_rounds: 2 }),
      });

      const err = await mesh
        .respondNegotiate("neg_1", reply(), "sess_b")
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(MeshMaxRoundsError);
      expect((err as MeshMaxRoundsError).meta).toMatchObject({
        negotiationId: "neg_1",
        rounds_completed: 4,
        max_rounds: 2,
      });
      expect(roundCreate).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["accept", "accepted"],
    ["reject", "rejected"],
  ])("closes the negotiation on %s and returns null", async (decision, status) => {
    const { mesh, negotiationUpdate } = makeMesh({
      negotiation: activeNegotiation(),
    });

    const result = await mesh.respondNegotiate(
      "neg_1",
      reply({ decision }),
      "sess_b",
    );

    expect(result).toBeNull();
    expect(negotiationUpdate).toHaveBeenCalledWith("neg_1", { status });
  });

  it("blocks the responder on a counter instead of returning", async () => {
    const { mesh, negotiationUpdate } = makeMesh({
      negotiation: activeNegotiation(),
    });

    const pending = ignore(
      mesh.respondNegotiate(
        "neg_1",
        reply({ decision: "counter", counter_proposal: "monday" }),
        "sess_b",
      ),
    );
    await tick();

    expect(await Promise.race([pending, Promise.resolve("pending")])).toBe("pending");
    // A counter is not terminal, so no status write.
    expect(negotiationUpdate).not.toHaveBeenCalledWith(
      "neg_1",
      expect.objectContaining({ status: expect.anything() }),
    );
  });

  it("hands the counter to the initiator's waiter and blocks the responder", async () => {
    const { mesh, negotiationCreate } = makeMesh({
      negotiation: activeNegotiation(),
    });
    negotiationCreate.mockResolvedValue({ id: "neg_1" });

    // Initiator is parked on `neg_1:initiator` after round 1.
    const initiatorWait = mesh.sendNegotiate("agent_a", "agent_b", "p", {
      initiatorSessionId: "sess_a",
    });
    await tick();

    const responderWait = ignore(
      mesh.respondNegotiate(
        "neg_1",
        reply({ decision: "counter", counter_proposal: "monday" }),
        "sess_b",
      ),
    );

    await expect(initiatorWait).resolves.toMatchObject({
      decision: "counter",
      counter_proposal: "monday",
    });
    expect(await Promise.race([responderWait, Promise.resolve("pending")])).toBe(
      "pending",
    );
  });
});

describe("unblockOnEscalate", () => {
  it("resolves the blocked side with the escalated sentinel", async () => {
    const { mesh, negotiationCreate } = makeMesh({
      negotiation: activeNegotiation(),
    });
    negotiationCreate.mockResolvedValue({ id: "neg_1" });

    const initiatorWait = mesh.sendNegotiate("agent_a", "agent_b", "p", {
      initiatorSessionId: "sess_a",
    });
    await tick();

    mesh.unblockOnEscalate("neg_1", "esc_9");

    const result = await initiatorWait;
    expect(result).toMatchObject({
      decision: "escalated",
      escalation_id: "esc_9",
      negotiation_id: "neg_1",
    });
    expect(result.message).toContain('add_to_escalation(escalation_id="esc_9"');
  });

  it("is a no-op when neither side is blocked", () => {
    const { mesh } = makeMesh();
    expect(() => mesh.unblockOnEscalate("neg_none", "esc_1")).not.toThrow();
  });

  it("is idempotent — a second call after both sides drained does nothing", async () => {
    const { mesh, negotiationCreate } = makeMesh({
      negotiation: activeNegotiation(),
    });
    negotiationCreate.mockResolvedValue({ id: "neg_1" });

    const wait = mesh.sendNegotiate("agent_a", "agent_b", "p", {
      initiatorSessionId: "sess_a",
    });
    await tick();

    mesh.unblockOnEscalate("neg_1", "esc_9");
    await wait;

    expect(() => mesh.unblockOnEscalate("neg_1", "esc_9")).not.toThrow();
  });
});

describe("reportBlocker", () => {
  it("dispatches a blocker session for the parent, attributed to the blocked agent", async () => {
    const { mesh, dispatchCalls } = makeMesh();
    mesh.reportBlocker("agent_boss", "agent_me", "task_7", "the key is missing");
    await tick();

    expect(dispatchCalls[0]).toMatchObject({
      agentId: "agent_boss",
      type: "blocker",
      callerAgentId: "agent_me",
    });
  });

  it("builds an intent naming the task and the revise_task remedy", async () => {
    const { mesh, dispatchCalls } = makeMesh();
    mesh.reportBlocker("agent_boss", "agent_me", "task_7", "the key is missing");
    await tick();

    const intent = dispatchCalls[0]!.intent;
    expect(intent).toContain('<mesh-blocker from="agent_me" task_id="task_7">');
    expect(intent).toContain("the key is missing");
    expect(intent).toContain('revise_task(task_id="task_7"');
  });

  it("returns synchronously without waiting on the spawn", () => {
    const { mesh } = makeMesh();
    expect(mesh.reportBlocker("agent_boss", "agent_me", "t", "d")).toBeUndefined();
  });

  it("does not bypass capacity — the parent spawn is fire-and-forget", async () => {
    const { mesh, countRunningByAgent } = makeMesh();
    mesh.reportBlocker("agent_boss", "agent_me", "t", "d");
    await tick();

    // A blocker report is an escalation path, not a mesh request: it is
    // deliberately not capacity-gated.
    expect(countRunningByAgent).not.toHaveBeenCalled();
  });
});
