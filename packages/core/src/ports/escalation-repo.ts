import type { Escalation, EscalationStatus, Proposal, ResolutionProposal } from "../domain/escalation.js";

export type NewEscalation = Omit<
  Escalation,
  | "status"
  | "resolution_proposal"
  | "resolution_notes"
  | "resolved_by"
  | "resolved_at"
  | "counterparty_proposals"
  | "counterparty_open_questions"
  | "counterparty_submitted_at"
  | "created_at"
  | "updated_at"
> & {
  /** Defaults to 'pending'. */
  status?: EscalationStatus;
};

/**
 * Patch for the second-side contribution + resolution. Identity fields
 * (negotiation_id, session ids, summary, escalated_by_role) are immutable.
 */
export interface EscalationPatch {
  /** Used by `add_to_escalation` to populate the counterparty slot. */
  counterparty_proposals?: Proposal[];
  counterparty_open_questions?: string[];
  counterparty_submitted_at?: Date;
  /** Used by `escalate_to_humans` if escalator is initiator (their slot). */
  initiator_proposals?: Proposal[];
  initiator_open_questions?: string[];
  initiator_submitted_at?: Date;
  /** Set by EscalationService.resolve. */
  status?: EscalationStatus;
  resolution_proposal?: ResolutionProposal;
  resolution_notes?: string;
  resolved_by?: string;
  resolved_at?: Date;
}

export interface EscalationRepository {
  findById(id: string): Promise<Escalation | undefined>;
  /** One escalation per negotiation (UNIQUE constraint). */
  findByNegotiation(negotiationId: string): Promise<Escalation | undefined>;
  listPending(): Promise<Escalation[]>;
  create(input: NewEscalation): Promise<Escalation>;
  update(id: string, patch: EscalationPatch): Promise<Escalation>;
}
