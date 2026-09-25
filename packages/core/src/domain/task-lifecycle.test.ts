import { describe, expect, it } from "vitest";
import { TASK_STATUSES, type TaskStatus } from "./task.js";
import {
  CANCELLABLE_TASK_STATUSES,
  RETRYABLE_TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  TASK_LIFECYCLES,
  TASK_LIFECYCLE_OF,
  TASK_STATUSES_BY_LIFECYCLE,
  isCancellableTaskStatus,
  isRetryableTaskStatus,
  isTerminalTaskStatus,
  taskStatusesInLifecycles,
  type TaskLifecycle,
} from "./task-lifecycle.js";

describe("TASK_LIFECYCLE_OF", () => {
  it("assigns every task status to a declared lane", () => {
    for (const status of TASK_STATUSES) {
      expect(TASK_LIFECYCLES).toContain(TASK_LIFECYCLE_OF[status]);
    }
  });

  it("keeps blocked and archived out of in_review and done", () => {
    // The api's copy of this map used to fold `blocked` into `in_review`
    // and `failed`/`cancelled` into `done`, so `?lifecycle=in_review`
    // returned rows the board files under Blocked. Pin the lanes so the
    // two can't drift apart again.
    expect(TASK_LIFECYCLE_OF.blocked).toBe("blocked");
    expect(TASK_LIFECYCLE_OF.review).toBe("in_review");
    expect(TASK_LIFECYCLE_OF.failed).toBe("archived");
    expect(TASK_LIFECYCLE_OF.cancelled).toBe("archived");
    expect(TASK_LIFECYCLE_OF.done).toBe("done");
  });

  it("covers every lane with at least one status", () => {
    const used = new Set<TaskLifecycle>(Object.values(TASK_LIFECYCLE_OF));
    expect([...TASK_LIFECYCLES].sort()).toEqual([...used].sort());
  });
});

describe("taskStatusesInLifecycles", () => {
  it("returns the statuses of one lane in TASK_STATUSES order", () => {
    expect(taskStatusesInLifecycles("pending")).toEqual(["pending", "assigned"]);
    expect(taskStatusesInLifecycles("in_progress")).toEqual([
      "in_progress",
      "needs_revision",
      "revision",
    ]);
  });

  it("unions several lanes without duplicating or reordering", () => {
    expect(taskStatusesInLifecycles("done", "archived")).toEqual([
      "done",
      "failed",
      "cancelled",
    ]);
  });

  it("returns every status when given every lane", () => {
    expect(taskStatusesInLifecycles(...TASK_LIFECYCLES)).toEqual(TASK_STATUSES);
  });

  it("returns nothing for no lanes", () => {
    expect(taskStatusesInLifecycles()).toEqual([]);
  });
});

describe("TASK_STATUSES_BY_LIFECYCLE", () => {
  it("inverts TASK_LIFECYCLE_OF exactly", () => {
    for (const status of TASK_STATUSES) {
      expect(TASK_STATUSES_BY_LIFECYCLE[TASK_LIFECYCLE_OF[status]]).toContain(status);
    }
    const flattened = TASK_LIFECYCLES.flatMap((l) => [...TASK_STATUSES_BY_LIFECYCLE[l]]);
    expect(flattened.sort()).toEqual([...TASK_STATUSES].sort());
  });
});

describe("action gates", () => {
  it("makes cancellable the exact complement of terminal", () => {
    const cancellable = new Set<TaskStatus>(CANCELLABLE_TASK_STATUSES);
    for (const status of TASK_STATUSES) {
      expect(cancellable.has(status)).toBe(!TERMINAL_TASK_STATUSES.includes(status));
    }
  });

  it("allows retry only from failed and cancelled", () => {
    expect([...RETRYABLE_TASK_STATUSES].sort()).toEqual(["cancelled", "failed"]);
    expect(isRetryableTaskStatus("done")).toBe(false);
    expect(isRetryableTaskStatus("failed")).toBe(true);
  });

  it("agrees with its predicates", () => {
    for (const status of TASK_STATUSES) {
      expect(isTerminalTaskStatus(status)).toBe(TERMINAL_TASK_STATUSES.includes(status));
      expect(isCancellableTaskStatus(status)).toBe(!isTerminalTaskStatus(status));
    }
  });
});
