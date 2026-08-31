import { describe, expect, it } from "vitest";
import {
  escalationContributionSchema,
  parseEscalationContribution,
} from "./escalation-input.js";

describe("escalationContributionSchema", () => {
  it("declares both args with the caller's prose", () => {
    const schema = escalationContributionSchema({
      proposals: "Your options.",
      openQuestions: "What you'd like to know.",
    });
    expect(Object.keys(schema)).toEqual(["proposals", "open_questions"]);
    expect(schema.proposals).toMatchObject({ description: "Your options." });
    expect(schema.open_questions).toMatchObject({
      type: "array",
      items: { type: "string" },
      description: "What you'd like to know.",
    });
  });

  it("requires title and description on a proposal but not tradeoffs", () => {
    // This is the model-facing contract for both escalation tools; it
    // was written out twice before and is the thing that could drift.
    const schema = escalationContributionSchema({ proposals: "a", openQuestions: "b" });
    expect(schema.proposals).toMatchObject({
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
    });
  });

  it("varies nothing but the prose between the two callers", () => {
    const initiator = escalationContributionSchema({ proposals: "A", openQuestions: "B" });
    const counterparty = escalationContributionSchema({ proposals: "C", openQuestions: "D" });
    const strip = (s: Record<string, unknown>) =>
      JSON.parse(JSON.stringify(s), (k, v) => (k === "description" ? undefined : v));
    expect(strip(initiator)).toEqual(strip(counterparty));
  });
});

describe("parseEscalationContribution", () => {
  it("reads both arrays off the raw input", () => {
    expect(
      parseEscalationContribution({
        proposals: [{ title: "Ship it", description: "now" }],
        open_questions: ["what is the deadline?"],
      }),
    ).toEqual({
      proposals: [{ title: "Ship it", description: "now" }],
      openQuestions: ["what is the deadline?"],
    });
  });

  it("leaves an omitted arg undefined rather than defaulting it to []", () => {
    // EscalationService distinguishes the two: absent leaves the slot
    // unset, [] records that the agent filed nothing.
    expect(parseEscalationContribution({})).toEqual({
      proposals: undefined,
      openQuestions: undefined,
    });
    expect(parseEscalationContribution({ proposals: [], open_questions: [] })).toEqual({
      proposals: [],
      openQuestions: [],
    });
  });

  it("filters non-strings out of open_questions", () => {
    expect(
      parseEscalationContribution({ open_questions: ["a", 3, null, "b"] }).openQuestions,
    ).toEqual(["a", "b"]);
  });

  it("passes proposal objects through uninspected", () => {
    // Matches what both call sites did — an unchecked cast. Pinned so a
    // future tightening is a deliberate change, not a silent one.
    const junk = [{ nope: true }];
    expect(parseEscalationContribution({ proposals: junk }).proposals).toEqual(junk);
  });

  it("treats a non-array as absent", () => {
    expect(
      parseEscalationContribution({ proposals: "one", open_questions: {} }),
    ).toEqual({ proposals: undefined, openQuestions: undefined });
  });
});
