/**
 * MeshServer — ask, negotiate and blocker, with in-memory fakes.
 *
 * `server.test.ts` pins the callee-failure propagation path. This suite
 * covers the rest of the broker: the capacity gate, the intents handed
 * to `dispatchService`, the resolver bookkeeping behind
 * `ask`/`respond_ask`, the B-resident negotiation ladder (row creation,
 * the exchange cap, side flipping, terminal decisions) and the
 * escalation sentinel.
 *
 * Nothing here spawns a CLI — `dispatchService` is a spy and every repo
 * is a plain object, so dispatch intents are inspected rather than run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const A = "agent_initiator";
const B = "agent_counterpart";

interface DispatchCall {
  agentId: string;
  intent: string;
  type: string;
  sessionIdOverride?: string;
  callerAgentId?: string;
}

interface Harness {
  mesh: MeshServer;
  dispatchCalls: DispatchCall[];
  dispatchTask: ReturnType<typeof vi.fn>;
  negotiationRepo: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
  };
  roundRepo: { create: ReturnType<typeof vi.fn> };
  countRunning: ReturnType<typeof vi.fn>;
  /** Mutable negotiation row the `findById` fake hands back. */
  negRow: Negotiation;
}

function agent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name: id,
    owner_id: "per_1",
    hierarchy_level: "team",
    max_mesh_sessions: 5,
    max_negotiation_rounds: 5,
    runtime_config: { type: "claude" },
    ...overrides,
  } as unknown as Agent;
}

function makeMesh(opts: { agents?: Record<string, Agent | undefined> } = {}): Harness {
  const dispatchCalls: DispatchCall[] = [];
  const dispatchTask = vi.fn(async (o: DispatchCall) => {
    dispatchCalls.push(o);
    return {} as Awaited<ReturnType<DispatchService["dispatchTask"]>>;
  });

  const negRow: Negotiation = {
    id: "neg_1",
    initiator_agent_id: A,
    initiator_session_id: "sess_initiator01",
    counterparty_agent_id: B,
    counterparty_session_id: null,
    status: "active",
    rounds_completed: 1,
    max_rounds: 5,
  } as unknown as Negotiation;

  const negotiationRepo = {
    create: vi.fn(async () => negRow),
    update: vi.fn(async (_id: string, patch: Partial<Negotiation>) => {
      Object.assign(negRow, patch);
      return negRow;
    }),
    findById: vi.fn(async () => negRow),
  };
  const roundRepo = { create: vi.fn(async () => ({})) };
  const countRunning = vi.fn(async () => 0);

  const mesh = new MeshServer({
    agentRepo: {
      findById: vi.fn(async (id: string) =>
        opts.agents ? opts.agents[id] : agent(id),
      ),
    } as unknown as AgentRepository,
    sessionRepo: { countRunningByAgent: countRunning } as unknown as SessionRepository,
    sessionEventRepo: {} as SessionEventRepository,
    negotiationRepo: negotiationRepo as unknown as NegotiationRepository,
    negotiationRoundRepo: roundRepo as unknown as NegotiationRoundRepository,
    workspaceManager: {} as WorkspaceManager,
    runtimeRegistry: {} as RuntimeRegistry,
    dispatchService: { dispatchTask } as unknown as DispatchService,
    makeMemoryAgent: () => ({}) as never,
  });

  return { mesh, dispatchCalls, dispatchTask, negotiationRepo, roundRepo, countRunning, negRow };
}

function counter(overrides: Partial<NegotiateResponse> = {}): NegotiateResponse {
  return {
    negotiation_id: "neg_1",
    from_agent_id: B,
    decision: "counter",
    message: "how about this instead",
    ...overrides,
  };
}

/** Let the microtask queue drain so fire-and-forget dispatches land. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── capacity gate ────────────────────────────────────────────────────────

describe("mesh capacity", () => {
  it("throws MeshCapacityError with the counts once the target is at cap", async () => {
    const h = makeMesh();
    h.countRunning.mockResolvedValue(5);

    await expect(h.mesh.sendAsk("req_1", A, B, "q?")).rejects.toThrow(MeshCapacityError);
    await expect(h.mesh.sendAsk("req_1", A, B, "q?")).rejects.toMatchObject({
      code: "MESH_CAPACITY_EXCEEDED",
      meta: { agentId: B, running: 5, cap: 5 },
    });
    expect(h.dispatchTask).not.toHaveBeenCalled();
  });

  it("counts only the three mesh session types", async () => {
    const h = makeMesh();

    void h.mesh.sendAsk("req_1", A, B, "q?").catch(() => undefined);
    await settle();

    expect(h.countRunning).toHaveBeenCalledWith(B, ["mesh_ask", "mesh_negotiate", "blocker"]);
  });

  it("defaults the cap to 3 when the agent sets none", async () => {
    const h = makeMesh({ agents: { [B]: agent(B, { max_mesh_sessions: undefined }) } });
    h.countRunning.mockResolvedValue(3);

    await expect(h.mesh.sendAsk("req_1", A, B, "q?")).rejects.toMatchObject({
      meta: { running: 3, cap: 3 },
    });
  });

  it("throws a plain error when the target agent does not exist", async () => {
    const h = makeMesh({ agents: {} });

    await expect(h.mesh.sendAsk("req_1", A, B, "q?")).rejects.toThrow(
      `target agent not found: ${B}`,
    );
  });
});

// ── ask / respond_ask ────────────────────────────────────────────────────

describe("sendAsk / respondAsk", () => {
  it("dispatches a mesh_ask carrying the question and the respond_ask contract", async () => {
    const h = makeMesh();

    const pending = h.mesh.sendAsk("req_1", A, B, "where does auth live?");
    await settle();

    expect(h.dispatchCalls).toHaveLength(1);
    const [call] = h.dispatchCalls;
    expect(call).toMatchObject({ agentId: B, type: "mesh_ask", callerAgentId: A });
    expect(call!.intent).toContain('<mesh-ask request_id="req_1" from="agent_initiator">');
    expect(call!.intent).toContain("where does auth live?");
    expect(call!.intent).toContain('respond_ask(request_id="req_1"');
    // The callee sid is pre-minted so the resolver can be indexed by it.
    expect(call!.sessionIdOverride).toMatch(/^sess_/);
    expect(h.mesh.hasPendingCalleeSession(call!.sessionIdOverride!)).toBe(true);

    h.mesh.respondAsk("req_1", { request_id: "req_1", from_agent_id: B, answer: "in core" });
    await expect(pending).resolves.toEqual({
      request_id: "req_1",
      from_agent_id: B,
      answer: "in core",
    });
    expect(h.mesh.hasPendingCalleeSession(call!.sessionIdOverride!)).toBe(false);
  });

  it("escapes xml-significant characters in the wrapper's attributes", async () => {
    const h = makeMesh();

    void h.mesh.sendAsk('req"1', "agent<a>", B, "q?").catch(() => undefined);
    await settle();

    const { intent } = h.dispatchCalls[0]!;
    expect(intent.split("\n")[0]).toBe(
      '<mesh-ask request_id="req&quot;1" from="agent&lt;a&gt;">',
    );
    // The `<context>` block below the wrapper is prose, not markup, so
    // the raw id is interpolated there verbatim on purpose.
    expect(intent).toContain('respond_ask(request_id="req"1"');
  });

  it("is a no-op when respond_ask arrives with nobody waiting", () => {
    const h = makeMesh();

    expect(() =>
      h.mesh.respondAsk("req_nobody", {
        request_id: "req_nobody",
        from_agent_id: B,
        answer: "hello?",
      }),
    ).not.toThrow();
  });

  it("logs and swallows a dispatch failure without rejecting the asker", async () => {
    const h = makeMesh();
    h.dispatchTask.mockRejectedValue(new Error("no daemon"));

    const pending = h.mesh.sendAsk("req_1", A, B, "q?");
    await settle();

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("[mesh] dispatch for"),
      "no daemon",
    );
    // The asker still waits on the resolver — a failed dispatch is
    // reported through failResolverForCalleeSession, not here.
    h.mesh.respondAsk("req_1", { request_id: "req_1", from_agent_id: B, answer: "late" });
    await expect(pending).resolves.toMatchObject({ answer: "late" });
  });
});

describe("resolver timeout", () => {
  it("rejects a waiting asker after the 5-minute ceiling", async () => {
    vi.useFakeTimers();
    try {
      const h = makeMesh();
      const pending = h.mesh.sendAsk("req_1", A, B, "q?");
      // Let the capacity check + dispatch await chain settle first.
      await vi.advanceTimersByTimeAsync(0);

      const settled = expect(pending).rejects.toThrow(
        "mesh resolver timeout (300000ms) for req_1:asker",
      );
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await settled;

      // The reverse index is drained too, so a late failure report is a no-op.
      const calleeSid = h.dispatchCalls[0]!.sessionIdOverride!;
      expect(h.mesh.hasPendingCalleeSession(calleeSid)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── negotiate — round 1 ──────────────────────────────────────────────────

describe("sendNegotiate", () => {
  it("rejects a negotiation aimed at an IC before touching anything else", async () => {
    const h = makeMesh({ agents: { [B]: agent(B, { hierarchy_level: "ic" }) } });

    await expect(
      h.mesh.sendNegotiate(A, B, "split the work", { initiatorSessionId: "sess_initiator01" }),
    ).rejects.toThrow(CannotNegotiateWithIcError);
    expect(h.negotiationRepo.create).not.toHaveBeenCalled();
    expect(h.countRunning).not.toHaveBeenCalled();
  });

  it("throws when the target or the initiator is missing", async () => {
    await expect(
      makeMesh({ agents: {} }).mesh.sendNegotiate(A, B, "p", {
        initiatorSessionId: "sess_initiator01",
      }),
    ).rejects.toThrow(`target agent not found: ${B}`);

    await expect(
      makeMesh({ agents: { [B]: agent(B) } }).mesh.sendNegotiate(A, B, "p", {
        initiatorSessionId: "sess_initiator01",
      }),
    ).rejects.toThrow(`initiator agent not found: ${A}`);
  });

  it("creates the negotiation and round 1, then dispatches B", async () => {
    const h = makeMesh();

    void h.mesh
      .sendNegotiate(A, B, "ship on friday", {
        taskId: "task_1",
        initiatorSessionId: "sess_initiator01",
      })
      .catch(() => undefined);
    await settle();

    expect(h.negotiationRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        initiator_agent_id: A,
        initiator_session_id: "sess_initiator01",
        counterparty_agent_id: B,
        task_id: "task_1",
        max_rounds: 5,
      }),
    );
    expect(h.roundRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        negotiation_id: "neg_1",
        round_number: 1,
        from_agent_id: A,
        decision: "propose",
        message: "ship on friday",
      }),
    );
    // rounds_completed is bumped in the same step so B's first reply
    // computes round 2 and doesn't collide on the UNIQUE constraint.
    expect(h.negotiationRepo.update).toHaveBeenCalledWith("neg_1", { rounds_completed: 1 });

    const [call] = h.dispatchCalls;
    expect(call).toMatchObject({ agentId: B, type: "mesh_negotiate", callerAgentId: A });
    expect(call!.intent).toContain('<mesh-negotiate negotiation_id="neg_1"');
    expect(call!.intent).toContain('round="1"');
    expect(call!.intent).toContain("ship on friday");
  });

  it("takes max_rounds from the initiator, defaulting to 5", async () => {
    const strict = makeMesh({
      agents: { [A]: agent(A, { max_negotiation_rounds: 2 }), [B]: agent(B) },
    });
    void strict.mesh
      .sendNegotiate(A, B, "p", { initiatorSessionId: "sess_initiator01" })
      .catch(() => undefined);
    await settle();
    expect(strict.negotiationRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ max_rounds: 2 }),
    );

    const lax = makeMesh({
      agents: { [A]: agent(A, { max_negotiation_rounds: undefined }), [B]: agent(B) },
    });
    void lax.mesh
      .sendNegotiate(A, B, "p", { initiatorSessionId: "sess_initiator01" })
      .catch(() => undefined);
    await settle();
    expect(lax.negotiationRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ max_rounds: 5 }),
    );
  });

  it("blocks the initiator until B's first respond_negotiate lands", async () => {
    const h = makeMesh();

    const pending = h.mesh.sendNegotiate(A, B, "p", {
      initiatorSessionId: "sess_initiator01",
    });
    await settle();

    const reply = counter({ decision: "accept", message: "works for me" });
    await h.mesh.respondNegotiate("neg_1", reply, "sess_counterpar1");

    await expect(pending).resolves.toEqual(reply);
  });
});

// ── negotiate — later rounds ─────────────────────────────────────────────

describe("respondNegotiate", () => {
  it("throws on an unknown negotiation", async () => {
    const h = makeMesh();
    h.negotiationRepo.findById.mockResolvedValue(undefined);

    await expect(h.mesh.respondNegotiate("neg_x", counter(), "sess_x")).rejects.toThrow(
      "negotiation neg_x not found",
    );
  });

  it.each(["accepted", "rejected", "escalated"] as const)(
    "throws when the negotiation is already %s",
    async (status) => {
      const h = makeMesh();
      Object.assign(h.negRow, { status });

      await expect(h.mesh.respondNegotiate("neg_1", counter(), "sess_x")).rejects.toThrow(
        `is not active (status='${status}')`,
      );
    },
  );

  it("stamps the counterparty session id on B's first response only", async () => {
    const h = makeMesh();

    await h.mesh.respondNegotiate("neg_1", counter({ decision: "accept" }), "sess_counterpar1");

    expect(h.negotiationRepo.update).toHaveBeenCalledWith("neg_1", {
      counterparty_session_id: "sess_counterpar1",
    });

    // Already stamped → no second write of that column.
    h.negotiationRepo.update.mockClear();
    Object.assign(h.negRow, { status: "active" });
    await h.mesh.respondNegotiate("neg_1", counter({ decision: "accept" }), "sess_counterpar1");
    expect(h.negotiationRepo.update).not.toHaveBeenCalledWith(
      "neg_1",
      expect.objectContaining({ counterparty_session_id: expect.anything() }),
    );
  });

  it("does not stamp a session id for a response from the initiator's side", async () => {
    const h = makeMesh();

    await h.mesh.respondNegotiate(
      "neg_1",
      counter({ from_agent_id: A, decision: "accept" }),
      "sess_initiator01",
    );

    expect(h.negotiationRepo.update).not.toHaveBeenCalledWith(
      "neg_1",
      expect.objectContaining({ counterparty_session_id: expect.anything() }),
    );
  });

  it("persists the next round and bumps rounds_completed", async () => {
    const h = makeMesh();
    Object.assign(h.negRow, { rounds_completed: 3 });

    await h.mesh.respondNegotiate("neg_1", counter({ decision: "reject" }), "sess_counterpar1");

    expect(h.roundRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        negotiation_id: "neg_1",
        round_number: 4,
        from_agent_id: B,
        decision: "reject",
        message: "how about this instead",
      }),
    );
    expect(h.negotiationRepo.update).toHaveBeenCalledWith("neg_1", { rounds_completed: 4 });
  });

  it.each([
    ["accept", "accepted"],
    ["reject", "rejected"],
  ] as const)("closes the negotiation as %s → %s and returns null", async (decision, status) => {
    const h = makeMesh();

    const out = await h.mesh.respondNegotiate(
      "neg_1",
      counter({ decision }),
      "sess_counterpar1",
    );

    expect(out).toBeNull();
    expect(h.negotiationRepo.update).toHaveBeenCalledWith("neg_1", { status });
  });

  it("blocks the responder on a counter, then resolves them from the other side", async () => {
    const h = makeMesh();

    // B counters round 1; nobody is registered yet, so B takes the
    // initiator key's opposite — the initiator key itself.
    const bWaiting = h.mesh.respondNegotiate("neg_1", counter(), "sess_counterpar1");
    await settle();

    // A replies, resolving B's wait.
    const aReply = counter({ from_agent_id: A, decision: "accept", message: "fine" });
    await h.mesh.respondNegotiate("neg_1", aReply, "sess_initiator01");

    await expect(bWaiting).resolves.toEqual(aReply);
  });

  it("flips to the responder key when the initiator is the one waiting", async () => {
    const h = makeMesh();

    // sendNegotiate parks the initiator on `neg_1:initiator`.
    const initiatorWait = h.mesh.sendNegotiate(A, B, "p", {
      initiatorSessionId: "sess_initiator01",
    });
    await settle();

    // B counters: the initiator is resolved, and B parks on the
    // responder key awaiting A's next move.
    const bCounter = counter();
    const bWaiting = h.mesh.respondNegotiate("neg_1", bCounter, "sess_counterpar1");
    await expect(initiatorWait).resolves.toEqual(bCounter);

    const aReply = counter({ from_agent_id: A, decision: "reject", message: "no" });
    await h.mesh.respondNegotiate("neg_1", aReply, "sess_initiator01");
    await expect(bWaiting).resolves.toEqual(aReply);
  });

  it("throws MeshMaxRoundsError once the next row would start an exchange past the cap", async () => {
    const h = makeMesh();
    // max_rounds counts A↔B exchanges; row 5 would start exchange 3.
    Object.assign(h.negRow, { rounds_completed: 4, max_rounds: 2 });

    await expect(
      h.mesh.respondNegotiate("neg_1", counter(), "sess_counterpar1"),
    ).rejects.toThrow(MeshMaxRoundsError);
    await expect(
      h.mesh.respondNegotiate("neg_1", counter(), "sess_counterpar1"),
    ).rejects.toMatchObject({
      code: "MAX_ROUNDS_EXCEEDED",
      meta: { negotiationId: "neg_1", rounds_completed: 4, max_rounds: 2 },
    });
    expect(h.roundRepo.create).not.toHaveBeenCalled();
  });

  it("lets B complete the capping exchange — only A can trip the cap", async () => {
    const h = makeMesh();
    // Row 4 completes exchange 2, which is exactly at the cap.
    Object.assign(h.negRow, { rounds_completed: 3, max_rounds: 2 });

    await expect(
      h.mesh.respondNegotiate("neg_1", counter({ decision: "accept" }), "sess_counterpar1"),
    ).resolves.toBeNull();
  });
});

// ── escalation sentinel ──────────────────────────────────────────────────

describe("unblockOnEscalate", () => {
  it("releases the waiting initiator with the escalated sentinel", async () => {
    const h = makeMesh();
    const pending = h.mesh.sendNegotiate(A, B, "p", {
      initiatorSessionId: "sess_initiator01",
    });
    await settle();

    h.mesh.unblockOnEscalate("neg_1", "esc_9");

    await expect(pending).resolves.toEqual({
      decision: "escalated",
      message: expect.stringContaining('add_to_escalation(escalation_id="esc_9"'),
      escalation_id: "esc_9",
      negotiation_id: "neg_1",
    });
  });

  it("releases the responder side too", async () => {
    const h = makeMesh();
    const initiatorWait = h.mesh.sendNegotiate(A, B, "p", {
      initiatorSessionId: "sess_initiator01",
    });
    await settle();
    const bWaiting = h.mesh.respondNegotiate("neg_1", counter(), "sess_counterpar1");
    await initiatorWait;

    h.mesh.unblockOnEscalate("neg_1", "esc_9");

    await expect(bWaiting).resolves.toMatchObject({ decision: "escalated" });
  });

  it("is an idempotent no-op when both sides have already exited", () => {
    const h = makeMesh();

    expect(() => h.mesh.unblockOnEscalate("neg_gone", "esc_9")).not.toThrow();
    expect(() => h.mesh.unblockOnEscalate("neg_gone", "esc_9")).not.toThrow();
  });
});

// ── blocker ──────────────────────────────────────────────────────────────

describe("reportBlocker", () => {
  it("dispatches the parent a blocker session and returns immediately", async () => {
    const h = makeMesh();

    const out = h.mesh.reportBlocker("agent_parent", A, "task_7", "the API 403s");
    await settle();

    expect(out).toBeUndefined();
    const [call] = h.dispatchCalls;
    expect(call).toMatchObject({
      agentId: "agent_parent",
      type: "blocker",
      callerAgentId: A,
      // Fire-and-forget: no pre-minted session id to index a resolver by.
      sessionIdOverride: undefined,
    });
    expect(call!.intent).toContain('<mesh-blocker from="agent_initiator" task_id="task_7">');
    expect(call!.intent).toContain("the API 403s");
    expect(call!.intent).toContain('revise_task(task_id="task_7"');
  });

  it("does not capacity-gate the parent", async () => {
    const h = makeMesh();
    h.countRunning.mockResolvedValue(99);

    h.mesh.reportBlocker("agent_parent", A, "task_7", "blocked");
    await settle();

    expect(h.dispatchCalls).toHaveLength(1);
  });

  it("swallows a dispatch failure", async () => {
    const h = makeMesh();
    h.dispatchTask.mockRejectedValue("pg down");

    h.mesh.reportBlocker("agent_parent", A, "task_7", "blocked");
    await settle();

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("[mesh] dispatch for agent_parent (blocker) failed:"),
      "pg down",
    );
  });
});
