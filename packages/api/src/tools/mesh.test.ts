/**
 * Mesh tool tests — tier gating plus per-handler behavior.
 *
 * The end-to-end mesh flows (a real spawn, a real block, a real
 * round-trip) need live Postgres and CLI subprocesses, and stay in the
 * m6/m7 e2e scripts. What lives here is everything that runs *before*
 * the server call and everything that shapes the result afterwards:
 * the tier inventory, argument validation, the parent lookup that gates
 * report_blocker, and the error/result projections the calling agent
 * branches on. All of that was uncovered.
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentRepository, TaskRepository } from "@beevibe/core";
import type { ResolvedCaller } from "@beevibe/core/auth";
import type { Pool } from "@beevibe/core/adapters/postgres";
import type { EscalationService } from "@beevibe/core/services/escalation-service";
import type { TaskService } from "@beevibe/core/services/task-service";
import { CannotNegotiateWithIcError, MeshMaxRoundsError } from "../mesh/types.js";
import type { MeshServer } from "../mesh/server.js";
import {
  buildIcMeshTools,
  buildTeamMeshTools,
  type MeshToolContext,
  type MeshToolServices,
} from "./mesh.js";

// Empty stand-in for the inventory tests below: assembly never invokes a
// handler, so it doesn't touch any of these. The handler tests build a
// wired harness (`meshHarness`) instead.
const fakeServices = {} as unknown as MeshToolServices;

const fakeCaller: ResolvedCaller = {
  agentId: "agent_x",
  source: "agent",
  hierarchyLevel: "team",
};
const fakeCtx: MeshToolContext = { caller: fakeCaller, beevibeSid: "ses_x" };

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

// ── Handler behavior ──────────────────────────────────────────────────

interface MeshHarness {
  services: MeshToolServices;
  mesh: {
    sendAsk: ReturnType<typeof vi.fn>;
    respondAsk: ReturnType<typeof vi.fn>;
    sendNegotiate: ReturnType<typeof vi.fn>;
    respondNegotiate: ReturnType<typeof vi.fn>;
    reportBlocker: ReturnType<typeof vi.fn>;
    unblockOnEscalate: ReturnType<typeof vi.fn>;
  };
  findParent: ReturnType<typeof vi.fn>;
  markBlocked: ReturnType<typeof vi.fn>;
  createEscalation: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
}

function meshHarness(
  overrides: {
    parent?: { id: string } | null;
    sendAsk?: () => unknown;
    sendNegotiate?: () => unknown;
    respondNegotiate?: () => unknown;
    markBlocked?: () => unknown;
    createEscalation?: () => unknown;
  } = {},
): MeshHarness {
  const mesh = {
    sendAsk: vi.fn(async () =>
      overrides.sendAsk
        ? overrides.sendAsk()
        : { request_id: "req_1", from_agent_id: "agent_b", answer: "yes, feasible" },
    ),
    respondAsk: vi.fn(() => undefined),
    sendNegotiate: vi.fn(async () =>
      overrides.sendNegotiate
        ? overrides.sendNegotiate()
        : {
            negotiation_id: "neg_1",
            from_agent_id: "agent_b",
            decision: "counter",
            message: "how about Tuesday",
            counter_proposal: "Tuesday",
          },
    ),
    respondNegotiate: vi.fn(async () =>
      overrides.respondNegotiate ? overrides.respondNegotiate() : null,
    ),
    reportBlocker: vi.fn(() => undefined),
    unblockOnEscalate: vi.fn(() => undefined),
  };
  const findParent = vi.fn(async () =>
    "parent" in overrides ? overrides.parent : { id: "agent_parent" },
  );
  const markBlocked = vi.fn(async () =>
    overrides.markBlocked ? overrides.markBlocked() : undefined,
  );
  const createEscalation = vi.fn(async () =>
    overrides.createEscalation
      ? overrides.createEscalation()
      : { id: "esc_1", status: "open", negotiation_id: "neg_1" },
  );
  const query = vi.fn(async () => ({ rows: [] }));

  const services = {
    mesh: mesh as unknown as MeshServer,
    agentRepo: { findParent } as unknown as AgentRepository,
    taskRepo: {} as unknown as TaskRepository,
    taskService: { markBlocked } as unknown as TaskService,
    escalationService: { create: createEscalation } as unknown as EscalationService,
    pool: { query } as unknown as Pool,
  } satisfies MeshToolServices;

  return { services, mesh, findParent, markBlocked, createEscalation, query };
}

function meshTool(h: MeshHarness, name: string, ctx: MeshToolContext = fakeCtx) {
  const tool = buildTeamMeshTools(ctx, h.services).find((t) => t.name === name);
  if (!tool) throw new Error(`no such mesh tool: ${name}`);
  return tool;
}

describe("ask", () => {
  it("mints a request id, forwards the caller as the asker, and projects the response", async () => {
    const h = meshHarness();
    const result = await meshTool(h, "ask").handler({
      target_agent_id: "agent_b",
      question: "is X feasible?",
    });

    expect(h.mesh.sendAsk).toHaveBeenCalledTimes(1);
    const [requestId, from, to, question] = h.mesh.sendAsk.mock.calls[0] ?? [];
    // A UUID minted per call — the asker never supplies it, so two asks
    // can't collide on the mesh server's pending-request map.
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect([from, to, question]).toEqual(["agent_x", "agent_b", "is X feasible?"]);

    // Projection, not passthrough: the agent sees only these three keys.
    expect(result.content).toEqual({
      request_id: "req_1",
      from_agent_id: "agent_b",
      answer: "yes, feasible",
    });
  });

  it("uses a fresh request id on every call", async () => {
    const h = meshHarness();
    const tool = meshTool(h, "ask");
    await tool.handler({ target_agent_id: "agent_b", question: "q1" });
    await tool.handler({ target_agent_id: "agent_b", question: "q2" });
    expect(h.mesh.sendAsk.mock.calls[0]?.[0]).not.toBe(h.mesh.sendAsk.mock.calls[1]?.[0]);
  });

  it("rejects a missing target or question without spawning the peer", async () => {
    const h = meshHarness();
    for (const input of [
      {},
      { target_agent_id: "agent_b" },
      { question: "q" },
      { target_agent_id: "", question: "q" },
      { target_agent_id: "agent_b", question: "" },
    ]) {
      const result = await meshTool(h, "ask").handler(input);
      expect(result.isError, JSON.stringify(input)).toBe(true);
      expect(result.content).toEqual({
        error: "target_agent_id and question required",
      });
    }
    expect(h.mesh.sendAsk).not.toHaveBeenCalled();
  });

  // A capacity or max-rounds refusal has to keep its code: the agent's
  // documented next step differs per code.
  it("preserves a CodedMeshError's code and meta", async () => {
    const err = new MeshMaxRoundsError({
      negotiationId: "neg_1",
      rounds_completed: 5,
      max_rounds: 5,
    });
    const h = meshHarness({
      sendAsk: () => {
        throw err;
      },
    });
    const result = await meshTool(h, "ask").handler({
      target_agent_id: "agent_b",
      question: "q",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "MAX_ROUNDS_EXCEEDED",
      negotiationId: "neg_1",
      max_rounds: 5,
    });
  });

  it("degrades an uncoded throw to the catch-all envelope", async () => {
    const h = meshHarness({
      sendAsk: () => {
        throw new Error("peer offline");
      },
    });
    const result = await meshTool(h, "ask").handler({
      target_agent_id: "agent_b",
      question: "q",
    });
    expect(result.content).toEqual({ error: "peer offline" });
  });
});

describe("respond_ask", () => {
  it("unblocks the asker with the caller stamped as the responder", async () => {
    const h = meshHarness();
    const result = await meshTool(h, "respond_ask").handler({
      request_id: "req_9",
      answer: "yes",
    });
    expect(h.mesh.respondAsk).toHaveBeenCalledWith("req_9", {
      request_id: "req_9",
      from_agent_id: "agent_x",
      answer: "yes",
    });
    expect(result.content).toEqual({ responded: true, request_id: "req_9" });
  });

  it("rejects a missing request_id or answer", async () => {
    const h = meshHarness();
    for (const input of [{}, { request_id: "req_9" }, { answer: "yes" }]) {
      const result = await meshTool(h, "respond_ask").handler(input);
      expect(result.isError).toBe(true);
      expect(result.content).toEqual({ error: "request_id and answer required" });
    }
    expect(h.mesh.respondAsk).not.toHaveBeenCalled();
  });

  // respondAsk is synchronous — an unknown request id throws straight
  // out of the mesh server rather than rejecting a promise.
  it("envelopes a throw from the mesh server", async () => {
    const h = meshHarness();
    h.mesh.respondAsk.mockImplementation(() => {
      throw new Error("no pending ask req_9");
    });
    const result = await meshTool(h, "respond_ask").handler({
      request_id: "req_9",
      answer: "yes",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "no pending ask req_9" });
  });
});

describe("negotiate", () => {
  it("forwards the proposal with the initiator's session id and optional task", async () => {
    const h = meshHarness();
    const result = await meshTool(h, "negotiate").handler({
      peer_id: "agent_b",
      proposal: "ship Monday",
      task_id: "task_7",
    });
    expect(h.mesh.sendNegotiate).toHaveBeenCalledWith(
      "agent_x",
      "agent_b",
      "ship Monday",
      { taskId: "task_7", initiatorSessionId: "ses_x" },
    );
    expect(result.content).toEqual({
      negotiation_id: "neg_1",
      from_agent_id: "agent_b",
      decision: "counter",
      message: "how about Tuesday",
      counter_proposal: "Tuesday",
    });
  });

  it("omits task_id when absent or blank", async () => {
    for (const task_id of [undefined, "", 7]) {
      const h = meshHarness();
      await meshTool(h, "negotiate").handler({
        peer_id: "agent_b",
        proposal: "p",
        task_id,
      });
      expect(h.mesh.sendNegotiate.mock.calls[0]?.[3]).toMatchObject({
        taskId: undefined,
      });
    }
  });

  it("rejects a missing peer_id or proposal", async () => {
    const h = meshHarness();
    for (const input of [{}, { peer_id: "agent_b" }, { proposal: "p" }]) {
      const result = await meshTool(h, "negotiate").handler(input);
      expect(result.isError).toBe(true);
      expect(result.content).toEqual({ error: "peer_id and proposal required" });
    }
    expect(h.mesh.sendNegotiate).not.toHaveBeenCalled();
  });

  // The escalated sentinel is a different shape entirely — the peer
  // escalated while we were blocked, and we must surface the escalation
  // id rather than a decision the agent would read as a real answer.
  it("projects the escalated sentinel instead of a decision", async () => {
    const h = meshHarness({
      sendNegotiate: () => ({
        decision: "escalated",
        escalation_id: "esc_3",
        negotiation_id: "neg_1",
        message: "peer escalated",
      }),
    });
    const result = await meshTool(h, "negotiate").handler({
      peer_id: "agent_b",
      proposal: "p",
    });
    expect(result.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_3",
      negotiation_id: "neg_1",
      message: "peer escalated",
    });
    expect(result.content.from_agent_id).toBeUndefined();
  });

  it("surfaces CANNOT_NEGOTIATE_WITH_IC with the offending agent id", async () => {
    const h = meshHarness({
      sendNegotiate: () => {
        throw new CannotNegotiateWithIcError({ agentId: "agent_ic" });
      },
    });
    const result = await meshTool(h, "negotiate").handler({
      peer_id: "agent_ic",
      proposal: "p",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "CANNOT_NEGOTIATE_WITH_IC",
      agentId: "agent_ic",
    });
  });
});

describe("respond_negotiate", () => {
  it("sends the round and reports terminal when the server returns null", async () => {
    const h = meshHarness({ respondNegotiate: () => null });
    const result = await meshTool(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "accept",
      message: "agreed",
    });
    expect(h.mesh.respondNegotiate).toHaveBeenCalledWith(
      "neg_1",
      {
        negotiation_id: "neg_1",
        from_agent_id: "agent_x",
        decision: "accept",
        message: "agreed",
        counter_proposal: undefined,
      },
      "ses_x",
    );
    expect(result.content).toEqual({
      negotiation_id: "neg_1",
      decision: "accept",
      terminal: true,
    });
  });

  it("projects the peer's next round when the negotiation continues", async () => {
    const h = meshHarness({
      respondNegotiate: () => ({
        negotiation_id: "neg_1",
        from_agent_id: "agent_b",
        decision: "counter",
        message: "Wednesday?",
        counter_proposal: "Wednesday",
      }),
    });
    const result = await meshTool(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "Tuesday?",
      counter_proposal: "Tuesday",
    });
    expect(result.content).toMatchObject({ decision: "counter", from_agent_id: "agent_b" });
  });

  it("rejects a missing negotiation_id or message", async () => {
    const h = meshHarness();
    for (const input of [
      { decision: "accept", message: "m" },
      { negotiation_id: "neg_1", decision: "accept" },
    ]) {
      const result = await meshTool(h, "respond_negotiate").handler(input);
      expect(result.isError).toBe(true);
      expect(result.content).toEqual({ error: "negotiation_id and message required" });
    }
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("rejects a decision outside counter/accept/reject", async () => {
    const h = meshHarness();
    for (const decision of [undefined, "", "maybe", "COUNTER"]) {
      const result = await meshTool(h, "respond_negotiate").handler({
        negotiation_id: "neg_1",
        decision,
        message: "m",
      });
      expect(result.isError, String(decision)).toBe(true);
      expect(String(result.content.error)).toContain("decision must be one of");
    }
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  // A counter with no alternative is a dead end: the peer is unblocked
  // with nothing to respond to, and the round is spent.
  it("requires counter_proposal when the decision is 'counter'", async () => {
    const h = meshHarness();
    const result = await meshTool(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "not this",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "counter_proposal required when decision='counter'",
    });
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("surfaces MAX_ROUNDS_EXCEEDED with its round counts", async () => {
    const h = meshHarness({
      respondNegotiate: () => {
        throw new MeshMaxRoundsError({
          negotiationId: "neg_1",
          rounds_completed: 5,
          max_rounds: 5,
        });
      },
    });
    const result = await meshTool(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "c",
    });
    expect(result.content).toMatchObject({
      error: "MAX_ROUNDS_EXCEEDED",
      rounds_completed: 5,
      max_rounds: 5,
    });
  });
});

describe("report_blocker", () => {
  it("marks the task blocked, then spawns the parent", async () => {
    const h = meshHarness();
    const result = await meshTool(h, "report_blocker").handler({
      task_id: "task_7",
      description: "no credentials for the staging DB",
    });

    expect(h.findParent).toHaveBeenCalledWith("agent_x");
    expect(h.markBlocked).toHaveBeenCalledWith(
      "task_7",
      "agent_x",
      "no credentials for the staging DB",
    );
    expect(h.mesh.reportBlocker).toHaveBeenCalledWith(
      "agent_parent",
      "agent_x",
      "task_7",
      "no credentials for the staging DB",
    );
    expect(result.content).toEqual({
      reported: true,
      parent_agent_id: "agent_parent",
      task_id: "task_7",
    });
  });

  // A top-level agent has nobody to report to; spawning nothing and
  // silently succeeding would strand the task in blocked forever.
  it("refuses for a top-level agent and leaves the task untouched", async () => {
    const h = meshHarness({ parent: null });
    const result = await meshTool(h, "report_blocker").handler({
      task_id: "task_7",
      description: "stuck",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "no_parent_to_block" });
    expect(h.markBlocked).not.toHaveBeenCalled();
    expect(h.mesh.reportBlocker).not.toHaveBeenCalled();
  });

  it("rejects a missing task_id or description before the parent lookup", async () => {
    const h = meshHarness();
    for (const input of [{}, { task_id: "task_7" }, { description: "stuck" }]) {
      const result = await meshTool(h, "report_blocker").handler(input);
      expect(result.isError).toBe(true);
      expect(result.content).toEqual({ error: "task_id and description required" });
    }
    expect(h.findParent).not.toHaveBeenCalled();
  });

  // The spawn is fire-and-forget, so if markBlocked fails the parent
  // must not be woken about a task that was never actually blocked.
  it("does not spawn the parent when markBlocked throws", async () => {
    const h = meshHarness({
      markBlocked: () => {
        throw new Error("task not found");
      },
    });
    const result = await meshTool(h, "report_blocker").handler({
      task_id: "task_missing",
      description: "stuck",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "task not found" });
    expect(h.mesh.reportBlocker).not.toHaveBeenCalled();
  });

  it("is available to IC agents too", async () => {
    const h = meshHarness();
    const ic = buildIcMeshTools(fakeCtx, h.services).find(
      (t) => t.name === "report_blocker",
    );
    const result = await ic?.handler({ task_id: "task_7", description: "stuck" });
    expect(result?.content).toMatchObject({ reported: true });
  });
});

describe("escalate_to_humans", () => {
  it("creates the escalation, unblocks the peer, then notifies listeners", async () => {
    const h = meshHarness();
    const result = await meshTool(h, "escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "We're stuck on the deploy window.",
      proposals: [{ title: "Monday", description: "ship Monday" }],
      open_questions: ["Is there a customer commitment?", 42],
    });

    expect(h.createEscalation).toHaveBeenCalledWith({
      negotiationId: "neg_1",
      callerAgentId: "agent_x",
      summary: "We're stuck on the deploy window.",
      proposals: [{ title: "Monday", description: "ship Monday" }],
      // Non-string entries are filtered out rather than reaching the DB.
      openQuestions: ["Is there a customer commitment?"],
    });
    expect(h.mesh.unblockOnEscalate).toHaveBeenCalledWith("neg_1", "esc_1");
    expect(h.query).toHaveBeenCalledWith(expect.stringContaining("pg_notify"), ["esc_1"]);
    expect(result.content).toEqual({
      escalation_id: "esc_1",
      status: "open",
      negotiation_id: "neg_1",
    });
  });

  it("omits proposals and open_questions when they are not arrays", async () => {
    const h = meshHarness();
    await meshTool(h, "escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "stuck",
      proposals: "Monday",
      open_questions: "anything?",
    });
    expect(h.createEscalation.mock.calls[0]?.[0]).toMatchObject({
      proposals: undefined,
      openQuestions: undefined,
    });
  });

  it("rejects a missing negotiation_id or summary", async () => {
    const h = meshHarness();
    for (const input of [{}, { negotiation_id: "neg_1" }, { summary: "stuck" }]) {
      const result = await meshTool(h, "escalate_to_humans").handler(input);
      expect(result.isError).toBe(true);
      expect(result.content).toEqual({ error: "negotiation_id and summary required" });
    }
    expect(h.createEscalation).not.toHaveBeenCalled();
  });

  // If the escalation row never landed there is nothing to unblock the
  // peer with — sending the sentinel anyway would point at a dead id.
  it("does not unblock the peer when the escalation insert fails", async () => {
    const h = meshHarness({
      createEscalation: () => {
        throw new Error("negotiation already escalated");
      },
    });
    const result = await meshTool(h, "escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "stuck",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "negotiation already escalated" });
    expect(h.mesh.unblockOnEscalate).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
  });
});
