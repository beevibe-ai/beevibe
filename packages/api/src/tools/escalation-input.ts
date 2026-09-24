/**
 * The `proposals` / `open_questions` input contract shared by the two MCP
 * tools that write an escalation slot:
 *
 *   - `escalate_to_humans` (tools/mesh.ts) — the initiator's slot.
 *   - `add_to_escalation` (tools/hierarchy.ts) — the counterparty's slot.
 *
 * Both carried a byte-identical copy of the nested JSON Schema and of the
 * `Array.isArray(...) ? cast : undefined` coercion. The two slots are read
 * back side by side on the escalation review page, so a schema that drifted
 * on one side would show up as one party's proposals rendering and the
 * other's silently dropping a field — not as an error. The wording of each
 * `description` stays at the call site: it is tool-specific prompt copy, and
 * that is the only part that legitimately differs.
 */

import type { Proposal } from "@beevibe/core";

/**
 * JSON Schema for a proposals array. Callers supply their own
 * `description` — spread this and add it:
 *
 * ```ts
 * proposals: { ...PROPOSALS_SCHEMA, description: "Your options for the human." }
 * ```
 */
export const PROPOSALS_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      title: { type: "string" },
      description: { type: "string" },
      tradeoffs: { type: "string" },
    },
    required: ["title", "description"],
  },
} as const;

/** JSON Schema for an open-questions array. Same `description` convention. */
export const OPEN_QUESTIONS_SCHEMA = {
  type: "array",
  items: { type: "string" },
} as const;

/**
 * Narrow a tool input's `proposals` field to `Proposal[]`, or `undefined`
 * when the model omitted it (or sent a non-array).
 *
 * The cast is unchecked by design: `EscalationService` persists proposals as
 * jsonb and the review page renders whatever fields are present, so a
 * malformed entry degrades to a sparse card rather than a failed escalation.
 * Rejecting here would lose the rest of a party's contribution.
 */
export function coerceProposals(value: unknown): Proposal[] | undefined {
  return Array.isArray(value) ? (value as Proposal[]) : undefined;
}

/**
 * Narrow a tool input's `open_questions` field to `string[]`, dropping
 * non-string entries. Unlike proposals these are rendered as bare list
 * items, so a non-string would stringify to "[object Object]" on the page.
 */
export function coerceOpenQuestions(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? (value as unknown[]).filter((q): q is string => typeof q === "string")
    : undefined;
}
