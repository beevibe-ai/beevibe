# @beevibe/scheduler

The server-side fallback claimant. Picks up sessions that no daemon will run — currently mesh asks whose target runtime is offline (`spawn_mode='server_fallback_mesh'`, `runtime_id IS NULL`) — and spawns the CLI in-process on the api host. Also reaps PID-orphaned in-process sessions and translates Postgres cancel notifications into `AbortController` fires. Stateless; restart at any time.

Real CLI dispatch for daemon-bound sessions lives in [`@beevibe/daemon`](../daemon), which claims pinned-runtime sessions over HTTP from [`@beevibe/api`](../api). The scheduler never sees those rows.

Depends only on [`@beevibe/core`](../core). No HTTP between scheduler and api — both processes use Postgres as the integration point. `pnpm dev` at the repo root brings this up alongside the api server. For full setup, see the [root README](../../README.md).

## What it does, per cycle

Default cadence: **every 30 seconds** (override via `POLL_INTERVAL_MS`).

1. **Reap PID orphans.** For each `running` session that has a `process_pid` (in-process spawns), if `isProcessAlive(pid)` is false, mark the session `failed` and re-queue the parent task (`in_progress` → `assigned`, `revision` → `needs_revision`). Daemon-orphan reaping (sessions with `runtime_id` set whose daemon has gone silent) is a separate `runOrphanReaper` wired by the api process — not this worker.
2. **Claim server-fallback sessions.** Atomically claim the next `pending` session with `runtime_id IS NULL` via `SessionRepository.claimNextForServerFallback` (`SKIP LOCKED`, promotes to `running`). Currently this only fires for mesh asks demoted to `spawn_mode='server_fallback_mesh'` by `DispatchService` when the target's runtime is offline.
3. **Per-agent capacity check.** If the agent is over `max_task_sessions`, release the row back to `pending` and bail.
4. **Provision + dispatch.** `LocalWorkspaceManager.ensureWorkspace` (also tier-syncs `SKILL.md` files into `<workspace>/.claude/skills/`), then hand off to `AgentSession.run`. Fire-and-forget under an `AbortController`.

Sessions reach the worker only after `DispatchService` has inserted them at `status='pending'` with the right `spawn_mode`. The scheduler never inserts session rows itself.

## Cancellation

The api's `POST /task/:id/cancel` writes the DB row and fires a Postgres `NOTIFY cancel_task <task_id>`. A dedicated `pg.Client` in the scheduler (`src/cancel-listener.ts`) `LISTEN`s on that channel and aborts the in-flight session's `AbortController`. The CLI subprocess gets `SIGTERM`.

Cancels for daemon-bound sessions are routed by the daemon's own cancel handler over the WS, not this listener. The scheduler only kills in-process subprocesses it spawned itself.

If the scheduler is down when the NOTIFY fires, the notification is lost — but the task's `cancelled` status is durable, so the next worker boot won't dispatch it. No reliable delivery is needed.

## Post-dispatch hook

After every session, an `onSessionComplete` hook runs (`src/post-dispatch.ts`):

- If the agent forgot to call `update_progress`, dispatch a one-shot retry via `DispatchService` with a `<context type="nudge_completion">` nudge intent and `kind:'crash_recovery'` (so `claude --resume` re-uses the prior `.jsonl`). The retry runs on the same runtime — daemon if pinned, scheduler if null. If it also exits without a terminal status, mark the task `failed`.
- If all of a parent task's children have settled, roll the parent up via `TaskService.checkAndCompleteParent`.

Safety net for agents that exit without setting their task's terminal status. The system-prompt lifecycle reminder injected by `AgentSession` (and `/runtime/claim`'s spawn-prep) covers most cases proactively; this hook is the catch-all when the LLM still slips.

## Run it

```bash
pnpm --filter @beevibe/scheduler build
pnpm --filter @beevibe/scheduler start            # node dist/main.js
# or watch mode:
pnpm --filter @beevibe/scheduler dev
```

Required env (validated at startup):

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `BEEVIBE_MCP_SERVER_URL` | The URL spawned agents will call back to. Baked into each workspace's `mcp-config.json`. |
| `OPENAI_API_KEY` | Embeddings (for the memory subsystem the spawned agents use) |
| `ANTHROPIC_API_KEY` | LLM (fact merging + promotion at session end) |

Optional:

| Var | Default | Purpose |
|---|---|---|
| `WORKSPACE_ROOT` | `~/.beevibe/workspaces` | Per-agent sandbox root |
| `BEEVIBE_SKILLS_DIR` | `<repo>/skills` | Source dir for skill sync |
| `POLL_INTERVAL_MS` | `30000` | Polling cadence |
| `BEEVIBE_SCHEDULER_HEALTH_PORT` | `3001` | `GET /health` listener |

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
├── worker.ts          poll loop: PID reap + server-fallback claim + dispatch
├── dispatch.ts        per-session dispatcher: builds AgentSession from claimed row
├── post-dispatch.ts   onSessionComplete: nudge-retry via DispatchService + parent rollup
├── cancel-listener.ts dedicated PG client subscribed to `cancel_task`
└── health-server.ts   GET /health
```

## Build / test

```bash
pnpm --filter @beevibe/scheduler build
pnpm --filter @beevibe/scheduler typecheck
pnpm --filter @beevibe/scheduler test
```
