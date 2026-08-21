/**
 * Mesh tool tests — tier gating plus per-handler behavior.
 *
 * The end-to-end mesh flows (real spawns, real blocking round-trips) are
 * exercised by the m6/m7 e2e scripts, which need live Postgres and CLI
 * subprocesses. What's tested here is everything the tool layer itself
 * owns: the static tier inventory, the argument coercion and guards each
 * handler applies before it reaches MeshServer, the projection of the
 * server's responses back onto the agent-facing envelope, and the
 * CodedMeshError pass-through that keeps `max_rounds_exceeded` and
 * friends machine-readable.
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
import { buildIcMeshTools, buildTeamMeshTools, type MeshToolServices } from "./mesh.js";
import type { AgentTool } from "./types.js";

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

interface MeshStubs {
  sendAsk: ReturnType<typeof vi.fn>;
  respondAsk: ReturnType<typeof vi.fn>;
  sendNegotiate: ReturnType<typeof vi.fn>;
  respondNegotiate: ReturnType<typeof vi.fn>;
  reportBlocker: ReturnType<typeof vi.fn>;
  unblockOnEscalate: ReturnType<typeof vi.fn>;
}

interface Harness {
  tools: AgentTool[];
  mesh: MeshStubs;
  findParent: ReturnType<typeof vi.fn>;
  markBlocked: ReturnType<typeof vi.fn>;
  createEscalation: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
}

function harness(
  overrides: Partial<{
    sendAsk: () => Promise<unknown>;
    respondAsk: () => void;
    sendNegotiate: () => Promise<unknown>;
    respondNegotiate: () => Promise<unknown>;
    reportBlocker: () => void;
    parent: { id: string } | undefined;
    markBlocked: () => Promise<unknown>;
    createEscalation: () => Promise<unknown>;
  }> = {},
): Harness {
  const mesh: MeshStubs = {
    sendAsk: vi.fn(
      overrides.sendAsk ??
        (async () => ({
          request_id: "req_1",
          from_agent_id: "agent_target",
          answer: "yes, feasible",
        })),
    ),
    respondAsk: vi.fn(overrides.respondAsk ?? (() => undefined)),
    sendNegotiate: vi.fn(
      overrides.sendNegotiate ??
        (async () => ({
          negotiation_id: "neg_1",
          from_agent_id: "agent_peer",
          decision: "counter",
          message: "how about Tuesday",
          counter_proposal: "ship Tuesday",
        })),
    ),
    respondNegotiate: vi.fn(overrides.respondNegotiate ?? (async () => null)),
    reportBlocker: vi.fn(overrides.reportBlocker ?? (() => undefined)),
    unblockOnEscalate: vi.fn(),
  };

  const findParent = vi.fn(async () =>
    "parent" in overrides ? overrides.parent : { id: "agent_parent" },
  );
  const markBlocked = vi.fn(overrides.markBlocked ?? (async () => undefined));
  const createEscalation = vi.fn(
    overrides.createEscalation ??
      (async () => ({
        id: "esc_1",
        status: "open",
        negotiation_id: "neg_1",
      })),
  );
  const query = vi.fn(async () => ({ rows: [] }));

  const services = {
    mesh: mesh as unknown as MeshServer,
    agentRepo: { findParent } as unknown as AgentRepository,
    taskRepo: {} as unknown as TaskRepository,
    taskService: { markBlocked } as unknown as TaskService,
    escalationService: { create: createEscalation } as unknown as EscalationService,
    pool: { query } as unknown as Pool,
  };

  return {
    tools: buildTeamMeshTools(fakeCtx, services),
    mesh,
    findParent,
    markBlocked,
    createEscalation,
    query,
  };
}

function pick(h: Harness, name: string): AgentTool {
  const t = h.tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} missing`);
  return t;
}

// ── ask ──────────────────────────────────────────────────────────────────

describe("ask handler", () => {
  it("forwards the caller as sender and projects only the wire fields", async () => {
    const h = harness();
    const result = await pick(h, "ask").handler({
      target_agent_id: "agent_target",
      question: "is X feasible?",
    });

    const [requestId, from, to, question] = h.mesh.sendAsk.mock.calls[0] ?? [];
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect([from, to, question]).toEqual([
      "agent_x",
      "agent_target",
      "is X feasible?",
    ]);
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      request_id: "req_1",
      from_agent_id: "agent_target",
      answer: "yes, feasible",
    });
  });

  it("mints a fresh request id per call", async () => {
    const h = harness();
    const t = pick(h, "ask");
    await t.handler({ target_agent_id: "a", question: "q" });
    await t.handler({ target_agent_id: "a", question: "q" });

    expect(h.mesh.sendAsk.mock.calls[0]?.[0]).not.toBe(
      h.mesh.sendAsk.mock.calls[1]?.[0],
    );
  });

  it.each([
    ["target_agent_id", { question: "q" }],
    ["question", { target_agent_id: "agent_target" }],
    ["both", {}],
  ])("rejects a call missing %s", async (_label, input) => {
    const h = harness();
    const result = await pick(h, "ask").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "target_agent_id and question required",
    });
    expect(h.mesh.sendAsk).not.toHaveBeenCalled();
  });

  it("preserves a CodedMeshError's code and meta", async () => {
    const h = harness({
      sendAsk: async () => {
        throw new CannotNegotiateWithIcError({ agentId: "agent_ic" });
      },
    });
    const result = await pick(h, "ask").handler({
      target_agent_id: "agent_ic",
      question: "q",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "CANNOT_NEGOTIATE_WITH_IC",
      agentId: "agent_ic",
    });
  });

  it("degrades a plain throw to the catch-all envelope", async () => {
    const h = harness({
      sendAsk: async () => {
        throw new Error("target offline");
      },
    });
    const result = await pick(h, "ask").handler({
      target_agent_id: "agent_target",
      question: "q",
    });

    expect(result.content).toEqual({ error: "target offline" });
  });
});

// ── respond_ask ──────────────────────────────────────────────────────────

describe("respond_ask handler", () => {
  it("stamps the responder as the caller and echoes the request id", async () => {
    const h = harness();
    const result = await pick(h, "respond_ask").handler({
      request_id: "req_1",
      answer: "yes",
    });

    expect(h.mesh.respondAsk).toHaveBeenCalledWith("req_1", {
      request_id: "req_1",
      from_agent_id: "agent_x",
      answer: "yes",
    });
    expect(result.content).toEqual({ responded: true, request_id: "req_1" });
  });

  it.each([
    ["request_id", { answer: "yes" }],
    ["answer", { request_id: "req_1" }],
  ])("rejects a call missing %s", async (_label, input) => {
    const h = harness();
    const result = await pick(h, "respond_ask").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "request_id and answer required" });
    expect(h.mesh.respondAsk).not.toHaveBeenCalled();
  });

  it("envelopes a throw from the unblock path", async () => {
    const h = harness({
      respondAsk: () => {
        throw new Error("no waiter registered");
      },
    });
    const result = await pick(h, "respond_ask").handler({
      request_id: "req_1",
      answer: "yes",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "no waiter registered" });
  });
});

// ── negotiate ────────────────────────────────────────────────────────────

describe("negotiate handler", () => {
  it("passes the caller's session id as initiator metadata", async () => {
    const h = harness();
    await pick(h, "negotiate").handler({
      peer_id: "agent_peer",
      proposal: "ship Monday",
      task_id: "task_1",
    });

    expect(h.mesh.sendNegotiate).toHaveBeenCalledWith(
      "agent_x",
      "agent_peer",
      "ship Monday",
      { taskId: "task_1", initiatorSessionId: "ses_x" },
    );
  });

  it.each([
    ["absent", {}],
    ["an empty string", { task_id: "" }],
    ["a non-string", { task_id: 5 }],
  ])("sends taskId undefined when task_id is %s", async (_label, extra) => {
    const h = harness();
    await pick(h, "negotiate").handler({
      peer_id: "agent_peer",
      proposal: "p",
      ...extra,
    });

    expect(h.mesh.sendNegotiate.mock.calls[0]?.[3]).toMatchObject({
      taskId: undefined,
    });
  });

  it("projects a counter response with its counter_proposal", async () => {
    const h = harness();
    const result = await pick(h, "negotiate").handler({
      peer_id: "agent_peer",
      proposal: "ship Monday",
    });

    expect(result.content).toEqual({
      negotiation_id: "neg_1",
      from_agent_id: "agent_peer",
      decision: "counter",
      message: "how about Tuesday",
      counter_proposal: "ship Tuesday",
    });
  });

  it("projects the escalated sentinel through its own branch", async () => {
    const h = harness({
      sendNegotiate: async () => ({
        decision: "escalated",
        escalation_id: "esc_9",
        negotiation_id: "neg_1",
        message: "peer escalated",
      }),
    });
    const result = await pick(h, "negotiate").handler({
      peer_id: "agent_peer",
      proposal: "p",
    });

    expect(result.content).toEqual({
      decision: "escalated",
      escalation_id: "esc_9",
      negotiation_id: "neg_1",
      message: "peer escalated",
    });
  });

  it.each([
    ["peer_id", { proposal: "p" }],
    ["proposal", { peer_id: "agent_peer" }],
  ])("rejects a call missing %s", async (_label, input) => {
    const h = harness();
    const result = await pick(h, "negotiate").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "peer_id and proposal required" });
    expect(h.mesh.sendNegotiate).not.toHaveBeenCalled();
  });

  it("surfaces cannot_negotiate_with_ic with its meta intact", async () => {
    const h = harness({
      sendNegotiate: async () => {
        throw new CannotNegotiateWithIcError({ agentId: "agent_ic" });
      },
    });
    const result = await pick(h, "negotiate").handler({
      peer_id: "agent_ic",
      proposal: "p",
    });

    expect(result.content).toMatchObject({
      error: "CANNOT_NEGOTIATE_WITH_IC",
      agentId: "agent_ic",
    });
  });
});

// ── respond_negotiate ────────────────────────────────────────────────────

const COUNTER_INPUT = {
  negotiation_id: "neg_1",
  decision: "counter",
  message: "not quite",
  counter_proposal: "ship Wednesday",
};

describe("respond_negotiate handler", () => {
  it("reports terminal when the server returns null (accept/reject)", async () => {
    const h = harness({ respondNegotiate: async () => null });
    const result = await pick(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "accept",
      message: "agreed",
    });

    expect(h.mesh.respondNegotiate).toHaveBeenCalledWith(
      "neg_1",
      {
        negotiation_id: "neg_1",
        from_agent_id: "agent_x",
        decision: "accept",
        message: "agreed",
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

  it("projects the peer's continuation when the round goes on", async () => {
    const h = harness({
      respondNegotiate: async () => ({
        negotiation_id: "neg_1",
        from_agent_id: "agent_peer",
        decision: "counter",
        message: "Thursday then",
        counter_proposal: "ship Thursday",
      }),
    });
    const result = await pick(h, "respond_negotiate").handler(COUNTER_INPUT);

    expect(result.content).toMatchObject({
      from_agent_id: "agent_peer",
      counter_proposal: "ship Thursday",
    });
  });

  it("projects an escalated sentinel returned to the responder", async () => {
    const h = harness({
      respondNegotiate: async () => ({
        decision: "escalated",
        escalation_id: "esc_9",
        negotiation_id: "neg_1",
        message: "peer escalated",
      }),
    });
    const result = await pick(h, "respond_negotiate").handler(COUNTER_INPUT);

    expect(result.content).toMatchObject({
      decision: "escalated",
      escalation_id: "esc_9",
    });
  });

  it("forwards counter_proposal on the counter path", async () => {
    const h = harness();
    await pick(h, "respond_negotiate").handler(COUNTER_INPUT);

    expect(h.mesh.respondNegotiate.mock.calls[0]?.[1]).toMatchObject({
      decision: "counter",
      counter_proposal: "ship Wednesday",
    });
  });

  it.each([
    ["negotiation_id", { decision: "accept", message: "ok" }],
    ["message", { negotiation_id: "neg_1", decision: "accept" }],
  ])("rejects a call missing %s", async (_label, input) => {
    const h = harness();
    const result = await pick(h, "respond_negotiate").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "negotiation_id and message required",
    });
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it.each([["approve"], [""], ["escalated"]])(
    "rejects decision %j",
    async (decision) => {
      const h = harness();
      const result = await pick(h, "respond_negotiate").handler({
        negotiation_id: "neg_1",
        decision,
        message: "m",
      });

      expect(result.isError).toBe(true);
      expect(String(result.content.error)).toContain(
        "decision must be one of: counter, accept, reject",
      );
      expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
    },
  );

  it("rejects decision='counter' with no counter_proposal", async () => {
    const h = harness();
    const result = await pick(h, "respond_negotiate").handler({
      negotiation_id: "neg_1",
      decision: "counter",
      message: "not quite",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "counter_proposal required when decision='counter'",
    });
    expect(h.mesh.respondNegotiate).not.toHaveBeenCalled();
  });

  it("keeps max_rounds_exceeded machine-readable for the escalate hand-off", async () => {
    const h = harness({
      respondNegotiate: async () => {
        throw new MeshMaxRoundsError({
          negotiationId: "neg_1",
          rounds_completed: 5,
          max_rounds: 5,
        });
      },
    });
    const result = await pick(h, "respond_negotiate").handler(COUNTER_INPUT);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "MAX_ROUNDS_EXCEEDED",
      negotiationId: "neg_1",
      rounds_completed: 5,
      max_rounds: 5,
    });
    expect(String(result.content.message)).toContain("escalate_to_humans");
  });
});

// ── report_blocker ───────────────────────────────────────────────────────

describe("report_blocker handler", () => {
  it("marks the task blocked, then spawns the parent", async () => {
    const h = harness();
    const result = await pick(h, "report_blocker").handler({
      task_id: "task_1",
      description: "the API key is missing",
    });

    expect(h.findParent).toHaveBeenCalledWith("agent_x");
    expect(h.markBlocked).toHaveBeenCalledWith(
      "task_1",
      "agent_x",
      "the API key is missing",
    );
    expect(h.mesh.reportBlocker).toHaveBeenCalledWith(
      "agent_parent",
      "agent_x",
      "task_1",
      "the API key is missing",
    );
    expect(result.content).toEqual({
      reported: true,
      parent_agent_id: "agent_parent",
      task_id: "task_1",
    });
  });

  it.each([
    ["task_id", { description: "d" }],
    ["description", { task_id: "task_1" }],
  ])("rejects a call missing %s", async (_label, input) => {
    const h = harness();
    const result = await pick(h, "report_blocker").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "task_id and description required" });
    expect(h.findParent).not.toHaveBeenCalled();
  });

  it("refuses for a top-level agent and leaves the task untouched", async () => {
    const h = harness({ parent: undefined });
    const result = await pick(h, "report_blocker").handler({
      task_id: "task_1",
      description: "stuck",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "no_parent_to_block" });
    expect(String(result.content.message)).toContain("escalate_to_humans");
    expect(h.markBlocked).not.toHaveBeenCalled();
    expect(h.mesh.reportBlocker).not.toHaveBeenCalled();
  });

  it("does not spawn the parent when marking the task blocked fails", async () => {
    const h = harness({
      markBlocked: async () => {
        throw new Error("task not found");
      },
    });
    const result = await pick(h, "report_blocker").handler({
      task_id: "task_gone",
      description: "stuck",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "task not found" });
    expect(h.mesh.reportBlocker).not.toHaveBeenCalled();
  });
});

// ── escalate_to_humans ───────────────────────────────────────────────────

const ESCALATE_INPUT = {
  negotiation_id: "neg_1",
  summary: "We're stuck on the ship date.",
  proposals: [{ title: "Ship Monday", description: "cut scope" }],
  open_questions: ["Is the customer demo fixed?"],
};

describe("escalate_to_humans handler", () => {
  it("creates the escalation, unblocks the peer, then notifies", async () => {
    const h = harness();
    const result = await pick(h, "escalate_to_humans").handler(ESCALATE_INPUT);

    expect(h.createEscalation).toHaveBeenCalledWith({
      negotiationId: "neg_1",
      callerAgentId: "agent_x",
      summary: "We're stuck on the ship date.",
      proposals: ESCALATE_INPUT.proposals,
      openQuestions: ESCALATE_INPUT.open_questions,
    });
    expect(h.mesh.unblockOnEscalate).toHaveBeenCalledWith("neg_1", "esc_1");
    expect(h.query).toHaveBeenCalledWith(
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
    ["not arrays", { proposals: "one", open_questions: "two" }],
    ["absent", {}],
  ])("sends undefined when proposals/open_questions are %s", async (_l, extra) => {
    const h = harness();
    await pick(h, "escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "s",
      ...extra,
    });

    expect(h.createEscalation.mock.calls[0]?.[0]).toMatchObject({
      proposals: undefined,
      openQuestions: undefined,
    });
  });

  it("drops non-string entries from open_questions", async () => {
    const h = harness();
    await pick(h, "escalate_to_humans").handler({
      negotiation_id: "neg_1",
      summary: "s",
      open_questions: ["real question", 42, null],
    });

    expect(h.createEscalation.mock.calls[0]?.[0]).toMatchObject({
      openQuestions: ["real question"],
    });
  });

  it.each([
    ["negotiation_id", { summary: "s" }],
    ["summary", { negotiation_id: "neg_1" }],
  ])("rejects a call missing %s", async (_label, input) => {
    const h = harness();
    const result = await pick(h, "escalate_to_humans").handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "negotiation_id and summary required",
    });
    expect(h.createEscalation).not.toHaveBeenCalled();
  });

  it("neither unblocks nor notifies when the escalation insert fails", async () => {
    const h = harness({
      createEscalation: async () => {
        throw new Error("negotiation neg_1 already has an escalation");
      },
    });
    const result = await pick(h, "escalate_to_humans").handler(ESCALATE_INPUT);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "negotiation neg_1 already has an escalation",
    });
    expect(h.mesh.unblockOnEscalate).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
  });
});

// ── IC tier handlers ─────────────────────────────────────────────────────

describe("IC tier handlers are wired to the same context", () => {
  it("respond_ask from an IC still stamps the IC as responder", async () => {
    const mesh = { respondAsk: vi.fn() } as unknown as MeshServer;
    const icCaller: ResolvedCaller = {
      agentId: "agent_ic",
      source: "agent",
      hierarchyLevel: "ic",
    };
    const tools = buildIcMeshTools(
      { caller: icCaller, beevibeSid: "ses_ic" },
      { mesh } as unknown as MeshToolServices,
    );
    const respondAsk = tools.find((t) => t.name === "respond_ask");

    const result = await respondAsk?.handler({
      request_id: "req_1",
      answer: "here's what I know",
    });

    expect(
      (mesh as unknown as { respondAsk: ReturnType<typeof vi.fn> }).respondAsk,
    ).toHaveBeenCalledWith("req_1", {
      request_id: "req_1",
      from_agent_id: "agent_ic",
      answer: "here's what I know",
    });
    expect(result?.content).toEqual({ responded: true, request_id: "req_1" });
  });
});
