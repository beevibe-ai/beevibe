import { describe, expect, it } from "vitest";
import {
  escalationOpenQuestionsSchema,
  escalationProposalsSchema,
  readEscalationContribution,
} from "./escalation-input.js";

describe("escalationProposalsSchema", () => {
  it("describes an array of title/description/tradeoffs objects", () => {
    expect(escalationProposalsSchema("pick one")).toEqual({
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
      description: "pick one",
    });
  });

  // The two tools address the agent at different points in the escalation,
  // so the prose is the only thing distinguishing them in the CLI.
  it("carries the caller's description through", () => {
    expect(escalationProposalsSchema("peer's turn")).toMatchObject({
      description: "peer's turn",
    });
  });
});

describe("escalationOpenQuestionsSchema", () => {
  it("describes an array of free-text strings", () => {
    expect(escalationOpenQuestionsSchema("what don't you know")).toEqual({
      type: "array",
      items: { type: "string" },
      description: "what don't you know",
    });
  });
});

describe("readEscalationContribution", () => {
  it("reads both fields off the payload", () => {
    const got = readEscalationContribution({
      proposals: [{ title: "A", description: "do A", tradeoffs: "slower" }],
      open_questions: ["is A funded?"],
    });
    expect(got).toEqual({
      proposals: [{ title: "A", description: "do A", tradeoffs: "slower" }],
      openQuestions: ["is A funded?"],
    });
  });

  // `undefined` is "this party contributed nothing", which the service
  // treats differently from an explicit empty array — so an absent field
  // must not coerce to [].
  it("leaves an absent field undefined rather than empty", () => {
    expect(readEscalationContribution({})).toEqual({
      proposals: undefined,
      openQuestions: undefined,
    });
  });

  it("rejects a non-array on either field", () => {
    expect(
      readEscalationContribution({ proposals: "not an array", open_questions: 7 }),
    ).toEqual({ proposals: undefined, openQuestions: undefined });
  });

  it("preserves an explicit empty array", () => {
    expect(readEscalationContribution({ proposals: [], open_questions: [] })).toEqual({
      proposals: [],
      openQuestions: [],
    });
  });

  it("drops non-string open questions", () => {
    const got = readEscalationContribution({ open_questions: ["real", 42, null, "also real"] });
    expect(got.openQuestions).toEqual(["real", "also real"]);
  });

  // Documents existing behaviour rather than endorsing it: proposals are
  // accepted on array-shape alone, with no per-element validation. Both call
  // sites already did this; the point of one definition is that tightening
  // it is now a single change.
  it("passes proposals through without per-element validation", () => {
    const got = readEscalationContribution({ proposals: [{ nonsense: true }] });
    expect(got.proposals).toEqual([{ nonsense: true }]);
  });
});
