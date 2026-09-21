import { describe, expect, it } from "vitest";
import {
  AGENT_BASE_COLUMNS,
  AGENT_HIERARCHY_ORDER,
  AGENT_STAT_COLUMNS,
  AGENT_STAT_JOINS,
  toAgentDisplay,
  type AgentDisplayRow,
} from "./agent-display.js";

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

/**
 * The point of the SQL fragments is that `AgentDisplayRow` describes
 * exactly what they select. Nothing in the type system enforces that —
 * the fragments are strings — so these assert the pairing directly:
 * add a column to the SQL without adding the field (or vice versa) and
 * the first test fails.
 */
describe("agent-display SQL fragments", () => {
  /**
   * Output names of a select list: `x AS y` → y, `a.z` → z. Splits on
   * top-level commas only — `COALESCE(sc.n, 0)::int AS sessions_count`
   * is one item, not two.
   */
  function selectedNames(fragment: string): string[] {
    const items: string[] = [];
    let depth = 0;
    let current = "";
    for (const ch of fragment) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === "," && depth === 0) {
        items.push(current);
        current = "";
        continue;
      }
      current += ch;
    }
    items.push(current);

    return items
      .map((item) => item.trim().replace(/\s+/g, " "))
      .filter((item) => item.length > 0)
      .map((item) => {
        const aliased = / AS (\w+)$/i.exec(item);
        if (aliased) return aliased[1]!;
        const parts = item.split(".");
        return parts[parts.length - 1]!;
      });
  }

  it("selects exactly the columns AgentDisplayRow declares", () => {
    const selected = [
      ...selectedNames(AGENT_BASE_COLUMNS),
      ...selectedNames(AGENT_STAT_COLUMNS),
    ];
    // Keys of AgentDisplayRow, via a value the compiler checks for us —
    // so a field added to the interface must be added here too.
    const declared = Object.keys(row());
    expect([...selected].sort()).toEqual([...declared].sort());
  });

  it("joins every alias the stat columns reference", () => {
    for (const alias of ["sc", "fc", "tl"]) {
      expect(AGENT_STAT_COLUMNS).toContain(`${alias}.`);
      expect(AGENT_STAT_JOINS).toMatch(new RegExp(`\\b${alias}\\b`));
    }
  });

  it("ranks org above team above ic, then sorts by name", () => {
    // TEXT ordering would read 'team' > 'org' > 'ic'; the CASE pins the
    // intended rank. Guards the numbers, which the UI's orbit layout
    // depends on (team agent at the centre of each orbit).
    expect(AGENT_HIERARCHY_ORDER.replace(/\s+/g, " ")).toBe(
      "CASE a.hierarchy_level WHEN 'org' THEN 0 WHEN 'team' THEN 1 ELSE 2 END, a.name ASC",
    );
  });
});
