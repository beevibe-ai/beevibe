/**
 * M6 end-to-end smoke for the api server + executor stack.
 *
 * Gated by `RUN_M6_E2E=1`. Requires `DATABASE_URL_TEST`, `OPENAI_API_KEY`,
 * `ANTHROPIC_API_KEY`, and `claude` on PATH.
 *
 *   RUN_M6_E2E=1 pnpm tsx scripts/m6-e2e.ts
 *
 * Boots both the api server and the executor in-process per scenario.
 * Spawned agent CLI subprocesses connect back to the in-process api via
 * its locally-bound HTTP port.
 *
 * Ten scenarios:
 *   1. bv_a_ task with update_progress
 *   2. review_policy gate + human revise
 *   3. bv_u_ chat: MCP-as-human (briefing + save_memory + DELETE)
 *   4. mesh negotiate happy path
 *   5. mesh capacity error
 *   6. full escalation flow with dual-resume
 *   7. postDispatch retry on missing update_progress
 *   8. in-flight task cancellation
 *   9. blocker → parent revise_task → resumed subordinate
 *  10. revision round-trip (verify agent acts on human feedback)
 */

import { config as loadEnv } from "dotenv";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../.env") });

import { bootstrap as bootstrapApi } from "../packages/api/src/bootstrap.js";
import type { BootstrapResult as ApiBootstrapResult } from "../packages/api/src/bootstrap.js";
import { bootstrap as bootstrapExecutor } from "../packages/executor/src/bootstrap.js";
import type { BootstrapResult as ExecutorBootstrapResult } from "../packages/executor/src/bootstrap.js";
import {
  agentId as makeAgentId,
  personId as makePersonId,
  taskId as makeTaskId,
} from "../packages/core/src/domain/ids.js";
import { DEFAULT_RUNTIME_CONFIG } from "../packages/core/src/domain/agent.js";
import {
  provisionAgent,
  provisionUser,
} from "../packages/core/src/auth/provision.js";
import { PostgresAgentRepository } from "../packages/core/src/adapters/postgres/agent-repo.js";
import { PostgresCoreMemoryRepository } from "../packages/core/src/adapters/postgres/core-memory-repo.js";
import { PostgresPersonRepository } from "../packages/core/src/adapters/postgres/person-repo.js";
import { PostgresSessionRepository } from "../packages/core/src/adapters/postgres/session-repo.js";
import { PostgresTaskRepository } from "../packages/core/src/adapters/postgres/task-repo.js";
import { createPool, type Pool } from "../packages/core/src/adapters/postgres/client.js";
import type { Agent } from "../packages/core/src/domain/agent.js";
import type { Session } from "../packages/core/src/domain/session.js";
import type { Task } from "../packages/core/src/domain/task.js";

// ───────────────────────── env / config ─────────────────────────

const REQUIRED_ENV = [
  "RUN_M6_E2E",
  "DATABASE_URL_TEST",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
] as const;

for (const k of REQUIRED_ENV) {
  if (!process.env[k]) {
    console.error(`✗ M6 E2E: missing env var ${k}`);
    process.exit(1);
  }
}

const TABLES = [
  "escalation",
  "negotiation_round",
  "negotiation",
  "memory_fact",
  "work_product",
  "core_memory_block",
  "session",
  "task",
  "agent",
  "person",
];

const TASK_TRANSITION_DEADLINE_MS = 15_000;
const SESSION_TERMINAL_DEADLINE_MS = 90_000;

// ───────────────────────── helpers ─────────────────────────

function log(msg: string): void {
  console.log(msg);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`    ✗ ${msg}`);
    process.exit(1);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function resetDb(pool: Pool): Promise<void> {
  await pool.query(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
}

/**
 * OS-assigned free port. The created server is closed before return so the
 * port is available for the api bootstrap. Tiny race window between close
 * and listen is acceptable for a test script.
 */
async function getFreePort(): Promise<number> {
  return new Promise((resolveP, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close((err) => (err ? reject(err) : resolveP(port)));
    });
  });
}

/**
 * Generic poll-with-deadline-and-predicate. Calls `fetch()` every 500ms
 * until either the predicate is true (returns the value) or the deadline
 * elapses (throws with `tag` for context). Used by all the wait* helpers
 * in this file — task status, latest session, escalation row, etc.
 */
async function pollUntil<T>(
  fetch: () => Promise<T | null | undefined>,
  pred: (v: T) => boolean,
  deadlineMs: number,
  tag: string,
): Promise<T> {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    const v = await fetch();
    if (v != null && pred(v)) return v;
    await sleep(500);
  }
  throw new Error(`pollUntil timed out: "${tag}" (deadline ${deadlineMs}ms)`);
}

const waitForTask = (
  tasks: PostgresTaskRepository,
  id: string,
  deadlineMs: number,
  pred: (t: Task) => boolean,
  tag: string,
): Promise<Task> =>
  pollUntil(() => tasks.findById(id), pred, deadlineMs, `task ${id}: ${tag}`);

const waitForSession = (
  sessions: PostgresSessionRepository,
  taskId: string,
  deadlineMs: number,
  pred: (s: Session) => boolean,
  tag: string,
): Promise<Session> =>
  pollUntil(
    () => sessions.findLatestForTask(taskId),
    pred,
    deadlineMs,
    `session for task ${taskId}: ${tag}`,
  );

// ───────────────────────── deps + boot ─────────────────────────

type Deps = {
  pool: Pool;
  persons: PostgresPersonRepository;
  agents: PostgresAgentRepository;
  coreMemoryRepo: PostgresCoreMemoryRepository;
  tasks: PostgresTaskRepository;
  sessions: PostgresSessionRepository;
  workspaceRoot: string;
};

interface Stack {
  api: ApiBootstrapResult;
  exec: ExecutorBootstrapResult;
  /** MCP endpoint URL (`http://localhost:PORT/mcp`). Used in agent mcp-config. */
  apiUrl: string;
  /** REST base URL (`http://localhost:PORT`). Used by human REST scenarios. */
  restUrl: string;
  shutdown: () => Promise<void>;
}

/**
 * Boot api + executor, return both. Api listens on an OS-assigned port; the
 * executor's `mcpServerUrl` is set to the api's actual listen URL so spawned
 * CLI subprocesses' `mcp-config.json` points at the in-process api.
 */
async function bootStack(
  deps: Deps,
  opts: { pollIntervalMs?: number } = {},
): Promise<Stack> {
  const port = await getFreePort();
  const restUrl = `http://localhost:${port}`;
  const apiUrl = `${restUrl}/mcp`;

  const api = await bootstrapApi({
    databaseUrl: process.env.DATABASE_URL_TEST!,
    mcpServerUrl: apiUrl,
    openaiApiKey: process.env.OPENAI_API_KEY!,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
    workspaceRoot: deps.workspaceRoot,
    port,
  });
  await api.server.start();

  const exec = await bootstrapExecutor({
    databaseUrl: process.env.DATABASE_URL_TEST!,
    mcpServerUrl: apiUrl,
    openaiApiKey: process.env.OPENAI_API_KEY!,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
    workspaceRoot: deps.workspaceRoot,
    pollIntervalMs: opts.pollIntervalMs ?? 2_000,
  });
  await exec.cancelListener.start();
  await exec.worker.start();

  const shutdown = async (): Promise<void> => {
    await exec.shutdown();
    await api.shutdown();
  };

  return { api, exec, apiUrl, restUrl, shutdown };
}

// ───────────────────────── seed helpers ─────────────────────────

async function seedAgent(
  deps: Deps,
  name: string,
  overrides: Partial<Pick<Agent, "hierarchy_level" | "review_policy" | "max_negotiation_rounds" | "max_mesh_sessions" | "parent_agent_id">> & {
    system_prompt_addition?: string;
    ownerId?: string;
  } = {},
): Promise<{ agent: Agent; apiKey: string; ownerId: string }> {
  let ownerId = overrides.ownerId;
  if (!ownerId) {
    const owner = await deps.persons.create({
      id: makePersonId(),
      name: `${name}-owner`,
    });
    ownerId = owner.id;
  }
  const { agent, apiKey } = await provisionAgent(
    { agentRepo: deps.agents, coreMemoryRepo: deps.coreMemoryRepo },
    {
      id: makeAgentId(),
      name,
      owner_id: ownerId,
      hierarchy_level: overrides.hierarchy_level ?? "ic",
      review_policy: overrides.review_policy,
      max_negotiation_rounds: overrides.max_negotiation_rounds,
      max_mesh_sessions: overrides.max_mesh_sessions,
      parent_agent_id: overrides.parent_agent_id,
      runtime_config: overrides.system_prompt_addition
        ? { ...DEFAULT_RUNTIME_CONFIG, system_prompt_addition: overrides.system_prompt_addition }
        : DEFAULT_RUNTIME_CONFIG,
    },
  );
  return { agent, apiKey, ownerId };
}

/**
 * Provision a human reviewer (person + bv_u_ key + team-level agent owned
 * by them). The team agent is required by `lookupApiKey` for bv_u_ →
 * ResolvedCaller resolution (IC agents are intentionally excluded as
 * runtime entry points; see findUserAgent).
 */
async function seedReviewer(
  deps: Deps,
  name: string,
): Promise<{ personId: string; apiKey: string; primaryAgent: Agent }> {
  const { person, apiKey } = await provisionUser(
    { personRepo: deps.persons },
    { id: makePersonId(), name },
  );
  const { agent: primaryAgent } = await provisionAgent(
    { agentRepo: deps.agents, coreMemoryRepo: deps.coreMemoryRepo },
    {
      id: makeAgentId(),
      name: `${name}-primary`,
      owner_id: person.id,
      hierarchy_level: "team",
      runtime_config: DEFAULT_RUNTIME_CONFIG,
    },
  );
  return { personId: person.id, apiKey, primaryAgent };
}

async function seedTask(
  deps: Deps,
  opts: {
    ownerId: string;
    agentId: string;
    title?: string;
    description?: string;
  },
): Promise<Task> {
  return deps.tasks.create({
    id: makeTaskId(),
    title: opts.title ?? "Reply with the single word 'ok'.",
    description: opts.description,
    priority: "medium",
    status: "assigned",
    assignee_id: opts.agentId,
    creator_id: opts.ownerId,
    creator_type: "person",
  });
}

// ───────────────────────── scenarios ─────────────────────────

type Scenario = (deps: Deps, stack: Stack) => Promise<void>;

/**
 * Wait between scenarios so any pending fire-and-forget post-dispatch
 * hooks from the previous scenario's last session complete (the hook
 * sleeps 2s before its first DB query). Without this drain, the next
 * scenario's `resetDb` would race those queries against the truncate.
 */
const INTER_SCENARIO_DRAIN_MS = 3_000;

async function scenario(
  name: string,
  fn: Scenario,
  deps: Deps,
  stack: Stack,
): Promise<void> {
  log(`\n═══ ${name} ═══`);
  const startedAt = Date.now();
  await resetDb(deps.pool);
  await fn(deps, stack);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  log(`  ✓ ${name}  (${elapsed}s)`);
  await sleep(INTER_SCENARIO_DRAIN_MS);
}

/**
 * Scenario 1 — bv_a_ task with update_progress flow.
 * The agent connects via MCP to our in-process api, calls update_progress
 * with status='done', and the executor + post-dispatch flow lets the task
 * settle in 'done'.
 */
const bvATaskHappyPath: Scenario = async (deps) => {
  const { agent, ownerId } = await seedAgent(deps, "happy-agent", {
    system_prompt_addition:
      "You are a beevibe test agent. The task envelope <task id=\"...\"> " +
      "tells you the task id. As soon as you start, call the " +
      "`update_progress` MCP tool with that task_id, status='done', and " +
      "summary='trivial-test-ok'. Then exit. Do no other work.",
  });
  const task = await seedTask(deps, { ownerId, agentId: agent.id });
  log(`  agent=${agent.id} task=${task.id}`);

  const session = await waitForSession(
    deps.sessions,
    task.id,
    SESSION_TERMINAL_DEADLINE_MS,
    (s) => s.status === "succeeded" || s.status === "failed",
    "session terminal",
  );
  assert(
    session.status === "succeeded",
    `session status=${session.status} error="${session.error}" exit=${session.exit_code} summary="${session.result_summary}"`,
  );
  log(`  session=${session.id} status=${session.status}`);

  const done = await waitForTask(
    deps.tasks,
    task.id,
    TASK_TRANSITION_DEADLINE_MS,
    (t) => t.status === "done",
    "task → done",
  );
  log(`  task=${done.id} status=${done.status} summary=${done.result_summary}`);
  assert(
    (done.result_summary?.length ?? 0) > 0,
    `result_summary not set after update_progress: "${done.result_summary}"`,
  );
};

/**
 * Scenario 7 — postDispatchCheck retry path.
 * Agent prompt forbids any MCP tool calls, so update_progress is never set
 * and post-dispatch fires the retry session. The retry agent uses the same
 * prompt so it ALSO skips update_progress; post-dispatch then marks the
 * task `failed` with the "two consecutive sessions" summary.
 */
const postDispatchRetry: Scenario = async (deps) => {
  const { agent, ownerId } = await seedAgent(deps, "no-progress-agent", {
    system_prompt_addition:
      "You are a beevibe test agent. CRITICAL: You must NOT call any MCP " +
      "tool. Do NOT call update_progress, save_memory, or anything else. " +
      "Just reply with the word 'idle' and stop. One reply, no tool calls.",
  });
  const task = await seedTask(deps, { ownerId, agentId: agent.id });
  log(`  agent=${agent.id} task=${task.id}`);

  const first = await waitForSession(
    deps.sessions,
    task.id,
    SESSION_TERMINAL_DEADLINE_MS,
    (s) => s.status === "succeeded" || s.status === "failed",
    "first session terminal",
  );
  log(`  first session=${first.id} status=${first.status}`);
  assert(first.status === "succeeded", `first.status=${first.status}`);

  const retry = await waitForSession(
    deps.sessions,
    task.id,
    SESSION_TERMINAL_DEADLINE_MS,
    (s) =>
      s.id !== first.id && (s.status === "succeeded" || s.status === "failed"),
    "retry session terminal",
  );
  log(`  retry session=${retry.id} prior=${retry.prior_session_id}`);

  assert(
    retry.prior_session_id === first.id,
    `retry.prior_session_id=${retry.prior_session_id} != first.id=${first.id}`,
  );
  assert(
    retry.intent.includes('<context type="nudge_completion">'),
    "retry intent missing nudge_completion marker",
  );
  assert(
    retry.intent.includes(`<task id="${task.id}"/>`),
    "retry intent missing self-closing task anchor",
  );

  const failed = await waitForTask(
    deps.tasks,
    task.id,
    TASK_TRANSITION_DEADLINE_MS,
    (t) => t.status === "failed",
    "task → failed (consecutive misses)",
  );
  log(`  task=${failed.id} status=${failed.status} summary="${failed.result_summary}"`);
  assert(
    failed.result_summary?.includes("Two consecutive sessions") ?? false,
    `result_summary missing 'Two consecutive sessions' marker: "${failed.result_summary}"`,
  );
};

/**
 * Scenario 2 — review_policy gate + human revise (intent verification).
 * Agent finishes via update_progress(done) → review_policy='require_human'
 * gate transitions task to 'review' (not 'done'). Human (test impersonation
 * via REST) calls POST /task/:id/revise with feedback. Worker re-claims;
 * the resumed session's intent contains <context type="revision"> + the
 * feedback. Stops there — scenario 10 verifies the agent acts on it.
 */
const reviewPolicyRevise: Scenario = async (deps, stack) => {
  const { agent, ownerId } = await seedAgent(deps, "review-agent", {
    review_policy: "require_human",
    system_prompt_addition:
      "You are a beevibe test agent. The <task id=\"...\"> envelope tells " +
      "you the task id. Reply 'v1' and immediately call update_progress " +
      "with that task_id, status='done', summary='v1 ready'. Then exit.",
  });
  // Provision a human reviewer to call POST /task/:id/revise.
  const reviewer = await seedReviewer(deps, "reviewer");
  const task = await seedTask(deps, { ownerId, agentId: agent.id });
  log(`  agent=${agent.id} task=${task.id} reviewer=${reviewer.personId}`);

  const first = await waitForSession(
    deps.sessions,
    task.id,
    SESSION_TERMINAL_DEADLINE_MS,
    (s) => s.status === "succeeded" || s.status === "failed",
    "first session terminal",
  );
  assert(first.status === "succeeded", `first.status=${first.status}`);
  log(`  first session=${first.id} cli=${first.cli_session_id}`);

  // review_policy gate: agent's update_progress(done) → task lands in
  // 'review' status (not 'done').
  const inReview = await waitForTask(
    deps.tasks,
    task.id,
    TASK_TRANSITION_DEADLINE_MS,
    (t) => t.status === "review",
    "task → review",
  );
  log(`  task in review: result_summary="${inReview.result_summary}"`);

  // Human reviewer revises via REST.
  const reviseResp = await fetch(`${stack.restUrl}/task/${task.id}/revise`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${reviewer.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      feedback: "Please add 'and please be polite' to your reply.",
    }),
  });
  if (!reviseResp.ok) {
    const errText = await reviseResp.text();
    throw new Error(`revise REST failed: ${reviseResp.status} ${errText}`);
  }
  const reviseBody = (await reviseResp.json()) as {
    ok: boolean;
    task: { id: string; status: string };
  };
  assert(
    reviseBody.task.status === "needs_revision",
    `revise response task.status=${reviseBody.task?.status}`,
  );

  const revised = await deps.tasks.findById(task.id);
  assert(
    revised?.next_dispatch_context?.kind === "revision",
    "next_dispatch_context not stamped with kind=revision",
  );
  assert(
    revised.next_dispatch_context.kind === "revision" &&
      revised.next_dispatch_context.feedback.includes("be polite"),
    "feedback not preserved in next_dispatch_context",
  );
  assert(
    revised.next_dispatch_context.kind === "revision" &&
      revised.next_dispatch_context.prior_session_id === first.id,
    "prior_session_id missing in next_dispatch_context",
  );

  // Worker re-claims (needs_revision → revision) and dispatches resumed.
  const second = await waitForSession(
    deps.sessions,
    task.id,
    SESSION_TERMINAL_DEADLINE_MS,
    (s) =>
      s.id !== first.id &&
      (s.status === "succeeded" || s.status === "failed"),
    "second (resumed) session terminal",
  );
  log(`  second session=${second.id} cli=${second.cli_session_id}`);
  assert(
    second.intent.includes('<context type="revision" source="human" from="review">'),
    "resumed intent missing revision context marker",
  );
  assert(
    second.intent.includes("be polite"),
    "resumed intent missing the human's feedback",
  );
  assert(
    second.cli_session_id === first.cli_session_id,
    `cli_session_id differs (resume should reuse): first=${first.cli_session_id} second=${second.cli_session_id}`,
  );
  assert(
    second.prior_session_id === first.id,
    `second.prior_session_id=${second.prior_session_id}`,
  );

  // Pre-empt this session's post-dispatch retry (we don't care what the
  // agent did this round; scenario 10 verifies feedback incorporation).
  await deps.tasks.update(task.id, {
    status: "done",
    result_summary: "scenario 2: feedback delivered; final state checked elsewhere",
  });
};

/**
 * Scenario 10 — full human-revision round-trip.
 * Like scenario 2, but verifies the resumed agent ACTUALLY processes the
 * feedback (proves the executor is feeding the comment to the agent in a
 * useful way). The first session says 'v1'; the human asks for 'v2'; the
 * resumed session's result_summary contains 'v2'.
 */
const revisionRoundTrip: Scenario = async (deps, stack) => {
  const { agent, ownerId } = await seedAgent(deps, "rt-agent", {
    review_policy: "require_human",
    system_prompt_addition:
      "You are a beevibe test agent. The <task id> envelope tells you the " +
      "task id. If you see a <context type=\"revision\"> block, READ THE " +
      "FEEDBACK and incorporate it into your reply. Otherwise, follow the " +
      "task normally. After your reply, call update_progress with status=" +
      "'done' and summary equal to your reply text exactly.",
  });
  const reviewer = await seedReviewer(deps, "rt-reviewer");
  const task = await seedTask(deps, {
    ownerId,
    agentId: agent.id,
    title: "Reply with the single token 'v1'.",
  });
  log(`  agent=${agent.id} task=${task.id}`);

  const first = await waitForSession(
    deps.sessions,
    task.id,
    SESSION_TERMINAL_DEADLINE_MS,
    (s) => s.status === "succeeded" || s.status === "failed",
    "first terminal",
  );
  assert(first.status === "succeeded", `first.status=${first.status}`);
  log(`  v1 result_summary="${first.result_summary}"`);

  await waitForTask(
    deps.tasks,
    task.id,
    TASK_TRANSITION_DEADLINE_MS,
    (t) => t.status === "review",
    "v1 → review",
  );

  const r = await fetch(`${stack.restUrl}/task/${task.id}/revise`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${reviewer.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      feedback: "Reply with the token 'v2' instead of 'v1'.",
    }),
  });
  assert(r.ok, `revise failed: ${r.status}`);

  const second = await waitForSession(
    deps.sessions,
    task.id,
    SESSION_TERMINAL_DEADLINE_MS,
    (s) =>
      s.id !== first.id &&
      (s.status === "succeeded" || s.status === "failed"),
    "v2 terminal",
  );
  assert(second.status === "succeeded", `second.status=${second.status}`);
  log(`  v2 result_summary="${second.result_summary}"`);

  assert(
    second.result_summary?.includes("v2") ?? false,
    `agent did not incorporate feedback — second.result_summary="${second.result_summary}"`,
  );

  await deps.tasks.update(task.id, {
    status: "done",
    result_summary: second.result_summary,
  });
};

/**
 * Scenario 8 — in-flight task cancellation (REST → pg_notify → executor).
 * Dispatch a long-running task; before it finishes, human cancels via REST.
 * Verify the cancel propagates within ~2s end-to-end and the task settles
 * in `cancelled` (terminal — not re-claimed by subsequent polls).
 */
const inFlightCancel: Scenario = async (deps, stack) => {
  const { agent, ownerId } = await seedAgent(deps, "cancel-agent", {
    system_prompt_addition:
      "You are a beevibe test agent. Use the Bash tool to run `sleep 30`. " +
      "Then call update_progress(done, summary='done after sleep').",
  });
  // Provision a human who can call POST /task/:id/cancel.
  const reviewer = await seedReviewer(deps, "canceller");
  const task = await seedTask(deps, {
    ownerId,
    agentId: agent.id,
    title: "Run a long bash command then update progress.",
  });
  log(`  agent=${agent.id} task=${task.id} canceller=${reviewer.personId}`);

  const running = await waitForSession(
    deps.sessions,
    task.id,
    30_000,
    (s) => s.status === "running" && s.process_pid != null,
    "session running with pid",
  );
  log(`  session=${running.id} pid=${running.process_pid}`);

  const cancelStart = Date.now();
  const cancelResp = await fetch(
    `${stack.restUrl}/task/${task.id}/cancel`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${reviewer.apiKey}` },
    },
  );
  const cancelMs = Date.now() - cancelStart;
  if (!cancelResp.ok) {
    const errText = await cancelResp.text();
    throw new Error(`cancel REST failed: ${cancelResp.status} ${errText}`);
  }
  const cancelBody = (await cancelResp.json()) as {
    ok: boolean;
    task_id: string;
  };
  log(`  cancel REST: ${cancelMs}ms, body.ok=${cancelBody.ok}`);
  assert(cancelBody.ok === true, `cancel response not ok: ${JSON.stringify(cancelBody)}`);
  assert(cancelMs < 1_000, `cancel REST too slow: ${cancelMs}ms`);

  const afterRest = await deps.tasks.findById(task.id);
  assert(
    afterRest?.status === "cancelled",
    `task.status after REST cancel=${afterRest?.status}`,
  );

  const cancelled = await waitForSession(
    deps.sessions,
    task.id,
    5_000,
    (s) => s.status === "cancelled" || s.status === "failed",
    "session cancelled",
  );
  log(`  session terminal: status=${cancelled.status} pid=${cancelled.process_pid}`);
  assert(
    cancelled.status === "cancelled",
    `expected session.status=cancelled, got ${cancelled.status}`,
  );

  if (cancelled.process_pid) {
    const { isProcessAlive } = await import("../packages/executor/src/worker.js");
    assert(
      !isProcessAlive(cancelled.process_pid),
      `CLI pid ${cancelled.process_pid} still alive after cancel`,
    );
  }

  const finalTask = await deps.tasks.findById(task.id);
  assert(
    finalTask?.status === "cancelled",
    `task.status drifted: ${finalTask?.status}`,
  );

  // Sanity-check no re-dispatch in the next 3s (poll is 2s).
  await sleep(3_000);
  const secondCheck = await deps.tasks.findById(task.id);
  assert(
    secondCheck?.status === "cancelled",
    `task re-claimed after cancel: ${secondCheck?.status}`,
  );
};

/**
 * Scenario 9 — blocker → parent revise_task → resumed subordinate.
 * IC agent I reports a blocker against parent T. T's session is auto-spawned
 * with a `<context type="blocker_report">` intent and calls `revise_task` to
 * unblock I. I's task transitions blocked → needs_revision; the resumed
 * session sees `<context type="revision" source="parent_agent" from="blocked">`
 * + the parent's feedback string. I then completes via update_progress.
 */
const blockerToReviseTask: Scenario = async (deps) => {
  // T (team-level parent) needs no review_policy. T's prompt: receive
  // blocker context, call revise_task with constructive feedback. I's
  // prompt: report a blocker, OR if resumed with a revision context,
  // process the feedback and complete via update_progress.
  const { agent: parentT, ownerId } = await seedAgent(deps, "parent-T", {
    hierarchy_level: "team",
    system_prompt_addition:
      "You are agent T, a parent agent. When you see a <mesh-blocker " +
      "from=\"...\" task_id=\"...\"> tag, IMMEDIATELY call the `revise_task` " +
      "MCP tool with that task_id and feedback='Use the existing helper " +
      "in src/util.ts — do not implement from scratch.'. Then exit. Do " +
      "NOT do any other work.",
  });
  const { agent: childI } = await seedAgent(deps, "child-I", {
    hierarchy_level: "ic",
    parent_agent_id: parentT.id,
    ownerId,
    system_prompt_addition:
      `You are agent I, a child of agent T (id=${parentT.id}). Your behavior depends ` +
      "on the task envelope you receive:\n" +
      "  - If the task envelope contains a <context type=\"revision\" " +
      "source=\"parent_agent\"> tag, your parent has unblocked you. Read " +
      "their feedback, acknowledge it, then call update_progress with " +
      "status='done' and summary='unblocked: ' + the feedback you received.\n" +
      "  - Otherwise (no revision context), you are stuck. Call the " +
      `\`report_blocker\` MCP tool with parent_agent_id='${parentT.id}', the ` +
      "task_id from the <task id> envelope, and description='I cannot " +
      "find the right helper to use here.'. Then exit. Do NOT call " +
      "update_progress in this case.",
  });
  const task = await seedTask(deps, {
    ownerId,
    agentId: childI.id,
    title: "Implement the foo helper.",
  });
  log(`  parent=${parentT.id} child=${childI.id} task=${task.id}`);

  // First session: I reports the blocker, exits without update_progress.
  const iFirst = await waitForSession(
    deps.sessions,
    task.id,
    SESSION_TERMINAL_DEADLINE_MS,
    (s) => s.status === "succeeded" || s.status === "failed",
    "I's first session terminal",
  );
  log(`  I first session=${iFirst.id} status=${iFirst.status}`);
  assert(iFirst.status === "succeeded", `iFirst.status=${iFirst.status}`);

  // I's task should be blocked with parent T as blocker_agent_id... wait no:
  // markBlocked sets blocker_agent_id = caller (I). The intent of the field
  // is "who is currently blocking the task" semantically; in this design
  // it's the agent whose session is blocking on resolution. For the e2e we
  // assert task is blocked + has a blocker_reason.
  const blocked = await waitForTask(
    deps.tasks,
    task.id,
    TASK_TRANSITION_DEADLINE_MS,
    (t) => t.status === "blocked",
    "I's task → blocked",
  );
  log(`  task blocked: blocker_reason="${blocked.blocker_reason}"`);
  assert(
    blocked.blocker_reason?.includes("right helper") ?? false,
    `blocker_reason missing: "${blocked.blocker_reason}"`,
  );

  // T's session was spawned async by mesh.reportBlocker. Its session has
  // type='blocker' and no task_id (mesh sessions don't have one). Wait for
  // it via the agent_id + recent created_at — easiest: query for sessions
  // by T's agent_id.
  const tSession = await waitForTSession(deps, parentT.id, iFirst.id);
  log(`  T's session=${tSession.id} status=${tSession.status}`);
  assert(tSession.status === "succeeded", `T's session status=${tSession.status}`);
  assert(
    tSession.intent.includes("<mesh-blocker"),
    `T's intent missing mesh-blocker tag: ${tSession.intent.slice(0, 200)}`,
  );

  // T's revise_task call should have transitioned I's task. Wait for it
  // (the revise_task happens via T's MCP tool call DURING T's session, so
  // it lands before T's session terminal).
  const revised = await waitForTask(
    deps.tasks,
    task.id,
    TASK_TRANSITION_DEADLINE_MS,
    (t) =>
      t.status === "needs_revision" ||
      t.status === "revision" ||
      t.status === "done",
    "task → needs_revision (after revise_task)",
  );
  if (revised.status !== "done") {
    assert(
      revised.next_dispatch_context?.kind === "revision",
      `next_dispatch_context kind=${revised.next_dispatch_context?.kind}`,
    );
    if (revised.next_dispatch_context?.kind === "revision") {
      assert(
        revised.next_dispatch_context.source === "parent_agent",
        `next_dispatch_context.source=${revised.next_dispatch_context.source}`,
      );
      assert(
        revised.next_dispatch_context.from_status === "blocked",
        `next_dispatch_context.from_status=${revised.next_dispatch_context.from_status}`,
      );
      assert(
        revised.next_dispatch_context.reviser_agent_id === parentT.id,
        `next_dispatch_context.reviser_agent_id=${revised.next_dispatch_context.reviser_agent_id}`,
      );
    }
  }

  // I's resumed session: dispatched by worker after needs_revision. The
  // resumed agent should incorporate the feedback and complete.
  const iSecond = await waitForSession(
    deps.sessions,
    task.id,
    SESSION_TERMINAL_DEADLINE_MS,
    (s) =>
      s.id !== iFirst.id &&
      (s.status === "succeeded" || s.status === "failed"),
    "I's resumed session terminal",
  );
  log(`  I resumed session=${iSecond.id} status=${iSecond.status}`);
  assert(iSecond.status === "succeeded", `iSecond.status=${iSecond.status}`);
  assert(
    iSecond.intent.includes('<context type="revision" source="parent_agent" from="blocked">'),
    "I's resumed intent missing parent-agent revision context marker",
  );
  assert(
    iSecond.intent.includes("Use the existing helper"),
    "I's resumed intent missing parent's feedback string",
  );

  // The resumed agent should have called update_progress(done) — task = done.
  const done = await waitForTask(
    deps.tasks,
    task.id,
    TASK_TRANSITION_DEADLINE_MS,
    (t) => t.status === "done",
    "I's task → done after revision",
  );
  log(`  task done: result_summary="${done.result_summary}"`);
  assert(
    done.result_summary?.toLowerCase().includes("unblocked") ?? false,
    `result_summary missing 'unblocked' marker: "${done.result_summary}"`,
  );
};

/**
 * Find T's blocker session — there's no task_id, so we look it up by
 * agent_id + created_at after the trigger session's terminal.
 */
async function waitForTSession(
  deps: Deps,
  parentAgentId: string,
  triggerSessionId: string,
): Promise<Session> {
  return pollUntil(
    async () => {
      const { rows } = await deps.pool.query<{ id: string }>(
        `SELECT id FROM session
          WHERE agent_id = $1
            AND type = 'blocker'
            AND id != $2
            AND status IN ('succeeded', 'failed')
          ORDER BY created_at DESC LIMIT 1`,
        [parentAgentId, triggerSessionId],
      );
      if (!rows[0]) return null;
      return deps.sessions.findById(rows[0].id);
    },
    () => true,
    SESSION_TERMINAL_DEADLINE_MS,
    `T's blocker session terminal (parent=${parentAgentId})`,
  );
}

/**
 * Scenario 5 — mesh capacity error.
 * Agent B has max_mesh_sessions=1 and a pre-seeded running mesh session
 * (synthesized via direct DB INSERT). Agent A tries to negotiate with B;
 * the mesh server's capacity check fails fast with mesh_capacity_exceeded
 * before B's CLI is spawned.
 */
const meshCapacityError: Scenario = async (deps) => {
  // A — initiator. Prompt: call negotiate(B, ...). Single attempt, then exit.
  // B — target with cap=1, already at 1 (synthetic running mesh session).
  const { agent: agentA, ownerId } = await seedAgent(deps, "mesh-A", {
    hierarchy_level: "team",
  });
  const { agent: agentB } = await seedAgent(deps, "mesh-B", {
    hierarchy_level: "team",
    max_mesh_sessions: 1,
    ownerId,
  });
  // Tell A: call negotiate(B, ...) directly. The capacity check throws
  // before B's session even spawns; A's tool result will contain
  // error: 'MESH_CAPACITY_EXCEEDED'.
  const { agent: agentARun } = await seedAgent(deps, "mesh-A-runner", {
    hierarchy_level: "team",
    ownerId,
    system_prompt_addition:
      `You are agent A. Call the \`negotiate\` MCP tool with peer_id='${agentB.id}', ` +
      "proposal='let's collaborate on X'. Read the response — if it has " +
      "error='MESH_CAPACITY_EXCEEDED', call update_progress with " +
      "status='done' and summary='capacity error received: ' + the error " +
      "code. If the call succeeds (no error), call update_progress with " +
      "status='failed' and summary='unexpected success'. Either way, exit.",
  });
  void agentA; // unused — keep the seed for hierarchy validation
  void agentARun;

  // Pre-seed B at cap: insert a session row with type='mesh_negotiate' and
  // status='running' for B. mesh capacity check counts these.
  await deps.pool.query(
    `INSERT INTO session (id, agent_id, type, status, intent, started_at)
     VALUES ($1, $2, 'mesh_negotiate', 'running', 'pre-seed: capacity test', NOW())`,
    [`sess_preseed_${Date.now()}`, agentB.id],
  );

  // Dispatch a task to A's runner.
  const task = await seedTask(deps, {
    ownerId,
    agentId: agentARun.id,
    title: "Negotiate with mesh-B (will hit capacity).",
  });
  log(`  A=${agentARun.id} B=${agentB.id} task=${task.id}`);

  const session = await waitForSession(
    deps.sessions,
    task.id,
    SESSION_TERMINAL_DEADLINE_MS,
    (s) => s.status === "succeeded" || s.status === "failed",
    "A's session terminal",
  );
  log(`  A's session=${session.id} status=${session.status}`);
  assert(session.status === "succeeded", `A's session.status=${session.status}`);

  // Wait for the task to settle (post-dispatch may still be running).
  const finalTask = await waitForTask(
    deps.tasks,
    task.id,
    TASK_TRANSITION_DEADLINE_MS,
    (t) => t.status === "done" || t.status === "failed",
    "task terminal",
  );
  log(`  task=${finalTask.id} status=${finalTask.status} summary="${finalTask.result_summary}"`);
  assert(
    finalTask.status === "done",
    `task.status=${finalTask.status} (agent should have called update_progress(done))`,
  );
  assert(
    (finalTask.result_summary?.includes("MESH_CAPACITY_EXCEEDED") ||
      finalTask.result_summary?.toLowerCase().includes("capacity")) ?? false,
    `result_summary missing capacity-error marker: "${finalTask.result_summary}"`,
  );

  // Verify NO B session was spawned (capacity check happens BEFORE spawn).
  // Only the pre-seeded one and any other unrelated sessions for B exist.
  const bSessions = await deps.pool.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM session
      WHERE agent_id = $1 AND type = 'mesh_negotiate' AND intent NOT LIKE 'pre-seed%'`,
    [agentB.id],
  );
  assert(
    Number(bSessions.rows[0]?.count ?? 0) === 0,
    `expected no real negotiate session spawned for B, got ${bSessions.rows[0]?.count}`,
  );
};

/**
 * Scenario 3 — bv_u_ chat (MCP-as-human).
 * Connect to /mcp with a user's bv_u_ token; verify the initialize handshake
 * returns the full briefing in `instructions` and assigns a Mcp-Session-Id;
 * call save_memory and verify the fact is written with the auto-cached
 * beevibe sid in source_session_ids; close the transport and verify the
 * session row reaches `succeeded`.
 */
const bvUChat: Scenario = async (deps, stack) => {
  const reviewer = await seedReviewer(deps, "alice-chat");
  log(`  user=${reviewer.personId} primaryAgent=${reviewer.primaryAgent.id}`);

  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  );

  const transport = new StreamableHTTPClientTransport(new URL(stack.apiUrl), {
    requestInit: { headers: { Authorization: `Bearer ${reviewer.apiKey}` } },
  });
  const client = new Client(
    { name: "m6-e2e-client", version: "0.0.0" },
    { capabilities: {} },
  );

  await client.connect(transport);

  // Verify briefing in instructions.
  const instructions = client.getInstructions();
  assert(
    typeof instructions === "string" && instructions.includes("<core_memory>"),
    `instructions missing <core_memory>: ${instructions?.slice(0, 80)}`,
  );
  assert(
    instructions.includes("<archival_memory>"),
    `instructions missing <archival_memory>`,
  );

  // Verify Mcp-Session-Id was assigned.
  const mcpSid = transport.sessionId;
  assert(typeof mcpSid === "string" && mcpSid.length > 0, "Mcp-Session-Id missing");
  log(`  mcp-sid=${mcpSid}`);

  // Verify the cache mapped mcpSid → a beevibe session id.
  const beevibeSid = stack.api.sessionCache.get(mcpSid);
  assert(typeof beevibeSid === "string" && beevibeSid.length > 0, "session cache miss");

  // Call save_memory.
  const result = await client.callTool({
    name: "save_memory",
    arguments: {
      content: "I really love the color green.",
      fact_type: "preference",
    },
  });
  assert(!result.isError, `save_memory returned error: ${JSON.stringify(result)}`);

  // Verify the fact landed with the right source_session_id.
  const factsRow = await deps.pool.query<{
    id: string;
    content: string;
    source_session_ids: string[];
  }>(
    `SELECT id, content, source_session_ids FROM memory_fact
      WHERE agent_id = $1`,
    [reviewer.primaryAgent.id],
  );
  assert(factsRow.rows.length === 1, `expected 1 fact, got ${factsRow.rows.length}`);
  const fact = factsRow.rows[0]!;
  assert(fact.content.includes("green"), `fact content: ${fact.content}`);
  assert(
    fact.source_session_ids.includes(beevibeSid),
    `fact.source_session_ids ${JSON.stringify(fact.source_session_ids)} missing beevibeSid=${beevibeSid}`,
  );

  // Explicitly DELETE /mcp — the SDK transport.close() doesn't always send
  // DELETE; we fire it manually to verify the session-termination path. The
  // server should: evict the cache entry → sessionRepo.update(beevibeSid,
  // status='succeeded') → fire onEvict (memory promotion via MemoryAgent).
  const delResp = await fetch(stack.apiUrl, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${reviewer.apiKey}`,
      "Mcp-Session-Id": mcpSid,
    },
  });
  assert(delResp.ok, `DELETE /mcp returned ${delResp.status}`);
  await transport.close();

  // Wait for the session row to reach terminal.
  const end = Date.now() + 5_000;
  let chatSession: Session | undefined;
  while (Date.now() < end) {
    chatSession = await deps.sessions.findById(beevibeSid);
    if (chatSession?.status === "succeeded") break;
    await sleep(200);
  }
  assert(
    chatSession?.status === "succeeded",
    `chat session status=${chatSession?.status}`,
  );
  log(`  chat session=${chatSession.id} status=${chatSession.status}`);
};

/**
 * Scenario 4 — mesh negotiate happy path (round 1, accept).
 * Team agent A's task prompts it to call negotiate(B, ...). Server spawns
 * B; B's prompt extracts negotiation_id from the mesh-negotiate envelope
 * and replies with respond_negotiate(decision='accept'). A unblocks, sees
 * the accepted decision, completes via update_progress.
 */
const meshNegotiateHappy: Scenario = async (deps) => {
  const { agent: agentA, ownerId } = await seedAgent(deps, "neg-A", {
    hierarchy_level: "team",
    system_prompt_addition:
      "You are agent A. The task envelope tells you the task id. Call the " +
      "`negotiate` MCP tool with peer_id=$PEER_ID and proposal='Let us " +
      "split the work 50/50.'. Wait for the response. The response object " +
      "has a `decision` field (counter/accept/reject). After receiving " +
      "the response, call update_progress with status='done' and " +
      "summary='negotiation_decision=' + decision. Then exit.",
  });
  const { agent: agentB } = await seedAgent(deps, "neg-B", {
    hierarchy_level: "team",
    ownerId,
    system_prompt_addition:
      "You are agent B. Your stdin will contain a <mesh-negotiate " +
      "negotiation_id=\"...\" ...> envelope with a proposal. Extract the " +
      "negotiation_id from the tag attribute. Then call the " +
      "`respond_negotiate` MCP tool with negotiation_id=THAT, " +
      "decision='accept', message='agreed'. Then exit. Do NOT counter or " +
      "reject — always accept.",
  });

  // A's prompt has a placeholder $PEER_ID — patch the agent row's
  // system_prompt_addition to replace it now that we know B's id.
  await deps.agents.update(agentA.id, {
    runtime_config: {
      ...agentA.runtime_config,
      system_prompt_addition: agentA.runtime_config.system_prompt_addition!.replace(
        "$PEER_ID",
        agentB.id,
      ),
    },
  });

  const task = await seedTask(deps, {
    ownerId,
    agentId: agentA.id,
    title: "Negotiate work split with neg-B.",
  });
  log(`  A=${agentA.id} B=${agentB.id} task=${task.id}`);

  // A's session terminates when negotiate returns.
  const aSession = await waitForSession(
    deps.sessions,
    task.id,
    SESSION_TERMINAL_DEADLINE_MS,
    (s) => s.status === "succeeded" || s.status === "failed",
    "A's session terminal",
  );
  log(`  A's session=${aSession.id} status=${aSession.status}`);
  assert(aSession.status === "succeeded", `A.status=${aSession.status}`);

  const finalTask = await waitForTask(
    deps.tasks,
    task.id,
    TASK_TRANSITION_DEADLINE_MS,
    (t) => t.status === "done" || t.status === "failed",
    "task terminal",
  );
  assert(
    finalTask.status === "done",
    `task.status=${finalTask.status}, summary="${finalTask.result_summary}"`,
  );
  log(`  task=${finalTask.id} done; result_summary="${finalTask.result_summary}"`);
  assert(
    finalTask.result_summary?.includes("accept") ?? false,
    `result_summary should mention accept: "${finalTask.result_summary}"`,
  );

  // Verify negotiation row + 2 rounds (round 1 = A's propose, round 2 =
  // B's accept). MeshServer + EscalationService unit tests cover the
  // tighter invariants; here we sanity-check the row is shaped correctly.
  const negs = await deps.pool.query<{ id: string; status: string }>(
    `SELECT id, status FROM negotiation
       WHERE initiator_agent_id = $1 AND counterparty_agent_id = $2`,
    [agentA.id, agentB.id],
  );
  assert(negs.rows.length === 1, `expected 1 negotiation, got ${negs.rows.length}`);
  assert(
    negs.rows[0]!.status === "accepted",
    `negotiation.status=${negs.rows[0]!.status}`,
  );
  const rounds = await deps.pool.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM negotiation_round WHERE negotiation_id = $1`,
    [negs.rows[0]!.id],
  );
  assert(
    Number(rounds.rows[0]?.count ?? 0) >= 2,
    `expected >=2 rounds, got ${rounds.rows[0]?.count}`,
  );
};

/**
 * Scenario 6 — full escalation flow with dual-resume.
 *
 *   max_negotiation_rounds = 1 (one full A↔B exchange allowed).
 *
 *   Round 1: A propose      (row 1, exchange 1 in progress)
 *            B counter      (row 2, exchange 1 complete)
 *   Round 2: A counter      → server: ceil(3/2)=2 > 1 → MAX_ROUNDS_EXCEEDED
 *            A escalates.
 *
 * A is the escalator (initiator always starts new exchanges, so A always
 * hits the cap). B receives the EscalatedSentinel via its blocked
 * respond_negotiate and contributes via add_to_escalation. After human
 * resolution, both agents resume with `<context type="post_escalation">`
 * intents and complete via update_progress.
 */
const fullEscalation: Scenario = async (deps, stack) => {
  const { agent: agentA, ownerId } = await seedAgent(deps, "esc-A", {
    hierarchy_level: "team",
    max_negotiation_rounds: 1,
    system_prompt_addition:
      "You are agent A. Two modes:\n" +
      "(1) If your stdin contains <context type=\"post_escalation\">, this is " +
      "a resumed session after human resolution. Read the resolution and " +
      "call update_progress with task_id from <task id>, status='done', " +
      "summary='post_escalation_acknowledged'. Then exit.\n" +
      "(2) Otherwise, fresh negotiation: read task_id from <task id>. " +
      "Call negotiate with peer_id=$PEER_B, proposal='Adopt approach X', " +
      "task_id=THAT_task_id. Inspect the response:\n" +
      "  - If decision='counter': call respond_negotiate with " +
      "negotiation_id from response, decision='counter', " +
      "counter_proposal='Insist on X', message='I disagree, X is better'. " +
      "If THAT call returns an error with code='MAX_ROUNDS_EXCEEDED' " +
      "(or any error mentioning max_rounds), call escalate_to_humans " +
      "with negotiation_id, summary='Stuck on approach X vs Y', " +
      "proposals=[{title:'A way',description:'Adopt X'}], " +
      "open_questions=['Which approach is faster?']. Then exit.\n" +
      "  - If decision='accept' or 'reject': call update_progress(done, " +
      "summary='neg_decision='+decision). Exit.",
  });
  const { agent: agentB } = await seedAgent(deps, "esc-B", {
    hierarchy_level: "team",
    ownerId,
    system_prompt_addition:
      "You are agent B. Two modes:\n" +
      "(1) If your stdin contains <context type=\"post_escalation\">: read " +
      "the resolution, then call update_progress with task_id from " +
      "<task id>, status='done', summary='post_escalation_acknowledged'. Exit.\n" +
      "(2) Otherwise, mesh-spawned (stdin has <mesh-negotiate " +
      "negotiation_id=...> envelope): extract negotiation_id from the " +
      "envelope. Call respond_negotiate with negotiation_id, " +
      "decision='counter', counter_proposal='Adopt approach Y', " +
      "message='I disagree, Y is better'. Inspect the response:\n" +
      "  - If decision='escalated': extract escalation_id. Call " +
      "add_to_escalation with escalation_id, " +
      "proposals=[{title:'B way',description:'Adopt Y'}], " +
      "open_questions=['Is Y reversible?']. Exit.\n" +
      "  - If decision='counter' or 'accept' or 'reject': just exit.",
  });
  // Patch A's prompt now that we know B's id.
  await deps.agents.update(agentA.id, {
    runtime_config: {
      ...agentA.runtime_config,
      system_prompt_addition: agentA.runtime_config.system_prompt_addition!.replace(
        "$PEER_B",
        agentB.id,
      ),
    },
  });

  const reviewer = await seedReviewer(deps, "esc-reviewer");
  const task = await seedTask(deps, {
    ownerId,
    agentId: agentA.id,
    title: "Decide approach for X with esc-B.",
  });
  log(`  A=${agentA.id} B=${agentB.id} task=${task.id} reviewer=${reviewer.personId}`);

  // Phase 1: wait for both A's and B's primary sessions to terminate.
  // Each terminates after its escalate_to_humans / add_to_escalation call.
  const aPrimary = await waitForSession(
    deps.sessions,
    task.id,
    SESSION_TERMINAL_DEADLINE_MS,
    (s) => s.status === "succeeded" || s.status === "failed",
    "A's primary session terminal",
  );
  log(`  A primary=${aPrimary.id} status=${aPrimary.status}`);
  assert(aPrimary.status === "succeeded", `A primary status=${aPrimary.status}`);

  // Verify the escalation row exists.
  const escRow = await waitForEscalationRow(deps, task.id);
  log(`  escalation=${escRow.id} status=${escRow.status} escalated_by=${escRow.escalated_by_role}`);
  assert(
    escRow.status === "pending",
    `escalation.status=${escRow.status} (expected pending)`,
  );
  assert(
    escRow.escalated_by_role === "initiator",
    `escalated_by_role=${escRow.escalated_by_role} (expected initiator — A escalates first under the user-facing round model)`,
  );

  // B's primary session: mesh-spawned, no task_id. Find it via agent_id.
  const bPrimary = await waitForBPrimary(deps, agentB.id);
  log(`  B primary=${bPrimary.id} status=${bPrimary.status}`);
  assert(bPrimary.status === "succeeded", `B primary status=${bPrimary.status}`);

  // Both contributions on the escalation row should be populated.
  const escFull = await deps.pool.query<{
    initiator_proposals: unknown;
    counterparty_proposals: unknown;
  }>(`SELECT initiator_proposals, counterparty_proposals FROM escalation WHERE id = $1`, [
    escRow.id,
  ]);
  assert(
    escFull.rows[0]?.initiator_proposals != null,
    "initiator_proposals not populated on escalation",
  );
  assert(
    escFull.rows[0]?.counterparty_proposals != null,
    "counterparty_proposals not populated on escalation (B's add_to_escalation didn't land)",
  );

  // Negotiation row should be 'escalated'; task should be 'blocked'.
  const negCheck = await deps.pool.query<{ status: string }>(
    `SELECT status FROM negotiation WHERE id = $1`,
    [escRow.negotiation_id],
  );
  assert(
    negCheck.rows[0]?.status === "escalated",
    `negotiation.status=${negCheck.rows[0]?.status}`,
  );
  const blockedTask = await deps.tasks.findById(task.id);
  assert(
    blockedTask?.status === "blocked",
    `task.status before resolve=${blockedTask?.status}`,
  );

  // Phase 2: human resolves via REST. Pick A's first proposal.
  const resolveResp = await fetch(
    `${stack.restUrl}/escalation/${escRow.id}/resolve`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${reviewer.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source: "initiator",
        source_index: 0,
        resolution_notes: "Go with approach X — phased rollout.",
      }),
    },
  );
  if (!resolveResp.ok) {
    const errText = await resolveResp.text();
    throw new Error(`resolve REST failed: ${resolveResp.status} ${errText}`);
  }
  const resolveBody = (await resolveResp.json()) as {
    ok: boolean;
    a_task_id: string;
    b_task_id: string;
  };
  log(`  resolved: A_task=${resolveBody.a_task_id} B_task=${resolveBody.b_task_id}`);
  assert(resolveBody.ok === true, `resolve response not ok`);
  assert(resolveBody.a_task_id === task.id, `a_task_id mismatch`);
  assert(typeof resolveBody.b_task_id === "string" && resolveBody.b_task_id.length > 0, `b_task_id missing`);

  // Verify A's task was re-queued with post_escalation context.
  const aTaskQueued = await deps.tasks.findById(task.id);
  assert(
    aTaskQueued?.status === "assigned",
    `A's task.status after resolve=${aTaskQueued?.status}`,
  );
  assert(
    aTaskQueued?.next_dispatch_context?.kind === "post_escalation",
    `A's next_dispatch_context.kind=${aTaskQueued?.next_dispatch_context?.kind}`,
  );
  if (aTaskQueued.next_dispatch_context?.kind === "post_escalation") {
    assert(
      aTaskQueued.next_dispatch_context.role === "initiator",
      `A's role=${aTaskQueued.next_dispatch_context.role}`,
    );
  }

  // Verify B has a synthetic task with post_escalation counterparty.
  const bSyntheticTask = await deps.tasks.findById(resolveBody.b_task_id);
  assert(bSyntheticTask, "B's synthetic task missing");
  assert(
    bSyntheticTask.assignee_id === agentB.id,
    `B's task assignee=${bSyntheticTask.assignee_id}`,
  );
  assert(
    bSyntheticTask.next_dispatch_context?.kind === "post_escalation",
    `B's next_dispatch_context.kind=${bSyntheticTask.next_dispatch_context?.kind}`,
  );
  if (bSyntheticTask.next_dispatch_context?.kind === "post_escalation") {
    assert(
      bSyntheticTask.next_dispatch_context.role === "counterparty",
      `B's role=${bSyntheticTask.next_dispatch_context.role}`,
    );
  }

  // Phase 3: wait for executor to dispatch resumed sessions for both A and B.
  const aResumed = await waitForSession(
    deps.sessions,
    task.id,
    SESSION_TERMINAL_DEADLINE_MS,
    (s) =>
      s.id !== aPrimary.id &&
      (s.status === "succeeded" || s.status === "failed"),
    "A's resumed (post_escalation) session terminal",
  );
  log(`  A resumed=${aResumed.id} status=${aResumed.status}`);
  assert(aResumed.status === "succeeded", `A resumed status=${aResumed.status}`);
  assert(
    aResumed.intent.includes('<context type="post_escalation" role="initiator">'),
    "A's resumed intent missing post_escalation initiator context",
  );

  const bResumed = await waitForSession(
    deps.sessions,
    resolveBody.b_task_id,
    SESSION_TERMINAL_DEADLINE_MS,
    (s) => s.status === "succeeded" || s.status === "failed",
    "B's resumed (post_escalation) session terminal",
  );
  log(`  B resumed=${bResumed.id} status=${bResumed.status}`);
  assert(bResumed.status === "succeeded", `B resumed status=${bResumed.status}`);
  assert(
    bResumed.intent.includes('<context type="post_escalation" role="counterparty">'),
    "B's resumed intent missing post_escalation counterparty context",
  );

  // Both tasks eventually reach 'done' via update_progress.
  const aDone = await waitForTask(
    deps.tasks,
    task.id,
    TASK_TRANSITION_DEADLINE_MS,
    (t) => t.status === "done",
    "A's task → done",
  );
  log(`  A's task done; result_summary="${aDone.result_summary}"`);
  const bDone = await waitForTask(
    deps.tasks,
    resolveBody.b_task_id,
    TASK_TRANSITION_DEADLINE_MS,
    (t) => t.status === "done",
    "B's task → done",
  );
  log(`  B's task done; result_summary="${bDone.result_summary}"`);
};

interface EscalationRow {
  id: string;
  negotiation_id: string;
  status: string;
  escalated_by_role: string;
}

function waitForEscalationRow(deps: Deps, taskId: string): Promise<EscalationRow> {
  return pollUntil(
    async () => {
      const { rows } = await deps.pool.query<EscalationRow>(
        `SELECT e.id, e.negotiation_id, e.status, e.escalated_by_role
           FROM escalation e
           JOIN negotiation n ON n.id = e.negotiation_id
          WHERE n.task_id = $1
          ORDER BY e.created_at DESC LIMIT 1`,
        [taskId],
      );
      return rows[0];
    },
    () => true,
    SESSION_TERMINAL_DEADLINE_MS,
    `escalation row for task ${taskId}`,
  );
}

function waitForBPrimary(deps: Deps, agentBId: string): Promise<Session> {
  return pollUntil(
    async () => {
      const { rows } = await deps.pool.query<{ id: string }>(
        `SELECT id FROM session
          WHERE agent_id = $1
            AND type = 'mesh_negotiate'
            AND status IN ('succeeded', 'failed')
          ORDER BY created_at DESC LIMIT 1`,
        [agentBId],
      );
      if (!rows[0]) return null;
      return deps.sessions.findById(rows[0].id);
    },
    () => true,
    SESSION_TERMINAL_DEADLINE_MS,
    `B's primary mesh_negotiate session terminal (B=${agentBId})`,
  );
}

// ───────────────────────── main ─────────────────────────

async function main(): Promise<void> {
  const workspaceRoot = mkdtempSync(`${tmpdir()}/beevibe-m6-e2e-`);
  const pool = createPool({ connectionString: process.env.DATABASE_URL_TEST });
  const deps: Deps = {
    pool,
    persons: new PostgresPersonRepository(pool),
    agents: new PostgresAgentRepository(pool),
    coreMemoryRepo: new PostgresCoreMemoryRepository(pool),
    tasks: new PostgresTaskRepository(pool),
    sessions: new PostgresSessionRepository(pool),
    workspaceRoot,
  };

  // One stack for the whole run. resetDb between scenarios + a 3s drain
  // window keeps in-memory state (mesh resolvers, session cache) cheaply
  // fresh — stale entries reference truncated rows, but each scenario
  // creates new ids so collisions don't happen.
  const stack = await bootStack(deps);

  const overall = Date.now();
  try {
    await scenario("1. bv_a_ task with update_progress", bvATaskHappyPath, deps, stack);
    await scenario("7. postDispatch retry on missing update_progress", postDispatchRetry, deps, stack);
    await scenario("2. review_policy gate + human revise", reviewPolicyRevise, deps, stack);
    await scenario("10. revision round-trip (agent acts on feedback)", revisionRoundTrip, deps, stack);
    await scenario("8. in-flight task cancellation", inFlightCancel, deps, stack);
    await scenario("9. blocker → parent revise_task → resumed subordinate", blockerToReviseTask, deps, stack);
    await scenario("5. mesh capacity error", meshCapacityError, deps, stack);
    await scenario("3. bv_u_ chat (MCP-as-human)", bvUChat, deps, stack);
    await scenario("4. mesh negotiate happy path (round 1, accept)", meshNegotiateHappy, deps, stack);
    await scenario("6. full escalation flow with dual-resume", fullEscalation, deps, stack);
  } finally {
    await stack.shutdown();
    rmSync(workspaceRoot, { recursive: true, force: true });
    await pool.end();
  }
  const totalSec = ((Date.now() - overall) / 1000).toFixed(1);
  log(`\n✓ M6 E2E complete (${totalSec}s)`);
}

main().catch((err: unknown) => {
  console.error("\n✗ M6 E2E failed:", err);
  process.exit(1);
});
