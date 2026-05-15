/**
 * Mock-Pool tests for views/tasks.ts. Validates row → DTO mapping +
 * filter-to-SQL params plumbing. The actual SQL correctness is exercised
 * by an integration-style e2e in a follow-up; these tests cover the
 * mapping layer without needing a database.
 */
import { describe, it, expect } from "vitest";
import { listTasks, getTask } from "./tasks.js";
import { makeMockPool } from "./test-helpers.js";

describe("listTasks", () => {
  it("returns empty array when DB returns no rows", async () => {
    const pool = makeMockPool([[]]);
    const tasks = await listTasks(pool, { bypassOwnerScope: true });
    expect(tasks).toEqual([]);
  });

  it("throws when neither caller_person_id nor bypassOwnerScope is set", async () => {
    // Fail-closed guard: a future caller forgetting the scope param would
    // otherwise leak every task in the DB. Surface the mistake immediately.
    const pool = makeMockPool([[]]);
    await expect(listTasks(pool)).rejects.toThrow(/caller_person_id/);
  });

  it("maps a row with joins into a TaskListItem", async () => {
    const pool = makeMockPool([
      [
        {
          id: "task_001",
          title: "Wire kanban",
          description: "do it",
          status: "in_progress",
          priority: "high",
          assignee_id: "agt_a",
          creator_id: "per_x",
          creator_type: "person",
          parent_task_id: null,
          result_summary: null,
          blocker_agent_id: null,
          blocker_reason: null,
          repo_url: null,
          next_dispatch_context: null,
          created_at: new Date("2026-04-30T00:00:00Z"),
          updated_at: new Date("2026-04-30T00:00:00Z"),
          assignee_name: "alice",
          assignee_hier: "ic",
          creator_label: "Weijia",
          session_count: "2",
          work_product_count: "1",
          latest_session_id: "sess_abc123def",
          latest_session_status: "running",
          latest_session_started_at: new Date("2026-04-30T11:55:00Z"),
          latest_session_completed_at: null,
          latest_session_agent_label: "alice",
        },
      ],
    ]);
    const tasks = await listTasks(pool, { bypassOwnerScope: true });
    expect(tasks).toHaveLength(1);
    const t = tasks[0]!;
    expect(t.title).toBe("Wire kanban");
    expect(t.assignee_label).toBe("alice");
    expect(t.assignee_hierarchy).toBe("ic");
    expect(t.creator_label).toBe("Weijia");
    expect(t.session_count).toBe(2);
    expect(t.work_product_count).toBe(1);
    expect(t.description).toEqual(["do it"]);
    expect(t.latest_session?.short_id).toBe("abc123");
    expect(t.latest_session?.status).toBe("running");
    expect(t.latest_session?.agent_label).toBe("alice");
  });

  it("translates lifecycle filter into a status array param", async () => {
    const pool = makeMockPool([[]]);
    const queryMock = pool._spy;
    await listTasks(pool, { lifecycle: "in_review", bypassOwnerScope: true });
    expect(queryMock).toHaveBeenCalledWith(
      expect.any(String),
      [["review", "blocked"], null, null],
    );
  });

  it("forwards assignee_id when set", async () => {
    const pool = makeMockPool([[]]);
    const queryMock = pool._spy;
    await listTasks(pool, { assignee_id: "agt_xyz", bypassOwnerScope: true });
    expect(queryMock).toHaveBeenCalledWith(expect.any(String), [null, "agt_xyz", null]);
  });

  it("forwards caller_person_id as the owner-scope param", async () => {
    // The /task route always sets this. SQL gates rows by assignee or
    // creator agent ownership, or by direct person-creator match.
    const pool = makeMockPool([[]]);
    const queryMock = pool._spy;
    await listTasks(pool, { caller_person_id: "per_owner" });
    expect(queryMock).toHaveBeenCalledWith(
      expect.any(String),
      [null, null, "per_owner"],
    );
  });
});

describe("getTask", () => {
  it("returns undefined when the task isn't found", async () => {
    const pool = makeMockPool([[], [], []]);
    const task = await getTask(pool, "task_missing");
    expect(task).toBeUndefined();
  });

  it("includes sessions and work products when found", async () => {
    const pool = makeMockPool([
      [
        {
          id: "task_001",
          title: "Wire kanban",
          description: "do it",
          status: "review",
          priority: "high",
          assignee_id: "agt_a",
          creator_id: "per_x",
          creator_type: "person",
          parent_task_id: null,
          result_summary: null,
          blocker_agent_id: null,
          blocker_reason: null,
          repo_url: null,
          next_dispatch_context: null,
          created_at: new Date(),
          updated_at: new Date(),
          assignee_name: "alice",
          assignee_hier: "ic",
          creator_label: "Weijia",
          session_count: 1,
          work_product_count: 1,
          latest_session_id: null,
          latest_session_status: null,
          latest_session_started_at: null,
          latest_session_completed_at: null,
          latest_session_agent_label: null,
        },
      ],
      [
        {
          id: "sess_abcdef0123",
          agent_id: "agt_a",
          agent_label: "alice",
          status: "succeeded",
          started_at: new Date("2026-04-30T10:00:00Z"),
          completed_at: new Date("2026-04-30T10:30:00Z"),
          result_summary: "all good",
        },
      ],
      [
        {
          id: "wp_001",
          task_id: "task_001",
          agent_id: "agt_a",
          type: "pull_request",
          title: "PR #42",
          summary: null,
          url: "https://github.com/foo/bar/pull/42",
          provider: "github",
          external_id: "42",
          metadata: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
    ]);
    const detail = await getTask(pool, "task_001");
    expect(detail?.title).toBe("Wire kanban");
    expect(detail?.sessions).toHaveLength(1);
    expect(detail?.sessions[0]?.short_id).toBe("abcdef");
    expect(detail?.sessions[0]?.duration_label).toBe("30m");
    expect(detail?.work_products).toHaveLength(1);
    expect(detail?.work_products[0]?.title).toBe("PR #42");
  });
});
