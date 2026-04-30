import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG } from "../../domain/agent.js";
import { agentId, personId, taskId } from "../../domain/ids.js";
import type { Pool } from "./client.js";
import { createTestPool, truncateAll } from "../../test-helpers.js";
import { PostgresAgentRepository } from "./agent-repo.js";
import { PostgresPersonRepository } from "./person-repo.js";
import { PostgresTaskRepository } from "./task-repo.js";

describe("PostgresTaskRepository", () => {
  let pool: Pool;
  let tasks: PostgresTaskRepository;
  let agents: PostgresAgentRepository;
  let persons: PostgresPersonRepository;
  let ownerPersonId: string;
  let assigneeAgentId: string;

  beforeAll(() => {
    pool = createTestPool();
    tasks = new PostgresTaskRepository(pool);
    agents = new PostgresAgentRepository(pool);
    persons = new PostgresPersonRepository(pool);
  });

  beforeEach(async () => {
    await truncateAll(pool);
    const owner = await persons.create({ id: personId(), name: "Owner" });
    ownerPersonId = owner.id;
    const a = await agents.create({
      id: agentId(),
      name: "Assignee",
      owner_id: owner.id,
      hierarchy_level: "ic",
      runtime_config: DEFAULT_RUNTIME_CONFIG,
    });
    assigneeAgentId = a.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  const newTask = (overrides: Partial<Parameters<typeof tasks.create>[0]> = {}) => ({
    id: taskId(),
    title: "T",
    priority: "medium" as const,
    creator_id: ownerPersonId,
    creator_type: "person" as const,
    ...overrides,
  });

  it("create + findById defaults status=pending", async () => {
    const id = taskId();
    const t = await tasks.create(newTask({ id, title: "First" }));
    expect(t.id).toBe(id);
    expect(t.status).toBe("pending");
    expect(t.priority).toBe("medium");
    expect(t.creator_type).toBe("person");
    const found = await tasks.findById(id);
    expect(found?.id).toBe(id);
  });

  it("create accepts an explicit status", async () => {
    const t = await tasks.create(newTask({ status: "assigned", assignee_id: assigneeAgentId }));
    expect(t.status).toBe("assigned");
  });

  it("repo_url round-trips: null by default, set via create, updatable", async () => {
    const t1 = await tasks.create(newTask({ title: "no-repo" }));
    expect(t1.repo_url).toBeUndefined();

    const t2 = await tasks.create(
      newTask({ title: "with-repo", repo_url: "https://github.com/org/repo" }),
    );
    expect(t2.repo_url).toBe("https://github.com/org/repo");

    const t3 = await tasks.update(t1.id, { repo_url: "https://github.com/org/repo2" });
    expect(t3.repo_url).toBe("https://github.com/org/repo2");
  });

  it("list with no filter returns all rows, newest first", async () => {
    const t1 = await tasks.create(newTask({ title: "first" }));
    await new Promise((r) => setTimeout(r, 5));
    const t2 = await tasks.create(newTask({ title: "second" }));
    const all = await tasks.list();
    expect(all[0]?.id).toBe(t2.id);
    expect(all[1]?.id).toBe(t1.id);
  });

  it("list by status array uses ANY($1::text[])", async () => {
    await tasks.create(newTask({ status: "pending" }));
    await tasks.create(newTask({ status: "done" }));
    await tasks.create(newTask({ status: "failed" }));
    const mid = await tasks.list({ status: ["pending", "done"] });
    expect(mid.map((t) => t.status).sort()).toEqual(["done", "pending"]);
  });

  it("list by creator_id filters", async () => {
    const otherPerson = await persons.create({ id: personId(), name: "Other" });
    const mine = await tasks.create(newTask());
    await tasks.create(newTask({ creator_id: otherPerson.id }));
    const byMe = await tasks.list({ creator_id: ownerPersonId });
    expect(byMe.map((t) => t.id)).toEqual([mine.id]);
  });

  it("listByAssignee returns only tasks for that agent", async () => {
    const other = await agents.create({
      id: agentId(),
      name: "Other",
      owner_id: ownerPersonId,
      hierarchy_level: "ic",
      runtime_config: DEFAULT_RUNTIME_CONFIG,
    });
    const mine = await tasks.create(newTask({ assignee_id: assigneeAgentId }));
    await tasks.create(newTask({ assignee_id: other.id }));
    await tasks.create(newTask()); // unassigned
    const got = await tasks.listByAssignee(assigneeAgentId);
    expect(got.map((t) => t.id)).toEqual([mine.id]);
  });

  it("listReviewQueue returns only review, priority desc then updated_at asc", async () => {
    const high = await tasks.create(newTask({ status: "review", priority: "high" }));
    const critical = await tasks.create(newTask({ status: "review", priority: "critical" }));
    // needs_revision (queued for re-work) and revision (actively running
    // re-work) are NOT in the human review queue — those are executor-side
    // states now, not awaiting-human-decision states.
    await tasks.create(newTask({ status: "needs_revision", priority: "critical" }));
    await tasks.create(newTask({ status: "revision", priority: "critical" }));
    await tasks.create(newTask({ status: "done" }));
    const queue = await tasks.listReviewQueue();
    expect(queue.map((t) => t.id)).toEqual([critical.id, high.id]);
  });

  it("countChildrenNotComplete counts sub-tasks in non-terminal states", async () => {
    const parent = await tasks.create(newTask({ title: "parent" }));
    await tasks.create(newTask({ parent_task_id: parent.id, status: "in_progress" }));
    await tasks.create(newTask({ parent_task_id: parent.id, status: "assigned" }));
    await tasks.create(newTask({ parent_task_id: parent.id, status: "done" }));
    await tasks.create(newTask({ parent_task_id: parent.id, status: "cancelled" }));
    await tasks.create(newTask({ parent_task_id: parent.id, status: "failed" }));
    expect(await tasks.countChildrenNotComplete(parent.id)).toBe(2);
  });

  it("countChildren counts ALL sub-tasks regardless of status", async () => {
    const parent = await tasks.create(newTask({ title: "parent" }));
    await tasks.create(newTask({ parent_task_id: parent.id, status: "in_progress" }));
    await tasks.create(newTask({ parent_task_id: parent.id, status: "done" }));
    await tasks.create(newTask({ parent_task_id: parent.id, status: "failed" }));
    // Unrelated task with no parent — must not count.
    await tasks.create(newTask({ title: "leaf" }));
    expect(await tasks.countChildren(parent.id)).toBe(3);
  });

  it("countChildren returns 0 for a leaf task (no children)", async () => {
    const leaf = await tasks.create(newTask({ title: "leaf" }));
    expect(await tasks.countChildren(leaf.id)).toBe(0);
  });

  it("updateProgress sets status + result_summary atomically", async () => {
    const t = await tasks.create(newTask({ status: "in_progress" }));
    const updated = await tasks.updateProgress(t.id, "done", "all green");
    expect(updated.status).toBe("done");
    expect(updated.result_summary).toBe("all green");
  });

  it("markBlocked sets status=blocked + blocker fields", async () => {
    const blocker = await agents.create({
      id: agentId(),
      name: "Parent",
      owner_id: ownerPersonId,
      hierarchy_level: "team",
      runtime_config: DEFAULT_RUNTIME_CONFIG,
    });
    const t = await tasks.create(newTask({ status: "in_progress" }));
    const blocked = await tasks.markBlocked(t.id, blocker.id, "stuck on auth");
    expect(blocked.status).toBe("blocked");
    expect(blocked.blocker_agent_id).toBe(blocker.id);
    expect(blocked.blocker_reason).toBe("stuck on auth");
  });

  it("clearBlocker resets blocker fields and returns to in_progress", async () => {
    const blocker = await agents.create({
      id: agentId(),
      name: "Parent",
      owner_id: ownerPersonId,
      hierarchy_level: "team",
      runtime_config: DEFAULT_RUNTIME_CONFIG,
    });
    const t = await tasks.create(newTask({ status: "in_progress" }));
    await tasks.markBlocked(t.id, blocker.id, "stuck");
    const cleared = await tasks.clearBlocker(t.id);
    expect(cleared.status).toBe("in_progress");
    expect(cleared.blocker_agent_id).toBeUndefined();
    expect(cleared.blocker_reason).toBeUndefined();
  });

  it("update patches selective fields", async () => {
    const t = await tasks.create(newTask({ title: "old", priority: "low" }));
    const updated = await tasks.update(t.id, { title: "new", priority: "high" });
    expect(updated.title).toBe("new");
    expect(updated.priority).toBe("high");
  });

  it("update with empty patch returns unchanged", async () => {
    const t = await tasks.create(newTask());
    const same = await tasks.update(t.id, {});
    expect(same.title).toBe(t.title);
  });

  it("create rejects creator_type not in ('person','agent')", async () => {
    await expect(
      tasks.create({ ...newTask(), creator_type: "bogus" as unknown as "person" }),
    ).rejects.toThrow();
  });

  it("parent_task_id self-reference works", async () => {
    const parent = await tasks.create(newTask({ title: "parent" }));
    const child = await tasks.create(newTask({ parent_task_id: parent.id }));
    expect(child.parent_task_id).toBe(parent.id);
  });

  describe("listAssignable + claimById (M5.0 dispatch API)", () => {
    it("listAssignable orders critical > high > medium > low then by created_at ASC", async () => {
      const low = await tasks.create(
        newTask({ status: "assigned", priority: "low", assignee_id: assigneeAgentId }),
      );
      await new Promise((r) => setTimeout(r, 5));
      const critical = await tasks.create(
        newTask({ status: "assigned", priority: "critical", assignee_id: assigneeAgentId }),
      );
      await new Promise((r) => setTimeout(r, 5));
      const high = await tasks.create(
        newTask({ status: "assigned", priority: "high", assignee_id: assigneeAgentId }),
      );
      await new Promise((r) => setTimeout(r, 5));
      const medium = await tasks.create(
        newTask({ status: "assigned", priority: "medium", assignee_id: assigneeAgentId }),
      );

      const list = await tasks.listAssignable();
      expect(list.map((t) => t.id)).toEqual([critical.id, high.id, medium.id, low.id]);
    });

    it("listAssignable uses created_at ASC to break ties within the same priority (FIFO)", async () => {
      const first = await tasks.create(
        newTask({ status: "assigned", priority: "high", assignee_id: assigneeAgentId }),
      );
      await new Promise((r) => setTimeout(r, 5));
      const second = await tasks.create(
        newTask({ status: "assigned", priority: "high", assignee_id: assigneeAgentId }),
      );

      const list = await tasks.listAssignable();
      expect(list.map((t) => t.id)).toEqual([first.id, second.id]);
    });

    it("listAssignable includes both assigned and needs_revision status", async () => {
      const assigned = await tasks.create(
        newTask({ status: "assigned", assignee_id: assigneeAgentId }),
      );
      const needsRevision = await tasks.create(
        newTask({ status: "needs_revision", assignee_id: assigneeAgentId }),
      );
      const list = await tasks.listAssignable();
      const ids = list.map((t) => t.id).sort();
      expect(ids).toEqual([assigned.id, needsRevision.id].sort());
    });

    it("listAssignable excludes running states (in_progress, revision) and terminal states", async () => {
      await tasks.create(newTask({ status: "pending", assignee_id: assigneeAgentId }));
      await tasks.create(newTask({ status: "in_progress", assignee_id: assigneeAgentId }));
      // `revision` is a running state (actively re-working) — must NOT appear
      // in the assignable queue, or a worker would re-claim it mid-run.
      await tasks.create(newTask({ status: "revision", assignee_id: assigneeAgentId }));
      await tasks.create(newTask({ status: "review", assignee_id: assigneeAgentId }));
      await tasks.create(newTask({ status: "done", assignee_id: assigneeAgentId }));
      await tasks.create(newTask({ status: "failed", assignee_id: assigneeAgentId }));
      await tasks.create(newTask({ status: "cancelled", assignee_id: assigneeAgentId }));
      const list = await tasks.listAssignable();
      expect(list).toHaveLength(0);
    });

    it("listAssignable excludes tasks with null assignee_id", async () => {
      await tasks.create(newTask({ status: "assigned" })); // no assignee
      const list = await tasks.listAssignable();
      expect(list).toHaveLength(0);
    });

    it("claimById transitions assigned → in_progress and returns the row", async () => {
      const t = await tasks.create(
        newTask({ status: "assigned", assignee_id: assigneeAgentId }),
      );
      const claimed = await tasks.claimById(t.id);
      expect(claimed?.id).toBe(t.id);
      expect(claimed?.status).toBe("in_progress");
      const reread = await tasks.findById(t.id);
      expect(reread?.status).toBe("in_progress");
    });

    it("claimById transitions needs_revision → revision (re-work running state)", async () => {
      const t = await tasks.create(
        newTask({ status: "needs_revision", assignee_id: assigneeAgentId }),
      );
      const claimed = await tasks.claimById(t.id);
      expect(claimed?.status).toBe("revision");
      const reread = await tasks.findById(t.id);
      expect(reread?.status).toBe("revision");
    });

    it("claimById returns undefined when the row is no longer in a queue state (race loser)", async () => {
      const t = await tasks.create(
        newTask({ status: "assigned", assignee_id: assigneeAgentId }),
      );
      const first = await tasks.claimById(t.id);
      expect(first?.status).toBe("in_progress");
      const second = await tasks.claimById(t.id);
      expect(second).toBeUndefined();
    });

    it("two concurrent claimById calls on the same task yield exactly one winner", async () => {
      const t = await tasks.create(
        newTask({ status: "assigned", assignee_id: assigneeAgentId }),
      );
      const [a, b] = await Promise.all([tasks.claimById(t.id), tasks.claimById(t.id)]);
      const winners = [a, b].filter((r) => r !== undefined);
      expect(winners).toHaveLength(1);
    });

    it("two concurrent claimById on a needs_revision task yield exactly one winner (revision path too)", async () => {
      const t = await tasks.create(
        newTask({ status: "needs_revision", assignee_id: assigneeAgentId }),
      );
      const [a, b] = await Promise.all([tasks.claimById(t.id), tasks.claimById(t.id)]);
      const winners = [a, b].filter((r) => r !== undefined);
      expect(winners).toHaveLength(1);
      expect(winners[0]?.status).toBe("revision");
    });
  });

  it("delete removes the row", async () => {
    const t = await tasks.create(newTask());
    await tasks.delete(t.id);
    expect(await tasks.findById(t.id)).toBeUndefined();
  });
});
