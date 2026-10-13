/**
 * Mesh tool tests — tier assembly plus per-handler behavior.
 *
 * Two layers live here:
 *
 *   1. The static tier inventory: the exact tool *names* each tier gets,
 *      so future skill-loader work can rely on the surface being stable.
 *   2. Each handler's own share of the work — argument coercion, the
 *      required-field guards, the response projection, and the coded
 *      error envelope. These are pure given a fake MeshServer, so they
 *      don't need the live Postgres + spawned CLI subprocesses that the
 *      m6/m7 e2e scripts use to exercise the real round-trip.
 */
import { describe, expect, it, vi, type Mock } from "vitest";
import type { ResolvedCaller } from "@beevibe/core/auth";
import type { AgentRepository, TaskRepository } from "@beevibe/core";
import type { EscalationService } from "@beevibe/core/services/escalation-service";
import type { TaskService } from "@beevibe/core/services/task-service";
import type { Pool } from "@beevibe/core/adapters/postgres";
import {
  buildIcMeshTools,
  buildTeamMeshTools,
  type MeshToolContext,
  type MeshToolServices,
} from "./mesh.js";
import type { MeshServer } from "../mesh/server.js";
import type { AgentTool } from "./types.js";
import {
  CannotNegotiateWithIcError,
  MeshCapacityError,
  MeshMaxRoundsError,
} from "../mesh/types.js";

const fakeCaller: ResolvedCaller = {
  agentId: "agent_x",
  source: "agent",
  hierarchyLevel: "team",
};
const fakeCtx: MeshToolContext = {
  caller: fakeCaller as MeshToolContext["caller"],
  beevibeSid: "ses_x",
};

// ── Tier inventory ───────────────────────────────────────────────────────

describe("buildIcMeshTools (M9.1)", () => {
  // Exact set, not a superset: ICs are responders, not initiators, so the
  // absences matter as much as the presences. No `respond_negotiate`
  // (M9.1 dropped it — ICs are workers, not deciders) and none of the
  // initiator-side surface (`ask`, `negotiate`, `escalate_to_humans`).
  it("gets exactly respond_ask + report_blocker", () => {
    const tools = buildIcMeshTools(fakeCtx, {} as unknown as MeshToolServices);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["report_blocker", "respond_ask"]);
  });
});

describe("buildTeamMeshTools", () => {
  it("gets the full mesh surface — initiator and responder sides both", () => {
    const tools = buildTeamMeshTools(fakeCtx, {} as unknown as MeshToolServices);
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

  it("every tool carries a description and an object schema", () => {
    for (const tool of buildTeamMeshTools(fakeCtx, {} as unknown as MeshToolServices)) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.schema.type).toBe("object");
      expect(tool.schema.properties).toBeTruthy();
    }
  });

  it("shares one respond_ask + report_blocker contract across both tiers", () => {
    const ic = buildIcMeshTools(fakeCtx, {} as unknown as MeshToolServices);
    const team = buildTeamMeshTools(fakeCtx, {} as unknown as MeshToolServices);
    for (const name of ["respond_ask", "report_blocker"]) {
      const a = ic.find((t) => t.name === name)!;
      const b = team.find((t) => t.name === name)!;
      expect(a.schema).toEqual(b.schema);
      expect(a.description).toBe(b.description);
    }
  });
});

// ── Handler harness ──────────────────────────────────────────────────────

/**
 * Every MeshServer method the tools touch, faked with one loose
 * signature so `mock.calls` stays indexable and a stubbed return can be
 * swapped in per test. `respondAsk`, `reportBlocker` and
 * `unblockOnEscalate` are fire-and-forget on the real server — the
 * handlers call them without awaiting — so their fakes stay synchronous
 * and a seeded failure throws synchronously too, which is the only way
 * the handler's try/catch can see it.
 */
type MeshFake = Mock<(...args: unknown[]) => unknown>;

const MESH_METHODS = [
  "sendAsk",
  "respondAsk",
  "sendNegotiate",
  "respondNegotiate",
  "reportBlocker",
  "unblockOnEscalate",
] as const;

type MeshMethod = (typeof MESH_METHODS)[number];

function harness(
  overrides: Partial<Record<MeshMethod, unknown>> & {
    parent?: { id: string } | null;
    escalation?: Record<string, unknown>;
    escalationThrows?: unknown;
    markBlockedThrows?: unknown;
  } = {},
) {
  const thrower = (v: unknown) => () => {
    throw v;
  };
  const mk = (key: MeshMethod, impl: (...a: unknown[]) => unknown): MeshFake =>
    vi.fn<(...args: unknown[]) => unknown>(
      overrides[key] === undefined ? impl : thrower(overrides[key]),
    );

  const mesh: Record<MeshMethod, MeshFake> = {
    sendAsk: mk("sendAsk", (requestId, _from, to, _q) => ({
      request_id: requestId,
      from_agent_id: to,
      answer: "yes, feasible",
    })),
    respondAsk: mk("respondAsk", () => undefined),
    sendNegotiate: mk("sendNegotiate", (_from, to) => ({
      negotiation_id: "neg_1",
      from_agent_id: to,
      decision: "counter",
      message: "how about this",
      counter_proposal: "do B instead",
    })),
    respondNegotiate: mk("respondNegotiate", (negId) => ({
      negotiation_id: negId,
      from_agent_id: "agent_peer",
      decision: "counter",
      message: "still not it",
      counter_proposal: "do C",
    })),
    reportBlocker: mk("reportBlocker", () => undefined),
    unblockOnEscalate: mk("unblockOnEscalate", () => undefined),
  };

  const parent = overrides.parent === undefined ? { id: "agent_parent" } : overrides.parent;
  const agentRepo = {
    findParent: vi.fn(async () => parent),
  } as unknown as AgentRepository;

  const taskService = {
    markBlocked: vi.fn(async () => {
      if (overrides.markBlockedThrows) throw overrides.markBlockedThrows;
    }),
  } as unknown as TaskService;

  const escalationInputs: Record<string, unknown>[] = [];
  const escalationService = {
    create: vi.fn(async (input: Record<string, unknown>) => {
      escalationInputs.push(input);
      if (overrides.escalationThrows) throw overrides.escalationThrows;
      return (
        overrides.escalation ?? {
          id: "esc_1",
          status: "open",
          negotiation_id: "neg_1",
        }
      );
    }),
  } as unknown as EscalationService;

  const pool = { query: vi.fn(async () => ({ rows: [] })) } as unknown as Pool;

  const services = {
    mesh: mesh as unknown as MeshServer,
    agentRepo,
    taskRepo: {} as unknown as TaskRepository,
    taskService,
    escalationService,
    pool,
  } satisfies MeshToolServices;

  const byName = new Map<string, AgentTool>(
    buildTeamMeshTools(fakeCtx, services).map((t) => [t.name, t]),
  );
  return {
    services,
    mesh,
    agentRepo,
    taskService,
    escalationService,
    escalationInputs,
    pool,
    tool: (name: string) => byName.get(name)!,
  };
}

// ── ask ──────────────────────────────────────────────────────────────────

describe("ask", () => {
  it("mints a request id, sends with the caller as originator, projects the answer", async () => {
    const h = harness();
    const res = await h.tool("ask").handler({
      target_agent_id: "agent_peer",
      question: "is X feasible?",
    });
    expect(h.mesh.sendAsk).toHaveBeenCalledTimes(1);
    const [requestId, from, to, question] = h.mesh.sendAsk.mock.calls[0]!;
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(from).toBe("agent_x");
    expect(to).toBe("agent_peer");
    expect(question).toBe("is X feasible?");
    expect(res.isError).toBeFalsy();
    expect(res.content).toEqual({
      request_id: requestId,
      from_agent_id: "agent_peer",
      answer: "yes, feasible",
    });
  });

  it("mints a distinct request id per call", async () => {
    const h = harness();
    const ask = h.tool("ask");
    await ask.handler({ target_agent_id: "a", question: "q" });
    await ask.handler({ target_agent_id: "a", question: "q" });
    expect(h.mesh.sendAsk.mock.calls[0]![0]).not.toBe(
      h.mesh.sendAsk.mock.calls[1]![0],
    );
  });

  it.each([
    ["no target", { question: "q" }],
    ["no question", { target_agent_id: "agent_peer" }],
    ["an empty target", { target_agent_id: "", question: "q" }],
    ["an empty question", { target_agent_id: "agent_peer", question: "" }],
  ])("refuses a call with %s", async (_label, input) => {
    const h = harness();
    const res = await h.tool("ask").handler(input);
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: "target_agent_id and question required" });
    expect(h.mesh.sendAsk).not.toHaveBeenCalled();
  });

  it("drops only the projected fields, not the whole response", async () => {
    // sendAsk may grow fields; the tool deliberately projects three.
    const h = harness({
      sendAsk: undefined,
    });
    h.mesh.sendAsk.mockImplementation(async () => ({
      request_id: "r1",
      from_agent_id: "agent_peer",
      answer: "ok",
      internal_trace: "should not reach the agent",
    }));
    const res = await h.tool("ask").handler({
      target_agent_id: "agent_peer",
      question: "q",
    });
    expect(Object.keys(res.content).sort()).toEqual([
      "answer",
      "from_agent_id",
      "request_id",
    ]);
  });
});

// ── respond_ask ──────────────────────────────────────────────────────────

describe("respond_ask", () => {
  it("echoes the request id back into the response envelope", async () => {
    const h = harness();
    const res = await h.tool("respond_ask").handler({
      request_id: "req_1",
      answer: "here is the answer",
    });
    expect(h.mesh.respondAsk).toHaveBeenCalledWith("req_1", {
      request_id: "req_1",
      from_agent_id: "agent_x",
      answer: "here is the answer",
    });
    expect(res.content).toEqual({ responded: true, request_id: "req_1" });
    expect(res.isError).toBeFalsy();
  });

  it.each([
    ["no request_id", { answer: "a" }],
    ["no answer", { request_id: "req_1" }],
    ["an empty answer", { request_id: "req_1", answer: "" }],
  ])("refuses a call with %s", async (_label, input) => {
    const h = harness();
    const res = await h.tool("respond_ask").handler(input);
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: "request_id and answer required" });
    expect(h.mesh.respondAsk).not.toHaveBeenCalled();
  });

  it("surfaces a throw from the waiter registry", async () => {
    const h = harness({ respondAsk: new Error("no waiter for req_1") });
    const res = await h.tool("respond_ask").handler({
      request_id: "req_1",
      answer: "a",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: "no waiter for req_1" });
  });
});

// ── negotiate ────────────────────────────────────────────────────────────

describe("negotiate", () => {
  it("sends with the caller's session as initiator and projects the counter", async () => {
    const h = harness();
    const res = await h.tool("negotiate").handler({
      peer_id: "agent_peer",
      proposal: "let's do A",
      task_id: "task_7",
    });
    expect(h.mesh.sendNegotiate).toHaveBeenCalledWith(
      "agent_x",
      "agent_peer",
      "let's do A",
      { taskId: "task_7", initiatorSessionId: "ses_x" },
    );
    expect(res.content).toEqual({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "counter",
      message: "how about this",
      counter_proposal: "do B instead",
    });
  });

  it.each([undefined, "", 42])("omits a task_id given as %p", async (taskId) => {
    const h = harness();
    await h.tool("negotiate").handler({
      peer_id: "agent_peer",
      proposal: "p",
      task_id: taskId,
    });
    expect(h.mesh.sendNegotiate.mock.calls[0]![3]).toEqual({
      taskId: undefined,
      initiatorSessionId: "ses_x",
    });
  });

  it.each([
    ["no peer", { proposal: "p" }],
    ["no proposal", { peer_id: "agent_peer" }],
    ["an empty proposal", { peer_id: "agent_peer", proposal: "" }],
  ])("refuses a call with %s", async (_label, input) => {
    const h = harness();
    const res = await h.tool("negotiate").handler(input);
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: "peer_id and proposal required" });
    expect(h.mesh.sendNegotiate).not.toHaveBeenCalled();
  });

  it("projects the escalated sentinel instead of a decision round", async () => {
    const h = harness();
    h.mesh.sendNegotiate.mockImplementation(async () => ({
      decision: "escalated",
      escalation_id: "esc_9",
      negotiation_id: "neg_1",
      message: "handed to humans",
    }));
    const res = await h.tool("negotiate").handler({
      peer_id: "agent_peer",
      proposal: "p",
    });
    expect(res.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_9",
      negotiation_id: "neg_1",
      message: "handed to humans",
    });
    // No from_agent_id / counter_proposal on the sentinel branch.
    expect(res.content).not.toHaveProperty("from_agent_id");
  });

  it("surfaces CANNOT_NEGOTIATE_WITH_IC with its meta", async () => {
    const h = harness({
      sendNegotiate: new CannotNegotiateWithIcError({ agentId: "agent_ic" }),
    });
    const res = await h.tool("negotiate").handler({
      peer_id: "agent_ic",
      proposal: "p",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({
      error: "CANNOT_NEGOTIATE_WITH_IC",
      agentId: "agent_ic",
    });
    expect(String(res.content.message)).toContain("agent_ic");
  });

  it("surfaces MESH_CAPACITY_EXCEEDED with the running/cap numbers", async () => {
    const h = harness({
      sendNegotiate: new MeshCapacityError("at cap", {
        agentId: "agent_peer",
        running: 3,
        cap: 3,
      }),
    });
    const res = await h.tool("negotiate").handler({
      peer_id: "agent_peer",
      proposal: "p",
    });
    expect(res.content).toEqual({
      error: "MESH_CAPACITY_EXCEEDED",
      agentId: "agent_peer",
      running: 3,
      cap: 3,
      message: "at cap",
    });
  });
});

// ── respond_negotiate ────────────────────────────────────────────────────

describe("respond_negotiate", () => {
  it("forwards a counter with the caller's session and projects the peer's reply", async () => {
    const h = harness();
    const res = await h.tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "not quite",
      counter_proposal: "try B",
    });
    expect(h.mesh.respondNegotiate).toHaveBeenCalledWith(
      "neg_1",
      {
        negotiation_id: "neg_1",
        from_agent_id: "agent_x",
        decision: "counter",
        message: "not quite",
        counter_proposal: "try B",
      },
      "ses_x",
    );
    expect(res.content).toMatchObject({ decision: "counter", counter_proposal: "do C" });
  });

  it.each(["accept", "reject"] as const)(
    "reports %s as terminal when the server returns null",
    async (decision) => {
      const h = harness();
      h.mesh.respondNegotiate.mockImplementation(async () => null);
      const res = await h.tool("respond_negotiate").handler({
        negotiation_id: "neg_1",
        decision,
        message: "done here",
      });
      expect(res.isError).toBeFalsy();
      expect(res.content).toEqual({
        negotiation_id: "neg_1",
        decision,
        terminal: true,
      });
    },
  );

  it.each(["accept", "reject"] as const)(
    "does not require a counter_proposal for %s",
    async (decision) => {
      const h = harness();
      h.mesh.respondNegotiate.mockImplementation(async () => null);
      const res = await h.tool("respond_negotiate").handler({
        negotiation_id: "neg_1",
        decision,
        message: "m",
      });
      expect(res.isError).toBeFalsy();
    },
  );

  it("requires a counter_proposal when the decision is counter", async () => {
    const h = harness();
    const res = await h.tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "not quite",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "counter_proposal required when decision='counter'",
    });
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it.each([
    ["no negotiation_id", { decision: "accept", message: "m" }],
    ["no message", { negotiation_id: "neg_1", decision: "accept" }],
    ["an empty message", { negotiation_id: "neg_1", decision: "accept", message: "" }],
  ])("refuses a call with %s", async (_label, input) => {
    const h = harness();
    const res = await h.tool("respond_negotiate").handler(input);
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: "negotiation_id and message required" });
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it.each(["escalated", "maybe", "", undefined, 1])(
    "refuses an out-of-enum decision (%p) and lists the valid ones",
    async (decision) => {
      const h = harness();
      const res = await h.tool("respond_negotiate").handler({
        negotiation_id: "neg_1",
        decision,
        message: "m",
      });
      expect(res.isError).toBe(true);
      expect(res.content.error).toBe(
        "decision must be one of: counter, accept, reject",
      );
      expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
    },
  );

  it("checks the required fields before the decision enum", async () => {
    const h = harness();
    const res = await h.tool("respond_negotiate").handler({ decision: "bogus" });
    expect(res.content.error).toBe("negotiation_id and message required");
  });

  it("drops a non-string counter_proposal rather than coercing it", async () => {
    const h = harness();
    const res = await h.tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: 42,
    });
    expect(res.isError).toBe(true);
    expect(res.content.error).toContain("counter_proposal required");
  });

  it("surfaces MAX_ROUNDS_EXCEEDED with the round counters", async () => {
    const h = harness({
      respondNegotiate: new MeshMaxRoundsError({
        negotiationId: "neg_1",
        rounds_completed: 5,
        max_rounds: 5,
      }),
    });
    const res = await h.tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "c",
    });
    expect(res.content).toMatchObject({
      error: "MAX_ROUNDS_EXCEEDED",
      negotiationId: "neg_1",
      rounds_completed: 5,
      max_rounds: 5,
    });
    // The message is what tells the agent to escalate instead of retrying.
    expect(String(res.content.message)).toContain("escalate_to_humans");
  });

  it("projects the escalated sentinel when the peer escalated mid-round", async () => {
    const h = harness();
    h.mesh.respondNegotiate.mockImplementation(async () => ({
      decision: "escalated",
      escalation_id: "esc_4",
      negotiation_id: "neg_1",
      message: "peer escalated",
    }));
    const res = await h.tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "c",
    });
    expect(res.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_4",
      negotiation_id: "neg_1",
      message: "peer escalated",
    });
  });
});

// ── report_blocker ───────────────────────────────────────────────────────

describe("report_blocker", () => {
  it("marks the task blocked, then spawns the parent", async () => {
    const h = harness();
    const res = await h.tool("report_blocker").handler({
      task_id: "task_7",
      description: "no credentials for the staging db",
    });
    expect(h.agentRepo.findParent).toHaveBeenCalledWith("agent_x");
    expect(h.taskService.markBlocked).toHaveBeenCalledWith(
      "task_7",
      "agent_x",
      "no credentials for the staging db",
    );
    expect(h.mesh.reportBlocker).toHaveBeenCalledWith(
      "agent_parent",
      "agent_x",
      "task_7",
      "no credentials for the staging db",
    );
    expect(res.content).toEqual({
      reported: true,
      parent_agent_id: "agent_parent",
      task_id: "task_7",
    });
  });

  it("refuses when the caller is top-level and points at the alternatives", async () => {
    const h = harness({ parent: null });
    const res = await h.tool("report_blocker").handler({
      task_id: "task_7",
      description: "stuck",
    });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("no_parent_to_block");
    expect(String(res.content.message)).toContain("escalate_to_humans");
    // Nothing happened — the task is not left blocked with no one watching.
    expect(h.taskService.markBlocked).not.toHaveBeenCalled();
    expect(h.mesh.reportBlocker).not.toHaveBeenCalled();
  });

  it.each([
    ["no task_id", { description: "d" }],
    ["no description", { task_id: "task_7" }],
    ["an empty description", { task_id: "task_7", description: "" }],
  ])("refuses a call with %s before looking up the parent", async (_label, input) => {
    const h = harness();
    const res = await h.tool("report_blocker").handler(input);
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: "task_id and description required" });
    expect(h.agentRepo.findParent).not.toHaveBeenCalled();
  });

  it("does not spawn the parent when markBlocked fails", async () => {
    const h = harness({ markBlockedThrows: new Error("task not found") });
    const res = await h.tool("report_blocker").handler({
      task_id: "task_missing",
      description: "stuck",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: "task not found" });
    expect(h.mesh.reportBlocker).not.toHaveBeenCalled();
  });
});

// ── escalate_to_humans ───────────────────────────────────────────────────

describe("escalate_to_humans", () => {
  it("creates the escalation, unblocks the peer, then notifies listeners", async () => {
    const h = harness();
    const res = await h.tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "We're stuck on X",
      proposals: [{ title: "A", description: "do A" }],
      open_questions: ["which budget?"],
    });
    expect(h.escalationService.create).toHaveBeenCalledWith({
      negotiationId: "neg_1",
      callerAgentId: "agent_x",
      summary: "We're stuck on X",
      proposals: [{ title: "A", description: "do A" }],
      openQuestions: ["which budget?"],
    });
    expect(h.mesh.unblockOnEscalate).toHaveBeenCalledWith("neg_1", "esc_1");
    expect(h.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("pg_notify('escalation_created'"),
      ["esc_1"],
    );
    expect(res.content).toEqual({
      escalation_id: "esc_1",
      status: "open",
      negotiation_id: "neg_1",
    });
  });

  it.each([
    ["no negotiation_id", { summary: "s" }],
    ["no summary", { negotiation_id: "neg_1" }],
    ["an empty summary", { negotiation_id: "neg_1", summary: "" }],
  ])("refuses a call with %s", async (_label, input) => {
    const h = harness();
    const res = await h.tool("escalate_to_humans").handler(input);
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: "negotiation_id and summary required" });
    expect(h.escalationService.create).not.toHaveBeenCalled();
  });

  it.each([undefined, "A, then B", 3, null])(
    "omits non-array proposals (%p)",
    async (proposals) => {
      const h = harness();
      await h.tool("escalate_to_humans").handler({
        negotiation_id: "neg_1",
        summary: "s",
        proposals,
      });
      expect(h.escalationInputs[0]?.proposals).toBeUndefined();
    },
  );

  it("filters non-string open_questions", async () => {
    const h = harness();
    await h.tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "s",
      open_questions: ["which budget?", 7, null, "by when?"],
    });
    expect(h.escalationInputs[0]?.openQuestions).toEqual([
      "which budget?",
      "by when?",
    ]);
  });

  it("omits open_questions entirely when not an array", async () => {
    const h = harness();
    await h.tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "s",
      open_questions: "which budget?",
    });
    expect(h.escalationInputs[0]?.openQuestions).toBeUndefined();
  });

  it("neither unblocks the peer nor notifies when the escalation insert fails", async () => {
    const h = harness({ escalationThrows: new Error("already escalated") });
    const res = await h.tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "s",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: "already escalated" });
    expect(h.mesh.unblockOnEscalate).not.toHaveBeenCalled();
    expect(h.pool.query).not.toHaveBeenCalled();
  });

  it("reports the escalation's own status rather than assuming open", async () => {
    const h = harness({
      escalation: { id: "esc_2", status: "resolved", negotiation_id: "neg_2" },
    });
    const res = await h.tool("escalate_to_humans").handler({
      negotiation_id: "neg_2",
      summary: "s",
    });
    expect(res.content).toEqual({
      escalation_id: "esc_2",
      status: "resolved",
      negotiation_id: "neg_2",
    });
  });
});

// ── shared error envelope ────────────────────────────────────────────────

describe("thrown-error envelope", () => {
  it("stringifies a non-Error throw rather than leaking undefined", async () => {
    const h = harness({ sendAsk: "socket hang up" });
    const res = await h.tool("ask").handler({
      target_agent_id: "agent_peer",
      question: "q",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: "socket hang up" });
  });

  it("puts a plain Error's message in `error`, matching the catch-all contract", async () => {
    const h = harness({ sendAsk: new Error("target offline") });
    const res = await h.tool("ask").handler({
      target_agent_id: "agent_peer",
      question: "q",
    });
    expect(res.content).toEqual({ error: "target offline" });
  });
});
