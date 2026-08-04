/**
 * Mock-Pool tests for views/activity.ts. One query, so the unit-level
 * surface is param forwarding plus the row → DTO mapping — in
 * particular the three derived fields (`short_id`, `task_short_id`,
 * `duration_label`) and the `started_at` epoch fallback that keeps the
 * wire type non-nullable for a session that never started.
 */
import { describe, it, expect } from "vitest";
import { listActivity } from "./activity.js";
import { makeMockPool } from "./test-helpers.js";

const baseRow = {
  id: "sess_abcdef123",
  agent_id: "agt_alpha99",
  agent_label: "Launch comms",
  agent_hierarchy: "ic" as const,
  type: "task" as const,
  status: "running" as const,
  intent: "Draft the launch playbook",
  task_id: "task_zzz777",
  task_title: "Launch playbook",
  started_at: new Date("2026-05-04T10:00:00Z"),
  completed_at: new Date("2026-05-04T10:03:30Z"),
};

describe("listActivity", () => {
  it("forwards owner id + limit to the SQL", async () => {
    const pool = makeMockPool([]);
    await listActivity(pool, "per_w", 5);
    expect(pool._spy).toHaveBeenCalledWith(expect.any(String), ["per_w", 5]);
  });

  it("defaults the limit to 20", async () => {
    const pool = makeMockPool([]);
    await listActivity(pool, "per_w");
    expect(pool._spy).toHaveBeenCalledWith(expect.any(String), ["per_w", 20]);
  });

  it("maps a row to ActivityEntry with derived short ids and duration", async () => {
    const pool = makeMockPool([baseRow]);
    const [entry] = await listActivity(pool, "per_w");
    expect(entry).toEqual({
      id: "sess_abcdef123",
      short_id: "abcdef",
      agent_id: "agt_alpha99",
      agent_label: "Launch comms",
      agent_hierarchy: "ic",
      type: "task",
      status: "running",
      intent: "Draft the launch playbook",
      task_id: "task_zzz777",
      task_title: "Launch playbook",
      task_short_id: "zzz777",
      started_at: "2026-05-04T10:00:00.000Z",
      duration_label: "3m",
    });
  });

  it("leaves task_short_id null for a session with no linked task", async () => {
    const pool = makeMockPool([
      { ...baseRow, task_id: null, task_title: null },
    ]);
    const [entry] = await listActivity(pool, "per_w");
    expect(entry?.task_id).toBeNull();
    expect(entry?.task_title).toBeNull();
    expect(entry?.task_short_id).toBeNull();
  });

  it("falls back to the epoch when started_at is null", async () => {
    const pool = makeMockPool([{ ...baseRow, started_at: null }]);
    const [entry] = await listActivity(pool, "per_w");
    expect(entry?.started_at).toBe("1970-01-01T00:00:00.000Z");
    // formatDurationLabel returns the em dash for a null start.
    expect(entry?.duration_label).toBe("—");
  });

  it("measures an in-flight session against now when completed_at is null", async () => {
    const pool = makeMockPool([
      {
        ...baseRow,
        started_at: new Date(Date.now() - 90_000),
        completed_at: null,
      },
    ]);
    const [entry] = await listActivity(pool, "per_w");
    expect(entry?.duration_label).toBe("1m");
  });

  it("returns an empty array when the owner has no sessions", async () => {
    const pool = makeMockPool([]);
    expect(await listActivity(pool, "per_w")).toEqual([]);
  });
});
