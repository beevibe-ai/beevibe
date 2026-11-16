/**
 * Mesh tools — tier gating plus per-handler behavior, with vitest fakes.
 *
 * Two layers live here:
 *
 *   1. The static tier inventory — the exact tool *names* each tier gets.
 *      The absences matter as much as the presences, so these assert exact
 *      sets rather than supersets.
 *   2. Handler behavior. The handlers are thin closures over
 *      (ctx, services): they coerce input, guard required args, delegate
 *      to MeshServer / TaskService / EscalationService, and project the
 *      response onto the agent-facing wire shape. All of that is testable
 *      with fakes; what needs live Postgres plus spawned CLI subprocesses
 *      is the blocking spawn semantics inside MeshServer, which the m6/m7
 *      e2e scripts cover.
 */
import { describe, expect, it, vi } from "vitest";
import type { ResolvedCaller } from "@beevibe/core/auth";
import type { AgentRepository } from "@beevibe/core";
import type { TaskService } from "@beevibe/core/services/task-service";
import type { EscalationService } from "@beevibe/core/services/escalation-service";
import type { Pool } from "@beevibe/core/adapters/postgres";
import {
  buildIcMeshTools,
  buildTeamMeshTools,
  type MeshToolServices,
} from "./mesh.js";
import { MeshCapacityError } from "../mesh/types.js";
import type { MeshServer } from "../mesh/server.js";
import type { AgentTool } from "./types.js";

const fakeCaller: ResolvedCaller = {
  agentId: "agent_x",
  source: "agent",
  hierarchyLevel: "team",
};
const fakeCtx = { caller: fakeCaller, beevibeSid: "ses_x" };

// ── Fakes ────────────────────────────────────────────────────────────────

type AnyMock = ReturnType<typeof vi.fn>;

/**
 * Every collaborator the six handlers reach, as a plain mock. Each entry can
 * be overridden per test to drive a failure path; `vi.fn()` keeps the
 * argument assertions below honest without needing the real services.
 */
interface MeshOverrides {
  sendAsk?: AnyMock;
  respondAsk?: AnyMock;
  sendNegotiate?: AnyMock;
  respondNegotiate?: AnyMock;
  reportBlocker?: AnyMock;
  unblockOnEscalate?: AnyMock;
  findParent?: AnyMock;
  markBlocked?: AnyMock;
  createEscalation?: AnyMock;
  query?: AnyMock;
}

function buildServices(o: MeshOverrides = {}) {
  const sendAsk =
    o.sendAsk ??
    vi.fn(async () => ({
      request_id: "req_1",
      from_agent_id: "agent_b",
      answer: "yes, feasible",
    }));
  const respondAsk = o.respondAsk ?? vi.fn(() => undefined);
  const sendNegotiate =
    o.sendNegotiate ??
    vi.fn(async () => ({
      negotiation_id: "neg_1",
      from_agent_id: "agent_b",
      decision: "counter",
      message: "how about Q3",
      counter_proposal: "ship in Q3",
    }));
  const respondNegotiate = o.respondNegotiate ?? vi.fn(async () => null);
  const reportBlocker = o.reportBlocker ?? vi.fn(() => undefined);
  const unblockOnEscalate = o.unblockOnEscalate ?? vi.fn(() => undefined);
  const findParent = o.findParent ?? vi.fn(async () => ({ id: "agent_parent" }));
  const markBlocked = o.markBlocked ?? vi.fn(async () => undefined);
  const createEscalation =
    o.createEscalation ??
    vi.fn(async () => ({ id: "esc_1", status: "open", negotiation_id: "neg_1" }));
  const query = o.query ?? vi.fn(async () => ({ rows: [] }));

  const services = {
    mesh: {
      sendAsk,
      respondAsk,
      sendNegotiate,
      respondNegotiate,
      reportBlocker,
      unblockOnEscalate,
    } as unknown as MeshServer,
    agentRepo: { findParent } as unknown as AgentRepository,
    taskRepo: {} as never,
    taskService: { markBlocked } as unknown as TaskService,
    escalationService: { create: createEscalation } as unknown as EscalationService,
    pool: { query } as unknown as Pool,
  } as unknown as MeshToolServices;

  return {
    services,
    sendAsk,
    respondAsk,
    sendNegotiate,
    respondNegotiate,
    reportBlocker,
    unblockOnEscalate,
    findParent,
    markBlocked,
    createEscalation,
    query,
  };
}

/** Named lookup that fails loudly — `noUncheckedIndexedAccess` makes a bare
 *  Record index `AgentTool | undefined` at every call site. */
function teamTools(services: MeshToolServices): Record<MeshToolName, AgentTool> {
  const built = buildTeamMeshTools(fakeCtx, services);
  const pick = (name: MeshToolName): AgentTool => {
    const found = built.find((t) => t.name === name);
    if (!found) throw new Error(`tool not assembled: ${name}`);
    return found;
  };
  return {
    ask: pick("ask"),
    respond_ask: pick("respond_ask"),
    negotiate: pick("negotiate"),
    respond_negotiate: pick("respond_negotiate"),
    report_blocker: pick("report_blocker"),
    escalate_to_humans: pick("escalate_to_humans"),
  };
}

type MeshToolName =
  | "ask"
  | "respond_ask"
  | "negotiate"
  | "respond_negotiate"
  | "report_blocker"
  | "escalate_to_humans";

/** The `n`th call's argument list, typed. */
function argsOf(fn: AnyMock, n = 0): unknown[] {
  const args = fn.mock.calls[n];
  if (!args) throw new Error(`expected at least ${n + 1} call(s)`);
  return args;
}

/** The `n`th call's `i`th argument, typed. */
function argOf<T>(fn: AnyMock, n = 0, i = 0): T {
  return argsOf(fn, n)[i] as T;
}

// ── Tier inventory ───────────────────────────────────────────────────────

describe("buildIcMeshTools (M9.1)", () => {
  // Exact set, not a superset: ICs are responders, not initiators, so the
  // absences matter as much as the presences. No `respond_negotiate`
  // (M9.1 dropped it — ICs are workers, not deciders) and none of the
  // initiator-side surface (`ask`, `negotiate`, `escalate_to_humans`).
  it("gets exactly respond_ask + report_blocker", () => {
    const tools = buildIcMeshTools(fakeCtx, buildServices().services);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["report_blocker", "respond_ask"]);
  });
});

describe("buildTeamMeshTools", () => {
  it("gets the full mesh surface — initiator and responder sides both", () => {
    const tools = buildTeamMeshTools(fakeCtx, buildServices().services);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "ask",
      "escalate_to_humans",
      "negotiate",
      "report_blocker",
      "respond_ask",
      "respond_negotiate",
    ]);
  });

  it("declares required args on every tool", () => {
    for (const t of buildTeamMeshTools(fakeCtx, buildServices().services)) {
      const required = (t.schema as { required?: string[] }).required ?? [];
      expect(required.length, `${t.name} must declare required args`)
        .toBeGreaterThan(0);
    }
  });

  it("hands the IC and team sets the same report_blocker contract", () => {
    const svc = buildServices().services;
    const ic = buildIcMeshTools(fakeCtx, svc).find(
      (t) => t.name === "report_blocker",
    );
    const team = teamTools(svc).report_blocker;
    expect(ic).toBeDefined();
    expect(ic?.schema).toEqual(team.schema);
    expect(ic?.description).toEqual(team.description);
  });
});

// ── ask ──────────────────────────────────────────────────────────────────

describe("ask", () => {
  it("forwards a generated request id and projects the answer", async () => {
    const { services, sendAsk } = buildServices();
    const res = await teamTools(services).ask.handler({
      target_agent_id: "agent_b",
      question: "is X feasible?",
    });

    const [requestId, from, target, question] = argsOf(sendAsk, 0);
    // The request id is minted here (randomUUID), not supplied by the
    // agent — the asker must not be able to collide with a live request.
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect([from, target, question]).toEqual([
      "agent_x",
      "agent_b",
      "is X feasible?",
    ]);
    expect(res).toEqual({
      content: {
        request_id: "req_1",
        from_agent_id: "agent_b",
        answer: "yes, feasible",
      },
    });
  });

  it("mints a fresh request id per call", async () => {
    const { services, sendAsk } = buildServices();
    const ask = teamTools(services).ask;
    await ask.handler({ target_agent_id: "agent_b", question: "q1" });
    await ask.handler({ target_agent_id: "agent_b", question: "q2" });
    expect(argOf(sendAsk, 0)).not.toBe(argOf(sendAsk, 1));
  });

  it.each([
    ["no target", { question: "q" }],
    ["no question", { target_agent_id: "agent_b" }],
    ["empty target", { target_agent_id: "", question: "q" }],
    ["empty question", { target_agent_id: "agent_b", question: "" }],
  ])("rejects %s without spawning the target", async (_label, input) => {
    const { services, sendAsk } = buildServices();
    const res = await teamTools(services).ask.handler(input);
    expect(res).toEqual({
      content: { error: "target_agent_id and question required" },
      isError: true,
    });
    expect(sendAsk).not.toHaveBeenCalled();
  });

  it("surfaces a coded mesh error with its code and meta intact", async () => {
    // MESH_CAPACITY_EXCEEDED is actionable: the agent can back off and
    // retry, but only if the code and the cap survive the envelope.
    const { services } = buildServices({
      sendAsk: vi.fn(async () => {
        throw new MeshCapacityError("at cap", {
          agentId: "agent_b",
          running: 3,
          cap: 3,
        });
      }),
    });
    const res = await teamTools(services).ask.handler({
      target_agent_id: "agent_b",
      question: "q",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "MESH_CAPACITY_EXCEEDED",
      agentId: "agent_b",
      running: 3,
      cap: 3,
      message: "at cap",
    });
  });

  it("degrades a plain Error to the catch-all envelope", async () => {
    const { services } = buildServices({
      sendAsk: vi.fn(async () => {
        throw new Error("target offline");
      }),
    });
    const res = await teamTools(services).ask.handler({
      target_agent_id: "agent_b",
      question: "q",
    });
    expect(res).toEqual({ content: { error: "target offline" }, isError: true });
  });
});

// ── respond_ask ──────────────────────────────────────────────────────────

describe("respond_ask", () => {
  it("unblocks the asker with the responder stamped as from_agent_id", async () => {
    const { services, respondAsk } = buildServices();
    const res = await teamTools(services).respond_ask.handler({
      request_id: "req_1",
      answer: "yes",
    });
    expect(respondAsk).toHaveBeenCalledWith("req_1", {
      request_id: "req_1",
      from_agent_id: "agent_x",
      answer: "yes",
    });
    expect(res).toEqual({ content: { responded: true, request_id: "req_1" } });
  });

  it.each([
    ["no request_id", { answer: "a" }],
    ["no answer", { request_id: "req_1" }],
    ["empty answer", { request_id: "req_1", answer: "" }],
  ])("rejects %s", async (_label, input) => {
    const { services, respondAsk } = buildServices();
    const res = await teamTools(services).respond_ask.handler(input);
    expect(res).toEqual({
      content: { error: "request_id and answer required" },
      isError: true,
    });
    expect(respondAsk).not.toHaveBeenCalled();
  });

  it("envelopes a throw from the mesh server", async () => {
    const { services } = buildServices({
      respondAsk: vi.fn(() => {
        throw new Error("no such pending request");
      }),
    });
    const res = await teamTools(services).respond_ask.handler({
      request_id: "req_gone",
      answer: "a",
    });
    expect(res).toEqual({
      content: { error: "no such pending request" },
      isError: true,
    });
  });
});

// ── negotiate ────────────────────────────────────────────────────────────

describe("negotiate", () => {
  it("passes the initiator session id so the peer row can be stamped", async () => {
    const { services, sendNegotiate } = buildServices();
    const res = await teamTools(services).negotiate.handler({
      peer_id: "agent_b",
      proposal: "ship in Q2",
      task_id: "task_1",
    });
    expect(sendNegotiate).toHaveBeenCalledWith(
      "agent_x",
      "agent_b",
      "ship in Q2",
      { taskId: "task_1", initiatorSessionId: "ses_x" },
    );
    expect(res.content).toEqual({
      negotiation_id: "neg_1",
      from_agent_id: "agent_b",
      decision: "counter",
      message: "how about Q3",
      counter_proposal: "ship in Q3",
    });
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["a non-string", 7],
  ])("omits task_id when %s", async (_label, task_id) => {
    const { services, sendNegotiate } = buildServices();
    await teamTools(services).negotiate.handler({
      peer_id: "agent_b",
      proposal: "p",
      task_id,
    });
    expect(argOf<{ taskId?: string }>(sendNegotiate, 0, 3).taskId).toBeUndefined();
  });

  it.each([
    ["no peer_id", { proposal: "p" }],
    ["no proposal", { peer_id: "agent_b" }],
    ["empty peer_id", { peer_id: "", proposal: "p" }],
  ])("rejects %s without spawning the peer", async (_label, input) => {
    const { services, sendNegotiate } = buildServices();
    const res = await teamTools(services).negotiate.handler(input);
    expect(res).toEqual({
      content: { error: "peer_id and proposal required" },
      isError: true,
    });
    expect(sendNegotiate).not.toHaveBeenCalled();
  });

  it("projects the escalated sentinel onto its own shape", async () => {
    // An escalated negotiation comes back with no from_agent_id or
    // counter_proposal — the sentinel branch must not leak those keys.
    const { services } = buildServices({
      sendNegotiate: vi.fn(async () => ({
        decision: "escalated",
        escalation_id: "esc_1",
        negotiation_id: "neg_1",
        message: "handed to humans",
      })),
    });
    const res = await teamTools(services).negotiate.handler({
      peer_id: "agent_b",
      proposal: "p",
    });
    expect(res.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_1",
      negotiation_id: "neg_1",
      message: "handed to humans",
    });
  });
});

// ── respond_negotiate ────────────────────────────────────────────────────

describe("respond_negotiate", () => {
  it("reports terminal on a null result (accept / reject)", async () => {
    const { services, respondNegotiate } = buildServices();
    const res = await teamTools(services).respond_negotiate.handler({
      negotiation_id: "neg_1",
      decision: "accept",
      message: "deal",
    });
    // The server computes the round number itself; the agent never sends one.
    expect(respondNegotiate).toHaveBeenCalledWith(
      "neg_1",
      {
        negotiation_id: "neg_1",
        from_agent_id: "agent_x",
        decision: "accept",
        message: "deal",
        counter_proposal: undefined,
      },
      "ses_x",
    );
    expect(res).toEqual({
      content: { negotiation_id: "neg_1", decision: "accept", terminal: true },
    });
  });

  it("projects the peer's reply when the negotiation continues", async () => {
    const { services } = buildServices({
      respondNegotiate: vi.fn(async () => ({
        negotiation_id: "neg_1",
        from_agent_id: "agent_b",
        decision: "counter",
        message: "still no",
        counter_proposal: "Q4",
      })),
    });
    const res = await teamTools(services).respond_negotiate.handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "how about Q3",
      counter_proposal: "Q3",
    });
    expect(res.content).toMatchObject({
      decision: "counter",
      counter_proposal: "Q4",
    });
  });

  it("forwards counter_proposal on a counter", async () => {
    const { services, respondNegotiate } = buildServices();
    await teamTools(services).respond_negotiate.handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "Q3",
    });
    expect(
      argOf<{ counter_proposal?: string }>(respondNegotiate, 0, 1).counter_proposal,
    ).toBe("Q3");
  });

  it.each([
    ["no negotiation_id", { decision: "accept", message: "m" }],
    ["no message", { negotiation_id: "neg_1", decision: "accept" }],
    ["empty message", { negotiation_id: "neg_1", decision: "accept", message: "" }],
  ])("rejects %s", async (_label, input) => {
    const { services, respondNegotiate } = buildServices();
    const res = await teamTools(services).respond_negotiate.handler(input);
    expect(res).toEqual({
      content: { error: "negotiation_id and message required" },
      isError: true,
    });
    expect(respondNegotiate).not.toHaveBeenCalled();
  });

  it.each([["approve"], [""], [undefined]])(
    "rejects decision=%s with the allowed list",
    async (decision) => {
      const { services, respondNegotiate } = buildServices();
      const res = await teamTools(services).respond_negotiate.handler({
        negotiation_id: "neg_1",
        decision,
        message: "m",
      });
      expect(res).toEqual({
        content: { error: "decision must be one of: counter, accept, reject" },
        isError: true,
      });
      expect(respondNegotiate).not.toHaveBeenCalled();
    },
  );

  it("requires counter_proposal when the decision is counter", async () => {
    // A counter with nothing to counter with would spawn the peer for a
    // round that says nothing, so it is refused before the server call.
    const { services, respondNegotiate } = buildServices();
    const res = await teamTools(services).respond_negotiate.handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
    });
    expect(res).toEqual({
      content: { error: "counter_proposal required when decision='counter'" },
      isError: true,
    });
    expect(respondNegotiate).not.toHaveBeenCalled();
  });

  it("does not require counter_proposal on accept or reject", async () => {
    const { services, respondNegotiate } = buildServices();
    for (const decision of ["accept", "reject"]) {
      const res = await teamTools(services).respond_negotiate.handler({
        negotiation_id: "neg_1",
        decision,
        message: "m",
      });
      expect(res.isError).toBeUndefined();
    }
    expect(respondNegotiate).toHaveBeenCalledTimes(2);
  });

  it("envelopes max_rounds_exceeded from the server", async () => {
    const { services } = buildServices({
      respondNegotiate: vi.fn(async () => {
        throw new Error("max_rounds_exceeded");
      }),
    });
    const res = await teamTools(services).respond_negotiate.handler({
      negotiation_id: "neg_1",
      decision: "accept",
      message: "m",
    });
    expect(res).toEqual({
      content: { error: "max_rounds_exceeded" },
      isError: true,
    });
  });
});

// ── report_blocker ───────────────────────────────────────────────────────

describe("report_blocker", () => {
  it("marks the task blocked, then spawns the parent", async () => {
    const { services, findParent, markBlocked, reportBlocker } = buildServices();
    const res = await teamTools(services).report_blocker.handler({
      task_id: "task_1",
      description: "no credentials",
    });

    expect(findParent).toHaveBeenCalledWith("agent_x");
    expect(markBlocked).toHaveBeenCalledWith("task_1", "agent_x", "no credentials");
    expect(reportBlocker).toHaveBeenCalledWith(
      "agent_parent",
      "agent_x",
      "task_1",
      "no credentials",
    );
    expect(res).toEqual({
      content: {
        reported: true,
        parent_agent_id: "agent_parent",
        task_id: "task_1",
      },
    });
  });

  it("refuses a top-level agent with no parent, leaving the task alone", async () => {
    const { services, markBlocked, reportBlocker } = buildServices({
      findParent: vi.fn(async () => undefined),
    });
    const res = await teamTools(services).report_blocker.handler({
      task_id: "task_1",
      description: "stuck",
    });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("no_parent_to_block");
    expect(res.content.message).toContain("escalate_to_humans");
    // Blocking the task with nobody to investigate would strand it.
    expect(markBlocked).not.toHaveBeenCalled();
    expect(reportBlocker).not.toHaveBeenCalled();
  });

  it.each([
    ["no task_id", { description: "d" }],
    ["no description", { task_id: "task_1" }],
    ["empty description", { task_id: "task_1", description: "" }],
  ])("rejects %s before the parent lookup", async (_label, input) => {
    const { services, findParent } = buildServices();
    const res = await teamTools(services).report_blocker.handler(input);
    expect(res).toEqual({
      content: { error: "task_id and description required" },
      isError: true,
    });
    expect(findParent).not.toHaveBeenCalled();
  });

  it("does not spawn the parent when markBlocked fails", async () => {
    const { services, reportBlocker } = buildServices({
      markBlocked: vi.fn(async () => {
        throw new Error("task not found");
      }),
    });
    const res = await teamTools(services).report_blocker.handler({
      task_id: "task_missing",
      description: "d",
    });
    expect(res).toEqual({ content: { error: "task not found" }, isError: true });
    // Waking the parent to investigate a task that never got marked
    // blocked would send them after nothing.
    expect(reportBlocker).not.toHaveBeenCalled();
  });
});

// ── escalate_to_humans ───────────────────────────────────────────────────

describe("escalate_to_humans", () => {
  it("creates the escalation, unblocks the peer, then notifies", async () => {
    const { services, createEscalation, unblockOnEscalate, query } =
      buildServices();
    const res = await teamTools(services).escalate_to_humans.handler({
      negotiation_id: "neg_1",
      summary: "stuck on scope",
      proposals: [{ title: "A", description: "do A" }],
      open_questions: ["who owns this?"],
    });

    expect(createEscalation).toHaveBeenCalledWith({
      negotiationId: "neg_1",
      callerAgentId: "agent_x",
      summary: "stuck on scope",
      proposals: [{ title: "A", description: "do A" }],
      openQuestions: ["who owns this?"],
    });
    // The peer is parked in a blocking respond_negotiate — without the
    // sentinel they wait for a round that is never coming.
    expect(unblockOnEscalate).toHaveBeenCalledWith("neg_1", "esc_1");
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("pg_notify('escalation_created'"),
      ["esc_1"],
    );
    expect(res).toEqual({
      content: {
        escalation_id: "esc_1",
        status: "open",
        negotiation_id: "neg_1",
      },
    });
  });

  it.each([
    ["absent", undefined],
    ["a non-array", "A then B"],
  ])("omits proposals when %s", async (_label, proposals) => {
    const { services, createEscalation } = buildServices();
    await teamTools(services).escalate_to_humans.handler({
      negotiation_id: "neg_1",
      summary: "s",
      proposals,
    });
    expect(
      argOf<{ proposals?: unknown }>(createEscalation, 0).proposals,
    ).toBeUndefined();
  });

  it("filters non-string open_questions", async () => {
    const { services, createEscalation } = buildServices();
    await teamTools(services).escalate_to_humans.handler({
      negotiation_id: "neg_1",
      summary: "s",
      open_questions: ["real question", 42, null, "another"],
    });
    expect(
      argOf<{ openQuestions?: string[] }>(createEscalation, 0).openQuestions,
    ).toEqual(["real question", "another"]);
  });

  it.each([
    ["no negotiation_id", { summary: "s" }],
    ["no summary", { negotiation_id: "neg_1" }],
    ["empty summary", { negotiation_id: "neg_1", summary: "" }],
  ])("rejects %s", async (_label, input) => {
    const { services, createEscalation } = buildServices();
    const res = await teamTools(services).escalate_to_humans.handler(input);
    expect(res).toEqual({
      content: { error: "negotiation_id and summary required" },
      isError: true,
    });
    expect(createEscalation).not.toHaveBeenCalled();
  });

  it("does not unblock the peer when the escalation insert fails", async () => {
    const { services, unblockOnEscalate, query } = buildServices({
      createEscalation: vi.fn(async () => {
        throw new Error("negotiation already escalated");
      }),
    });
    const res = await teamTools(services).escalate_to_humans.handler({
      negotiation_id: "neg_1",
      summary: "s",
    });
    expect(res).toEqual({
      content: { error: "negotiation already escalated" },
      isError: true,
    });
    // Releasing the peer with an escalation id that does not exist would
    // send them to add_to_escalation against a missing row.
    expect(unblockOnEscalate).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("surfaces a pg_notify failure rather than reporting success", async () => {
    const { services } = buildServices({
      query: vi.fn(async () => {
        throw new Error("connection terminated");
      }),
    });
    const res = await teamTools(services).escalate_to_humans.handler({
      negotiation_id: "neg_1",
      summary: "s",
    });
    expect(res).toEqual({
      content: { error: "connection terminated" },
      isError: true,
    });
  });
});
