# Deployment

Beevibe is a self-hosted control plane for AI agent teams. A production
deployment needs:

- Postgres 16+ with the `pgvector` extension
- `@beevibe/api`
- `@beevibe/scheduler`
- `@beevibe/web`
- one local `beevibe-daemon` per user machine that should run agent sessions

Daemons register every supported CLI they find on `PATH`. `claude` is the
default high-reliability runtime. `opencode` is the open/free model path: it
can route through OpenRouter, Ollama, and OpenAI-compatible providers using
OpenCode's own provider configuration.

## Required Environment

Copy [`.env.example`](./.env.example) and set the values for your host.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string |
| `BEEVIBE_MCP_SERVER_URL` | API MCP URL written into agent workspace config |
| `BEEVIBE_API_PORT` | API listen port, default `3000` |
| `BEEVIBE_SCHEDULER_HEALTH_PORT` | scheduler health port, default `3001` |
| `BEEVIBE_CORS_ORIGINS` | comma-separated allowed web origins |
| `NEXT_PUBLIC_BV_API_URL` | API origin used by the web client |
| `OPENAI_API_KEY` | embeddings and memory support |
| `ANTHROPIC_API_KEY` | memory fact merging and promotion |

## Railway

Use the template:

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/beevibe)

The template creates `api`, `scheduler`, `web`, and Postgres services.

### First Deploy Notes

Railway templates may not propagate the per-service config-as-code file path
when cloning the template. If a service tries to build the monorepo through
Railpack auto-detection, set the config path manually:

1. Open the Railway project.
2. Open each service.
3. Go to **Settings** -> **Config-as-code** -> **Railway Config File**.
4. Add the matching path:

| Service | Railway config file |
| --- | --- |
| `api` | `infra/railway/api.railway.json` |
| `scheduler` | `infra/railway/scheduler.railway.json` |
| `web` | `infra/railway/web.railway.json` |

Then set variables:

- `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` on `api` and `scheduler`
- `BEEVIBE_CORS_ORIGINS` on `api`, pointing at the web public URL
- `NEXT_PUBLIC_BV_API_URL` for the web build, pointing at the API public URL

End users still run the daemon on their own machines. The hosted API does not
spawn their local CLI sessions.

## Docker

The repo ships a self-contained compose stack — postgres + api + scheduler +
web in one command, no Node or pnpm on the host.

```bash
ANTHROPIC_API_KEY=sk-ant-… \
OPENAI_API_KEY=sk-…       \
docker compose -f docker-compose.quickstart.yml up -d --build
```

Visit `http://localhost:3030` for the dashboard. To shut down + wipe the
local db volume:

```bash
docker compose -f docker-compose.quickstart.yml down -v
```

The stack runs migrations as a one-shot service before api starts, so no
separate migrate step is needed. The compose file is annotated with the
non-obvious wiring — see the `BEEVIBE_MCP_SERVER_URL` comments for why api
and scheduler resolve the api differently.

For per-image manual control (custom networking, sidecars, separate hosts
per service), build and run the images individually:

```bash
docker build -f infra/railway/Dockerfile.api -t beevibe-api .
docker build -f infra/railway/Dockerfile.scheduler -t beevibe-scheduler .
docker build -f infra/railway/Dockerfile.web \
  --build-arg NEXT_PUBLIC_BV_API_URL=http://localhost:3000 \
  -t beevibe-web .
```

Then run with your own env file. See the Dockerfile headers for the
required runtime envs per service.

## Bare Node

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm migrate:deploy up

node packages/api/dist/main.js
node packages/scheduler/dist/main.js
pnpm --filter @beevibe/web start
```

## Local Daemon

The daemon is installed and run on the machine that should execute agent CLI
sessions.

```bash
brew install beevibe-ai/tap/beevibe-daemon

beevibe-daemon setup \
  --api https://your-api.example.com \
  --user-token <bv_u_token>

beevibe-daemon start
```

For local development from the repo:

```bash
pnpm tsx packages/daemon/src/main.ts setup \
  --api http://localhost:3000 \
  --user-token <bv_u_token>

pnpm tsx packages/daemon/src/main.ts start
```

The daemon stores config in `~/.beevibe/config.json`.

## Production Notes

- Run Postgres 16+ with `pgvector`.
- Set `BEEVIBE_CORS_ORIGINS` to the dashboard's public origin.
- Put a reverse proxy in front of the API that supports WebSockets and
  long-held HTTP responses.
- Run one API replica for v1. Some mesh and chat resolvers are still
  in-process maps, so both halves of a long-held request need to reach the
  same API process.
- Scheduler and daemon processes can scale horizontally.
