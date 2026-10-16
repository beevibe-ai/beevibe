/**
 * Mesh tool handlers — unit tests with a faked MeshServer.
 *
 * `mesh.test.ts` locks the per-tier tool inventory; the handlers
 * themselves were only exercised by the m6/m7 e2e scripts, which need
 * live Postgres plus spawned CLI subprocesses. Everything below the
 * MeshServer boundary is therefore faked, which leaves exactly the
 * adapter layer under test:
 *
 *   - the argument coercion + required-field gates each handler applies
 *     before it will spawn or block a peer's session (an LLM-written
 *     call is the only caller these ever get);
 *   - the response projections, which decide what the *other* agent
 *     sees — `projectNegotiateResponse` in particular switches shape
 *     entirely on the escalated sentinel;
 *   - the error envelope, where a `CodedMeshError` has to keep its code
 *     and meta (MAX_ROUNDS_EXCEEDED is what tells an agent to escalate
 *     rather than retry).
 *
 * `report_blocker` and `escalate_to_humans` also have ordering that
 * matters — mark-blocked before the fire-and-forget parent spawn, and
 * sentinel-unblock before the pg_notify — so those are asserted too.
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentRepository, TaskRepository } from "@beevibe/core";
import type { TaskService } from "@beevibe/core/services/task-service";
import type { EscalationService } from "@beevibe/core/services/escalation-service";
import type { Pool } from "@beevibe/core/adapters/postgres";
import { MeshMaxRoundsError } from "../mesh/types.js";
import type { McpCaller } from "./assemble.js";
import type { MeshServer } from "../mesh/server.js";
import type { AgentTool } from "./types.js";
import { buildIcMeshTools, buildTeamMeshTools, type MeshToolServices } from "./mesh.js";

const CALLER = "agent_caller";
const SID = "sess_caller0001";

const caller: McpCaller = {
  agentId: CALLER,
  source: "agent",
  hierarchyLevel: "team",
};

interface Harness {
  services: MeshToolServices;
  mesh: {
    sendAsk: ReturnType<typeof vi.fn>;
    respondAsk: ReturnType<typeof vi.fn>;
    sendNegotiate: ReturnType<typeof vi.fn>;
    respondNegotiate: ReturnType<typeof vi.fn>;
    reportBlocker: ReturnType<typeof vi.fn>;
    unblockOnEscalate: ReturnType<typeof vi.fn>;
  };
  order: string[];
  tool: (name: string) => AgentTool;
  icTool: (name: string) => AgentTool;
}

function makeHarness(overrides: Record<string, unknown> = {}): Harness {
  const order: string[] = [];
  const mesh = {
    sendAsk: vi.fn(async () => ({
      request_id: "req_1",
      from_agent_id: "agent_target",
      answer: "yes, feasible",
    })),
    respondAsk: vi.fn(),
    sendNegotiate: vi.fn(async () => ({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "counter",
      message: "how about Q3",
      counter_proposal: "ship in Q3",
    })),
    respondNegotiate: vi.fn(async () => null),
    reportBlocker: vi.fn(() => {
      order.push("spawn_parent");
    }),
    unblockOnEscalate: vi.fn(() => {
      order.push("unblock_peer");
    }),
    ...overrides,
  };
  const services = {
    mesh: mesh as unknown as MeshServer,
    agentRepo: {
      findParent: vi.fn(async () => ({ id: "agent_parent" })),
    } as unknown as AgentRepository,
    taskRepo: {} as unknown as TaskRepository,
    taskService: {
      markBlocked: vi.fn(async () => {
        order.push("mark_blocked");
      }),
    } as unknown as TaskService,
    escalationService: {
      create: vi.fn(async () => ({
        id: "esc_1",
        status: "open",
        negotiation_id: "neg_1",
      })),
    } as unknown as EscalationService,
    pool: {
      query: vi.fn(async () => {
        order.push("pg_notify");
        return { rows: [] };
      }),
    } as unknown as Pool,
  } satisfies MeshToolServices;

  const ctx = { caller, beevibeSid: SID };
  const team = buildTeamMeshTools(ctx, services);
  const ic = buildIcMeshTools(ctx, services);
  return {
    services,
    mesh: mesh as unknown as Harness["mesh"],
    order,
    tool: (name) => team.find((t) => t.name === name)!,
    icTool: (name) => ic.find((t) => t.name === name)!,
  };
}

describe("ask", () => {
  it("mints a request id, forwards the question, and projects the answer", async () => {
    const h = makeHarness();
    const res = await h.tool("ask").handler({
      target_agent_id: "agent_target",
      question: "is X feasible?",
    });
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({
      request_id: "req_1",
      from_agent_id: "agent_target",
      answer: "yes, feasible",
    });
    const [requestId, from, target, question] = h.mesh.sendAsk.mock.calls[0]!;
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect([from, target, question]).toEqual([CALLER, "agent_target", "is X feasible?"]);
  });

  it("refuses a missing target or question without spawning the peer", async () => {
    const h = makeHarness();
    for (const input of [
      {},
      { target_agent_id: "agent_target" },
      { question: "is X feasible?" },
      { target_agent_id: "", question: "is X feasible?" },
    ]) {
      const res = await h.tool("ask").handler(input);
      expect(res.isError).toBe(true);
      expect(res.content.error).toContain("required");
    }
    expect(h.mesh.sendAsk).not.toHaveBeenCalled();
  });

  it("keeps a CodedMeshError's code and meta in the envelope", async () => {
    const h = makeHarness({
      sendAsk: vi.fn(async () => {
        throw new MeshMaxRoundsError({
          negotiationId: "neg_1",
          rounds_completed: 5,
          max_rounds: 5,
        });
      }),
    });
    const res = await h.tool("ask").handler({
      target_agent_id: "agent_target",
      question: "q",
    });
    expect(res.isError).toBe(true);
    // The code is what tells the agent to escalate instead of retrying.
    expect(res.content).toMatchObject({
      error: "MAX_ROUNDS_EXCEEDED",
      negotiationId: "neg_1",
      rounds_completed: 5,
      max_rounds: 5,
    });
  });

  it("degrades a plain throw to the catch-all envelope", async () => {
    const h = makeHarness({
      sendAsk: vi.fn(async () => {
        throw new Error("target offline");
      }),
    });
    const res = await h.tool("ask").handler({
      target_agent_id: "agent_target",
      question: "q",
    });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("target offline");
  });
});

describe("respond_ask", () => {
  it("unblocks the asker with the caller stamped as responder", async () => {
    const h = makeHarness();
    const res = await h.tool("respond_ask").handler({
      request_id: "req_1",
      answer: "it is feasible",
    });
    expect(res.content).toEqual({ responded: true, request_id: "req_1" });
    expect(h.mesh.respondAsk).toHaveBeenCalledWith("req_1", {
      request_id: "req_1",
      from_agent_id: CALLER,
      answer: "it is feasible",
    });
  });

  it("is also on the IC tier and behaves identically there", async () => {
    const h = makeHarness();
    const res = await h.icTool("respond_ask").handler({
      request_id: "req_1",
      answer: "done",
    });
    expect(res.content).toEqual({ responded: true, request_id: "req_1" });
  });

  it("envelopes a throw from the resolver (asker already timed out)", async () => {
    const h = makeHarness({
      respondAsk: vi.fn(() => {
        throw new Error("no resolver registered for req_1");
      }),
    });
    const res = await h.tool("respond_ask").handler({ request_id: "req_1", answer: "a" });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("no resolver registered for req_1");
  });

  it("refuses a missing request_id or answer", async () => {
    const h = makeHarness();
    for (const input of [{}, { request_id: "req_1" }, { answer: "a" }]) {
      expect((await h.tool("respond_ask").handler(input)).isError).toBe(true);
    }
    expect(h.mesh.respondAsk).not.toHaveBeenCalled();
  });
});

describe("negotiate", () => {
  it("opens round 1 with the caller's session as originator metadata", async () => {
    const h = makeHarness();
    const res = await h.tool("negotiate").handler({
      peer_id: "agent_peer",
      proposal: "ship in Q2",
      task_id: "task_1",
    });
    expect(res.content).toEqual({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "counter",
      message: "how about Q3",
      counter_proposal: "ship in Q3",
    });
    expect(h.mesh.sendNegotiate).toHaveBeenCalledWith(CALLER, "agent_peer", "ship in Q2", {
      taskId: "task_1",
      initiatorSessionId: SID,
    });
  });

  it("treats a blank or non-string task_id as absent", async () => {
    const h = makeHarness();
    for (const task_id of [undefined, "", 42]) {
      await h.tool("negotiate").handler({
        peer_id: "agent_peer",
        proposal: "p",
        ...(task_id === undefined ? {} : { task_id }),
      });
    }
    for (const call of h.mesh.sendNegotiate.mock.calls) {
      expect(call[3]).toMatchObject({ taskId: undefined });
    }
  });

  it("refuses a missing peer_id or proposal", async () => {
    const h = makeHarness();
    for (const input of [{}, { peer_id: "agent_peer" }, { proposal: "p" }]) {
      expect((await h.tool("negotiate").handler(input)).isError).toBe(true);
    }
    expect(h.mesh.sendNegotiate).not.toHaveBeenCalled();
  });

  it("envelopes a throw from the peer spawn", async () => {
    const h = makeHarness({
      sendNegotiate: vi.fn(async () => {
        throw new Error("cannot_negotiate_with_ic");
      }),
    });
    const res = await h.tool("negotiate").handler({ peer_id: "agent_ic", proposal: "p" });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("cannot_negotiate_with_ic");
  });

  it("projects the escalated sentinel into its own shape", async () => {
    const h = makeHarness({
      sendNegotiate: vi.fn(async () => ({
        decision: "escalated",
        escalation_id: "esc_1",
        negotiation_id: "neg_1",
        message: "handed to humans",
      })),
    });
    const res = await h.tool("negotiate").handler({ peer_id: "agent_peer", proposal: "p" });
    expect(res.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_1",
      negotiation_id: "neg_1",
      message: "handed to humans",
    });
    // No from_agent_id / counter_proposal keys on the sentinel shape.
    expect(res.content).not.toHaveProperty("from_agent_id");
  });
});

describe("respond_negotiate", () => {
  it("counters and returns the peer's next reply", async () => {
    const h = makeHarness({
      respondNegotiate: vi.fn(async () => ({
        negotiation_id: "neg_1",
        from_agent_id: "agent_peer",
        decision: "accept",
        message: "Q3 works",
        counter_proposal: undefined,
      })),
    });
    const res = await h.tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "Q3 then",
      counter_proposal: "ship in Q3",
    });
    expect(res.content).toMatchObject({ decision: "accept", message: "Q3 works" });
    // The round number is the server's business; agents never pass one.
    expect(h.mesh.respondNegotiate).toHaveBeenCalledWith(
      "neg_1",
      {
        negotiation_id: "neg_1",
        from_agent_id: CALLER,
        decision: "counter",
        message: "Q3 then",
        counter_proposal: "ship in Q3",
      },
      SID,
    );
  });

  it("reports terminal when accept/reject resolves the negotiation", async () => {
    const h = makeHarness();
    for (const decision of ["accept", "reject"]) {
      const res = await h.tool("respond_negotiate").handler({
        negotiation_id: "neg_1",
        decision,
        message: "final",
      });
      expect(res.isError).toBeUndefined();
      expect(res.content).toEqual({ negotiation_id: "neg_1", decision, terminal: true });
    }
  });

  it("requires a counter_proposal when the decision is counter", async () => {
    const h = makeHarness();
    const res = await h.tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "not this",
    });
    expect(res.isError).toBe(true);
    expect(res.content.error).toContain("counter_proposal required");
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("rejects a decision outside counter / accept / reject", async () => {
    const h = makeHarness();
    for (const decision of [undefined, "", "maybe", "ACCEPT", 1]) {
      const res = await h.tool("respond_negotiate").handler({
        negotiation_id: "neg_1",
        message: "m",
        ...(decision === undefined ? {} : { decision }),
      });
      expect(res.isError).toBe(true);
      expect(res.content.error).toContain("decision must be one of");
    }
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("refuses a missing negotiation_id or message before validating the decision", async () => {
    const h = makeHarness();
    for (const input of [
      { decision: "accept", message: "m" },
      { negotiation_id: "neg_1", decision: "accept" },
    ]) {
      const res = await h.tool("respond_negotiate").handler(input);
      expect(res.isError).toBe(true);
      expect(res.content.error).toContain("negotiation_id and message required");
    }
  });

  it("surfaces MAX_ROUNDS_EXCEEDED so the agent knows to escalate", async () => {
    const h = makeHarness({
      respondNegotiate: vi.fn(async () => {
        throw new MeshMaxRoundsError({
          negotiationId: "neg_1",
          rounds_completed: 5,
          max_rounds: 5,
        });
      }),
    });
    const res = await h.tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "c",
    });
    expect(res.content).toMatchObject({ error: "MAX_ROUNDS_EXCEEDED", max_rounds: 5 });
  });
});

describe("report_blocker", () => {
  it("marks the task blocked before spawning the parent", async () => {
    const h = makeHarness();
    const res = await h.tool("report_blocker").handler({
      task_id: "task_1",
      description: "the API key is missing",
    });
    expect(res.content).toEqual({
      reported: true,
      parent_agent_id: "agent_parent",
      task_id: "task_1",
    });
    // The parent's session reads the blocked row, so the write comes first.
    expect(h.order).toEqual(["mark_blocked", "spawn_parent"]);
    expect(h.services.taskService.markBlocked).toHaveBeenCalledWith(
      "task_1",
      CALLER,
      "the API key is missing",
    );
    expect(h.mesh.reportBlocker).toHaveBeenCalledWith(
      "agent_parent",
      CALLER,
      "task_1",
      "the API key is missing",
    );
  });

  it("refuses a top-level caller with no parent, and writes nothing", async () => {
    const h = makeHarness();
    vi.mocked(h.services.agentRepo.findParent).mockResolvedValue(undefined);

    const res = await h.tool("report_blocker").handler({
      task_id: "task_1",
      description: "stuck",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "no_parent_to_block" });
    expect(res.content.message).toContain("escalate_to_humans");
    expect(h.order).toEqual([]);
  });

  it("refuses a missing task_id or description before looking up the parent", async () => {
    const h = makeHarness();
    for (const input of [{}, { task_id: "task_1" }, { description: "stuck" }]) {
      expect((await h.tool("report_blocker").handler(input)).isError).toBe(true);
    }
    expect(h.services.agentRepo.findParent).not.toHaveBeenCalled();
  });

  it("surfaces a markBlocked failure instead of spawning the parent", async () => {
    const h = makeHarness();
    vi.mocked(h.services.taskService.markBlocked).mockRejectedValue(
      new Error("task not found"),
    );

    const res = await h.tool("report_blocker").handler({
      task_id: "task_gone",
      description: "stuck",
    });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("task not found");
    expect(h.mesh.reportBlocker).not.toHaveBeenCalled();
  });

  it("is on the IC tier too", async () => {
    const h = makeHarness();
    const res = await h.icTool("report_blocker").handler({
      task_id: "task_1",
      description: "stuck",
    });
    expect(res.content).toMatchObject({ reported: true });
  });
});

describe("escalate_to_humans", () => {
  it("creates the escalation, unblocks the peer, then notifies", async () => {
    const h = makeHarness();
    const res = await h.tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "We're stuck on the ship date.",
      proposals: [{ title: "Q2", description: "ship in Q2", tradeoffs: "risky" }],
      open_questions: ["is the Q2 launch contractual?"],
    });
    expect(res.content).toEqual({
      escalation_id: "esc_1",
      status: "open",
      negotiation_id: "neg_1",
    });
    // The peer's pending respond_negotiate has to get the sentinel before
    // any listener hears about the escalation.
    expect(h.order).toEqual(["unblock_peer", "pg_notify"]);
    expect(h.services.escalationService.create).toHaveBeenCalledWith({
      negotiationId: "neg_1",
      callerAgentId: CALLER,
      summary: "We're stuck on the ship date.",
      proposals: [{ title: "Q2", description: "ship in Q2", tradeoffs: "risky" }],
      openQuestions: ["is the Q2 launch contractual?"],
    });
    expect(h.mesh.unblockOnEscalate).toHaveBeenCalledWith("neg_1", "esc_1");
    expect(vi.mocked(h.services.pool.query).mock.calls[0]).toEqual([
      "SELECT pg_notify('escalation_created', $1)",
      ["esc_1"],
    ]);
  });

  it("treats non-array proposals / open_questions as absent and filters non-strings", async () => {
    const h = makeHarness();
    await h.tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "stuck",
      proposals: "just one",
      open_questions: ["real question", 42, null],
    });
    expect(vi.mocked(h.services.escalationService.create).mock.calls[0]![0]).toMatchObject({
      proposals: undefined,
      openQuestions: ["real question"],
    });
  });

  it("refuses a missing negotiation_id or summary", async () => {
    const h = makeHarness();
    for (const input of [{}, { negotiation_id: "neg_1" }, { summary: "stuck" }]) {
      expect((await h.tool("escalate_to_humans").handler(input)).isError).toBe(true);
    }
    expect(h.services.escalationService.create).not.toHaveBeenCalled();
  });

  it("surfaces a create failure without unblocking the peer", async () => {
    const h = makeHarness();
    vi.mocked(h.services.escalationService.create).mockRejectedValue(
      new Error("negotiation already escalated"),
    );

    const res = await h.tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "stuck",
    });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("negotiation already escalated");
    expect(h.order).toEqual([]);
  });
});
