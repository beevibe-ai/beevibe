# @beevibe/web

The Next.js dashboard. Humans use this to chat with their team agents, watch tasks move through their lifecycle, read session transcripts, browse memory, manage rooms with their teammates, and approve / revise / cancel work — plus a Runtimes panel to register and monitor the local daemons that actually run the agent CLIs.

It's a thin, read-mostly UI — there are **no API routes** in this package. All data goes through [`@beevibe/api`](../api), and live updates arrive over SSE from `GET /api/stream` on that server. For full setup, see the [root README](../../README.md).

## Run it

```bash
pnpm --filter @beevibe/web dev    # Next.js dev server
```

Next.js defaults to port 3000, which collides with the api's default. Either run the api on a different port (`BEEVIBE_API_PORT=3001 pnpm dev`) or run web on a different port (`pnpm --filter @beevibe/web dev -- -p 3030`).

## Env vars

| Var | Required | Example | Purpose |
|---|---|---|---|
| `NEXT_PUBLIC_BV_API_URL` | yes\* | `http://localhost:3000` | Origin of the api server (no `/mcp` suffix). |
| `NEXT_PUBLIC_BV_USER_KEY` | yes\* | `bv_u_…` | Bearer token sent on every request. |

\* When unset, the app boots but every page renders an empty/not-configured state. Useful for layout work without a backing api.

`pnpm bootstrap` writes both vars into `packages/web/.env.local` when it provisions the admin user. To mint a fresh `bv_u_` key for a demo run, `pnpm tsx scripts/provision-demo.ts` from the repo root creates a captain + IC team and prints the token.

## Auth

Authenticated pages live under `app/(authed)/` and are gated by `<AuthGate>` (`components/auth-gate.tsx`). The gate hits `GET /me` to resolve the caller; on `401` it redirects to `/sign-in`.

Public pages (no auth):

- `/sign-in` — email + password
- `/sign-up` — email + password (gated server-side by `BEEVIBE_SIGNUP_ENABLED`)
- `/welcome` — post-signup wizard: install daemon, verify runtimes, meet your team agent
- `/community` — public pattern index and newsletter signup

The `bv_u_` token is sourced from `NEXT_PUBLIC_BV_USER_KEY` for now (single-tenant local dev) — sign-in / sign-up live API endpoints exist on the api side and the wizard reads from them, but the production token-storage flow is still in progress.

## Pages

| Path | What you see |
|---|---|
| `/` | Redirects to `/dashboard`. |
| `/dashboard` | Home — KPI tiles, fleet status bars, task breakdown. |
| `/chat` | Multi-agent chat surface. Sidebar lists conversations; main pane streams the active turn token-by-token (via `lib/chat-stream.ts`); live panel shows tool steps. |
| `/sessions/:sid` | Chat-session detail — full transcript, usage panel, daemon `Ran on …` line. |
| `/agents` | Agent list with hierarchy. |
| `/agents/:id` | Agent detail — core memory blocks, depth metrics, recent sessions. |
| `/tasks` | Kanban board grouped by lifecycle (backlog / ready / running / done / archived); filterable by view, assignee, lifecycle. |
| `/tasks/:id` | Task detail — metadata, sessions rail, controls (approve / reject / revise / cancel). |
| `/tasks/:id/sessions/:sid` | Task-session transcript + escalation-resolution UI. |
| `/work-products/:id` | Work-product detail (PR / branch / commit / document / …). |
| `/memory` | Fact browser with scope tabs (`ic` / `team` / `org`). |
| `/promotions` | Audit log of memory facts that the promoter elevated across scopes. |
| `/mesh` | Agent-to-agent activity feed + request graph. |
| `/rooms` | Shared rooms list. |
| `/rooms/:id` | Room detail — team-orbit visualization (`components/team-orbit.tsx`), message stream, mention picker. |
| `/runtimes` | Worker daemon panel — list of registered daemons + their CLIs, online/offline badges (live via `runtime.updated` SSE), revoke action, install instructions for fresh machines. |
| `/community` | Public community surface for pattern curation and newsletter capture. |

`/community` is shaped around the ADR visual-report contract
(`lib/community/adr-visual-report.ts`). Fresh ADR runs can be converted into
the same visual primitives with `pnpm adr:visual <.adr-runs/run-name>`.

## Data flow

```
Browser ──HTTP──> @beevibe/api  ──SQL──> Postgres
   ▲                  │
   │                  │
   ├──SSE invalidate──┤
   │ (lib/sse.ts)     │
   │                  │
   └─SSE token stream─┘
     (lib/chat-stream.ts, /chat only)
                                 ←── PG NOTIFY (bv_event)
```

- **Reads + mutations** go through domain hooks under `lib/hooks/` (`use-chat`, `use-tasks`, `use-agents`, `use-rooms`, `use-runtimes`, …) — each one wraps `lib/api/client.ts` (the typed fetch wrapper) in [TanStack Query](https://tanstack.com/query). Query keys are centralized in `lib/hooks/keys.ts`.
- **Live invalidations** flow via `useLiveUpdates()` (`lib/sse.ts`). It opens an `EventSource` to `/api/stream` (token passed as `?token=` because `EventSource` can't set headers) and on each event (`task.created`, `task.updated`, `agent.updated`, `session.updated`, `session.event`, `session.step`, `memory.fact.created`, `memory.fact.deleted`, `promotion.created`, `mesh.activity`, `runtime.updated`, `room.message`) invalidates the matching React Query keys — pages refetch automatically. The `eventInvalidations` map in `lib/sse.ts` is the canonical event → keys registry.
- **Chat token stream** is separate. `lib/chat-stream.ts` opens its own SSE connection that carries inline tool-step / agent-message tokens for the active chat turn. Distinct from the invalidation channel because it streams data, not "go refetch X."

The web package only imports `@beevibe/core` for **types** (`TaskStatus`, `MemoryScope`, `HierarchyLevel`, `KnownCli`, …) via the `@beevibe/core/domain` browser-safe subpath. It never touches the database directly.

## Source layout

```
app/
├── layout.tsx          root layout, theme provider
├── providers.tsx       QueryClientProvider + useLiveUpdates
├── globals.css         Tailwind + CSS variables (light/dark)
├── not-found.tsx       404
├── sign-in/            sign-in form
├── sign-up/            sign-up form
├── welcome/            post-signup wizard
└── (authed)/           gated by <AuthGate>
    ├── layout.tsx      auth-gate + sidebar shell
    ├── page.tsx        / → /dashboard redirect
    ├── dashboard/
    ├── chat/
    ├── sessions/[sid]/
    ├── agents/, agents/[id]/
    ├── tasks/, tasks/[id]/, tasks/[id]/sessions/[sid]/
    ├── work-products/[id]/
    ├── memory/
    ├── promotions/
    ├── mesh/
    ├── rooms/, rooms/[id]/
    └── runtimes/

components/
├── auth-gate.tsx                 route gate (calls GET /me)
├── sidebar.tsx, mode-sidebars.tsx app shell
├── user-widget.tsx, theme-toggle.tsx
├── team-orbit.tsx                 room visualization
├── daemon-install.tsx             install instructions for /runtimes empty state
├── chat/, agents/, tasks/, sessions/, memory/, mesh/, promotions/, home/, detail/
├── agent-chip.tsx, hier-chip.tsx, scope-chip.tsx, fact-type-tag.tsx
├── task-status-icon.tsx, command-block.tsx, rich-text.tsx, relative-time.tsx
├── avatar.tsx, empty-state.tsx, load-older-button.tsx
└── skeleton.tsx, skeletons.tsx

lib/
├── api/                 typed fetch wrapper (client.ts) + http.ts + config.ts
├── hooks/               domain hooks per resource (use-chat, use-tasks, use-agents, …)
│                        + keys.ts (centralized React Query key factory)
├── types/               UI-only shapes split per domain
├── sse.ts               useLiveUpdates() — EventSource → React Query invalidate
├── chat-stream.ts       chat token stream (separate SSE channel)
├── dashboard-display.ts, mesh-display.ts, mesh-layout.ts
├── tasks-grouping.ts, tool-format.ts, usage-format.ts, format.ts
└── utils.ts
```

## Styling

- [Tailwind CSS](https://tailwindcss.com/) for utilities; theme tokens in `globals.css`.
- [`lucide-react`](https://lucide.dev/) for icons.
- Light/dark toggle persisted to `localStorage`.

## Build / test

```bash
pnpm --filter @beevibe/web build       # next build
pnpm --filter @beevibe/web start       # production server
pnpm --filter @beevibe/web typecheck
pnpm --filter @beevibe/web test        # vitest + @testing-library/react
```

Tests colocate next to components (`*.test.tsx`).
