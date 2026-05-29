// Serialized escalation shapes returned by GET /escalation/:id. Mirrors
// @beevibe/core's EscalationReview but with ISO-string timestamps — the web
// receives JSON over the wire and never sees Date objects.

export interface EscalationProposal {
  title: string;
  description: string;
  tradeoffs?: string;
}

export type NegotiationDecision = "propose" | "counter" | "accept" | "reject";

/**
 * A side's last negotiation-round message, surfaced when that side never
 * filed proposals (e.g. its mesh client dropped before the escalation
 * sentinel landed). Lets the reviewer see both positions.
 */
export interface EscalationRecoveredPosition {
  from_round: number;
  decision: NegotiationDecision;
  message: string;
}

export interface EscalationResolution {
  title: string;
  description: string;
  source: "initiator" | "counterparty" | "human";
  source_index?: number;
}

export type EscalationStatus = "pending" | "resolved" | "cancelled";

export interface EscalationReviewDetail {
  id: string;
  negotiation_id: string;
  summary: string;
  escalated_by_role: "initiator" | "counterparty";

  initiator_agent_name: string;
  counterparty_agent_name: string;

  initiator_proposals?: EscalationProposal[];
  initiator_open_questions: string[];
  initiator_submitted_at?: string;
  initiator_recovered?: EscalationRecoveredPosition;

  counterparty_proposals?: EscalationProposal[];
  counterparty_open_questions: string[];
  counterparty_submitted_at?: string;
  counterparty_recovered?: EscalationRecoveredPosition;

  status: EscalationStatus;
  resolution_proposal?: EscalationResolution;
  resolution_notes?: string;
  resolved_by?: string;
  resolved_at?: string;

  created_at: string;
  updated_at: string;
}
