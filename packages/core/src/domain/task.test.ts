import { describe, expect, it } from "vitest";
import {
  CANCELLABLE_TASK_STATUSES,
  RETRYABLE_TASK_STATUSES,
  TASK_LIFECYCLES,
  TASK_LIFECYCLE_OF,
  TASK_STATUSES,
  TASK_STATUSES_BY_LIFECYCLE,
  TERMINAL_TASK_STATUSES,
  isRetryableTaskStatus,
  isTerminalTaskStatus,
  taskLifecycleOf,
  type TaskLifecycle,
  type TaskStatus,
} from "./task.js";

/**
 * These constants are the shared task taxonomy: the web board groups on
 * them, `GET /task?lifecycle=` filters SQL on them, and the cancel route
 * gates transitions on them. The invariants below are what previously
 * drifted when each consumer carried its own copy.
 */

describe("task status sets", () => {
  it("splits every status into exactly one of cancellable or terminal", () => {
    const partitioned = [...CANCELLABLE_TASK_STATUSES, ...TERMINAL_TASK_STATUSES].sort();
    expect(partitioned).toEqual([...TASK_STATUSES].sort());
  });

  it("keeps cancellable and terminal disjoint", () => {
    const overlap = CANCELLABLE_TASK_STATUSES.filter((s) =>
      TERMINAL_TASK_STATUSES.includes(s),
    );
    expect(overlap).toEqual([]);
  });

  it("treats every retryable status as terminal but not every terminal as retryable", () => {
    for (const s of RETRYABLE_TASK_STATUSES) expect(isTerminalTaskStatus(s)).toBe(true);
    expect(isRetryableTaskStatus("done")).toBe(false);
  });

  it("agrees between the predicates and the sets they read", () => {
    for (const s of TASK_STATUSES) {
      expect(isTerminalTaskStatus(s)).toBe(TERMINAL_TASK_STATUSES.includes(s));
      expect(isRetryableTaskStatus(s)).toBe(RETRYABLE_TASK_STATUSES.includes(s));
    }
  });
});

describe("task lifecycle taxonomy", () => {
  it("assigns every status to a declared lane", () => {
    for (const s of TASK_STATUSES) {
      expect(TASK_LIFECYCLES).toContain(TASK_LIFECYCLE_OF[s]);
    }
  });

  it("inverts the forward map exactly — no status lost or duplicated", () => {
    const flattened = TASK_LIFECYCLES.flatMap((l) => [...TASK_STATUSES_BY_LIFECYCLE[l]]);
    expect(flattened.sort()).toEqual([...TASK_STATUSES].sort());
  });

  it("puts each status in the bucket its forward mapping names", () => {
    for (const s of TASK_STATUSES) {
      expect(TASK_STATUSES_BY_LIFECYCLE[TASK_LIFECYCLE_OF[s]]).toContain(s);
    }
  });

  it("gives every lane a bucket, even if empty", () => {
    for (const l of TASK_LIFECYCLES) {
      expect(TASK_STATUSES_BY_LIFECYCLE[l]).toBeDefined();
    }
  });

  it("keeps blocked and archived out of in_review and done", () => {
    // The drift this taxonomy replaced: the server folded `blocked` into
    // in_review and `failed`/`cancelled` into done, while the board
    // painted them as their own lanes.
    expect(TASK_STATUSES_BY_LIFECYCLE.in_review).toEqual(["review"]);
    expect(TASK_STATUSES_BY_LIFECYCLE.done).toEqual(["done"]);
    expect(TASK_STATUSES_BY_LIFECYCLE.blocked).toEqual(["blocked"]);
    expect(TASK_STATUSES_BY_LIFECYCLE.archived).toEqual(["failed", "cancelled"]);
  });

  it("maps exactly the terminal statuses into the done + archived lanes", () => {
    const settled: TaskStatus[] = [
      ...TASK_STATUSES_BY_LIFECYCLE.done,
      ...TASK_STATUSES_BY_LIFECYCLE.archived,
    ];
    expect(settled.sort()).toEqual([...TERMINAL_TASK_STATUSES].sort());
  });

  it("exposes the same lane through the helper as through the map", () => {
    for (const s of TASK_STATUSES) {
      expect(taskLifecycleOf(s)).toBe(TASK_LIFECYCLE_OF[s]);
    }
  });

  it("lists lanes in workflow order", () => {
    const expected: TaskLifecycle[] = [
      "pending",
      "in_progress",
      "blocked",
      "in_review",
      "done",
      "archived",
    ];
    expect([...TASK_LIFECYCLES]).toEqual(expected);
  });
});
