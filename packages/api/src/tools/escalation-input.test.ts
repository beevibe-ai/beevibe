import { describe, expect, it } from "vitest";
import {
  openQuestionsArgSchema,
  proposalsArgSchema,
  readEscalationContribution,
} from "./escalation-input.js";
import { buildHierarchyTools } from "./hierarchy.js";
import { buildTeamMeshTools } from "./mesh.js";

describe("proposalsArgSchema", () => {
  it("mirrors core's Proposal: title + description required, tradeoffs optional", () => {
    expect(proposalsArgSchema("why")).toEqual({
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
      description: "why",
    });
  });
});

describe("openQuestionsArgSchema", () => {
  it("is a plain string array carrying the caller's prose", () => {
    expect(openQuestionsArgSchema("ask away")).toEqual({
      type: "array",
      items: { type: "string" },
      description: "ask away",
    });
  });
});

describe("readEscalationContribution", () => {
  it("passes a well-formed contribution through", () => {
    const proposals = [{ title: "A", description: "do A", tradeoffs: "slow" }];
    expect(
      readEscalationContribution({ proposals, open_questions: ["why?"] }),
    ).toEqual({ proposals, openQuestions: ["why?"] });
  });

  it("reports absent rather than empty when nothing was contributed", () => {
    // The service distinguishes "submitted nothing" from "submitted an
    // empty list" when deciding whether a side has filled its slot.
    expect(readEscalationContribution({})).toEqual({
      proposals: undefined,
      openQuestions: undefined,
    });
  });

  it("treats a non-array value as absent instead of rejecting it", () => {
    expect(
      readEscalationContribution({ proposals: "nope", open_questions: 7 }),
    ).toEqual({ proposals: undefined, openQuestions: undefined });
  });

  it("preserves an explicitly empty array", () => {
    expect(readEscalationContribution({ proposals: [], open_questions: [] })).toEqual({
      proposals: [],
      openQuestions: [],
    });
  });

  it("drops non-strings from open_questions", () => {
    // An object here would render as "[object Object]" on the review page.
    expect(
      readEscalationContribution({ open_questions: ["ok", 1, null, { a: 1 }, "fine"] })
        .openQuestions,
    ).toEqual(["ok", "fine"]);
  });
});

/**
 * The point of the shared factories: both tools write the same two
 * `escalation` columns, so the shape they accept has to agree. Only the
 * agent-facing prose is allowed to differ.
 */
describe("escalate_to_humans and add_to_escalation agree on the shape", () => {
  function argSchema(tool: { schema: Record<string, unknown> }, name: string) {
    const props = tool.schema.properties as Record<string, Record<string, unknown>>;
    return props[name]!;
  }

  // Both builders are pure closures over ctx + services; nothing is
  // called here, only the declared schemas are read.
  const services = {} as never;
  const escalate = buildTeamMeshTools(
    { caller: { agentId: "agt_1" } } as never,
    services,
  ).find((t) => t.name === "escalate_to_humans")!;
  const addTo = buildHierarchyTools(
    { agentId: "agt_1", hierarchyLevel: "team" } as never,
    services,
  ).find((t) => t.name === "add_to_escalation")!;

  it.each(["proposals", "open_questions"])(
    "declares an identical %s shape in both tools",
    (name) => {
      const a = { ...argSchema(escalate, name) };
      const b = { ...argSchema(addTo, name) };
      // Prose is deliberately per-tool — the two are called at different
      // moments — so compare everything else.
      delete a.description;
      delete b.description;
      expect(a).toEqual(b);
      expect(argSchema(escalate, name).description).not.toBe(
        argSchema(addTo, name).description,
      );
    },
  );
});
