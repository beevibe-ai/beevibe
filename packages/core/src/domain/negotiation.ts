/**
 * Negotiation domain. Two-agent multi-round protocol via the `negotiate` /
 * `respond_negotiate` mesh tools.
 *
 * B-resident model: the responder agent is spawned ONCE on round 1 and
 * stays alive through all rounds, alternating blocking via
 * `respond_negotiate`. After round 1 BOTH sides use respond_negotiate; the
 * resolver-map pattern in MeshServer (M6.4) toggles which side is blocked
 * each round. Single `counterparty_session_id` on the row reflects this —
 * not per-round.
 *
 * Per-round messages live on `negotiation_round` rows (one per turn). When
 * either side calls accept/reject, the negotiation transitions to a
 * terminal status; when the round cap is hit, status becomes 'escalated'
 * and an `escalation` row is created via escalate_to_humans.
 */

export type NegotiationStatus =
  | "active"
  | "accepted"
  | "rejected"
  | "escalated"
  | "cancelled";

export type NegotiationDecision = "propose" | "counter" | "accept" | "reject";

export interface Negotiation {
  id: string;
  initiator_agent_id: string;
  initiator_session_id: string;
  counterparty_agent_id: string;
  /** Set once B's session is created on round 1; immutable thereafter. */
  counterparty_session_id?: string;
  task_id?: string;

  /** Stamped from initiator_agent.max_negotiation_rounds (or default 5). */
  max_rounds: number;
  /** Bumped by every `respond_negotiate` insert into negotiation_round. */
  rounds_completed: number;

  status: NegotiationStatus;

  created_at: Date;
  updated_at: Date;
}

export interface NegotiationRound {
  id: string;
  negotiation_id: string;
  round_number: number;
  from_agent_id: string;
  decision: NegotiationDecision;
  message: string;
  sent_at: Date;
}
