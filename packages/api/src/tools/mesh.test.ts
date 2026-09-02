/**
 * Mesh tool tests — IC vs team tier gating, plus per-handler behavior.
 *
 * The tier inventory suites lock the exact tool *names* each tier gets, so
 * future skill-loader work can rely on the surface being stable.
 *
 * The handler suites below drive each tool's argument coercion, validation
 * and error envelope against fake services. The wire-level flows (a real
 * spawn blocking until the peer responds) still belong to the m6/m7 e2e
 * scripts, which need live Postgres + CLI subprocesses; what's unit-testable
 * here is everything between the MCP boundary and the MeshServer call.
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentRepository, TaskRepository } from "@beevibe/core";
import type { EscalationService } from "@beevibe/core/services/escalation-service";
import type { TaskService } from "@beevibe/core/services/task-service";
import type { Pool } from "@beevibe/core/adapters/postgres";
import { MeshCapacityError } from "../mesh/types.js";
import type { MeshServer } from "../mesh/server.js";
import type { McpCaller } from "./assemble.js";
import type { AgentTool } from "./types.js";
import {
  buildIcMeshTools,
  buildTeamMeshTools,
  type MeshToolContext,
  type MeshToolServices,
} from "./mesh.js";

// Fake services — the assembly itself doesn't invoke handlers, so the
// dependencies just need to be the right shape.
const fakeServices = {} as unknown as MeshToolServices;

// McpCaller, not the wider ResolvedCaller: a mesh tool is never built for a
// daemon caller, and MeshToolContext.caller excludes that variant.
const fakeCaller: McpCaller = {
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

interface MeshFakes {
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

function meshHarness(overrides: Partial<MeshFakes> = {}) {
  const f: MeshFakes = {
    sendAsk:
      overrides.sendAsk ??
      vi.fn(async (requestId: string) => ({
        request_id: requestId,
        from_agent_id: "agent_y",
        answer: "yes",
      })),
    respondAsk: overrides.respondAsk ?? vi.fn(),
    sendNegotiate:
      overrides.sendNegotiate ??
      vi.fn(async () => ({
        negotiation_id: "neg_1",
        from_agent_id: "agent_y",
        decision: "counter",
        message: "how about this",
        counter_proposal: "half now, half later",
      })),
    respondNegotiate: overrides.respondNegotiate ?? vi.fn(async () => null),
    reportBlocker: overrides.reportBlocker ?? vi.fn(),
    unblockOnEscalate: overrides.unblockOnEscalate ?? vi.fn(),
    findParent: overrides.findParent ?? vi.fn(async () => ({ id: "agent_parent" })),
    markBlocked: overrides.markBlocked ?? vi.fn(async () => undefined),
    createEscalation:
      overrides.createEscalation ??
      vi.fn(async () => ({
        id: "esc_1",
        status: "open",
        negotiation_id: "neg_1",
      })),
    query: overrides.query ?? vi.fn(async () => ({ rows: [] })),
  };

  const services = {
    mesh: {
      sendAsk: f.sendAsk,
      respondAsk: f.respondAsk,
      sendNegotiate: f.sendNegotiate,
      respondNegotiate: f.respondNegotiate,
      reportBlocker: f.reportBlocker,
      unblockOnEscalate: f.unblockOnEscalate,
    } as unknown as MeshServer,
    agentRepo: { findParent: f.findParent } as unknown as AgentRepository,
    taskRepo: {} as unknown as TaskRepository,
    taskService: { markBlocked: f.markBlocked } as unknown as TaskService,
    escalationService: { create: f.createEscalation } as unknown as EscalationService,
    pool: { query: f.query } as unknown as Pool,
  } satisfies MeshToolServices;

  const ctx: MeshToolContext = { caller: fakeCaller, beevibeSid: "ses_x" };
  const tools = buildTeamMeshTools(ctx, services);
  const tool = (name: string): AgentTool => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`tool ${name} not built`);
    return t;
  };
  return { f, tool, ctx, services };
}

describe("ask handler", () => {
  it("mints a request id and projects only the wire fields back", async () => {
    const { f, tool } = meshHarness();

    const result = await tool("ask").handler({
      target_agent_id: "agent_y",
      question: "is X feasible?",
    });

    const [requestId, from, target, question] = f.sendAsk.mock.calls[0] ?? [];
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect([from, target, question]).toEqual(["agent_x", "agent_y", "is X feasible?"]);
    // Projection is deliberate: internal fields on AskResponse stay internal.
    expect(result.content).toEqual({
      request_id: requestId,
      from_agent_id: "agent_y",
      answer: "yes",
    });
  });

  it("mints a fresh request id per call", async () => {
    const { f, tool } = meshHarness();

    await tool("ask").handler({ target_agent_id: "agent_y", question: "q1" });
    await tool("ask").handler({ target_agent_id: "agent_y", question: "q2" });

    expect(f.sendAsk.mock.calls[0]?.[0]).not.toBe(f.sendAsk.mock.calls[1]?.[0]);
  });

  it("rejects a missing target or question without spawning the peer", async () => {
    const { f, tool } = meshHarness();

    for (const input of [
      {},
      { target_agent_id: "agent_y" },
      { question: "q" },
      { target_agent_id: "", question: "q" },
    ]) {
      const result = await tool("ask").handler(input);
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({
        error: "target_agent_id and question required",
      });
    }
    expect(f.sendAsk).not.toHaveBeenCalled();
  });

  it("keeps a CodedMeshError's code and meta in the envelope", async () => {
    const { tool } = meshHarness({
      sendAsk: vi.fn(async () => {
        throw new MeshCapacityError("too many running", {
          agentId: "agent_y",
          running: 5,
          cap: 5,
        });
      }),
    });

    const result = await tool("ask").handler({
      target_agent_id: "agent_y",
      question: "q",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "MESH_CAPACITY_EXCEEDED",
      agentId: "agent_y",
      running: 5,
      cap: 5,
      message: "too many running",
    });
  });

  it("degrades an unrecognized throw to the catch-all shape", async () => {
    const { tool } = meshHarness({
      sendAsk: vi.fn(async () => {
        throw new Error("peer never spawned");
      }),
    });

    const result = await tool("ask").handler({
      target_agent_id: "agent_y",
      question: "q",
    });

    expect(result.content).toEqual({ error: "peer never spawned" });
  });
});

describe("respond_ask handler", () => {
  it("unblocks the asker under the responder's own agent id", async () => {
    const { f, tool } = meshHarness();

    const result = await tool("respond_ask").handler({
      request_id: "req_1",
      answer: "yes, feasible",
    });

    expect(f.respondAsk).toHaveBeenCalledWith("req_1", {
      request_id: "req_1",
      from_agent_id: "agent_x",
      answer: "yes, feasible",
    });
    expect(result.content).toEqual({ responded: true, request_id: "req_1" });
  });

  it("rejects a missing request_id or answer", async () => {
    const { f, tool } = meshHarness();

    for (const input of [{}, { request_id: "req_1" }, { answer: "a" }]) {
      const result = await tool("respond_ask").handler(input);
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({
        error: "request_id and answer required",
      });
    }
    expect(f.respondAsk).not.toHaveBeenCalled();
  });

  it("wraps a throw from the mesh server", async () => {
    const { tool } = meshHarness({
      respondAsk: vi.fn(() => {
        throw new Error("no waiter for req_1");
      }),
    });

    const result = await tool("respond_ask").handler({
      request_id: "req_1",
      answer: "a",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "no waiter for req_1" });
  });
});

describe("negotiate handler", () => {
  it("passes the optional task id and the caller's session as originator metadata", async () => {
    const { f, tool } = meshHarness();

    const result = await tool("negotiate").handler({
      peer_id: "agent_y",
      proposal: "ship on Friday",
      task_id: "task_1",
    });

    expect(f.sendNegotiate).toHaveBeenCalledWith("agent_x", "agent_y", "ship on Friday", {
      taskId: "task_1",
      initiatorSessionId: "ses_x",
    });
    expect(result.content).toEqual({
      negotiation_id: "neg_1",
      from_agent_id: "agent_y",
      decision: "counter",
      message: "how about this",
      counter_proposal: "half now, half later",
    });
  });

  it("omits a task id that is blank or not a string", async () => {
    const { f, tool } = meshHarness();

    await tool("negotiate").handler({ peer_id: "agent_y", proposal: "p" });
    await tool("negotiate").handler({ peer_id: "agent_y", proposal: "p", task_id: "" });
    await tool("negotiate").handler({ peer_id: "agent_y", proposal: "p", task_id: 7 });

    for (const call of f.sendNegotiate.mock.calls) {
      expect(call[3]).toMatchObject({ taskId: undefined });
    }
  });

  it("projects the escalated sentinel through its own shape", async () => {
    const { tool } = meshHarness({
      sendNegotiate: vi.fn(async () => ({
        decision: "escalated",
        escalation_id: "esc_1",
        negotiation_id: "neg_1",
        message: "handed to humans",
      })),
    });

    const result = await tool("negotiate").handler({
      peer_id: "agent_y",
      proposal: "p",
    });

    expect(result.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_1",
      negotiation_id: "neg_1",
      message: "handed to humans",
    });
  });

  it("rejects a missing peer_id or proposal", async () => {
    const { f, tool } = meshHarness();

    for (const input of [{}, { peer_id: "agent_y" }, { proposal: "p" }]) {
      const result = await tool("negotiate").handler(input);
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "peer_id and proposal required" });
    }
    expect(f.sendNegotiate).not.toHaveBeenCalled();
  });

  it("surfaces the server's IC guardrail as a coded error", async () => {
    const { tool } = meshHarness({
      sendNegotiate: vi.fn(async () => {
        throw new Error("cannot_negotiate_with_ic");
      }),
    });

    const result = await tool("negotiate").handler({
      peer_id: "agent_ic",
      proposal: "p",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "cannot_negotiate_with_ic" });
  });
});

describe("respond_negotiate handler", () => {
  it("sends a counter with its proposal and returns the peer's reply", async () => {
    const { f, tool } = meshHarness({
      respondNegotiate: vi.fn(async () => ({
        negotiation_id: "neg_1",
        from_agent_id: "agent_y",
        decision: "accept",
        message: "works",
        counter_proposal: undefined,
      })),
    });

    const result = await tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "not quite",
      counter_proposal: "Monday instead",
    });

    // The round number is the server's to compute — the tool must not send one.
    expect(f.respondNegotiate).toHaveBeenCalledWith(
      "neg_1",
      {
        negotiation_id: "neg_1",
        from_agent_id: "agent_x",
        decision: "counter",
        message: "not quite",
        counter_proposal: "Monday instead",
      },
      "ses_x",
    );
    expect(result.content).toMatchObject({ decision: "accept" });
  });

  it("reports terminal when the server returns null", async () => {
    const { tool } = meshHarness();

    const result = await tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "accept",
      message: "agreed",
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      negotiation_id: "neg_1",
      decision: "accept",
      terminal: true,
    });
  });

  it("rejects a missing negotiation_id or message", async () => {
    const { f, tool } = meshHarness();

    for (const input of [
      { decision: "accept", message: "m" },
      { negotiation_id: "neg_1", decision: "accept" },
    ]) {
      const result = await tool("respond_negotiate").handler(input);
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({
        error: "negotiation_id and message required",
      });
    }
    expect(f.respondNegotiate).not.toHaveBeenCalled();
  });

  it("rejects a decision outside counter/accept/reject", async () => {
    const { f, tool } = meshHarness();

    const result = await tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "maybe",
      message: "m",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "decision must be one of: counter, accept, reject",
    });
    expect(f.respondNegotiate).not.toHaveBeenCalled();
  });

  it("rejects a counter with no counter_proposal", async () => {
    const { f, tool } = meshHarness();

    const result = await tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "counter_proposal required when decision='counter'",
    });
    expect(f.respondNegotiate).not.toHaveBeenCalled();
  });

  it("surfaces max_rounds_exceeded from the server", async () => {
    const { tool } = meshHarness({
      respondNegotiate: vi.fn(async () => {
        throw new Error("max_rounds_exceeded");
      }),
    });

    const result = await tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "accept",
      message: "m",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "max_rounds_exceeded" });
  });
});

describe("report_blocker handler", () => {
  it("marks the task blocked, then spawns the direct parent", async () => {
    const order: string[] = [];
    const { f, tool } = meshHarness({
      markBlocked: vi.fn(async () => {
        order.push("markBlocked");
      }),
      reportBlocker: vi.fn(() => {
        order.push("spawnParent");
      }),
    });

    const result = await tool("report_blocker").handler({
      task_id: "task_1",
      description: "the API key is missing",
    });

    expect(f.findParent).toHaveBeenCalledWith("agent_x");
    expect(f.markBlocked).toHaveBeenCalledWith(
      "task_1",
      "agent_x",
      "the API key is missing",
    );
    expect(f.reportBlocker).toHaveBeenCalledWith(
      "agent_parent",
      "agent_x",
      "task_1",
      "the API key is missing",
    );
    // The task must read as blocked before the parent's session can look at it.
    expect(order).toEqual(["markBlocked", "spawnParent"]);
    expect(result.content).toEqual({
      reported: true,
      parent_agent_id: "agent_parent",
      task_id: "task_1",
    });
  });

  it("refuses a top-level agent with no parent, leaving the task alone", async () => {
    const { f, tool } = meshHarness({ findParent: vi.fn(async () => null) });

    const result = await tool("report_blocker").handler({
      task_id: "task_1",
      description: "stuck",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "no_parent_to_block" });
    expect(f.markBlocked).not.toHaveBeenCalled();
    expect(f.reportBlocker).not.toHaveBeenCalled();
  });

  it("rejects a missing task_id or description before touching the hierarchy", async () => {
    const { f, tool } = meshHarness();

    for (const input of [{}, { task_id: "task_1" }, { description: "d" }]) {
      const result = await tool("report_blocker").handler(input);
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({
        error: "task_id and description required",
      });
    }
    expect(f.findParent).not.toHaveBeenCalled();
  });

  it("wraps a throw from markBlocked without spawning the parent", async () => {
    const { f, tool } = meshHarness({
      markBlocked: vi.fn(async () => {
        throw new Error("task not found");
      }),
    });

    const result = await tool("report_blocker").handler({
      task_id: "task_1",
      description: "d",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "task not found" });
    expect(f.reportBlocker).not.toHaveBeenCalled();
  });
});

describe("escalate_to_humans handler", () => {
  it("creates the escalation, unblocks the peer, then notifies listeners", async () => {
    const order: string[] = [];
    const { f, tool } = meshHarness({
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
      summary: "We're stuck on X.",
      proposals: [{ title: "A", description: "do A" }],
      open_questions: ["what is the deadline?"],
    });

    expect(f.createEscalation).toHaveBeenCalledWith({
      negotiationId: "neg_1",
      callerAgentId: "agent_x",
      summary: "We're stuck on X.",
      proposals: [{ title: "A", description: "do A" }],
      openQuestions: ["what is the deadline?"],
    });
    expect(f.unblockOnEscalate).toHaveBeenCalledWith("neg_1", "esc_1");
    expect(f.query).toHaveBeenCalledWith(
      `SELECT pg_notify('escalation_created', $1)`,
      ["esc_1"],
    );
    // The escalation row has to exist before anyone is told to go read it.
    expect(order).toEqual(["create", "unblock", "notify"]);
    expect(result.content).toEqual({
      escalation_id: "esc_1",
      status: "open",
      negotiation_id: "neg_1",
    });
  });

  it("omits proposals and open_questions that are not arrays", async () => {
    const { f, tool } = meshHarness();

    await tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "s",
      proposals: "A or B",
      open_questions: "when?",
    });

    expect(f.createEscalation.mock.calls[0]?.[0]).toMatchObject({
      proposals: undefined,
      openQuestions: undefined,
    });
  });

  it("filters non-string entries out of open_questions", async () => {
    const { f, tool } = meshHarness();

    await tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "s",
      open_questions: ["when?", 42, null, "who?"],
    });

    expect(f.createEscalation.mock.calls[0]?.[0]).toMatchObject({
      openQuestions: ["when?", "who?"],
    });
  });

  it("rejects a missing negotiation_id or summary", async () => {
    const { f, tool } = meshHarness();

    for (const input of [{}, { negotiation_id: "neg_1" }, { summary: "s" }]) {
      const result = await tool("escalate_to_humans").handler(input);
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({
        error: "negotiation_id and summary required",
      });
    }
    expect(f.createEscalation).not.toHaveBeenCalled();
  });

  it("wraps a create failure without unblocking the peer", async () => {
    const { f, tool } = meshHarness({
      createEscalation: vi.fn(async () => {
        throw new Error("negotiation already escalated");
      }),
    });

    const result = await tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "s",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "negotiation already escalated" });
    expect(f.unblockOnEscalate).not.toHaveBeenCalled();
  });
});

describe("IC mesh handlers", () => {
  it("shares the same respond_ask and report_blocker implementations", async () => {
    const { services, ctx, f } = meshHarness();
    const icTools = buildIcMeshTools(ctx, services);

    const respondAsk = icTools.find((t) => t.name === "respond_ask");
    await respondAsk?.handler({ request_id: "req_1", answer: "a" });

    expect(f.respondAsk).toHaveBeenCalledWith("req_1", {
      request_id: "req_1",
      from_agent_id: "agent_x",
      answer: "a",
    });
  });
});
