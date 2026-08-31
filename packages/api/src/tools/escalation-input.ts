/**
 * The escalation contribution block — one declaration.
 *
 * An escalation carries two role-tagged slots, and both are filled by a
 * tool that takes the same pair of args: `proposals` (options for the
 * human) and `open_questions`. `escalate_to_humans` in `mesh.ts` files
 * the initiator's slot; `add_to_escalation` in `hierarchy.ts` files the
 * counterparty's. The two tools live in different modules and had each
 * written out the pair twice over — once as JSON Schema for the model,
 * once as a parse in the handler.
 *
 * The schemas were identical bar their `description` prose. The parses
 * were identical in behavior but not in type: `mesh.ts` cast to
 * `CreateEscalationInput["proposals"]` while `hierarchy.ts` cast to a
 * hand-written `Array<{ title: string; description: string; tradeoffs?:
 * string }>`. Both resolve to `Proposal[]`, so the duplication was
 * invisible to the compiler — a field added to `Proposal` would have
 * silently kept working on one side and not the other.
 */

import type { Proposal } from "@beevibe/core";

/**
 * JSON Schema for the two contribution args, sent verbatim to the model.
 *
 * The per-tool prose stays a parameter: the initiator is asked for "your
 * concrete options for the human (2-3 typical)" while the counterparty
 * is told theirs must be "different from initiator's", and that framing
 * is the whole reason the second tool exists.
 */
export function escalationContributionSchema(descriptions: {
  proposals: string;
  openQuestions: string;
}): Record<string, unknown> {
  return {
    proposals: {
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
      description: descriptions.proposals,
    },
    open_questions: {
      type: "array",
      items: { type: "string" },
      description: descriptions.openQuestions,
    },
  };
}

/**
 * Parse the two contribution args off a tool handler's raw input.
 *
 * `undefined` (rather than `[]`) for an arg the model omitted, which is
 * what `EscalationService` distinguishes: an absent `proposals` leaves
 * the slot unset, an empty array records that the agent filed nothing.
 *
 * Proposal objects are passed through uninspected — the same unchecked
 * cast both call sites already performed. Only `open_questions` filters
 * its elements, because a stray non-string there would be rendered
 * straight into the human's review page.
 */
export function parseEscalationContribution(input: Record<string, unknown>): {
  proposals: Proposal[] | undefined;
  openQuestions: string[] | undefined;
} {
  return {
    proposals: Array.isArray(input.proposals)
      ? (input.proposals as Proposal[])
      : undefined,
    openQuestions: Array.isArray(input.open_questions)
      ? (input.open_questions as string[]).filter((q) => typeof q === "string")
      : undefined,
  };
}
