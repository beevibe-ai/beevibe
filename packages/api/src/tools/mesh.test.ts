/**
 * Mesh tool assembly + handler tests.
 *
 * The tier-gating blocks lock the static inventory — the exact tool
 * *names* each tier gets, so future skill-loader work can rely on the
 * surface being stable.
 *
 * The handler blocks cover the adapter layer around MeshServer: argument
 * coercion, the required-field guards, the response projections (which
 * deliberately narrow what the agent sees), and the `toolErrorFromThrown`
 * envelope. The transport underneath — spawning the target's CLI and
 * blocking on its reply — still belongs to the m6/m7 e2e scripts; here
 * MeshServer is a fake, so no Postgres or subprocess is needed.
 */
import { describe, expect, it, vi } from "vitest";
import type { ResolvedCaller } from "@beevibe/core/auth";
import type { AgentRepository, TaskRepository } from "@beevibe/core";
import type { EscalationService } from "@beevibe/core/services/escalation-service";
import type { TaskService } from "@beevibe/core/services/task-service";
import type { Pool } from "@beevibe/core/adapters/postgres";
import type { MeshServer } from "../mesh/server.js";
import {
  CannotNegotiateWithIcError,
  MeshMaxRoundsError,
} from "../mesh/types.js";
import type { AgentTool } from "./types.js";
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

// ── Handler harness ──────────────────────────────────────────────────────

interface MeshSpies {
  sendAsk: ReturnType<typeof vi.fn>;
  respondAsk: ReturnType<typeof vi.fn>;
  sendNegotiate: ReturnType<typeof vi.fn>;
  respondNegotiate: ReturnType<typeof vi.fn>;
  reportBlocker: ReturnType<typeof vi.fn>;
  unblockOnEscalate: ReturnType<typeof vi.fn>;
}

interface Harness {
  tools: Record<string, AgentTool>;
  mesh: MeshSpies;
  findParent: ReturnType<typeof vi.fn>;
  markBlocked: ReturnType<typeof vi.fn>;
  createEscalation: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
}

function harness(
  behavior: {
    askResponse?: unknown;
    negotiateResponse?: unknown;
    respondNegotiateResult?: unknown;
    parent?: { id: string } | null;
    escalation?: Record<string, unknown>;
    throws?: Partial<Record<keyof MeshSpies | "markBlocked" | "createEscalation", unknown>>;
  } = {},
): Harness {
  const t = behavior.throws ?? {};
  const raise = (key: string) => {
    const e = (t as Record<string, unknown>)[key];
    if (e !== undefined) throw e;
  };

  const mesh: MeshSpies = {
    sendAsk: vi.fn(async () => {
      raise("sendAsk");
      return (
        behavior.askResponse ?? {
          request_id: "req_1",
          from_agent_id: "agent_target",
          answer: "yes, feasible",
        }
      );
    }),
    respondAsk: vi.fn(() => {
      raise("respondAsk");
    }),
    sendNegotiate: vi.fn(async () => {
      raise("sendNegotiate");
      return (
        behavior.negotiateResponse ?? {
          negotiation_id: "neg_1",
          from_agent_id: "agent_peer",
          decision: "counter",
          message: "how about Tuesday",
          counter_proposal: "ship Tuesday",
        }
      );
    }),
    respondNegotiate: vi.fn(async () => {
      raise("respondNegotiate");
      return behavior.respondNegotiateResult === undefined
        ? null
        : behavior.respondNegotiateResult;
    }),
    reportBlocker: vi.fn(() => {
      raise("reportBlocker");
    }),
    unblockOnEscalate: vi.fn(() => {
      raise("unblockOnEscalate");
    }),
  };

  const findParent = vi.fn(async () =>
    behavior.parent === undefined ? { id: "agent_parent" } : behavior.parent,
  );
  const markBlocked = vi.fn(async () => {
    raise("markBlocked");
  });
  const createEscalation = vi.fn(async () => {
    raise("createEscalation");
    return (
      behavior.escalation ?? {
        id: "esc_1",
        status: "open",
        negotiation_id: "neg_1",
      }
    );
  });
  const query = vi.fn(async () => ({ rows: [] }));

  const services = {
    mesh: mesh as unknown as MeshServer,
    agentRepo: { findParent } as unknown as AgentRepository,
    taskRepo: {} as unknown as TaskRepository,
    taskService: { markBlocked } as unknown as TaskService,
    escalationService: { create: createEscalation } as unknown as EscalationService,
    pool: { query } as unknown as Pool,
  } satisfies MeshToolServices;

  const tools = Object.fromEntries(
    buildTeamMeshTools(fakeCtx, services).map((tool) => [tool.name, tool]),
  );
  return { tools, mesh, findParent, markBlocked, createEscalation, query };
}

describe("ask", () => {
  it("sends the ask with a minted request id and projects the response", async () => {
    const { tools, mesh } = harness();
    const result = await tools.ask!.handler({
      target_agent_id: "agent_target",
      question: "is X feasible?",
    });

    expect(mesh.sendAsk).toHaveBeenCalledTimes(1);
    const [requestId, from, to, question] = mesh.sendAsk.mock.calls[0]!;
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect([from, to, question]).toEqual(["agent_x", "agent_target", "is X feasible?"]);
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      request_id: "req_1",
      from_agent_id: "agent_target",
      answer: "yes, feasible",
    });
  });

  it("mints a distinct request id per call", async () => {
    const { tools, mesh } = harness();
    await tools.ask!.handler({ target_agent_id: "a", question: "q" });
    await tools.ask!.handler({ target_agent_id: "a", question: "q" });
    expect(mesh.sendAsk.mock.calls[0]![0]).not.toBe(mesh.sendAsk.mock.calls[1]![0]);
  });

  it("drops any extra fields the mesh response carries", async () => {
    const { tools } = harness({
      askResponse: {
        request_id: "req_1",
        from_agent_id: "agent_target",
        answer: "ok",
        internal_session_id: "ses_secret",
      },
    });
    const result = await tools.ask!.handler({
      target_agent_id: "agent_target",
      question: "q",
    });
    expect(Object.keys(result.content).sort()).toEqual([
      "answer",
      "from_agent_id",
      "request_id",
    ]);
  });

  it.each([
    ["target_agent_id", { question: "q" }],
    ["question", { target_agent_id: "a" }],
    ["both", {}],
  ])("rejects a call missing %s", async (_label, input) => {
    const { tools, mesh } = harness();
    const result = await tools.ask!.handler(input);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "target_agent_id and question required" });
    expect(mesh.sendAsk).not.toHaveBeenCalled();
  });

  it("envelopes a coded mesh error with its code and meta", async () => {
    const { tools } = harness({
      throws: {
        sendAsk: new MeshMaxRoundsError({
          negotiationId: "neg_1",
          rounds_completed: 5,
          max_rounds: 5,
        }),
      },
    });
    const result = await tools.ask!.handler({
      target_agent_id: "a",
      question: "q",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "MAX_ROUNDS_EXCEEDED",
      negotiationId: "neg_1",
      rounds_completed: 5,
      max_rounds: 5,
    });
  });

  it("envelopes an uncoded throw as the catch-all shape", async () => {
    const { tools } = harness({ throws: { sendAsk: new Error("target offline") } });
    const result = await tools.ask!.handler({
      target_agent_id: "a",
      question: "q",
    });
    expect(result.content).toEqual({ error: "target offline" });
  });
});

describe("respond_ask", () => {
  it("resolves the waiting ask with the caller as from_agent_id", async () => {
    const { tools, mesh } = harness();
    const result = await tools.respond_ask!.handler({
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
    ["request_id", { answer: "a" }],
    ["answer", { request_id: "req_1" }],
  ])("rejects a call missing %s", async (_label, input) => {
    const { tools, mesh } = harness();
    const result = await tools.respond_ask!.handler(input);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "request_id and answer required" });
    expect(mesh.respondAsk).not.toHaveBeenCalled();
  });

  it("envelopes a throw from the mesh server", async () => {
    const { tools } = harness({ throws: { respondAsk: new Error("no such request") } });
    const result = await tools.respond_ask!.handler({
      request_id: "req_1",
      answer: "a",
    });
    expect(result.content).toEqual({ error: "no such request" });
  });
});

describe("negotiate", () => {
  it("passes the task id and initiator session through as metadata", async () => {
    const { tools, mesh } = harness();
    const result = await tools.negotiate!.handler({
      peer_id: "agent_peer",
      proposal: "ship Monday",
      task_id: "task_7",
    });

    expect(mesh.sendNegotiate).toHaveBeenCalledWith(
      "agent_x",
      "agent_peer",
      "ship Monday",
      { taskId: "task_7", initiatorSessionId: "ses_x" },
    );
    expect(result.content).toEqual({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "counter",
      message: "how about Tuesday",
      counter_proposal: "ship Tuesday",
    });
  });

  it.each([
    ["omitted", undefined],
    ["empty", ""],
    ["a non-string", 7],
  ])("sends taskId undefined when task_id is %s", async (_label, taskId) => {
    const { tools, mesh } = harness();
    await tools.negotiate!.handler({
      peer_id: "agent_peer",
      proposal: "p",
      task_id: taskId,
    } as Record<string, unknown>);
    expect(mesh.sendNegotiate.mock.calls[0]![3]).toEqual({
      taskId: undefined,
      initiatorSessionId: "ses_x",
    });
  });

  it.each([
    ["peer_id", { proposal: "p" }],
    ["proposal", { peer_id: "agent_peer" }],
  ])("rejects a call missing %s", async (_label, input) => {
    const { tools, mesh } = harness();
    const result = await tools.negotiate!.handler(input);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "peer_id and proposal required" });
    expect(mesh.sendNegotiate).not.toHaveBeenCalled();
  });

  it("projects the escalated sentinel rather than a normal response", async () => {
    const { tools } = harness({
      negotiateResponse: {
        decision: "escalated",
        escalation_id: "esc_9",
        negotiation_id: "neg_1",
        message: "handed to humans",
      },
    });
    const result = await tools.negotiate!.handler({
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

  it("surfaces CANNOT_NEGOTIATE_WITH_IC with its meta", async () => {
    const { tools } = harness({
      throws: { sendNegotiate: new CannotNegotiateWithIcError({ agentId: "agent_ic" }) },
    });
    const result = await tools.negotiate!.handler({
      peer_id: "agent_ic",
      proposal: "p",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "CANNOT_NEGOTIATE_WITH_IC",
      agentId: "agent_ic",
    });
  });
});

describe("respond_negotiate", () => {
  it("reports terminal when the server returns null (accept/reject)", async () => {
    const { tools, mesh } = harness({ respondNegotiateResult: null });
    const result = await tools.respond_negotiate!.handler({
      negotiation_id: "neg_1",
      decision: "accept",
      message: "deal",
    });

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

  it("projects the peer's reply when the round continues", async () => {
    const { tools } = harness({
      respondNegotiateResult: {
        negotiation_id: "neg_1",
        from_agent_id: "agent_peer",
        decision: "reject",
        message: "no",
        counter_proposal: undefined,
      },
    });
    const result = await tools.respond_negotiate!.handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "how about Wednesday",
      counter_proposal: "ship Wednesday",
    });

    expect(result.content).toMatchObject({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "reject",
    });
  });

  it("forwards the counter_proposal on a counter", async () => {
    const { tools, mesh } = harness();
    await tools.respond_negotiate!.handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "alt plan",
    });
    expect(mesh.respondNegotiate.mock.calls[0]![1]).toMatchObject({
      counter_proposal: "alt plan",
    });
  });

  it.each([
    ["negotiation_id", { decision: "accept", message: "m" }],
    ["message", { negotiation_id: "neg_1", decision: "accept" }],
  ])("rejects a call missing %s", async (_label, input) => {
    const { tools, mesh } = harness();
    const result = await tools.respond_negotiate!.handler(input);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "negotiation_id and message required" });
    expect(mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it.each([["escalated"], [""], [undefined], [3]])(
    "rejects the unsupported decision %p",
    async (decision) => {
      const { tools, mesh } = harness();
      const result = await tools.respond_negotiate!.handler({
        negotiation_id: "neg_1",
        decision,
        message: "m",
      } as Record<string, unknown>);

      expect(result.isError).toBe(true);
      expect(result.content).toEqual({
        error: "decision must be one of: counter, accept, reject",
      });
      expect(mesh.respondNegotiate).not.toHaveBeenCalled();
    },
  );

  it("requires a counter_proposal when the decision is counter", async () => {
    const { tools, mesh } = harness();
    const result = await tools.respond_negotiate!.handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "counter_proposal required when decision='counter'",
    });
    expect(mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("surfaces MAX_ROUNDS_EXCEEDED so the agent knows to escalate", async () => {
    const { tools } = harness({
      throws: {
        respondNegotiate: new MeshMaxRoundsError({
          negotiationId: "neg_1",
          rounds_completed: 5,
          max_rounds: 5,
        }),
      },
    });
    const result = await tools.respond_negotiate!.handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "c",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "MAX_ROUNDS_EXCEEDED" });
    expect(result.content.message).toContain("escalate_to_humans");
  });
});

describe("report_blocker", () => {
  it("marks the task blocked, then spawns the parent", async () => {
    const { tools, findParent, markBlocked, mesh } = harness();
    const result = await tools.report_blocker!.handler({
      task_id: "task_7",
      description: "cannot reach the vendor API",
    });

    expect(findParent).toHaveBeenCalledWith("agent_x");
    expect(markBlocked).toHaveBeenCalledWith(
      "task_7",
      "agent_x",
      "cannot reach the vendor API",
    );
    expect(mesh.reportBlocker).toHaveBeenCalledWith(
      "agent_parent",
      "agent_x",
      "task_7",
      "cannot reach the vendor API",
    );
    expect(result.content).toEqual({
      reported: true,
      parent_agent_id: "agent_parent",
      task_id: "task_7",
    });
  });

  it("refuses for a top-level agent without touching the task", async () => {
    const { tools, markBlocked, mesh } = harness({ parent: null });
    const result = await tools.report_blocker!.handler({
      task_id: "task_7",
      description: "stuck",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "no_parent_to_block" });
    expect(markBlocked).not.toHaveBeenCalled();
    expect(mesh.reportBlocker).not.toHaveBeenCalled();
  });

  it.each([
    ["task_id", { description: "d" }],
    ["description", { task_id: "task_7" }],
  ])("rejects a call missing %s", async (_label, input) => {
    const { tools, findParent } = harness();
    const result = await tools.report_blocker!.handler(input);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "task_id and description required" });
    expect(findParent).not.toHaveBeenCalled();
  });

  it("does not spawn the parent when marking the task blocked fails", async () => {
    const { tools, mesh } = harness({ throws: { markBlocked: new Error("task gone") } });
    const result = await tools.report_blocker!.handler({
      task_id: "task_7",
      description: "stuck",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "task gone" });
    expect(mesh.reportBlocker).not.toHaveBeenCalled();
  });
});

describe("escalate_to_humans", () => {
  it("creates the escalation, unblocks the peer, then notifies", async () => {
    const { tools, createEscalation, mesh, query } = harness();
    const result = await tools.escalate_to_humans!.handler({
      negotiation_id: "neg_1",
      summary: "We're stuck on X",
      proposals: [{ title: "A", description: "do A" }],
      open_questions: ["what is the budget?", 42],
    });

    expect(createEscalation).toHaveBeenCalledWith({
      negotiationId: "neg_1",
      callerAgentId: "agent_x",
      summary: "We're stuck on X",
      proposals: [{ title: "A", description: "do A" }],
      // Non-string open questions are filtered out.
      openQuestions: ["what is the budget?"],
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

  it.each([
    ["omitted", undefined],
    ["not an array", "just one idea"],
  ])("passes proposals/open_questions as undefined when %s", async (_label, value) => {
    const { tools, createEscalation } = harness();
    await tools.escalate_to_humans!.handler({
      negotiation_id: "neg_1",
      summary: "s",
      proposals: value,
      open_questions: value,
    } as Record<string, unknown>);

    expect(createEscalation.mock.calls[0]![0]).toMatchObject({
      proposals: undefined,
      openQuestions: undefined,
    });
  });

  it.each([
    ["negotiation_id", { summary: "s" }],
    ["summary", { negotiation_id: "neg_1" }],
  ])("rejects a call missing %s", async (_label, input) => {
    const { tools, createEscalation } = harness();
    const result = await tools.escalate_to_humans!.handler(input);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "negotiation_id and summary required" });
    expect(createEscalation).not.toHaveBeenCalled();
  });

  it("leaves the peer blocked when the escalation row cannot be created", async () => {
    const { tools, mesh, query } = harness({
      throws: { createEscalation: new Error("negotiation not found") },
    });
    const result = await tools.escalate_to_humans!.handler({
      negotiation_id: "neg_1",
      summary: "s",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "negotiation not found" });
    expect(mesh.unblockOnEscalate).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});
