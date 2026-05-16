import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG } from "../../domain/agent.js";
import {
  agentId,
  daemonId,
  personId,
  runtimeId,
  sessionId,
  taskId,
} from "../../domain/ids.js";
import type { Pool } from "./client.js";
import { createTestPool, truncateAll } from "../../test-helpers.js";
import { PostgresAgentRepository } from "./agent-repo.js";
import { PostgresDaemonRepository } from "./daemon-repo.js";
import { PostgresPersonRepository } from "./person-repo.js";
import { PostgresRuntimeRepository } from "./runtime-repo.js";
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

  describe("softDeleteChatChain", () => {
    it("walks the chain backwards and stamps every session as deleted", async () => {
      const turn1 = await sessions.create(newSession({ type: "chat", intent: "hi" }));
      const turn2 = await sessions.create(
        newSession({ type: "chat", intent: "follow up", prior_session_id: turn1.id }),
      );
      const turn3 = await sessions.create(
        newSession({ type: "chat", intent: "again", prior_session_id: turn2.id }),
      );

      const deleted = await sessions.softDeleteChatChain(turn3.id, agent);
      expect(deleted).toBe(3);

      // listChatForAgent must hide the whole chain so it doesn't reappear
      // under a new head id when the original head is gone.
      const remaining = await sessions.listChatForAgent(agent, 100);
      expect(remaining).toEqual([]);
    });

    it("is scoped to agent — a different agent's head id does nothing", async () => {
      const head = await sessions.create(newSession({ type: "chat", intent: "hi" }));
      const otherAgent = await agents.create({
        id: agentId(),
        name: "B",
        owner_id: person,
        hierarchy_level: "ic",
        runtime_config: DEFAULT_RUNTIME_CONFIG,
      });

      const deleted = await sessions.softDeleteChatChain(head.id, otherAgent.id);
      expect(deleted).toBe(0);

      const remaining = await sessions.listChatForAgent(agent, 100);
      expect(remaining.map((s) => s.id)).toEqual([head.id]);
    });

    it("is idempotent — re-deleting an already-deleted chain returns 0", async () => {
      const head = await sessions.create(newSession({ type: "chat", intent: "hi" }));
      expect(await sessions.softDeleteChatChain(head.id, agent)).toBe(1);
      expect(await sessions.softDeleteChatChain(head.id, agent)).toBe(0);
    });

    it("only touches chat sessions — task chains in between are untouched", async () => {
      // Build a chat chain that happens to share an agent with task work.
      const chatHead = await sessions.create(newSession({ type: "chat", intent: "hi" }));
      const taskRun = await sessions.create(newSession({ type: "task", task_id: task }));

      await sessions.softDeleteChatChain(chatHead.id, agent);

      const tasksRemaining = await sessions.listForAgent(agent);
      // listForAgent returns ALL types and is not filtered by deleted_at,
      // so the task session must still be there.
      expect(tasksRemaining.some((s) => s.id === taskRun.id)).toBe(true);
    });
  });

  describe("claimNextForRuntime", () => {
    let daemons: PostgresDaemonRepository;
    let runtimes: PostgresRuntimeRepository;
    let runtime: string;

    beforeEach(async () => {
      daemons = new PostgresDaemonRepository(pool);
      runtimes = new PostgresRuntimeRepository(pool);
      const dId = daemonId();
      await daemons.create({
        id: dId,
        owner_person_id: person,
        external_id: "host-a",
        device_name: "Host A",
        token_hash: "h1",
      });
      runtime = runtimeId();
      await runtimes.create({ id: runtime, daemon_id: dId, cli: "claude" });
    });

    it("returns undefined when no pending session exists for the runtime", async () => {
      const claimed = await sessions.claimNextForRuntime(runtime);
      expect(claimed).toBeUndefined();
    });

    it("promotes the oldest pending session to running and returns it", async () => {
      const a = await sessions.create(
        newSession({
          id: sessionId(),
          task_id: task,
          runtime_id: runtime,
          status: "pending",
        }),
      );
      // Wait one tick so created_at differs.
      await new Promise((r) => setTimeout(r, 10));
      await sessions.create(
        newSession({
          id: sessionId(),
          task_id: task,
          runtime_id: runtime,
          status: "pending",
        }),
      );

      const claimed = await sessions.claimNextForRuntime(runtime);
      expect(claimed?.id).toBe(a.id);
      expect(claimed?.status).toBe("running");
      expect(claimed?.started_at).toBeInstanceOf(Date);
    });

    it("skips sessions already claimed (status='running')", async () => {
      await sessions.create(
        newSession({
          id: sessionId(),
          task_id: task,
          runtime_id: runtime,
          status: "running",
        }),
      );
      const claimed = await sessions.claimNextForRuntime(runtime);
      expect(claimed).toBeUndefined();
    });

    it("skips sessions bound to a different runtime", async () => {
      const otherRuntime = runtimeId();
      // Use a different daemon so the FK doesn't conflict.
      const otherDaemon = daemonId();
      await daemons.create({
        id: otherDaemon,
        owner_person_id: person,
        external_id: "host-b",
        device_name: "Host B",
        token_hash: "h2",
      });
      await runtimes.create({
        id: otherRuntime,
        daemon_id: otherDaemon,
        cli: "claude",
      });
      await sessions.create(
        newSession({
          id: sessionId(),
          task_id: task,
          runtime_id: otherRuntime,
          status: "pending",
        }),
      );
      const claimed = await sessions.claimNextForRuntime(runtime);
      expect(claimed).toBeUndefined();
    });

    it("two parallel claims race-safely return distinct sessions or undefined", async () => {
      const ids = [sessionId(), sessionId()];
      for (const id of ids) {
        await sessions.create(
          newSession({ id, task_id: task, runtime_id: runtime, status: "pending" }),
        );
      }
      const [a, b] = await Promise.all([
        sessions.claimNextForRuntime(runtime),
        sessions.claimNextForRuntime(runtime),
      ]);
      const claimedIds = [a?.id, b?.id].filter((x): x is string => Boolean(x)).sort();
      expect(claimedIds).toEqual(ids.slice().sort());
    });
  });

  describe("countOwnedByDaemon", () => {
    let daemons: PostgresDaemonRepository;
    let runtimes: PostgresRuntimeRepository;
    let dId: string;
    let rId: string;

    beforeEach(async () => {
      daemons = new PostgresDaemonRepository(pool);
      runtimes = new PostgresRuntimeRepository(pool);
      dId = daemonId();
      await daemons.create({
        id: dId,
        owner_person_id: person,
        external_id: "host",
        device_name: "Host",
        token_hash: "t",
      });
      rId = runtimeId();
      await runtimes.create({ id: rId, daemon_id: dId, cli: "claude" });
    });

    it("returns 0 for empty input without touching the DB", async () => {
      expect(await sessions.countOwnedByDaemon(dId, [])).toBe(0);
    });

    it("counts sessions whose runtime is owned by the daemon", async () => {
      const a = sessionId();
      const b = sessionId();
      await sessions.create(newSession({ id: a, runtime_id: rId, status: "running" }));
      await sessions.create(newSession({ id: b, runtime_id: rId, status: "running" }));
      expect(await sessions.countOwnedByDaemon(dId, [a, b])).toBe(2);
    });

    it("excludes sessions bound to other daemons' runtimes", async () => {
      const otherDaemon = daemonId();
      await daemons.create({
        id: otherDaemon,
        owner_person_id: person,
        external_id: "other",
        device_name: "Other",
        token_hash: "t2",
      });
      const otherRuntime = runtimeId();
      await runtimes.create({ id: otherRuntime, daemon_id: otherDaemon, cli: "claude" });

      const owned = sessionId();
      const stranger = sessionId();
      await sessions.create(newSession({ id: owned, runtime_id: rId, status: "running" }));
      await sessions.create(
        newSession({ id: stranger, runtime_id: otherRuntime, status: "running" }),
      );

      expect(await sessions.countOwnedByDaemon(dId, [owned, stranger])).toBe(1);
    });

    it("excludes sessions with no runtime_id", async () => {
      const s = sessionId();
      await sessions.create(newSession({ id: s, status: "running" }));
      expect(await sessions.countOwnedByDaemon(dId, [s])).toBe(0);
    });
  });
});
