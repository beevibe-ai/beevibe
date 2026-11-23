/**
 * Mesh tool tests — tier inventory plus per-handler behavior.
 *
 * The tier inventory locks the exact tool *names* each tier gets, so
 * future skill-loader work can rely on the surface being stable.
 *
 * The handler tests below mock MeshServer and the repos, which is where
 * the handlers' own logic lives: argument coercion, the required-field
 * refusals, the decision enum guard, the terminal-vs-counter branch of
 * respond_negotiate, the response projections (which deliberately drop
 * server-internal fields before the agent sees them), and the write
 * ordering in report_blocker / escalate_to_humans. The live flows
 * themselves (real Postgres + spawned CLI subprocesses) stay with the
 * m6/m7 e2e scripts.
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentRepository, TaskRepository } from "@beevibe/core";
import type { TaskService } from "@beevibe/core/services/task-service";
import type { EscalationService } from "@beevibe/core/services/escalation-service";
import type { Pool } from "@beevibe/core/adapters/postgres";
import type { MeshServer } from "../mesh/server.js";
import { MeshCapacityError, MeshMaxRoundsError } from "../mesh/types.js";
import {
  buildIcMeshTools,
  buildTeamMeshTools,
  type MeshToolServices,
  type MeshToolContext,
} from "./mesh.js";
import type { McpCaller } from "./assemble.js";
import type { AgentTool } from "./types.js";

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

  it("declares the required fields each handler enforces at runtime", () => {
    const tools = buildTeamMeshTools(fakeCtx, fakeServices);
    const required = Object.fromEntries(
      tools.map((t) => [t.name, t.schema.required]),
    );
    expect(required).toEqual({
      ask: ["target_agent_id", "question"],
      respond_ask: ["request_id", "answer"],
      negotiate: ["peer_id", "proposal"],
      respond_negotiate: ["negotiation_id", "decision", "message"],
      report_blocker: ["task_id", "description"],
      escalate_to_humans: ["negotiation_id", "summary"],
    });
  });

  it("offers exactly counter/accept/reject as negotiation decisions", () => {
    const tools = buildTeamMeshTools(fakeCtx, fakeServices);
    const respond = tools.find((t) => t.name === "respond_negotiate")!;
    const props = respond.schema.properties as Record<
      string,
      { enum?: string[] }
    >;
    expect(props.decision?.enum).toEqual(["counter", "accept", "reject"]);
  });
});

// ── handler harness ──────────────────────────────────────────────────────

interface MeshMocks {
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
  order: string[];
}

function harness(
  overrides: Partial<Record<keyof MeshMocks, unknown>> & {
    ctx?: Partial<MeshToolContext>;
  } = {},
): { tool: (name: string) => AgentTool; mocks: MeshMocks } {
  const order: string[] = [];
  const track =
    <T>(label: string, impl: (...a: never[]) => T) =>
    (...args: never[]): T => {
      order.push(label);
      return impl(...args);
    };

  const mocks = {
    order,
    sendAsk: vi.fn(
      (overrides.sendAsk as never) ??
        track("mesh.sendAsk", () =>
          Promise.resolve({
            request_id: "req_1",
            from_agent_id: "agent_target",
            answer: "yes, feasible",
            // server-internal field the projection must drop
            internal_trace_id: "trace_secret",
          }),
        ),
    ),
    respondAsk: vi.fn(
      (overrides.respondAsk as never) ?? track("mesh.respondAsk", () => undefined),
    ),
    sendNegotiate: vi.fn(
      (overrides.sendNegotiate as never) ??
        track("mesh.sendNegotiate", () =>
          Promise.resolve({
            negotiation_id: "neg_1",
            from_agent_id: "agent_peer",
            decision: "counter",
            message: "how about this instead",
            counter_proposal: "do it in two phases",
          }),
        ),
    ),
    respondNegotiate: vi.fn(
      (overrides.respondNegotiate as never) ??
        track("mesh.respondNegotiate", () =>
          Promise.resolve({
            negotiation_id: "neg_1",
            from_agent_id: "agent_peer",
            decision: "counter",
            message: "still not quite",
            counter_proposal: "three phases",
          }),
        ),
    ),
    reportBlocker: vi.fn(
      (overrides.reportBlocker as never) ??
        track("mesh.reportBlocker", () => undefined),
    ),
    unblockOnEscalate: vi.fn(
      (overrides.unblockOnEscalate as never) ??
        track("mesh.unblockOnEscalate", () => undefined),
    ),
    findParent: vi.fn(
      (overrides.findParent as never) ??
        track("agentRepo.findParent", () => Promise.resolve({ id: "agent_boss" })),
    ),
    markBlocked: vi.fn(
      (overrides.markBlocked as never) ??
        track("taskService.markBlocked", () => Promise.resolve(undefined)),
    ),
    createEscalation: vi.fn(
      (overrides.createEscalation as never) ??
        track("escalationService.create", () =>
          Promise.resolve({
            id: "esc_1",
            status: "open",
            negotiation_id: "neg_1",
          }),
        ),
    ),
    query: vi.fn(
      (overrides.query as never) ?? track("pool.query", () => Promise.resolve({ rows: [] })),
    ),
  } as unknown as MeshMocks;

  const services = {
    mesh: {
      sendAsk: mocks.sendAsk,
      respondAsk: mocks.respondAsk,
      sendNegotiate: mocks.sendNegotiate,
      respondNegotiate: mocks.respondNegotiate,
      reportBlocker: mocks.reportBlocker,
      unblockOnEscalate: mocks.unblockOnEscalate,
    } as unknown as MeshServer,
    agentRepo: { findParent: mocks.findParent } as unknown as AgentRepository,
    taskRepo: {} as unknown as TaskRepository,
    taskService: { markBlocked: mocks.markBlocked } as unknown as TaskService,
    escalationService: {
      create: mocks.createEscalation,
    } as unknown as EscalationService,
    pool: { query: mocks.query } as unknown as Pool,
  };

  const ctx: MeshToolContext = {
    caller: fakeCaller,
    beevibeSid: "ses_x",
    ...overrides.ctx,
  };
  const tools = buildTeamMeshTools(ctx, services);
  return {
    tool: (name) => tools.find((t) => t.name === name)!,
    mocks,
  };
}

describe("ask handler", () => {
  it("sends the ask with a fresh request id and the caller as sender", async () => {
    const { tool, mocks } = harness();

    const result = await tool("ask").handler({
      target_agent_id: "agent_target",
      question: "is X feasible?",
    });

    expect(mocks.sendAsk).toHaveBeenCalledTimes(1);
    const [requestId, from, target, question] = mocks.sendAsk.mock.calls[0]!;
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(from).toBe("agent_x");
    expect(target).toBe("agent_target");
    expect(question).toBe("is X feasible?");
    expect(result.isError).toBeFalsy();
  });

  it("mints a different request id per call", async () => {
    const { tool, mocks } = harness();
    await tool("ask").handler({ target_agent_id: "t", question: "q" });
    await tool("ask").handler({ target_agent_id: "t", question: "q" });
    expect(mocks.sendAsk.mock.calls[0]?.[0]).not.toBe(
      mocks.sendAsk.mock.calls[1]?.[0],
    );
  });

  it("projects the response down to the three agent-facing fields", async () => {
    const { tool } = harness();

    const result = await tool("ask").handler({
      target_agent_id: "agent_target",
      question: "q",
    });

    // Exact, not a subset — server-internal fields must not leak.
    expect(result.content).toEqual({
      request_id: "req_1",
      from_agent_id: "agent_target",
      answer: "yes, feasible",
    });
  });

  it("refuses a missing target or question without spawning the target", async () => {
    for (const input of [
      {},
      { target_agent_id: "t" },
      { question: "q" },
      { target_agent_id: "", question: "q" },
      { target_agent_id: "t", question: "" },
    ]) {
      const { tool, mocks } = harness();
      const result = await tool("ask").handler(input);
      expect(result.isError).toBe(true);
      expect(result.content.error).toBe("target_agent_id and question required");
      expect(mocks.sendAsk).not.toHaveBeenCalled();
    }
  });

  it("keeps the code and meta off a CodedMeshError", async () => {
    const { tool } = harness({
      sendAsk: () =>
        Promise.reject(
          new MeshCapacityError("too many sessions", {
            agentId: "agent_target",
            running: 5,
            cap: 5,
          }),
        ),
    });

    const result = await tool("ask").handler({
      target_agent_id: "agent_target",
      question: "q",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "MESH_CAPACITY_EXCEEDED",
      agentId: "agent_target",
      running: 5,
      cap: 5,
      message: "too many sessions",
    });
  });

  it("degrades a plain Error to the catch-all envelope", async () => {
    const { tool } = harness({
      sendAsk: () => Promise.reject(new Error("target never responded")),
    });

    const result = await tool("ask").handler({
      target_agent_id: "t",
      question: "q",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "target never responded" });
  });
});

describe("respond_ask handler", () => {
  it("delivers the answer stamped with the responder's agent id", async () => {
    const { tool, mocks } = harness();

    const result = await tool("respond_ask").handler({
      request_id: "req_1",
      answer: "yes",
    });

    expect(mocks.respondAsk).toHaveBeenCalledWith("req_1", {
      request_id: "req_1",
      from_agent_id: "agent_x",
      answer: "yes",
    });
    expect(result.content).toEqual({ responded: true, request_id: "req_1" });
  });

  it("refuses a missing request_id or answer", async () => {
    for (const input of [{}, { request_id: "r" }, { answer: "a" }]) {
      const { tool, mocks } = harness();
      const result = await tool("respond_ask").handler(input);
      expect(result.isError).toBe(true);
      expect(result.content.error).toBe("request_id and answer required");
      expect(mocks.respondAsk).not.toHaveBeenCalled();
    }
  });

  it("envelopes a throw from the server", async () => {
    const { tool } = harness({
      respondAsk: () => {
        throw new Error("no waiter for req_1");
      },
    });

    const result = await tool("respond_ask").handler({
      request_id: "req_1",
      answer: "a",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "no waiter for req_1" });
  });
});

describe("negotiate handler", () => {
  it("opens round 1 with the caller's session as originator metadata", async () => {
    const { tool, mocks } = harness();

    await tool("negotiate").handler({
      peer_id: "agent_peer",
      proposal: "ship behind a flag",
      task_id: "task_7",
    });

    expect(mocks.sendNegotiate).toHaveBeenCalledWith(
      "agent_x",
      "agent_peer",
      "ship behind a flag",
      { taskId: "task_7", initiatorSessionId: "ses_x" },
    );
  });

  it("leaves taskId undefined when task_id is absent, blank or not a string", async () => {
    for (const task_id of [undefined, "", 42]) {
      const { tool, mocks } = harness();
      await tool("negotiate").handler({
        peer_id: "p",
        proposal: "x",
        task_id,
      });
      expect(mocks.sendNegotiate.mock.calls[0]?.[3]).toMatchObject({
        taskId: undefined,
      });
    }
  });

  it("projects a counter response with the counter_proposal intact", async () => {
    const { tool } = harness();

    const result = await tool("negotiate").handler({
      peer_id: "p",
      proposal: "x",
    });

    expect(result.content).toEqual({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "counter",
      message: "how about this instead",
      counter_proposal: "do it in two phases",
    });
  });

  it("projects the escalated sentinel through its own shape", async () => {
    const { tool } = harness({
      sendNegotiate: () =>
        Promise.resolve({
          decision: "escalated",
          escalation_id: "esc_9",
          negotiation_id: "neg_1",
          message: "handed to humans",
        }),
    });

    const result = await tool("negotiate").handler({
      peer_id: "p",
      proposal: "x",
    });

    // The sentinel branch carries escalation_id and no from_agent_id.
    expect(result.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_9",
      negotiation_id: "neg_1",
      message: "handed to humans",
    });
  });

  it("refuses a missing peer_id or proposal", async () => {
    for (const input of [{}, { peer_id: "p" }, { proposal: "x" }]) {
      const { tool, mocks } = harness();
      const result = await tool("negotiate").handler(input);
      expect(result.isError).toBe(true);
      expect(result.content.error).toBe("peer_id and proposal required");
      expect(mocks.sendNegotiate).not.toHaveBeenCalled();
    }
  });

  it("surfaces the IC-target guardrail from the server", async () => {
    const { tool } = harness({
      sendNegotiate: () =>
        Promise.reject(new Error("cannot_negotiate_with_ic")),
    });

    const result = await tool("negotiate").handler({
      peer_id: "agent_ic",
      proposal: "x",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "cannot_negotiate_with_ic" });
  });
});

describe("respond_negotiate handler", () => {
  it("sends the round with the caller's id and session, letting the server number it", async () => {
    const { tool, mocks } = harness();

    await tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "not yet",
      counter_proposal: "try this",
    });

    expect(mocks.respondNegotiate).toHaveBeenCalledWith(
      "neg_1",
      {
        negotiation_id: "neg_1",
        from_agent_id: "agent_x",
        decision: "counter",
        message: "not yet",
        counter_proposal: "try this",
      },
      "ses_x",
    );
    // Round number is server-computed; the agent never passes one.
    expect(mocks.respondNegotiate.mock.calls[0]?.[1]).not.toHaveProperty(
      "round",
    );
  });

  it("reports terminal when the server returns null (accept/reject)", async () => {
    const { tool } = harness({ respondNegotiate: () => Promise.resolve(null) });

    const result = await tool("respond_negotiate").handler({
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

  it("projects the peer's next round when the negotiation continues", async () => {
    const { tool } = harness();

    const result = await tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "c",
    });

    expect(result.content).toEqual({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "counter",
      message: "still not quite",
      counter_proposal: "three phases",
    });
  });

  it("accepts reject without a counter_proposal", async () => {
    const { tool, mocks } = harness({
      respondNegotiate: () => Promise.resolve(null),
    });

    const result = await tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "reject",
      message: "no",
    });

    expect(result.isError).toBeFalsy();
    expect(mocks.respondNegotiate.mock.calls[0]?.[1]).toMatchObject({
      counter_proposal: undefined,
    });
  });

  it("requires a counter_proposal when countering", async () => {
    for (const counter_proposal of [undefined, 42]) {
      const { tool, mocks } = harness();
      const result = await tool("respond_negotiate").handler({
        negotiation_id: "neg_1",
        decision: "counter",
        message: "m",
        counter_proposal,
      });
      expect(result.isError).toBe(true);
      expect(result.content.error).toBe(
        "counter_proposal required when decision='counter'",
      );
      expect(mocks.respondNegotiate).not.toHaveBeenCalled();
    }
  });

  it("rejects a decision outside the enum", async () => {
    for (const decision of [undefined, "maybe", ""]) {
      const { tool, mocks } = harness();
      const result = await tool("respond_negotiate").handler({
        negotiation_id: "neg_1",
        decision,
        message: "m",
      });
      expect(result.isError).toBe(true);
      expect(String(result.content.error)).toContain(
        "decision must be one of",
      );
      expect(mocks.respondNegotiate).not.toHaveBeenCalled();
    }
  });

  it("refuses a missing negotiation_id or message before checking the decision", async () => {
    for (const input of [
      {},
      { negotiation_id: "neg_1" },
      { message: "m", decision: "accept" },
    ]) {
      const { tool, mocks } = harness();
      const result = await tool("respond_negotiate").handler(input);
      expect(result.isError).toBe(true);
      expect(result.content.error).toBe(
        "negotiation_id and message required",
      );
      expect(mocks.respondNegotiate).not.toHaveBeenCalled();
    }
  });

  it("surfaces max_rounds_exceeded with its meta so the agent can escalate", async () => {
    const { tool } = harness({
      respondNegotiate: () =>
        Promise.reject(
          new MeshMaxRoundsError({
            negotiationId: "neg_1",
            rounds_completed: 5,
            max_rounds: 5,
          }),
        ),
    });

    const result = await tool("respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "c",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "MAX_ROUNDS_EXCEEDED",
      negotiationId: "neg_1",
      rounds_completed: 5,
      max_rounds: 5,
      message: expect.stringContaining("escalate_to_humans"),
    });
  });
});

describe("report_blocker handler", () => {
  it("marks the task blocked before spawning the parent", async () => {
    const { tool, mocks } = harness();

    const result = await tool("report_blocker").handler({
      task_id: "task_7",
      description: "the API key is missing",
    });

    // Parent is derived server-side, then the task is marked, then the
    // parent is spawned fire-and-forget.
    expect(mocks.order).toEqual([
      "agentRepo.findParent",
      "taskService.markBlocked",
      "mesh.reportBlocker",
    ]);
    expect(mocks.findParent).toHaveBeenCalledWith("agent_x");
    expect(mocks.markBlocked).toHaveBeenCalledWith(
      "task_7",
      "agent_x",
      "the API key is missing",
    );
    expect(mocks.reportBlocker).toHaveBeenCalledWith(
      "agent_boss",
      "agent_x",
      "task_7",
      "the API key is missing",
    );
    expect(result.content).toEqual({
      reported: true,
      parent_agent_id: "agent_boss",
      task_id: "task_7",
    });
  });

  it("refuses a top-level agent with no parent, leaving the task untouched", async () => {
    const { tool, mocks } = harness({ findParent: () => Promise.resolve(null) });

    const result = await tool("report_blocker").handler({
      task_id: "task_7",
      description: "stuck",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "no_parent_to_block",
      message: expect.stringContaining("escalate_to_humans"),
    });
    expect(mocks.markBlocked).not.toHaveBeenCalled();
    expect(mocks.reportBlocker).not.toHaveBeenCalled();
  });

  it("refuses a missing task_id or description", async () => {
    for (const input of [{}, { task_id: "t" }, { description: "d" }]) {
      const { tool, mocks } = harness();
      const result = await tool("report_blocker").handler(input);
      expect(result.isError).toBe(true);
      expect(result.content.error).toBe("task_id and description required");
      expect(mocks.findParent).not.toHaveBeenCalled();
    }
  });

  it("does not spawn the parent when marking the task blocked fails", async () => {
    const { tool, mocks } = harness({
      markBlocked: () => Promise.reject(new Error("task task_7 not found")),
    });

    const result = await tool("report_blocker").handler({
      task_id: "task_7",
      description: "stuck",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "task task_7 not found" });
    expect(mocks.reportBlocker).not.toHaveBeenCalled();
  });
});

describe("escalate_to_humans handler", () => {
  it("creates the escalation, unblocks the peer, then notifies listeners", async () => {
    const { tool, mocks } = harness();

    const result = await tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "We're stuck on X; root disagreement is Y.",
      proposals: [{ title: "A", description: "do A" }],
      open_questions: ["is there a deadline?"],
    });

    expect(mocks.order).toEqual([
      "escalationService.create",
      "mesh.unblockOnEscalate",
      "pool.query",
    ]);
    expect(mocks.createEscalation).toHaveBeenCalledWith({
      negotiationId: "neg_1",
      callerAgentId: "agent_x",
      summary: "We're stuck on X; root disagreement is Y.",
      proposals: [{ title: "A", description: "do A" }],
      openQuestions: ["is there a deadline?"],
    });
    expect(mocks.unblockOnEscalate).toHaveBeenCalledWith("neg_1", "esc_1");
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("pg_notify('escalation_created'"),
      ["esc_1"],
    );
    expect(result.content).toEqual({
      escalation_id: "esc_1",
      status: "open",
      negotiation_id: "neg_1",
    });
  });

  it("omits proposals and open_questions that are not arrays", async () => {
    const { tool, mocks } = harness();

    await tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "s",
      proposals: "not an array",
      open_questions: { a: 1 },
    });

    expect(mocks.createEscalation.mock.calls[0]?.[0]).toMatchObject({
      proposals: undefined,
      openQuestions: undefined,
    });
  });

  it("drops non-string open_questions entries", async () => {
    const { tool, mocks } = harness();

    await tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "s",
      open_questions: ["real question", 42, null, "another"],
    });

    expect(mocks.createEscalation.mock.calls[0]?.[0]).toMatchObject({
      openQuestions: ["real question", "another"],
    });
  });

  it("refuses a missing negotiation_id or summary", async () => {
    for (const input of [{}, { negotiation_id: "n" }, { summary: "s" }]) {
      const { tool, mocks } = harness();
      const result = await tool("escalate_to_humans").handler(input);
      expect(result.isError).toBe(true);
      expect(result.content.error).toBe(
        "negotiation_id and summary required",
      );
      expect(mocks.createEscalation).not.toHaveBeenCalled();
    }
  });

  it("does not unblock the peer when creating the escalation fails", async () => {
    const { tool, mocks } = harness({
      createEscalation: () =>
        Promise.reject(new Error("negotiation neg_1 is already resolved")),
    });

    const result = await tool("escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "s",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "negotiation neg_1 is already resolved",
    });
    expect(mocks.unblockOnEscalate).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
