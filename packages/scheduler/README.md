# @beevibe/executor

The long-running worker. Polls Postgres for assigned tasks, provisions agent workspaces, and dispatches `claude` CLI sessions for each one. Stateless — restart at any time.

It only depends on `@beevibe/core`. It never talks to [`@beevibe/api`](../api) over HTTP — both processes use the database as the integration point.

If you're running beevibe locally, `pnpm dev` at the repo root brings this up alongside the api server. For full setup, see the [root README](../../README.md).

## What it does, per cycle

Default cadence: **every 30 seconds** (override via `POLL_INTERVAL_MS`).

1. **Reap orphans.** Any session whose CLI process has died (`isProcessAlive(pid)`) is marked `failed` and its task is re-queued.
2. **Dispatch ready tasks.** For each assignable task:
   - Check the agent's per-agent capacity (`agent.max_task_sessions`, default 1).
   - Atomically claim via `TaskRepository.claimById` (race-safe across multiple executor replicas).
   - Provision the workspace (`LocalWorkspaceManager.ensureWorkspace`). This also syncs the agent's tier-filtered `SKILL.md` files into `<workspace>/.claude/skills/`.
   - Hand off to the dispatcher: `AgentSession.run(...)` from `@beevibe/core`. Fire-and-forget, tracked by an `AbortController`.

The dispatcher figures out the right session shape from `task.next_dispatch_context` (set by api on revisions / escalation resolutions) — fresh, crash-recovery, post-escalation, or revision.

## Cancellation

The api's `POST /task/:id/cancel` writes the DB row and fires a Postgres `NOTIFY cancel_task <task_id>`. A dedicated `pg.Client` in the executor (`src/cancel-listener.ts`) is `LISTEN`ing on that channel and aborts the in-flight session's `AbortController`. The CLI subprocess gets `SIGTERM`. End-to-end latency is sub-200ms.

If the executor is down when the NOTIFY fires, the notification is lost — but the task's `cancelled` status is durable, so the next worker boot won't dispatch it. No reliable delivery is needed.

## Post-dispatch hook

After every session, an `onSessionComplete` hook runs:

- If the agent forgot to call `update_progress`, retry the task once with a `<context type="nudge_completion">` nudge intent. Fail it on the second silent exit.
- If all of a parent task's children have settled, roll the parent up via `TaskService.checkAndCompleteParent`.

It's a safety net for agents that exit without setting their task's terminal status. The system-prompt lifecycle reminder injected by `AgentSession` covers most cases proactively; this hook is the catch-all when the LLM still slips.

## Run it

```bash
pnpm --filter @beevibe/executor build
pnpm --filter @beevibe/executor start            # node dist/main.js
# or watch mode:
pnpm --filter @beevibe/executor dev
```

Required env (validated at startup):

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `BEEVIBE_MCP_SERVER_URL` | The URL spawned agents will call back to. Baked into each agent's `mcp-config.json`. |
| `OPENAI_API_KEY` | Embeddings (for the memory subsystem the spawned agents use) |
| `ANTHROPIC_API_KEY` | LLM (fact merging + promotion at session end) |

Optional:

| Var | Default | Purpose |
|---|---|---|
| `WORKSPACE_ROOT` | `~/.beevibe/workspaces` | Per-agent sandbox root |
| `BEEVIBE_SKILLS_DIR` | `<repo>/skills` | Source dir for skill sync |
| `POLL_INTERVAL_MS` | `30000` | Polling cadence |
| `BEEVIBE_EXECUTOR_HEALTH_PORT` | `3001` | `GET /health` listener |

`GET /health` returns:

```json
{ "ok": true, "polling": true, "last_poll_at": "...", "in_flight_count": 2, "poll_interval_ms": 30000 }
```

`ok` is `false` (with HTTP 503) if the worker has stopped polling or the last poll is older than 3× the interval — suitable for liveness probes.

## Source layout

```
src/
├── main.ts            startup: env validation → bootstrap → start workers
├── bootstrap.ts       composition root: pool + repos + services + dispatcher + listener
├── worker.ts          poll-claim-dispatch loop (the heart of this package)
├── dispatch.ts        per-task dispatcher: ResumeReason resolution + AgentSession.run
├── cancel-listener.ts dedicated PG client subscribed to `cancel_task`
└── health-server.ts   GET /health
```

## Build / test

```bash
pnpm --filter @beevibe/scheduler build
pnpm --filter @beevibe/scheduler typecheck
pnpm --filter @beevibe/scheduler test
```
