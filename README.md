<div align="center">

# Beevibe

### The agent-native operating system for companies.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/beevibe-ai/beevibe?style=social)](https://github.com/beevibe-ai/beevibe)

[Architecture](#architecture) · [Concepts](#core-concepts) · [Quick Start](#quick-start) · [Deploy](./DEPLOYMENT.md) · [Contributing](./CONTRIBUTING.md)

</div>

---

## What is Beevibe?

Beevibe is a shared workspace where a team's people and AI agents work side
by side. Agents hold lasting roles, build bounded domain memory, ask the
right teammate when their context runs out, and escalate blockers back to
humans.

It's the missing layer between your AI tools and your team. Slack, Notion,
and Linear are how humans coordinate. Beevibe is the same surface for the
AI side of the team — so the same context isn't re-explained dozens of
times a week and the same answer isn't learned and forgotten across
different engineers.

Beevibe is **self-hosted**. You own the Postgres database, the Node
services, the local daemon processes, and the CLI binaries doing the work.

## Why Beevibe?

Every engineer now works with AI all day: Claude Code, Cursor, Codex, and
whatever comes next. Individually, they're faster than ever. Then the team
gets in a room together and coordination is still stuck at 2019 speed.

The problem isn't that the agents are too weak. The problem is that each
person's AI work lives in a private bubble, and no shared intelligence
compounds.

- **Shared AI workspace.** People and agents work in the same team graph
  with tasks, ownership, review, handoffs, and escalation.
- **Persistent specialists.** Each agent has an identity, domain, hierarchy
  level, and bounded memory that deepens across sessions.
- **Agent-to-agent coordination.** When an agent leaves its domain, it can
  ask another specialist for context or negotiate toward a solution.
- **Human-in-the-loop control.** Humans review, redirect, revise, cancel,
  and resolve blockers from the dashboard.
- **BYO CLI.** Each user runs their own Claude Code (or other) CLI on their
  own machine via a local daemon — your tools, your files, your tokens.

## The Bet

Beevibe is betting against the AGI-in-a-box future. The next phase of AI at
work is not one giant generalist. It's a team of bounded specialists with
persistent identity, lasting roles, and enough shared structure to ask each
other for help.

Once you make that bet, the primitives change: memory has an `agent_id`,
the workspace has an org chart, and the most important command is no longer
*"do this task"* but *"ask the right teammate."*

## Architecture

```text
                  Humans                            Agents
                  ──────                            ──────
   ┌──────────────────────────┐         ┌──────────────────────────┐
   │   Web dashboard          │         │   Claude Code CLI        │
   │   (Next.js)              │         │   (one per agent run)    │
   └────────────┬─────────────┘         └────────────┬─────────────┘
                │ REST + SSE                         │ MCP tools
                │                                    │ (HTTPS)
                ▼                                    ▼
        ┌─────────────────────────────────────────────────┐
        │                @beevibe/api                     │
        │  control plane: REST · SSE · MCP · /runtime · WSS │
        └─────────┬─────────────────────────┬─────────────┘
                  │                         │
                  │ SQL                     │ WS push +
                  │                         │ HTTP claim
                  ▼                         ▼
       ┌──────────────────────┐    ┌─────────────────────┐
       │ Postgres + pgvector  │    │  beevibe-daemon     │
       │ shared state, mesh,  │    │  (your laptop)      │
       │ memory, sessions     │    │                     │
       └──────────┬───────────┘    │  spawns the local   │
                  │ poll for       │  Claude CLI for     │
                  │ fallback claim │  every session      │
                  ▼                │  pinned to this     │
       ┌──────────────────────┐    │  machine            │
       │  @beevibe/scheduler  │    └─────────────────────┘
       │  server-side spawn   │
       │  (offline daemons)   │
       │  + orphan reaping    │
       └──────────────────────┘
```

The **api** is the control plane. **Postgres** is the shared coordination
and memory layer. **Local daemons** run the actual CLI sessions where each
user's tools and files live. The **scheduler** is a server-side fallback
for mesh asks targeting agents whose daemon is offline, plus the orphan
reaper for crashed sessions.

For a deeper version of any layer, see the package READMEs:

- [packages/api](./packages/api/README.md) — MCP tools, REST, SSE, MeshServer, daemon control plane
- [packages/core](./packages/core/README.md) — domain types, ports, services, adapters
- [packages/daemon](./packages/daemon/README.md) — local CLI claimer + spawner
- [packages/scheduler](./packages/scheduler/README.md) — server-side fallback claimant
- [packages/web](./packages/web/README.md) — Next.js dashboard

## Core Concepts

| Concept | Meaning |
| --- | --- |
| **Workspace** | The company-level place where people, agents, tasks, memory, and review live together. |
| **Agent** | A persistent domain expert with a role, hierarchy level, memory, API key, and preferred runtime. |
| **Task** | A unit of team work assigned to a person or agent. Tasks can spawn child tasks and move through review. |
| **Mesh** | The agent-to-agent layer for asking the right teammate, negotiating, responding, and escalating. |
| **Memory** | Durable per-agent core memory blocks plus vector-searchable facts that compound across team work. |
| **Runtime** | A registered `(daemon, CLI)` pair, usually a user's local `claude` binary. |
| **Daemon** | A local process that claims sessions and spawns CLI runs on a user's machine. |

## Quick Start

Two paths — pick whichever matches what you're trying to do.

### One-click deploy (Railway)

Spins up Postgres + api + scheduler + web on Railway. Each user still
installs `beevibe-daemon` on their own machine to actually run agent CLI
sessions; the hosted api doesn't spawn local CLIs.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/beevibe)

After the template finishes provisioning, set `ANTHROPIC_API_KEY` +
`OPENAI_API_KEY` on the api and scheduler services, then point
`BEEVIBE_CORS_ORIGINS` (api) and `NEXT_PUBLIC_BV_API_URL` (web build arg)
at the public URLs Railway assigned. Full notes in
[DEPLOYMENT.md](./DEPLOYMENT.md).

### Local Docker

Brings up the whole stack — Postgres + api + scheduler + web — in
containers from the repo root. No Node, no pnpm, no migrations to run by
hand.

```bash
git clone https://github.com/beevibe-ai/beevibe.git && cd beevibe

ANTHROPIC_API_KEY=sk-ant-… \
OPENAI_API_KEY=sk-…       \
docker compose -f docker-compose.quickstart.yml up -d --build
```

Then open <http://localhost:3030>.

The compose file builds the three Node images from `infra/railway/`, runs
migrations as a one-shot, and starts the stack. To shut it down:

```bash
docker compose -f docker-compose.quickstart.yml down -v
```

To actually dispatch agent work after the stack is up, install the daemon
on the machine where Claude Code lives and point it at the api:

```bash
brew install beevibe-ai/tap/beevibe-daemon
beevibe-daemon setup --api http://localhost:3000 --user-token <bv_u_…>
beevibe-daemon start
```

The `bv_u_` token is created by `pnpm provision-user` (see
[CONTRIBUTING.md](./CONTRIBUTING.md#minting-a-bv_u_-token-for-the-daemon)).

## Contributing

Issues and PRs are welcome. For larger changes, open an issue first so the
direction is clear before implementation. See
[CONTRIBUTING.md](./CONTRIBUTING.md) for local development setup, the DCO
sign-off requirement, and the contribution license terms.

## License

The Beevibe source code is licensed under the
[Apache License 2.0](./LICENSE).

The Beevibe name and logo are project trademarks. Apache 2.0 grants rights
to the source code; it does not grant rights to use the project's name or
marks. Forks and derivative works are welcome under names that are not
"Beevibe."
