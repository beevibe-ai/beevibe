import { describe, expect, it } from "vitest";
import {
  openQuestionsSchema,
  parseOpenQuestions,
  parseProposals,
  proposalsSchema,
} from "./escalation-input.js";

describe("proposalsSchema", () => {
  it("describes an array of title/description objects with optional tradeoffs", () => {
    expect(proposalsSchema("pick one")).toEqual({
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

  it("carries the call site's wording — agents read it", () => {
    expect(proposalsSchema("initiator's options").description).toBe("initiator's options");
    expect(proposalsSchema("peer's options").description).toBe("peer's options");
  });

  it("returns a fresh object per call, so one tool can't mutate another's schema", () => {
    const a = proposalsSchema("a");
    const b = proposalsSchema("b");
    expect(a).not.toBe(b);
    expect(a.items).not.toBe(b.items);
  });
});

describe("openQuestionsSchema", () => {
  it("describes a plain string array", () => {
    expect(openQuestionsSchema("what we don't know")).toEqual({
      type: "array",
      items: { type: "string" },
      description: "what we don't know",
    });
  });
});

describe("parseProposals", () => {
  it("passes an array through untouched", () => {
    const proposals = [{ title: "A", description: "do A", tradeoffs: "slow" }];
    expect(parseProposals({ proposals })).toEqual(proposals);
  });

  it("keeps an entry with no tradeoffs — the field is optional", () => {
    expect(parseProposals({ proposals: [{ title: "A", description: "do A" }] })).toEqual([
      { title: "A", description: "do A" },
    ]);
  });

  it("returns undefined when the field is absent", () => {
    expect(parseProposals({})).toBeUndefined();
  });

  it("returns undefined for a non-array, rather than wrapping it", () => {
    expect(parseProposals({ proposals: "A" })).toBeUndefined();
    expect(parseProposals({ proposals: { title: "A" } })).toBeUndefined();
    expect(parseProposals({ proposals: null })).toBeUndefined();
  });

  it("preserves an empty array — distinct from 'not submitted'", () => {
    expect(parseProposals({ proposals: [] })).toEqual([]);
  });
});

describe("parseOpenQuestions", () => {
  it("passes a string array through", () => {
    expect(parseOpenQuestions({ open_questions: ["why?", "when?"] })).toEqual([
      "why?",
      "when?",
    ]);
  });

  it("drops non-string entries", () => {
    expect(
      parseOpenQuestions({ open_questions: ["why?", 42, null, { q: "x" }, "when?"] }),
    ).toEqual(["why?", "when?"]);
  });

  it("returns undefined when the field is absent", () => {
    expect(parseOpenQuestions({})).toBeUndefined();
  });

  it("returns undefined for a non-array", () => {
    expect(parseOpenQuestions({ open_questions: "why?" })).toBeUndefined();
  });

  it("returns an empty array when every entry was dropped", () => {
    expect(parseOpenQuestions({ open_questions: [1, 2] })).toEqual([]);
  });
});
