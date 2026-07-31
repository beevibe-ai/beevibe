/**
 * Mock-Pool tests for views/activity.ts. Validates row → DTO mapping
 * (short ids, task linkage, duration/started_at derivation) without a
 * database.
 */
import { describe, it, expect } from "vitest";
import { listActivity } from "./activity.js";
import { makeMockPool } from "./test-helpers.js";

const baseRow = {
  id: "sess_abcdef123",
  agent_id: "agt_9911",
  agent_label: "Alice",
  agent_hierarchy: "ic" as const,
  type: "chat" as const,
  status: "running" as const,
  intent: "refactor the auth flow",
  task_id: null,
  task_title: null,
  started_at: new Date("2026-04-30T10:00:00Z"),
  completed_at: null,
};

describe("listActivity", () => {
  it("forwards owner + default limit to the SQL", async () => {
    const pool = makeMockPool([]);
    await listActivity(pool, "per_w");
    expect(pool._spy).toHaveBeenCalledWith(expect.any(String), ["per_w", 20]);
  });

  it("forwards an explicit limit verbatim", async () => {
    const pool = makeMockPool([]);
    await listActivity(pool, "per_w", 5);
    expect(pool._spy).toHaveBeenCalledWith(expect.any(String), ["per_w", 5]);
  });

  it("returns an empty list when the owner has no sessions", async () => {
    const pool = makeMockPool([]);
    await expect(listActivity(pool, "per_w")).resolves.toEqual([]);
  });

  it("maps a task-less session, deriving short_id and leaving task fields null", async () => {
    const pool = makeMockPool([baseRow]);
    const entries = await listActivity(pool, "per_w");
    const entry = entries[0]!;
    expect(entry).toEqual({
      id: "sess_abcdef123",
      short_id: "abcdef",
      agent_id: "agt_9911",
      agent_label: "Alice",
      agent_hierarchy: "ic",
      type: "chat",
      status: "running",
      intent: "refactor the auth flow",
      task_id: null,
      task_title: null,
      task_short_id: null,
      started_at: "2026-04-30T10:00:00.000Z",
      duration_label: expect.any(String),
    });
  });

  it("derives task_short_id from task_id when a task is linked", async () => {
    const pool = makeMockPool([
      {
        ...baseRow,
        type: "task",
        task_id: "tsk_ff00aa9911",
        task_title: "refactor auth flow",
      },
    ]);
    const entries = await listActivity(pool, "per_w");
    const entry = entries[0]!;
    expect(entry.task_id).toBe("tsk_ff00aa9911");
    expect(entry.task_short_id).toBe("ff00aa");
    expect(entry.task_title).toBe("refactor auth flow");
  });

  it("computes duration_label from the started/completed span", async () => {
    const pool = makeMockPool([
      {
        ...baseRow,
        started_at: new Date("2026-04-30T10:00:00Z"),
        completed_at: new Date("2026-04-30T10:05:00Z"),
      },
    ]);
    const entries = await listActivity(pool, "per_w");
    const entry = entries[0]!;
    expect(entry.duration_label).toBe("5m");
  });

  it("falls back to the epoch when started_at is null", async () => {
    const pool = makeMockPool([{ ...baseRow, started_at: null }]);
    const entries = await listActivity(pool, "per_w");
    const entry = entries[0]!;
    expect(entry.started_at).toBe("1970-01-01T00:00:00.000Z");
    // formatDurationLabel has no start to measure from.
    expect(entry.duration_label).toBe("—");
  });

  it("preserves row order across a multi-row result", async () => {
    const pool = makeMockPool([
      { ...baseRow, id: "sess_aaa111" },
      { ...baseRow, id: "sess_bbb222" },
      { ...baseRow, id: "sess_ccc333" },
    ]);
    const entries = await listActivity(pool, "per_w");
    expect(entries.map((e) => e.short_id)).toEqual(["aaa111", "bbb222", "ccc333"]);
  });
});
