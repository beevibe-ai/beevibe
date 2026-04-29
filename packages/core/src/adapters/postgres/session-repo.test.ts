import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG } from "../../domain/agent.js";
import { agentId, personId, sessionId, taskId } from "../../domain/ids.js";
import type { Pool } from "./client.js";
import { createTestPool, truncateAll } from "../../test-helpers.js";
import { PostgresAgentRepository } from "./agent-repo.js";
import { PostgresPersonRepository } from "./person-repo.js";
import { PostgresSessionRepository } from "./session-repo.js";
import { PostgresTaskRepository } from "./task-repo.js";

describe("PostgresSessionRepository", () => {
  let pool: Pool;
  let sessions: PostgresSessionRepository;
  let agents: PostgresAgentRepository;
  let persons: PostgresPersonRepository;
  let tasks: PostgresTaskRepository;
  let agent: string;
  let person: string;
  let task: string;

  beforeAll(() => {
    pool = createTestPool();
    sessions = new PostgresSessionRepository(pool);
    agents = new PostgresAgentRepository(pool);
    persons = new PostgresPersonRepository(pool);
    tasks = new PostgresTaskRepository(pool);
  });

  beforeEach(async () => {
    await truncateAll(pool);
    const p = await persons.create({ id: personId(), name: "P" });
    person = p.id;
    const a = await agents.create({
      id: agentId(),
      name: "A",
      owner_id: person,
      hierarchy_level: "ic",
      runtime_config: DEFAULT_RUNTIME_CONFIG,
    });
    agent = a.id;
    const t = await tasks.create({
      id: taskId(),
      title: "T",
      priority: "medium",
      creator_id: person,
      creator_type: "person",
    });
    task = t.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  const newSession = (overrides: Partial<Parameters<typeof sessions.create>[0]> = {}) => ({
    id: sessionId(),
    agent_id: agent,
    type: "task" as const,
    intent: "do the thing",
    ...overrides,
  });

  it("create + findById round-trips, status defaults to running", async () => {
    const id = sessionId();
    const s = await sessions.create(newSession({ id, task_id: task }));
    expect(s.id).toBe(id);
    expect(s.status).toBe("running");
    expect(s.type).toBe("task");
    expect(s.task_id).toBe(task);
    const found = await sessions.findById(id);
    expect(found?.id).toBe(id);
  });

  it("create persists optional fields", async () => {
    const s = await sessions.create(
      newSession({
        task_id: task,
        workspace_path: "/tmp/x",
        process_pid: 12345,
        process_group_id: 12345,
      }),
    );
    expect(s.workspace_path).toBe("/tmp/x");
    expect(s.process_pid).toBe(12345);
    expect(s.process_group_id).toBe(12345);
  });

  it("findLatestForTask returns newest by created_at", async () => {
    await sessions.create(newSession({ task_id: task, intent: "first" }));
    await new Promise((r) => setTimeout(r, 5));
    const latest = await sessions.create(newSession({ task_id: task, intent: "second" }));
    const got = await sessions.findLatestForTask(task);
    expect(got?.id).toBe(latest.id);
  });

  it("listForTask returns all sessions, newest first", async () => {
    const s1 = await sessions.create(newSession({ task_id: task }));
    await new Promise((r) => setTimeout(r, 5));
    const s2 = await sessions.create(newSession({ task_id: task }));
    const list = await sessions.listForTask(task);
    expect(list.map((s) => s.id)).toEqual([s2.id, s1.id]);
  });

  it("countRunningByAgent counts sessions in given types", async () => {
    await sessions.create(newSession({ type: "task", task_id: task }));
    await sessions.create(newSession({ type: "task", task_id: task }));
    await sessions.create(newSession({ type: "mesh_ask", task_id: undefined }));
    const s = await sessions.create(newSession({ type: "task", task_id: task }));
    await sessions.update(s.id, { status: "succeeded" });

    expect(await sessions.countRunningByAgent(agent, ["task"])).toBe(2);
    expect(
      await sessions.countRunningByAgent(agent, ["mesh_ask", "mesh_negotiate", "blocker"]),
    ).toBe(1);
    expect(await sessions.countRunningByAgent(agent, [])).toBe(0);
  });

  it("listRunningWithPid returns running sessions with a PID set", async () => {
    const withPid = await sessions.create(newSession({ process_pid: 1234, task_id: task }));
    const noPid = await sessions.create(newSession({ task_id: task })); // no PID
    const completed = await sessions.create(newSession({ process_pid: 5678, task_id: task }));
    await sessions.update(completed.id, { status: "succeeded" });

    const live = await sessions.listRunningWithPid();
    const ids = live.map((s) => s.id);
    expect(ids).toContain(withPid.id);
    expect(ids).not.toContain(noPid.id);
    expect(ids).not.toContain(completed.id);
  });

  it("update patches process info, then usage JSONB, then completion", async () => {
    const s = await sessions.create(newSession({ task_id: task }));

    await sessions.update(s.id, { process_pid: 9999, process_group_id: 9999, cli_session_id: "cli_x" });
    const running = await sessions.findById(s.id);
    expect(running?.process_pid).toBe(9999);
    expect(running?.cli_session_id).toBe("cli_x");

    const usage = { cost_usd: 0.42, input_tokens: 100, output_tokens: 50, model: "claude-opus-4-7" };
    await sessions.update(s.id, { usage });
    const withUsage = await sessions.findById(s.id);
    expect(withUsage?.usage).toEqual(usage);

    const completedAt = new Date();
    await sessions.update(s.id, {
      status: "succeeded",
      result_summary: "done",
      exit_code: 0,
      completed_at: completedAt,
    });
    const finished = await sessions.findById(s.id);
    expect(finished?.status).toBe("succeeded");
    expect(finished?.result_summary).toBe("done");
    expect(finished?.exit_code).toBe(0);
    expect(finished?.completed_at).toEqual(completedAt);
  });

  it("FK to agent is enforced — missing agent rejects", async () => {
    await expect(
      sessions.create(newSession({ agent_id: "agent_missing" })),
    ).rejects.toThrow();
  });

  it("FK to task is nullable (mesh sessions have no task)", async () => {
    const s = await sessions.create(newSession({ type: "mesh_ask", task_id: undefined }));
    expect(s.task_id).toBeUndefined();
  });

  it("prior_session_id self-reference works", async () => {
    const first = await sessions.create(newSession({ task_id: task }));
    const second = await sessions.create(
      newSession({ task_id: task, prior_session_id: first.id }),
    );
    expect(second.prior_session_id).toBe(first.id);
  });

  it("update with empty patch returns unchanged", async () => {
    const s = await sessions.create(newSession({ task_id: task }));
    const same = await sessions.update(s.id, {});
    expect(same.id).toBe(s.id);
    expect(same.status).toBe("running");
  });
});
