# @beevibe/api

The API server. One Node binary that wears three hats:

1. **MCP server for agents** — exposes the tool surface that spawned `claude` CLIs call into (save memory, ask peers, report blockers, create tasks, …).
2. **REST + SSE server for humans** — endpoints that the [web UI](../web) and CLI tooling use to view / approve / revise tasks, chat with agents, manage rooms and runtimes, and resolve escalations.
3. **Daemon control plane** — `/runtime/*` HTTP + `/runtime/ws` WSS that the local [`@beevibe/daemon`](../daemon) processes use to register, claim sessions, heartbeat, and stream events back.

It also contains the in-process `MeshServer` (agent-to-agent `ask` / `negotiate` broker), `DaemonHub` (in-memory WS client registry indexed by `runtime_id`), and `ChatResolver` (per-session promise registry that unblocks `POST /chat` when `/runtime/done` lands).

If you're running beevibe locally, you don't start this directly — `pnpm dev` at the repo root brings up Postgres + api + scheduler. Real CLI dispatch happens on a daemon, which the user runs separately.

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
| `BEEVIBE_MCP_SERVER_URL` | The URL spawned agents will call back to (e.g. `http://localhost:3000/mcp`). Embedded in each agent's `mcp-config.json` at spawn time (by the daemon, or by the scheduler fallback for null-runtime agents). |
| `OPENAI_API_KEY` | Embeddings (memory recall) |
| `ANTHROPIC_API_KEY` | LLM (fact merging + promotion) |

Optional:

| Var | Default | Purpose |
|---|---|---|
| `PORT` | (unset) | PaaS-style override; takes precedence over `BEEVIBE_API_PORT`. |
| `BEEVIBE_API_PORT` | `3000` | HTTP listen port. |
| `BEEVIBE_CORS_ORIGINS` | (localhost only) | Comma-separated extra cross-origin allowlist for browser clients. |
| `BEEVIBE_SIGNUP_ENABLED` | `1` | Set `0` to 404 `/signup` and `/signin`. |
| `WORKSPACE_ROOT` | `~/.beevibe/workspaces` | Per-agent sandbox root (server-fallback spawns only). |
| `BEEVIBE_SKILLS_DIR` | `<repo>/skills` | Source dir for skill sync. |

`GET /health` (no auth) returns `{ ok, version }` and is suitable for liveness probes.

## Auth

Bearer tokens, three prefixes:

- `bv_a_…` — **agent** key. Permits MCP calls on `/mcp/*`. Tier-gated by `agent.hierarchy_level` (`ic` / `team` / `org`).
- `bv_u_…` — **user** key. Permits REST mutations on `/task/*`, `/escalation/*`, `/room/*`, `/agent/*`, `/chat/*`, `/runtimes/*`, `/runtime/register`, and SSE on `/api/stream`.
- `bv_d_…` — **daemon** key. Minted by `POST /runtime/register` (called with a `bv_u_` key); shown to the daemon once and stored hashed (SHA-256) in the `daemon` row. Permits `/runtime/heartbeat|claim|events|done|skills` and the `/runtime/ws` upgrade.

The token is taken from the `Authorization: Bearer …` header (or `?token=…` query param for SSE — `EventSource` can't set headers). Validation routes to `@beevibe/core/auth.lookupApiKey` and the resolved caller is attached to `req.caller`. Each handler narrows the variant via `requireHuman` / `requireAgent` / `requireDaemon`.

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

### Team / org additions (11 more tools, 23 total)

| Tool | Purpose |
|---|---|
| `find_subordinates` | List my direct reports. |
| `find_peers` | List same-level siblings. |
| `create_task` | Spawn new work for myself or a subordinate. |
| `create_subordinate_agent` | Provision a new IC subordinate under me. Per-parent daily cap; writes a row to `agent_provision_event`. |
| `check_work_status` | DB-only status check (no session spawn — use this instead of `ask` for status). |
| `revise_task` | Unblock a subordinate's blocked task with feedback. |
| `ask` | One-shot question to a peer. Spawns their CLI; blocks until they call `respond_ask`. |
| `negotiate` | Propose a multi-round deal with a team/org peer. Rejected against ICs. |
| `respond_negotiate` | Reply to an in-flight negotiation. |
| `escalate_to_humans` | Promote a stuck negotiation to a human decision. Exit after. |
| `add_to_escalation` | Join an escalation as the second party (sentinel-prompted). |

Tier filtering happens in `src/tools/assemble.ts:assembleTools(caller)`. Tool descriptions follow the Letta pattern — HOW + best practices + examples in the docstring; WHY + cadence in the system-prompt reminders that `AgentSession` injects.

When a mesh `ask` / `negotiate` target's daemon is offline at dispatch, the api spawns the responder server-side under `spawn_mode='server_fallback_mesh'` with a restricted surface — `filterForServerFallback` strips `create_task`, `create_subordinate_agent`, `update_work_product`, `revise_task`, and `add_to_escalation` so the offline-fallback agent can answer the ask but can't mutate state.

## REST (human-facing, `bv_u_` only)

### Tasks + escalations

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/task` | Create a task. |
| `POST` | `/task/:id/approve` | Approve (terminal `done`). |
| `POST` | `/task/:id/reject` | Reject (terminal `failed`). |
| `POST` | `/task/:id/revise` | Reopen with reviewer feedback. |
| `POST` | `/task/:id/cancel` | Abort a non-terminal task (PG-NOTIFY signals the scheduler's `cancel-listener` for in-process spawns; daemon-bound sessions are cancelled by the daemon's WS handler). |
| `POST` | `/escalation/:id/resolve` | Human decides; both parties get re-queued tasks with post-resolution context. |

### Chat + rooms

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/chat` | Send a turn to the caller's team agent. Dispatches via `DispatchService`; awaits `ChatResolver` for the response. 503 `agent_offline` if the daemon isn't reachable. |
| `GET` | `/chat` | History for a conversation (or the latest if none specified). |
| `GET` | `/chat/conversations` | Sidebar list of past conversations. |
| `POST` | `/room` | Create a room. |
| `GET` | `/room` / `/room/:id` | List + detail. |
| `POST` | `/room/:id/join` | Add caller to room. |
| `POST` | `/room/:id/invite` | Invite another person/agent. |
| `POST` | `/room/:id/message` | Post a message; `@mentions` dispatch a session for the mentioned agent. |

### Runtimes panel (worker daemons)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/runtimes` | List the caller's daemons + runtimes, with online status from `DaemonHub.isOnline`. |
| `POST` | `/runtimes/:id/revoke` | Revoke a daemon (kills WS, marks row revoked). |

### Daemon control plane (`bv_d_` only)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/runtime/register` | (`bv_u_`) Register a daemon + its detected runtimes. Returns `bv_d_` token (shown once). |
| `POST` | `/runtime/heartbeat` | Liveness ping (15s cadence). |
| `POST` | `/runtime/claim` | Atomically claim the next session pinned to one of my runtimes; returns intent + workspace + agent context, or 204 if nothing waiting. |
| `POST` | `/runtime/events` | Append session events (tool calls, agent messages) — fan to `session.event` SSE. |
| `POST` | `/runtime/done` | Finalize a session; resolves any blocked `ChatResolver` / mesh resolver. |
| `GET` | `/runtime/skills` | All skill bundles + SHA-256 version, for daemon-side cache. |
| `GET` | `/runtime/ws` | WSS upgrade for low-latency push (`task_available`, `cancel`). |

### Identity + onboarding

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/me` | Resolved caller (person + team agent). Used by the web `<AuthGate>`. |
| `POST` | `/me/onboarding/complete` | Flip `person.onboarding_completed_at`. |
| `GET` | `/health/runtime` | Caller's daemon liveness summary, for the welcome wizard's "verify daemon" step. |
| `POST` | `/signup` | Email + password. (Public; gated by `BEEVIBE_SIGNUP_ENABLED`.) |
| `POST` | `/signin` | Email + password. (Public.) |
| `POST` | `/newsletter/subscribe` | Email capture for the public community newsletter. (Public.) |

### Read-only views

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/task` / `/task/:id` | Task list / detail. |
| `GET` | `/agent` / `/agent/:id` | Agent list / detail. |
| `GET` | `/agent/network` | Cross-tenant agent graph for the team-orbit visualization. |
| `POST` | `/agent/:id/runtime\|model\|review-policy\|core-memory/:block\|archive` | Owner-only mutations on agent config + memory. |
| `GET` | `/session/:short_id` | Session detail (transcript view). |
| `GET` | `/memory/fact` | List facts (filter by scope/owner/type). |
| `DELETE` | `/memory/fact/:id` | Delete a fact (owner-only). |
| `GET` | `/promotion` | Memory-promotion audit log. |
| `GET` | `/work-product/:id` | Work-product detail. |
| `GET` | `/inbox` | Caller's pending review/decisions. |
| `GET` | `/activity` | Cross-resource activity feed. |
| `GET` | `/mesh` | Mesh activity + request graph. |
| `GET` | `/dashboard` | Home KPI summary. |

### Streaming

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/stream` | Server-Sent Events for live updates (see below). |
| `GET` | `/health` | Public liveness. |

### Live updates

`GET /api/stream` opens a long-lived SSE connection. Internally it's PG `LISTEN bv_event` — a single channel on which DB triggers `pg_notify` events whose names match a fixed registry. Currently emits 12 event types: `task.created`, `task.updated`, `agent.updated`, `session.updated`, `session.event`, `session.step`, `memory.fact.created`, `memory.fact.deleted`, `promotion.created`, `mesh.activity`, `runtime.updated`, `room.message`.

`session.step` carries inline data (tool name, content preview ≤512 chars) so the chat live panel can render without a refetch; every other event is `{event, id}`-only — the browser invalidates the matching React Query keys via `web/lib/sse.ts:eventInvalidations` and refetches the read endpoints above.

## Mesh

`MeshServer` (`src/mesh/server.ts`) is the in-process broker for agent-to-agent calls:

- **Capacity**: max 3 concurrent mesh sessions per agent (across `ask` / `negotiate` / `report_blocker`). Over capacity → fail-fast with `mesh_capacity_exceeded` to the caller.
- **Spawn**: when an agent calls `ask` / `negotiate`, `MeshServer` dispatches a pending mesh session via `DispatchService`. The target's daemon claims and spawns; if the daemon is offline, the api spawns server-side under `server_fallback_mesh` with a restricted tool surface (see §MCP tools).
- **Resolver map**: the caller's tool call awaits a peer's `respond_ask` / `respond_negotiate`. Resolvers keyed by `request_id:role`.
- **Negotiation**: B-resident — agent B is spawned once on round 1, stays alive across rounds (max 5, configurable per-agent via `agent.max_negotiation_rounds`).
- **Escalation sentinel**: when one party calls `escalate_to_humans`, the peer's blocked `respond_negotiate` resolves with `{decision: "escalated", escalation_id}` and both sessions exit cleanly.

Caveat: resolver state is in-memory. An api restart drops in-flight mesh + chat requests. Cross-instance federation via `pg_notify` is in the plan for Phase 6.

## Source layout

```
src/
├── main.ts             startup: env validation → bootstrap → listen
├── bootstrap.ts        composition root: pool + repos + services + routers
├── server.ts           Express app builder
├── cors.ts             CORS allowlist (BEEVIBE_CORS_ORIGINS + localhost)
├── auth/               bearer-token middleware (bv_a_/bv_u_/bv_d_)
├── tools/              MCP tool definitions (assemble.ts is the inventory)
├── routes/             REST handlers — chat, room, runtimes, me, signup,
│                       signin, task, escalation, view (read-only),
│                       stream (SSE), mcp, health, directives
├── runtime/            daemon control plane: HTTP /runtime/* (router.ts),
│                       WSS /runtime/ws (ws-server.ts), in-mem DaemonHub
│                       (hub.ts), per-session ChatResolver (chat-resolver.ts)
├── mesh/               MeshServer (in-process A2A broker)
├── sse/                pg LISTEN bv_event → SseManager fanout, OwnerLookup
├── views/              direct-pg DTO composers for read endpoints
└── session-cache.ts    MCP session cache (idle sweep, fact promotion on evict)
```

## Build / test

```bash
pnpm --filter @beevibe/api build
pnpm --filter @beevibe/api typecheck
pnpm --filter @beevibe/api test
```
