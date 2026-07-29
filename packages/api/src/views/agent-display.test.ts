import { describe, expect, it } from "vitest";
import { toAgentDisplay, type AgentDisplayRow } from "./agent-display.js";

const NOW = new Date("2026-01-01T00:00:00Z");

function row(overrides: Partial<AgentDisplayRow> = {}): AgentDisplayRow {
  return {
    id: "agent_1",
    name: "Atlas",
    owner_id: "person_1",
    parent_agent_id: null,
    hierarchy_level: "ic",
    review_policy: null,
    runtime_config: { type: "claude", model: "opus" },
    preferred_runtime_id: null,
    created_at: NOW,
    updated_at: NOW,
    sessions_count: 3,
    facts_learned: 7,
    tag_line: null,
    ...overrides,
  };
}

describe("toAgentDisplay", () => {
  it("splits runtime (CLI tool) from model (LLM alias)", () => {
    const d = toAgentDisplay(row());
    expect(d.runtime).toBe("claude");
    expect(d.model).toBe("opus");
  });

  it("defaults runtime to claude for agents predating the runtime/model split", () => {
    expect(toAgentDisplay(row({ runtime_config: {} })).runtime).toBe("claude");
    expect(toAgentDisplay(row({ runtime_config: null })).runtime).toBe("claude");
  });

  it("leaves model undefined when the agent uses the CLI's own default", () => {
    expect(toAgentDisplay(row({ runtime_config: { type: "codex" } })).model).toBeUndefined();
  });

  it("coerces counts whether the driver returns int or text", () => {
    // The network view's SQL casts to ::int; the list view's COUNT(*)
    // comes back as a string. Both must land as numbers.
    expect(toAgentDisplay(row({ sessions_count: "12", facts_learned: "4" }))).toMatchObject({
      sessions_count: 12,
      facts_learned: 4,
    });
    expect(toAgentDisplay(row({ sessions_count: 12, facts_learned: 4 }))).toMatchObject({
      sessions_count: 12,
      facts_learned: 4,
    });
  });

  it("derives specialization from the first non-empty tag_line line", () => {
    expect(toAgentDisplay(row({ tag_line: "\n\n  Ships infra  \nmore prose" })).specialization).toBe(
      "Ships infra",
    );
    expect(toAgentDisplay(row({ tag_line: "   \n  " })).specialization).toBeUndefined();
    expect(toAgentDisplay(row({ tag_line: null })).specialization).toBeUndefined();
  });

  it("normalizes nullable columns to undefined so they drop out of JSON", () => {
    const d = toAgentDisplay(row());
    expect(d.parent_agent_id).toBeUndefined();
    expect(d.review_policy).toBeUndefined();
    expect(d.preferred_runtime_id).toBeUndefined();
  });

  it("mirrors name into display_name and hierarchy_level into hierarchy", () => {
    const d = toAgentDisplay(row({ name: "Atlas", hierarchy_level: "team" }));
    expect(d.display_name).toBe("Atlas");
    expect(d.hierarchy).toBe("team");
  });

  it("emits neither owner_label nor archived_at — those are per-view additions", () => {
    const d = toAgentDisplay(row());
    expect(d.owner_label).toBeUndefined();
    expect(d.archived_at).toBeUndefined();
  });
});
