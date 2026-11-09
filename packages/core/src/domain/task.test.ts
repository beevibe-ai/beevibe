import { describe, expect, it } from "vitest";
import {
  TASK_LIFECYCLE_OF,
  TASK_LIFECYCLES,
  TASK_STATUSES,
  TASK_STATUSES_BY_LIFECYCLE,
  taskStatusesForLifecycles,
  type TaskLifecycle,
  type TaskStatus,
} from "./task.js";

/**
 * The lifecycle table is a wire contract: the web board draws one column
 * per lane and the api's `GET /task?lifecycle=` filters by the same
 * names. These tests pin the mapping itself (changing a lane moves rows
 * under users) and the invariants that keep the derived views honest.
 */
describe("task lifecycle mapping", () => {
  const EXPECTED: Record<TaskStatus, TaskLifecycle> = {
    pending: "pending",
    assigned: "pending",
    in_progress: "in_progress",
    revision: "in_progress",
    needs_revision: "in_progress",
    review: "in_review",
    blocked: "blocked",
    done: "done",
    failed: "archived",
    cancelled: "archived",
  };

  it("assigns every status its documented lane", () => {
    expect(TASK_LIFECYCLE_OF).toEqual(EXPECTED);
  });

  it("covers every status in TASK_STATUSES", () => {
    for (const status of TASK_STATUSES) {
      expect(TASK_LIFECYCLE_OF[status]).toBeDefined();
    }
    expect(Object.keys(TASK_LIFECYCLE_OF).sort()).toEqual([...TASK_STATUSES].sort());
  });

  it("lists the lanes in workflow order, archived last", () => {
    expect(TASK_LIFECYCLES).toEqual([
      "pending",
      "in_progress",
      "blocked",
      "in_review",
      "done",
      "archived",
    ]);
  });

  it("keeps blocked out of in_review and failed/cancelled out of done", () => {
    // The api used to fold these together while the board kept them
    // apart, so a filter named after a lane returned rows the lane does
    // not hold. Guard against that fold coming back.
    expect(TASK_STATUSES_BY_LIFECYCLE.in_review).toEqual(["review"]);
    expect(TASK_STATUSES_BY_LIFECYCLE.blocked).toEqual(["blocked"]);
    expect(TASK_STATUSES_BY_LIFECYCLE.done).toEqual(["done"]);
    expect(TASK_STATUSES_BY_LIFECYCLE.archived).toEqual(["failed", "cancelled"]);
  });

  it("partitions TASK_STATUSES exactly once across the lanes", () => {
    const flat = TASK_LIFECYCLES.flatMap((lane) => [
      ...TASK_STATUSES_BY_LIFECYCLE[lane],
    ]);
    expect(flat.sort()).toEqual([...TASK_STATUSES].sort());
  });

  it("inverts TASK_LIFECYCLE_OF consistently", () => {
    for (const lane of TASK_LIFECYCLES) {
      for (const status of TASK_STATUSES_BY_LIFECYCLE[lane]) {
        expect(TASK_LIFECYCLE_OF[status]).toBe(lane);
      }
    }
  });
});

describe("taskStatusesForLifecycles", () => {
  it("unions the requested lanes in TASK_STATUSES order", () => {
    expect(taskStatusesForLifecycles(["in_review", "pending"])).toEqual([
      "pending",
      "assigned",
      "review",
    ]);
  });

  it("returns every status for every lane", () => {
    expect([...taskStatusesForLifecycles(TASK_LIFECYCLES)]).toEqual([
      ...TASK_STATUSES,
    ]);
  });

  it("returns nothing for no lanes", () => {
    expect(taskStatusesForLifecycles([])).toEqual([]);
  });

  it("de-duplicates a repeated lane", () => {
    expect(taskStatusesForLifecycles(["blocked", "blocked"])).toEqual(["blocked"]);
  });
});
