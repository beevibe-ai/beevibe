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
