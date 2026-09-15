/**
 * Handler behavior for the six mesh tools.
 *
 * `mesh.test.ts` locks the per-tier tool *inventory*; its header notes
 * that handler behavior was only exercised by the m6/m7 e2e scripts,
 * which need live Postgres plus spawned CLI subprocesses. Every
 * collaborator is injected though, so the handlers test as plain
 * functions — validation, the projection helpers, the fire-and-forget
 * ordering, and the CodedMeshError envelope all run without a database.
 */
import { describe, expect, it, vi } from "vitest";
import { MeshCapacityError } from "../mesh/types.js";
import type { McpCaller } from "./assemble.js";
import {
  buildIcMeshTools,
  buildTeamMeshTools,
  type MeshToolContext,
  type MeshToolServices,
} from "./mesh.js";

interface Stubs {
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
  /** Call order across mesh + repos, for ordering assertions. */
  order: string[];
}

const CALLER: McpCaller = {
  agentId: "agent_me",
  source: "agent",
  hierarchyLevel: "team",
};

function harness(): { services: MeshToolServices; ctx: MeshToolContext } & Stubs {
  const order: string[] = [];
  const track =
    <T>(label: string, impl: (...a: never[]) => T) =>
    (...args: never[]): T => {
      order.push(label);
      return impl(...args);
    };

  const stubs = {
    sendAsk: vi.fn(
      track("sendAsk", () =>
        Promise.resolve({
          request_id: "req_1",
          from_agent_id: "agent_them",
          answer: "yes, feasible",
        }),
      ),
    ),
    respondAsk: vi.fn(track("respondAsk", () => undefined)),
    sendNegotiate: vi.fn(
      track("sendNegotiate", () =>
        Promise.resolve({
          negotiation_id: "neg_1",
          from_agent_id: "agent_them",
          decision: "counter",
          message: "how about this",
          counter_proposal: "do it in two phases",
        }),
      ),
    ),
    respondNegotiate: vi.fn(track("respondNegotiate", () => Promise.resolve(null))),
    reportBlocker: vi.fn(track("mesh.reportBlocker", () => undefined)),
    unblockOnEscalate: vi.fn(track("unblockOnEscalate", () => undefined)),
    findParent: vi.fn(
      track("findParent", () => Promise.resolve({ id: "agent_boss" })),
    ),
    markBlocked: vi.fn(track("markBlocked", () => Promise.resolve(undefined))),
    createEscalation: vi.fn(
      track("createEscalation", () =>
        Promise.resolve({
          id: "esc_1",
          status: "open",
          negotiation_id: "neg_1",
        }),
      ),
    ),
    query: vi.fn(track("pg_notify", () => Promise.resolve({ rows: [] }))),
    order,
  } as unknown as Stubs;

  const services = {
    mesh: {
      sendAsk: stubs.sendAsk,
      respondAsk: stubs.respondAsk,
      sendNegotiate: stubs.sendNegotiate,
      respondNegotiate: stubs.respondNegotiate,
      reportBlocker: stubs.reportBlocker,
      unblockOnEscalate: stubs.unblockOnEscalate,
    },
    agentRepo: { findParent: stubs.findParent },
    taskRepo: {},
    taskService: { markBlocked: stubs.markBlocked },
    escalationService: { create: stubs.createEscalation },
    pool: { query: stubs.query },
  } as unknown as MeshToolServices;

  return {
    services,
    ctx: { caller: CALLER, beevibeSid: "sess_me" },
    ...stubs,
  };
}

function teamTool(h: ReturnType<typeof harness>, name: string) {
  const tool = buildTeamMeshTools(h.ctx, h.services).find((t) => t.name === name);
  if (!tool) throw new Error(`no such team tool: ${name}`);
  return tool;
}

describe("ask", () => {
  it("projects the mesh response down to the three agent-facing fields", async () => {
    const h = harness();
    const result = await teamTool(h, "ask").handler({
      target_agent_id: "agent_them",
      question: "is X feasible?",
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      request_id: "req_1",
      from_agent_id: "agent_them",
      answer: "yes, feasible",
    });
  });

  it("sends the caller's own agent id as the asker", async () => {
    const h = harness();
    await teamTool(h, "ask").handler({
      target_agent_id: "agent_them",
      question: "q",
    });

    const [requestId, from, to, question] = h.sendAsk.mock.calls[0]!;
    expect(from).toBe("agent_me");
    expect(to).toBe("agent_them");
    expect(question).toBe("q");
    expect(typeof requestId).toBe("string");
  });

  it("mints a fresh request id per call", async () => {
    const h = harness();
    const tool = teamTool(h, "ask");
    await tool.handler({ target_agent_id: "a", question: "q" });
    await tool.handler({ target_agent_id: "a", question: "q" });

    expect(h.sendAsk.mock.calls[0]![0]).not.toBe(h.sendAsk.mock.calls[1]![0]);
  });

  it.each([
    ["a missing target", { question: "q" }],
    ["an empty target", { target_agent_id: "", question: "q" }],
    ["a missing question", { target_agent_id: "a" }],
    ["an empty question", { target_agent_id: "a", question: "" }],
  ])("rejects %s without hitting the mesh", async (_label, input) => {
    const h = harness();
    const result = await teamTool(h, "ask").handler(input);

    expect(result.isError).toBe(true);
    expect(h.sendAsk).not.toHaveBeenCalled();
  });

  it("keeps a CodedMeshError's code and meta in the envelope", async () => {
    const h = harness();
    h.sendAsk.mockRejectedValue(
      new MeshCapacityError("too many running", {
        agentId: "agent_them",
        running: 5,
        cap: 5,
      }),
    );

    const result = await teamTool(h, "ask").handler({
      target_agent_id: "agent_them",
      question: "q",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "MESH_CAPACITY_EXCEEDED",
      agentId: "agent_them",
      running: 5,
      cap: 5,
      message: "too many running",
    });
  });

  it("degrades a plain Error to the catch-all envelope", async () => {
    const h = harness();
    h.sendAsk.mockRejectedValue(new Error("target went away"));

    const result = await teamTool(h, "ask").handler({
      target_agent_id: "agent_them",
      question: "q",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "target went away" });
  });
});

describe("respond_ask", () => {
  it("stamps the responder id onto the response and confirms", async () => {
    const h = harness();
    const result = await teamTool(h, "respond_ask").handler({
      request_id: "req_1",
      answer: "here you go",
    });

    expect(h.respondAsk).toHaveBeenCalledWith("req_1", {
      request_id: "req_1",
      from_agent_id: "agent_me",
      answer: "here you go",
    });
    expect(result.content).toEqual({ responded: true, request_id: "req_1" });
  });

  it.each([
    ["a missing request_id", { answer: "a" }],
    ["an empty answer", { request_id: "r", answer: "" }],
  ])("rejects %s without unblocking anyone", async (_label, input) => {
    const h = harness();
    const result = await teamTool(h, "respond_ask").handler(input);

    expect(result.isError).toBe(true);
    expect(h.respondAsk).not.toHaveBeenCalled();
  });

  it("is available to IC agents", () => {
    const h = harness();
    const names = buildIcMeshTools(h.ctx, h.services).map((t) => t.name);
    expect(names).toContain("respond_ask");
  });

  it("wraps a throw out of the mesh", async () => {
    const h = harness();
    h.respondAsk.mockImplementation(() => {
      throw new Error("no waiter for that request");
    });

    const result = await teamTool(h, "respond_ask").handler({
      request_id: "req_1",
      answer: "a",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "no waiter for that request" });
  });
});

describe("negotiate", () => {
  it("projects a counter response with its proposal", async () => {
    const h = harness();
    const result = await teamTool(h, "negotiate").handler({
      peer_id: "agent_them",
      proposal: "ship on friday",
    });

    expect(result.content).toEqual({
      negotiation_id: "neg_1",
      from_agent_id: "agent_them",
      decision: "counter",
      message: "how about this",
      counter_proposal: "do it in two phases",
    });
  });

  it("passes the caller's session id as the initiator session", async () => {
    const h = harness();
    await teamTool(h, "negotiate").handler({
      peer_id: "agent_them",
      proposal: "p",
      task_id: "task_7",
    });

    expect(h.sendNegotiate).toHaveBeenCalledWith("agent_me", "agent_them", "p", {
      taskId: "task_7",
      initiatorSessionId: "sess_me",
    });
  });

  it.each([
    ["an omitted task_id", undefined],
    ["an empty task_id", ""],
    ["a non-string task_id", 7],
  ])("sends undefined for %s", async (_label, task_id) => {
    const h = harness();
    await teamTool(h, "negotiate").handler({
      peer_id: "agent_them",
      proposal: "p",
      task_id,
    });

    expect(h.sendNegotiate.mock.calls[0]![3]).toMatchObject({ taskId: undefined });
  });

  it("projects the escalated sentinel through its own branch", async () => {
    const h = harness();
    h.sendNegotiate.mockResolvedValue({
      decision: "escalated",
      escalation_id: "esc_9",
      negotiation_id: "neg_1",
      message: "handed to humans",
    });

    const result = await teamTool(h, "negotiate").handler({
      peer_id: "agent_them",
      proposal: "p",
    });

    expect(result.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_9",
      negotiation_id: "neg_1",
      message: "handed to humans",
    });
    expect(result.content.from_agent_id).toBeUndefined();
  });

  it.each([
    ["a missing peer", { proposal: "p" }],
    ["an empty proposal", { peer_id: "a", proposal: "" }],
  ])("rejects %s without hitting the mesh", async (_label, input) => {
    const h = harness();
    const result = await teamTool(h, "negotiate").handler(input);

    expect(result.isError).toBe(true);
    expect(h.sendNegotiate).not.toHaveBeenCalled();
  });

  it("surfaces the server's max-rounds error to the caller", async () => {
    const h = harness();
    h.sendNegotiate.mockRejectedValue(new Error("max_rounds_exceeded"));

    const result = await teamTool(h, "negotiate").handler({
      peer_id: "agent_them",
      proposal: "p",
    });

    expect(result.content).toEqual({ error: "max_rounds_exceeded" });
  });

  it("is withheld from IC agents", () => {
    const h = harness();
    const names = buildIcMeshTools(h.ctx, h.services).map((t) => t.name);
    expect(names).not.toContain("negotiate");
  });
});

describe("respond_negotiate", () => {
  it("reports terminal when the server returns null", async () => {
    const h = harness();
    const result = await teamTool(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "accept",
      message: "agreed",
    });

    expect(result.content).toEqual({
      negotiation_id: "neg_1",
      decision: "accept",
      terminal: true,
    });
  });

  it("projects the peer's next round when one comes back", async () => {
    const h = harness();
    h.respondNegotiate.mockResolvedValue({
      negotiation_id: "neg_1",
      from_agent_id: "agent_them",
      decision: "counter",
      message: "still no",
      counter_proposal: "try monday",
    });

    const result = await teamTool(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "how about friday",
      counter_proposal: "friday",
    });

    expect(result.content).toMatchObject({
      from_agent_id: "agent_them",
      decision: "counter",
      counter_proposal: "try monday",
    });
  });

  it("sends the caller's id and session, letting the server compute the round", async () => {
    const h = harness();
    await teamTool(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "reject",
      message: "no",
    });

    expect(h.respondNegotiate).toHaveBeenCalledWith(
      "neg_1",
      {
        negotiation_id: "neg_1",
        from_agent_id: "agent_me",
        decision: "reject",
        message: "no",
        counter_proposal: undefined,
      },
      "sess_me",
    );
  });

  it.each([
    ["a missing negotiation_id", { decision: "accept", message: "m" }],
    ["an empty message", { negotiation_id: "n", decision: "accept", message: "" }],
  ])("rejects %s", async (_label, input) => {
    const h = harness();
    const result = await teamTool(h, "respond_negotiate").handler(input);

    expect(result.isError).toBe(true);
    expect(h.respondNegotiate).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown decision", "maybe"],
    ["a missing decision", undefined],
  ])("rejects %s and names the legal values", async (_label, decision) => {
    const h = harness();
    const result = await teamTool(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision,
      message: "m",
    });

    expect(result.isError).toBe(true);
    expect(String(result.content.error)).toContain("counter, accept, reject");
    expect(h.respondNegotiate).not.toHaveBeenCalled();
  });

  it("requires a counter_proposal when countering", async () => {
    const h = harness();
    const result = await teamTool(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
    });

    expect(result.isError).toBe(true);
    expect(String(result.content.error)).toContain("counter_proposal required");
    expect(h.respondNegotiate).not.toHaveBeenCalled();
  });

  it.each([["accept"], ["reject"]])(
    "does not require a counter_proposal for %s",
    async (decision) => {
      const h = harness();
      const result = await teamTool(h, "respond_negotiate").handler({
        negotiation_id: "neg_1",
        decision,
        message: "m",
      });

      expect(result.isError).toBeFalsy();
    },
  );

  it("is withheld from IC agents", () => {
    const h = harness();
    const names = buildIcMeshTools(h.ctx, h.services).map((t) => t.name);
    expect(names).not.toContain("respond_negotiate");
  });
});

describe("report_blocker", () => {
  it("marks the task blocked before spawning the parent", async () => {
    const h = harness();
    const result = await teamTool(h, "report_blocker").handler({
      task_id: "task_7",
      description: "the API key is missing",
    });

    expect(result.content).toEqual({
      reported: true,
      parent_agent_id: "agent_boss",
      task_id: "task_7",
    });
    // The DB state has to land before the fire-and-forget spawn, or the
    // parent's session can read a task that isn't blocked yet.
    expect(h.order).toEqual(["findParent", "markBlocked", "mesh.reportBlocker"]);
  });

  it("records the caller as the blocker agent", async () => {
    const h = harness();
    await teamTool(h, "report_blocker").handler({
      task_id: "task_7",
      description: "stuck",
    });

    expect(h.markBlocked).toHaveBeenCalledWith("task_7", "agent_me", "stuck");
    expect(h.reportBlocker).toHaveBeenCalledWith(
      "agent_boss",
      "agent_me",
      "task_7",
      "stuck",
    );
  });

  it("refuses for a top-level agent and points at the alternatives", async () => {
    const h = harness();
    h.findParent.mockResolvedValue(undefined);

    const result = await teamTool(h, "report_blocker").handler({
      task_id: "task_7",
      description: "stuck",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "no_parent_to_block" });
    expect(String(result.content.message)).toContain("escalate_to_humans");
    expect(h.markBlocked).not.toHaveBeenCalled();
    expect(h.reportBlocker).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing task_id", { description: "d" }],
    ["an empty description", { task_id: "t", description: "" }],
  ])("rejects %s before looking up the parent", async (_label, input) => {
    const h = harness();
    const result = await teamTool(h, "report_blocker").handler(input);

    expect(result.isError).toBe(true);
    expect(h.findParent).not.toHaveBeenCalled();
  });

  it("does not spawn the parent when marking the task blocked fails", async () => {
    const h = harness();
    h.markBlocked.mockRejectedValue(new Error("task not found"));

    const result = await teamTool(h, "report_blocker").handler({
      task_id: "task_7",
      description: "stuck",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "task not found" });
    expect(h.reportBlocker).not.toHaveBeenCalled();
  });

  it("is available to IC agents — that is their escalation path", () => {
    const h = harness();
    const names = buildIcMeshTools(h.ctx, h.services).map((t) => t.name);
    expect(names).toContain("report_blocker");
  });
});

describe("escalate_to_humans", () => {
  const INPUT = {
    negotiation_id: "neg_1",
    summary: "We're stuck on X; root disagreement is Y.",
  };

  it("creates the escalation, unblocks the peer, then notifies", async () => {
    const h = harness();
    const result = await teamTool(h, "escalate_to_humans").handler(INPUT);

    expect(result.content).toEqual({
      escalation_id: "esc_1",
      status: "open",
      negotiation_id: "neg_1",
    });
    expect(h.order).toEqual(["createEscalation", "unblockOnEscalate", "pg_notify"]);
  });

  it("passes the caller as the escalating agent", async () => {
    const h = harness();
    await teamTool(h, "escalate_to_humans").handler(INPUT);

    expect(h.createEscalation).toHaveBeenCalledWith({
      negotiationId: "neg_1",
      callerAgentId: "agent_me",
      summary: INPUT.summary,
      proposals: undefined,
      openQuestions: undefined,
    });
  });

  it("unblocks the peer against the new escalation id", async () => {
    const h = harness();
    await teamTool(h, "escalate_to_humans").handler(INPUT);

    expect(h.unblockOnEscalate).toHaveBeenCalledWith("neg_1", "esc_1");
  });

  it("notifies listeners with the escalation id", async () => {
    const h = harness();
    await teamTool(h, "escalate_to_humans").handler(INPUT);

    const [sql, params] = h.query.mock.calls[0]!;
    expect(String(sql)).toContain("escalation_created");
    expect(params).toEqual(["esc_1"]);
  });

  it("forwards proposals and open questions when supplied", async () => {
    const h = harness();
    const proposals = [{ title: "A", description: "do A", tradeoffs: "slow" }];
    await teamTool(h, "escalate_to_humans").handler({
      ...INPUT,
      proposals,
      open_questions: ["is the deadline firm?"],
    });

    expect(h.createEscalation).toHaveBeenCalledWith(
      expect.objectContaining({
        proposals,
        openQuestions: ["is the deadline firm?"],
      }),
    );
  });

  it("drops non-string open questions", async () => {
    const h = harness();
    await teamTool(h, "escalate_to_humans").handler({
      ...INPUT,
      open_questions: ["keep me", 42, null, "and me"],
    });

    expect(h.createEscalation.mock.calls[0]![0].openQuestions).toEqual([
      "keep me",
      "and me",
    ]);
  });

  it.each([
    ["a non-array proposals", "one proposal"],
    ["a non-array open_questions", "a question"],
  ])("ignores %s", async (_label, value) => {
    const h = harness();
    await teamTool(h, "escalate_to_humans").handler({
      ...INPUT,
      proposals: value,
      open_questions: value,
    });

    expect(h.createEscalation.mock.calls[0]![0]).toMatchObject({
      proposals: undefined,
      openQuestions: undefined,
    });
  });

  it.each([
    ["a missing negotiation_id", { summary: "s" }],
    ["an empty summary", { negotiation_id: "n", summary: "" }],
  ])("rejects %s before creating anything", async (_label, input) => {
    const h = harness();
    const result = await teamTool(h, "escalate_to_humans").handler(input);

    expect(result.isError).toBe(true);
    expect(h.createEscalation).not.toHaveBeenCalled();
  });

  it("leaves the peer blocked when the escalation cannot be created", async () => {
    const h = harness();
    h.createEscalation.mockRejectedValue(new Error("negotiation already resolved"));

    const result = await teamTool(h, "escalate_to_humans").handler(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "negotiation already resolved" });
    expect(h.unblockOnEscalate).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
  });

  it("reports an error when the notify fails, after the peer is unblocked", async () => {
    const h = harness();
    h.query.mockRejectedValue(new Error("pg gone"));

    const result = await teamTool(h, "escalate_to_humans").handler(INPUT);

    expect(result.isError).toBe(true);
    expect(h.unblockOnEscalate).toHaveBeenCalled();
  });

  it("is withheld from IC agents", () => {
    const h = harness();
    const names = buildIcMeshTools(h.ctx, h.services).map((t) => t.name);
    expect(names).not.toContain("escalate_to_humans");
  });
});
