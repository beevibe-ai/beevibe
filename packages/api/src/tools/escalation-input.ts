/**
 * The `proposals` + `open_questions` arguments shared by the two tools
 * that write an escalation: `escalate_to_humans` (mesh.ts) creates the
 * row with the initiator's side, `add_to_escalation` (hierarchy.ts) fills
 * the counterparty's slot on the same row.
 *
 * Both halves land in the same two `escalation` columns and are rendered
 * side by side on the human's review page, so their accepted shape has
 * to agree. It was declared twice — once per tool — which meant a field
 * added to one side would be silently dropped by the other, and the
 * reader that narrows the raw input was duplicated with it.
 *
 * What stays per-tool is the `description` prose: the two tools are
 * called at different moments (initiating a hand-off vs. responding to a
 * peer's) and the agent-facing wording reflects that. The factories take
 * it as an argument for exactly that reason.
 */

import type { Proposal } from "@beevibe/core";

/**
 * JSON Schema for the `proposals` argument.
 *
 * `required: ["title", "description"]` with `tradeoffs` optional mirrors
 * core's `Proposal`. The service stores what it is given, so this schema
 * is the only thing stopping a half-filled proposal from reaching the
 * review page.
 */
export function proposalsArgSchema(description: string): Record<string, unknown> {
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

/** JSON Schema for the `open_questions` argument: a plain string array. */
export function openQuestionsArgSchema(description: string): Record<string, unknown> {
  return {
    type: "array",
    items: { type: "string" },
    description,
  };
}

/**
 * Narrow the raw `proposals` / `open_questions` input for the escalation
 * service.
 *
 * Both are optional, and `undefined` means "contributed nothing" rather
 * than "contributed an empty list" — the service distinguishes the two
 * when deciding whether a side has submitted. A non-array value is
 * treated as absent rather than rejected, which is what both call sites
 * already did.
 *
 * The proposals cast is unchecked beyond "is an array", matching the
 * previous behavior at both sites: the JSON Schema is what enforces the
 * per-item shape. `open_questions` does filter out non-strings, since an
 * object in that array would render as `[object Object]` on the review
 * page.
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
