# beevibe

Beevibe core — modular monolith for the agent runtime platform.

## Architecture

```
beevibe/
├── packages/
│   ├── core/          shared library: domain, ports, services, adapters, auth
│   ├── api/           binary: MCP tool surface for agents + REST endpoints for humans + MeshServer
│   ├── executor/      binary: task polling + session dispatch
│   └── web/           Next.js UI + API routes (M8)
│
├── migrations/        node-pg-migrate SQL files
├── scripts/           dev orchestrator + e2e smokes + provisioning helpers
└── docker-compose.yml Postgres 16 + pgvector
```

### Dependency direction (enforced via ESLint)

```
core/domain     → nothing
core/ports      → domain
core/services   → domain + ports  (NEVER adapters)
core/adapters   → ports it implements + domain
api/            → core (composition root)
executor/       → core (composition root)
```

## Tech stack

- TypeScript strict (ES2022, NodeNext)
- pnpm workspaces + Turborepo
- Postgres 16 + pgvector, raw `pg` driver (no ORM)
- node-pg-migrate
- Claude Code CLI runtime
- `@modelcontextprotocol/sdk`

## Quick start

Requires Node ≥ 20, pnpm 9, Docker, and the `claude` CLI on PATH.

```bash
pnpm install
docker compose up -d                     # postgres + pgvector
cp .env.example .env                     # fill in ANTHROPIC_API_KEY + OPENAI_API_KEY
pnpm migrate up                          # apply migrations to dev DB
pnpm dev                                 # postgres + api + executor + cloudflared tunnel
```

`pnpm dev` runs `scripts/dev.sh`, which:
- starts Postgres if it isn't already running
- applies migrations
- spawns `@beevibe/api` (port 3000 by default) and `@beevibe/executor` (health on 3001) in watch mode with `[api]` / `[exec]` log prefixes
- if `cloudflared` is on PATH, exposes the api at a `*.trycloudflare.com` URL and prints a paste-ready `mcp.json` snippet for remote Claude CLI access. Pass `--no-tunnel` to disable.

Ctrl+C tears the whole tree down via `trap 'kill 0' EXIT`.

### Common commands

```bash
pnpm build              # tsc across all packages
pnpm typecheck          # typecheck without emit
pnpm lint               # eslint
pnpm test               # vitest (unit + integration)
pnpm dev                # full local stack (postgres + api + executor + tunnel)
pnpm migrate up         # apply migrations to DATABASE_URL
pnpm migrate:test up    # apply migrations to DATABASE_URL_TEST
```

## Manual smoke against the tunnel

To exercise the MCP tool surface end-to-end with your own Claude CLI as the human user:

```bash
# Terminal 1 — start the stack
pnpm dev
# Wait for: "Tunnel URL: https://<random>.trycloudflare.com"
# (the URL is also written to ~/.beevibe/last-tunnel-url)

# Terminal 2 — provision a demo team
pnpm tsx scripts/provision-demo.ts
```

`provision-demo.ts` creates an idempotent demo topology in the dev DB:

```
person:   demo-user (bv_u_<token>)
  └── captain   (team-tier, owned by demo-user) ← bv_u_ resolves here
        ├── ic-alice  (ic-tier)
        └── ic-bob    (ic-tier)
```

It prints a paste-ready `mcp.json` snippet pointing at the live tunnel URL. Drop that into your local Claude CLI's MCP config (`~/.config/claude/mcp.json` or wherever your CLI reads it), then in any directory:

```bash
claude
# In the chat, try:
#   "who are my subordinates?"        → find_subordinates → [ic-alice, ic-bob]
#   "create a task for ic-alice: write a hello-world bash script"
#   wait ~30-60s, watching [exec] logs in Terminal 1
#   "what's the status of that task?" → get_task → done
#   "ask ic-alice: where is hello.sh?" → mesh-ask round-trip
```

When done:

```bash
pnpm tsx scripts/provision-demo.ts --print  # re-print existing keys/snippet
pnpm tsx scripts/provision-demo.ts --clean  # wipe demo rows (no reseed)
```

`--clean` only removes rows owned by `demo-user`; other dev-DB data is untouched. It refuses if a demo agent has a live OS process to avoid wedging mid-flight tasks.

## Integration tests

Live E2E smokes that exercise real Postgres + LLM APIs. Each is gated by an env flag; CI runs them under separate jobs.

```bash
# In-process smoke (10 scenarios; api+executor bootstrapped in the same VM)
RUN_M6_E2E=1 \
  DATABASE_URL_TEST=postgresql://beevibe:beevibe@localhost:5433/beevibe_test \
  OPENAI_API_KEY=... ANTHROPIC_API_KEY=... \
  pnpm tsx scripts/m6-e2e.ts

# Multi-process smoke (api + executor as actual `node dist/main.js`
# subprocesses; verifies cross-process IPC, signal propagation, no orphans)
RUN_M7_E2E=1 \
  DATABASE_URL_TEST=postgresql://beevibe:beevibe@localhost:5433/beevibe_test \
  OPENAI_API_KEY=... ANTHROPIC_API_KEY=... \
  pnpm tsx scripts/m7-e2e.ts
```

Apply test-DB migrations first with `pnpm migrate:test up`. Both scripts truncate the test DB at start; back-to-back runs work.

## Status

- **M0**: scaffold ✅
- **M1**: domain + ports + postgres adapter + schema + migrations ✅
- **M2**: claude-code runtime adapter + git adapter ✅
- **M3**: services + pgvector + llm providers ✅
- **M4**: auth ✅
- **M5**: executor binary (polling + dispatch) ✅
- **M6**: api binary (MCP tool surface + REST + mesh + escalation + cancellation) ✅
- **M7**: full-stack integration test (multi-process smoke + dev orchestrator + manual smoke recipe) ✅
- **M8**: web package (Next.js UI + API routes) ✅
- **M9**: agent skill system (markdown behavioral fragments) — placeholder, see issue #9
