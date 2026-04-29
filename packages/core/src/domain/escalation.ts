/**
 * Escalation domain types. M6.3 lands the structural types needed by the
 * `buildIntent` helper in agent-session.ts. M6.4 adds the `Escalation`
 * interface itself (the row type backing the `escalation` table) along with
 * the lifecycle + resolution flows.
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
