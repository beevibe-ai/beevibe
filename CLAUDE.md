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
and the adapter tests make live provider calls. Missing prerequisites
fail loudly by design rather than silently skipping. The one exception is
`packages/api/src/routes/mcp.test.ts`, which is `describe.skipIf`-gated on
both provider keys — CI supplies them, so it runs there, but a keyless
local run skips it silently. (The opt-in e2e/smoke suites and the
`it.skipIf(win32)` platform gates skip by design; see below.)

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

### Measuring coverage

No coverage provider is tracked as a dependency — install one for the
sweep and don't commit it:

```bash
pnpm add -Dw @vitest/coverage-v8@2.1.9
cd packages/daemon && npx vitest run --coverage --coverage.provider=v8 \
  --coverage.all --coverage.include='src/**/*.ts' \
  --coverage.exclude='src/**/*.test.ts' --exclude '**/*.e2e.test.ts'
```

Two traps:

- `--coverage.all` is required, or files with no test file at all are
  simply absent from the report and read as "covered".
- An **unhandled** error in a test file (the DB-gated suites throw one
  from `afterAll`) aborts report generation entirely — the run prints
  results but writes no `coverage-summary.json`. Exclude the DB- and
  key-gated suites when measuring without Postgres.

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

## Dead-code analysis: known false positives

`knip` and `depcheck` flag the same handful of things on every sweep. All
of the below are **load-bearing — do not remove.** Verify against this
table before deleting anything a tool reports as unused.

| Reported as unused | Why it stays |
| --- | --- |
| `packages/api` dep `node-pg-migrate` | Runs migrations on deploy via `scripts/start-api.sh`. Removing it broke the Railway deploy once already (#258). |
| `packages/api` dep `zod` | Required **peer dependency** of `@modelcontextprotocol/sdk` (`^3.25 \|\| ^4.0`). Nothing imports it directly. |
| `packages/web` devDeps `postcss`, `autoprefixer` | Referenced by `packages/web/postcss.config.js`, which the tools don't parse. |
| root devDep `prettier` | Formatting is editor/CLI-driven off `.prettierrc.json`; there's no `format` script to detect. |
| `migrations/*.js` | Applied migration history. **Never** delete a migration file. |
| `scripts/provision-demo.ts`, `pre-deploy-fix-migration-names.cjs` | Invoked from `scripts/dev.sh` and `scripts/start-api.sh` — shell call sites are invisible to knip. |
| `scripts/seed-session-search-demo.ts`, `test-session-search.ts`, `packages/sandbox/src/scripts/*` | Documented manual dev/ops utilities, run by hand via `pnpm tsx …`. |
| `OwnerLookup.singleOwnerSet` / `.meshOwners` | Called by the module-level `RESOLVERS` table, so they must stay public. Knip only checks cross-module use. |
| `@beevibe/core/{domain,adapters/codex,adapters/opencode,services/skills,auth/constants}` subpath exports | Deliberate library surface. The codex/opencode runtimes are wired through `runtime-registry.ts`, which imports `./codex/runtime.js` directly rather than the barrel. |

Most "unused export" hits are symbols used *within their own file* — the
`export` is redundant, not dead. Leave them alone unless you're already
editing the file.

The checks that do find real dead code here:

```bash
npx tsc -p packages/<pkg>/tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters
npx tsc -p packages/<pkg>/tsconfig.json --noEmit --allowUnreachableCode false   # TS7027
```

Note `@typescript-eslint/no-unused-vars` defaults to `args: after-used`,
so an unused parameter followed by a used one is **not** reported — only
`--noUnusedParameters` catches it. Convention here is to prefix a
deliberately-unused param with `_`.

### knip's blind spot: symbols behind `@beevibe/core` subpath barrels

`packages/core/package.json` declares 26 `exports` subpaths. knip treats
each one as an **entry point**, so anything re-exported from a barrel
(`domain/index.ts`, `adapters/postgres/index.ts`, …) is "reachable" and
never flagged — no matter how many packages actually import it. Every
core dead-export found so far was invisible to knip for this reason.

Sweep it by name instead — for each `export function|class|const` under
`packages/*/src/**`, grep the whole monorepo and discount (a) the
declaring file and (b) pure re-export lines in `index.ts`:

```bash
git grep -n -w -- "<symbol>" -- 'packages/**' 'scripts/**' | grep -v /dist/
```

Zero surviving hits = dead. Hits only from `*.test.ts` = alive only for
its own test — check whether it's a deliberate test seam (`clearCache()`
in `api/src/sse/owner-lookup.ts` is marked `@internal Tests only`) before
touching it.

### Dead in-repo, but not ours to delete

| Thing | Why it survived the sweep |
| --- | --- |
| `GET /activity` → `api/src/views/activity.ts` | No caller anywhere in the monorepo, but it's a **documented public endpoint** (`packages/api/README.md`). Retiring it is a product call. The web side is fully gone: the client stub (`api.activity.list`) went with #273, and `queryKeys.activity` + its no-op `lib/sse.ts` invalidations went with #283. |
| `SkillOutcomeRepository.listBySkill` / `.statsForSkill`, `AgentProvisionEventRepository.listByParent` | Uncalled **read** halves of audit trails whose write side is live and accumulating rows (`skill_outcome` via `recordCapabilityOutcome`, `agent_provision_event` via `create_subordinate_agent`). Same call as the promotion repo below — the consumers (discovery-ranker feedback, agents-page audit panel) are unbuilt, not removed. Deleting the queries makes finishing them harder. |
| `PostgresMemoryPromotionEventRepository` | Never constructed — `bootstrap.ts` builds the MemoryAgent without `promotionEventRepo`, so the M8.D promotion audit log never writes even though the port, the service branch, its tests and the read-side `views/promotions.ts` all exist. That's **unfinished wiring, not dead code**; deleting the adapter makes finishing it harder. |

## Deploying

```bash
vercel --prod   # from beevibe-marketing for the marketing site
```

API deploys separately — see Vercel project settings.
