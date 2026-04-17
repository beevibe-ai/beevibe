import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG } from "../../domain/agent.js";
import { agentId, personId, taskId } from "../../domain/ids.js";
import type { Pool } from "./client.js";
import { createTestPool, truncateAll } from "./test-helpers.js";
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

  it("listReviewQueue returns only review/revision, priority desc then updated_at asc", async () => {
    const a = await tasks.create(newTask({ status: "review", priority: "high" }));
    const b = await tasks.create(newTask({ status: "revision", priority: "critical" }));
    await tasks.create(newTask({ status: "done" }));
    const queue = await tasks.listReviewQueue();
    expect(queue.map((t) => t.id)).toEqual([b.id, a.id]);
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

  it("delete removes the row", async () => {
    const t = await tasks.create(newTask());
    await tasks.delete(t.id);
    expect(await tasks.findById(t.id)).toBeUndefined();
  });
});
