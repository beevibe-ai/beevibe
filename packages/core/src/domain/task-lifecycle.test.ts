import { describe, expect, it } from "vitest";
import { TASK_STATUSES, type TaskStatus } from "./task.js";
import {
  TASK_LIFECYCLE_OF,
  TASK_STATUSES_BY_VIEW,
  TASK_STATUSES_BY_WIRE_LIFECYCLE,
  WIRE_LIFECYCLE_LANES,
  type TaskLifecycle,
  type TaskWireLifecycle,
} from "./task-lifecycle.js";

const WIRE_LIFECYCLES: readonly TaskWireLifecycle[] = [
  "pending",
  "in_progress",
  "in_review",
  "done",
];

describe("TASK_LIFECYCLE_OF", () => {
  it("assigns a lane to every task status", () => {
    for (const status of TASK_STATUSES) {
      expect(TASK_LIFECYCLE_OF[status]).toBeDefined();
    }
    expect(Object.keys(TASK_LIFECYCLE_OF).sort()).toEqual([...TASK_STATUSES].sort());
  });

  it("keeps blocked and archived out of the lanes they used to be folded into", () => {
    expect(TASK_LIFECYCLE_OF.blocked).toBe("blocked");
    expect(TASK_LIFECYCLE_OF.failed).toBe("archived");
    expect(TASK_LIFECYCLE_OF.cancelled).toBe("archived");
  });
});

describe("TASK_STATUSES_BY_WIRE_LIFECYCLE", () => {
  // These four arrays are the api's wire contract: they were hand-written
  // before being derived, so pin them rather than recompute them.
  it("matches the status sets the task-list filter has always sent", () => {
    expect(TASK_STATUSES_BY_WIRE_LIFECYCLE).toEqual({
      pending: ["pending", "assigned"],
      in_progress: ["in_progress", "revision", "needs_revision"],
      in_review: ["review", "blocked"],
      done: ["done", "failed", "cancelled"],
    });
  });

  it("partitions the statuses — every one in exactly one wire bucket", () => {
    const seen = new Map<TaskStatus, number>();
    for (const lifecycle of WIRE_LIFECYCLES) {
      for (const status of TASK_STATUSES_BY_WIRE_LIFECYCLE[lifecycle]) {
        seen.set(status, (seen.get(status) ?? 0) + 1);
      }
    }
    expect([...seen.keys()].sort()).toEqual([...TASK_STATUSES].sort());
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
  });

  it("covers every board lane across the wire buckets", () => {
    const lanes = new Set<TaskLifecycle>(
      WIRE_LIFECYCLES.flatMap((l) => [...WIRE_LIFECYCLE_LANES[l]]),
    );
    expect([...lanes].sort()).toEqual([...new Set(Object.values(TASK_LIFECYCLE_OF))].sort());
  });
});

describe("TASK_STATUSES_BY_VIEW", () => {
  it("sprint is everything but the terminal statuses", () => {
    expect(TASK_STATUSES_BY_VIEW.sprint).toEqual([
      "pending",
      "assigned",
      "in_progress",
      "revision",
      "needs_revision",
      "review",
      "blocked",
    ]);
  });

  it("timeline is every status", () => {
    expect([...(TASK_STATUSES_BY_VIEW.timeline ?? [])].sort()).toEqual([...TASK_STATUSES].sort());
  });

  it("has no entry for the views that aren't status filters", () => {
    expect(TASK_STATUSES_BY_VIEW.all).toBeUndefined();
    expect(TASK_STATUSES_BY_VIEW.mine).toBeUndefined();
  });
});
