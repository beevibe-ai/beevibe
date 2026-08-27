import { describe, expect, it } from "vitest";
import { TASK_STATUSES } from "./task.js";
import {
  TASK_LIFECYCLES,
  TASK_LIFECYCLE_OF,
  TASK_STATUSES_BY_LIFECYCLE,
  TASK_STATUSES_BY_VIEW,
  isTaskLifecycle,
} from "./task-lifecycle.js";

describe("task lifecycle lanes", () => {
  it("puts every status in exactly one lane", () => {
    const seen = TASK_LIFECYCLES.flatMap((lane) => TASK_STATUSES_BY_LIFECYCLE[lane]);
    expect([...seen].sort()).toEqual([...TASK_STATUSES].sort());
    expect(seen.length).toBe(TASK_STATUSES.length);
  });

  it("keeps the lane→statuses map the exact inverse of status→lane", () => {
    for (const status of TASK_STATUSES) {
      expect(TASK_STATUSES_BY_LIFECYCLE[TASK_LIFECYCLE_OF[status]]).toContain(status);
    }
  });

  it("orders lanes by workflow position", () => {
    expect([...TASK_LIFECYCLES]).toEqual([
      "pending",
      "in_progress",
      "blocked",
      "in_review",
      "done",
      "archived",
    ]);
  });

  it("narrows only known lane names", () => {
    expect(isTaskLifecycle("blocked")).toBe(true);
    expect(isTaskLifecycle("nonsense")).toBe(false);
    expect(isTaskLifecycle("")).toBe(false);
  });

  /**
   * These two saved views predate the lane split and are composed from
   * lanes now. Pinning their status sets keeps that composition from
   * changing what `GET /task?view=` returns.
   */
  it("keeps the sprint and timeline views' status sets", () => {
    expect([...(TASK_STATUSES_BY_VIEW.sprint ?? [])].sort()).toEqual(
      ["pending", "assigned", "in_progress", "needs_revision", "revision", "review", "blocked"].sort(),
    );
    expect([...(TASK_STATUSES_BY_VIEW.timeline ?? [])].sort()).toEqual(
      [
        "pending",
        "assigned",
        "in_progress",
        "needs_revision",
        "revision",
        "review",
        "blocked",
        "done",
      ].sort(),
    );
  });
});
