/**
 * Mesh tool tests — IC vs team tier gating, plus per-handler behavior.
 *
 * The tier blocks lock the static inventory: the exact tool *names* each
 * tier gets, so future skill-loader work can rely on the surface being
 * stable.
 *
 * The handler blocks cover what each tool owns on its own: input
 * coercion, the required-field and decision guards, the response
 * projections, and the error envelope. Every service dependency is a
 * recording fake, so none of this needs Postgres or a spawned CLI — the
 * m6/m7 e2e scripts still cover the wired-up flows end to end.
 */
import { describe, expect, it, vi } from "vitest";
import type { ResolvedCaller } from "@beevibe/core/auth";
import type { AgentRepository, TaskRepository } from "@beevibe/core";
import type { TaskService } from "@beevibe/core/services/task-service";
import type { EscalationService } from "@beevibe/core/services/escalation-service";
import type { Pool } from "@beevibe/core/adapters/postgres";
import { MeshCapacityError } from "../mesh/types.js";
import type { MeshServer } from "../mesh/server.js";
import type { AgentTool } from "./types.js";
import type { McpCaller } from "./assemble.js";
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

// ── Handler behavior ─────────────────────────────────────────────────────

const TEAM_CALLER: McpCaller = {
  agentId: "agent_x",
  source: "agent",
  hierarchyLevel: "team",
};

interface MeshHarness {
  services: MeshToolServices;
  calls: Array<{ fn: string; args: unknown[] }>;
  tool: (name: string) => AgentTool;
}

/**
 * Recording fakes for the whole MeshToolServices surface. Any entry in
 * `impl` replaces the default return (or throws, if the function throws).
 */
function meshHarness(
  impl: Partial<Record<string, (...args: unknown[]) => unknown>> = {},
  caller: McpCaller = TEAM_CALLER,
): MeshHarness {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const record =
    (fn: string, fallback: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      calls.push({ fn, args });
      return (impl[fn] ?? fallback)(...args);
    };

  const mesh = {
    sendAsk: vi.fn(
      record("sendAsk", (requestId, _from, to) => ({
        request_id: requestId,
        from_agent_id: to,
        answer: "yes, feasible",
      })),
    ),
    respondAsk: vi.fn(record("respondAsk", () => undefined)),
    sendNegotiate: vi.fn(
      record("sendNegotiate", (_from, peer) => ({
        negotiation_id: "neg_1",
        from_agent_id: peer,
        decision: "accept",
        message: "works for me",
      })),
    ),
    respondNegotiate: vi.fn(
      record("respondNegotiate", (negId) => ({
        negotiation_id: negId,
        from_agent_id: "agent_peer",
        decision: "counter",
        message: "how about this",
        counter_proposal: "do it Tuesday",
      })),
    ),
    reportBlocker: vi.fn(record("reportBlocker", () => undefined)),
    unblockOnEscalate: vi.fn(record("unblockOnEscalate", () => undefined)),
  } as unknown as MeshServer;

  const agentRepo = {
    findParent: vi.fn(record("findParent", () => ({ id: "agent_parent" }))),
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
    query: vi.fn(record("poolQuery", () => ({ rows: [] }))),
  } as unknown as Pool;

  const services = {
    mesh,
    agentRepo,
    taskRepo: {} as unknown as TaskRepository,
    taskService,
    escalationService,
    pool,
  } satisfies MeshToolServices;

  const ctx = { caller, beevibeSid: "ses_x" };
  const built = [
    ...buildTeamMeshTools(ctx, services),
    ...buildIcMeshTools(ctx, services),
  ];

  return {
    services,
    calls,
    tool: (name) => {
      const found = built.find((t) => t.name === name);
      if (!found) throw new Error(`no mesh tool named ${name}`);
      return found;
    },
  };
}

function argsOf(h: MeshHarness, fn: string): unknown[] {
  const call = h.calls.find((c) => c.fn === fn);
  if (!call) throw new Error(`${fn} was not called`);
  return call.args;
}

describe("ask handler", () => {
  it("sends the ask under a fresh request id and projects the answer", async () => {
    const h = meshHarness();

    const result = await h
      .tool("ask")
      .handler({ target_agent_id: "agent_b", question: "is X feasible?" });

    const [requestId, from, to, question] = argsOf(h, "sendAsk");
    expect(typeof requestId).toBe("string");
    expect(from).toBe("agent_x");
    expect(to).toBe("agent_b");
    expect(question).toBe("is X feasible?");

    expect(result.isError).toBeFalsy();
    // Only the three projected fields reach the agent.
    expect(result.content).toEqual({
      request_id: requestId,
      from_agent_id: "agent_b",
      answer: "yes, feasible",
    });
  });

  it("mints a distinct request id per call", async () => {
    const h = meshHarness();
    const ask = h.tool("ask");

    const a = await ask.handler({ target_agent_id: "agent_b", question: "q1" });
    const b = await ask.handler({ target_agent_id: "agent_b", question: "q2" });

    expect(a.content.request_id).not.toBe(b.content.request_id);
  });

  it.each([
    ["a missing target", { question: "q" }],
    ["a missing question", { target_agent_id: "agent_b" }],
    ["an empty target", { target_agent_id: "", question: "q" }],
    ["an empty question", { target_agent_id: "agent_b", question: "" }],
  ])("refuses %s without spawning anyone", async (_label, input) => {
    const h = meshHarness();

    const result = await h.tool("ask").handler(input as Record<string, unknown>);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "target_agent_id and question required",
    });
    expect(h.calls.filter((c) => c.fn === "sendAsk")).toHaveLength(0);
  });

  it("keeps a CodedMeshError's code and meta in the envelope", async () => {
    const h = meshHarness({
      sendAsk: () => {
        throw new MeshCapacityError("too many sessions", {
          agentId: "agent_b",
          running: 5,
          cap: 5,
        });
      },
    });

    const result = await h
      .tool("ask")
      .handler({ target_agent_id: "agent_b", question: "q" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "MESH_CAPACITY_EXCEEDED",
      agentId: "agent_b",
      running: 5,
      cap: 5,
      message: "too many sessions",
    });
  });

  it("degrades a plain Error to the catch-all envelope", async () => {
    const h = meshHarness({
      sendAsk: () => {
        throw new Error("ask timed out");
      },
    });

    const result = await h
      .tool("ask")
      .handler({ target_agent_id: "agent_b", question: "q" });

    expect(result.content).toEqual({ error: "ask timed out" });
  });
});

describe("respond_ask handler", () => {
  it("unblocks the asker and stamps the responder as from_agent_id", async () => {
    const h = meshHarness();

    const result = await h
      .tool("respond_ask")
      .handler({ request_id: "req_1", answer: "yes" });

    expect(argsOf(h, "respondAsk")).toEqual([
      "req_1",
      { request_id: "req_1", from_agent_id: "agent_x", answer: "yes" },
    ]);
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ responded: true, request_id: "req_1" });
  });

  it.each([
    ["a missing request_id", { answer: "yes" }],
    ["a missing answer", { request_id: "req_1" }],
    ["an empty answer", { request_id: "req_1", answer: "" }],
  ])("refuses %s", async (_label, input) => {
    const h = meshHarness();

    const result = await h
      .tool("respond_ask")
      .handler(input as Record<string, unknown>);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "request_id and answer required" });
    expect(h.calls.filter((c) => c.fn === "respondAsk")).toHaveLength(0);
  });

  it("envelopes a throw from the server", async () => {
    const h = meshHarness({
      respondAsk: () => {
        throw new Error("no waiter for req_1");
      },
    });

    const result = await h
      .tool("respond_ask")
      .handler({ request_id: "req_1", answer: "yes" });

    expect(result.content).toEqual({ error: "no waiter for req_1" });
  });
});

describe("negotiate handler", () => {
  it("sends round 1 with the caller's session as initiator", async () => {
    const h = meshHarness();

    const result = await h
      .tool("negotiate")
      .handler({ peer_id: "agent_p", proposal: "ship Friday", task_id: "task_1" });

    expect(argsOf(h, "sendNegotiate")).toEqual([
      "agent_x",
      "agent_p",
      "ship Friday",
      { taskId: "task_1", initiatorSessionId: "ses_x" },
    ]);
    expect(result.content).toEqual({
      negotiation_id: "neg_1",
      from_agent_id: "agent_p",
      decision: "accept",
      message: "works for me",
      counter_proposal: undefined,
    });
  });

  it.each([
    ["an omitted task_id", undefined],
    ["an empty task_id", ""],
    ["a non-string task_id", 7],
  ])("leaves taskId unset for %s", async (_label, taskId) => {
    const h = meshHarness();

    await h
      .tool("negotiate")
      .handler({ peer_id: "agent_p", proposal: "ship Friday", task_id: taskId });

    expect(argsOf(h, "sendNegotiate")[3]).toEqual({
      taskId: undefined,
      initiatorSessionId: "ses_x",
    });
  });

  it.each([
    ["a missing peer_id", { proposal: "p" }],
    ["a missing proposal", { peer_id: "agent_p" }],
    ["an empty peer_id", { peer_id: "", proposal: "p" }],
  ])("refuses %s", async (_label, input) => {
    const h = meshHarness();

    const result = await h
      .tool("negotiate")
      .handler(input as Record<string, unknown>);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "peer_id and proposal required" });
    expect(h.calls.filter((c) => c.fn === "sendNegotiate")).toHaveLength(0);
  });

  it("projects an escalated sentinel instead of a decision round", async () => {
    const h = meshHarness({
      sendNegotiate: () => ({
        decision: "escalated",
        escalation_id: "esc_9",
        negotiation_id: "neg_1",
        message: "handed to humans",
      }),
    });

    const result = await h
      .tool("negotiate")
      .handler({ peer_id: "agent_p", proposal: "p" });

    expect(result.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_9",
      negotiation_id: "neg_1",
      message: "handed to humans",
    });
    // The sentinel branch must not leak the peer-round fields.
    expect(result.content).not.toHaveProperty("counter_proposal");
  });

  it("envelopes a coded server refusal", async () => {
    const h = meshHarness({
      sendNegotiate: () => {
        throw new Error("cannot_negotiate_with_ic");
      },
    });

    const result = await h
      .tool("negotiate")
      .handler({ peer_id: "agent_ic", proposal: "p" });

    expect(result.content).toEqual({ error: "cannot_negotiate_with_ic" });
  });
});

describe("respond_negotiate handler", () => {
  it("counters and returns the peer's next round", async () => {
    const h = meshHarness();

    const result = await h.tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "not Friday",
      counter_proposal: "Tuesday",
    });

    // The round number is the server's business — it is not passed in.
    expect(argsOf(h, "respondNegotiate")).toEqual([
      "neg_1",
      {
        negotiation_id: "neg_1",
        from_agent_id: "agent_x",
        decision: "counter",
        message: "not Friday",
        counter_proposal: "Tuesday",
      },
      "ses_x",
    ]);
    expect(result.content).toMatchObject({
      decision: "counter",
      counter_proposal: "do it Tuesday",
    });
  });

  it.each(["accept", "reject"] as const)(
    "reports %s as terminal when the server returns null",
    async (decision) => {
      const h = meshHarness({ respondNegotiate: () => null });

      const result = await h.tool("respond_negotiate").handler({
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

  it("passes no counter_proposal on an accept", async () => {
    const h = meshHarness({ respondNegotiate: () => null });

    await h.tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "accept",
      message: "agreed",
      counter_proposal: 42,
    });

    expect(argsOf(h, "respondNegotiate")[1]).toMatchObject({
      counter_proposal: undefined,
    });
  });

  it.each([
    ["a missing negotiation_id", { decision: "accept", message: "m" }],
    ["a missing message", { negotiation_id: "neg_1", decision: "accept" }],
    ["an empty message", { negotiation_id: "neg_1", decision: "accept", message: "" }],
  ])("refuses %s", async (_label, input) => {
    const h = meshHarness();

    const result = await h
      .tool("respond_negotiate")
      .handler(input as Record<string, unknown>);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "negotiation_id and message required",
    });
    expect(h.calls.filter((c) => c.fn === "respondNegotiate")).toHaveLength(0);
  });

  it.each([
    ["an unknown decision", "defer"],
    ["a missing decision", undefined],
    ["a non-string decision", 1],
  ])("refuses %s and lists the valid ones", async (_label, decision) => {
    const h = meshHarness();

    const result = await h.tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision,
      message: "m",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "decision must be one of: counter, accept, reject",
    });
    expect(h.calls.filter((c) => c.fn === "respondNegotiate")).toHaveLength(0);
  });

  it.each([
    ["an omitted counter_proposal", undefined],
    ["an empty counter_proposal", ""],
    ["a non-string counter_proposal", 3],
  ])("requires a counter_proposal on a counter — %s", async (_label, counter) => {
    const h = meshHarness();

    const result = await h.tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: counter,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "counter_proposal required when decision='counter'",
    });
    expect(h.calls.filter((c) => c.fn === "respondNegotiate")).toHaveLength(0);
  });

  it("surfaces max_rounds_exceeded from the server", async () => {
    const h = meshHarness({
      respondNegotiate: () => {
        throw new Error("max_rounds_exceeded");
      },
    });

    const result = await h.tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "c",
    });

    expect(result.content).toEqual({ error: "max_rounds_exceeded" });
  });
});

describe("report_blocker handler", () => {
  it("marks the task blocked, then spawns the parent", async () => {
    const h = meshHarness();

    const result = await h
      .tool("report_blocker")
      .handler({ task_id: "task_1", description: "API 500s on every call" });

    expect(argsOf(h, "findParent")).toEqual(["agent_x"]);
    expect(argsOf(h, "markBlocked")).toEqual([
      "task_1",
      "agent_x",
      "API 500s on every call",
    ]);
    expect(argsOf(h, "reportBlocker")).toEqual([
      "agent_parent",
      "agent_x",
      "task_1",
      "API 500s on every call",
    ]);
    // Marking blocked has to land before the parent is woken, or the
    // parent can read a task that is not yet blocked.
    const order = h.calls.map((c) => c.fn);
    expect(order.indexOf("markBlocked")).toBeLessThan(
      order.indexOf("reportBlocker"),
    );

    expect(result.content).toEqual({
      reported: true,
      parent_agent_id: "agent_parent",
      task_id: "task_1",
    });
  });

  it("refuses a top-level agent with no parent, and touches no task", async () => {
    const h = meshHarness({ findParent: () => null });

    const result = await h
      .tool("report_blocker")
      .handler({ task_id: "task_1", description: "stuck" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "no_parent_to_block" });
    expect(String(result.content.message)).toContain("escalate_to_humans");
    expect(h.calls.filter((c) => c.fn === "markBlocked")).toHaveLength(0);
    expect(h.calls.filter((c) => c.fn === "reportBlocker")).toHaveLength(0);
  });

  it.each([
    ["a missing task_id", { description: "stuck" }],
    ["a missing description", { task_id: "task_1" }],
    ["an empty description", { task_id: "task_1", description: "" }],
  ])("refuses %s before looking up the parent", async (_label, input) => {
    const h = meshHarness();

    const result = await h
      .tool("report_blocker")
      .handler(input as Record<string, unknown>);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "task_id and description required" });
    expect(h.calls).toHaveLength(0);
  });

  it("does not spawn the parent when marking blocked fails", async () => {
    const h = meshHarness({
      markBlocked: () => {
        throw new Error("task not found");
      },
    });

    const result = await h
      .tool("report_blocker")
      .handler({ task_id: "task_1", description: "stuck" });

    expect(result.content).toEqual({ error: "task not found" });
    expect(h.calls.filter((c) => c.fn === "reportBlocker")).toHaveLength(0);
  });

  it("is reachable on the IC tier too", async () => {
    const h = meshHarness(
      {},
      { agentId: "agent_ic", source: "agent", hierarchyLevel: "ic" },
    );

    const result = await h
      .tool("report_blocker")
      .handler({ task_id: "task_1", description: "stuck" });

    expect(result.isError).toBeFalsy();
    expect(argsOf(h, "findParent")).toEqual(["agent_ic"]);
  });
});

describe("escalate_to_humans handler", () => {
  it("creates the escalation, unblocks the peer, then notifies", async () => {
    const h = meshHarness();

    const result = await h.tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "We're stuck on scope",
      proposals: [{ title: "A", description: "do A" }],
      open_questions: ["what is the deadline?"],
    });

    expect(argsOf(h, "createEscalation")).toEqual([
      {
        negotiationId: "neg_1",
        callerAgentId: "agent_x",
        summary: "We're stuck on scope",
        proposals: [{ title: "A", description: "do A" }],
        openQuestions: ["what is the deadline?"],
      },
    ]);
    expect(argsOf(h, "unblockOnEscalate")).toEqual(["neg_1", "esc_1"]);
    expect(argsOf(h, "poolQuery")).toEqual([
      expect.stringContaining("pg_notify('escalation_created'"),
      ["esc_1"],
    ]);

    const order = h.calls.map((c) => c.fn);
    expect(order.indexOf("createEscalation")).toBeLessThan(
      order.indexOf("unblockOnEscalate"),
    );

    expect(result.content).toEqual({
      escalation_id: "esc_1",
      status: "open",
      negotiation_id: "neg_1",
    });
  });

  it.each([
    ["omitted", undefined],
    ["a non-array", "A then B"],
  ])("leaves proposals and open_questions unset when %s", async (_label, value) => {
    const h = meshHarness();

    await h.tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "stuck",
      proposals: value,
      open_questions: value,
    });

    expect(argsOf(h, "createEscalation")[0]).toMatchObject({
      proposals: undefined,
      openQuestions: undefined,
    });
  });

  it("keeps only the string entries of open_questions", async () => {
    const h = meshHarness();

    await h.tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "stuck",
      open_questions: ["real question", 5, null, "another"],
    });

    expect(argsOf(h, "createEscalation")[0]).toMatchObject({
      openQuestions: ["real question", "another"],
    });
  });

  it.each([
    ["a missing negotiation_id", { summary: "stuck" }],
    ["a missing summary", { negotiation_id: "neg_1" }],
    ["an empty summary", { negotiation_id: "neg_1", summary: "" }],
  ])("refuses %s", async (_label, input) => {
    const h = meshHarness();

    const result = await h
      .tool("escalate_to_humans")
      .handler(input as Record<string, unknown>);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "negotiation_id and summary required",
    });
    expect(h.calls).toHaveLength(0);
  });

  it("does not unblock the peer when the escalation cannot be created", async () => {
    const h = meshHarness({
      createEscalation: () => {
        throw new Error("negotiation already escalated");
      },
    });

    const result = await h
      .tool("escalate_to_humans")
      .handler({ negotiation_id: "neg_1", summary: "stuck" });

    expect(result.content).toEqual({ error: "negotiation already escalated" });
    expect(h.calls.filter((c) => c.fn === "unblockOnEscalate")).toHaveLength(0);
  });

  it("envelopes a failed pg_notify after the escalation landed", async () => {
    const h = meshHarness({
      poolQuery: () => {
        throw new Error("connection terminated");
      },
    });

    const result = await h
      .tool("escalate_to_humans")
      .handler({ negotiation_id: "neg_1", summary: "stuck" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "connection terminated" });
    // The peer was already unblocked — the escalation itself is durable.
    expect(h.calls.filter((c) => c.fn === "unblockOnEscalate")).toHaveLength(1);
  });
});
