import type {
  Escalation,
  Proposal,
  ResolutionProposal,
} from "../domain/escalation.js";
import type { NextDispatchContext } from "../domain/task.js";
import { escalationId as makeEscalationId, taskId as makeTaskId } from "../domain/ids.js";
import type { AgentRepository } from "../ports/agent-repo.js";
import type { EscalationRepository } from "../ports/escalation-repo.js";
import type { NegotiationRepository } from "../ports/negotiation-repo.js";
import type { TaskRepository } from "../ports/task-repo.js";
import { buildIntent, type ResumeReason } from "./agent-session.js";
import type { DispatchService } from "./dispatch-service.js";

export class EscalationNotFoundError extends Error {
  readonly code = "ESCALATION_NOT_FOUND";
  constructor(id: string) {
    super(`Escalation ${id} not found`);
    this.name = "EscalationNotFoundError";
  }
}

export class EscalationStateError extends Error {
  readonly code = "ESCALATION_STATE_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "EscalationStateError";
  }
}

export class NegotiationNotFoundError extends Error {
  readonly code = "NEGOTIATION_NOT_FOUND";
  constructor(id: string) {
    super(`Negotiation ${id} not found`);
    this.name = "NegotiationNotFoundError";
  }
}

export class NotPartyError extends Error {
  readonly code = "NOT_PARTY";
  constructor(message: string) {
    super(message);
    this.name = "NotPartyError";
  }
}

export interface EscalationServiceDeps {
  escalationRepo: EscalationRepository;
  negotiationRepo: NegotiationRepository;
  taskRepo: TaskRepository;
  agentRepo: AgentRepository;
  /**
   * Required to spawn the post-resolution sessions for both initiator and
   * counterparty. Optional for dependency-injection in tests that exercise
   * resolve() without verifying dispatch (the create-only paths still
   * require it for state-transition correctness — leaving this undefined
   * means no pending session lands and the post-escalation flow stalls).
   */
  dispatchService?: DispatchService;
}

export interface CreateEscalationInput {
  /** The negotiation being escalated. */
  negotiationId: string;
  /** Caller's agent id (must be initiator or counterparty of the negotiation). */
  callerAgentId: string;
  summary: string;
  proposals?: Proposal[];
  openQuestions?: string[];
}

export interface AddToEscalationInput {
  escalationId: string;
  callerAgentId: string;
  proposals?: Proposal[];
  openQuestions?: string[];
}

/** Spec for which proposal slot to copy (audit-preserving), with optional edits. */
export type ResolveSelector =
  | { source: "initiator" | "counterparty"; source_index: number; edited_title?: string; edited_description?: string }
  | { source: "human"; title: string; description: string };

export interface ResolveInput {
  escalationId: string;
  /** Resolving person (bv_u_ caller). Stored as resolved_by. */
  personId: string;
  selector: ResolveSelector;
  /** Optional free-form addendum (e.g., "but cap timeline at 4 weeks"). */
  notes?: string;
}

export interface ResolveResult {
  escalation: Escalation;
  /** Task id that owns the initiator's resumed dispatch (existing or synthetic). */
  initiatorTaskId: string;
  /** Synthetic task id for the counterparty's follow-up (always synthetic). */
  counterpartyTaskId: string;
}

/**
 * EscalationService — DB writes only. NO spawning, NO orchestration.
 *
 * Per the M6 plan: api server stays narrow (write rows + pg_notify); the
 * executor picks up the re-queued tasks within ≤30s and does the actual
 * dispatch. This keeps capacity logic in one place (the executor's existing
 * `hasTaskCapacity`) and avoids duplicating spawn paths.
 */
export class EscalationService {
  constructor(private readonly deps: EscalationServiceDeps) {}

  /**
   * `escalate_to_humans` backend. Creates the escalation row populating the
   * caller's slot. Caller MUST be a party to the negotiation (initiator or
   * counterparty). Returns the new row.
   *
   * Side effects:
   *   - INSERT escalation { status: 'pending', escalated_by_role, summary, ... }
   *   - UPDATE negotiation SET status='escalated'
   *   - UPDATE task SET status='blocked' (if neg.task_id is set)
   *
   * Caller is responsible for resolving the peer's pending respond_negotiate
   * promise with a sentinel — the service can't reach the in-memory resolver
   * map (it lives in MeshServer).
   */
  async create(input: CreateEscalationInput): Promise<Escalation> {
    const neg = await this.deps.negotiationRepo.findById(input.negotiationId);
    if (!neg) throw new NegotiationNotFoundError(input.negotiationId);

    const role = this.callerRole(neg, input.callerAgentId);

    // Reject if already escalated (UNIQUE on negotiation_id will enforce
    // anyway, but a clear domain error is friendlier).
    const existing = await this.deps.escalationRepo.findByNegotiation(neg.id);
    if (existing) {
      throw new EscalationStateError(
        `negotiation ${neg.id} already has an escalation; use add_to_escalation`,
      );
    }

    if (!neg.counterparty_session_id) {
      throw new EscalationStateError(
        `negotiation ${neg.id} has no counterparty_session_id (round 1 not started?)`,
      );
    }

    const created = await this.deps.escalationRepo.create({
      id: makeEscalationId(),
      negotiation_id: neg.id,
      initiator_session_id: neg.initiator_session_id,
      counterparty_session_id: neg.counterparty_session_id,
      summary: input.summary,
      escalated_by_role: role,
      // Populate the caller's slot at create time.
      ...(role === "initiator"
        ? {
            initiator_proposals: input.proposals,
            initiator_open_questions: input.openQuestions ?? [],
            initiator_submitted_at: new Date(),
          }
        : {
            initiator_open_questions: [],
          }),
    });

    // If escalator was the counterparty, populate their slot via update
    // (the create signature only carries initiator slots — escalation_repo
    // omits counterparty slots from NewEscalation).
    if (role === "counterparty") {
      await this.deps.escalationRepo.update(created.id, {
        counterparty_proposals: input.proposals,
        counterparty_open_questions: input.openQuestions ?? [],
        counterparty_submitted_at: new Date(),
      });
    }

    // Mark negotiation escalated (terminal — never flips back).
    await this.deps.negotiationRepo.update(neg.id, { status: "escalated" });

    // Block the task if the negotiation was task-bound.
    if (neg.task_id) {
      await this.deps.taskRepo.update(neg.task_id, { status: "blocked" });
    }

    // Re-fetch to get the post-update row (counterparty case).
    const final = await this.deps.escalationRepo.findById(created.id);
    return final ?? created;
  }

  /**
   * `add_to_escalation` backend. Populates the OTHER party's slot. Caller
   * must be the party who DIDN'T escalate.
   */
  async addContribution(input: AddToEscalationInput): Promise<Escalation> {
    const esc = await this.deps.escalationRepo.findById(input.escalationId);
    if (!esc) throw new EscalationNotFoundError(input.escalationId);
    if (esc.status !== "pending") {
      throw new EscalationStateError(
        `escalation ${esc.id} is not pending (status='${esc.status}')`,
      );
    }

    const neg = await this.deps.negotiationRepo.findById(esc.negotiation_id);
    if (!neg) throw new NegotiationNotFoundError(esc.negotiation_id);

    const role = this.callerRole(neg, input.callerAgentId);
    if (role === esc.escalated_by_role) {
      throw new EscalationStateError(
        `caller ${input.callerAgentId} already escalated; cannot also add_to_escalation`,
      );
    }

    // Idempotency: if this side already submitted, reject.
    const alreadySubmitted =
      role === "initiator"
        ? esc.initiator_submitted_at !== undefined
        : esc.counterparty_submitted_at !== undefined;
    if (alreadySubmitted) {
      throw new EscalationStateError(
        `caller's slot (${role}) already submitted on escalation ${esc.id}`,
      );
    }

    const updated = await this.deps.escalationRepo.update(esc.id, {
      ...(role === "initiator"
        ? {
            initiator_proposals: input.proposals,
            initiator_open_questions: input.openQuestions ?? [],
            initiator_submitted_at: new Date(),
          }
        : {
            counterparty_proposals: input.proposals,
            counterparty_open_questions: input.openQuestions ?? [],
            counterparty_submitted_at: new Date(),
          }),
    });

    return updated;
  }

  /**
   * `POST /escalation/:id/resolve` backend. Marks the escalation resolved
   * with the chosen proposal, and re-queues both sides' tasks for dispatch:
   *
   *   - initiator: if neg.task_id is set, UPDATE that task to status=
   *     'assigned' with `next_dispatch_context.kind='post_escalation'`
   *     and `role='initiator'`. If no task_id (rare), INSERT a synthetic
   *     task for the initiator.
   *
   *   - counterparty: ALWAYS INSERT a synthetic task (B has no own task —
   *     it was a mesh peer). Status='assigned' with
   *     `next_dispatch_context.kind='post_escalation'` and
   *     `role='counterparty'`.
   *
   * Both tasks land at status='assigned' with stamped contexts; executor
   * picks them up within ≤30s. NO spawning happens here.
   */
  async resolve(input: ResolveInput): Promise<ResolveResult> {
    const esc = await this.deps.escalationRepo.findById(input.escalationId);
    if (!esc) throw new EscalationNotFoundError(input.escalationId);
    if (esc.status !== "pending") {
      throw new EscalationStateError(
        `escalation ${esc.id} is not pending (status='${esc.status}')`,
      );
    }

    const neg = await this.deps.negotiationRepo.findById(esc.negotiation_id);
    if (!neg) throw new NegotiationNotFoundError(esc.negotiation_id);

    const chosenProposal = this.buildResolutionProposal(esc, input.selector);

    await this.deps.escalationRepo.update(esc.id, {
      status: "resolved",
      resolution_proposal: chosenProposal,
      resolution_notes: input.notes,
      resolved_by: input.personId,
      resolved_at: new Date(),
    });

    // Build per-role next_dispatch_context shapes. prior_session_id is the
    // session that ran during the negotiation — buildIntent (M6.5) emits
    // <task id/> + <context type="post_escalation"> with these.
    const initiatorCtx: NextDispatchContext = {
      kind: "post_escalation",
      role: "initiator",
      resolution: chosenProposal,
      notes: input.notes,
      prior_session_id: esc.initiator_session_id,
    };

    const counterpartyCtx: NextDispatchContext = {
      kind: "post_escalation",
      role: "counterparty",
      resolution: chosenProposal,
      notes: input.notes,
      prior_session_id: esc.counterparty_session_id,
    };

    // Initiator side — re-queue existing task or synth task (rare, when
    // negotiation wasn't task-bound).
    let initiatorTask;
    if (neg.task_id) {
      initiatorTask = await this.deps.taskRepo.update(neg.task_id, {
        status: "assigned",
        next_dispatch_context: initiatorCtx,
      });
    } else {
      initiatorTask = await this.deps.taskRepo.create({
        id: makeTaskId(),
        title: `Process escalation ${esc.id.slice(0, 8)} resolution`,
        description: "(see post-escalation context)",
        status: "assigned",
        priority: "medium",
        assignee_id: neg.initiator_agent_id,
        creator_id: input.personId,
        creator_type: "person",
        next_dispatch_context: initiatorCtx,
      });
    }

    // Counterparty side — always synthetic.
    const counterpartyTask = await this.deps.taskRepo.create({
      id: makeTaskId(),
      title: `Process escalation ${esc.id.slice(0, 8)} resolution`,
      description: "(see post-escalation context)",
      status: "assigned",
      priority: "medium",
      assignee_id: neg.counterparty_agent_id,
      creator_id: input.personId,
      creator_type: "person",
      parent_task_id: neg.task_id ?? undefined,
      next_dispatch_context: counterpartyCtx,
    });

    // Dispatch both sides. ResumeReason is structurally compatible with
    // NextDispatchContext for the post_escalation kind. Without dispatch,
    // the legacy executor used to claim the 'assigned' tasks via poll —
    // post-Phase-4 nobody polls tasks, so we must explicitly create the
    // pending session rows here.
    if (this.deps.dispatchService) {
      const initiatorReason: ResumeReason = initiatorCtx;
      const counterpartyReason: ResumeReason = counterpartyCtx;
      await Promise.all([
        this.deps.dispatchService.dispatchTask({
          task: initiatorTask,
          agentId: neg.initiator_agent_id,
          intent: buildIntent(
            { id: initiatorTask.id, title: initiatorTask.title, description: initiatorTask.description },
            initiatorReason,
          ),
          reason: initiatorReason,
          type: "task",
        }),
        this.deps.dispatchService.dispatchTask({
          task: counterpartyTask,
          agentId: neg.counterparty_agent_id,
          intent: buildIntent(
            { id: counterpartyTask.id, title: counterpartyTask.title, description: counterpartyTask.description },
            counterpartyReason,
          ),
          reason: counterpartyReason,
          type: "task",
        }),
      ]);
    }

    const finalEsc = await this.deps.escalationRepo.findById(esc.id);
    return {
      escalation: finalEsc!,
      initiatorTaskId: initiatorTask.id,
      counterpartyTaskId: counterpartyTask.id,
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private callerRole(
    neg: { initiator_agent_id: string; counterparty_agent_id: string },
    callerAgentId: string,
  ): "initiator" | "counterparty" {
    if (callerAgentId === neg.initiator_agent_id) return "initiator";
    if (callerAgentId === neg.counterparty_agent_id) return "counterparty";
    throw new NotPartyError(
      `agent ${callerAgentId} is not a party to this negotiation`,
    );
  }

  private buildResolutionProposal(
    esc: Escalation,
    selector: ResolveSelector,
  ): ResolutionProposal {
    if (selector.source === "human") {
      return {
        title: selector.title,
        description: selector.description,
        source: "human",
      };
    }
    const slot =
      selector.source === "initiator"
        ? esc.initiator_proposals
        : esc.counterparty_proposals;
    if (!slot || selector.source_index >= slot.length || selector.source_index < 0) {
      throw new EscalationStateError(
        `invalid source_index=${selector.source_index} for ${selector.source}_proposals`,
      );
    }
    const original = slot[selector.source_index]!;
    return {
      title: selector.edited_title ?? original.title,
      description: selector.edited_description ?? original.description,
      source: selector.source,
      source_index: selector.source_index,
    };
  }
}
