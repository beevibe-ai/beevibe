import { describe, expect, it } from "vitest";
import type { TaskStatus } from "@beevibe/core";
import { TASK_STATUSES } from "@beevibe/core";
import {
  countArchivedTasks,
  groupTasks,
  type Lifecycle,
} from "./tasks-grouping";
import type { TaskListItem } from "@/lib/types/tasks";

function makeTask(id: string, status: TaskStatus): TaskListItem {
  return {
    id,
    title: `task-${id}`,
    status,
    priority: "medium",
    creator_id: "u_creator",
    creator_type: "person",
    created_at: new Date("2026-04-01T00:00:00Z"),
    updated_at: new Date("2026-04-01T00:00:00Z"),
  };
}

const EXPECTED_LIFECYCLE: Record<TaskStatus, Lifecycle> = {
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

describe("groupTasks", () => {
  it("returns five lanes in workflow order by default (no archived)", () => {
    const lanes = groupTasks([]);
    expect(lanes.map((l) => l.key)).toEqual([
      "pending",
      "in_progress",
      "blocked",
      "in_review",
      "done",
    ]);
    expect(lanes.every((l) => l.count === 0 && l.tasks.length === 0)).toBe(true);
  });

  it("appends an archived lane when showArchived is true", () => {
    const lanes = groupTasks([], { showArchived: true });
    expect(lanes.map((l) => l.key)).toEqual([
      "pending",
      "in_progress",
      "blocked",
      "in_review",
      "done",
      "archived",
    ]);
  });

  it("maps every TaskStatus exhaustively (no status falls through to a wrong lane)", () => {
    for (const status of TASK_STATUSES) {
      const [task] = [makeTask("t1", status)];
      const lanes = groupTasks([task], { showArchived: true });
      const populated = lanes.find((l) => l.tasks.length === 1);
      expect(populated?.key, `status=${status}`).toBe(EXPECTED_LIFECYCLE[status]);
    }
  });

  it("hides failed + cancelled tasks when showArchived is false", () => {
    const tasks: TaskListItem[] = [
      makeTask("a", "pending"),
      makeTask("b", "failed"),
      makeTask("c", "cancelled"),
      makeTask("d", "done"),
    ];
    const lanes = groupTasks(tasks);
    const totalShown = lanes.reduce((n, l) => n + l.count, 0);
    expect(totalShown).toBe(2); // pending + done only
    expect(lanes.find((l) => l.key === "done")?.count).toBe(1);
  });

  it("places blocked tasks in their own lane (not in In review)", () => {
    const tasks: TaskListItem[] = [
      makeTask("a", "blocked"),
      makeTask("b", "review"),
    ];
    const lanes = groupTasks(tasks);
    const byKey = Object.fromEntries(lanes.map((l) => [l.key, l]));
    expect(byKey.blocked.tasks.map((t) => t.id)).toEqual(["a"]);
    expect(byKey.in_review.tasks.map((t) => t.id)).toEqual(["b"]);
  });

  it("counts tasks within each lane and preserves insertion order", () => {
    const tasks: TaskListItem[] = [
      makeTask("a", "pending"),
      makeTask("b", "in_progress"),
      makeTask("c", "blocked"),
      makeTask("d", "review"),
      makeTask("e", "done"),
      makeTask("f", "failed"),
      makeTask("g", "assigned"),
      makeTask("h", "needs_revision"),
    ];
    const lanes = groupTasks(tasks, { showArchived: true });
    const byKey = Object.fromEntries(lanes.map((l) => [l.key, l]));

    expect(byKey.pending.tasks.map((t) => t.id)).toEqual(["a", "g"]);
    expect(byKey.in_progress.tasks.map((t) => t.id)).toEqual(["b", "h"]);
    expect(byKey.blocked.tasks.map((t) => t.id)).toEqual(["c"]);
    expect(byKey.in_review.tasks.map((t) => t.id)).toEqual(["d"]);
    expect(byKey.done.tasks.map((t) => t.id)).toEqual(["e"]);
    expect(byKey.archived.tasks.map((t) => t.id)).toEqual(["f"]);
  });

  it("attaches a non-empty dot class and label to each lane", () => {
    const lanes = groupTasks([], { showArchived: true });
    for (const lane of lanes) {
      expect(lane.dot).toMatch(/^bg-/);
      expect(lane.label.length).toBeGreaterThan(0);
    }
  });
});

describe("countArchivedTasks", () => {
  it("counts only failed + cancelled", () => {
    const tasks: TaskListItem[] = [
      makeTask("a", "pending"),
      makeTask("b", "failed"),
      makeTask("c", "cancelled"),
      makeTask("d", "done"),
      makeTask("e", "blocked"),
      makeTask("f", "failed"),
    ];
    expect(countArchivedTasks(tasks)).toBe(3);
  });

  it("returns 0 on empty input", () => {
    expect(countArchivedTasks([])).toBe(0);
  });
});
