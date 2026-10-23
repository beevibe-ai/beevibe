import { describe, expect, it } from "vitest";
import {
  TASK_CLAIM_TRANSITION,
  TASK_STATUSES,
  transitionForClaim,
  transitionForReapRequeue,
  type TaskStatus,
} from "./task.js";

describe("transitionForClaim", () => {
  it("moves the two queue states into their active states", () => {
    expect(transitionForClaim("assigned")).toBe("in_progress");
    expect(transitionForClaim("needs_revision")).toBe("revision");
  });

  it("leaves already-active states alone", () => {
    expect(transitionForClaim("in_progress")).toBeUndefined();
    expect(transitionForClaim("revision")).toBeUndefined();
  });

  it("leaves terminal states alone — they must not be re-dispatched", () => {
    for (const status of ["done", "failed", "cancelled"] as TaskStatus[]) {
      expect(transitionForClaim(status)).toBeUndefined();
    }
  });
});

describe("transitionForReapRequeue", () => {
  it("puts an active state back on the queue it was claimed from", () => {
    expect(transitionForReapRequeue("in_progress")).toBe("assigned");
    expect(transitionForReapRequeue("revision")).toBe("needs_revision");
  });

  it("leaves terminal states alone — a reap must not overwrite them", () => {
    // Both reapers rely on this: a task the agent already marked done
    // must not be dragged back onto the queue because its session row
    // looked orphaned.
    for (const status of ["done", "failed", "cancelled"] as TaskStatus[]) {
      expect(transitionForReapRequeue(status)).toBeUndefined();
    }
  });

  it("leaves queue states alone", () => {
    expect(transitionForReapRequeue("pending")).toBeUndefined();
    expect(transitionForReapRequeue("assigned")).toBeUndefined();
    expect(transitionForReapRequeue("needs_revision")).toBeUndefined();
  });
});

describe("the claim/reap pair", () => {
  it("is each other's inverse on every status", () => {
    // The point of deriving the reap table from the claim table: the api
    // and scheduler claim paths walk it forwards and both reapers walk it
    // backwards, so a one-sided edit wedges tasks in an active state with
    // no live session behind them.
    for (const status of TASK_STATUSES) {
      const claimed = transitionForClaim(status);
      if (claimed) expect(transitionForReapRequeue(claimed)).toBe(status);

      const requeued = transitionForReapRequeue(status);
      if (requeued) expect(transitionForClaim(requeued)).toBe(status);
    }
  });

  it("names only statuses that exist", () => {
    for (const [from, to] of Object.entries(TASK_CLAIM_TRANSITION)) {
      expect(TASK_STATUSES).toContain(from as TaskStatus);
      expect(TASK_STATUSES).toContain(to);
    }
  });
});
