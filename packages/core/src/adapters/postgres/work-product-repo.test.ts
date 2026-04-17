import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG } from "../../domain/agent.js";
import { agentId, personId, taskId, workProductId } from "../../domain/ids.js";
import type { Pool } from "./client.js";
import { createTestPool, truncateAll } from "./test-helpers.js";
import { PostgresAgentRepository } from "./agent-repo.js";
import { PostgresPersonRepository } from "./person-repo.js";
import { PostgresTaskRepository } from "./task-repo.js";
import { PostgresWorkProductRepository } from "./work-product-repo.js";

describe("PostgresWorkProductRepository", () => {
  let pool: Pool;
  let wps: PostgresWorkProductRepository;
  let agents: PostgresAgentRepository;
  let persons: PostgresPersonRepository;
  let tasks: PostgresTaskRepository;
  let agent: string;
  let task: string;

  beforeAll(() => {
    pool = createTestPool();
    wps = new PostgresWorkProductRepository(pool);
    agents = new PostgresAgentRepository(pool);
    persons = new PostgresPersonRepository(pool);
    tasks = new PostgresTaskRepository(pool);
  });

  beforeEach(async () => {
    await truncateAll(pool);
    const p = await persons.create({ id: personId(), name: "P" });
    const a = await agents.create({
      id: agentId(),
      name: "A",
      owner_id: p.id,
      hierarchy_level: "ic",
      runtime_config: DEFAULT_RUNTIME_CONFIG,
    });
    agent = a.id;
    const t = await tasks.create({
      id: taskId(),
      title: "T",
      priority: "medium",
      creator_id: p.id,
      creator_type: "person",
    });
    task = t.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  const newWp = (overrides: Partial<Parameters<typeof wps.create>[0]> = {}) => ({
    id: workProductId(),
    task_id: task,
    agent_id: agent,
    type: "pull_request" as const,
    title: "Add feature X",
    ...overrides,
  });

  it("create + findById round-trips", async () => {
    const id = workProductId();
    const wp = await wps.create(
      newWp({
        id,
        summary: "Summary here",
        url: "https://github.com/foo/bar/pull/42",
        provider: "github",
        external_id: "42",
        metadata: { files_changed: 3, lines_added: 120 },
      }),
    );
    expect(wp.id).toBe(id);
    expect(wp.type).toBe("pull_request");
    expect(wp.provider).toBe("github");
    expect(wp.external_id).toBe("42");
    expect(wp.metadata).toEqual({ files_changed: 3, lines_added: 120 });

    const found = await wps.findById(id);
    expect(found).toEqual(wp);
  });

  it("create without optional fields returns undefined (null→undefined mapping)", async () => {
    const wp = await wps.create(newWp());
    expect(wp.summary).toBeUndefined();
    expect(wp.url).toBeUndefined();
    expect(wp.provider).toBeUndefined();
    expect(wp.external_id).toBeUndefined();
    expect(wp.metadata).toBeUndefined();
  });

  it("listByTask filters + sorts by created_at DESC", async () => {
    const a = await wps.create(newWp({ title: "first" }));
    await new Promise((r) => setTimeout(r, 5));
    const b = await wps.create(newWp({ title: "second" }));
    const list = await wps.listByTask(task);
    expect(list.map((w) => w.id)).toEqual([b.id, a.id]);
  });

  it("listByTask returns empty for unknown task", async () => {
    expect(await wps.listByTask("task_missing")).toEqual([]);
  });

  it("listByAgent filters + sorts by created_at DESC", async () => {
    const a = await wps.create(newWp({ title: "first" }));
    await new Promise((r) => setTimeout(r, 5));
    const b = await wps.create(newWp({ title: "second" }));
    const list = await wps.listByAgent(agent);
    expect(list.map((w) => w.id)).toEqual([b.id, a.id]);
  });

  it("FK to task enforced — missing task rejects", async () => {
    await expect(wps.create(newWp({ task_id: "task_missing" }))).rejects.toThrow();
  });

  it("FK to agent enforced — missing agent rejects", async () => {
    await expect(wps.create(newWp({ agent_id: "agent_missing" }))).rejects.toThrow();
  });

  it("deleting task cascades to work products (FK ON DELETE CASCADE)", async () => {
    await wps.create(newWp({ title: "a" }));
    await wps.create(newWp({ title: "b" }));
    expect((await wps.listByTask(task)).length).toBe(2);
    await tasks.delete(task);
    expect(await wps.listByTask(task)).toEqual([]);
  });

  it("delete removes single row", async () => {
    const wp = await wps.create(newWp());
    await wps.delete(wp.id);
    expect(await wps.findById(wp.id)).toBeUndefined();
  });
});
