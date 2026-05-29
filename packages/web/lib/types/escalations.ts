// Serialized escalation shapes returned by GET /escalation/:id. The
// non-date types are re-exported straight from @beevibe/core (single
// source of truth); only the escalation row itself needs a serialized
// mirror because JSON over the wire turns its timestamps into ISO
// strings.

import type {
  EscalationReview,
  Proposal,
  RecoveredPosition,
} from "@beevibe/core";

export type EscalationProposal = Proposal;
export type EscalationRecoveredPosition = RecoveredPosition;

export type EscalationReviewDetail = Omit<
  EscalationReview,
  | "initiator_submitted_at"
  | "counterparty_submitted_at"
  | "resolved_at"
  | "created_at"
  | "updated_at"
> & {
  initiator_submitted_at?: string;
  counterparty_submitted_at?: string;
  resolved_at?: string;
  created_at: string;
  updated_at: string;
};
