/**
 * The `proposals` / `open_questions` pair, in one place.
 *
 * Two tools submit an agent's perspective on an escalation — `escalate`
 * (mesh.ts, opens the row) and `add_to_escalation` (hierarchy.ts, fills the
 * peer's slot) — and both hand the same two fields to `EscalationService`.
 * Each carried its own copy of the JSON Schema fragment and its own
 * `Array.isArray(...) ? cast : undefined` parse, with `add_to_escalation`
 * restating the `Proposal` shape inline as a third declaration of it.
 *
 * The schemas take their `description` from the call site: the wording is
 * genuinely per-tool ("your concrete options" vs "different from
 * initiator's") and agents read it, so only the shape is shared.
 */

import type { Proposal } from "@beevibe/core/domain";

/** JSON Schema for a `proposals` array. `tradeoffs` is the optional third field. */
export function proposalsSchema(description: string): Record<string, unknown> {
  return {
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
    description,
  };
}

/** JSON Schema for an `open_questions` array of plain strings. */
export function openQuestionsSchema(description: string): Record<string, unknown> {
  return {
    type: "array",
    items: { type: "string" },
    description,
  };
}

/**
 * Read `proposals` off a tool input payload, or `undefined` when absent.
 *
 * Deliberately shallow: a non-array is dropped, but the elements are passed
 * through as-is rather than validated field by field. MCP clients validate
 * against the schema above, and `EscalationService` is the authority on what
 * a usable proposal is — tightening it here would reject payloads the
 * service currently accepts.
 */
export function parseProposals(input: Record<string, unknown>): Proposal[] | undefined {
  return Array.isArray(input.proposals) ? (input.proposals as Proposal[]) : undefined;
}

/**
 * Read `open_questions` off a tool input payload, dropping any non-string
 * entries, or `undefined` when absent.
 */
export function parseOpenQuestions(input: Record<string, unknown>): string[] | undefined {
  return Array.isArray(input.open_questions)
    ? (input.open_questions as unknown[]).filter((q): q is string => typeof q === "string")
    : undefined;
}
