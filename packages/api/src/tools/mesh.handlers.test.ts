/**
 * Mesh tool HANDLER tests.
 *
 * `mesh.test.ts` next door locks the per-tier tool inventory and notes
 * that handler behavior is covered by the m6/m7 e2e scripts. That's true
 * of the end-to-end flow — spawning a peer's CLI and blocking on its
 * reply needs live Postgres and subprocesses — but the handlers
 * themselves are thin adapters over MeshServer and the services. Their
 * own work is argument coercion, the required/invalid-arg refusals, the
 * response projections, and the CodedMeshError envelope. All of that is
 * testable with fakes, so it's tested here rather than left to a script
 * that doesn't run in CI.
 */
import { describe, expect, it, vi } from "vitest";
import type { ResolvedCaller } from "@beevibe/core/auth";
import type { AgentRepository, TaskRepository } from "@beevibe/core";
import type { TaskService } from "@beevibe/core/services/task-service";
import type { EscalationService } from "@beevibe/core/services/escalation-service";
import type { Pool } from "@beevibe/core/adapters/postgres";
import {
  MeshCapacityError,
  MeshMaxRoundsError,
  type AskResponse,
  type NegotiateResponse,
} from "../mesh/types.js";
import type { MeshServer } from "../mesh/server.js";
import {
  buildIcMeshTools,
  buildTeamMeshTools,
  type MeshToolServices,
} from "./mesh.js";
import type { AgentTool } from "./types.js";

const caller: ResolvedCaller = {
  agentId: "agent_a",
  source: "agent",
  hierarchyLevel: "team",
};
const ctx = { caller, beevibeSid: "sess_caller" };

interface MeshStubs {
  sendAsk?: (...a: unknown[]) => Promise<unknown>;
  respondAsk?: (...a: unknown[]) => void;
  sendNegotiate?: (...a: unknown[]) => Promise<unknown>;
  respondNegotiate?: (...a: unknown[]) => Promise<unknown>;
  reportBlocker?: (...a: unknown[]) => void;
  unblockOnEscalate?: (...a: unknown[]) => void;
  findParent?: (...a: unknown[]) => Promise<unknown>;
  markBlocked?: (...a: unknown[]) => Promise<unknown>;
  createEscalation?: (...a: unknown[]) => Promise<unknown>;
  poolQuery?: (...a: unknown[]) => Promise<unknown>;
}

function harness(stubs: MeshStubs = {}) {
  const calls: Record<string, unknown[][]> = {};
  const record = (name: string, args: unknown[]) => {
    (calls[name] ??= []).push(args);
  };

  const mesh = {
    sendAsk: vi.fn(async (...a: unknown[]) => {
      record("sendAsk", a);
      return (
        (await stubs.sendAsk?.(...a)) ??
        ({
          request_id: String(a[0]),
          from_agent_id: String(a[2]),
          answer: "yes, feasible",
        } satisfies AskResponse)
      );
    }),
    respondAsk: vi.fn((...a: unknown[]) => {
      record("respondAsk", a);
      stubs.respondAsk?.(...a);
    }),
    sendNegotiate: vi.fn(async (...a: unknown[]) => {
      record("sendNegotiate", a);
      return (
        (await stubs.sendNegotiate?.(...a)) ??
        ({
          negotiation_id: "neg_1",
          from_agent_id: String(a[1]),
          decision: "accept",
          message: "works for me",
        } satisfies NegotiateResponse)
      );
    }),
    respondNegotiate: vi.fn(async (...a: unknown[]) => {
      record("respondNegotiate", a);
      return stubs.respondNegotiate
        ? await stubs.respondNegotiate(...a)
        : null;
    }),
    reportBlocker: vi.fn((...a: unknown[]) => {
      record("reportBlocker", a);
      stubs.reportBlocker?.(...a);
    }),
    unblockOnEscalate: vi.fn((...a: unknown[]) => {
      record("unblockOnEscalate", a);
      stubs.unblockOnEscalate?.(...a);
    }),
  } as unknown as MeshServer;

  const agentRepo = {
    findParent: vi.fn(async (...a: unknown[]) => {
      record("findParent", a);
      return stubs.findParent
        ? await stubs.findParent(...a)
        : { id: "agent_parent" };
    }),
  } as unknown as AgentRepository;

  const taskService = {
    markBlocked: vi.fn(async (...a: unknown[]) => {
      record("markBlocked", a);
      return stubs.markBlocked ? await stubs.markBlocked(...a) : undefined;
    }),
  } as unknown as TaskService;

  const escalationService = {
    create: vi.fn(async (...a: unknown[]) => {
      record("createEscalation", a);
      return (
        (await stubs.createEscalation?.(...a)) ?? {
          id: "esc_1",
          status: "open",
          negotiation_id: "neg_1",
        }
      );
    }),
  } as unknown as EscalationService;

  const pool = {
    query: vi.fn(async (...a: unknown[]) => {
      record("poolQuery", a);
      return stubs.poolQuery ? await stubs.poolQuery(...a) : { rows: [] };
    }),
  } as unknown as Pool;

  const services = {
    mesh,
    agentRepo,
    taskRepo: {} as unknown as TaskRepository,
    taskService,
    escalationService,
    pool,
  } satisfies MeshToolServices;

  const byName = new Map<string, AgentTool>(
    buildTeamMeshTools(ctx, services).map((t) => [t.name, t]),
  );
  const tool = (name: string): AgentTool => {
    const t = byName.get(name);
    if (!t) throw new Error(`no tool ${name}`);
    return t;
  };

  return { services, calls, tool };
}

describe("ask", () => {
  it("mints a uuid request id and forwards caller, target, question", async () => {
    const h = harness();
    const out = await h
      .tool("ask")
      .handler({ target_agent_id: "agent_b", question: "is X feasible?" });

    const [requestId, from, target, question] = h.calls.sendAsk?.[0] ?? [];
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect([from, target, question]).toEqual([
      "agent_a",
      "agent_b",
      "is X feasible?",
    ]);
    expect(out.isError).toBeUndefined();
  });

  it("mints a distinct request id per call", async () => {
    const h = harness();
    const t = h.tool("ask");
    await t.handler({ target_agent_id: "agent_b", question: "q1" });
    await t.handler({ target_agent_id: "agent_b", question: "q2" });

    expect(h.calls.sendAsk?.[0]?.[0]).not.toBe(h.calls.sendAsk?.[1]?.[0]);
  });

  it("projects only request_id, from_agent_id, answer", async () => {
    const h = harness({
      sendAsk: async () => ({
        request_id: "req_1",
        from_agent_id: "agent_b",
        answer: "yes",
        internal_trace: "should not leak",
      }),
    });
    const out = await h
      .tool("ask")
      .handler({ target_agent_id: "agent_b", question: "q" });

    expect(out.content).toEqual({
      request_id: "req_1",
      from_agent_id: "agent_b",
      answer: "yes",
    });
  });

  it.each([
    ["no target", { question: "q" }],
    ["no question", { target_agent_id: "agent_b" }],
    ["empty target", { target_agent_id: "", question: "q" }],
    ["empty question", { target_agent_id: "agent_b", question: "" }],
  ])("refuses %s without spawning the peer", async (_label, input) => {
    const h = harness();
    const out = await h.tool("ask").handler(input);

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({
      error: "target_agent_id and question required",
    });
    expect(h.calls.sendAsk).toBeUndefined();
  });

  it("surfaces a CodedMeshError's code and meta", async () => {
    const h = harness({
      sendAsk: async () => {
        throw new MeshCapacityError("at cap", {
          agentId: "agent_b",
          running: 3,
          cap: 3,
        });
      },
    });
    const out = await h
      .tool("ask")
      .handler({ target_agent_id: "agent_b", question: "q" });

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({
      error: "MESH_CAPACITY_EXCEEDED",
      agentId: "agent_b",
      running: 3,
      cap: 3,
      message: "at cap",
    });
  });

  it("degrades a plain Error to the catch-all envelope", async () => {
    const h = harness({
      sendAsk: async () => {
        throw new Error("peer never responded");
      },
    });
    const out = await h
      .tool("ask")
      .handler({ target_agent_id: "agent_b", question: "q" });

    expect(out.content).toEqual({ error: "peer never responded" });
  });
});

describe("respond_ask", () => {
  it("stamps the responder from context and confirms synchronously", async () => {
    const h = harness();
    const out = await h
      .tool("respond_ask")
      .handler({ request_id: "req_1", answer: "here's the context" });

    expect(h.calls.respondAsk?.[0]).toEqual([
      "req_1",
      {
        request_id: "req_1",
        from_agent_id: "agent_a",
        answer: "here's the context",
      },
    ]);
    expect(out.content).toEqual({ responded: true, request_id: "req_1" });
  });

  it.each([
    ["no request_id", { answer: "a" }],
    ["no answer", { request_id: "req_1" }],
    ["empty answer", { request_id: "req_1", answer: "" }],
  ])("refuses %s", async (_label, input) => {
    const h = harness();
    const out = await h.tool("respond_ask").handler(input);

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({ error: "request_id and answer required" });
    expect(h.calls.respondAsk).toBeUndefined();
  });

  it("envelopes a throw from an unknown request id", async () => {
    const h = harness({
      respondAsk: () => {
        throw new Error("no waiter for req_gone");
      },
    });
    const out = await h
      .tool("respond_ask")
      .handler({ request_id: "req_gone", answer: "a" });

    expect(out.content).toEqual({ error: "no waiter for req_gone" });
  });
});

describe("negotiate", () => {
  it("forwards caller, peer, proposal and the initiator session", async () => {
    const h = harness();
    await h
      .tool("negotiate")
      .handler({ peer_id: "agent_b", proposal: "split the work" });

    expect(h.calls.sendNegotiate?.[0]).toEqual([
      "agent_a",
      "agent_b",
      "split the work",
      { taskId: undefined, initiatorSessionId: "sess_caller" },
    ]);
  });

  it("passes a task_id through when present", async () => {
    const h = harness();
    await h.tool("negotiate").handler({
      peer_id: "agent_b",
      proposal: "p",
      task_id: "task_7",
    });

    expect(h.calls.sendNegotiate?.[0]?.[3]).toEqual({
      taskId: "task_7",
      initiatorSessionId: "sess_caller",
    });
  });

  it.each([
    ["a non-string", 5],
    ["an empty string", ""],
  ])("drops %s task_id", async (_label, taskId) => {
    const h = harness();
    await h.tool("negotiate").handler({
      peer_id: "agent_b",
      proposal: "p",
      task_id: taskId,
    });

    expect(
      (h.calls.sendNegotiate?.[0]?.[3] as { taskId?: string }).taskId,
    ).toBeUndefined();
  });

  it("projects a normal decision with its counter_proposal", async () => {
    const h = harness({
      sendNegotiate: async () => ({
        negotiation_id: "neg_1",
        from_agent_id: "agent_b",
        decision: "counter",
        message: "not quite",
        counter_proposal: "try this instead",
      }),
    });
    const out = await h
      .tool("negotiate")
      .handler({ peer_id: "agent_b", proposal: "p" });

    expect(out.content).toEqual({
      negotiation_id: "neg_1",
      from_agent_id: "agent_b",
      decision: "counter",
      message: "not quite",
      counter_proposal: "try this instead",
    });
  });

  it("projects the escalated sentinel to its own shape", async () => {
    const h = harness({
      sendNegotiate: async () => ({
        decision: "escalated",
        escalation_id: "esc_9",
        negotiation_id: "neg_1",
        message: "handed to humans",
      }),
    });
    const out = await h
      .tool("negotiate")
      .handler({ peer_id: "agent_b", proposal: "p" });

    // The sentinel has no from_agent_id — the projection must not invent one.
    expect(out.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_9",
      negotiation_id: "neg_1",
      message: "handed to humans",
    });
    expect(out.content).not.toHaveProperty("from_agent_id");
  });

  it.each([
    ["no peer", { proposal: "p" }],
    ["no proposal", { peer_id: "agent_b" }],
    ["empty proposal", { peer_id: "agent_b", proposal: "" }],
  ])("refuses %s without spawning the peer", async (_label, input) => {
    const h = harness();
    const out = await h.tool("negotiate").handler(input);

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({ error: "peer_id and proposal required" });
    expect(h.calls.sendNegotiate).toBeUndefined();
  });

  it("surfaces the IC-target guardrail from the server", async () => {
    const h = harness({
      sendNegotiate: async () => {
        throw new Error("cannot_negotiate_with_ic");
      },
    });
    const out = await h
      .tool("negotiate")
      .handler({ peer_id: "agent_ic", proposal: "p" });

    expect(out.content).toEqual({ error: "cannot_negotiate_with_ic" });
  });
});

describe("respond_negotiate", () => {
  it("forwards the round payload and the caller's session", async () => {
    const h = harness({
      respondNegotiate: async () => ({
        negotiation_id: "neg_1",
        from_agent_id: "agent_b",
        decision: "accept",
        message: "ok",
      }),
    });
    await h.tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "how about this",
      counter_proposal: "alt plan",
    });

    expect(h.calls.respondNegotiate?.[0]).toEqual([
      "neg_1",
      {
        negotiation_id: "neg_1",
        from_agent_id: "agent_a",
        decision: "counter",
        message: "how about this",
        counter_proposal: "alt plan",
      },
      "sess_caller",
    ]);
  });

  it("reports terminal when the server returns null", async () => {
    const h = harness();
    const out = await h.tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "accept",
      message: "agreed",
    });

    expect(out.isError).toBeUndefined();
    expect(out.content).toEqual({
      negotiation_id: "neg_1",
      decision: "accept",
      terminal: true,
    });
  });

  it("projects the peer's next round when the server returns one", async () => {
    const h = harness({
      respondNegotiate: async () => ({
        negotiation_id: "neg_1",
        from_agent_id: "agent_b",
        decision: "counter",
        message: "still no",
        counter_proposal: "third option",
      }),
    });
    const out = await h.tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "c",
    });

    expect(out.content).toMatchObject({
      from_agent_id: "agent_b",
      decision: "counter",
      counter_proposal: "third option",
    });
    expect(out.content).not.toHaveProperty("terminal");
  });

  it("projects an escalated sentinel returned to the blocked side", async () => {
    const h = harness({
      respondNegotiate: async () => ({
        decision: "escalated",
        escalation_id: "esc_3",
        negotiation_id: "neg_1",
        message: "peer escalated",
      }),
    });
    const out = await h.tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "c",
    });

    expect(out.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_3",
      negotiation_id: "neg_1",
      message: "peer escalated",
    });
  });

  it.each([
    ["no negotiation_id", { decision: "accept", message: "m" }],
    ["no message", { negotiation_id: "neg_1", decision: "accept" }],
    ["an empty message", { negotiation_id: "neg_1", decision: "accept", message: "" }],
  ])("refuses %s", async (_label, input) => {
    const h = harness();
    const out = await h.tool("respond_negotiate").handler(input);

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({
      error: "negotiation_id and message required",
    });
    expect(h.calls.respondNegotiate).toBeUndefined();
  });

  it.each([
    ["an unknown decision", "maybe"],
    ["a missing decision", undefined],
  ])("refuses %s and names the valid set", async (_label, decision) => {
    const h = harness();
    const out = await h.tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision,
      message: "m",
    });

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({
      error: "decision must be one of: counter, accept, reject",
    });
    expect(h.calls.respondNegotiate).toBeUndefined();
  });

  it("requires counter_proposal when countering", async () => {
    const h = harness();
    const out = await h.tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
    });

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({
      error: "counter_proposal required when decision='counter'",
    });
    expect(h.calls.respondNegotiate).toBeUndefined();
  });

  it.each(["accept", "reject"])(
    "does not require counter_proposal for %s",
    async (decision) => {
      const h = harness();
      const out = await h.tool("respond_negotiate").handler({
        negotiation_id: "neg_1",
        decision,
        message: "m",
      });

      expect(out.isError).toBeUndefined();
      expect(h.calls.respondNegotiate).toHaveLength(1);
    },
  );

  it("surfaces max_rounds_exceeded with its round meta", async () => {
    const h = harness({
      respondNegotiate: async () => {
        throw new MeshMaxRoundsError({
          negotiationId: "neg_1",
          rounds_completed: 5,
          max_rounds: 5,
        });
      },
    });
    const out = await h.tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "c",
    });

    expect(out.isError).toBe(true);
    expect(out.content).toMatchObject({
      error: "MAX_ROUNDS_EXCEEDED",
      negotiationId: "neg_1",
      rounds_completed: 5,
      max_rounds: 5,
    });
    expect(String(out.content.message)).toContain("escalate_to_humans");
  });
});

describe("report_blocker", () => {
  it("marks the task blocked, then spawns the parent, in that order", async () => {
    const order: string[] = [];
    const h = harness({
      markBlocked: async () => {
        order.push("markBlocked");
      },
      reportBlocker: () => {
        order.push("reportBlocker");
      },
    });
    const out = await h.tool("report_blocker").handler({
      task_id: "task_1",
      description: "the API key is missing",
    });

    expect(h.calls.findParent?.[0]).toEqual(["agent_a"]);
    expect(h.calls.markBlocked?.[0]).toEqual([
      "task_1",
      "agent_a",
      "the API key is missing",
    ]);
    expect(h.calls.reportBlocker?.[0]).toEqual([
      "agent_parent",
      "agent_a",
      "task_1",
      "the API key is missing",
    ]);
    // The task must be blocked before the parent is woken, or the parent
    // can read a still-unblocked task.
    expect(order).toEqual(["markBlocked", "reportBlocker"]);
    expect(out.content).toEqual({
      reported: true,
      parent_agent_id: "agent_parent",
      task_id: "task_1",
    });
  });

  it("refuses for a top-level agent and points at the alternatives", async () => {
    const h = harness({ findParent: async () => null });
    const out = await h
      .tool("report_blocker")
      .handler({ task_id: "task_1", description: "stuck" });

    expect(out.isError).toBe(true);
    expect(out.content.error).toBe("no_parent_to_block");
    expect(String(out.content.message)).toContain("escalate_to_humans");
    // Nothing was mutated — the task stays unblocked.
    expect(h.calls.markBlocked).toBeUndefined();
    expect(h.calls.reportBlocker).toBeUndefined();
  });

  it.each([
    ["no task_id", { description: "d" }],
    ["no description", { task_id: "task_1" }],
    ["an empty description", { task_id: "task_1", description: "" }],
  ])("refuses %s before looking up the parent", async (_label, input) => {
    const h = harness();
    const out = await h.tool("report_blocker").handler(input);

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({ error: "task_id and description required" });
    expect(h.calls.findParent).toBeUndefined();
  });

  it("does not spawn the parent when markBlocked fails", async () => {
    const h = harness({
      markBlocked: async () => {
        throw new Error("task task_1 not found");
      },
    });
    const out = await h
      .tool("report_blocker")
      .handler({ task_id: "task_1", description: "d" });

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({ error: "task task_1 not found" });
    expect(h.calls.reportBlocker).toBeUndefined();
  });
});

describe("escalate_to_humans", () => {
  it("creates the escalation, unblocks the peer, then notifies", async () => {
    const order: string[] = [];
    const h = harness({
      createEscalation: async () => {
        order.push("create");
        return { id: "esc_1", status: "open", negotiation_id: "neg_1" };
      },
      unblockOnEscalate: () => order.push("unblock"),
      poolQuery: async () => {
        order.push("notify");
        return { rows: [] };
      },
    });
    const out = await h.tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "We're stuck on X",
      proposals: [{ title: "A", description: "do A" }],
      open_questions: ["is B acceptable?"],
    });

    expect(h.calls.createEscalation?.[0]?.[0]).toEqual({
      negotiationId: "neg_1",
      callerAgentId: "agent_a",
      summary: "We're stuck on X",
      proposals: [{ title: "A", description: "do A" }],
      openQuestions: ["is B acceptable?"],
    });
    // The peer has to be unblocked with the real escalation id, so the
    // create must come first.
    expect(h.calls.unblockOnEscalate?.[0]).toEqual(["neg_1", "esc_1"]);
    expect(order).toEqual(["create", "unblock", "notify"]);
    expect(out.content).toEqual({
      escalation_id: "esc_1",
      status: "open",
      negotiation_id: "neg_1",
    });
  });

  it("pg_notifies escalation_created with the new id", async () => {
    const h = harness();
    await h.tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "s",
    });

    const [sql, params] = h.calls.poolQuery?.[0] ?? [];
    expect(String(sql)).toContain("pg_notify('escalation_created', $1)");
    expect(params).toEqual(["esc_1"]);
  });

  it("omits proposals and open_questions when they aren't arrays", async () => {
    const h = harness();
    await h.tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "s",
      proposals: "not an array",
      open_questions: 3,
    });

    expect(h.calls.createEscalation?.[0]?.[0]).toMatchObject({
      proposals: undefined,
      openQuestions: undefined,
    });
  });

  it("keeps only the string open_questions", async () => {
    const h = harness();
    await h.tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "s",
      open_questions: ["real question", 7, null, "another"],
    });

    expect(
      (h.calls.createEscalation?.[0]?.[0] as { openQuestions?: string[] })
        .openQuestions,
    ).toEqual(["real question", "another"]);
  });

  it.each([
    ["no negotiation_id", { summary: "s" }],
    ["no summary", { negotiation_id: "neg_1" }],
    ["an empty summary", { negotiation_id: "neg_1", summary: "" }],
  ])("refuses %s", async (_label, input) => {
    const h = harness();
    const out = await h.tool("escalate_to_humans").handler(input);

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({
      error: "negotiation_id and summary required",
    });
    expect(h.calls.createEscalation).toBeUndefined();
  });

  it("does not unblock the peer when the escalation can't be created", async () => {
    const h = harness({
      createEscalation: async () => {
        throw new Error("negotiation already escalated");
      },
    });
    const out = await h.tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "s",
    });

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({ error: "negotiation already escalated" });
    expect(h.calls.unblockOnEscalate).toBeUndefined();
    expect(h.calls.poolQuery).toBeUndefined();
  });

  it("reports a failed notify rather than a false success", async () => {
    // The escalation row and the peer unblock both landed, but the agent
    // is told the call failed. Worth pinning: it's the one step whose
    // failure leaves committed state behind.
    const h = harness({
      poolQuery: async () => {
        throw new Error("connection terminated");
      },
    });
    const out = await h.tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "s",
    });

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({ error: "connection terminated" });
    expect(h.calls.unblockOnEscalate).toHaveLength(1);
  });
});

describe("IC tier handlers", () => {
  it("binds the same working handlers the team tier gets", async () => {
    const h = harness();
    const icTools = buildIcMeshTools(ctx, h.services);
    const respondAsk = icTools.find((t) => t.name === "respond_ask");

    const out = await respondAsk?.handler({
      request_id: "req_1",
      answer: "from the IC",
    });

    expect(out?.content).toEqual({ responded: true, request_id: "req_1" });
    expect(h.calls.respondAsk?.[0]?.[1]).toMatchObject({
      from_agent_id: "agent_a",
      answer: "from the IC",
    });
  });
});
