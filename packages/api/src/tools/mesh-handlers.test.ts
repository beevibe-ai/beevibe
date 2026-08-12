/**
 * Mesh tool *handler* tests — validation, delegation and error mapping.
 *
 * Complements mesh.test.ts, which locks the per-tier tool inventory. The
 * handlers are pure adapters over MeshServer / TaskService /
 * EscalationService, so faking those four dependencies exercises every
 * branch without the live Postgres + spawned CLI subprocesses the m6/m7
 * e2e scripts need.
 */
import { describe, expect, it, vi } from "vitest";
import type { ResolvedCaller } from "@beevibe/core/auth";
import type { Agent, AgentRepository, TaskRepository } from "@beevibe/core";
import type { TaskService } from "@beevibe/core/services/task-service";
import type { EscalationService } from "@beevibe/core/services/escalation-service";
import type { Pool } from "@beevibe/core/adapters/postgres";
import { MeshCapacityError } from "../mesh/types.js";
import type { MeshServer } from "../mesh/server.js";
import {
  buildTeamMeshTools,
  type MeshToolContext,
  type MeshToolServices,
} from "./mesh.js";

type Impls = Partial<{
  sendAsk: (...a: unknown[]) => unknown;
  respondAsk: (...a: unknown[]) => unknown;
  sendNegotiate: (...a: unknown[]) => unknown;
  respondNegotiate: (...a: unknown[]) => unknown;
  reportBlocker: (...a: unknown[]) => unknown;
  unblockOnEscalate: (...a: unknown[]) => unknown;
  findParent: (...a: unknown[]) => unknown;
  markBlocked: (...a: unknown[]) => unknown;
  createEscalation: (...a: unknown[]) => unknown;
  query: (...a: unknown[]) => unknown;
}>;

interface Harness {
  services: MeshToolServices;
  calls: Record<string, unknown[][]>;
}

const PARENT = { id: "agent_parent" } as unknown as Agent;

function harness(impls: Impls = {}): Harness {
  const calls: Record<string, unknown[][]> = {};
  const record =
    (name: string, fallback: (...a: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      (calls[name] ??= []).push(args);
      const impl = impls[name as keyof Impls];
      return impl ? impl(...args) : fallback(...args);
    };

  const mesh = {
    sendAsk: vi.fn(
      record("sendAsk", (requestId) => ({
        request_id: requestId,
        from_agent_id: "agent_b",
        answer: "yes, feasible",
        // Extra server-side fields the tool is expected to project away.
        internal_trace: "should-not-leak",
      })),
    ),
    respondAsk: vi.fn(record("respondAsk", () => undefined)),
    sendNegotiate: vi.fn(
      record("sendNegotiate", () => ({
        negotiation_id: "neg_1",
        from_agent_id: "agent_b",
        decision: "counter",
        message: "how about Friday",
        counter_proposal: "ship Friday",
      })),
    ),
    respondNegotiate: vi.fn(
      record("respondNegotiate", () => ({
        negotiation_id: "neg_1",
        from_agent_id: "agent_b",
        decision: "counter",
        message: "still no",
        counter_proposal: "ship Monday",
      })),
    ),
    reportBlocker: vi.fn(record("reportBlocker", () => undefined)),
    unblockOnEscalate: vi.fn(record("unblockOnEscalate", () => undefined)),
  } as unknown as MeshServer;

  const agentRepo = {
    findParent: vi.fn(record("findParent", () => PARENT)),
  } as unknown as AgentRepository;

  const taskService = {
    markBlocked: vi.fn(record("markBlocked", () => undefined)),
  } as unknown as TaskService;

  const escalationService = {
    create: vi.fn(
      record("createEscalation", () => ({
        id: "esc_1",
        status: "open",
        negotiation_id: "neg_1",
      })),
    ),
  } as unknown as EscalationService;

  const pool = {
    query: vi.fn(record("query", () => ({ rows: [] }))),
  } as unknown as Pool;

  return {
    services: {
      mesh,
      agentRepo,
      taskRepo: {} as unknown as TaskRepository,
      taskService,
      escalationService,
      pool,
    },
    calls,
  };
}

const CALLER: ResolvedCaller = {
  agentId: "agent_a",
  source: "agent",
  hierarchyLevel: "team",
};
const CTX: MeshToolContext = { caller: CALLER, beevibeSid: "sess_a" };

function toolNamed(h: Harness, name: string) {
  const found = buildTeamMeshTools(CTX, h.services).find((t) => t.name === name);
  if (!found) throw new Error(`no mesh tool named ${name}`);
  return found;
}

describe("ask", () => {
  it("mints a request id and forwards caller, target and question", async () => {
    const h = harness();
    const result = await toolNamed(h, "ask").handler({
      target_agent_id: "agent_b",
      question: "is X feasible?",
    });

    const [requestId, from, target, question] = h.calls.sendAsk![0]!;
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect([from, target, question]).toEqual([
      "agent_a",
      "agent_b",
      "is X feasible?",
    ]);
    expect(result.isError).toBeFalsy();
  });

  it("mints a distinct request id per call", async () => {
    const h = harness();
    const ask = toolNamed(h, "ask");
    await ask.handler({ target_agent_id: "agent_b", question: "q1" });
    await ask.handler({ target_agent_id: "agent_b", question: "q2" });

    expect(h.calls.sendAsk![0]![0]).not.toBe(h.calls.sendAsk![1]![0]);
  });

  it("projects the response down to the three agent-facing fields", async () => {
    const h = harness();
    const result = await toolNamed(h, "ask").handler({
      target_agent_id: "agent_b",
      question: "q",
    });

    expect(Object.keys(result.content).sort()).toEqual([
      "answer",
      "from_agent_id",
      "request_id",
    ]);
    expect(result.content.answer).toBe("yes, feasible");
  });

  it.each([
    ["a missing target", { question: "q" }],
    ["a missing question", { target_agent_id: "agent_b" }],
    ["an empty target", { target_agent_id: "", question: "q" }],
    ["an empty question", { target_agent_id: "agent_b", question: "" }],
  ])("refuses %s without reaching the mesh", async (_l, input) => {
    const h = harness();
    const result = await toolNamed(h, "ask").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content.error).toBe("target_agent_id and question required");
    expect(h.calls.sendAsk).toBeUndefined();
  });
});

describe("respond_ask", () => {
  it("stamps the responding agent id and echoes the request id", async () => {
    const h = harness();
    const result = await toolNamed(h, "respond_ask").handler({
      request_id: "req_1",
      answer: "here you go",
    });

    expect(h.calls.respondAsk![0]).toEqual([
      "req_1",
      {
        request_id: "req_1",
        from_agent_id: "agent_a",
        answer: "here you go",
      },
    ]);
    expect(result.content).toEqual({ responded: true, request_id: "req_1" });
  });

  it.each([
    ["a missing request_id", { answer: "a" }],
    ["a missing answer", { request_id: "req_1" }],
  ])("refuses %s", async (_l, input) => {
    const h = harness();
    const result = await toolNamed(h, "respond_ask").handler(input);

    expect(result.isError).toBe(true);
    expect(h.calls.respondAsk).toBeUndefined();
  });
});

describe("negotiate", () => {
  it("forwards the proposal with the initiator's session id as metadata", async () => {
    const h = harness();
    await toolNamed(h, "negotiate").handler({
      peer_id: "agent_b",
      proposal: "ship Thursday",
      task_id: "task_1",
    });

    expect(h.calls.sendNegotiate![0]).toEqual([
      "agent_a",
      "agent_b",
      "ship Thursday",
      { taskId: "task_1", initiatorSessionId: "sess_a" },
    ]);
  });

  it.each([
    ["omitted", undefined],
    ["empty", ""],
    ["a non-string", 42],
  ])("passes taskId as undefined when %s", async (_l, task_id) => {
    const h = harness();
    await toolNamed(h, "negotiate").handler({
      peer_id: "agent_b",
      proposal: "p",
      task_id,
    });

    expect(
      (h.calls.sendNegotiate![0]![3] as Record<string, unknown>).taskId,
    ).toBeUndefined();
  });

  it("projects a counter response", async () => {
    const h = harness();
    const result = await toolNamed(h, "negotiate").handler({
      peer_id: "agent_b",
      proposal: "p",
    });

    expect(result.content).toEqual({
      negotiation_id: "neg_1",
      from_agent_id: "agent_b",
      decision: "counter",
      message: "how about Friday",
      counter_proposal: "ship Friday",
    });
  });

  it("projects the escalated sentinel into its own shape", async () => {
    const h = harness({
      sendNegotiate: () => ({
        decision: "escalated",
        escalation_id: "esc_7",
        negotiation_id: "neg_1",
        message: "handed to humans",
      }),
    });
    const result = await toolNamed(h, "negotiate").handler({
      peer_id: "agent_b",
      proposal: "p",
    });

    expect(result.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_7",
      negotiation_id: "neg_1",
      message: "handed to humans",
    });
    expect(result.content).not.toHaveProperty("counter_proposal");
  });

  it.each([
    ["a missing peer_id", { proposal: "p" }],
    ["a missing proposal", { peer_id: "agent_b" }],
  ])("refuses %s", async (_l, input) => {
    const h = harness();
    const result = await toolNamed(h, "negotiate").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content.error).toBe("peer_id and proposal required");
    expect(h.calls.sendNegotiate).toBeUndefined();
  });
});

describe("respond_negotiate", () => {
  it("forwards the round without a round number — the server derives it", async () => {
    const h = harness();
    await toolNamed(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "not quite",
      counter_proposal: "ship Monday",
    });

    expect(h.calls.respondNegotiate![0]).toEqual([
      "neg_1",
      {
        negotiation_id: "neg_1",
        from_agent_id: "agent_a",
        decision: "counter",
        message: "not quite",
        counter_proposal: "ship Monday",
      },
      "sess_a",
    ]);
  });

  it.each(["accept", "reject"])(
    "reports %s as terminal when the server returns null",
    async (decision) => {
      const h = harness({ respondNegotiate: () => null });
      const result = await toolNamed(h, "respond_negotiate").handler({
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

  it("projects the peer's next round when the negotiation continues", async () => {
    const h = harness();
    const result = await toolNamed(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "c",
    });

    expect(result.content).toMatchObject({
      negotiation_id: "neg_1",
      decision: "counter",
      counter_proposal: "ship Monday",
    });
  });

  it("requires a counter_proposal when countering", async () => {
    const h = harness();
    const result = await toolNamed(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
    });

    expect(result.isError).toBe(true);
    expect(result.content.error).toBe(
      "counter_proposal required when decision='counter'",
    );
    expect(h.calls.respondNegotiate).toBeUndefined();
  });

  it("does not require a counter_proposal for accept or reject", async () => {
    for (const decision of ["accept", "reject"]) {
      const h = harness({ respondNegotiate: () => null });
      const result = await toolNamed(h, "respond_negotiate").handler({
        negotiation_id: "neg_1",
        decision,
        message: "m",
      });
      expect(result.isError).toBeFalsy();
    }
  });

  it.each([
    ["an unknown decision", "maybe"],
    ["an omitted decision", undefined],
  ])("rejects %s", async (_l, decision) => {
    const h = harness();
    const result = await toolNamed(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision,
      message: "m",
    });

    expect(result.isError).toBe(true);
    expect(result.content.error).toBe(
      "decision must be one of: counter, accept, reject",
    );
    expect(h.calls.respondNegotiate).toBeUndefined();
  });

  it.each([
    ["a missing negotiation_id", { decision: "accept", message: "m" }],
    ["a missing message", { negotiation_id: "neg_1", decision: "accept" }],
  ])("refuses %s", async (_l, input) => {
    const h = harness();
    const result = await toolNamed(h, "respond_negotiate").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content.error).toBe("negotiation_id and message required");
    expect(h.calls.respondNegotiate).toBeUndefined();
  });
});

describe("report_blocker", () => {
  it("marks the task blocked, then spawns the parent", async () => {
    const h = harness();
    const result = await toolNamed(h, "report_blocker").handler({
      task_id: "task_1",
      description: "the API key is missing",
    });

    expect(h.calls.findParent![0]).toEqual(["agent_a"]);
    expect(h.calls.markBlocked![0]).toEqual([
      "task_1",
      "agent_a",
      "the API key is missing",
    ]);
    expect(h.calls.reportBlocker![0]).toEqual([
      "agent_parent",
      "agent_a",
      "task_1",
      "the API key is missing",
    ]);
    expect(result.content).toEqual({
      reported: true,
      parent_agent_id: "agent_parent",
      task_id: "task_1",
    });
  });

  it("refuses a top-level agent and leaves the task untouched", async () => {
    const h = harness({ findParent: () => null });
    const result = await toolNamed(h, "report_blocker").handler({
      task_id: "task_1",
      description: "stuck",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "no_parent_to_block" });
    expect(h.calls.markBlocked).toBeUndefined();
    expect(h.calls.reportBlocker).toBeUndefined();
  });

  it("does not spawn the parent when marking the task blocked fails", async () => {
    const h = harness({
      markBlocked: () => {
        throw new Error("task not found");
      },
    });
    const result = await toolNamed(h, "report_blocker").handler({
      task_id: "task_gone",
      description: "stuck",
    });

    expect(result.isError).toBe(true);
    expect(result.content.error).toBe("task not found");
    expect(h.calls.reportBlocker).toBeUndefined();
  });

  it.each([
    ["a missing task_id", { description: "d" }],
    ["a missing description", { task_id: "task_1" }],
  ])("refuses %s before resolving the parent", async (_l, input) => {
    const h = harness();
    const result = await toolNamed(h, "report_blocker").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content.error).toBe("task_id and description required");
    expect(h.calls.findParent).toBeUndefined();
  });
});

describe("escalate_to_humans", () => {
  it("creates the escalation, unblocks the peer, then notifies", async () => {
    const h = harness();
    const result = await toolNamed(h, "escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "We're stuck on the ship date.",
      proposals: [{ title: "Ship Friday", description: "cut scope" }],
      open_questions: ["is the deadline hard?"],
    });

    expect(h.calls.createEscalation![0]![0]).toEqual({
      negotiationId: "neg_1",
      callerAgentId: "agent_a",
      summary: "We're stuck on the ship date.",
      proposals: [{ title: "Ship Friday", description: "cut scope" }],
      openQuestions: ["is the deadline hard?"],
    });
    expect(h.calls.unblockOnEscalate![0]).toEqual(["neg_1", "esc_1"]);
    expect(h.calls.query![0]).toEqual([
      `SELECT pg_notify('escalation_created', $1)`,
      ["esc_1"],
    ]);
    expect(result.content).toEqual({
      escalation_id: "esc_1",
      status: "open",
      negotiation_id: "neg_1",
    });
  });

  it.each([
    ["omitted", undefined],
    ["not an array", "a proposal"],
  ])("passes proposals as undefined when %s", async (_l, proposals) => {
    const h = harness();
    await toolNamed(h, "escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "s",
      proposals,
    });

    expect(
      (h.calls.createEscalation![0]![0] as Record<string, unknown>).proposals,
    ).toBeUndefined();
  });

  it("drops non-string open_questions", async () => {
    const h = harness();
    await toolNamed(h, "escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "s",
      open_questions: ["real question", 42, null, "another"],
    });

    expect(
      (h.calls.createEscalation![0]![0] as Record<string, unknown>).openQuestions,
    ).toEqual(["real question", "another"]);
  });

  it("does not unblock the peer or notify when escalation creation fails", async () => {
    const h = harness({
      createEscalation: () => {
        throw new Error("negotiation already escalated");
      },
    });
    const result = await toolNamed(h, "escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "s",
    });

    expect(result.isError).toBe(true);
    expect(result.content.error).toBe("negotiation already escalated");
    expect(h.calls.unblockOnEscalate).toBeUndefined();
    expect(h.calls.query).toBeUndefined();
  });

  it.each([
    ["a missing negotiation_id", { summary: "s" }],
    ["a missing summary", { negotiation_id: "neg_1" }],
  ])("refuses %s", async (_l, input) => {
    const h = harness();
    const result = await toolNamed(h, "escalate_to_humans").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content.error).toBe("negotiation_id and summary required");
    expect(h.calls.createEscalation).toBeUndefined();
  });
});

describe("thrown-error mapping", () => {
  it("preserves the code and meta of a CodedMeshError", async () => {
    const meta = { agentId: "agent_b", running: 3, cap: 3 };
    const h = harness({
      sendAsk: () => {
        throw new MeshCapacityError("agent_b is at capacity", meta);
      },
    });
    const result = await toolNamed(h, "ask").handler({
      target_agent_id: "agent_b",
      question: "q",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "MESH_CAPACITY_EXCEEDED",
      ...meta,
      message: "agent_b is at capacity",
    });
  });

  it("degrades a plain Error to the catch-all shape, message in `error`", async () => {
    const h = harness({
      sendNegotiate: () => {
        throw new Error("peer never responded");
      },
    });
    const result = await toolNamed(h, "negotiate").handler({
      peer_id: "agent_b",
      proposal: "p",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "peer never responded" });
  });

  it("maps a max-rounds throw out of respond_negotiate", async () => {
    const h = harness({
      respondNegotiate: () => {
        throw new Error("max_rounds_exceeded");
      },
    });
    const result = await toolNamed(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "c",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "max_rounds_exceeded" });
  });

  it("stringifies a thrown non-Error", async () => {
    const h = harness({
      respondAsk: () => {
        throw "channel closed";
      },
    });
    const result = await toolNamed(h, "respond_ask").handler({
      request_id: "req_1",
      answer: "a",
    });

    expect(result.content).toEqual({ error: "channel closed" });
  });
});
