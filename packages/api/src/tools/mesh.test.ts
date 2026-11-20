/**
 * Mesh tool tests — tier gating, plus each handler's own logic.
 *
 * The *flows* (blocking round-trips, session spawning, round counting)
 * need live Postgres and spawned CLI subprocesses, and the m6/m7 e2e
 * scripts cover them. What the handlers do before and after those calls
 * is plain code and is covered here: argument coercion, the required-
 * field guards, the decision enum check, `counter_proposal` being
 * mandatory only for `decision: "counter"`, the no-parent case in
 * report_blocker, the write ordering in report_blocker and
 * escalate_to_humans, and the two response projections — including the
 * `escalated` sentinel branch, which returns a different key set than a
 * normal negotiate reply.
 *
 * The error envelope matters as much as the happy path: every handler
 * funnels throws through `toolErrorFromThrown`, which preserves a
 * CodedMeshError's `code` + `meta` (so an agent can branch on
 * MAX_ROUNDS_EXCEEDED and read the round numbers) and flattens anything
 * else to `{ error: <message> }`.
 */
import { describe, expect, it, vi } from "vitest";
import type { ResolvedCaller } from "@beevibe/core/auth";
import type {
  Agent,
  AgentRepository,
  Task,
  TaskRepository,
} from "@beevibe/core";
import type { TaskService } from "@beevibe/core/services/task-service";
import type { EscalationService } from "@beevibe/core/services/escalation-service";
import type { Pool } from "@beevibe/core/adapters/postgres";
import {
  CannotNegotiateWithIcError,
  MeshMaxRoundsError,
} from "../mesh/types.js";
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

// ── Handler tests ────────────────────────────────────────────────────────

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
  /** Cross-service call order, for write-ordering assertions. */
  order: string[];
}

function meshHarness(
  opts: {
    parent?: Agent | null;
    sendAsk?: () => unknown;
    sendNegotiate?: () => unknown;
    respondNegotiate?: () => unknown;
    respondAsk?: () => unknown;
    markBlocked?: () => unknown;
    createEscalation?: () => unknown;
  } = {},
): MeshHarness {
  const order: string[] = [];
  const parent =
    opts.parent === undefined
      ? ({ id: "agent_parent" } as unknown as Agent)
      : opts.parent;

  const mesh = {
    sendAsk: vi.fn(async () =>
      opts.sendAsk
        ? opts.sendAsk()
        : {
            request_id: "req_1",
            from_agent_id: "agent_target",
            answer: "yes, feasible",
          },
    ),
    respondAsk: vi.fn(() => {
      if (opts.respondAsk) return opts.respondAsk();
      order.push("mesh.respondAsk");
      return undefined;
    }),
    sendNegotiate: vi.fn(async () =>
      opts.sendNegotiate
        ? opts.sendNegotiate()
        : {
            negotiation_id: "neg_1",
            from_agent_id: "agent_peer",
            decision: "counter",
            message: "how about this",
            counter_proposal: "do it in two phases",
          },
    ),
    respondNegotiate: vi.fn(async () =>
      opts.respondNegotiate
        ? opts.respondNegotiate()
        : {
            negotiation_id: "neg_1",
            from_agent_id: "agent_peer",
            decision: "accept",
            message: "agreed",
          },
    ),
    reportBlocker: vi.fn(() => {
      order.push("mesh.reportBlocker");
      return undefined;
    }),
    unblockOnEscalate: vi.fn(() => {
      order.push("mesh.unblockOnEscalate");
      return undefined;
    }),
  };

  const findParent = vi.fn(async () => parent);
  const markBlocked = vi.fn(async () => {
    order.push("taskService.markBlocked");
    if (opts.markBlocked) return opts.markBlocked();
    return {} as unknown as Task;
  });
  const createEscalation = vi.fn(async () => {
    order.push("escalation.create");
    if (opts.createEscalation) return opts.createEscalation();
    return { id: "esc_1", status: "open", negotiation_id: "neg_1" };
  });
  const query = vi.fn(async () => {
    order.push("pg_notify");
    return { rows: [] };
  });

  const services = {
    mesh: mesh as unknown as MeshServer,
    agentRepo: { findParent } as unknown as AgentRepository,
    taskRepo: {} as unknown as TaskRepository,
    taskService: { markBlocked } as unknown as TaskService,
    escalationService: {
      create: createEscalation,
    } as unknown as EscalationService,
    pool: { query } as unknown as Pool,
  };

  return {
    services,
    mesh,
    findParent,
    markBlocked,
    createEscalation,
    query,
    order,
  };
}

/** Pull one team-tier tool by name. */
function teamTool(h: MeshHarness, name: string) {
  const found = buildTeamMeshTools(fakeCtx, h.services).find(
    (t) => t.name === name,
  );
  if (!found) throw new Error(`no such mesh tool: ${name}`);
  return found;
}

describe("ask handler", () => {
  it("forwards the caller as asker and projects only the three wire fields", async () => {
    const h = meshHarness();
    const result = await teamTool(h, "ask").handler({
      target_agent_id: "agent_target",
      question: "is X feasible?",
    });

    expect(h.mesh.sendAsk).toHaveBeenCalledTimes(1);
    const [requestId, from, target, question] = h.mesh.sendAsk.mock.calls[0]!;
    // The request id is minted here, not supplied by the agent.
    expect(typeof requestId).toBe("string");
    expect(requestId).not.toHaveLength(0);
    expect(from).toBe("agent_x");
    expect(target).toBe("agent_target");
    expect(question).toBe("is X feasible?");

    expect(result.isError).toBeFalsy();
    // Exact, not a superset: the projection deliberately drops anything
    // else the server returns.
    expect(result.content).toEqual({
      request_id: "req_1",
      from_agent_id: "agent_target",
      answer: "yes, feasible",
    });
  });

  it("mints a fresh request id per call", async () => {
    const h = meshHarness();
    const t = teamTool(h, "ask");
    await t.handler({ target_agent_id: "a", question: "q" });
    await t.handler({ target_agent_id: "a", question: "q" });
    expect(h.mesh.sendAsk.mock.calls[0]![0]).not.toBe(
      h.mesh.sendAsk.mock.calls[1]![0],
    );
  });

  it.each([
    ["a missing target", { question: "q" }],
    ["an empty target", { target_agent_id: "", question: "q" }],
    ["a missing question", { target_agent_id: "a" }],
    ["an empty question", { target_agent_id: "a", question: "" }],
  ])("rejects %s without reaching the mesh", async (_label, input) => {
    const h = meshHarness();
    const result = await teamTool(h, "ask").handler(input);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "target_agent_id and question required",
    });
    expect(h.mesh.sendAsk).not.toHaveBeenCalled();
  });

  it("preserves a CodedMeshError's code and meta", async () => {
    const h = meshHarness({
      sendAsk: () => {
        throw new CannotNegotiateWithIcError({ agentId: "agent_ic" });
      },
    });

    const result = await teamTool(h, "ask").handler({
      target_agent_id: "agent_ic",
      question: "q",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "CANNOT_NEGOTIATE_WITH_IC",
      agentId: "agent_ic",
    });
  });

  it("flattens a plain Error to the catch-all envelope", async () => {
    const h = meshHarness({
      sendAsk: () => {
        throw new Error("target offline");
      },
    });

    const result = await teamTool(h, "ask").handler({
      target_agent_id: "a",
      question: "q",
    });

    // Note the shape difference from a coded error: the human message
    // lands in `error`, not `message`. That's the existing contract.
    expect(result.content).toEqual({ error: "target offline" });
  });
});

describe("respond_ask handler", () => {
  it("stamps the caller as responder and reports the request id back", async () => {
    const h = meshHarness();
    const result = await teamTool(h, "respond_ask").handler({
      request_id: "req_1",
      answer: "here is the context",
    });

    expect(h.mesh.respondAsk).toHaveBeenCalledWith("req_1", {
      request_id: "req_1",
      from_agent_id: "agent_x",
      answer: "here is the context",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ responded: true, request_id: "req_1" });
  });

  it.each([
    ["a missing request_id", { answer: "a" }],
    ["an empty request_id", { request_id: "", answer: "a" }],
    ["a missing answer", { request_id: "req_1" }],
    ["an empty answer", { request_id: "req_1", answer: "" }],
  ])("rejects %s", async (_label, input) => {
    const h = meshHarness();
    const result = await teamTool(h, "respond_ask").handler(input);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "request_id and answer required",
    });
    expect(h.mesh.respondAsk).not.toHaveBeenCalled();
  });

  it("envelopes a throw from the synchronous resolver", async () => {
    const h = meshHarness({
      respondAsk: () => {
        throw new Error("no pending ask with that id");
      },
    });
    const result = await teamTool(h, "respond_ask").handler({
      request_id: "req_gone",
      answer: "a",
    });
    expect(result.content).toEqual({ error: "no pending ask with that id" });
  });
});

describe("negotiate handler", () => {
  it("passes the task id and initiator session as options", async () => {
    const h = meshHarness();
    const result = await teamTool(h, "negotiate").handler({
      peer_id: "agent_peer",
      proposal: "ship behind a flag",
      task_id: "task_7",
    });

    expect(h.mesh.sendNegotiate).toHaveBeenCalledWith(
      "agent_x",
      "agent_peer",
      "ship behind a flag",
      { taskId: "task_7", initiatorSessionId: "ses_x" },
    );
    expect(result.content).toMatchObject({
      negotiation_id: "neg_1",
      decision: "counter",
      counter_proposal: "do it in two phases",
    });
  });

  it.each([
    ["omitted", {}],
    ["an empty string", { task_id: "" }],
    ["a non-string", { task_id: 9 }],
  ])("sends taskId undefined when task_id is %s", async (_label, extra) => {
    const h = meshHarness();
    await teamTool(h, "negotiate").handler({
      peer_id: "agent_peer",
      proposal: "p",
      ...extra,
    });
    expect(h.mesh.sendNegotiate.mock.calls[0]![3]).toEqual({
      taskId: undefined,
      initiatorSessionId: "ses_x",
    });
  });

  it.each([
    ["a missing peer_id", { proposal: "p" }],
    ["an empty peer_id", { peer_id: "", proposal: "p" }],
    ["a missing proposal", { peer_id: "a" }],
    ["an empty proposal", { peer_id: "a", proposal: "" }],
  ])("rejects %s", async (_label, input) => {
    const h = meshHarness();
    const result = await teamTool(h, "negotiate").handler(input);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "peer_id and proposal required" });
    expect(h.mesh.sendNegotiate).not.toHaveBeenCalled();
  });

  it("projects the escalated sentinel as its own key set", async () => {
    // A sentinel carries escalation_id and omits from_agent_id /
    // counter_proposal — a different shape than a normal reply.
    const h = meshHarness({
      sendNegotiate: () => ({
        decision: "escalated",
        message: "peer escalated to humans",
        escalation_id: "esc_9",
        negotiation_id: "neg_1",
      }),
    });

    const result = await teamTool(h, "negotiate").handler({
      peer_id: "agent_peer",
      proposal: "p",
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_9",
      negotiation_id: "neg_1",
      message: "peer escalated to humans",
    });
  });

  it("surfaces MAX_ROUNDS_EXCEEDED with the round counts intact", async () => {
    const h = meshHarness({
      sendNegotiate: () => {
        throw new MeshMaxRoundsError({
          negotiationId: "neg_1",
          rounds_completed: 5,
          max_rounds: 5,
        });
      },
    });

    const result = await teamTool(h, "negotiate").handler({
      peer_id: "agent_peer",
      proposal: "p",
    });

    expect(result.isError).toBe(true);
    // The agent is told to call escalate_to_humans next, so it needs the
    // code and the numbers, not just prose.
    expect(result.content).toMatchObject({
      error: "MAX_ROUNDS_EXCEEDED",
      negotiationId: "neg_1",
      rounds_completed: 5,
      max_rounds: 5,
    });
  });
});

describe("respond_negotiate handler", () => {
  it("omits the round number — the server derives it", async () => {
    const h = meshHarness();
    await teamTool(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "not quite",
      counter_proposal: "try this",
    });

    expect(h.mesh.respondNegotiate).toHaveBeenCalledWith(
      "neg_1",
      {
        negotiation_id: "neg_1",
        from_agent_id: "agent_x",
        decision: "counter",
        message: "not quite",
        counter_proposal: "try this",
      },
      "ses_x",
    );
  });

  it("projects the peer's continuation reply", async () => {
    const h = meshHarness();
    const result = await teamTool(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "c",
    });
    expect(result.content).toMatchObject({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "accept",
    });
  });

  it("reports terminal:true when the server returns null", async () => {
    // accept / reject end the negotiation; there is no peer reply to wait
    // for, and the handler echoes the caller's own decision back.
    const h = meshHarness({ respondNegotiate: () => null });

    const result = await teamTool(h, "respond_negotiate").handler({
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

  it.each(["accept", "reject"])(
    "does not require counter_proposal for decision=%s",
    async (decision) => {
      const h = meshHarness({ respondNegotiate: () => null });
      const result = await teamTool(h, "respond_negotiate").handler({
        negotiation_id: "neg_1",
        decision,
        message: "done",
      });
      expect(result.isError).toBeFalsy();
    },
  );

  it("requires counter_proposal when decision=counter", async () => {
    const h = meshHarness();
    const result = await teamTool(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "not quite",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "counter_proposal required when decision='counter'",
    });
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("treats an empty counter_proposal as absent", async () => {
    const h = meshHarness();
    const result = await teamTool(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "counter_proposal required when decision='counter'",
    });
  });

  it.each([
    ["an unknown decision", "maybe"],
    ["a missing decision", undefined],
  ])("rejects %s with the allowed values listed", async (_label, decision) => {
    const h = meshHarness();
    const result = await teamTool(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision,
      message: "m",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "decision must be one of: counter, accept, reject",
    });
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing negotiation_id", { decision: "accept", message: "m" }],
    [
      "an empty negotiation_id",
      { negotiation_id: "", decision: "accept", message: "m" },
    ],
    ["a missing message", { negotiation_id: "neg_1", decision: "accept" }],
    [
      "an empty message",
      { negotiation_id: "neg_1", decision: "accept", message: "" },
    ],
  ])("rejects %s", async (_label, input) => {
    const h = meshHarness();
    const result = await teamTool(h, "respond_negotiate").handler(input);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "negotiation_id and message required",
    });
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("checks the id/message guard before the decision enum", async () => {
    // Both guards can match at once; pinning precedence keeps the
    // agent-facing diagnostic stable.
    const h = meshHarness();
    const result = await teamTool(h, "respond_negotiate").handler({
      decision: "bogus",
      message: "",
    });
    expect(result.content).toEqual({
      error: "negotiation_id and message required",
    });
  });

  it("surfaces the escalated sentinel to a blocked responder", async () => {
    const h = meshHarness({
      respondNegotiate: () => ({
        decision: "escalated",
        message: "peer escalated",
        escalation_id: "esc_9",
        negotiation_id: "neg_1",
      }),
    });

    const result = await teamTool(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "c",
    });

    expect(result.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_9",
      negotiation_id: "neg_1",
      message: "peer escalated",
    });
  });

  it("envelopes a thrown max-rounds error", async () => {
    const h = meshHarness({
      respondNegotiate: () => {
        throw new MeshMaxRoundsError({
          negotiationId: "neg_1",
          rounds_completed: 5,
          max_rounds: 5,
        });
      },
    });
    const result = await teamTool(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "c",
    });
    expect(result.content).toMatchObject({ error: "MAX_ROUNDS_EXCEEDED" });
  });
});

describe("report_blocker handler", () => {
  it("marks the task blocked before spawning the parent", async () => {
    const h = meshHarness();
    const result = await teamTool(h, "report_blocker").handler({
      task_id: "task_7",
      description: "the API key is missing",
    });

    expect(h.findParent).toHaveBeenCalledWith("agent_x");
    expect(h.markBlocked).toHaveBeenCalledWith(
      "task_7",
      "agent_x",
      "the API key is missing",
    );
    // The parent's session must not start before the task row shows the
    // blocked state it's being spawned to investigate.
    expect(h.order).toEqual([
      "taskService.markBlocked",
      "mesh.reportBlocker",
    ]);
    expect(h.mesh.reportBlocker).toHaveBeenCalledWith(
      "agent_parent",
      "agent_x",
      "task_7",
      "the API key is missing",
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      reported: true,
      parent_agent_id: "agent_parent",
      task_id: "task_7",
    });
  });

  it("refuses for a top-level agent and points at the alternatives", async () => {
    const h = meshHarness({ parent: null });

    const result = await teamTool(h, "report_blocker").handler({
      task_id: "task_7",
      description: "stuck",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "no_parent_to_block" });
    expect(
      String((result.content as { message: string }).message),
    ).toContain("escalate_to_humans");
    // The task is left alone — nothing was marked blocked.
    expect(h.markBlocked).not.toHaveBeenCalled();
    expect(h.mesh.reportBlocker).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing task_id", { description: "d" }],
    ["an empty task_id", { task_id: "", description: "d" }],
    ["a missing description", { task_id: "task_7" }],
    ["an empty description", { task_id: "task_7", description: "" }],
  ])("rejects %s before the parent lookup", async (_label, input) => {
    const h = meshHarness();
    const result = await teamTool(h, "report_blocker").handler(input);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "task_id and description required",
    });
    expect(h.findParent).not.toHaveBeenCalled();
  });

  it("does not spawn the parent when markBlocked throws", async () => {
    const h = meshHarness({
      markBlocked: () => {
        throw new Error("task not found");
      },
    });

    const result = await teamTool(h, "report_blocker").handler({
      task_id: "task_gone",
      description: "d",
    });

    expect(result.content).toEqual({ error: "task not found" });
    expect(h.mesh.reportBlocker).not.toHaveBeenCalled();
  });
});

describe("escalate_to_humans handler", () => {
  it("creates the escalation, unblocks the peer, then notifies", async () => {
    const h = meshHarness();
    const result = await teamTool(h, "escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "We're stuck on X; root disagreement is Y.",
      proposals: [{ title: "A", description: "do A" }],
      open_questions: ["which budget?"],
    });

    expect(h.createEscalation).toHaveBeenCalledWith({
      negotiationId: "neg_1",
      callerAgentId: "agent_x",
      summary: "We're stuck on X; root disagreement is Y.",
      proposals: [{ title: "A", description: "do A" }],
      openQuestions: ["which budget?"],
    });
    // The peer can only call add_to_escalation once the row exists, and
    // subscribers must not be notified before it does either.
    expect(h.order).toEqual([
      "escalation.create",
      "mesh.unblockOnEscalate",
      "pg_notify",
    ]);
    expect(h.mesh.unblockOnEscalate).toHaveBeenCalledWith("neg_1", "esc_1");
    expect(h.query).toHaveBeenCalledWith(
      expect.stringContaining("pg_notify('escalation_created'"),
      ["esc_1"],
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      escalation_id: "esc_1",
      status: "open",
      negotiation_id: "neg_1",
    });
  });

  it.each([
    ["omitted", {}],
    ["not an array", { proposals: "A then B", open_questions: "which?" }],
  ])(
    "sends undefined for proposals / open_questions when %s",
    async (_label, extra) => {
      const h = meshHarness();
      await teamTool(h, "escalate_to_humans").handler({
        negotiation_id: "neg_1",
        summary: "s",
        ...extra,
      });
      expect(h.createEscalation.mock.calls[0]![0]).toMatchObject({
        proposals: undefined,
        openQuestions: undefined,
      });
    },
  );

  it("filters non-string open_questions", async () => {
    const h = meshHarness();
    await teamTool(h, "escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "s",
      open_questions: ["real question", 42, null, "another"],
    });
    expect(h.createEscalation.mock.calls[0]![0]).toMatchObject({
      openQuestions: ["real question", "another"],
    });
  });

  it.each([
    ["a missing negotiation_id", { summary: "s" }],
    ["an empty negotiation_id", { negotiation_id: "", summary: "s" }],
    ["a missing summary", { negotiation_id: "neg_1" }],
    ["an empty summary", { negotiation_id: "neg_1", summary: "" }],
  ])("rejects %s", async (_label, input) => {
    const h = meshHarness();
    const result = await teamTool(h, "escalate_to_humans").handler(input);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "negotiation_id and summary required",
    });
    expect(h.createEscalation).not.toHaveBeenCalled();
  });

  it("leaves the peer blocked and unnotified when create throws", async () => {
    const h = meshHarness({
      createEscalation: () => {
        throw new Error("negotiation neg_1 already has an escalation");
      },
    });

    const result = await teamTool(h, "escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "s",
    });

    expect(result.content).toEqual({
      error: "negotiation neg_1 already has an escalation",
    });
    expect(h.mesh.unblockOnEscalate).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
  });
});

describe("IC-tier handlers share the team implementations", () => {
  it("wires respond_ask and report_blocker to the same services", async () => {
    const h = meshHarness();
    const icTools = buildIcMeshTools(
      { caller: { ...fakeCaller, hierarchyLevel: "ic" }, beevibeSid: "ses_ic" },
      h.services,
    );

    const respondAsk = icTools.find((t) => t.name === "respond_ask")!;
    await respondAsk.handler({ request_id: "req_1", answer: "a" });
    expect(h.mesh.respondAsk).toHaveBeenCalledWith("req_1", {
      request_id: "req_1",
      from_agent_id: "agent_x",
      answer: "a",
    });

    const reportBlocker = icTools.find((t) => t.name === "report_blocker")!;
    const result = await reportBlocker.handler({
      task_id: "task_7",
      description: "blocked on creds",
    });
    expect(result.content).toMatchObject({
      reported: true,
      parent_agent_id: "agent_parent",
    });
  });
});
