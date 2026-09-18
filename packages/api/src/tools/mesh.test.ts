/**
 * Mesh tool tests — tier gating plus per-handler behavior.
 *
 * The end-to-end flows (real spawns, real blocking round-trips) stay in
 * the m6/m7 e2e scripts, which need live Postgres and CLI subprocesses.
 * What's unit-testable here is everything the tool layer itself owns:
 * the static tier inventory, the argument guards that run before
 * MeshServer is ever reached, the projection of each response onto the
 * agent-facing wire shape, and the error envelopes. A fake MeshServer
 * stands in for the blocking transport.
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentRepository, TaskRepository } from "@beevibe/core";
import type { ResolvedCaller } from "@beevibe/core/auth";
import type { EscalationService } from "@beevibe/core/services/escalation-service";
import type { TaskService } from "@beevibe/core/services/task-service";
import type { Pool } from "@beevibe/core/adapters/postgres";
import { buildIcMeshTools, buildTeamMeshTools, type MeshToolServices } from "./mesh.js";
import {
  CannotNegotiateWithIcError,
  MeshCapacityError,
  MeshMaxRoundsError,
} from "../mesh/types.js";
import type { MeshServer } from "../mesh/server.js";
import type { McpCaller } from "./assemble.js";
import type { AgentTool } from "./types.js";

// Fake services — the assembly itself doesn't invoke handlers, so the
// dependencies just need to be the right shape.
const fakeServices = {} as unknown as MeshToolServices;

const fakeCaller: ResolvedCaller = {
  agentId: "agent_x",
  source: "agent",
  hierarchyLevel: "team",
};
const fakeCtx = { caller: fakeCaller, beevibeSid: "ses_x" };

describe("buildIcMeshTools (M9.1)", () => {
  // Exact set, not a superset: ICs are responders, not initiators, so the
  // absences matter as much as the presences. No `respond_negotiate`
  // (M9.1 dropped it — ICs are workers, not deciders) and none of the
  // initiator-side surface (`ask`, `negotiate`, `escalate_to_humans`).
  it("gets exactly respond_ask + report_blocker", () => {
    const tools = buildIcMeshTools(fakeCtx, fakeServices);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["report_blocker", "respond_ask"]);
  });
});

describe("buildTeamMeshTools", () => {
  it("gets the full mesh surface — initiator and responder sides both", () => {
    const tools = buildTeamMeshTools(fakeCtx, fakeServices);
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
});

// ── Handler harness ──────────────────────────────────────────────────────

interface MeshStubs {
  sendAsk: ReturnType<typeof vi.fn>;
  respondAsk: ReturnType<typeof vi.fn>;
  sendNegotiate: ReturnType<typeof vi.fn>;
  respondNegotiate: ReturnType<typeof vi.fn>;
  reportBlocker: ReturnType<typeof vi.fn>;
  unblockOnEscalate: ReturnType<typeof vi.fn>;
  findParent: ReturnType<typeof vi.fn>;
  markBlocked: ReturnType<typeof vi.fn>;
  createEscalation: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
}

function harness(overrides: Partial<MeshStubs> = {}): {
  tool: (name: string) => AgentTool;
  stubs: MeshStubs;
} {
  const stubs: MeshStubs = {
    sendAsk:
      overrides.sendAsk ??
      vi.fn(async (requestId: string) => ({
        request_id: requestId,
        from_agent_id: "agent_target",
        answer: "yes, feasible",
      })),
    respondAsk: overrides.respondAsk ?? vi.fn(() => undefined),
    sendNegotiate:
      overrides.sendNegotiate ??
      vi.fn(async () => ({
        negotiation_id: "neg_1",
        from_agent_id: "agent_peer",
        decision: "counter",
        message: "how about Tuesday",
        counter_proposal: "ship Tuesday",
      })),
    respondNegotiate:
      overrides.respondNegotiate ??
      vi.fn(async () => ({
        negotiation_id: "neg_1",
        from_agent_id: "agent_peer",
        decision: "counter",
        message: "still Tuesday",
        counter_proposal: "ship Tuesday",
      })),
    reportBlocker: overrides.reportBlocker ?? vi.fn(() => undefined),
    unblockOnEscalate: overrides.unblockOnEscalate ?? vi.fn(() => undefined),
    findParent: overrides.findParent ?? vi.fn(async () => ({ id: "agent_parent" })),
    markBlocked: overrides.markBlocked ?? vi.fn(async () => ({ id: "tsk_1" })),
    createEscalation:
      overrides.createEscalation ??
      vi.fn(async () => ({
        id: "esc_1",
        status: "open",
        negotiation_id: "neg_1",
      })),
    query: overrides.query ?? vi.fn(async () => ({ rows: [] })),
  };

  const services: MeshToolServices = {
    mesh: {
      sendAsk: stubs.sendAsk,
      respondAsk: stubs.respondAsk,
      sendNegotiate: stubs.sendNegotiate,
      respondNegotiate: stubs.respondNegotiate,
      reportBlocker: stubs.reportBlocker,
      unblockOnEscalate: stubs.unblockOnEscalate,
    } as unknown as MeshServer,
    agentRepo: { findParent: stubs.findParent } as unknown as AgentRepository,
    taskRepo: {} as unknown as TaskRepository,
    taskService: { markBlocked: stubs.markBlocked } as unknown as TaskService,
    escalationService: {
      create: stubs.createEscalation,
    } as unknown as EscalationService,
    pool: { query: stubs.query } as unknown as Pool,
  };

  const built = buildTeamMeshTools(fakeCtx, services);
  return {
    stubs,
    tool: (name: string) => {
      const found = built.find((t) => t.name === name);
      if (!found) throw new Error(`no such mesh tool: ${name}`);
      return found;
    },
  };
}

// ── ask / respond_ask ────────────────────────────────────────────────────

describe("ask", () => {
  it("mints a request id, sends from the caller, and projects the answer", async () => {
    const { tool, stubs } = harness();

    const result = await tool("ask").handler({
      target_agent_id: "agent_target",
      question: "is X feasible?",
    });

    const [requestId, from, target, question] = stubs.sendAsk.mock.calls[0]!;
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect([from, target, question]).toEqual([
      "agent_x",
      "agent_target",
      "is X feasible?",
    ]);
    expect(result.isError).toBeFalsy();
    // Exactly the three projected fields — no internal transport state.
    expect(result.content).toEqual({
      request_id: requestId,
      from_agent_id: "agent_target",
      answer: "yes, feasible",
    });
  });

  it("mints a fresh request id per call", async () => {
    const { tool, stubs } = harness();

    await tool("ask").handler({ target_agent_id: "a", question: "q" });
    await tool("ask").handler({ target_agent_id: "a", question: "q" });

    expect(stubs.sendAsk.mock.calls[0]![0]).not.toBe(stubs.sendAsk.mock.calls[1]![0]);
  });

  it.each([
    ["no target", { question: "q" }],
    ["no question", { target_agent_id: "a" }],
    ["empty target", { target_agent_id: "", question: "q" }],
    ["empty question", { target_agent_id: "a", question: "" }],
  ])("refuses a call with %s without spawning the target", async (_label, input) => {
    const { tool, stubs } = harness();

    const result = await tool("ask").handler(input as Record<string, unknown>);

    expect(result.isError).toBe(true);
    expect(result.content.error).toBe("target_agent_id and question required");
    expect(stubs.sendAsk).not.toHaveBeenCalled();
  });

  it("projects a capacity error onto its coded envelope with the meta intact", async () => {
    const { tool } = harness({
      sendAsk: vi.fn(async () => {
        throw new MeshCapacityError("at cap", {
          agentId: "agent_target",
          running: 3,
          cap: 3,
        });
      }),
    });

    const result = await tool("ask").handler({
      target_agent_id: "agent_target",
      question: "q",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "MESH_CAPACITY_EXCEEDED",
      agentId: "agent_target",
      running: 3,
      cap: 3,
      message: "at cap",
    });
  });
});

describe("respond_ask", () => {
  it("hands the answer back to the blocked asker under the caller's id", async () => {
    const { tool, stubs } = harness();

    const result = await tool("respond_ask").handler({
      request_id: "req_1",
      answer: "here you go",
    });

    expect(stubs.respondAsk).toHaveBeenCalledWith("req_1", {
      request_id: "req_1",
      from_agent_id: "agent_x",
      answer: "here you go",
    });
    expect(result.content).toEqual({ responded: true, request_id: "req_1" });
  });

  it.each([
    ["no request_id", { answer: "a" }],
    ["no answer", { request_id: "req_1" }],
  ])("refuses a call with %s", async (_label, input) => {
    const { tool, stubs } = harness();

    const result = await tool("respond_ask").handler(input as Record<string, unknown>);

    expect(result.isError).toBe(true);
    expect(result.content.error).toBe("request_id and answer required");
    expect(stubs.respondAsk).not.toHaveBeenCalled();
  });

  it("envelopes an unresolvable request id as a generic error", async () => {
    const { tool } = harness({
      respondAsk: vi.fn(() => {
        throw new Error("no pending ask req_gone");
      }),
    });

    const result = await tool("respond_ask").handler({
      request_id: "req_gone",
      answer: "a",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "no pending ask req_gone" });
  });
});

// ── negotiate / respond_negotiate ────────────────────────────────────────

describe("negotiate", () => {
  it("sends the proposal with the caller's session as originator metadata", async () => {
    const { tool, stubs } = harness();

    const result = await tool("negotiate").handler({
      peer_id: "agent_peer",
      proposal: "ship Monday",
      task_id: "tsk_1",
    });

    expect(stubs.sendNegotiate).toHaveBeenCalledWith(
      "agent_x",
      "agent_peer",
      "ship Monday",
      { taskId: "tsk_1", initiatorSessionId: "ses_x" },
    );
    expect(result.content).toEqual({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "counter",
      message: "how about Tuesday",
      counter_proposal: "ship Tuesday",
    });
  });

  it("leaves taskId undefined when task_id is absent, blank, or not a string", async () => {
    const { tool, stubs } = harness();

    await tool("negotiate").handler({ peer_id: "p", proposal: "x" });
    await tool("negotiate").handler({ peer_id: "p", proposal: "x", task_id: "" });
    await tool("negotiate").handler({ peer_id: "p", proposal: "x", task_id: 7 });

    for (const call of stubs.sendNegotiate.mock.calls) {
      expect(call[3]).toMatchObject({ taskId: undefined });
    }
  });

  it.each([
    ["no peer_id", { proposal: "x" }],
    ["no proposal", { peer_id: "p" }],
  ])("refuses a call with %s without spawning the peer", async (_label, input) => {
    const { tool, stubs } = harness();

    const result = await tool("negotiate").handler(input as Record<string, unknown>);

    expect(result.isError).toBe(true);
    expect(result.content.error).toBe("peer_id and proposal required");
    expect(stubs.sendNegotiate).not.toHaveBeenCalled();
  });

  it("surfaces the IC guardrail as its own code so the agent can switch to ask/create_task", async () => {
    const { tool } = harness({
      sendNegotiate: vi.fn(async () => {
        throw new CannotNegotiateWithIcError({ agentId: "agent_ic" });
      }),
    });

    const result = await tool("negotiate").handler({
      peer_id: "agent_ic",
      proposal: "x",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "CANNOT_NEGOTIATE_WITH_IC",
      agentId: "agent_ic",
    });
  });

  it("projects the escalated sentinel's own shape, not the counter shape", async () => {
    const { tool } = harness({
      sendNegotiate: vi.fn(async () => ({
        decision: "escalated",
        escalation_id: "esc_1",
        negotiation_id: "neg_1",
        message: "peer escalated to humans",
      })),
    });

    const result = await tool("negotiate").handler({
      peer_id: "agent_peer",
      proposal: "x",
    });

    expect(result.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_1",
      negotiation_id: "neg_1",
      message: "peer escalated to humans",
    });
    expect(result.content).not.toHaveProperty("counter_proposal");
  });
});

describe("respond_negotiate", () => {
  it("forwards a counter with its proposal and the caller's session", async () => {
    const { tool, stubs } = harness();

    const result = await tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "not Monday",
      counter_proposal: "Wednesday",
    });

    expect(stubs.respondNegotiate).toHaveBeenCalledWith(
      "neg_1",
      {
        negotiation_id: "neg_1",
        from_agent_id: "agent_x",
        decision: "counter",
        message: "not Monday",
        counter_proposal: "Wednesday",
      },
      "ses_x",
    );
    expect(result.content).toMatchObject({ decision: "counter" });
  });

  it.each(["accept", "reject"] as const)(
    "reports terminal when the server returns null after %s",
    async (decision) => {
      const { tool } = harness({ respondNegotiate: vi.fn(async () => null) });

      const result = await tool("respond_negotiate").handler({
        negotiation_id: "neg_1",
        decision,
        message: "done",
      });

      expect(result.isError).toBeFalsy();
      expect(result.content).toEqual({
        negotiation_id: "neg_1",
        decision,
        terminal: true,
      });
    },
  );

  it("projects the escalated sentinel when the peer escalated mid-round", async () => {
    const { tool } = harness({
      respondNegotiate: vi.fn(async () => ({
        decision: "escalated",
        escalation_id: "esc_9",
        negotiation_id: "neg_1",
        message: "handed to humans",
      })),
    });

    const result = await tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "c",
    });

    expect(result.content).toMatchObject({
      decision: "escalated",
      escalation_id: "esc_9",
    });
  });

  it.each([
    ["no negotiation_id", { decision: "accept", message: "m" }],
    ["no message", { negotiation_id: "neg_1", decision: "accept" }],
  ])("refuses a call with %s", async (_label, input) => {
    const { tool, stubs } = harness();

    const result = await tool("respond_negotiate").handler(
      input as Record<string, unknown>,
    );

    expect(result.isError).toBe(true);
    expect(result.content.error).toBe("negotiation_id and message required");
    expect(stubs.respondNegotiate).not.toHaveBeenCalled();
  });

  it("rejects a decision outside the enum", async () => {
    const { tool, stubs } = harness();

    const result = await tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "maybe",
      message: "m",
    });

    expect(result.isError).toBe(true);
    expect(result.content.error).toBe("decision must be one of: counter, accept, reject");
    expect(stubs.respondNegotiate).not.toHaveBeenCalled();
  });

  it("rejects a counter with no counter_proposal — the peer would have nothing to answer", async () => {
    const { tool, stubs } = harness();

    const result = await tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
    });

    expect(result.isError).toBe(true);
    expect(result.content.error).toBe(
      "counter_proposal required when decision='counter'",
    );
    expect(stubs.respondNegotiate).not.toHaveBeenCalled();
  });

  it("lets accept through without a counter_proposal", async () => {
    const { tool, stubs } = harness();

    await tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "accept",
      message: "agreed",
    });

    expect(stubs.respondNegotiate.mock.calls[0]![1]).toMatchObject({
      counter_proposal: undefined,
    });
  });

  it("surfaces max_rounds_exceeded with its round counters so the agent knows to escalate", async () => {
    const { tool } = harness({
      respondNegotiate: vi.fn(async () => {
        throw new MeshMaxRoundsError({
          negotiationId: "neg_1",
          rounds_completed: 5,
          max_rounds: 5,
        });
      }),
    });

    const result = await tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "c",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "MAX_ROUNDS_EXCEEDED",
      rounds_completed: 5,
      max_rounds: 5,
    });
  });
});

// ── report_blocker ───────────────────────────────────────────────────────

describe("report_blocker", () => {
  it("marks the task blocked, then spawns the parent", async () => {
    const order: string[] = [];
    const { tool, stubs } = harness({
      markBlocked: vi.fn(async () => {
        order.push("markBlocked");
        return { id: "tsk_1" };
      }),
      reportBlocker: vi.fn(() => {
        order.push("spawn");
      }),
    });

    const result = await tool("report_blocker").handler({
      task_id: "tsk_1",
      description: "the API key is missing",
    });

    expect(stubs.findParent).toHaveBeenCalledWith("agent_x");
    expect(stubs.markBlocked).toHaveBeenCalledWith(
      "tsk_1",
      "agent_x",
      "the API key is missing",
    );
    expect(stubs.reportBlocker).toHaveBeenCalledWith(
      "agent_parent",
      "agent_x",
      "tsk_1",
      "the API key is missing",
    );
    // The row has to be blocked before the parent's session reads it.
    expect(order).toEqual(["markBlocked", "spawn"]);
    expect(result.content).toEqual({
      reported: true,
      parent_agent_id: "agent_parent",
      task_id: "tsk_1",
    });
  });

  it("refuses a top-level agent with no parent, and leaves the task alone", async () => {
    const { tool, stubs } = harness({ findParent: vi.fn(async () => null) });

    const result = await tool("report_blocker").handler({
      task_id: "tsk_1",
      description: "stuck",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "no_parent_to_block" });
    expect(result.content.message).toContain("escalate_to_humans");
    expect(stubs.markBlocked).not.toHaveBeenCalled();
    expect(stubs.reportBlocker).not.toHaveBeenCalled();
  });

  it.each([
    ["no task_id", { description: "d" }],
    ["no description", { task_id: "tsk_1" }],
  ])("refuses a call with %s before resolving the parent", async (_label, input) => {
    const { tool, stubs } = harness();

    const result = await tool("report_blocker").handler(
      input as Record<string, unknown>,
    );

    expect(result.isError).toBe(true);
    expect(result.content.error).toBe("task_id and description required");
    expect(stubs.findParent).not.toHaveBeenCalled();
  });

  it("does not spawn the parent when marking the task blocked fails", async () => {
    const { tool, stubs } = harness({
      markBlocked: vi.fn(async () => {
        throw new Error("task tsk_gone not found");
      }),
    });

    const result = await tool("report_blocker").handler({
      task_id: "tsk_gone",
      description: "stuck",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "task tsk_gone not found" });
    expect(stubs.reportBlocker).not.toHaveBeenCalled();
  });
});

// ── escalate_to_humans ───────────────────────────────────────────────────

describe("escalate_to_humans", () => {
  it("creates the escalation, unblocks the peer, then notifies — in that order", async () => {
    const order: string[] = [];
    const { tool, stubs } = harness({
      createEscalation: vi.fn(async () => {
        order.push("create");
        return { id: "esc_1", status: "open", negotiation_id: "neg_1" };
      }),
      unblockOnEscalate: vi.fn(() => {
        order.push("unblock");
      }),
      query: vi.fn(async () => {
        order.push("notify");
        return { rows: [] };
      }),
    });

    const result = await tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "We disagree on the rollout window",
      proposals: [{ title: "Ship Monday", description: "…" }],
      open_questions: ["Is the customer demo fixed?"],
    });

    expect(stubs.createEscalation).toHaveBeenCalledWith({
      negotiationId: "neg_1",
      callerAgentId: "agent_x",
      summary: "We disagree on the rollout window",
      proposals: [{ title: "Ship Monday", description: "…" }],
      openQuestions: ["Is the customer demo fixed?"],
    });
    expect(stubs.unblockOnEscalate).toHaveBeenCalledWith("neg_1", "esc_1");
    expect(stubs.query.mock.calls[0]![1]).toEqual(["esc_1"]);
    expect(order).toEqual(["create", "unblock", "notify"]);
    expect(result.content).toEqual({
      escalation_id: "esc_1",
      status: "open",
      negotiation_id: "neg_1",
    });
  });

  it("drops non-array proposals / open_questions and non-string questions", async () => {
    const { tool, stubs } = harness();

    await tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "s",
      proposals: "not an array",
      open_questions: ["keep me", 42, null],
    });

    expect(stubs.createEscalation.mock.calls[0]![0]).toMatchObject({
      proposals: undefined,
      openQuestions: ["keep me"],
    });
  });

  it.each([
    ["no negotiation_id", { summary: "s" }],
    ["no summary", { negotiation_id: "neg_1" }],
  ])("refuses a call with %s", async (_label, input) => {
    const { tool, stubs } = harness();

    const result = await tool("escalate_to_humans").handler(
      input as Record<string, unknown>,
    );

    expect(result.isError).toBe(true);
    expect(result.content.error).toBe("negotiation_id and summary required");
    expect(stubs.createEscalation).not.toHaveBeenCalled();
  });

  it("does not unblock the peer when the escalation row never lands", async () => {
    const { tool, stubs } = harness({
      createEscalation: vi.fn(async () => {
        throw new Error("negotiation neg_1 already has an escalation");
      }),
    });

    const result = await tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "s",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "negotiation neg_1 already has an escalation",
    });
    expect(stubs.unblockOnEscalate).not.toHaveBeenCalled();
    expect(stubs.query).not.toHaveBeenCalled();
  });
});

// ── IC tier handlers ─────────────────────────────────────────────────────

describe("IC tier handlers", () => {
  it("wires the same respond_ask and report_blocker handlers the team tier gets", async () => {
    const stubs = {
      respondAsk: vi.fn(() => undefined),
      reportBlocker: vi.fn(() => undefined),
      findParent: vi.fn(async () => ({ id: "agent_lead" })),
      markBlocked: vi.fn(async () => ({ id: "tsk_1" })),
    };
    const services = {
      mesh: {
        respondAsk: stubs.respondAsk,
        reportBlocker: stubs.reportBlocker,
      } as unknown as MeshServer,
      agentRepo: { findParent: stubs.findParent } as unknown as AgentRepository,
      taskService: { markBlocked: stubs.markBlocked } as unknown as TaskService,
    } as unknown as MeshToolServices;

    const icCtx = {
      caller: {
        agentId: "agent_ic",
        source: "agent",
        hierarchyLevel: "ic",
      } as McpCaller,
      beevibeSid: "ses_ic",
    };
    const tools = buildIcMeshTools(icCtx, services);

    await tools.find((t) => t.name === "respond_ask")!.handler({
      request_id: "req_1",
      answer: "done",
    });
    await tools.find((t) => t.name === "report_blocker")!.handler({
      task_id: "tsk_1",
      description: "blocked",
    });

    expect(stubs.respondAsk).toHaveBeenCalledWith("req_1", {
      request_id: "req_1",
      from_agent_id: "agent_ic",
      answer: "done",
    });
    expect(stubs.reportBlocker).toHaveBeenCalledWith(
      "agent_lead",
      "agent_ic",
      "tsk_1",
      "blocked",
    );
  });
});
