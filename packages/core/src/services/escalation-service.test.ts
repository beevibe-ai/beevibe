import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Escalation, Proposal } from "../domain/escalation.js";
import type { Agent } from "../domain/agent.js";
import type { Negotiation, NegotiationRound } from "../domain/negotiation.js";
import type { Task } from "../domain/task.js";
import type { AgentRepository } from "../ports/agent-repo.js";
import type { EscalationRepository } from "../ports/escalation-repo.js";
import type {
  NegotiationRepository,
  NegotiationRoundRepository,
} from "../ports/negotiation-repo.js";
import type { TaskRepository } from "../ports/task-repo.js";
import type { DispatchService } from "./dispatch-service.js";
import {
  EscalationNotFoundError,
  EscalationService,
  EscalationStateError,
  NotPartyError,
} from "./escalation-service.js";
import { NegotiationNotFoundError } from "./negotiation-service.js";

function makeNeg(overrides: Partial<Negotiation> = {}): Negotiation {
  return {
    id: "neg_1",
    initiator_agent_id: "agent_a",
    initiator_session_id: "sess_a",
    counterparty_agent_id: "agent_b",
    counterparty_session_id: "sess_b",
    task_id: "task_1",
    max_rounds: 5,
    rounds_completed: 5,
    status: "active",
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeEsc(overrides: Partial<Escalation> = {}): Escalation {
  return {
    id: "esc_1",
    negotiation_id: "neg_1",
    initiator_session_id: "sess_a",
    counterparty_session_id: "sess_b",
    summary: "we're stuck",
    initiator_proposals: undefined,
    initiator_open_questions: [],
    counterparty_proposals: undefined,
    counterparty_open_questions: [],
    escalated_by_role: "initiator",
    status: "pending",
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

let escalationRepo: EscalationRepository;
let negotiationRepo: NegotiationRepository;
let negotiationRoundRepo: NegotiationRoundRepository;
let taskRepo: TaskRepository;
let agentRepo: AgentRepository;
let svc: EscalationService;

beforeEach(() => {
  escalationRepo = {
    findById: vi.fn(),
    findByNegotiation: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };
  negotiationRepo = {
    findById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };
  negotiationRoundRepo = {
    listByNegotiation: vi.fn(),
    create: vi.fn(),
  };
  taskRepo = {
    findById: vi.fn(),
    list: vi.fn(),
    listByAssignee: vi.fn(),
    countChildrenNotComplete: vi.fn(),
    countChildren: vi.fn(),
    create: vi.fn(async (input) => ({ ...input, status: input.status ?? "pending", priority: input.priority, created_at: new Date(), updated_at: new Date() }) as Task),
    update: vi.fn(async (id, patch) => ({
      id,
      title: "T",
      status: patch.status ?? "assigned",
      priority: "medium",
      created_at: new Date(),
      updated_at: new Date(),
      ...patch,
    }) as Task),
    updateProgress: vi.fn(),
    markBlocked: vi.fn(),
    clearBlocker: vi.fn(),
    delete: vi.fn(),
  };
  agentRepo = {
    findById: vi.fn(),
    findByApiKey: vi.fn(),
    findTopLevelForOwner: vi.fn(),
    findSubordinates: vi.fn(),
    findPeers: vi.fn(),
    findParent: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  svc = new EscalationService({
    escalationRepo,
    negotiationRepo,
    negotiationRoundRepo,
    taskRepo,
    agentRepo,
  });
});

describe("EscalationService.create", () => {
  it("initiator escalating populates initiator slot + marks negotiation escalated + blocks task", async () => {
    vi.mocked(negotiationRepo.findById).mockResolvedValue(makeNeg());
    vi.mocked(escalationRepo.findByNegotiation).mockResolvedValue(undefined);
    vi.mocked(escalationRepo.create).mockImplementation(async (input) => makeEsc(input));
    vi.mocked(escalationRepo.findById).mockResolvedValue(
      makeEsc({
        initiator_proposals: [{ title: "A", description: "x" }],
        initiator_submitted_at: new Date(),
        escalated_by_role: "initiator",
      }),
    );

    const proposals: Proposal[] = [{ title: "A", description: "x" }];
    const result = await svc.create({
      negotiationId: "neg_1",
      callerAgentId: "agent_a",
      summary: "stuck",
      proposals,
      openQuestions: ["q1"],
    });

    expect(escalationRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        negotiation_id: "neg_1",
        summary: "stuck",
        escalated_by_role: "initiator",
        initiator_proposals: proposals,
      }),
    );
    expect(negotiationRepo.update).toHaveBeenCalledWith("neg_1", { status: "escalated" });
    expect(taskRepo.update).toHaveBeenCalledWith("task_1", { status: "blocked" });
    expect(result.escalated_by_role).toBe("initiator");
  });

  it("counterparty escalating populates counterparty slot via subsequent update", async () => {
    vi.mocked(negotiationRepo.findById).mockResolvedValue(makeNeg());
    vi.mocked(escalationRepo.findByNegotiation).mockResolvedValue(undefined);
    vi.mocked(escalationRepo.create).mockImplementation(async (input) => makeEsc(input));
    vi.mocked(escalationRepo.update).mockImplementation(async (id, patch) =>
      makeEsc({ id, ...(patch as Partial<Escalation>) }),
    );
    vi.mocked(escalationRepo.findById).mockResolvedValue(makeEsc());

    await svc.create({
      negotiationId: "neg_1",
      callerAgentId: "agent_b",
      summary: "stuck (B side)",
    });

    // First create with role=counterparty
    expect(escalationRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ escalated_by_role: "counterparty" }),
    );
    // Then update to populate counterparty slot
    expect(escalationRepo.update).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ counterparty_submitted_at: expect.any(Date) }),
    );
  });

  it("rejects callers who aren't a party to the negotiation", async () => {
    vi.mocked(negotiationRepo.findById).mockResolvedValue(makeNeg());
    vi.mocked(escalationRepo.findByNegotiation).mockResolvedValue(undefined);

    await expect(
      svc.create({ negotiationId: "neg_1", callerAgentId: "agent_z", summary: "x" }),
    ).rejects.toBeInstanceOf(NotPartyError);
  });

  it("rejects when an escalation already exists for the negotiation", async () => {
    vi.mocked(negotiationRepo.findById).mockResolvedValue(makeNeg());
    vi.mocked(escalationRepo.findByNegotiation).mockResolvedValue(makeEsc());

    await expect(
      svc.create({ negotiationId: "neg_1", callerAgentId: "agent_a", summary: "x" }),
    ).rejects.toBeInstanceOf(EscalationStateError);
  });

  it("404s when negotiation doesn't exist", async () => {
    vi.mocked(negotiationRepo.findById).mockResolvedValue(undefined);

    await expect(
      svc.create({ negotiationId: "neg_missing", callerAgentId: "agent_a", summary: "x" }),
    ).rejects.toBeInstanceOf(NegotiationNotFoundError);
  });

  it("rejects a negotiation that never started round 1 (no counterparty session)", async () => {
    // The escalation row requires both session ids; escalating before the
    // counterparty ever ran would write a half-formed row.
    vi.mocked(negotiationRepo.findById).mockResolvedValue(
      makeNeg({ counterparty_session_id: undefined }),
    );
    vi.mocked(escalationRepo.findByNegotiation).mockResolvedValue(undefined);

    await expect(
      svc.create({ negotiationId: "neg_1", callerAgentId: "agent_a", summary: "x" }),
    ).rejects.toThrow(/no counterparty_session_id/);
    expect(escalationRepo.create).not.toHaveBeenCalled();
    expect(negotiationRepo.update).not.toHaveBeenCalled();
  });

  it("skips the task block when the negotiation isn't task-bound", async () => {
    vi.mocked(negotiationRepo.findById).mockResolvedValue(
      makeNeg({ task_id: undefined }),
    );
    vi.mocked(escalationRepo.findByNegotiation).mockResolvedValue(undefined);
    vi.mocked(escalationRepo.create).mockImplementation(async (input) => makeEsc(input));
    vi.mocked(escalationRepo.findById).mockResolvedValue(makeEsc());

    await svc.create({ negotiationId: "neg_1", callerAgentId: "agent_a", summary: "x" });

    expect(negotiationRepo.update).toHaveBeenCalledWith("neg_1", { status: "escalated" });
    expect(taskRepo.update).not.toHaveBeenCalled();
  });

  it("falls back to the created row when the post-update re-fetch misses", async () => {
    vi.mocked(negotiationRepo.findById).mockResolvedValue(makeNeg());
    vi.mocked(escalationRepo.findByNegotiation).mockResolvedValue(undefined);
    vi.mocked(escalationRepo.create).mockImplementation(async (input) => makeEsc(input));
    vi.mocked(escalationRepo.findById).mockResolvedValue(undefined);

    const result = await svc.create({
      negotiationId: "neg_1",
      callerAgentId: "agent_a",
      summary: "x",
    });

    expect(result.negotiation_id).toBe("neg_1");
  });
});

describe("EscalationService.addContribution", () => {
  it("populates the OTHER party's slot", async () => {
    vi.mocked(escalationRepo.findById).mockResolvedValue(
      makeEsc({
        escalated_by_role: "initiator",
        initiator_proposals: [{ title: "A", description: "a" }],
        initiator_submitted_at: new Date(),
      }),
    );
    vi.mocked(negotiationRepo.findById).mockResolvedValue(makeNeg());
    vi.mocked(escalationRepo.update).mockImplementation(async (id, patch) =>
      makeEsc({ id, ...(patch as Partial<Escalation>) }),
    );

    const proposals: Proposal[] = [{ title: "B", description: "b" }];
    await svc.addContribution({
      escalationId: "esc_1",
      callerAgentId: "agent_b",
      proposals,
      openQuestions: ["bq"],
    });

    expect(escalationRepo.update).toHaveBeenCalledWith(
      "esc_1",
      expect.objectContaining({
        counterparty_proposals: proposals,
        counterparty_open_questions: ["bq"],
      }),
    );
  });

  it("rejects if the same role tries to add (escalator can't also add)", async () => {
    vi.mocked(escalationRepo.findById).mockResolvedValue(
      makeEsc({
        escalated_by_role: "initiator",
        initiator_submitted_at: new Date(),
      }),
    );
    vi.mocked(negotiationRepo.findById).mockResolvedValue(makeNeg());

    await expect(
      svc.addContribution({ escalationId: "esc_1", callerAgentId: "agent_a" }),
    ).rejects.toBeInstanceOf(EscalationStateError);
  });

  it("rejects if the side already submitted (idempotency)", async () => {
    vi.mocked(escalationRepo.findById).mockResolvedValue(
      makeEsc({
        escalated_by_role: "initiator",
        counterparty_submitted_at: new Date(),
      }),
    );
    vi.mocked(negotiationRepo.findById).mockResolvedValue(makeNeg());

    await expect(
      svc.addContribution({ escalationId: "esc_1", callerAgentId: "agent_b" }),
    ).rejects.toBeInstanceOf(EscalationStateError);
  });

  it("populates the initiator slot when the counterparty escalated", async () => {
    // Mirror of the first case — the role branch that picks initiator_* keys.
    vi.mocked(escalationRepo.findById).mockResolvedValue(
      makeEsc({
        escalated_by_role: "counterparty",
        counterparty_proposals: [{ title: "B", description: "b" }],
        counterparty_submitted_at: new Date(),
      }),
    );
    vi.mocked(negotiationRepo.findById).mockResolvedValue(makeNeg());
    vi.mocked(escalationRepo.update).mockImplementation(async (id, patch) =>
      makeEsc({ id, ...(patch as Partial<Escalation>) }),
    );

    const proposals: Proposal[] = [{ title: "A", description: "a" }];
    await svc.addContribution({
      escalationId: "esc_1",
      callerAgentId: "agent_a",
      proposals,
    });

    expect(escalationRepo.update).toHaveBeenCalledWith(
      "esc_1",
      expect.objectContaining({
        initiator_proposals: proposals,
        initiator_open_questions: [],
        initiator_submitted_at: expect.any(Date),
      }),
    );
  });

  it("rejects contributions to an escalation that is no longer pending", async () => {
    vi.mocked(escalationRepo.findById).mockResolvedValue(
      makeEsc({ status: "resolved" }),
    );

    await expect(
      svc.addContribution({ escalationId: "esc_1", callerAgentId: "agent_b" }),
    ).rejects.toThrow(/not pending \(status='resolved'\)/);
    // Bails before touching the negotiation.
    expect(negotiationRepo.findById).not.toHaveBeenCalled();
  });

  it("throws EscalationNotFoundError for an unknown escalation id", async () => {
    vi.mocked(escalationRepo.findById).mockResolvedValue(undefined);

    await expect(
      svc.addContribution({ escalationId: "esc_missing", callerAgentId: "agent_b" }),
    ).rejects.toBeInstanceOf(EscalationNotFoundError);
  });

  it("throws NegotiationNotFoundError when the backing negotiation vanished", async () => {
    vi.mocked(escalationRepo.findById).mockResolvedValue(makeEsc());
    vi.mocked(negotiationRepo.findById).mockResolvedValue(undefined);

    await expect(
      svc.addContribution({ escalationId: "esc_1", callerAgentId: "agent_b" }),
    ).rejects.toBeInstanceOf(NegotiationNotFoundError);
  });
});

describe("EscalationService.resolve", () => {
  it("updates A's existing task + creates synthetic task for B; both with post_escalation context", async () => {
    vi.mocked(escalationRepo.findById).mockResolvedValueOnce(
      makeEsc({
        initiator_proposals: [{ title: "A0", description: "a0d" }],
        counterparty_proposals: [{ title: "B0", description: "b0d" }],
      }),
    );
    vi.mocked(negotiationRepo.findById).mockResolvedValue(makeNeg());
    vi.mocked(escalationRepo.update).mockImplementation(async (id, patch) =>
      makeEsc({ id, ...(patch as Partial<Escalation>) }),
    );
    vi.mocked(escalationRepo.findById).mockResolvedValue(
      makeEsc({ status: "resolved" }),
    );

    const result = await svc.resolve({
      escalationId: "esc_1",
      personId: "person_1",
      selector: { source: "counterparty", source_index: 0 },
      notes: "Cap timeline at 4 weeks.",
    });

    // Initiator task updated (existing task_1)
    expect(taskRepo.update).toHaveBeenCalledWith(
      "task_1",
      expect.objectContaining({
        status: "assigned",
        next_dispatch_context: expect.objectContaining({
          kind: "post_escalation",
          role: "initiator",
          resolution: expect.objectContaining({
            title: "B0",
            source: "counterparty",
            source_index: 0,
          }),
          notes: "Cap timeline at 4 weeks.",
          prior_session_id: "sess_a",
        }),
      }),
    );

    // Counterparty synth task created
    expect(taskRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        assignee_id: "agent_b",
        creator_id: "person_1",
        creator_type: "person",
        parent_task_id: "task_1",
        status: "assigned",
        next_dispatch_context: expect.objectContaining({
          role: "counterparty",
          prior_session_id: "sess_b",
        }),
      }),
    );

    // Escalation marked resolved with the chosen proposal
    expect(escalationRepo.update).toHaveBeenCalledWith(
      "esc_1",
      expect.objectContaining({
        status: "resolved",
        resolution_proposal: expect.objectContaining({
          title: "B0",
          source: "counterparty",
          source_index: 0,
        }),
        resolution_notes: "Cap timeline at 4 weeks.",
        resolved_by: "person_1",
      }),
    );

    expect(result.initiatorTaskId).toBe("task_1");
  });

  it("source='human': uses provided title/description; no source_index", async () => {
    vi.mocked(escalationRepo.findById).mockResolvedValueOnce(makeEsc());
    vi.mocked(negotiationRepo.findById).mockResolvedValue(makeNeg());
    vi.mocked(escalationRepo.update).mockImplementation(async (id, patch) =>
      makeEsc({ id, ...(patch as Partial<Escalation>) }),
    );
    vi.mocked(escalationRepo.findById).mockResolvedValue(
      makeEsc({ status: "resolved" }),
    );

    await svc.resolve({
      escalationId: "esc_1",
      personId: "person_1",
      selector: {
        source: "human",
        title: "Hybrid approach",
        description: "Reuse component X but rewrite Y.",
      },
    });

    expect(escalationRepo.update).toHaveBeenCalledWith(
      "esc_1",
      expect.objectContaining({
        resolution_proposal: {
          title: "Hybrid approach",
          description: "Reuse component X but rewrite Y.",
          source: "human",
        },
      }),
    );
  });

  it("synth-creates initiator task when negotiation has no task_id", async () => {
    vi.mocked(escalationRepo.findById).mockResolvedValueOnce(makeEsc());
    vi.mocked(negotiationRepo.findById).mockResolvedValue(makeNeg({ task_id: undefined }));
    vi.mocked(escalationRepo.update).mockImplementation(async (id, patch) =>
      makeEsc({ id, ...(patch as Partial<Escalation>) }),
    );
    vi.mocked(escalationRepo.findById).mockResolvedValue(
      makeEsc({ status: "resolved" }),
    );

    const result = await svc.resolve({
      escalationId: "esc_1",
      personId: "person_1",
      selector: { source: "human", title: "x", description: "y" },
    });

    // Two synth tasks (one for each side); taskRepo.update never called.
    expect(taskRepo.update).not.toHaveBeenCalled();
    expect(taskRepo.create).toHaveBeenCalledTimes(2);
    expect(result.initiatorTaskId).toMatch(/^task_/);
    expect(result.counterpartyTaskId).toMatch(/^task_/);
    expect(result.initiatorTaskId).not.toBe(result.counterpartyTaskId);
  });

  it("rejects with EscalationStateError if not pending", async () => {
    vi.mocked(escalationRepo.findById).mockResolvedValue(
      makeEsc({ status: "resolved" }),
    );

    await expect(
      svc.resolve({
        escalationId: "esc_1",
        personId: "person_1",
        selector: { source: "human", title: "x", description: "y" },
      }),
    ).rejects.toBeInstanceOf(EscalationStateError);
  });

  it("rejects invalid source_index (out of bounds or empty slot)", async () => {
    vi.mocked(escalationRepo.findById).mockResolvedValue(
      makeEsc({ initiator_proposals: [{ title: "A", description: "a" }] }),
    );
    vi.mocked(negotiationRepo.findById).mockResolvedValue(makeNeg());

    await expect(
      svc.resolve({
        escalationId: "esc_1",
        personId: "person_1",
        selector: { source: "initiator", source_index: 5 },
      }),
    ).rejects.toBeInstanceOf(EscalationStateError);

    await expect(
      svc.resolve({
        escalationId: "esc_1",
        personId: "person_1",
        selector: { source: "counterparty", source_index: 0 },
      }),
    ).rejects.toBeInstanceOf(EscalationStateError);
  });
});

describe("EscalationService.resolve — dispatch wiring", () => {
  let dispatchService: DispatchService;

  beforeEach(() => {
    // Post-Phase-4 nobody polls for 'assigned' tasks, so resolve() must
    // create the pending session rows itself. Without this the two sides
    // sit assigned forever.
    dispatchService = {
      dispatchTask: vi.fn(async () => ({ session: {}, runtime_id: null })),
    } as unknown as DispatchService;
    svc = new EscalationService({
      escalationRepo,
      negotiationRepo,
      negotiationRoundRepo,
      taskRepo,
      agentRepo,
      dispatchService,
    });

    vi.mocked(escalationRepo.findById).mockResolvedValue(
      makeEsc({
        initiator_proposals: [{ title: "A0", description: "a0d" }],
        counterparty_proposals: [{ title: "B0", description: "b0d" }],
      }),
    );
    vi.mocked(negotiationRepo.findById).mockResolvedValue(makeNeg());
    vi.mocked(escalationRepo.update).mockImplementation(async (id, patch) =>
      makeEsc({ id, ...(patch as Partial<Escalation>) }),
    );
  });

  it("dispatches both sides with post_escalation reasons pinned to their prior sessions", async () => {
    await svc.resolve({
      escalationId: "esc_1",
      personId: "person_1",
      selector: { source: "initiator", source_index: 0 },
      notes: "go with A0",
    });

    expect(dispatchService.dispatchTask).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(dispatchService.dispatchTask).mock.calls.map((c) => c[0]);

    const initiator = calls.find((c) => c.agentId === "agent_a");
    expect(initiator).toBeDefined();
    expect(initiator!.type).toBe("task");
    expect(initiator!.reason).toMatchObject({
      kind: "post_escalation",
      role: "initiator",
      prior_session_id: "sess_a",
    });

    const counterparty = calls.find((c) => c.agentId === "agent_b");
    expect(counterparty).toBeDefined();
    expect(counterparty!.reason).toMatchObject({
      kind: "post_escalation",
      role: "counterparty",
      prior_session_id: "sess_b",
    });
  });

  it("dispatches each side against its own task, with the resolution in the intent", async () => {
    const result = await svc.resolve({
      escalationId: "esc_1",
      personId: "person_1",
      selector: { source: "initiator", source_index: 0 },
    });

    const calls = vi.mocked(dispatchService.dispatchTask).mock.calls.map((c) => c[0]);
    const initiator = calls.find((c) => c.agentId === "agent_a")!;
    const counterparty = calls.find((c) => c.agentId === "agent_b")!;

    expect(initiator.task.id).toBe(result.initiatorTaskId);
    expect(counterparty.task.id).toBe(result.counterpartyTaskId);
    expect(initiator.intent).toContain(result.initiatorTaskId);
    expect(counterparty.intent).toContain(result.counterpartyTaskId);
  });

  it("still resolves when no dispatchService is configured", async () => {
    svc = new EscalationService({
      escalationRepo,
      negotiationRepo,
      negotiationRoundRepo,
      taskRepo,
      agentRepo,
    });

    const result = await svc.resolve({
      escalationId: "esc_1",
      personId: "person_1",
      selector: { source: "initiator", source_index: 0 },
    });

    expect(dispatchService.dispatchTask).not.toHaveBeenCalled();
    expect(result.initiatorTaskId).toBeTruthy();
    expect(result.counterpartyTaskId).toBeTruthy();
  });
});

describe("EscalationService.getReview", () => {
  function makeRound(overrides: Partial<NegotiationRound> = {}): NegotiationRound {
    return {
      id: "round_1",
      negotiation_id: "neg_1",
      round_number: 1,
      from_agent_id: "agent_a",
      decision: "propose",
      message: "round message",
      sent_at: new Date(),
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.mocked(agentRepo.findById).mockImplementation(
      async (id: string) =>
        ({
          id,
          name: id === "agent_a" ? "Alice team" : id === "agent_b" ? "Bob team" : id,
        }) as unknown as Agent,
    );
  });

  it("backfills the un-submitted side from its last round (counterparty escalated)", async () => {
    vi.mocked(escalationRepo.findById).mockResolvedValue(
      makeEsc({
        escalated_by_role: "counterparty",
        counterparty_proposals: [{ title: "B", description: "b" }],
        counterparty_submitted_at: new Date(),
        initiator_submitted_at: undefined,
      }),
    );
    vi.mocked(negotiationRepo.findById).mockResolvedValue(makeNeg());
    vi.mocked(negotiationRoundRepo.listByNegotiation).mockResolvedValue([
      makeRound({ round_number: 1, from_agent_id: "agent_a", decision: "propose", message: "A opening" }),
      makeRound({ id: "round_2", round_number: 2, from_agent_id: "agent_b", decision: "counter", message: "B counter" }),
      makeRound({ id: "round_3", round_number: 3, from_agent_id: "agent_a", decision: "counter", message: "A latest" }),
    ]);

    const review = await svc.getReview("esc_1");

    expect(review.initiator_recovered).toEqual({
      from_round: 3,
      decision: "counter",
      message: "A latest",
    });
    expect(review.counterparty_recovered).toBeUndefined();
    expect(review.initiator_agent_name).toBe("Alice team");
    expect(review.counterparty_agent_name).toBe("Bob team");
  });

  it("includes agent names without a round fetch when both sides submitted", async () => {
    vi.mocked(escalationRepo.findById).mockResolvedValue(
      makeEsc({
        initiator_submitted_at: new Date(),
        counterparty_submitted_at: new Date(),
      }),
    );
    vi.mocked(negotiationRepo.findById).mockResolvedValue(makeNeg());

    const review = await svc.getReview("esc_1");

    expect(review.initiator_recovered).toBeUndefined();
    expect(review.counterparty_recovered).toBeUndefined();
    expect(review.initiator_agent_name).toBe("Alice team");
    expect(review.counterparty_agent_name).toBe("Bob team");
    expect(negotiationRoundRepo.listByNegotiation).not.toHaveBeenCalled();
  });

  it("leaves recovered undefined when the un-submitted side has no rounds", async () => {
    vi.mocked(escalationRepo.findById).mockResolvedValue(
      makeEsc({
        escalated_by_role: "counterparty",
        counterparty_submitted_at: new Date(),
        initiator_submitted_at: undefined,
      }),
    );
    vi.mocked(negotiationRepo.findById).mockResolvedValue(makeNeg());
    vi.mocked(negotiationRoundRepo.listByNegotiation).mockResolvedValue([
      makeRound({ round_number: 2, from_agent_id: "agent_b", decision: "counter", message: "B only" }),
    ]);

    const review = await svc.getReview("esc_1");

    expect(review.initiator_recovered).toBeUndefined();
  });

  it("throws EscalationNotFoundError for a missing escalation", async () => {
    vi.mocked(escalationRepo.findById).mockResolvedValue(undefined);
    await expect(svc.getReview("esc_missing")).rejects.toThrow(EscalationNotFoundError);
  });

  it("still reads a resolved escalation — unlike the mutating paths", async () => {
    // getReview shares its fetch-and-check preamble with addContribution and
    // resolve, but deliberately does NOT require status='pending': the review
    // page renders resolved escalations too. Pin that difference so the
    // shared loader can't quietly grow a pending check.
    vi.mocked(escalationRepo.findById).mockResolvedValue(
      makeEsc({
        status: "resolved",
        initiator_proposals: [{ title: "A", description: "a" }],
        initiator_submitted_at: new Date(),
        counterparty_proposals: [{ title: "B", description: "b" }],
        counterparty_submitted_at: new Date(),
      }),
    );
    vi.mocked(negotiationRepo.findById).mockResolvedValue(makeNeg());
    vi.mocked(negotiationRoundRepo.listByNegotiation).mockResolvedValue([]);

    const review = await svc.getReview("esc_1");

    expect(review.status).toBe("resolved");
    expect(review.initiator_recovered).toBeUndefined();
    expect(review.counterparty_recovered).toBeUndefined();
  });
});
