/**
 * Mesh tool *handler* behavior — the complement to mesh.test.ts, which
 * locks the per-tier tool inventory.
 *
 * The handlers are adapters over MeshServer / TaskService /
 * EscalationService: they validate args, project the service's reply
 * down to the agent-visible fields, and map a throw to an error
 * envelope. The mesh *flows* (real spawns, real blocking) need Postgres
 * and live CLI subprocesses and stay with the m6/m7 e2e scripts; the
 * adapter logic here needs neither, so fakes cover it.
 *
 * Two things these pin deliberately:
 *   - the projections. `ask` and `negotiate` return service objects with
 *     more fields than the agent should see; the projection is the wire
 *     contract, so a widened one is a leak.
 *   - the `from_agent_id` on every outbound payload, which must come
 *     from the resolved caller and never from tool input.
 */
import { describe, expect, it, vi } from "vitest";
import type { ResolvedCaller } from "@beevibe/core/auth";
import type { AgentRepository, TaskRepository } from "@beevibe/core";
import type { TaskService } from "@beevibe/core/services/task-service";
import type { EscalationService } from "@beevibe/core/services/escalation-service";
import type { Pool } from "@beevibe/core/adapters/postgres";
import { MeshCapacityError } from "../mesh/types.js";
import type { MeshServer } from "../mesh/server.js";
import {
  buildIcMeshTools,
  buildTeamMeshTools,
  type MeshToolContext,
  type MeshToolServices,
} from "./mesh.js";

const CALLER: ResolvedCaller = {
  agentId: "agent_caller",
  source: "agent",
  hierarchyLevel: "team",
};
const CTX: MeshToolContext = { caller: CALLER, beevibeSid: "ses_caller" };

/** Named so each spy keeps its own type under noUncheckedIndexedAccess. */
interface MeshSpies {
  sendAsk: ReturnType<typeof vi.fn>;
  respondAsk: ReturnType<typeof vi.fn>;
  sendNegotiate: ReturnType<typeof vi.fn>;
  respondNegotiate: ReturnType<typeof vi.fn>;
  reportBlocker: ReturnType<typeof vi.fn>;
  unblockOnEscalate: ReturnType<typeof vi.fn>;
}

interface Fakes {
  services: MeshToolServices;
  mesh: MeshSpies;
  queries: unknown[][];
}

function fakes(
  opts: {
    askResponse?: unknown;
    negotiateResponse?: unknown;
    respondNegotiateResult?: unknown;
    parent?: { id: string } | null;
    escalation?: Record<string, unknown>;
    throws?: unknown;
  } = {},
): Fakes {
  const boom = (fallback: unknown) => () => {
    if (opts.throws) throw opts.throws;
    return fallback;
  };

  const mesh: MeshSpies = {
    sendAsk: vi.fn(async () =>
      boom(
        opts.askResponse ?? {
          request_id: "req_1",
          from_agent_id: "agent_target",
          answer: "yes, feasible",
        },
      )(),
    ),
    respondAsk: vi.fn(() => boom(undefined)()),
    sendNegotiate: vi.fn(async () =>
      boom(
        opts.negotiateResponse ?? {
          negotiation_id: "neg_1",
          from_agent_id: "agent_peer",
          decision: "accept",
          message: "works for me",
          counter_proposal: undefined,
        },
      )(),
    ),
    respondNegotiate: vi.fn(async () =>
      boom(opts.respondNegotiateResult ?? null)(),
    ),
    reportBlocker: vi.fn(() => boom(undefined)()),
    unblockOnEscalate: vi.fn(() => boom(undefined)()),
  };

  const agentRepo = {
    findParent: vi.fn(async () => {
      if (opts.throws) throw opts.throws;
      return opts.parent === undefined ? { id: "agent_parent" } : opts.parent;
    }),
  } as unknown as AgentRepository;

  const taskService = {
    markBlocked: vi.fn(async () => {
      if (opts.throws) throw opts.throws;
    }),
  } as unknown as TaskService;

  const escalationService = {
    create: vi.fn(async () => {
      if (opts.throws) throw opts.throws;
      return (
        opts.escalation ?? {
          id: "esc_1",
          status: "open",
          negotiation_id: "neg_1",
        }
      );
    }),
  } as unknown as EscalationService;

  const queries: unknown[][] = [];
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      queries.push([sql, params]);
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
  };
}

function teamTool(f: Fakes, name: string, ctx = CTX) {
  const tool = buildTeamMeshTools(ctx, f.services).find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
}

// ── ask ──────────────────────────────────────────────────────────────────

describe("ask handler", () => {
  it("sends the ask as the resolved caller and projects the reply", async () => {
    const f = fakes();
    const result = await teamTool(f, "ask").handler({
      target_agent_id: "agent_target",
      question: "is X feasible?",
    });

    expect(f.mesh.sendAsk).toHaveBeenCalledTimes(1);
    const [requestId, from, target, question] =
      f.mesh.sendAsk.mock.calls[0] ?? [];
    expect(from).toBe("agent_caller");
    expect(target).toBe("agent_target");
    expect(question).toBe("is X feasible?");
    // A fresh uuid per ask is what correlates the response.
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(result.content).toEqual({
      request_id: "req_1",
      from_agent_id: "agent_target",
      answer: "yes, feasible",
    });
  });

  it("mints a distinct request id per call", async () => {
    const f = fakes();
    const tool = teamTool(f, "ask");
    await tool.handler({ target_agent_id: "a", question: "q" });
    await tool.handler({ target_agent_id: "a", question: "q" });

    const first = f.mesh.sendAsk.mock.calls[0]?.[0];
    const second = f.mesh.sendAsk.mock.calls[1]?.[0];
    expect(first).not.toBe(second);
  });

  it("projects away any extra fields the service returns", async () => {
    // The ask response row carries internal columns; only the three
    // projected fields are part of the agent-facing contract.
    const f = fakes({
      askResponse: {
        request_id: "req_1",
        from_agent_id: "agent_target",
        answer: "yes",
        internal_session_id: "ses_secret",
        created_at: "2026-01-01",
      },
    });
    const result = await teamTool(f, "ask").handler({
      target_agent_id: "agent_target",
      question: "q",
    });

    expect(Object.keys(result.content).sort()).toEqual([
      "answer",
      "from_agent_id",
      "request_id",
    ]);
  });

  it("requires both target_agent_id and question", async () => {
    for (const input of [
      {},
      { target_agent_id: "agent_target" },
      { question: "q" },
      { target_agent_id: "", question: "q" },
      { target_agent_id: "agent_target", question: "" },
    ]) {
      const f = fakes();
      const result = await teamTool(f, "ask").handler(input);

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({
        error: "target_agent_id and question required",
      });
      expect(f.mesh.sendAsk).not.toHaveBeenCalled();
    }
  });
});

// ── respond_ask ──────────────────────────────────────────────────────────

describe("respond_ask handler", () => {
  it("stamps the answer with the caller's own agent id", async () => {
    // The responder cannot answer on another agent's behalf, even by
    // passing from_agent_id in the input.
    const f = fakes();
    const result = await teamTool(f, "respond_ask").handler({
      request_id: "req_1",
      answer: "yes",
      from_agent_id: "agent_impostor",
    });

    expect(f.mesh.respondAsk).toHaveBeenCalledWith("req_1", {
      request_id: "req_1",
      from_agent_id: "agent_caller",
      answer: "yes",
    });
    expect(result.content).toEqual({ responded: true, request_id: "req_1" });
  });

  it("requires both request_id and answer", async () => {
    for (const input of [
      {},
      { request_id: "req_1" },
      { answer: "yes" },
      { request_id: "", answer: "yes" },
    ]) {
      const f = fakes();
      const result = await teamTool(f, "respond_ask").handler(input);

      expect(result.isError).toBe(true);
      expect(f.mesh.respondAsk).not.toHaveBeenCalled();
    }
  });
});

// ── negotiate ────────────────────────────────────────────────────────────

describe("negotiate handler", () => {
  it("sends round 1 with the caller's id, session and optional task", async () => {
    const f = fakes();
    const result = await teamTool(f, "negotiate").handler({
      peer_id: "agent_peer",
      proposal: "ship behind a flag",
      task_id: "task_7",
    });

    expect(f.mesh.sendNegotiate).toHaveBeenCalledWith(
      "agent_caller",
      "agent_peer",
      "ship behind a flag",
      { taskId: "task_7", initiatorSessionId: "ses_caller" },
    );
    expect(result.content).toMatchObject({
      negotiation_id: "neg_1",
      decision: "accept",
    });
  });

  it("omits task_id when absent, blank or not a string", async () => {
    for (const task_id of [undefined, "", 7, null]) {
      const f = fakes();
      await teamTool(f, "negotiate").handler({
        peer_id: "agent_peer",
        proposal: "p",
        task_id,
      });

      expect(f.mesh.sendNegotiate.mock.calls[0]?.[3]).toMatchObject({
        taskId: undefined,
      });
    }
  });

  it("projects an escalated sentinel to its own shape", async () => {
    // When the peer escalated mid-negotiation the reply is a different
    // union member; projecting it as a normal round would hand the agent
    // a decision it can't act on.
    const f = fakes({
      negotiateResponse: {
        decision: "escalated",
        escalation_id: "esc_9",
        negotiation_id: "neg_1",
        message: "handed to humans",
      },
    });
    const result = await teamTool(f, "negotiate").handler({
      peer_id: "agent_peer",
      proposal: "p",
    });

    expect(result.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_9",
      negotiation_id: "neg_1",
      message: "handed to humans",
    });
  });

  it("carries a counter_proposal through on a countered round", async () => {
    const f = fakes({
      negotiateResponse: {
        negotiation_id: "neg_1",
        from_agent_id: "agent_peer",
        decision: "counter",
        message: "not quite",
        counter_proposal: "ship next sprint",
      },
    });
    const result = await teamTool(f, "negotiate").handler({
      peer_id: "agent_peer",
      proposal: "p",
    });

    expect(result.content).toMatchObject({
      decision: "counter",
      counter_proposal: "ship next sprint",
    });
  });

  it("requires both peer_id and proposal", async () => {
    for (const input of [{}, { peer_id: "agent_peer" }, { proposal: "p" }]) {
      const f = fakes();
      const result = await teamTool(f, "negotiate").handler(input);

      expect(result.isError).toBe(true);
      expect(f.mesh.sendNegotiate).not.toHaveBeenCalled();
    }
  });
});

// ── respond_negotiate ────────────────────────────────────────────────────

describe("respond_negotiate handler", () => {
  it("sends a counter round with the caller's id and session", async () => {
    const f = fakes({
      respondNegotiateResult: {
        negotiation_id: "neg_1",
        from_agent_id: "agent_peer",
        decision: "counter",
        message: "still no",
        counter_proposal: "do Z",
      },
    });
    const result = await teamTool(f, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "how about Y",
      counter_proposal: "do Y",
    });

    expect(f.mesh.respondNegotiate).toHaveBeenCalledWith(
      "neg_1",
      {
        negotiation_id: "neg_1",
        from_agent_id: "agent_caller",
        decision: "counter",
        message: "how about Y",
        counter_proposal: "do Y",
      },
      "ses_caller",
    );
    expect(result.content).toMatchObject({ decision: "counter" });
  });

  it("reports terminal for accept and reject, where the service returns null", async () => {
    for (const decision of ["accept", "reject"]) {
      const f = fakes({ respondNegotiateResult: null });
      const result = await teamTool(f, "respond_negotiate").handler({
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
    }
  });

  it("rejects a decision outside counter/accept/reject", async () => {
    for (const decision of ["maybe", "", undefined, 7]) {
      const f = fakes();
      const result = await teamTool(f, "respond_negotiate").handler({
        negotiation_id: "neg_1",
        decision,
        message: "m",
      });

      expect(result.isError).toBe(true);
      expect(String(result.content.error)).toContain("decision must be one of");
      expect(f.mesh.respondNegotiate).not.toHaveBeenCalled();
    }
  });

  it("requires a counter_proposal when countering", async () => {
    // Countering without an alternative leaves the peer nothing to
    // respond to, so the round is refused before it is sent.
    const f = fakes();
    const result = await teamTool(f, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "no",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "counter_proposal required when decision='counter'",
    });
    expect(f.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("does not require a counter_proposal for accept or reject", async () => {
    for (const decision of ["accept", "reject"]) {
      const f = fakes({ respondNegotiateResult: null });
      const result = await teamTool(f, "respond_negotiate").handler({
        negotiation_id: "neg_1",
        decision,
        message: "m",
      });
      expect(result.isError).toBeFalsy();
    }
  });

  it("requires negotiation_id and message", async () => {
    for (const input of [
      { decision: "accept", message: "m" },
      { negotiation_id: "neg_1", decision: "accept" },
      { negotiation_id: "", decision: "accept", message: "m" },
    ]) {
      const f = fakes();
      const result = await teamTool(f, "respond_negotiate").handler(input);

      expect(result.isError).toBe(true);
      expect(f.mesh.respondNegotiate).not.toHaveBeenCalled();
    }
  });

  it("checks the ids before the decision value", async () => {
    // A caller missing both gets the id complaint, which is the one it
    // can act on without re-reading the enum.
    const f = fakes();
    const result = await teamTool(f, "respond_negotiate").handler({
      decision: "bogus",
      message: "",
    });

    expect(result.content).toMatchObject({
      error: "negotiation_id and message required",
    });
  });
});

// ── report_blocker ───────────────────────────────────────────────────────

describe("report_blocker handler", () => {
  it("marks the task blocked, then spawns the parent", async () => {
    const f = fakes();
    const result = await teamTool(f, "report_blocker").handler({
      task_id: "task_7",
      description: "npm registry unreachable",
    });

    expect(f.services.taskService.markBlocked).toHaveBeenCalledWith(
      "task_7",
      "agent_caller",
      "npm registry unreachable",
    );
    expect(f.mesh.reportBlocker).toHaveBeenCalledWith(
      "agent_parent",
      "agent_caller",
      "task_7",
      "npm registry unreachable",
    );
    expect(result.content).toEqual({
      reported: true,
      parent_agent_id: "agent_parent",
      task_id: "task_7",
    });
  });

  it("refuses with no_parent_to_block for a top-level agent", async () => {
    // Without a parent there is nobody to spawn, and marking the task
    // blocked would strand it with no one investigating.
    const f = fakes({ parent: null });
    const result = await teamTool(f, "report_blocker").handler({
      task_id: "task_7",
      description: "stuck",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "no_parent_to_block" });
    expect(f.services.taskService.markBlocked).not.toHaveBeenCalled();
    expect(f.mesh.reportBlocker).not.toHaveBeenCalled();
  });

  it("requires task_id and description", async () => {
    for (const input of [
      {},
      { task_id: "task_7" },
      { description: "stuck" },
      { task_id: "", description: "stuck" },
    ]) {
      const f = fakes();
      const result = await teamTool(f, "report_blocker").handler(input);

      expect(result.isError).toBe(true);
      expect(f.services.agentRepo.findParent).not.toHaveBeenCalled();
    }
  });

  it("is available to IC tier too", async () => {
    // ICs can't initiate coordination but must be able to escalate up.
    const f = fakes();
    const names = buildIcMeshTools(CTX, f.services).map((t) => t.name);
    expect(names).toContain("report_blocker");
  });
});

// ── escalate_to_humans ───────────────────────────────────────────────────

describe("escalate_to_humans handler", () => {
  it("creates the escalation, unblocks the peer, then notifies", async () => {
    const f = fakes();
    const result = await teamTool(f, "escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "We're stuck on X",
      proposals: [{ title: "A", description: "do A" }],
      open_questions: ["who owns X?"],
    });

    expect(f.services.escalationService.create).toHaveBeenCalledWith({
      negotiationId: "neg_1",
      callerAgentId: "agent_caller",
      summary: "We're stuck on X",
      proposals: [{ title: "A", description: "do A" }],
      openQuestions: ["who owns X?"],
    });
    // The peer is parked in a blocking respond_negotiate; without the
    // sentinel it waits for a round that will never come.
    expect(f.mesh.unblockOnEscalate).toHaveBeenCalledWith("neg_1", "esc_1");
    expect(result.content).toEqual({
      escalation_id: "esc_1",
      status: "open",
      negotiation_id: "neg_1",
    });
  });

  it("emits pg_notify('escalation_created') with the new id", async () => {
    const f = fakes();
    await teamTool(f, "escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "stuck",
    });

    expect(f.queries).toHaveLength(1);
    expect(String(f.queries[0]?.[0])).toContain("escalation_created");
    expect(f.queries[0]?.[1]).toEqual(["esc_1"]);
  });

  it("omits proposals and open_questions when they are not arrays", async () => {
    const f = fakes();
    await teamTool(f, "escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "stuck",
      proposals: "A then B",
      open_questions: "who owns X?",
    });

    expect(f.services.escalationService.create).toHaveBeenCalledWith(
      expect.objectContaining({ proposals: undefined, openQuestions: undefined }),
    );
  });

  it("drops non-string open_questions entries", async () => {
    const f = fakes();
    await teamTool(f, "escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "stuck",
      open_questions: ["who owns X?", 7, null, "when is the deadline?"],
    });

    expect(f.services.escalationService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        openQuestions: ["who owns X?", "when is the deadline?"],
      }),
    );
  });

  it("requires negotiation_id and summary", async () => {
    for (const input of [
      {},
      { negotiation_id: "neg_1" },
      { summary: "stuck" },
      { negotiation_id: "", summary: "stuck" },
    ]) {
      const f = fakes();
      const result = await teamTool(f, "escalate_to_humans").handler(input);

      expect(result.isError).toBe(true);
      expect(f.services.escalationService.create).not.toHaveBeenCalled();
    }
  });
});

// ── error envelopes ──────────────────────────────────────────────────────

describe("mesh handler error mapping", () => {
  const inputs: Record<string, Record<string, unknown>> = {
    ask: { target_agent_id: "agent_target", question: "q" },
    respond_ask: { request_id: "req_1", answer: "a" },
    negotiate: { peer_id: "agent_peer", proposal: "p" },
    respond_negotiate: {
      negotiation_id: "neg_1",
      decision: "accept",
      message: "m",
    },
    report_blocker: { task_id: "task_7", description: "stuck" },
    escalate_to_humans: { negotiation_id: "neg_1", summary: "stuck" },
  };

  for (const [name, input] of Object.entries(inputs)) {
    it(`${name} returns the catch-all envelope for a plain Error`, async () => {
      const f = fakes({ throws: new Error("pool exhausted") });
      const result = await teamTool(f, name).handler(input);

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "pool exhausted" });
    });

    it(`${name} keeps a CodedMeshError's code and meta`, async () => {
      // The code is the whole point of raising a coded error — an agent
      // over capacity should see MESH_CAPACITY_EXCEEDED and back off,
      // not a prose string it has to parse.
      const f = fakes({
        throws: new MeshCapacityError("at cap", {
          agentId: "agent_target",
          running: 3,
          cap: 3,
        }),
      });
      const result = await teamTool(f, name).handler(input);

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({
        error: "MESH_CAPACITY_EXCEEDED",
        agentId: "agent_target",
        running: 3,
        cap: 3,
        message: "at cap",
      });
    });
  }

  it("stringifies a non-Error throw", async () => {
    const f = fakes({ throws: "kaboom" });
    const result = await teamTool(f, "ask").handler(inputs.ask ?? {});

    expect(result.content).toMatchObject({ error: "kaboom" });
  });
});
