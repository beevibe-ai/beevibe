/**
 * Mesh tool tests — tier inventory plus per-handler behavior.
 *
 * The tier inventory locks the exact tool *names* each tier gets, so
 * future skill-loader work can rely on the surface being stable. The
 * handler tests below cover what the m6/m7 e2e scripts can't reach
 * cheaply (they need live Postgres plus spawned CLI subprocesses):
 * argument coercion, the guards that must refuse before a session is
 * spawned, the projection of each MeshServer reply onto the agent-facing
 * envelope, and the ordering of the multi-step handlers.
 */
import { describe, expect, it, vi } from "vitest";
import type { ResolvedCaller } from "@beevibe/core/auth";
import type { AgentRepository, TaskRepository } from "@beevibe/core";
import type { TaskService } from "@beevibe/core/services/task-service";
import type { EscalationService } from "@beevibe/core/services/escalation-service";
import type { Pool } from "@beevibe/core/adapters/postgres";
import {
  CannotNegotiateWithIcError,
  MeshCapacityError,
  MeshMaxRoundsError,
} from "../mesh/types.js";
import type { MeshServer } from "../mesh/server.js";
import {
  buildIcMeshTools,
  buildTeamMeshTools,
  type MeshToolContext,
  type MeshToolServices,
} from "./mesh.js";

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

  it("declares required args on every tool in the set", () => {
    const required = new Map(
      buildTeamMeshTools(fakeCtx, fakeServices).map((t) => [
        t.name,
        t.schema.required,
      ]),
    );

    expect(Object.fromEntries(required)).toEqual({
      ask: ["target_agent_id", "question"],
      respond_ask: ["request_id", "answer"],
      negotiate: ["peer_id", "proposal"],
      respond_negotiate: ["negotiation_id", "decision", "message"],
      report_blocker: ["task_id", "description"],
      escalate_to_humans: ["negotiation_id", "summary"],
    });
  });

  it("builds a tool set the ICs' two tools are a subset of", () => {
    const team = buildTeamMeshTools(fakeCtx, fakeServices).map((t) => t.name);
    for (const ic of buildIcMeshTools(fakeCtx, fakeServices)) {
      expect(team).toContain(ic.name);
    }
  });
});

// ── Handler harness ──────────────────────────────────────────────────────

type MeshMock = ReturnType<typeof vi.fn>;

interface MeshFakes {
  services: MeshToolServices;
  order: string[];
  mesh: {
    sendAsk: MeshMock;
    respondAsk: MeshMock;
    sendNegotiate: MeshMock;
    respondNegotiate: MeshMock;
    reportBlocker: MeshMock;
    unblockOnEscalate: MeshMock;
  };
  agentRepo: { findParent: ReturnType<typeof vi.fn> };
  taskService: { markBlocked: ReturnType<typeof vi.fn> };
  escalationService: { create: ReturnType<typeof vi.fn> };
  pool: { query: ReturnType<typeof vi.fn> };
}

function makeFakes(
  overrides: {
    sendAsk?: unknown;
    sendNegotiate?: unknown;
    respondNegotiate?: unknown;
    parent?: unknown;
    escalation?: unknown;
  } = {},
): MeshFakes {
  const order: string[] = [];
  const step =
    <T>(name: string, value: T) =>
    () => {
      order.push(name);
      if (value instanceof Error) throw value;
      return value;
    };

  const mesh = {
    sendAsk: vi.fn(
      step(
        "sendAsk",
        "sendAsk" in overrides
          ? overrides.sendAsk
          : { request_id: "req_1", from_agent_id: "agent_t", answer: "yes" },
      ),
    ),
    respondAsk: vi.fn(step("respondAsk", undefined)),
    sendNegotiate: vi.fn(
      step(
        "sendNegotiate",
        "sendNegotiate" in overrides
          ? overrides.sendNegotiate
          : {
              negotiation_id: "neg_1",
              from_agent_id: "agent_p",
              decision: "counter",
              message: "not quite",
              counter_proposal: "do it in two phases",
            },
      ),
    ),
    respondNegotiate: vi.fn(
      step(
        "respondNegotiate",
        "respondNegotiate" in overrides ? overrides.respondNegotiate : null,
      ),
    ),
    reportBlocker: vi.fn(step("mesh.reportBlocker", undefined)),
    unblockOnEscalate: vi.fn(step("unblockOnEscalate", undefined)),
  };

  const agentRepo = {
    findParent: vi.fn(async () =>
      step("findParent", "parent" in overrides ? overrides.parent : { id: "agent_parent" })(),
    ),
  };
  const taskService = {
    markBlocked: vi.fn(async () => step("markBlocked", undefined)()),
  };
  const escalationService = {
    create: vi.fn(async () =>
      step(
        "escalation.create",
        "escalation" in overrides
          ? overrides.escalation
          : { id: "esc_1", status: "open", negotiation_id: "neg_1" },
      )(),
    ),
  };
  const pool = { query: vi.fn(async () => step("pg_notify", { rows: [] })()) };

  return {
    order,
    mesh,
    agentRepo,
    taskService,
    escalationService,
    pool,
    services: {
      mesh: mesh as unknown as MeshServer,
      agentRepo: agentRepo as unknown as AgentRepository,
      taskRepo: {} as unknown as TaskRepository,
      taskService: taskService as unknown as TaskService,
      escalationService: escalationService as unknown as EscalationService,
      pool: pool as unknown as Pool,
    },
  };
}

const CTX: MeshToolContext = {
  caller: { agentId: "agent_x", source: "agent", hierarchyLevel: "team" },
  beevibeSid: "ses_x",
};

function tool(name: string, fakes: MeshFakes, ctx: MeshToolContext = CTX) {
  const found = buildTeamMeshTools(ctx, fakes.services).find(
    (t) => t.name === name,
  );
  if (!found) throw new Error(`no mesh tool named ${name}`);
  return found;
}

// ── ask ──────────────────────────────────────────────────────────────────

describe("ask handler", () => {
  it("mints a request id and projects only request_id, from_agent_id, answer", async () => {
    const fakes = makeFakes({
      sendAsk: {
        request_id: "req_1",
        from_agent_id: "agent_t",
        answer: "feasible with caveats",
        // Extra server-side fields must not leak to the agent.
        internal_session_id: "sess_secret",
      },
    });
    const result = await tool("ask", fakes).handler({
      target_agent_id: "agent_t",
      question: "is X feasible?",
    });

    const [requestId, from, target, question] =
      fakes.mesh.sendAsk.mock.calls[0]!;
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect([from, target, question]).toEqual([
      "agent_x",
      "agent_t",
      "is X feasible?",
    ]);
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      request_id: "req_1",
      from_agent_id: "agent_t",
      answer: "feasible with caveats",
    });
  });

  it("mints a fresh request id per call", async () => {
    const fakes = makeFakes();
    const t = tool("ask", fakes);
    await t.handler({ target_agent_id: "agent_t", question: "q1" });
    await t.handler({ target_agent_id: "agent_t", question: "q2" });

    expect(fakes.mesh.sendAsk.mock.calls[0]![0]).not.toBe(
      fakes.mesh.sendAsk.mock.calls[1]![0],
    );
  });

  it.each([
    ["target_agent_id", { question: "q" }],
    ["question", { target_agent_id: "agent_t" }],
    ["both", {}],
  ])("refuses without %s — no session is spawned", async (_label, input) => {
    const fakes = makeFakes();
    const result = await tool("ask", fakes).handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "target_agent_id and question required",
    });
    expect(fakes.mesh.sendAsk).not.toHaveBeenCalled();
  });

  it("projects a coded capacity error with its meta", async () => {
    const fakes = makeFakes({
      sendAsk: new MeshCapacityError("at cap", {
        agentId: "agent_t",
        running: 3,
        cap: 3,
      }),
    });
    const result = await tool("ask", fakes).handler({
      target_agent_id: "agent_t",
      question: "q",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "MESH_CAPACITY_EXCEEDED",
      agentId: "agent_t",
      running: 3,
      cap: 3,
      message: "at cap",
    });
  });

  it("degrades an uncoded throw to the catch-all envelope", async () => {
    const fakes = makeFakes({ sendAsk: new Error("target never responded") });
    const result = await tool("ask", fakes).handler({
      target_agent_id: "agent_t",
      question: "q",
    });

    expect(result.content).toEqual({ error: "target never responded" });
  });
});

// ── respond_ask ──────────────────────────────────────────────────────────

describe("respond_ask handler", () => {
  it("stamps the responder's own agent id on the reply", async () => {
    const fakes = makeFakes();
    const result = await tool("respond_ask", fakes).handler({
      request_id: "req_1",
      answer: "yes, with caveats",
    });

    expect(fakes.mesh.respondAsk).toHaveBeenCalledWith("req_1", {
      request_id: "req_1",
      // Taken from context, never from input — a responder can't
      // impersonate another agent.
      from_agent_id: "agent_x",
      answer: "yes, with caveats",
    });
    expect(result.content).toEqual({ responded: true, request_id: "req_1" });
  });

  it.each([
    ["request_id", { answer: "a" }],
    ["answer", { request_id: "req_1" }],
    ["an empty answer", { request_id: "req_1", answer: "" }],
  ])("refuses without %s", async (_label, input) => {
    const fakes = makeFakes();
    const result = await tool("respond_ask", fakes).handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "request_id and answer required" });
    expect(fakes.mesh.respondAsk).not.toHaveBeenCalled();
  });

  it("envelopes a throw from the unblock path", async () => {
    const fakes = makeFakes();
    fakes.mesh.respondAsk.mockImplementation(() => {
      throw new Error("no waiter for req_1");
    });
    const result = await tool("respond_ask", fakes).handler({
      request_id: "req_1",
      answer: "a",
    });

    expect(result.content).toEqual({ error: "no waiter for req_1" });
  });
});

// ── negotiate ────────────────────────────────────────────────────────────

describe("negotiate handler", () => {
  it("passes the task id and the caller's session as originator metadata", async () => {
    const fakes = makeFakes();
    const result = await tool("negotiate", fakes).handler({
      peer_id: "agent_p",
      proposal: "ship behind a flag",
      task_id: "task_9",
    });

    expect(fakes.mesh.sendNegotiate).toHaveBeenCalledWith(
      "agent_x",
      "agent_p",
      "ship behind a flag",
      { taskId: "task_9", initiatorSessionId: "ses_x" },
    );
    expect(result.content).toEqual({
      negotiation_id: "neg_1",
      from_agent_id: "agent_p",
      decision: "counter",
      message: "not quite",
      counter_proposal: "do it in two phases",
    });
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["a non-string", 9],
  ])("sends taskId undefined when task_id is %s", async (_label, task_id) => {
    const fakes = makeFakes();
    await tool("negotiate", fakes).handler({
      peer_id: "agent_p",
      proposal: "p",
      task_id,
    });

    expect(fakes.mesh.sendNegotiate.mock.calls[0]![3]).toEqual({
      taskId: undefined,
      initiatorSessionId: "ses_x",
    });
  });

  it.each([
    ["peer_id", { proposal: "p" }],
    ["proposal", { peer_id: "agent_p" }],
  ])("refuses without %s", async (_label, input) => {
    const fakes = makeFakes();
    const result = await tool("negotiate", fakes).handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "peer_id and proposal required" });
    expect(fakes.mesh.sendNegotiate).not.toHaveBeenCalled();
  });

  it("projects the escalated sentinel instead of the responder shape", async () => {
    const fakes = makeFakes({
      sendNegotiate: {
        decision: "escalated",
        escalation_id: "esc_1",
        negotiation_id: "neg_1",
        message: "handed to humans",
      },
    });
    const result = await tool("negotiate", fakes).handler({
      peer_id: "agent_p",
      proposal: "p",
    });

    expect(result.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_1",
      negotiation_id: "neg_1",
      message: "handed to humans",
    });
    // The sentinel branch must not carry the peer-reply fields.
    expect(result.content).not.toHaveProperty("from_agent_id");
  });

  it("projects CANNOT_NEGOTIATE_WITH_IC so the agent can switch to ask()", async () => {
    const fakes = makeFakes({
      sendNegotiate: new CannotNegotiateWithIcError({ agentId: "agent_ic" }),
    });
    const result = await tool("negotiate", fakes).handler({
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

// ── respond_negotiate ────────────────────────────────────────────────────

describe("respond_negotiate handler", () => {
  it("reports terminal when the server returns null (accept/reject)", async () => {
    const fakes = makeFakes({ respondNegotiate: null });
    const result = await tool("respond_negotiate", fakes).handler({
      negotiation_id: "neg_1",
      decision: "accept",
      message: "works for me",
    });

    expect(fakes.mesh.respondNegotiate).toHaveBeenCalledWith(
      "neg_1",
      {
        negotiation_id: "neg_1",
        from_agent_id: "agent_x",
        decision: "accept",
        message: "works for me",
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
    const fakes = makeFakes({
      respondNegotiate: {
        negotiation_id: "neg_1",
        from_agent_id: "agent_p",
        decision: "counter",
        message: "almost",
        counter_proposal: "split the rollout",
      },
    });
    const result = await tool("respond_negotiate", fakes).handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "how about this",
      counter_proposal: "phase it",
    });

    expect(fakes.mesh.respondNegotiate.mock.calls[0]![1]).toMatchObject({
      counter_proposal: "phase it",
    });
    expect(result.content).toMatchObject({
      from_agent_id: "agent_p",
      decision: "counter",
      counter_proposal: "split the rollout",
    });
  });

  it("projects the escalated sentinel when the peer escalated mid-round", async () => {
    const fakes = makeFakes({
      respondNegotiate: {
        decision: "escalated",
        escalation_id: "esc_1",
        negotiation_id: "neg_1",
        message: "peer escalated",
      },
    });
    const result = await tool("respond_negotiate", fakes).handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "c",
    });

    expect(result.content).toMatchObject({
      decision: "escalated",
      escalation_id: "esc_1",
    });
  });

  it.each([
    ["negotiation_id", { decision: "accept", message: "m" }],
    ["message", { negotiation_id: "neg_1", decision: "accept" }],
  ])("refuses without %s", async (_label, input) => {
    const fakes = makeFakes();
    const result = await tool("respond_negotiate", fakes).handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "negotiation_id and message required",
    });
    expect(fakes.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown value", "maybe"],
    ["absent", undefined],
    ["a non-string", 1],
  ])("rejects a decision that is %s, listing the legal set", async (_label, decision) => {
    const fakes = makeFakes();
    const result = await tool("respond_negotiate", fakes).handler({
      negotiation_id: "neg_1",
      decision,
      message: "m",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "decision must be one of: counter, accept, reject",
    });
    expect(fakes.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  // Without this guard the peer is unblocked with a counter that has no
  // proposal in it, and the negotiation stalls a round later.
  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["a non-string", 3],
  ])(
    "requires counter_proposal on decision=counter when it is %s",
    async (_label, counter_proposal) => {
      const fakes = makeFakes();
      const result = await tool("respond_negotiate", fakes).handler({
        negotiation_id: "neg_1",
        decision: "counter",
        message: "m",
        counter_proposal,
      });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual({
        error: "counter_proposal required when decision='counter'",
      });
      expect(fakes.mesh.respondNegotiate).not.toHaveBeenCalled();
    },
  );

  it.each(["accept", "reject"] as const)(
    "does not require counter_proposal on decision=%s",
    async (decision) => {
      const fakes = makeFakes();
      const result = await tool("respond_negotiate", fakes).handler({
        negotiation_id: "neg_1",
        decision,
        message: "m",
      });

      expect(result.isError).toBeFalsy();
      expect(result.content).toMatchObject({ decision, terminal: true });
    },
  );

  it("projects MAX_ROUNDS_EXCEEDED with the round counters", async () => {
    const fakes = makeFakes({
      respondNegotiate: new MeshMaxRoundsError({
        negotiationId: "neg_1",
        rounds_completed: 5,
        max_rounds: 5,
      }),
    });
    const result = await tool("respond_negotiate", fakes).handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "m",
      counter_proposal: "c",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "MAX_ROUNDS_EXCEEDED",
      rounds_completed: 5,
      max_rounds: 5,
    });
    expect(result.content.message).toContain("escalate_to_humans");
  });
});

// ── report_blocker ───────────────────────────────────────────────────────

describe("report_blocker handler", () => {
  it("resolves the parent, marks the task blocked, then spawns the parent", async () => {
    const fakes = makeFakes();
    const result = await tool("report_blocker", fakes).handler({
      task_id: "task_9",
      description: "the API key is missing",
    });

    expect(fakes.order).toEqual([
      "findParent",
      // The task must be blocked before the parent is spawned, or the
      // parent reads a task that still looks in-flight.
      "markBlocked",
      "mesh.reportBlocker",
    ]);
    expect(fakes.taskService.markBlocked).toHaveBeenCalledWith(
      "task_9",
      "agent_x",
      "the API key is missing",
    );
    expect(fakes.mesh.reportBlocker).toHaveBeenCalledWith(
      "agent_parent",
      "agent_x",
      "task_9",
      "the API key is missing",
    );
    expect(result.content).toEqual({
      reported: true,
      parent_agent_id: "agent_parent",
      task_id: "task_9",
    });
  });

  it.each([
    ["task_id", { description: "d" }],
    ["description", { task_id: "task_9" }],
  ])("refuses without %s before any lookup", async (_label, input) => {
    const fakes = makeFakes();
    const result = await tool("report_blocker", fakes).handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "task_id and description required" });
    expect(fakes.order).toEqual([]);
  });

  // A top-level agent has nobody to escalate to; blocking the task anyway
  // would strand it with no investigator.
  it.each([
    ["null", null],
    ["undefined", undefined],
  ])("returns no_parent_to_block when findParent yields %s", async (_label, parent) => {
    const fakes = makeFakes({ parent });
    const result = await tool("report_blocker", fakes).handler({
      task_id: "task_9",
      description: "d",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "no_parent_to_block" });
    expect(result.content.message).toContain("escalate_to_humans");
    expect(fakes.taskService.markBlocked).not.toHaveBeenCalled();
    expect(fakes.mesh.reportBlocker).not.toHaveBeenCalled();
  });

  it("does not spawn the parent when markBlocked fails", async () => {
    const fakes = makeFakes();
    fakes.taskService.markBlocked.mockImplementation(async () => {
      throw new Error("task task_9 not found");
    });
    const result = await tool("report_blocker", fakes).handler({
      task_id: "task_9",
      description: "d",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "task task_9 not found" });
    expect(fakes.mesh.reportBlocker).not.toHaveBeenCalled();
  });

  it("is on the IC tier with the same behavior", async () => {
    const fakes = makeFakes();
    const icTool = buildIcMeshTools(
      { caller: { agentId: "agent_ic", source: "agent", hierarchyLevel: "ic" }, beevibeSid: "ses_ic" },
      fakes.services,
    ).find((t) => t.name === "report_blocker")!;

    const result = await icTool.handler({ task_id: "task_9", description: "d" });

    expect(result.content).toMatchObject({ reported: true });
    expect(fakes.taskService.markBlocked).toHaveBeenCalledWith(
      "task_9",
      "agent_ic",
      "d",
    );
  });
});

// ── escalate_to_humans ───────────────────────────────────────────────────

describe("escalate_to_humans handler", () => {
  const INPUT = {
    negotiation_id: "neg_1",
    summary: "We're stuck on rollout order",
    proposals: [{ title: "Phase it", description: "Two releases" }],
    open_questions: ["Is the deadline hard?"],
  };

  it("creates the escalation, unblocks the peer, then notifies listeners", async () => {
    const fakes = makeFakes();
    const result = await tool("escalate_to_humans", fakes).handler(INPUT);

    expect(fakes.escalationService.create).toHaveBeenCalledWith({
      negotiationId: "neg_1",
      callerAgentId: "agent_x",
      summary: INPUT.summary,
      proposals: INPUT.proposals,
      openQuestions: INPUT.open_questions,
    });
    expect(fakes.order).toEqual([
      "escalation.create",
      // The peer's pending respond_negotiate has to be released before we
      // spend a round trip on pg_notify.
      "unblockOnEscalate",
      "pg_notify",
    ]);
    expect(fakes.mesh.unblockOnEscalate).toHaveBeenCalledWith("neg_1", "esc_1");
    expect(fakes.pool.query.mock.calls[0]![0]).toContain(
      "pg_notify('escalation_created'",
    );
    expect(fakes.pool.query.mock.calls[0]![1]).toEqual(["esc_1"]);
    expect(result.content).toEqual({
      escalation_id: "esc_1",
      status: "open",
      negotiation_id: "neg_1",
    });
  });

  it.each([
    ["negotiation_id", { summary: "s" }],
    ["summary", { negotiation_id: "neg_1" }],
  ])("refuses without %s", async (_label, input) => {
    const fakes = makeFakes();
    const result = await tool("escalate_to_humans", fakes).handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "negotiation_id and summary required",
    });
    expect(fakes.order).toEqual([]);
  });

  it.each([
    ["absent", undefined],
    ["a non-array", "Phase it"],
    ["an object", { title: "Phase it" }],
  ])("sends undefined proposals when they are %s", async (_label, proposals) => {
    const fakes = makeFakes();
    await tool("escalate_to_humans", fakes).handler({
      negotiation_id: "neg_1",
      summary: "s",
      proposals,
    });

    expect(fakes.escalationService.create.mock.calls[0]![0]).toMatchObject({
      proposals: undefined,
    });
  });

  it("filters non-strings out of open_questions", async () => {
    const fakes = makeFakes();
    await tool("escalate_to_humans", fakes).handler({
      negotiation_id: "neg_1",
      summary: "s",
      open_questions: ["real?", 42, null, "also real?"],
    });

    expect(fakes.escalationService.create.mock.calls[0]![0]).toMatchObject({
      openQuestions: ["real?", "also real?"],
    });
  });

  it("sends undefined openQuestions when the field is not an array", async () => {
    const fakes = makeFakes();
    await tool("escalate_to_humans", fakes).handler({
      negotiation_id: "neg_1",
      summary: "s",
      open_questions: "just one",
    });

    expect(fakes.escalationService.create.mock.calls[0]![0]).toMatchObject({
      openQuestions: undefined,
    });
  });

  it("leaves the peer blocked-and-notified untouched when create fails", async () => {
    const fakes = makeFakes({ escalation: new Error("already escalated") });
    const result = await tool("escalate_to_humans", fakes).handler(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "already escalated" });
    expect(fakes.mesh.unblockOnEscalate).not.toHaveBeenCalled();
    expect(fakes.pool.query).not.toHaveBeenCalled();
  });

  it("surfaces a pg_notify failure rather than reporting success", async () => {
    const fakes = makeFakes();
    fakes.pool.query.mockImplementation(async () => {
      throw new Error("connection terminated");
    });
    const result = await tool("escalate_to_humans", fakes).handler(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "connection terminated" });
  });
});
