/**
 * Escalation domain.
 *
 * An escalation is a stuck two-agent negotiation handed off to a human
 * reviewer. Created by the first party calling `escalate_to_humans`; the
 * peer adds their perspective via `add_to_escalation` after receiving the
 * sentinel from their blocked respond_negotiate. Resolved by the human via
 * POST /escalation/:id/resolve, which spawns synthetic tasks for both
 * sides with `next_dispatch_context.kind === 'post_escalation'`.
 *
 * Single shared `summary` (set on first call, immutable). Each side's
 * `proposals` + `open_questions` populated independently in role-tagged
 * slots.
 */

import type { NegotiationDecision } from "./negotiation.js";

/**
 * A single proposal an agent submits during escalate_to_humans /
 * add_to_escalation. Plain content; no source tagging — that's the
 * agent's role in the escalation, captured at the row level.
 */
export interface Proposal {
  title: string;
  description: string;
  /** Optional: trade-offs, conditions, etc. */
  tradeoffs?: string;
}

/**
 * The human's final resolution. Either a copy-with-edits of one of the
 * agents' proposals, or a fresh human-authored solution.
 *
 * - `source='initiator'` / `'counterparty'`: copied from that party's
 *   proposals array, optionally with edited title/description (audit
 *   preserves the original via `source_index`).
 * - `source='human'`: human composed; no source_index.
 */
export interface ResolutionProposal {
  title: string;
  description: string;
  source: "initiator" | "counterparty" | "human";
  /** Index into the source-tagged proposals array. Present iff source !== 'human'. */
  source_index?: number;
}

export type EscalationStatus = "pending" | "resolved" | "cancelled";

export interface Escalation {
  id: string;
  negotiation_id: string;

  initiator_session_id: string;
  counterparty_session_id: string;

  summary: string;

  initiator_proposals?: Proposal[];
  initiator_open_questions: string[];
  initiator_submitted_at?: Date;

  counterparty_proposals?: Proposal[];
  counterparty_open_questions: string[];
  counterparty_submitted_at?: Date;

  /** Which role called escalate_to_humans first. Audit / UI hint. */
  escalated_by_role: "initiator" | "counterparty";

  status: EscalationStatus;
  resolution_proposal?: ResolutionProposal;
  resolution_notes?: string;
  resolved_by?: string;
  resolved_at?: Date;

  created_at: Date;
  updated_at: Date;
}

/**
 * A side's last negotiation-round message, surfaced as a fallback when that
 * side never filed proposals into the escalation — e.g. its mesh client
 * dropped before the escalation sentinel could land, so add_to_escalation
 * never fired. Lets a human reviewer see both positions even when one slot
 * is empty. The proposal text isn't lost; it lives in negotiation_round.
 */
export interface RecoveredPosition {
  from_round: number;
  decision: NegotiationDecision;
  message: string;
}

/**
 * An escalation prepared for human review: the stored row plus a recovered
 * fallback (see RecoveredPosition) for any side that never submitted. Pure
 * read-time composition — the underlying escalation row is never mutated.
 */
export interface EscalationReview extends Escalation {
  /** Display names of the two agents, resolved from the negotiation. Falls
   *  back to the agent id if the agent was since deleted. */
  initiator_agent_name: string;
  counterparty_agent_name: string;
  initiator_recovered?: RecoveredPosition;
  counterparty_recovered?: RecoveredPosition;
}
