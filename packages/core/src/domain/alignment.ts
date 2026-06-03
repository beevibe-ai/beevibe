/**
 * Alignment Meeting domain types.
 *
 * A meeting keeps a team agent's specialists aligned and fixes memory drift.
 * See migration 1781200000000_add-alignment-meeting.sql for the why.
 */

export type AlignmentMeetingStatus = "prepping" | "active" | "wrapped";

export interface AlignmentMeeting {
  id: string;
  team_agent_id: string;
  owner_person_id: string;
  status: AlignmentMeetingStatus;
  /** Null until the first message is sent. */
  chat_session_id: string | null;
  notes: string;
  created_at: Date;
  updated_at: Date;
  wrapped_at: Date | null;
}

/**
 * gemma's plain-language card for one specialist. Deliberately jargon-free —
 * no scores, no protocol vocabulary. Each field is a short bullet list a human
 * can skim in a meeting.
 */
export interface AlignmentDigestSummary {
  /** What this teammate believes to be true (the drift surface). */
  believes: string[];
  /** Concrete knowledge / expertise it carries. */
  knows: string[];
  /** What it's currently working on. */
  working_on: string[];
  /** Hard rules it follows. */
  rules: string[];
}

export interface AlignmentDigest {
  id: string;
  meeting_id: string;
  agent_id: string;
  summary: AlignmentDigestSummary;
  source_block_ids: string[];
  source_fact_ids: string[];
  model: string;
  created_at: Date;
}

export type AlignmentActionKind = "correct_memory" | "note" | "followup";
export type AlignmentActionStatus = "open" | "applied" | "dismissed";

/**
 * How a `correct_memory` action writes back into the specialist's memory.
 * `core_block` edits a named core-memory block (append/replace); `fact`
 * writes an archival fact.
 */
export type AlignmentTargetRef =
  | {
      type: "core_block";
      block_name: string;
      operation: "append" | "replace";
      content: string;
      old_content?: string;
    }
  | {
      type: "fact";
      content: string;
      fact_type?: string;
      /** When set, the correction replaces an existing fact's content. */
      fact_id?: string;
    };

export interface AlignmentActionItem {
  id: string;
  meeting_id: string;
  agent_id: string;
  kind: AlignmentActionKind;
  title: string;
  rationale: string;
  target_ref: AlignmentTargetRef | null;
  status: AlignmentActionStatus;
  applied_session_id: string | null;
  applied_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
