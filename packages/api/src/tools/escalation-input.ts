/**
 * The escalation contribution shape — `proposals` + `open_questions` — in one
 * place, for both tools that accept it.
 *
 * `escalate_to_humans` (mesh.ts) opens an escalation and `add_to_escalation`
 * (hierarchy.ts) fills the peer's slot on an existing one. Different tools,
 * same two fields, and both the JSON Schema and the coercion out of the
 * untyped MCP payload had been written out twice.
 *
 * Worth one definition because it is a wire contract on both sides: the
 * schema is what the CLI shows the agent, and the coercion is what reaches
 * `EscalationService`. The copies had already started to diverge on the type
 * side — mesh derived the element type from `CreateEscalationInput` while
 * hierarchy restated `{ title; description; tradeoffs? }` by hand, so a
 * change to `Proposal` would have been caught in one tool and silently
 * missed in the other. Here it is derived once, from the domain type.
 *
 * The `description` strings stay per-call-site: the two tools really are
 * addressing different agents at different points in the escalation (the
 * initiator proposing options vs. the peer adding theirs), and that prose is
 * the only thing telling them apart in the CLI.
 */

import type { Proposal } from "@beevibe/core/domain";

/**
 * JSON Schema for the `proposals` array. Element shape mirrors `Proposal`;
 * `title` + `description` required, `tradeoffs` optional.
 */
export function escalationProposalsSchema(description: string): Record<string, unknown> {
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

/** JSON Schema for the `open_questions` array of free-text strings. */
export function escalationOpenQuestionsSchema(description: string): Record<string, unknown> {
  return {
    type: "array",
    items: { type: "string" },
    description,
  };
}

/**
 * Coerce the two contribution fields out of an MCP tool payload.
 *
 * Both stay `undefined` when absent or not an array, which is what the
 * service treats as "this party contributed nothing" — distinct from an
 * explicit empty array. `openQuestions` drops non-string elements;
 * `proposals` is passed through on shape alone, as both call sites already
 * did. Tightening that into per-element validation would change what the
 * tools accept, so it is left as-is here rather than smuggled into a
 * refactor — but it now has one place to change.
 */
export function readEscalationContribution(input: Record<string, unknown>): {
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
