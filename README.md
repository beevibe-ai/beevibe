<div align="center">

# Beevibe

## The agent-native operating system for companies.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-43853d.svg)](./package.json)
[![pnpm](https://img.shields.io/badge/pnpm-9-F69220.svg)](./package.json)

Beevibe is a shared workspace where a team's people and AI agents work side by
side. Agents hold lasting roles, build bounded domain memory, ask the right
teammate when their context runs out, and escalate blockers back to humans.

[Quick Start](#quick-start) | [Architecture](#architecture) |
[Deployment](./DEPLOYMENT.md)

</div>

## Why Beevibe?

Every engineer now works with AI all day: Claude Code, Cursor, Codex, and
whatever comes next. Individually, they are faster than ever. Then the team
gets in a room together and coordination is still stuck at 2019 speed.

The problem is not that the agents are too weak. The problem is that each
person's AI work lives in a private bubble. The same context gets re-explained
dozens of times a week, the same answer gets learned and forgotten across
different engineers, and no shared intelligence compounds.

Teams solved this for humans with Slack, Notion, and Linear. Beevibe is that
missing layer for the AI side of the team.

- **Shared AI workspace.** People and agents work in the same team graph,
  with tasks, ownership, review, handoffs, and escalation.
- **Persistent specialists.** Each agent has an identity, domain, hierarchy
  level, and bounded memory that deepens across sessions.
- **Agent-to-agent coordination.** When an agent leaves its domain, it can ask
  another specialist for context or negotiate toward a solution.
- **Human-in-the-loop control.** Humans review, redirect, revise, cancel, and
  resolve blockers from the dashboard.

Beevibe is self-hosted. You own the Postgres database, the Node services, the
local daemon processes, and the CLI binaries doing the work.

## Quick Start

Prerequisites: Node.js 20+, pnpm 9, Docker, the Claude Code CLI on `PATH`,
and provider keys for `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`. Run
`claude login` once before dispatching real agent work.

```bash
git clone https://github.com/beevibe-ai/beevibe.git && cd beevibe
pnpm install && pnpm bootstrap
pnpm dev
```

In a second terminal, start the dashboard:

```bash
pnpm --filter @beevibe/web dev -- -p 3030
```

Open `http://localhost:3030`.

`pnpm bootstrap` creates `.env`, starts local Postgres, runs migrations, and
provisions an admin user plus a team agent. `pnpm dev` starts the API,
scheduler, Postgres, and an optional Cloudflare tunnel when `cloudflared` is
installed.

## The Bet

Beevibe is betting against the AGI-in-a-box future. The next phase of AI at
work is not one giant generalist. It is a team of bounded specialists with
persistent identity, lasting roles, and enough shared structure to ask each
other for help.

Once you make that bet, the primitives change: memory has an `agent_id`, the
workspace has an org chart, and the most important command is not "do this
task" but "ask the right teammate."

## The Mental Model

```text
Company workspace
  |
  +-- People
  |     +-- engineers review, redirect, and hand off work
  |
  +-- Team agents
        +-- backend specialist
        +-- frontend specialist
        +-- infrastructure specialist
        +-- product specialist

Task -> right agent -> asks peers when needed -> human review
```

Agents are not disposable chat sessions. They are persistent teammates with
domains. They can delegate through hierarchy, ask peers for missing context,
negotiate when plans conflict, and escalate to a human when a decision needs
judgment.

## Core Concepts

| Concept | Meaning |
| --- | --- |
| **Workspace** | The company-level place where people, agents, tasks, memory, and review live together. |
| **Agent** | A persistent domain expert with a role, hierarchy level, memory, API key, and preferred runtime. |
| **Task** | A unit of team work assigned to a person or agent. Tasks can spawn child tasks and move through review. |
| **Mesh** | The agent-to-agent layer for asking the right teammate, negotiating, responding, and escalating. |
| **Memory** | Durable per-agent memory plus vector-searchable facts that compound across team work. |
| **Runtime** | A registered `(daemon, CLI)` pair, usually a user's local `claude` binary. |
| **Daemon** | A local process that claims sessions and spawns CLI runs on a user's machine. |

## Architecture

```text
                 +------------------+
                 |   Web dashboard  |
                 +--------+---------+
                          |
                          v
People + agents  -->  Beevibe API  <-- MCP tool calls from Claude
                          |
                          v
                    Postgres + pgvector
                          ^
                          |
              +-----------+------------+
              |                        |
        Local daemons              Scheduler
       spawn CLI runs          fallback + reaping
```

The API is the control plane. Postgres is the shared coordination and memory
layer. Local daemons run the actual CLI sessions where each user's tools and
files live.

For the deeper version, see the package docs:

- [packages/api](./packages/api/README.md)
- [packages/core](./packages/core/README.md)
- [packages/web](./packages/web/README.md)

## Tech Stack

- **Database:** Postgres 16 + `pgvector`
- **Runtime:** Node.js 20, TypeScript, pnpm workspaces, Turborepo
- **Agents:** Claude Code CLI + Model Context Protocol
- **Memory:** OpenAI embeddings + Anthropic/OpenAI LLM providers
- **Web:** Next.js, React Query, Tailwind CSS, Server-Sent Events

## Deployment

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/beevibe)

Beevibe can run on Railway, Docker, bare Node, or any container host with
Postgres 16 and `pgvector`.

See [DEPLOYMENT.md](./DEPLOYMENT.md) for Railway notes, Docker commands,
production configuration, and current self-hosting limitations.

## Development

Common commands:

```bash
pnpm build              # build all packages
pnpm typecheck          # TypeScript checks
pnpm lint               # ESLint
pnpm test               # unit + integration tests
pnpm migrate up         # apply migrations to DATABASE_URL
pnpm db:reset           # reset local DB and apply migrations
```

Monorepo layout:

```text
packages/
+-- api/         MCP tools, REST API, SSE, chat, mesh broker
+-- core/        domain types, ports, services, adapters, auth
+-- daemon/      local process that claims sessions and spawns CLIs
+-- scheduler/   server-side fallback claimant and orphan reaper
+-- web/         Next.js dashboard
```

Live end-to-end smokes live in [scripts](./scripts). Most are gated with
environment variables such as `RUN_M7_E2E=1` because they use real Postgres,
provider APIs, and CLI processes.

## Contributing

Issues and PRs are welcome. For larger changes, open an issue first so the
direction is clear before implementation.

Please include a `Signed-off-by:` trailer on commits. See
[CONTRIBUTING.md](./CONTRIBUTING.md) for the DCO details.

## License

The Beevibe source code is licensed under the [Apache License 2.0](./LICENSE).

The Beevibe name and logo are project trademarks. Apache 2.0 grants rights to
the source code; it does not grant rights to use the project's name or marks.
Forks and derivative works are welcome under names that are not "Beevibe."
