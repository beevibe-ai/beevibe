import { describe, expect, it } from "vitest";
import { TASK_STATUSES, TASK_STATUSES_BY_LIFECYCLE } from "@beevibe/core";
import { TASK_STATUSES_BY_VIEW } from "./tasks-grouping.js";

/**
 * `sprint` and `timeline` are composed out of the lifecycle lanes, so a
 * change to the lane split silently changes which rows these saved views
 * return. These assertions pin the membership independently of how the
 * lanes are carved up.
 */

describe("TASK_STATUSES_BY_VIEW", () => {
  it("keeps sprint at every in-flight status", () => {
    expect([...TASK_STATUSES_BY_VIEW.sprint!].sort()).toEqual(
      [
        "assigned",
        "blocked",
        "in_progress",
        "needs_revision",
        "pending",
        "review",
        "revision",
      ].sort(),
    );
  });

  it("excludes the settled statuses from sprint", () => {
    for (const s of ["done", "failed", "cancelled"] as const) {
      expect(TASK_STATUSES_BY_VIEW.sprint).not.toContain(s);
    }
  });

  it("keeps timeline at every status there is", () => {
    expect([...TASK_STATUSES_BY_VIEW.timeline!].sort()).toEqual([...TASK_STATUSES].sort());
  });

  it("lists sprint as a strict subset of timeline", () => {
    for (const s of TASK_STATUSES_BY_VIEW.sprint!) {
      expect(TASK_STATUSES_BY_VIEW.timeline).toContain(s);
    }
    expect(TASK_STATUSES_BY_VIEW.timeline!.length).toBeGreaterThan(
      TASK_STATUSES_BY_VIEW.sprint!.length,
    );
  });

  it("repeats no status within a view", () => {
    for (const view of ["sprint", "timeline"] as const) {
      const statuses = TASK_STATUSES_BY_VIEW[view]!;
      expect(new Set(statuses).size).toBe(statuses.length);
    }
  });

  it("leaves 'all' and 'mine' unmapped — they are not status filters", () => {
    expect(TASK_STATUSES_BY_VIEW.all).toBeUndefined();
    expect(TASK_STATUSES_BY_VIEW.mine).toBeUndefined();
  });

  it("covers timeline with exactly the union of every lane", () => {
    const everyLane = Object.values(TASK_STATUSES_BY_LIFECYCLE).flatMap((s) => [...s]);
    expect([...TASK_STATUSES_BY_VIEW.timeline!].sort()).toEqual(everyLane.sort());
  });
});
