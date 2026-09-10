import { describe, expect, it } from "vitest";
import {
  CANCELLABLE_TASK_STATUSES,
  RETRYABLE_TASK_STATUSES,
  TASK_LIFECYCLES,
  TASK_LIFECYCLE_OF_STATUS,
  TASK_STATUSES,
  TASK_STATUSES_BY_LIFECYCLE,
  TERMINAL_TASK_STATUSES,
} from "./task.js";

/**
 * These sets are the shared lifecycle vocabulary the api's `?lifecycle=`
 * filter, its `/cancel` and `/retry` gates, and the web board all read.
 * They are derived from `TASK_LIFECYCLE_OF_STATUS`, so what's worth
 * testing is the derivation — that no status goes missing or lands in two
 * lanes, and that the two gates stay exact complements.
 */
describe("task lifecycle vocabulary", () => {
  it("assigns every TaskStatus to exactly one lane", () => {
    const seen = Object.values(TASK_STATUSES_BY_LIFECYCLE).flat();
    expect([...seen].sort()).toEqual([...TASK_STATUSES].sort());
    expect(new Set(seen).size).toBe(TASK_STATUSES.length);
  });

  it("inverts TASK_LIFECYCLE_OF_STATUS consistently", () => {
    for (const status of TASK_STATUSES) {
      const lane = TASK_LIFECYCLE_OF_STATUS[status];
      expect(TASK_STATUSES_BY_LIFECYCLE[lane], `status=${status}`).toContain(status);
    }
  });

  it("has a bucket for every lane, even an empty one", () => {
    for (const lane of TASK_LIFECYCLES) {
      expect(TASK_STATUSES_BY_LIFECYCLE[lane]).toBeInstanceOf(Array);
    }
  });

  it("keeps blocked out of in_review and failed/cancelled out of done", () => {
    expect(TASK_STATUSES_BY_LIFECYCLE.in_review).toEqual(["review"]);
    expect(TASK_STATUSES_BY_LIFECYCLE.blocked).toEqual(["blocked"]);
    expect(TASK_STATUSES_BY_LIFECYCLE.done).toEqual(["done"]);
    expect(TASK_STATUSES_BY_LIFECYCLE.archived).toEqual(["failed", "cancelled"]);
  });

  it("derives the retry gate as the archived lane", () => {
    expect([...RETRYABLE_TASK_STATUSES]).toEqual(["failed", "cancelled"]);
  });

  it("derives the cancel gate as the exact complement of the terminal set", () => {
    const terminal = new Set<string>(TERMINAL_TASK_STATUSES);
    for (const status of CANCELLABLE_TASK_STATUSES) {
      expect(terminal.has(status), `cancellable=${status}`).toBe(false);
    }
    expect(CANCELLABLE_TASK_STATUSES.length + TERMINAL_TASK_STATUSES.length).toBe(
      TASK_STATUSES.length,
    );
  });

  it("treats every non-terminal status as cancellable", () => {
    const cancellable = new Set<string>(CANCELLABLE_TASK_STATUSES);
    for (const status of TASK_STATUSES) {
      if (TERMINAL_TASK_STATUSES.includes(status)) continue;
      expect(cancellable.has(status), `status=${status}`).toBe(true);
    }
  });
});
