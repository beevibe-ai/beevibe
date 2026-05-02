# Getting started with beevibe

A walkthrough of using beevibe end-to-end, from a fresh `git clone` to
running your first task. Targets a developer comfortable with a Node +
Postgres + Docker stack on macOS or Linux.

> **Self-hosted, single-user.** beevibe runs entirely on your machine.
> No SaaS account. No outbound traffic except to whichever LLM provider
> keys you supply. The bv_u_ token in `.env` is the only auth.

---

## What you're getting

beevibe is a team of AI agents you manage by chatting. There's one
**team agent** as your primary interface; it has full access to a
hierarchy of tools (mint tasks, query the fleet, escalate, write to
memory). When the team agent decides work needs doing, it spawns
**IC subordinates** in the executor; they run as Claude Code CLI
subprocesses with sandboxed workspaces and stream their progress back
to you.

The web UI is chat-first: `/` is the chat. The dashboard, tasks board,
mesh activity, memory facts, and promotion log are reachable in the
sidebar but secondary — they're things the chat agent can also surface
inline as cards or "Open this →" buttons in the conversation.

---

## Prerequisites

- **Node 20+** and **pnpm 9+**
- **Docker** (Docker Desktop on macOS works)
- **Claude Code CLI** on `PATH` (`claude` command) — agents are spawned
  as `claude` subprocesses in their own workspaces
- **Anthropic API key** (`sk-ant-...`) — for chat agents and memory
  fact merging/promotion
- **OpenAI API key** (`sk-...`) — for memory fact embeddings (1536-dim,
  text-embedding-3-small)

The init script checks for these and bails with a useful message if
anything's missing.

---

## Step 1: Install

```sh
git clone https://github.com/beevibe-ai/beevibe.git
cd beevibe
pnpm install
pnpm init
```

`pnpm init` is a one-shot first-run setup. It does six things, in
order, and is idempotent — re-running on a populated install is a
no-op:

1. **Create `.env`** from `.env.example` if missing.
2. **Prompt for `ANTHROPIC_API_KEY` + `OPENAI_API_KEY`** if `.env`
   has placeholders. The keys are written to `.env` only — never sent
   anywhere else by the script. (Once your stack is running, the api
   server reads them from the same `.env`.)
3. **Bring up Postgres** via `docker compose up -d postgres`. Waits
   for `pg_isready`.
4. **Apply migrations** via `pnpm migrate up`. About a dozen migrations
   on a fresh install; idempotent.
5. **Provision an admin person + team agent.** Mints a `bv_u_` API key
   for you (the human caller) and creates a team-tier agent owned by
   that person. The team agent is what you'll chat with. Your `bv_u_`
   key is written into `.env` as `NEXT_PUBLIC_BV_USER_KEY` so the web
   shell is connected on first start.
6. **Print "ready to start."**

Expect ~10 seconds end-to-end on a warm machine; longer the first
time as Docker pulls the `pgvector/pgvector:pg16` image.

---

## Step 2: Start the stack

```sh
pnpm dev
```

This spawns `@beevibe/api` (port 3000) and `@beevibe/executor` (health
on port 3001) as subprocesses, prefixing each one's logs in your
terminal:

```
[api] ready on port 3000
[exec] worker started, polling tasks
```

Optionally, the script also starts `cloudflared` to expose the api
publicly so a remote Claude CLI can connect — useful if you want to
spawn agents on a different machine. Skip with `pnpm dev --no-tunnel`.
For local single-user dev, it doesn't matter.

In a **second terminal**:

```sh
pnpm --filter @beevibe/web dev
```

Next picks the next free port (typically `3001` or `3002`). Open the
URL it prints.

---

## Step 3: First-run wizard

On first load, the browser lands on **`/welcome`** instead of `/`. The
sidebar is hidden — this is a focused wizard, not a chrome-laden page.

### Step 3a — Intro

> **Welcome to beevibe.**
> beevibe is a team of AI agents you manage by chatting with them.
>
> [diagram: You ↔ Team agent ↔ Subordinates]
>
> [ Set up my team agent → ]

One button. No account form — `pnpm init` already minted your admin
key and the browser inherited it via `.env`.

### Step 3b — Provider check

The wizard hits `GET /health/llm` on the api server. The api makes a
1-token Claude completion + a tiny OpenAI embedding in parallel and
reports each provider independently. You'll see two status rows:

- **Anthropic** ✓ powers your agents
- **OpenAI** ✓ memory + embeddings

If a key is bad, the row goes red with the provider's error message
inline (typically "401 Invalid API key"). Fix `.env`, restart `pnpm
dev`, click "Re-check." The "Continue" button stays disabled until
both pass — there's no point starting a chat if the LLM call will fail
mid-turn.

### Step 3c — Ready

> **You're set.**
> Your team agent will introduce itself and ask you a few questions on
> the next screen so it can save what it learns into its memory.
> Answer naturally — it watches you type and writes to memory live.
>
> [ Meet my team agent → ]

Clicking the button navigates to `/?from=welcome` (the param tells the
chat surface "the wizard sent you here, don't bounce me back to
/welcome"). The team agent has been pre-spawned and is waiting.

---

## Step 4: Your first chat — onboarding

Your first turn is in **onboarding mode**. The chat route detects this
because `person.onboarding_completed_at` is still NULL, and it appends
a special block to the team agent's system prompt that tells it:

- Greet warmly and briefly
- Ask three questions in one message: what you do, what work you'd
  like the agent to handle, how it should check in when unsure
- Use `update_core_memory` to save what it learns **as the conversation
  progresses** so you can see writes happen
- At the end, suggest 2-3 concrete first tasks based on what you told it

You'll see the empty state pre-load three onboarding-flavored prompt
suggestions:

- "Hi! Tell me what you're working on."
- "Introduce yourself."
- "What can you do for me?"

Click one, or type your own. The chat UI mints a session id
client-side and subscribes to `session.step` SSE events for that
session **before** the POST starts — so you watch the agent's tool
calls stream in real time during the 5-30s wait, not just a static
spinner. The thinking bubble shows the last 6 tool calls.

When the response arrives, the agent's text appears as a chat bubble.
If the agent mentioned any task / agent / session id, those render as
inline **reference cards** below the bubble — clickable, linked to the
detail page, hydrated by `useTask`/`useAgent`/`useSession` hooks.

If the agent emitted an `<open_view path="..." label="..."/>`
directive, the directive is parsed out, hidden from the visible text,
and rendered as a prominent **"Open this →"** CTA below the bubble.

The first successful turn flips `onboarding_completed_at` server-side
(fire-and-forget), the `useChat` hook invalidates the `me` query, and
the welcome wizard quietly disappears from your nav. From now on you
land directly at `/` and the chat is just a chat.

---

## Step 5: Daily use

### Mint a task by talking to your team agent

beevibe doesn't have a "+ New Task" button by design (see
[`feedback_no_direct_task_assignment`](../.claude-memory/...) — tasks
are minted through the team agent so the agent has full context). To
start work, just say what you want:

> *"Refactor the billing module to use the new pricing model. There's
> a sketch in `notes/billing-v2.md`."*

The team agent will:

1. **Search its memory** for relevant facts (you told it during
   onboarding what kind of code review you prefer? It'll use that.)
2. **Mint a task** via the `mint_task` MCP tool. The new task gets a
   `task_*` id and shows up in the Tasks board within seconds (live
   via SSE).
3. **Spawn an IC subordinate** if it has one, or **escalate** if it
   thinks the work needs another team agent's input.
4. **Reply with the `task_*` id** in its response. The id renders as a
   clickable card in the chat bubble. Optionally ends the message with
   `<open_view path="/tasks/task_xxx"/>` so you get a one-click jump
   to the detail page.

### Watch tasks execute

Click the task card or the "Open this →" CTA. The task detail page
shows:

- **Header:** title, status (pending → in_progress → done/blocked/failed),
  assignee agent
- **Sessions list:** every CLI invocation that worked on this task, with
  their result summaries
- **Work products:** files the agent produced, viewable inline
- **Briefing:** what was in the agent's context window at start of each
  session (memory blocks + facts retrieved by vector search)
- **Transcript:** every tool call the agent made (Read, Edit, Bash,
  etc.) — persisted to `session_event` and surfaced via `json_agg`

Sessions stream live: while one is running, the SSE channel pushes
`session.step` events that update the page in real time.

### When something goes wrong

If a session hits a blocker, the agent uses the `report_blocker` tool.
That spawns a "blocker" mesh session against the agent's parent (in
your single-user case: the team agent) so the parent can either revise
the task or escalate further. The blocker shows up on the **Mesh**
page in the activity feed.

If two agents disagree (`negotiate` tool), the negotiation rounds
appear on the Mesh page too. Both ask and blocker session types are
unified with negotiations in a single feed; filter buttons (All / ask
/ negotiate / blocker) narrow the view.

### Surface knowledge

The **Memory** page shows every `memory_fact` row across the fleet —
what each agent has learned. Each fact has a `scope` (ic / team / org)
which determines who else can see it via vector search. Promotions
(an LLM-driven decision to lift a fact from ic → team → org) are
audited in **Promotions**.

You can ask your team agent things like *"what does the billing agent
know about our pricing structure?"* and it'll search facts (via the
hierarchy tools) and summarize them back, with `agent_*` reference
cards.

### Conversation continuity

Every chat turn passes `prior_session_id` to the next, so the runtime
spawns Claude Code with `--resume` and the agent has the full
conversation context. Click "New conversation" in the chat header to
break the chain — useful when switching contexts ("now let's talk
about the marketing site").

---

## Reference: web surfaces

| Surface | URL | What it's for |
|---|---|---|
| Chat | `/` | Primary entry. Talk to your team agent. |
| Welcome | `/welcome` | First-run wizard. Auto-redirects to `/` once `onboarding_completed_at` is set. |
| Dashboard | `/dashboard` | KPIs (active sessions, in review, completed today, blocked) + status breakdown + fleet bars + 7-day trend + attention list. |
| Tasks | `/tasks` | Kanban board grouped by status. Search + filter by view (all / mine / sprint / timeline). |
| Task detail | `/tasks/[id]` | Sessions list, work products, briefing snapshot, controls (approve/reject/revise/cancel). |
| Session detail | `/tasks/[id]/sessions/[sid]` | Transcript, briefing, ask threads. |
| Agents | `/agents` | Org chart + specialization table. Provisional rendering until you have agents. |
| Agent detail | `/agents/[id]` | Core memory blocks, recent sessions, outgoing mesh hints, metrics. |
| Mesh | `/mesh` | Live mesh activity feed (asks / negotiations / blockers). Static graph layout. |
| Memory | `/memory` | Memory facts (working / semantic) with scope filters. |
| Promotions | `/promotions` | Audit log of FactPromoter decisions (promoted + rejected). |

Empty states across tasks, memory, and mesh point you back to chat
with an "Open chat" CTA — the implicit message being *the way you
populate this page is by talking to your team agent.*

---

## Reference: command-line

| Command | What it does |
|---|---|
| `pnpm init` | First-run setup. Idempotent. |
| `pnpm dev` | Bring up postgres + api + executor. `--no-tunnel` to skip cloudflared. |
| `pnpm dev` + `pnpm --filter @beevibe/web dev` | Full local stack with web UI. |
| `pnpm migrate up` / `pnpm migrate down` | Apply / roll back migrations. |
| `pnpm test` | Run unit tests across all packages. Integration tests need `DATABASE_URL_TEST`. |
| `pnpm typecheck` | TypeScript across all packages. |
| `pnpm lint` | ESLint across all packages. |

---

## Troubleshooting

**`pnpm init` says "Docker daemon isn't running."**
Start Docker Desktop. Mac: `open -a Docker`. Wait ~10 seconds, re-run.

**Web UI shows "Chat not connected."**
`NEXT_PUBLIC_BV_API_URL` or `NEXT_PUBLIC_BV_USER_KEY` is unset in
`.env`. Re-run `pnpm init` to repair.

**Welcome wizard's "Anthropic" check fails with 401.**
The key in `.env` is wrong or expired. Update `ANTHROPIC_API_KEY`,
restart `pnpm dev`, click "Re-check."

**Chat reply takes 30+ seconds.**
Expected for a turn that involves multiple tool calls. The streaming
step list under "thinking…" shows real progress. If it stalls (no new
steps for 60s), check `[exec]` logs — Claude Code may be wedged.

**The agent doesn't emit `<open_view>` directives.**
The directive lives in `CHAT_DIRECTIVES` (per-call, in the api's chat
route). Older Claude models occasionally ignore the directive on the
first turn; subsequent turns adhere. Not load-bearing — the reference
cards still hydrate from id mentions.

**`pnpm migrate up` fails with "relation already exists."**
You probably ran migrations twice against the same DB. `pnpm migrate
down` once then `up` again to re-establish a clean state, or drop the
db and recreate.

**The team agent doesn't have an api_key.**
Re-run `pnpm init` — it'll detect the existing person but missing
agent and re-provision just the team agent.

---

## What's deliberately not done yet

- **Multi-user / SaaS.** beevibe is single-user self-hosted today.
  Multi-tenant would need owner-aware SSE filtering and per-tenant
  resource limits.
- **Async chat.** Each chat turn blocks the request for 5-30s. Fine
  for a single user; not for production scale. The streaming step
  events make the wait tolerable.
- **Provider rate-limiting.** `/health/llm` is auth'd but unmetered.
  Spam-clicking "Re-check" in the wizard costs ~$0.0005 per click.
- **Provider keys via UI.** Today keys live in `.env`. Editing them
  via the web would need a config table + provider re-init.
- **Onboarding resume.** If you close the browser mid-wizard, you'll
  re-enter it from step 1 (until you complete the first chat turn,
  which sets `onboarding_completed_at`).
- **Team-agent name change.** The default name is "Team agent." There's
  no UI to rename it; ask the agent itself ("what would you like to be
  called?") and it'll use `update_agent` if it has the tool.

If you hit something not covered here, the source is the doc — start
at `packages/api/src/bootstrap.ts` for the api wiring or
`packages/web/app/(authed)/chat/chat-client.tsx` for the chat UI.
