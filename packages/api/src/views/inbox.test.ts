/**
 * Mock-Pool tests for views/inbox.ts. The composer's a single
 * UNION ALL query, so the unit-level surface is small: param
 * forwarding, limit clamp, and row → DTO mapping. The SQL itself
 * (filter predicates, joins) is contract-tested separately by the
 * route integration tests once those land.
 */
import { describe, it, expect } from "vitest";
import { listInbox } from "./inbox.js";
import { makeMockPool } from "./test-helpers.js";

const reviewRow = {
  id: "task_review:task_a",
  kind: "task_review" as const,
  title: "Draft the launch playbook",
  detail: "launch comms specialist",
  href: "/tasks/task_a",
  age_at: new Date("2026-05-04T10:00:00Z"),
};

const blockedRow = {
  id: "task_blocked:task_b",
  kind: "task_blocked" as const,
  title: "Wire the dashboard split",
  detail: "Need session_event schema decision before binding.",
  href: "/tasks/task_b",
  age_at: new Date("2026-05-03T22:00:00Z"),
};

const escalationRow = {
  id: "escalation_pending:esc_x",
  kind: "escalation_pending" as const,
  title: "Empty-state copy direction",
  detail: "ux specialist ↔ frontend specialist",
  href: "/mesh#esc-esc_x",
  age_at: new Date("2026-05-04T08:00:00Z"),
};

describe("listInbox", () => {
  it("forwards person id + clamped limit to the SQL", async () => {
    const pool = makeMockPool([]);
    await listInbox(pool, "per_w", { limit: 25 });
    expect(pool._spy).toHaveBeenCalledWith(expect.any(String), ["per_w", 25]);
  });

  it("clamps limit to [1, 200] and defaults to 50", async () => {
    const pool = makeMockPool([]);
    await listInbox(pool, "per_w");
    expect(pool._spy).toHaveBeenLastCalledWith(expect.any(String), ["per_w", 50]);
    await listInbox(pool, "per_w", { limit: 9999 });
    expect(pool._spy).toHaveBeenLastCalledWith(expect.any(String), ["per_w", 200]);
    await listInbox(pool, "per_w", { limit: 0 });
    expect(pool._spy).toHaveBeenLastCalledWith(expect.any(String), ["per_w", 1]);
  });

  it("maps each row 1:1 to InboxItem preserving every field", async () => {
    const pool = makeMockPool([reviewRow]);
    const items = await listInbox(pool, "per_w");
    expect(items).toEqual([
      {
        id: "task_review:task_a",
        kind: "task_review",
        title: "Draft the launch playbook",
        detail: "launch comms specialist",
        href: "/tasks/task_a",
        age_at: new Date("2026-05-04T10:00:00Z"),
      },
    ]);
  });

  it("returns all three kinds in the order the SQL returned them", async () => {
    const pool = makeMockPool([reviewRow, escalationRow, blockedRow]);
    const items = await listInbox(pool, "per_w");
    expect(items.map((i) => i.kind)).toEqual([
      "task_review",
      "escalation_pending",
      "task_blocked",
    ]);
  });

  it("returns empty array when no rows match", async () => {
    const pool = makeMockPool([]);
    const items = await listInbox(pool, "per_w");
    expect(items).toEqual([]);
  });

  it("includes /tasks/ paths for task kinds and /mesh#esc- for escalations", async () => {
    const pool = makeMockPool([reviewRow, blockedRow, escalationRow]);
    const items = await listInbox(pool, "per_w");
    expect(items[0]?.href).toBe("/tasks/task_a");
    expect(items[1]?.href).toBe("/tasks/task_b");
    expect(items[2]?.href).toMatch(/^\/mesh#esc-/);
  });
});
