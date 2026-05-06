# @beevibe/web

The Next.js dashboard. Humans use this to view agents, watch tasks move through their lifecycle, read session transcripts, browse memory, and approve/revise/cancel work.

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

To mint a `bv_u_` key for local dev, run `pnpm tsx scripts/provision-demo.ts` from the repo root — it creates a captain + IC team and prints the token (along with a paste-ready `mcp.json` snippet, separately useful for the Claude CLI smoke).

## Pages

All pages live under `app/(authed)/` — there's no public surface and no login flow yet (token is sourced from the env var above).

| Path | What you see |
|---|---|
| `/` | Home dashboard — KPI tiles, fleet status bars, task breakdown |
| `/tasks` | Kanban board grouped by lifecycle (backlog / ready / running / done / archived); filterable by view, assignee, lifecycle |
| `/tasks/:id` | Task detail — metadata, sessions rail, controls (approve / reject / revise / cancel) |
| `/tasks/:id/sessions/:sid` | Session transcript + escalation-resolution UI |
| `/agents` | Agent list with hierarchy and organization layout |
| `/memory` | Fact browser with scope tabs (`ic` / `team` / `org`) |
| `/mesh` | Agent-to-agent activity feed + request graph |
| `/promotions` | Audit log of memory facts that the promoter elevated across scopes |

## Data flow

```
Browser ──HTTP──> @beevibe/api  ──SQL──> Postgres
   ▲                  │
   └───SSE(/api/stream)┘   ←── PG NOTIFY
```

- **Reads** go through `lib/api/client.ts` — a tiny fetch wrapper around `@beevibe/api`'s read endpoints (`GET /task`, `GET /agent`, `GET /memory/fact`, `GET /session/:short_id`, …). Wrapped in [TanStack Query](https://tanstack.com/query) for caching + retries.
- **Mutations** call the same client (`POST /task/:id/approve`, `POST /escalation/:id/resolve`, …). On success, React Query invalidates the relevant keys.
- **Live updates** flow via `useLiveUpdates()` (`lib/sse.ts`). It opens an `EventSource` to `/api/stream` (token passed as `?token=` because `EventSource` can't set headers), and on each `task.updated` / `session.updated` / `memory.fact.created` / etc. invalidates the matching React Query keys — pages refetch automatically.

The web package only imports `@beevibe/core` for **types** (`TaskStatus`, `MemoryScope`, `HierarchyLevel`, …). It never touches the database directly.

## Source layout

```
app/
├── layout.tsx          root layout, theme provider
├── providers.tsx       QueryClientProvider + useLiveUpdates
├── globals.css         Tailwind + CSS variables (light/dark)
└── (authed)/           every page lives under this group
    ├── page.tsx        home / dashboard
    ├── tasks/
    ├── agents/
    ├── memory/
    ├── mesh/
    └── promotions/

components/
├── tasks/, agents/, memory/, mesh/, promotions/, sessions/
├── kpi-tile.tsx, status-pill.tsx, priority-pill.tsx, …
└── skeletons/          loading states for every list/detail page

lib/
├── api/client.ts       fetch wrapper around @beevibe/api
├── sse.ts              useLiveUpdates() — EventSource → React Query invalidate
└── types.ts            UI-only shapes
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
