/**
 * Mesh tool tests — tier gating (which tools each tier gets) plus each
 * handler's own logic against a fake MeshServer.
 *
 * The handlers are thin: validate args, call the server, project the
 * response. The projections matter because they are the agent-facing
 * wire shape (an ask's answer, a negotiation's counter-proposal, the
 * `escalated` sentinel), and the validation matters because a blank
 * required arg has to fail here rather than spawn a session that hangs.
 *
 * What is NOT here: the server's own blocking/round-counting behavior,
 * which needs live Postgres + spawned CLI subprocesses and stays in the
 * m6/m7 e2e scripts.
 */
import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@beevibe/core";
import { MeshMaxRoundsError } from "../mesh/types.js";
import type { McpCaller } from "./assemble.js";
import {
  buildIcMeshTools,
  buildTeamMeshTools,
  type MeshToolContext,
  type MeshToolServices,
} from "./mesh.js";

// Fake services — the assembly itself doesn't invoke handlers, so the
// dependencies just need to be the right shape.
const fakeServices = {} as unknown as MeshToolServices;

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

interface MeshStub {
  sendAsk: ReturnType<typeof vi.fn>;
  respondAsk: ReturnType<typeof vi.fn>;
  sendNegotiate: ReturnType<typeof vi.fn>;
  respondNegotiate: ReturnType<typeof vi.fn>;
  reportBlocker: ReturnType<typeof vi.fn>;
  unblockOnEscalate: ReturnType<typeof vi.fn>;
}

function harness(
  overrides: {
    mesh?: Partial<Record<keyof MeshStub, unknown>>;
    parent?: Agent | undefined;
    escalation?: Record<string, unknown>;
    markBlocked?: unknown;
    escalationCreate?: unknown;
  } = {},
) {
  const mesh: MeshStub = {
    sendAsk: vi.fn(async (requestId: string, _from: string, to: string) => ({
      request_id: requestId,
      from_agent_id: to,
      answer: "yes, feasible",
    })),
    respondAsk: vi.fn(),
    sendNegotiate: vi.fn(async (_from: string, to: string) => ({
      negotiation_id: "neg_1",
      from_agent_id: to,
      decision: "counter",
      message: "how about Tuesday",
      counter_proposal: "Tuesday",
    })),
    respondNegotiate: vi.fn(async () => null),
    reportBlocker: vi.fn(),
    unblockOnEscalate: vi.fn(),
  };
  for (const [k, v] of Object.entries(overrides.mesh ?? {})) {
    (mesh as unknown as Record<string, unknown>)[k] = v;
  }

  const query = vi.fn(async () => ({ rows: [] }));
  const markBlocked = vi.fn(async () => {
    if (overrides.markBlocked) throw overrides.markBlocked;
  });
  const create = vi.fn(async (_input: Record<string, unknown>) => {
    if (overrides.escalationCreate) throw overrides.escalationCreate;
    return (
      overrides.escalation ?? {
        id: "esc_1",
        status: "open",
        negotiation_id: "neg_1",
      }
    );
  });
  const parent = "parent" in overrides ? overrides.parent : ({ id: "agent_parent" } as Agent);

  const services = {
    mesh,
    agentRepo: { findParent: vi.fn(async () => parent) },
    taskRepo: {},
    taskService: { markBlocked },
    escalationService: { create },
    pool: { query },
  } as unknown as MeshToolServices;

  const ctx: MeshToolContext = { caller: fakeCaller, beevibeSid: "ses_x" };
  const tools = buildTeamMeshTools(ctx, services);
  const tool = (name: string) => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool named ${name}`);
    return t;
  };
  return { mesh, services, tool, query, markBlocked, create };
}

describe("ask", () => {
  it("mints a request id, sends from the caller, and projects the answer", async () => {
    const { tool, mesh } = harness();
    const result = await tool("ask").handler({
      target_agent_id: "agent_b",
      question: "is X feasible?",
    });

    expect(mesh.sendAsk).toHaveBeenCalledTimes(1);
    const [requestId, from, to, question] = mesh.sendAsk.mock.calls[0]!;
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(from).toBe("agent_x");
    expect(to).toBe("agent_b");
    expect(question).toBe("is X feasible?");

    // Exact projection: the agent sees these three fields and nothing else.
    expect(result.content).toEqual({
      request_id: requestId,
      from_agent_id: "agent_b",
      answer: "yes, feasible",
    });
    expect(result.isError).toBeFalsy();
  });

  it.each([
    ["no target", { question: "q" }],
    ["no question", { target_agent_id: "agent_b" }],
    ["blank target", { target_agent_id: "", question: "q" }],
    ["blank question", { target_agent_id: "agent_b", question: "" }],
  ])("refuses to spawn with %s", async (_l, input) => {
    const { tool, mesh } = harness();
    const result = await tool("ask").handler(input);
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "target_agent_id and question required",
    });
    expect(mesh.sendAsk).not.toHaveBeenCalled();
  });

  it("projects a coded mesh error with its code and meta", async () => {
    const err = new MeshMaxRoundsError({
      negotiationId: "neg_1",
      rounds_completed: 5,
      max_rounds: 5,
    });
    const { tool } = harness({
      mesh: { sendAsk: vi.fn(async () => { throw err; }) },
    });
    const result = await tool("ask").handler({
      target_agent_id: "agent_b",
      question: "q",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "MAX_ROUNDS_EXCEEDED",
      negotiationId: "neg_1",
      max_rounds: 5,
      message: err.message,
    });
  });

  it("degrades an uncoded throw to the catch-all envelope", async () => {
    const { tool } = harness({
      mesh: { sendAsk: vi.fn(async () => { throw new Error("peer offline"); }) },
    });
    const result = await tool("ask").handler({
      target_agent_id: "agent_b",
      question: "q",
    });
    expect(result.content).toEqual({ error: "peer offline" });
  });
});

describe("respond_ask", () => {
  it("unblocks the asker with the caller stamped as responder", async () => {
    const { tool, mesh } = harness();
    const result = await tool("respond_ask").handler({
      request_id: "req_1",
      answer: "yes",
    });
    expect(mesh.respondAsk).toHaveBeenCalledWith("req_1", {
      request_id: "req_1",
      from_agent_id: "agent_x",
      answer: "yes",
    });
    expect(result.content).toEqual({ responded: true, request_id: "req_1" });
  });

  it.each([
    ["no request_id", { answer: "yes" }],
    ["no answer", { request_id: "req_1" }],
  ])("rejects %s", async (_l, input) => {
    const { tool, mesh } = harness();
    const result = await tool("respond_ask").handler(input);
    expect(result.isError).toBe(true);
    expect(mesh.respondAsk).not.toHaveBeenCalled();
  });

  it("envelopes a synchronous throw from the server", async () => {
    const { tool } = harness({
      mesh: { respondAsk: vi.fn(() => { throw new Error("no such request"); }) },
    });
    const result = await tool("respond_ask").handler({
      request_id: "req_1",
      answer: "yes",
    });
    expect(result.content).toEqual({ error: "no such request" });
  });
});

describe("negotiate", () => {
  it("passes task_id and the caller's session as initiator metadata", async () => {
    const { tool, mesh } = harness();
    const result = await tool("negotiate").handler({
      peer_id: "agent_b",
      proposal: "ship Monday",
      task_id: "tsk_1",
    });
    expect(mesh.sendNegotiate).toHaveBeenCalledWith(
      "agent_x",
      "agent_b",
      "ship Monday",
      { taskId: "tsk_1", initiatorSessionId: "ses_x" },
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
      const { tool, mesh } = harness();
      await tool("negotiate").handler({ peer_id: "agent_b", proposal: "p", task_id });
      expect(mesh.sendNegotiate.mock.calls[0]?.[3]).toMatchObject({
        taskId: undefined,
      });
    }
  });

  it.each([
    ["no peer_id", { proposal: "p" }],
    ["no proposal", { peer_id: "agent_b" }],
  ])("rejects %s", async (_l, input) => {
    const { tool, mesh } = harness();
    const result = await tool("negotiate").handler(input);
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "peer_id and proposal required" });
    expect(mesh.sendNegotiate).not.toHaveBeenCalled();
  });

  it("envelopes a throw from the server rather than blocking the caller", async () => {
    const { tool } = harness({
      mesh: {
        sendNegotiate: vi.fn(async () => { throw new Error("peer at capacity"); }),
      },
    });
    const result = await tool("negotiate").handler({
      peer_id: "agent_b",
      proposal: "p",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "peer at capacity" });
  });

  it("projects the escalated sentinel instead of a normal response", async () => {
    const { tool } = harness({
      mesh: {
        sendNegotiate: vi.fn(async () => ({
          decision: "escalated",
          escalation_id: "esc_1",
          negotiation_id: "neg_1",
          message: "handed to humans",
        })),
      },
    });
    const result = await tool("negotiate").handler({
      peer_id: "agent_b",
      proposal: "p",
    });
    expect(result.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_1",
      negotiation_id: "neg_1",
      message: "handed to humans",
    });
    // The sentinel branch must not leak the peer-response fields.
    expect(result.content).not.toHaveProperty("from_agent_id");
  });
});

describe("respond_negotiate", () => {
  const ok = { negotiation_id: "neg_1", decision: "accept", message: "deal" };

  it("reports terminal when the server returns null (accept/reject)", async () => {
    const { tool, mesh } = harness();
    const result = await tool("respond_negotiate").handler(ok);
    expect(mesh.respondNegotiate).toHaveBeenCalledWith(
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
    expect(result.content).toEqual({
      negotiation_id: "neg_1",
      decision: "accept",
      terminal: true,
    });
  });

  it("projects the peer's next round when the server returns one", async () => {
    const { tool } = harness({
      mesh: {
        respondNegotiate: vi.fn(async () => ({
          negotiation_id: "neg_1",
          from_agent_id: "agent_b",
          decision: "counter",
          message: "not quite",
          counter_proposal: "Wednesday",
        })),
      },
    });
    const result = await tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "how about Tuesday",
      counter_proposal: "Tuesday",
    });
    expect(result.content).toMatchObject({
      from_agent_id: "agent_b",
      decision: "counter",
      counter_proposal: "Wednesday",
    });
  });

  it("forwards the counter_proposal on a counter", async () => {
    const { tool, mesh } = harness();
    await tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "Tuesday",
    });
    expect(mesh.respondNegotiate.mock.calls[0]?.[1]).toMatchObject({
      counter_proposal: "Tuesday",
    });
  });

  it.each([
    ["no negotiation_id", { decision: "accept", message: "m" }],
    ["no message", { negotiation_id: "neg_1", decision: "accept" }],
  ])("rejects %s", async (_l, input) => {
    const { tool, mesh } = harness();
    const result = await tool("respond_negotiate").handler(input);
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "negotiation_id and message required",
    });
    expect(mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("rejects a decision outside counter/accept/reject", async () => {
    const { tool, mesh } = harness();
    const result = await tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "maybe",
      message: "m",
    });
    expect(result.isError).toBe(true);
    expect(String(result.content.error)).toContain("decision must be one of");
    expect(mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("rejects decision='counter' with no counter_proposal", async () => {
    const { tool, mesh } = harness();
    const result = await tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "counter_proposal required when decision='counter'",
    });
    expect(mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("surfaces MAX_ROUNDS_EXCEEDED so the agent can escalate instead", async () => {
    const { tool } = harness({
      mesh: {
        respondNegotiate: vi.fn(async () => {
          throw new MeshMaxRoundsError({
            negotiationId: "neg_1",
            rounds_completed: 5,
            max_rounds: 5,
          });
        }),
      },
    });
    const result = await tool("respond_negotiate").handler(ok);
    expect(result.content).toMatchObject({
      error: "MAX_ROUNDS_EXCEEDED",
      rounds_completed: 5,
    });
  });
});

describe("report_blocker", () => {
  it("marks the task blocked and fires the parent's session", async () => {
    const { tool, mesh, markBlocked } = harness();
    const result = await tool("report_blocker").handler({
      task_id: "tsk_1",
      description: "missing credentials",
    });
    expect(markBlocked).toHaveBeenCalledWith("tsk_1", "agent_x", "missing credentials");
    expect(mesh.reportBlocker).toHaveBeenCalledWith(
      "agent_parent",
      "agent_x",
      "tsk_1",
      "missing credentials",
    );
    expect(result.content).toEqual({
      reported: true,
      parent_agent_id: "agent_parent",
      task_id: "tsk_1",
    });
  });

  it("refuses for a top-level agent with no parent, without touching the task", async () => {
    const { tool, mesh, markBlocked } = harness({ parent: undefined });
    const result = await tool("report_blocker").handler({
      task_id: "tsk_1",
      description: "stuck",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "no_parent_to_block" });
    expect(String(result.content.message)).toContain("escalate_to_humans");
    expect(markBlocked).not.toHaveBeenCalled();
    expect(mesh.reportBlocker).not.toHaveBeenCalled();
  });

  it.each([
    ["no task_id", { description: "stuck" }],
    ["no description", { task_id: "tsk_1" }],
  ])("rejects %s before resolving the parent", async (_l, input) => {
    const { tool, services } = harness();
    const result = await tool("report_blocker").handler(input);
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "task_id and description required" });
    expect(services.agentRepo.findParent).not.toHaveBeenCalled();
  });

  it("does not spawn the parent when marking the task blocked fails", async () => {
    const { tool, mesh } = harness({ markBlocked: new Error("task gone") });
    const result = await tool("report_blocker").handler({
      task_id: "tsk_1",
      description: "stuck",
    });
    expect(result.content).toEqual({ error: "task gone" });
    expect(mesh.reportBlocker).not.toHaveBeenCalled();
  });
});

describe("escalate_to_humans", () => {
  it("creates the escalation, unblocks the peer, and notifies listeners", async () => {
    const { tool, mesh, create, query } = harness();
    const result = await tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "stuck on scope",
      proposals: [{ title: "A", description: "do A" }],
      open_questions: ["who owns X?", 7, null],
    });

    expect(create).toHaveBeenCalledWith({
      negotiationId: "neg_1",
      callerAgentId: "agent_x",
      summary: "stuck on scope",
      proposals: [{ title: "A", description: "do A" }],
      // non-strings are dropped so the service never sees a mixed array
      openQuestions: ["who owns X?"],
    });
    expect(mesh.unblockOnEscalate).toHaveBeenCalledWith("neg_1", "esc_1");
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("pg_notify('escalation_created'"),
      ["esc_1"],
    );
    expect(result.content).toEqual({
      escalation_id: "esc_1",
      status: "open",
      negotiation_id: "neg_1",
    });
  });

  it("omits proposals / open_questions that aren't arrays", async () => {
    const { tool, create } = harness();
    await tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "s",
      proposals: "A",
      open_questions: "who?",
    });
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      proposals: undefined,
      openQuestions: undefined,
    });
  });

  it.each([
    ["no negotiation_id", { summary: "s" }],
    ["no summary", { negotiation_id: "neg_1" }],
  ])("rejects %s", async (_l, input) => {
    const { tool, create } = harness();
    const result = await tool("escalate_to_humans").handler(input);
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "negotiation_id and summary required",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("leaves the peer blocked and sends no notify when creation fails", async () => {
    const { tool, mesh, query } = harness({
      escalationCreate: new Error("not a party to this negotiation"),
    });
    const result = await tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "s",
    });
    expect(result.content).toEqual({ error: "not a party to this negotiation" });
    expect(mesh.unblockOnEscalate).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});
