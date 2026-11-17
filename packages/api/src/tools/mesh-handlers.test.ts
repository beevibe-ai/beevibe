/**
 * Mesh tool handlers — unit tests with a faked MeshServer.
 *
 * `mesh.test.ts` pins the per-tier tool inventory; this file covers what
 * each handler does with its input: the required-argument guards, the
 * projections the agent actually sees (which deliberately drop fields
 * the server carries internally), the terminal-vs-blocking branches of
 * respond_negotiate, report_blocker's no-parent refusal and its
 * mark-blocked-then-spawn ordering, and escalate_to_humans' create →
 * unblock-peer → pg_notify sequence.
 *
 * The handlers' throw path goes through `toolErrorFromThrown`
 * (`errors.test.ts` covers the envelope shapes), so here it's asserted
 * once per tool: a coded mesh error keeps its code and meta, and
 * anything else degrades to the catch-all.
 */
import { describe, expect, it, vi } from "vitest";
import type { Agent, AgentRepository, TaskRepository } from "@beevibe/core";
import type { Pool } from "@beevibe/core/adapters/postgres";
import type { EscalationService } from "@beevibe/core/services/escalation-service";
import type { TaskService } from "@beevibe/core/services/task-service";
import type { McpCaller } from "./assemble.js";
import type { MeshServer } from "../mesh/server.js";
import {
  CannotNegotiateWithIcError,
  MeshCapacityError,
  MeshMaxRoundsError,
} from "../mesh/types.js";
import { buildTeamMeshTools, type MeshToolServices } from "./mesh.js";
import type { AgentTool, AgentToolResult } from "./types.js";

// ── Harness ──────────────────────────────────────────────────────────────

const CALLER = "agent_caller";
const SID = "sess_caller0000";

const caller: McpCaller = {
  agentId: CALLER,
  source: "agent",
  hierarchyLevel: "team",
};

interface MeshFns {
  sendAsk: ReturnType<typeof vi.fn>;
  respondAsk: ReturnType<typeof vi.fn>;
  sendNegotiate: ReturnType<typeof vi.fn>;
  respondNegotiate: ReturnType<typeof vi.fn>;
  reportBlocker: ReturnType<typeof vi.fn>;
  unblockOnEscalate: ReturnType<typeof vi.fn>;
}

interface Harness {
  tool: (name: string) => AgentTool;
  mesh: MeshFns;
  findParent: ReturnType<typeof vi.fn>;
  markBlocked: ReturnType<typeof vi.fn>;
  createEscalation: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
}

function harness(
  overrides: Partial<{
    sendAsk: unknown;
    sendNegotiate: unknown;
    respondNegotiate: unknown;
    parent: Agent | null;
    markBlocked: unknown;
    createEscalation: unknown;
  }> = {},
): Harness {
  const asFn = (impl: unknown, fallback: (...a: never[]) => unknown) =>
    vi.fn(
      (impl as ((...a: never[]) => unknown) | undefined) ?? fallback,
    );

  const mesh: MeshFns = {
    sendAsk: asFn(overrides.sendAsk, async () => ({
      request_id: "req_1",
      from_agent_id: "agent_callee",
      answer: "yes",
    })),
    respondAsk: vi.fn(),
    sendNegotiate: asFn(overrides.sendNegotiate, async () => ({
      negotiation_id: "neg_1",
      from_agent_id: "agent_callee",
      decision: "counter",
      message: "how about Tuesday",
      counter_proposal: "Tuesday",
    })),
    respondNegotiate: asFn(overrides.respondNegotiate, async () => null),
    reportBlocker: vi.fn(),
    unblockOnEscalate: vi.fn(),
  };

  const findParent = vi
    .fn()
    .mockResolvedValue(
      overrides.parent === undefined
        ? ({ id: "agent_parent", name: "Parent" } as Agent)
        : overrides.parent,
    );
  const markBlocked = asFn(overrides.markBlocked, async () => undefined);
  const createEscalation = asFn(overrides.createEscalation, async () => ({
    id: "esc_1",
    status: "open",
    negotiation_id: "neg_1",
  }));
  const query = vi.fn(async () => ({ rows: [] }));

  const services = {
    mesh: mesh as unknown as MeshServer,
    agentRepo: { findParent } as unknown as AgentRepository,
    taskRepo: {} as TaskRepository,
    taskService: { markBlocked } as unknown as TaskService,
    escalationService: { create: createEscalation } as unknown as EscalationService,
    pool: { query } as unknown as Pool,
  } satisfies MeshToolServices;

  const tools = buildTeamMeshTools({ caller, beevibeSid: SID }, services);
  const tool = (name: string): AgentTool => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool named ${name}`);
    return t;
  };

  return { tool, mesh, findParent, markBlocked, createEscalation, query };
}

// ── ask ──────────────────────────────────────────────────────────────────

describe("ask", () => {
  it("mints a request id, forwards the caller as the asker and projects the answer", async () => {
    const h = harness();
    const res = await h.tool("ask").handler({
      target_agent_id: "agent_callee",
      question: "feasible?",
    });
    const [requestId, from, to, question] = h.mesh.sendAsk.mock.calls[0]!;
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect([from, to, question]).toEqual([CALLER, "agent_callee", "feasible?"]);
    expect(res.content).toEqual({
      request_id: "req_1",
      from_agent_id: "agent_callee",
      answer: "yes",
    });
  });

  it.each([
    ["no target", { question: "q" }],
    ["no question", { target_agent_id: "agent_callee" }],
    ["empty strings", { target_agent_id: "", question: "" }],
  ])("refuses a call with %s", async (_label, input) => {
    const h = harness();
    const res = await h.tool("ask").handler(input);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("target_agent_id and question required");
    expect(h.mesh.sendAsk).not.toHaveBeenCalled();
  });

  it("projects a capacity error with its code and counts", async () => {
    const h = harness({
      sendAsk: async () => {
        throw new MeshCapacityError("at capacity", {
          agentId: "agent_callee",
          running: 3,
          cap: 3,
        });
      },
    });
    const res = await h.tool("ask").handler({
      target_agent_id: "agent_callee",
      question: "q",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "MESH_CAPACITY_EXCEEDED",
      agentId: "agent_callee",
      running: 3,
      cap: 3,
      message: "at capacity",
    });
  });

  it("degrades an uncoded throw to the catch-all envelope", async () => {
    const h = harness({
      sendAsk: async () => {
        throw new Error("mesh resolver timeout (300000ms) for req_1:asker");
      },
    });
    const res = await h.tool("ask").handler({
      target_agent_id: "agent_callee",
      question: "q",
    });
    expect(res.isError).toBe(true);
    expect(res.content.error).toContain("mesh resolver timeout");
  });
});

// ── respond_ask ──────────────────────────────────────────────────────────

describe("respond_ask", () => {
  it("fires the asker's resolver with the caller stamped as responder", async () => {
    const h = harness();
    const res = await h.tool("respond_ask").handler({
      request_id: "req_7",
      answer: "yes, by Friday",
    });
    expect(h.mesh.respondAsk).toHaveBeenCalledWith("req_7", {
      request_id: "req_7",
      from_agent_id: CALLER,
      answer: "yes, by Friday",
    });
    expect(res.content).toEqual({ responded: true, request_id: "req_7" });
  });

  it.each([
    ["no request id", { answer: "a" }],
    ["no answer", { request_id: "req_7" }],
  ])("refuses a call with %s", async (_label, input) => {
    const h = harness();
    const res = await h.tool("respond_ask").handler(input);
    expect(res.isError).toBe(true);
    expect(h.mesh.respondAsk).not.toHaveBeenCalled();
  });
});

// ── negotiate ────────────────────────────────────────────────────────────

describe("negotiate", () => {
  it("forwards the caller's session as the initiator session and projects the counter", async () => {
    const h = harness();
    const res = await h.tool("negotiate").handler({
      peer_id: "agent_peer",
      proposal: "split 60/40",
      task_id: "task_3",
    });
    expect(h.mesh.sendNegotiate).toHaveBeenCalledWith(
      CALLER,
      "agent_peer",
      "split 60/40",
      { taskId: "task_3", initiatorSessionId: SID },
    );
    expect(res.content).toEqual({
      negotiation_id: "neg_1",
      from_agent_id: "agent_callee",
      decision: "counter",
      message: "how about Tuesday",
      counter_proposal: "Tuesday",
    });
  });

  it("treats a blank or non-string task_id as absent", async () => {
    const h = harness();
    await h.tool("negotiate").handler({
      peer_id: "agent_peer",
      proposal: "p",
      task_id: "",
    });
    expect(h.mesh.sendNegotiate.mock.calls[0]?.[3].taskId).toBeUndefined();

    const h2 = harness();
    await h2.tool("negotiate").handler({
      peer_id: "agent_peer",
      proposal: "p",
      task_id: 7,
    });
    expect(h2.mesh.sendNegotiate.mock.calls[0]?.[3].taskId).toBeUndefined();
  });

  it.each([
    ["no peer", { proposal: "p" }],
    ["no proposal", { peer_id: "agent_peer" }],
  ])("refuses a call with %s", async (_label, input) => {
    const h = harness();
    const res = await h.tool("negotiate").handler(input);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("peer_id and proposal required");
    expect(h.mesh.sendNegotiate).not.toHaveBeenCalled();
  });

  it("projects the escalated sentinel without the peer-response fields", async () => {
    const h = harness({
      sendNegotiate: async () => ({
        decision: "escalated",
        message: "Peer initiated escalation.",
        escalation_id: "esc_9",
        negotiation_id: "neg_1",
      }),
    });
    const res = await h.tool("negotiate").handler({
      peer_id: "agent_peer",
      proposal: "p",
    });
    expect(res.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_9",
      negotiation_id: "neg_1",
      message: "Peer initiated escalation.",
    });
    expect(res.content.from_agent_id).toBeUndefined();
  });

  it("projects the IC guardrail with its code", async () => {
    const h = harness({
      sendNegotiate: async () => {
        throw new CannotNegotiateWithIcError({ agentId: "agent_ic" });
      },
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
  });
});

// ── respond_negotiate ────────────────────────────────────────────────────

describe("respond_negotiate", () => {
  function input(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      negotiation_id: "neg_1",
      decision: "counter",
      message: "not quite",
      counter_proposal: "Tuesday",
      ...overrides,
    };
  }

  it("forwards the round with the caller as sender and their session id", async () => {
    const h = harness();
    await h.tool("respond_negotiate").handler(input());
    expect(h.mesh.respondNegotiate).toHaveBeenCalledWith(
      "neg_1",
      {
        negotiation_id: "neg_1",
        from_agent_id: CALLER,
        decision: "counter",
        message: "not quite",
        counter_proposal: "Tuesday",
      },
      SID,
    );
  });

  it("reports a terminal round when the server returns null", async () => {
    const h = harness();
    const res = await h.tool("respond_negotiate").handler(
      input({ decision: "accept", counter_proposal: undefined }),
    );
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({
      negotiation_id: "neg_1",
      decision: "accept",
      terminal: true,
    });
  });

  it("projects the peer's next round when the server returns one", async () => {
    const h = harness({
      respondNegotiate: async () => ({
        negotiation_id: "neg_1",
        from_agent_id: "agent_peer",
        decision: "reject",
        message: "no deal",
      }),
    });
    const res = await h.tool("respond_negotiate").handler(input());
    expect(res.content).toEqual({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "reject",
      message: "no deal",
      counter_proposal: undefined,
    });
  });

  it("projects the escalated sentinel when the peer escalated while we waited", async () => {
    const h = harness({
      respondNegotiate: async () => ({
        decision: "escalated",
        message: "Peer initiated escalation.",
        escalation_id: "esc_4",
        negotiation_id: "neg_1",
      }),
    });
    const res = await h.tool("respond_negotiate").handler(input());
    expect(res.content).toMatchObject({
      decision: "escalated",
      escalation_id: "esc_4",
    });
  });

  it.each([
    ["no negotiation id", { negotiation_id: undefined }],
    ["no message", { message: "" }],
  ])("refuses a call with %s", async (_label, patch) => {
    const h = harness();
    const res = await h.tool("respond_negotiate").handler(input(patch));
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("negotiation_id and message required");
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it.each([["approve"], [""], [42]])(
    "refuses the unknown decision %p",
    async (decision) => {
      const h = harness();
      const res = await h.tool("respond_negotiate").handler(input({ decision }));
      expect(res.isError).toBe(true);
      expect(String(res.content.error)).toContain(
        "decision must be one of: counter, accept, reject",
      );
      expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
    },
  );

  it("requires a counter_proposal when countering", async () => {
    const h = harness();
    const res = await h.tool("respond_negotiate").handler(
      input({ counter_proposal: undefined }),
    );
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe(
      "counter_proposal required when decision='counter'",
    );
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it.each([["accept"], ["reject"]])(
    "does not require a counter_proposal to %s",
    async (decision) => {
      const h = harness();
      const res = await h.tool("respond_negotiate").handler(
        input({ decision, counter_proposal: undefined }),
      );
      expect(res.isError).toBeUndefined();
    },
  );

  it("surfaces the max-rounds cap with its counts so the agent can escalate", async () => {
    const h = harness({
      respondNegotiate: async () => {
        throw new MeshMaxRoundsError({
          negotiationId: "neg_1",
          rounds_completed: 10,
          max_rounds: 5,
        });
      },
    });
    const res = await h.tool("respond_negotiate").handler(input());
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({
      error: "MAX_ROUNDS_EXCEEDED",
      negotiationId: "neg_1",
      rounds_completed: 10,
      max_rounds: 5,
    });
  });
});

// ── report_blocker ───────────────────────────────────────────────────────

describe("report_blocker", () => {
  it("marks the task blocked, then spawns the parent", async () => {
    const order: string[] = [];
    const h = harness({
      markBlocked: async () => {
        order.push("markBlocked");
      },
    });
    h.mesh.reportBlocker.mockImplementation(() => order.push("spawnParent"));

    const res = await h.tool("report_blocker").handler({
      task_id: "task_5",
      description: "CI is red on main",
    });
    expect(h.findParent).toHaveBeenCalledWith(CALLER);
    expect(h.markBlocked).toHaveBeenCalledWith(
      "task_5",
      CALLER,
      "CI is red on main",
    );
    expect(h.mesh.reportBlocker).toHaveBeenCalledWith(
      "agent_parent",
      CALLER,
      "task_5",
      "CI is red on main",
    );
    // The task row must be blocked before the parent's session can read it.
    expect(order).toEqual(["markBlocked", "spawnParent"]);
    expect(res.content).toEqual({
      reported: true,
      parent_agent_id: "agent_parent",
      task_id: "task_5",
    });
  });

  it("refuses a top-level caller with no parent, and blocks nothing", async () => {
    const h = harness({ parent: null });
    const res = await h.tool("report_blocker").handler({
      task_id: "task_5",
      description: "stuck",
    });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("no_parent_to_block");
    expect(String(res.content.message)).toContain("escalate_to_humans");
    expect(h.markBlocked).not.toHaveBeenCalled();
    expect(h.mesh.reportBlocker).not.toHaveBeenCalled();
  });

  it.each([
    ["no task id", { description: "stuck" }],
    ["no description", { task_id: "task_5" }],
  ])("refuses a call with %s", async (_label, input) => {
    const h = harness();
    const res = await h.tool("report_blocker").handler(input);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("task_id and description required");
    expect(h.findParent).not.toHaveBeenCalled();
  });

  it("does not spawn the parent when marking the task blocked fails", async () => {
    const h = harness({
      markBlocked: async () => {
        throw new Error("task task_5 not found");
      },
    });
    const res = await h.tool("report_blocker").handler({
      task_id: "task_5",
      description: "stuck",
    });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("task task_5 not found");
    expect(h.mesh.reportBlocker).not.toHaveBeenCalled();
  });
});

// ── escalate_to_humans ───────────────────────────────────────────────────

describe("escalate_to_humans", () => {
  it("creates the escalation, unblocks the peer, then notifies listeners", async () => {
    const order: string[] = [];
    const h = harness({
      createEscalation: async () => {
        order.push("create");
        return { id: "esc_1", status: "open", negotiation_id: "neg_1" };
      },
    });
    h.mesh.unblockOnEscalate.mockImplementation(() => order.push("unblock"));
    h.query.mockImplementation(async () => {
      order.push("notify");
      return { rows: [] };
    });

    const res = await h.tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "We're stuck on the rollout order.",
      proposals: [{ title: "A", description: "ship A first" }],
      open_questions: ["does legal care?", 42, null],
    });

    expect(h.createEscalation).toHaveBeenCalledWith({
      negotiationId: "neg_1",
      callerAgentId: CALLER,
      summary: "We're stuck on the rollout order.",
      proposals: [{ title: "A", description: "ship A first" }],
      // Non-strings are dropped rather than forwarded to the human view.
      openQuestions: ["does legal care?"],
    });
    expect(h.mesh.unblockOnEscalate).toHaveBeenCalledWith("neg_1", "esc_1");
    expect(h.query).toHaveBeenCalledWith(
      "SELECT pg_notify('escalation_created', $1)",
      ["esc_1"],
    );
    // The peer must be released before we block on the notify round-trip.
    expect(order).toEqual(["create", "unblock", "notify"]);
    expect(res.content).toEqual({
      escalation_id: "esc_1",
      status: "open",
      negotiation_id: "neg_1",
    });
  });

  it("treats non-array proposals and open_questions as absent", async () => {
    const h = harness();
    await h.tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "stuck",
      proposals: "just one",
      open_questions: "why",
    });
    expect(h.createEscalation.mock.calls[0]?.[0]).toMatchObject({
      proposals: undefined,
      openQuestions: undefined,
    });
  });

  it.each([
    ["no negotiation id", { summary: "s" }],
    ["no summary", { negotiation_id: "neg_1" }],
  ])("refuses a call with %s", async (_label, input) => {
    const h = harness();
    const res = await h.tool("escalate_to_humans").handler(input);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("negotiation_id and summary required");
    expect(h.createEscalation).not.toHaveBeenCalled();
  });

  it("leaves the peer blocked when the escalation can't be created", async () => {
    // Better the peer waits out its own timeout than gets a sentinel
    // pointing at an escalation id that doesn't exist.
    const h = harness({
      createEscalation: async () => {
        throw new Error("negotiation neg_1 is not active");
      },
    });
    const res: AgentToolResult = await h.tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "stuck",
    });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("negotiation neg_1 is not active");
    expect(h.mesh.unblockOnEscalate).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
  });
});
