# @beevibe/api

The API server. One Node binary that wears two hats:

1. **MCP server for agents** — exposes the tool surface that spawned `claude` CLIs call into (save memory, ask peers, report blockers, create tasks, …).
2. **REST + SSE server for humans** — endpoints that the [web UI](../web) and CLI tooling use to view / approve / revise tasks and resolve escalations.

It also contains the in-process `MeshServer` — the broker that handles agent-to-agent `ask` and `negotiate`.

If you're running beevibe locally, you don't start this directly — `pnpm dev` at the repo root brings up Postgres + api + executor together.

## Run it

```bash
# from repo root
pnpm --filter @beevibe/api build
pnpm --filter @beevibe/api start            # node dist/main.js
# or watch mode:
pnpm --filter @beevibe/api dev
```

Required env (validated at startup):

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `BEEVIBE_MCP_SERVER_URL` | The URL spawned agents will call back to (e.g. `http://localhost:3000/mcp`). Baked into each agent's `mcp-config.json` by the executor. |
| `OPENAI_API_KEY` | Embeddings (memory recall) |
| `ANTHROPIC_API_KEY` | LLM (fact merging + promotion) |

Optional:

| Var | Default | Purpose |
|---|---|---|
| `BEEVIBE_API_PORT` | `3000` | HTTP listen port |
| `WORKSPACE_ROOT` | `~/.beevibe/workspaces` | Per-agent sandbox root |
| `BEEVIBE_SKILLS_DIR` | `<repo>/skills` | Source dir for skill sync |

`GET /health` (no auth) returns `{ ok, version }` and is suitable for liveness probes.

## Auth

Bearer tokens, two prefixes:

- `bv_a_…` — **agent** key. Permits MCP calls on `/mcp/*`. Tier-gated by `agent.hierarchy_level` (`ic` / `team` / `org`).
- `bv_u_…` — **user** key. Permits REST mutations on `/task/*`, `/escalation/*` and SSE on `/api/stream`.

The token is taken from the `Authorization: Bearer …` header (or `?token=…` query param for SSE — `EventSource` can't set headers). Validation routes to `@beevibe/core/auth.lookupApiKey` and the resolved caller is attached to `req.caller`.

## MCP tools (agent-facing, mounted at `/mcp`)

The exact tool inventory depends on the calling agent's tier. The IC tier is the worker tier — fewer tools, no peer negotiation. The team / org tier adds delegation and negotiation.

### All tiers (12 tools)

| Tool | Purpose |
|---|---|
| `save_memory` | Archive a fact (`belief`/`pattern`/`gotcha`/`preference`/`decision`). |
| `update_core_memory` | Append/replace a stable block (persona/domain/constraints/learnings). |
| `search_context` | Vector-search archival memory mid-session. |
| `update_progress` | Set the task's terminal status (`done`/`failed`/`blocked`). Exit after. |
| `find_up` | Get my direct parent agent. |
| `get_agent_profile` | Look up an agent's hierarchy + capacity + memory. |
| `get_task` | Fetch a task's full row (title, description, status). |
| `create_work_product` | Record a deliverable (PR/branch/commit/document/…). |
| `list_work_products` | List the task's deliverables (call this before `create_work_product` to dedupe). |
| `update_work_product` | Edit an existing deliverable. |
| `respond_ask` | Answer a peer who called `ask()` against me. |
| `report_blocker` | Tell my parent I can't proceed. Server uses my parent implicitly — top-level agents can't call this. Exit after. |

### Team / org additions (10 more tools, 22 total)

| Tool | Purpose |
|---|---|
| `find_subordinates` | List my direct reports. |
| `find_peers` | List same-level siblings. |
| `create_task` | Spawn new work for myself or a subordinate. |
| `check_work_status` | DB-only status check (no session spawn — use this instead of `ask` for status). |
| `revise_task` | Unblock a subordinate's blocked task with feedback. |
| `ask` | One-shot question to a peer. Spawns their CLI; blocks until they call `respond_ask`. |
| `negotiate` | Propose a multi-round deal with a team/org peer. Rejected against ICs. |
| `respond_negotiate` | Reply to an in-flight negotiation. |
| `escalate_to_humans` | Promote a stuck negotiation to a human decision. Exit after. |
| `add_to_escalation` | Join an escalation as the second party (sentinel-prompted). |

Tier filtering happens in `src/tools/assemble.ts:assembleTools(caller)`. Tool descriptions follow the Letta pattern — HOW + best practices + examples in the docstring; WHY + cadence in the system-prompt reminders that `AgentSession` injects.

## REST (human-facing, `bv_u_` only)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/task` | Create a task. |
| `POST` | `/task/:id/approve` | Approve (terminal `done`). |
| `POST` | `/task/:id/reject` | Reject (terminal `failed`). |
| `POST` | `/task/:id/revise` | Reopen with reviewer feedback. |
| `POST` | `/task/:id/cancel` | Abort a non-terminal task (PG-NOTIFY signals the executor). |
| `GET` | `/task` / `/task/:id` | Read-only views. |
| `GET` | `/agent` / `/agent/:id` | Read-only views. |
| `GET` | `/session/:short_id` | Session detail (for the UI's transcript view). |
| `GET` | `/memory/fact` | List facts (filter by scope/owner/type). |
| `GET` | `/promotion` | Memory-promotion audit log. |
| `GET` | `/mesh` / `/dashboard` | UI summary endpoints. |
| `POST` | `/escalation/:id/resolve` | Human decides; both parties get re-queued tasks with post-resolution context. |
| `GET` | `/api/stream` | Server-Sent Events for live updates (see below). |
| `GET` | `/health` | Public liveness. |

### Live updates

`GET /api/stream` opens a long-lived SSE connection. Internally it's PG `LISTEN/NOTIFY` (`task_updated`, `session_updated`, `memory.fact.created`, `promotion.created`, `mesh.activity`, …) bridged to `text/event-stream`. The web UI uses this to invalidate React Query caches; data refetches happen on the read endpoints above.

## Mesh

`MeshServer` (`src/mesh/server.ts`) is the in-process broker for agent-to-agent calls:

- **Capacity**: max 3 concurrent mesh sessions per agent (across `ask` / `negotiate` / `report_blocker`). Over capacity → fail-fast with `mesh_capacity_exceeded` to the caller.
- **Spawn**: when an agent calls `ask` / `negotiate`, the api server provisions the target's workspace and runs an `AgentSession` for them.
- **Resolver map**: the caller's tool call awaits a peer's `respond_ask` / `respond_negotiate`. Resolvers keyed by `request_id:role`.
- **Negotiation**: B-resident — agent B is spawned once on round 1, stays alive across rounds (max 5, configurable per-agent via `agent.max_negotiation_rounds`).
- **Escalation sentinel**: when one party calls `escalate_to_humans`, the peer's blocked `respond_negotiate` resolves with `{decision: "escalated", escalation_id}` and both sessions exit cleanly.

Caveat: resolver state is in-memory. An api restart drops in-flight mesh requests. Persistence is on the deferred list — see issue #6 design notes.

## Source layout

```
src/
├── main.ts          startup: env validation → bootstrap → listen
├── bootstrap.ts     composition root: pool + repos + services + routers
├── server.ts        Express app builder
├── auth/            bearer-token middleware + caller resolution
├── tools/           MCP tool definitions (assemble.ts is the inventory)
├── routes/          REST handlers (task, escalation, view routes)
├── mesh/            MeshServer (ask + negotiate brokering)
├── sse/             PG LISTEN/NOTIFY → SSE bridge
├── views/           shared response shapes for read endpoints
└── session-cache.ts MCP session cache (30-min idle sweep, fact promotion on evict)
```

## Build / test

```bash
pnpm --filter @beevibe/api build
pnpm --filter @beevibe/api typecheck
pnpm --filter @beevibe/api test
```
