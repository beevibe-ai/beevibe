/**
 * Mesh tool tests — tier gating plus per-handler behavior.
 *
 * The tier inventory below locks the exact tool *names* each tier gets,
 * so future skill-loader work can rely on the surface being stable.
 *
 * The handler suites run against fakes rather than the live mesh: the
 * m6/m7 e2e scripts still own the real blocking/spawn semantics (they
 * need Postgres + spawned CLI subprocesses), but the argument coercion,
 * the required-field guards, and the projection of mesh responses onto
 * the wire shape are plain functions and are pinned here.
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentRepository, TaskRepository } from "@beevibe/core";
import type { EscalationService } from "@beevibe/core/services/escalation-service";
import type { TaskService } from "@beevibe/core/services/task-service";
import type { Pool } from "@beevibe/core/adapters/postgres";
import type { ResolvedCaller } from "@beevibe/core/auth";
import { MeshMaxRoundsError } from "../mesh/types.js";
import type { MeshServer } from "../mesh/server.js";
import { buildIcMeshTools, buildTeamMeshTools, type MeshToolServices } from "./mesh.js";

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

// ── Handler suites ───────────────────────────────────────────────────────

interface MeshHarness {
  services: MeshToolServices;
  mesh: Record<string, ReturnType<typeof vi.fn>>;
  queries: Array<{ sql: string; params: unknown[] }>;
  markBlocked: ReturnType<typeof vi.fn>;
  escalationCreate: ReturnType<typeof vi.fn>;
}

function meshHarness(
  overrides: {
    ask?: unknown;
    negotiate?: unknown;
    respondNegotiate?: unknown;
    parent?: { id: string } | null;
    escalation?: Record<string, unknown>;
    throws?: unknown;
  } = {},
): MeshHarness {
  const maybeThrow = () => {
    if (overrides.throws) throw overrides.throws;
  };

  const mesh = {
    sendAsk: vi.fn(async () => {
      maybeThrow();
      return (
        overrides.ask ?? {
          request_id: "req_1",
          from_agent_id: "agent_target",
          answer: "yes, feasible",
        }
      );
    }),
    respondAsk: vi.fn(() => {
      maybeThrow();
    }),
    sendNegotiate: vi.fn(async () => {
      maybeThrow();
      return (
        overrides.negotiate ?? {
          negotiation_id: "neg_1",
          from_agent_id: "agent_peer",
          decision: "counter",
          message: "how about Thursday",
          counter_proposal: "ship Thursday",
        }
      );
    }),
    respondNegotiate: vi.fn(async () => {
      maybeThrow();
      return overrides.respondNegotiate === undefined ? null : overrides.respondNegotiate;
    }),
    reportBlocker: vi.fn(() => {
      maybeThrow();
    }),
    unblockOnEscalate: vi.fn(),
  };

  const parent = overrides.parent === undefined ? { id: "agent_parent" } : overrides.parent;
  const agentRepo = {
    findParent: vi.fn(async () => {
      maybeThrow();
      return parent;
    }),
  } as unknown as AgentRepository;

  const markBlocked = vi.fn(async () => {
    maybeThrow();
  });
  const taskService = { markBlocked } as unknown as TaskService;

  const escalationCreate = vi.fn(async () => {
    maybeThrow();
    return (
      overrides.escalation ?? {
        id: "esc_1",
        status: "open",
        negotiation_id: "neg_1",
      }
    );
  });
  const escalationService = {
    create: escalationCreate,
  } as unknown as EscalationService;

  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      return { rows: [] };
    }),
  } as unknown as Pool;

  return {
    services: {
      mesh: mesh as unknown as MeshServer,
      agentRepo,
      taskRepo: {} as unknown as TaskRepository,
      taskService,
      escalationService,
      pool,
    },
    mesh,
    queries,
    markBlocked,
    escalationCreate,
  };
}

function meshTool(h: MeshHarness, name: string) {
  const tool = buildTeamMeshTools(fakeCtx, h.services).find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not built`);
  return tool;
}

describe("ask", () => {
  it("sends the question from the caller with a fresh request id", async () => {
    const h = meshHarness();
    await meshTool(h, "ask").handler({
      target_agent_id: "agent_target",
      question: "is X feasible?",
    });

    const [requestId, from, to, question] = h.mesh.sendAsk!.mock.calls[0]!;
    // A v4 UUID, minted per call so two asks never collide on the resolver.
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect([from, to, question]).toEqual(["agent_x", "agent_target", "is X feasible?"]);
  });

  it("mints a distinct request id per call", async () => {
    const h = meshHarness();
    const tool = meshTool(h, "ask");
    await tool.handler({ target_agent_id: "a", question: "q" });
    await tool.handler({ target_agent_id: "a", question: "q" });

    expect(h.mesh.sendAsk!.mock.calls[0]![0]).not.toBe(h.mesh.sendAsk!.mock.calls[1]![0]);
  });

  // The responder's session carries more than the answer; the asker sees
  // only these three fields.
  it("projects the response down to request_id, from_agent_id and answer", async () => {
    const h = meshHarness({
      ask: {
        request_id: "req_1",
        from_agent_id: "agent_target",
        answer: "yes",
        internal_session_id: "sess_secret",
      },
    });
    const result = await meshTool(h, "ask").handler({
      target_agent_id: "agent_target",
      question: "q",
    });

    expect(result.content).toEqual({
      request_id: "req_1",
      from_agent_id: "agent_target",
      answer: "yes",
    });
  });

  it.each([
    ["target_agent_id", { question: "q" }],
    ["question", { target_agent_id: "agent_target" }],
    ["both", {}],
  ])("errors when %s is missing, without spawning the target", async (_l, input) => {
    const h = meshHarness();
    const result = await meshTool(h, "ask").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "target_agent_id and question required",
    });
    expect(h.mesh.sendAsk).not.toHaveBeenCalled();
  });

  it("surfaces a coded mesh error with its code and meta intact", async () => {
    const err = new MeshMaxRoundsError({
      negotiationId: "neg_1",
      rounds_completed: 5,
      max_rounds: 5,
    });
    const h = meshHarness({ throws: err });
    const result = await meshTool(h, "ask").handler({
      target_agent_id: "agent_target",
      question: "q",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "MAX_ROUNDS_EXCEEDED",
      negotiationId: "neg_1",
      max_rounds: 5,
    });
  });

  it("degrades a plain throw to the catch-all envelope", async () => {
    const h = meshHarness({ throws: new Error("target offline") });
    const result = await meshTool(h, "ask").handler({
      target_agent_id: "agent_target",
      question: "q",
    });

    expect(result.content).toEqual({ error: "target offline" });
  });
});

describe("respond_ask", () => {
  it("delivers the answer stamped with the responding agent", async () => {
    const h = meshHarness();
    const result = await meshTool(h, "respond_ask").handler({
      request_id: "req_1",
      answer: "yes",
    });

    expect(h.mesh.respondAsk).toHaveBeenCalledWith("req_1", {
      request_id: "req_1",
      from_agent_id: "agent_x",
      answer: "yes",
    });
    expect(result.content).toEqual({ responded: true, request_id: "req_1" });
  });

  it.each([
    ["request_id", { answer: "yes" }],
    ["answer", { request_id: "req_1" }],
  ])("errors when %s is missing", async (_label, input) => {
    const h = meshHarness();
    const result = await meshTool(h, "respond_ask").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "request_id and answer required",
    });
    expect(h.mesh.respondAsk).not.toHaveBeenCalled();
  });

  it("envelopes a throw from the resolver", async () => {
    const h = meshHarness({ throws: new Error("no such request") });
    const result = await meshTool(h, "respond_ask").handler({
      request_id: "req_1",
      answer: "yes",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "no such request" });
  });
});

describe("negotiate", () => {
  it("passes the caller's session id as the initiator session", async () => {
    const h = meshHarness();
    await meshTool(h, "negotiate").handler({
      peer_id: "agent_peer",
      proposal: "ship Monday",
      task_id: "task_1",
    });

    expect(h.mesh.sendNegotiate).toHaveBeenCalledWith("agent_x", "agent_peer", "ship Monday", {
      taskId: "task_1",
      initiatorSessionId: "ses_x",
    });
  });

  it("omits task_id when absent or blank", async () => {
    const h = meshHarness();
    const tool = meshTool(h, "negotiate");
    await tool.handler({ peer_id: "agent_peer", proposal: "p" });
    await tool.handler({ peer_id: "agent_peer", proposal: "p", task_id: "" });

    for (const call of h.mesh.sendNegotiate!.mock.calls) {
      expect(call[3]).toMatchObject({ taskId: undefined });
    }
  });

  it("projects a counter response onto the wire shape", async () => {
    const h = meshHarness();
    const result = await meshTool(h, "negotiate").handler({
      peer_id: "agent_peer",
      proposal: "ship Monday",
    });

    expect(result.content).toEqual({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "counter",
      message: "how about Thursday",
      counter_proposal: "ship Thursday",
    });
  });

  // The escalated sentinel is a different shape entirely — no
  // from_agent_id, an escalation_id instead — so it gets its own branch.
  it("projects the escalated sentinel with its escalation id", async () => {
    const h = meshHarness({
      negotiate: {
        decision: "escalated",
        escalation_id: "esc_1",
        negotiation_id: "neg_1",
        message: "handed to humans",
      },
    });
    const result = await meshTool(h, "negotiate").handler({
      peer_id: "agent_peer",
      proposal: "p",
    });

    expect(result.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_1",
      negotiation_id: "neg_1",
      message: "handed to humans",
    });
  });

  it.each([
    ["peer_id", { proposal: "p" }],
    ["proposal", { peer_id: "agent_peer" }],
  ])("errors when %s is missing", async (_label, input) => {
    const h = meshHarness();
    const result = await meshTool(h, "negotiate").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "peer_id and proposal required" });
    expect(h.mesh.sendNegotiate).not.toHaveBeenCalled();
  });

  it("surfaces the IC guardrail's code", async () => {
    const h = meshHarness({ throws: new Error("target agent not found: agent_peer") });
    const result = await meshTool(h, "negotiate").handler({
      peer_id: "agent_peer",
      proposal: "p",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "target agent not found: agent_peer" });
  });
});

describe("respond_negotiate", () => {
  it("sends the round stamped with the caller and their session", async () => {
    const h = meshHarness({
      respondNegotiate: {
        negotiation_id: "neg_1",
        from_agent_id: "agent_peer",
        decision: "counter",
        message: "ok but Friday",
        counter_proposal: "ship Friday",
      },
    });
    await meshTool(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "how about Thursday",
      counter_proposal: "ship Thursday",
    });

    expect(h.mesh.respondNegotiate).toHaveBeenCalledWith(
      "neg_1",
      {
        negotiation_id: "neg_1",
        from_agent_id: "agent_x",
        decision: "counter",
        message: "how about Thursday",
        counter_proposal: "ship Thursday",
      },
      "ses_x",
    );
  });

  // A null return means accept/reject landed and nobody is waiting on the
  // other side — the tool has to tell the agent to stop, not hand back an
  // empty projection.
  it.each(["accept", "reject"])(
    "reports terminal=true when %s ends the negotiation",
    async (decision) => {
      const h = meshHarness({ respondNegotiate: null });
      const result = await meshTool(h, "respond_negotiate").handler({
        negotiation_id: "neg_1",
        decision,
        message: "agreed",
      });

      expect(result.isError).toBeFalsy();
      expect(result.content).toEqual({
        negotiation_id: "neg_1",
        decision,
        terminal: true,
      });
    },
  );

  it("projects the peer's next round when the negotiation continues", async () => {
    const h = meshHarness({
      respondNegotiate: {
        negotiation_id: "neg_1",
        from_agent_id: "agent_peer",
        decision: "counter",
        message: "ok but Friday",
        counter_proposal: "ship Friday",
      },
    });
    const result = await meshTool(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "how about Thursday",
      counter_proposal: "ship Thursday",
    });

    expect(result.content).toMatchObject({
      from_agent_id: "agent_peer",
      counter_proposal: "ship Friday",
    });
  });

  it("projects an escalated sentinel returned mid-round", async () => {
    const h = meshHarness({
      respondNegotiate: {
        decision: "escalated",
        escalation_id: "esc_1",
        negotiation_id: "neg_1",
        message: "peer escalated",
      },
    });
    const result = await meshTool(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "accept",
      message: "fine",
    });

    expect(result.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_1",
      negotiation_id: "neg_1",
      message: "peer escalated",
    });
  });

  it.each([
    ["negotiation_id", { decision: "accept", message: "m" }],
    ["message", { negotiation_id: "neg_1", decision: "accept" }],
  ])("errors when %s is missing", async (_label, input) => {
    const h = meshHarness();
    const result = await meshTool(h, "respond_negotiate").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "negotiation_id and message required",
    });
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("rejects a decision outside counter/accept/reject", async () => {
    const h = meshHarness();
    const result = await meshTool(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "maybe",
      message: "m",
    });

    expect(result.isError).toBe(true);
    expect(String((result.content as Record<string, unknown>).error)).toContain(
      "decision must be one of",
    );
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  // A counter with no alternative leaves the peer nothing to respond to,
  // so it is caught here rather than round-tripping through the server.
  it("requires counter_proposal when the decision is counter", async () => {
    const h = meshHarness();
    const result = await meshTool(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "counter_proposal required when decision='counter'",
    });
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("does not require counter_proposal for accept or reject", async () => {
    const h = meshHarness({ respondNegotiate: null });
    const result = await meshTool(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "accept",
      message: "m",
    });

    expect(result.isError).toBeFalsy();
  });

  it("surfaces max_rounds_exceeded with its meta so the agent can escalate", async () => {
    const h = meshHarness({
      throws: new MeshMaxRoundsError({
        negotiationId: "neg_1",
        rounds_completed: 5,
        max_rounds: 5,
      }),
    });
    const result = await meshTool(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "accept",
      message: "m",
    });

    expect(result.isError).toBe(true);
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
      task_id: "task_1",
      description: "the API key is missing",
    });

    expect(h.markBlocked).toHaveBeenCalledWith("task_1", "agent_x", "the API key is missing");
    expect(h.mesh.reportBlocker).toHaveBeenCalledWith(
      "agent_parent",
      "agent_x",
      "task_1",
      "the API key is missing",
    );
    expect(result.content).toEqual({
      reported: true,
      parent_agent_id: "agent_parent",
      task_id: "task_1",
    });
  });

  // A top-level agent has nowhere to escalate to; blocking the task with
  // nobody spawned to unblock it would strand the work.
  it("refuses for a top-level agent and leaves the task alone", async () => {
    const h = meshHarness({ parent: null });
    const result = await meshTool(h, "report_blocker").handler({
      task_id: "task_1",
      description: "stuck",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "no_parent_to_block" });
    expect(h.markBlocked).not.toHaveBeenCalled();
    expect(h.mesh.reportBlocker).not.toHaveBeenCalled();
  });

  it.each([
    ["task_id", { description: "stuck" }],
    ["description", { task_id: "task_1" }],
  ])("errors when %s is missing, before the parent lookup", async (_l, input) => {
    const h = meshHarness();
    const result = await meshTool(h, "report_blocker").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "task_id and description required",
    });
    expect(h.services.agentRepo.findParent).not.toHaveBeenCalled();
  });

  it("envelopes a throw from markBlocked", async () => {
    const h = meshHarness({ throws: new Error("task not found") });
    const result = await meshTool(h, "report_blocker").handler({
      task_id: "task_1",
      description: "stuck",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "task not found" });
  });
});

describe("escalate_to_humans", () => {
  it("creates the escalation, unblocks the peer, and notifies listeners", async () => {
    const h = meshHarness();
    const result = await meshTool(h, "escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "We're stuck on the deploy window",
      proposals: [{ title: "Ship Monday", description: "cut scope" }],
      open_questions: ["Is the Friday freeze hard?"],
    });

    expect(h.escalationCreate).toHaveBeenCalledWith({
      negotiationId: "neg_1",
      callerAgentId: "agent_x",
      summary: "We're stuck on the deploy window",
      proposals: [{ title: "Ship Monday", description: "cut scope" }],
      openQuestions: ["Is the Friday freeze hard?"],
    });
    expect(h.mesh.unblockOnEscalate).toHaveBeenCalledWith("neg_1", "esc_1");
    expect(h.queries[0]?.sql).toContain("pg_notify('escalation_created'");
    expect(h.queries[0]?.params).toEqual(["esc_1"]);
    expect(result.content).toEqual({
      escalation_id: "esc_1",
      status: "open",
      negotiation_id: "neg_1",
    });
  });

  it("unblocks the peer before notifying — the peer is the one waiting", async () => {
    const h = meshHarness();
    await meshTool(h, "escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "stuck",
    });

    const unblockOrder = h.mesh.unblockOnEscalate!.mock.invocationCallOrder[0]!;
    const notifyOrder = (h.services.pool.query as unknown as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0]!;
    expect(unblockOrder).toBeLessThan(notifyOrder);
  });

  it.each([
    ["proposals is not an array", { proposals: "one option" }],
    ["proposals is omitted", {}],
  ])("passes proposals as undefined when %s", async (_label, extra) => {
    const h = meshHarness();
    await meshTool(h, "escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "stuck",
      ...extra,
    });

    expect(h.escalationCreate.mock.calls[0]![0]).toMatchObject({
      proposals: undefined,
    });
  });

  it("drops non-string open questions", async () => {
    const h = meshHarness();
    await meshTool(h, "escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "stuck",
      open_questions: ["real question", 42, null, "another"],
    });

    expect(h.escalationCreate.mock.calls[0]![0]).toMatchObject({
      openQuestions: ["real question", "another"],
    });
  });

  it.each([
    ["negotiation_id", { summary: "stuck" }],
    ["summary", { negotiation_id: "neg_1" }],
  ])("errors when %s is missing", async (_label, input) => {
    const h = meshHarness();
    const result = await meshTool(h, "escalate_to_humans").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "negotiation_id and summary required",
    });
    expect(h.escalationCreate).not.toHaveBeenCalled();
  });

  it("envelopes a throw from the escalation service", async () => {
    const h = meshHarness({ throws: new Error("negotiation already escalated") });
    const result = await meshTool(h, "escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "stuck",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "negotiation already escalated" });
    expect(h.mesh.unblockOnEscalate).not.toHaveBeenCalled();
  });
});

// ICs share respond_ask + report_blocker with the team tier; the handlers
// are the same closures, so one behavioral check each is enough to prove
// the IC-tier build wires them to the same services.
describe("IC-tier handlers", () => {
  it("respond_ask delivers as the IC caller", async () => {
    const h = meshHarness();
    const icCtx = {
      caller: { ...fakeCaller, agentId: "agent_ic", hierarchyLevel: "ic" as const },
      beevibeSid: "ses_ic",
    };
    const tool = buildIcMeshTools(icCtx, h.services).find((t) => t.name === "respond_ask")!;
    await tool.handler({ request_id: "req_1", answer: "done" });

    expect(h.mesh.respondAsk).toHaveBeenCalledWith("req_1", {
      request_id: "req_1",
      from_agent_id: "agent_ic",
      answer: "done",
    });
  });

  it("report_blocker escalates to the IC's parent", async () => {
    const h = meshHarness();
    const icCtx = {
      caller: { ...fakeCaller, agentId: "agent_ic", hierarchyLevel: "ic" as const },
      beevibeSid: "ses_ic",
    };
    const tool = buildIcMeshTools(icCtx, h.services).find((t) => t.name === "report_blocker")!;
    const result = await tool.handler({ task_id: "task_1", description: "stuck" });

    expect(result.content).toMatchObject({ parent_agent_id: "agent_parent" });
    expect(h.markBlocked).toHaveBeenCalledWith("task_1", "agent_ic", "stuck");
  });
});
