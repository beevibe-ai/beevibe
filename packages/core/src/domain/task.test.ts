import { describe, expect, it } from "vitest";
import {
  RETRYABLE_TASK_STATUSES,
  TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  isCancellableTaskStatus,
  isRetryableTaskStatus,
  isTerminalTaskStatus,
} from "./task.js";

const cancellable = TASK_STATUSES.filter(isCancellableTaskStatus);

describe("task status classification", () => {
  it("partitions every status into exactly one of terminal / cancellable", () => {
    for (const status of TASK_STATUSES) {
      expect(isTerminalTaskStatus(status)).toBe(!isCancellableTaskStatus(status));
    }
    expect(cancellable.length + TERMINAL_TASK_STATUSES.length).toBe(TASK_STATUSES.length);
  });

  /**
   * The cancellable set is derived from the terminal one now; this pins it
   * to the list `api/src/routes/task.ts` used to spell out by hand, so the
   * derivation can't quietly widen what `/task/:id/cancel` accepts.
   */
  it("keeps the cancellable set the api's /cancel gate shipped with", () => {
    expect(cancellable).toEqual([
      "pending",
      "assigned",
      "in_progress",
      "needs_revision",
      "revision",
      "review",
      "blocked",
    ]);
  });

  it("treats retryable statuses as a strict subset of terminal ones", () => {
    for (const status of RETRYABLE_TASK_STATUSES) {
      expect(isTerminalTaskStatus(status)).toBe(true);
    }
    // `done` is terminal but not retryable — a shipped task is revised, not retried.
    expect(isRetryableTaskStatus("done")).toBe(false);
  });
});
