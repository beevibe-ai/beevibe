# Beevibe — Claude Code Guide

## Monorepo structure

```
packages/
  core/       shared domain, ports, services, adapters — compiled to dist/
  api/        Express API + MCP server (tsx watch src/main.ts)
  daemon/     Local agent runner (tsx watch src/main.ts start)
  scheduler/  Cron + background jobs
  web/        Next.js frontend
scripts/
  dev.sh      One-command local stack (postgres + core watch + api + scheduler)
```

## Running locally

```bash
pnpm dev          # everything: postgres, core watcher, api, scheduler, tunnel
pnpm dev --no-tunnel
```

`pnpm dev` now:
1. Kills any stale beevibe processes from previous runs
2. Starts `tsc --watch` for `@beevibe/core` so source changes compile automatically
3. Starts API and scheduler (tsx watch, reload on file change)

The **daemon** is NOT started by `pnpm dev` — start it separately:
```bash
cd packages/daemon && npx tsx watch src/main.ts start
```

## Critical: @beevibe/core compiles to dist/

`packages/core/package.json` exports point to `./dist/`, not `./src/`. Changes
to `packages/core/src/**` are **invisible** to the API and daemon until compiled.

`pnpm dev` now runs `tsc --watch` for core automatically. If you're not using
`pnpm dev` (e.g. running the API standalone), rebuild manually first:

```bash
pnpm --filter @beevibe/core build
```

After a core rebuild, touch a file in the consuming package to force tsx reload:
```bash
touch packages/api/src/runtime/router.ts   # reload API
touch packages/daemon/src/spawner.ts       # reload daemon
```

## Restarting cleanly

`pnpm dev` uses `trap 'kill 0' EXIT` but only kills its own children. If you
close the terminal without Ctrl+C, tsx/node processes linger and hold ports.

To fully reset:
```bash
pkill -f "beevibe/(packages|scripts)"
pkill -f "daemon/src/main"
```

Or just run `pnpm dev` — it does this cleanup at the start now.

## Agent runtime (Claude Code CLI)

- The CLI binary is `claude` on PATH
- Sessions spawn with `--dangerously-skip-permissions --strict-mcp-config`
- MCP config lives in `~/.beevibe/workspaces/<agent_id>/mcp-config.json`
- Agent cwd is the workspace path (`~/.beevibe/workspaces/<agent_id>`)

## Team agent routing

Team agents (hierarchy_level = 'team') in chat sessions:
- Keep full tool access — they need to read code, search repos, and write
  scratch files to ground handoffs in real context
- Must route work to subordinate specialists or recommend spawning one
- Routing directive fires post-onboarding, even with zero subordinates

Routing is enforced by prompt (`teamAgentRoutingDirective` +
`BEEVIBE_LIFECYCLE_REMINDER_CHAT`), not by tool restriction.

## Checking if a change is live

```bash
# API PID — if unchanged after touching a file, tsx didn't reload
lsof -i :3000 -sTCP:LISTEN | grep LISTEN

# Daemon log
tail -f /tmp/beevibe-daemon.log

# Verify core dist has your change
grep "your_symbol" packages/core/dist/adapters/claude-code/runtime.js
```

## Database

```bash
# Local postgres via docker-compose
docker exec beevibe-postgres psql -U beevibe -d beevibe -c "SELECT ..."

# Connection string
DATABASE_URL=postgresql://beevibe:beevibe@localhost:5433/beevibe
```

## Running tests

`pnpm test` is **not** hermetic — integration tests need a real Postgres
and the adapter tests make live provider calls. There is no
`describe.skipIf`: missing prerequisites fail loudly by design.

```bash
docker compose up -d --wait postgres
docker exec beevibe-postgres psql -U beevibe -d beevibe \
  -c 'CREATE DATABASE beevibe_test;'
# .env needs DATABASE_URL, DATABASE_URL_TEST, OPENAI_API_KEY, ANTHROPIC_API_KEY
pnpm migrate up && pnpm migrate:test up
pnpm test
```

`.github/workflows/ci.yml` is the source of truth; CONTRIBUTING.md has
the long form. Narrower loop: `pnpm --filter @beevibe/core test`.

### Recognizing environmental failures vs. real ones

In a sandbox with no Docker and no provider keys, these failures are
**pre-existing and unrelated to your change** — don't chase them:

| Message | Cause |
| --- | --- |
| `DATABASE_URL_TEST env var is required…` | no Postgres |
| `Cannot read properties of undefined (reading 'end')` in `afterAll` | knock-on from the above |
| `OPENAI_API_KEY missing` / `ANTHROPIC_API_KEY missing` | no provider keys |

Baseline in a bare sandbox (no Docker, no keys), for comparison rather
than expecting green:

| Package | Result |
| --- | --- |
| `@beevibe/api` | 27 files pass, 9 fail (308 tests pass) |
| `@beevibe/core` | 9 tests fail, 415 pass |
| `@beevibe/scheduler` | 2 files pass, 2 fail (10 tests pass) |
| `@beevibe/sandbox` | exits 0 — its only suite is Docker-gated and skips |

`typecheck`, `lint`, and `build` need none of this and should always be
clean — use them as the real gate when the DB isn't available.

### `pnpm build` fails on web behind a proxy

Turbo 2.x runs tasks in **strict env mode** and `turbo.json` declares no
`globalPassThroughEnv`, so `HTTPS_PROXY` / `NODE_EXTRA_CA_CERTS` are
stripped before the task runs. `next/font` then can't verify the proxy's
CA when fetching Google Fonts:

```
FetchError: request to https://fonts.googleapis.com/… failed,
  reason: self-signed certificate in certificate chain
```

The network is fine — verify with
`curl -sS -o /dev/null -w '%{http_code}\n' https://fonts.googleapis.com/css2?family=Inter`.
Build the package directly to bypass Turbo:

```bash
pnpm --filter @beevibe/web exec next build
```

Diagnose Turbo's env filtering with
`npx turbo run build --filter=@beevibe/web --dry-run=json` and check
`envMode` / `passthrough`.

## Deploying

```bash
vercel --prod   # from beevibe-marketing for the marketing site
```

API deploys separately — see Vercel project settings.
