# beevibe

> A self-hosted runtime for autonomous AI agent teams. Tasks flow between agents through hierarchy and peer mesh; memory carries forward; humans review and approve from a dashboard.

beevibe lets you run a small organization of Claude Code agents that delegate to each other, negotiate, escalate to humans when stuck, and build up shared memory over time. You provide the agents (a captain and a few ICs is a fine starting point), the work, and the review judgment. The platform handles the rest.

It's open source under the Apache-2.0 license. Everything is self-hosted: your Postgres, your `claude` CLI binaries, your filesystem.

## Deploy

One-click cloud deploy:

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/beevibe)

This brings up `api` + `scheduler` + `web` services and a managed Postgres in one click. After the deploy finishes, set `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in the project's Variables tab, then visit the web service's public URL to sign up. You'll be prompted to install the local daemon as part of the welcome flow.

Self-host options:

- **Docker / docker-compose** — `git clone && docker compose up` against a tagged release (see [Self-hosting](#self-hosting) below).
- **Manual** — `pnpm install && pnpm build && pnpm start` per service against your own Postgres.

The repo and its tagged releases are the source of truth. The Railway button is a convenience layer; you can deploy the same code to Fly, Render, Coolify, k8s, or any container host.

## What's inside

```
beevibe/
├── packages/
│   ├── core/         shared library (domain, ports, services, adapters, auth)
│   ├── api/          MCP tool surface for agents + REST for humans + mesh broker
│   ├── scheduler/    fallback claimant for null-runtime sessions + orphan reaper
│   ├── daemon/       runs on each user's machine; claims sessions and spawns CLIs locally
│   └── web/          Next.js dashboard with live updates over SSE
│
├── skills/           Anthropic Agent Skills (markdown behavioral protocols)
├── migrations/       node-pg-migrate SQL files
├── scripts/          dev orchestrator + e2e smokes + provisioning helpers
└── docker-compose.yml Postgres 16 + pgvector
```

Each package has its own README with details:

- [packages/core](./packages/core/README.md) — the library
- [packages/api](./packages/api/README.md) — the agent + human API server
- [packages/scheduler](./packages/scheduler/README.md) — server-fallback claimant + orphan reaper
- [packages/daemon](./packages/daemon/README.md) — local-runtime daemon (one per user machine)
- [packages/web](./packages/web/README.md) — the dashboard

## Concepts in 60 seconds

- **Agent**. Has a hierarchy level — `ic` (worker), `team` (delegator), or `org` (decider). Owns a persona, a set of stable core-memory blocks, and a vector-indexed archive of facts. Identified by an `agent_id` and authenticates with a `bv_a_…` API key.
- **Person / user**. A human owner. Authenticates with a `bv_u_…` API key. Can act as their top-level agent through MCP, or use the dashboard for review.
- **Task**. A unit of work assigned to an agent. Moves through `pending → running → review → done` (or `failed` / `blocked` / `cancelled`). Tasks can spawn child tasks; parents auto-complete when their children settle.
- **Session**. One run of the `claude` CLI for one task. Has a transcript, a `cli_session_id` (for `--resume`), and usage telemetry (including cache-hit ratios).
- **Mesh**. Agents can `ask` peers one-shot questions or `negotiate` with team/org peers across multiple rounds. If they can't agree, either side can `escalate_to_humans` and a person resolves it from the dashboard.
- **Memory**. `save_memory(...)` archives a fact (`belief`/`pattern`/`gotcha`/`preference`/`decision`); after the session ends, the FactPromoter LLM may elevate it from `ic` scope to `team` or `org` based on whether it generalizes. `update_core_memory(...)` writes the durable per-agent blocks.
- **Skills**. Markdown procedural protocols ([Anthropic Agent Skills standard](https://agentskills.io/specification)) auto-discovered by `claude` from `<workspace>/.claude/skills/`. We ship two: `beevibe-pre-task-setup` and `beevibe-team-mesh-negotiation`.

## Quick start

You'll need:

- Node ≥ 20 + pnpm 9
- Docker (for the Postgres + pgvector container)
- The [`claude`](https://docs.claude.com/en/docs/claude-code/overview) CLI on PATH
- An Anthropic API key + an OpenAI API key (the latter is for embeddings)

```bash
git clone https://github.com/beevibe-ai/beevibe.git
cd beevibe
pnpm install

cp .env.example .env
# fill in ANTHROPIC_API_KEY and OPENAI_API_KEY

docker compose up -d                  # postgres + pgvector
pnpm migrate up                       # apply migrations to dev DB
pnpm dev                              # postgres + api + scheduler (+ tunnel if cloudflared is on PATH)
```

`pnpm dev` runs [`scripts/dev.sh`](./scripts/dev.sh), which:

- starts Postgres if it isn't already running
- applies migrations
- spawns `@beevibe/api` (port 3000) and `@beevibe/scheduler` (health on 3001) in watch mode with `[api]` / `[exec]` log prefixes
- if `cloudflared` is on PATH, exposes the api at a `*.trycloudflare.com` URL and prints a paste-ready `mcp.json` snippet for remote `claude` CLI access (pass `--no-tunnel` to disable)

`Ctrl+C` tears the whole tree down.

To bring up the dashboard alongside, in a second terminal:

```bash
pnpm --filter @beevibe/web dev -- -p 3030
# then visit http://localhost:3030
```

The web app reads `NEXT_PUBLIC_BV_API_URL` (origin of the api server). For a working demo flow, run `pnpm seed-demo` to provision demo users (each with a password) — then sign in at `/sign-in`. The welcome wizard guides daemon setup.

## Try it from your own Claude CLI

The `provision-demo.ts` script creates an idempotent demo team in your dev DB and prints a paste-ready MCP config so you can act *as* the captain agent from your own `claude` CLI:

```bash
# Terminal 1
pnpm dev
# Wait for: "Tunnel URL: https://<random>.trycloudflare.com"

# Terminal 2
pnpm tsx scripts/provision-demo.ts
```

This creates:

```
person:   demo-user (bv_u_<token>)
  └── captain   (team-tier, owned by demo-user)
        ├── ic-alice  (ic-tier)
        └── ic-bob    (ic-tier)
```

Drop the printed snippet into your local `claude` CLI's MCP config (`~/.config/claude/mcp.json` or wherever your CLI reads it), then in any directory:

```bash
claude
# In the chat, try:
#   "who are my subordinates?"        → find_subordinates → [ic-alice, ic-bob]
#   "create a task for ic-alice: write a hello-world bash script"
#   wait ~30-60s, watching [exec] logs in Terminal 1
#   "what's the status of that task?" → check_work_status → done
#   "ask ic-alice: where is hello.sh?" → mesh-ask round-trip
```

Cleanup:

```bash
pnpm tsx scripts/provision-demo.ts --print  # re-print existing keys/snippet
pnpm tsx scripts/provision-demo.ts --clean  # wipe demo rows (no reseed)
```

`--clean` only removes rows owned by `demo-user`. It refuses if a demo agent has a live OS process so you don't wedge mid-flight tasks.

## Skills

beevibe ships agent behavioral skills as `SKILL.md` files in [`/skills/`](./skills) — Anthropic's [Agent Skills open standard](https://agentskills.io/specification). The api and daemons sync them into each agent's workspace at dispatch time automatically; agent-spawned sessions get them for free.

For human users running `claude` locally and acting *as* a beevibe agent (the manual-smoke path above), install them once into your local Claude Code skill discovery dir:

```bash
pnpm install-skills
```

The install is idempotent — re-run after `git pull` to refresh. Only dirs named exactly `beevibe` or starting with `beevibe-` in `~/.claude/skills/` are touched; your other personal skills are left alone.

> **Reserved namespace**: the `beevibe-` prefix in `~/.claude/skills/` is reserved for skills shipped by this repo. If you author your own personal skills, use a different prefix (e.g., `mybeevibe-foo`) — anything not matching `beevibe-*` is invisible to the install command.

## Self-hosting

Beyond the Railway one-click button, the same code runs anywhere that can run a container or Node 20+.

### Option 1: Docker

Each service has a Dockerfile under [`infra/railway/`](./infra/railway). To run the full stack via Docker:

```bash
git clone https://github.com/beevibe-ai/beevibe.git
cd beevibe
# Optional: pin to a tagged release for reproducible builds
#   git checkout v0.1.0

# 1. Build the three service images
docker build -f infra/railway/Dockerfile.api       -t beevibe-api .
docker build -f infra/railway/Dockerfile.scheduler -t beevibe-scheduler .
docker build -f infra/railway/Dockerfile.web \
  --build-arg NEXT_PUBLIC_BV_API_URL=http://localhost:3000 \
  -t beevibe-web .

# 2. Start Postgres
docker compose up -d postgres

# 3. Run migrations once
docker run --rm --network host \
  -e DATABASE_URL=postgresql://beevibe:beevibe@localhost:5433/beevibe \
  beevibe-api pnpm migrate:deploy up

# 4. Run the services (each in its own terminal or via your orchestrator)
docker run -p 3000:3000 --network host --env-file .env beevibe-api
docker run --network host --env-file .env beevibe-scheduler
docker run -p 8080:3000 --env-file .env beevibe-web
```

Then visit `http://localhost:8080` to sign up.

### Option 2: Bare Node

If you'd rather not use Docker:

```bash
git clone https://github.com/beevibe-ai/beevibe.git
cd beevibe
# Optional: pin to a tagged release
#   git checkout v0.1.0

pnpm install --frozen-lockfile
pnpm build
pnpm migrate:deploy up

# Start each service in its own process (use systemd, pm2, or your service manager)
node packages/api/dist/main.js          # api on $PORT (default 3000)
node packages/scheduler/dist/main.js    # scheduler (background worker)
pnpm --filter @beevibe/web start        # web (next start, port from $PORT)
```

Required env vars are listed in [`.env.example`](./.env.example). The api needs `DATABASE_URL`, `BEEVIBE_MCP_SERVER_URL`, `ANTHROPIC_API_KEY`, and `OPENAI_API_KEY` at minimum.

### Notes for production self-hosting

- **Single api replica** for v1 (see [v1 single-instance API constraint](#v1-single-instance-api-constraint) below).
- **Postgres 16+** with `pgvector` extension. The included `docker-compose.yml` uses `pgvector/pgvector:pg16`.
- **Reverse proxy** in front of the api (nginx / Caddy / Cloudflare) must support WebSockets (`/runtime/ws`) and long-held HTTP responses (mesh negotiate held connections, up to 5 minutes idle).
- **CORS**: set `BEEVIBE_CORS_ORIGINS` to the public URL of the web service. Localhost variants are always allowed in addition.
- **Daemon distribution**: end users still install the [`beevibe-daemon`](./packages/daemon) on their own machines to run agent CLIs locally. The hosted api never spawns user CLIs.

## Architecture

The dependency direction across packages is one-way and ESLint-enforced:

```
core/domain     → nothing
core/ports      → domain
core/services   → domain + ports     (NEVER adapters)
core/adapters   → ports it implements + domain
api/            → core (composition root)
scheduler/      → core (composition root)
daemon/         → core (workspace + runtime adapters, direct imports)
web/            → core (types only) + api (HTTP)
```

The api, scheduler, and per-user daemons are independent processes. The api never talks to the scheduler or daemons over HTTP for task dispatch — Postgres is the integration point:

- The api writes task lifecycle changes (created, approved, revised, cancelled) and inserts `session` rows with `status='pending'`.
- A daemon claims sessions whose `preferred_runtime_id` matches its registered runtime and spawns the CLI locally on the user's machine.
- The scheduler claims null-runtime sessions (server-fallback for offline-target mesh asks) and runs the daemon-orphan reaper.
- Cancellation: api `UPDATE`s the row + `pg_notify('cancel_task', task_id)`; the active claimant (daemon or scheduler) aborts the in-flight session in <200ms.
- Live updates: every state-changing INSERT/UPDATE fires a `pg_notify`; api's `/api/stream` SSE endpoint relays them to the dashboard.

That decoupling means each component scales independently — many daemons (one per user machine), one or a few schedulers, a single api replica per region (see [v1 single-instance API constraint](#v1-single-instance-api-constraint) below).

### v1 single-instance API constraint

The mesh resolver (`packages/api/src/mesh/server.ts:90`) and the
forthcoming chat / room resolvers are in-process `Map`s — when an agent's
`ask` fires, the API holds the HTTP request open and resolves it from
that map when the target's `respond_ask` lands. **Both halves of the
round-trip must hit the same API process** for v1; a multi-instance API
fronted by a load balancer can drop responses on the floor when the two
HTTP requests land on different replicas. Documented in code; tracked
for cross-instance federation via `pg_notify` as a follow-up. **Self-hosters
should run a single API replica until that ships.** The scheduler and
per-user daemons scale horizontally either way.

## Common commands

```bash
pnpm build              # tsc across all packages (turbo-cached)
pnpm typecheck          # types only
pnpm lint               # eslint
pnpm test               # vitest (unit + integration)
pnpm dev                # full local stack (postgres + api + scheduler + tunnel)
pnpm migrate up         # apply migrations to DATABASE_URL
pnpm migrate:test up    # apply migrations to DATABASE_URL_TEST
pnpm install-skills     # install beevibe skills into ~/.claude/skills/
```

## Tech stack

- TypeScript strict (ES2022, NodeNext)
- pnpm workspaces + Turborepo
- Postgres 16 + pgvector, raw `pg` driver (no ORM)
- node-pg-migrate
- Claude Code CLI runtime (spawned per-session)
- `@modelcontextprotocol/sdk`
- Next.js 14 + TanStack Query + Tailwind (dashboard)

## End-to-end smokes

Live integration tests against real Postgres + LLM APIs. Each is gated by an env flag.

```bash
# In-process smoke — api + scheduler bootstrapped in the same VM
RUN_M6_E2E=1 \
  DATABASE_URL_TEST=postgresql://beevibe:beevibe@localhost:5433/beevibe_test \
  OPENAI_API_KEY=... ANTHROPIC_API_KEY=... \
  pnpm tsx scripts/m6-e2e.ts

# Multi-process smoke — api + scheduler as actual `node dist/main.js`
# subprocesses; verifies cross-process IPC, signal propagation, no orphans
RUN_M7_E2E=1 \
  DATABASE_URL_TEST=postgresql://beevibe:beevibe@localhost:5433/beevibe_test \
  OPENAI_API_KEY=... ANTHROPIC_API_KEY=... \
  pnpm tsx scripts/m7-e2e.ts

# Skills + memory + cache-hit ratio smoke (M9 features)
RUN_M9_E2E=1 \
  DATABASE_URL_TEST=postgresql://beevibe:beevibe@localhost:5433/beevibe_test \
  OPENAI_API_KEY=... ANTHROPIC_API_KEY=... \
  pnpm tsx scripts/m9-e2e.ts
```

Apply test-DB migrations first with `pnpm migrate:test up`. All scripts truncate the test DB at the start, so back-to-back runs work.

## Project status

The platform was built in milestones (M0 → M9), each with its own integration test:

| Milestone | What landed |
|---|---|
| M0 | Repo scaffold |
| M1 | Domain + ports + Postgres adapter + schema + migrations |
| M2 | Claude Code runtime adapter + workspace adapter |
| M3 | Memory subsystem + pgvector + LLM providers |
| M4 | API-key auth + agent provisioning |
| M5 | Executor binary (polling + dispatch) |
| M6 | API binary (MCP tools + REST + mesh + escalation + cancellation) |
| M7 | Multi-process integration test + dev orchestrator |
| M8 | Web dashboard (Next.js + SSE) |
| M9 | Skill system (auto-discovered behavioral protocols) + memory tooling refresh |

The full design discussions and PR references live in the [closed issues](https://github.com/beevibe-ai/beevibe/issues?q=is%3Aissue+is%3Aclosed) — each milestone has one tracking issue.

## Contributing

Issues and PRs welcome. For non-trivial changes, open an issue first so we can align on direction.

A few conventions worth knowing:

- **Plan first, build second.** Each milestone is scoped end-to-end (schema → types → unit tests → integration test) before any code is written. See `tasks/` (gitignored) for the workflow.
- **TDD where it pays.** Domain types and pure services are test-first. Adapters get integration tests against real services (Postgres, real LLM keys).
- **No parallel systems.** When a feature replaces an older one, the old code is deleted in the same PR — no `if (new) ... else if (old) ...` branches.

## License

The Beevibe source code is licensed under the [Apache License 2.0](./LICENSE).

The **Beevibe** name and logo are trademarks of the project — see
[TRADEMARK.md](./TRADEMARK.md). Apache 2.0 grants rights to the source
code; it does not grant rights to use the project's name or marks. Forks
and derivative works are welcome under any name that is not "Beevibe."

Contributing? See [CONTRIBUTING.md](./CONTRIBUTING.md). All commits must
include a `Signed-off-by:` trailer (the [Developer Certificate of Origin
v1.1](./CONTRIBUTING.md#developer-certificate-of-origin-v11)) — `git commit -s`.

Copyright (c) 2026 Zhe Pang. Rights to be assigned to Beevibe Inc. upon
its formation.
