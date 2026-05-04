/**
 * Wire types for mesh tool round-trips.
 */

export interface AskResponse {
  request_id: string;
  /** Target agent's id (the responder). */
  from_agent_id: string;
  /** The answer text the target produced. */
  answer: string;
}

export type NegotiateDecision = "counter" | "accept" | "reject";

/**
 * One side's response in a negotiation. After round 1, BOTH sides use
 * `respond_negotiate` to alternate. The `decision` discriminates:
 *   - "counter" → counter_proposal required; sender expects the peer's
 *     reply and stays blocked
 *   - "accept" / "reject" → terminal; no continuation
 */
export interface NegotiateResponse {
  negotiation_id: string;
  from_agent_id: string;
  decision: NegotiateDecision;
  /** Free-form message from the responder. */
  message: string;
  /** Required when decision === 'counter'. */
  counter_proposal?: string;
}

/**
 * Sentinel returned to a blocked `respond_negotiate` when the peer escalated.
 * The blocked side reads this, calls `add_to_escalation(escalation_id, ...)`,
 * then exits.
 */
export interface EscalatedSentinel {
  decision: "escalated";
  message: string;
  escalation_id: string;
  negotiation_id: string;
}

export class MeshCapacityError extends Error {
  readonly code = "MESH_CAPACITY_EXCEEDED";
  constructor(
    message: string,
    public readonly meta: { agentId: string; running: number; cap: number },
  ) {
    super(message);
    this.name = "MeshCapacityError";
  }
}

export class MeshMaxRoundsError extends Error {
  readonly code = "MAX_ROUNDS_EXCEEDED";
  constructor(
    public readonly meta: {
      negotiationId: string;
      rounds_completed: number;
      max_rounds: number;
    },
  ) {
    super(
      `negotiation ${meta.negotiationId} hit max_rounds (${meta.rounds_completed}/${meta.max_rounds}); call escalate_to_humans`,
    );
    this.name = "MeshMaxRoundsError";
  }
}

/**
 * Thrown when a team/org agent calls `negotiate` with an IC target. ICs are
 * workers, not deciders — they don't have `respond_negotiate` (M9.1) so a
 * negotiation against them would hang forever. Use `ask` (lateral one-shot)
 * or `create_task` (downward delegation) instead.
 */
export class CannotNegotiateWithIcError extends Error {
  readonly code = "CANNOT_NEGOTIATE_WITH_IC";
  constructor(public readonly meta: { agentId: string }) {
    super(
      `cannot negotiate with IC agent ${meta.agentId} — ICs are workers, not deciders. Use ask() or create_task() instead.`,
    );
    this.name = "CannotNegotiateWithIcError";
  }
}
