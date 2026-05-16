# @beevibe/core

Shared library for the beevibe agent runtime: domain types, port interfaces, services, adapters, and auth.

This package has no entry point of its own — it's imported by [`@beevibe/api`](../api), [`@beevibe/scheduler`](../scheduler), [`@beevibe/daemon`](../daemon), and [`@beevibe/web`](../web). If you want to run beevibe end-to-end, start at the [repo root README](../../README.md). If you want to embed pieces of beevibe in another Node program, this is the package you depend on.

## Layout

```
src/
├── domain/      pure types — agents, tasks, sessions, memory, work products
├── ports/       interfaces — repos, runtime, workspace, LLM provider, embeddings
├── services/    business logic — agent-session, task, escalation, memory, skills
├── adapters/    impls — postgres, claude-code, openai, anthropic, local-workspace
└── auth/        api key validation, caller resolution, agent provisioning
```

The dependency direction is one-way and ESLint-enforced:

```
domain      → nothing
ports       → domain
services    → domain + ports     (NEVER adapters)
adapters    → ports + domain
auth        → domain + ports
```

## Subpath exports

Tree-shake-friendly subpaths via the `exports` map in `package.json`:

| Import path | What's there |
|---|---|
| `@beevibe/core` | Main barrel — domain types, ports, auth |
| `@beevibe/core/domain` | Domain-only barrel (no ports/auth) — for browser-safe imports |
| `@beevibe/core/auth` | API-key validation, `ResolvedCaller`, `provisionAgent` |
| `@beevibe/core/auth/constants` | Browser-safe constants (`PASSWORD_MIN_LENGTH`, …) |
| `@beevibe/core/adapters/postgres` | All 15 repository implementations + `createPool` |
| `@beevibe/core/adapters/claude-code` | `ClaudeCodeRuntime` (spawns `claude` CLI) |
| `@beevibe/core/adapters/opencode` | `OpenCodeRuntime` (spawns `opencode` CLI for OpenRouter, Ollama, and OpenAI-compatible providers) |
| `@beevibe/core/adapters/openai` | `OpenAIEmbeddingService`, `OpenAILlmProvider` |
| `@beevibe/core/adapters/anthropic` | `AnthropicLlmProvider` |
| `@beevibe/core/adapters/local-workspace` | `LocalWorkspaceManager` |
| `@beevibe/core/adapters/runtime-registry` | `createDefaultRuntimeRegistry` |
| `@beevibe/core/services/agent-session` | `AgentSession` (orchestrates one CLI run) |
| `@beevibe/core/services/dispatch-service` | `DispatchService` (central pending-session insert + daemon wakeup) |
| `@beevibe/core/services/orphan-reaper` | `runOrphanReaper` (daemon-orphan detection + crash-recovery re-dispatch) |
| `@beevibe/core/services/task-service` | Task state machine — approve/reject/revise/cancel |
| `@beevibe/core/services/escalation-service` | Escalation creation + resolution |
| `@beevibe/core/services/memory` | `MemoryAgent`, `CoreMemory`, `FactStore`, `FactPromoter` |
| `@beevibe/core/services/skills` | `syncSkills`, `tierFilterFor` |
| `@beevibe/core/test-helpers` | `createTestPool`, `truncateAll` for integration tests |

## Quick example — wire a session

```ts
import { createPool, PostgresAgentRepository, /* … */ } from "@beevibe/core/adapters/postgres";
import { ClaudeCodeRuntime } from "@beevibe/core/adapters/claude-code";
import { LocalWorkspaceManager } from "@beevibe/core/adapters/local-workspace";
import { AgentSession } from "@beevibe/core/services/agent-session";

const pool = createPool({ connectionString: process.env.DATABASE_URL! });
const runtime = new ClaudeCodeRuntime({ maxTurns: 50 });
const workspaces = new LocalWorkspaceManager({ /* … */ });
const session = new AgentSession({ /* repos + runtime + memoryAgent */ });

const result = await session.run({
  agentId: "agt_…",
  intent: "Reply with the single word 'ok'.",
  workspace: await workspaces.ensureWorkspace(/* … */),
});
// → { id, status, cli_session_id, usage }
```

The full wiring lives in `packages/api/src/bootstrap.ts`, `packages/scheduler/src/bootstrap.ts`, and `packages/daemon/src/start.ts` — copy from there.

## Domain at a glance

The domain layer is pure types — no I/O, no dependencies beyond `nanoid` for ID minting.

| File | Key types |
|---|---|
| `domain/agent.ts` | `Agent`, `HierarchyLevel` (`ic`/`team`/`org`), `RuntimeConfig`, `ReviewPolicy` |
| `domain/task.ts` | `Task`, `TaskStatus`, `TaskPriority`, `NextDispatchContext` |
| `domain/session.ts` | `Session`, `SessionType`, `SessionStatus` (incl. `pending`), `SessionSpawnMode`, `TerminalSessionStatus`, `InFlightSessionStatus`, `SessionEvent`, `SessionUsage` |
| `domain/daemon.ts` | `Daemon`, `NewDaemon` |
| `domain/runtime.ts` | `Runtime`, `NewRuntime`, `KnownCli`, `RUNTIME_HEARTBEAT_INTERVAL_MS` |
| `domain/room.ts` | `Room`, `RoomMember`, `RoomMessage`, `RoomMemberKind`, `RoomMessageKind` |
| `domain/core-memory.ts` | `CoreMemoryBlock`, default block templates, char limits |
| `domain/memory.ts` | `MemoryFact`, `FactType`, `MemoryScope` (`ic`/`team`/`org`) |
| `domain/work-product.ts` | `WorkProduct`, `WorkProductType` (PR, branch, commit, document, …) |
| `domain/negotiation.ts` | `Negotiation`, `NegotiationRound` |
| `domain/escalation.ts` | `Escalation`, `Proposal`, `ResolutionProposal` |
| `domain/person.ts` | `Person` |
| `domain/ids.ts` | `agentId()`, `taskId()`, `sessionId()`, … (prefixed nanoid) |

## Ports

Every external dependency lives behind a port. New runtimes (e.g., a different CLI), new vector stores, or new LLM providers slot in by implementing the relevant interface — the rest of the codebase doesn't move.

- **Repositories** (15) — `AgentRepository`, `TaskRepository`, `SessionRepository`, `PersonRepository`, `CoreMemoryRepository`, `WorkProductRepository`, `MemoryFactRepository`, `NegotiationRepository`, `EscalationRepository`, `MemoryPromotionEventRepository`, `SessionEventRepository`, `RoomRepository`, `AgentProvisionEventRepository`, `DaemonRepository`, `RuntimeRepository`
- **LLM + embeddings** — `LlmProvider`, `EmbeddingService`
- **Execution** — `AgentRuntime`, `WorkspaceManager`

## Services

| Service | What it does |
|---|---|
| `AgentSession` | Runs one CLI session end-to-end. Composes the system prompt (memory briefing + lifecycle/memory reminders), invokes the runtime, persists the session row, fires the post-dispatch hook. |
| `DispatchService` | Central pending-session insert. Resolves `runtime_id` (pinning resume sessions to their prior runtime), advances task state, fires `onSessionInserted` to wake the daemon hub. Demotes mesh dispatches to `server_fallback_mesh` when the target's runtime isn't live. |
| `runOrphanReaper` | Polls for daemon sessions whose runtime heartbeat is stale (>60s by default) AND whose own `last_event_at` is >5min old; marks them `failed/daemon_orphaned`, fires `onSessionReaped`, re-dispatches task sessions with `kind:'crash_recovery'`. |
| `composeSystemPromptAppend` | Cache-stable lifecycle/memory reminder text shared by `AgentSession.run` (in-process) and `/runtime/claim` (daemon path). Lives in `services/spawn-prep.ts`. |
| `TaskService` | Task state machine. `approveTask` / `rejectTask` / `reviseTask` / `cancelTask`, parent rollup when all children settle. |
| `EscalationService` | Creates escalations, resolves them, re-queues both parties' tasks with post-resolution context. |
| `MemoryAgent` | Per-agent memory orchestrator. `prepareBriefing(intent)` (system + user split for cache), `searchArchival(query)` for mid-session recall, `onTaskComplete` for fact promotion. |
| `CoreMemory` | Reads/writes the agent's stable per-agent blocks (persona, domain, constraints, learnings). |
| `FactStore` / `FactPromoter` | Vector-indexed archival facts; LLM-judged scope promotion (ic → team → org). |
| `syncSkills` | Per-workspace mtime-diff sync of `SKILL.md` files into `<workspace>/.claude/skills/`. Namespace-safe — only touches `beevibe`/`beevibe-*` dirs. |

## Adapters

| Adapter group | Implements | Notes |
|---|---|---|
| `postgres/` | All 15 repos + `createPool` | Raw `pg` driver, no ORM. Schema in [`/migrations/`](../../migrations). |
| `claude-code/` | `AgentRuntime` | Spawns `claude` CLI as subprocess, parses stream-JSON output, captures cache tokens. |
| `opencode/` | `AgentRuntime` | Spawns `opencode run --format json`; delegates provider/model plumbing to OpenCode for OpenRouter, Ollama, and OpenAI-compatible endpoints. |
| `openai/` | `EmbeddingService`, `LlmProvider` | `text-embedding-3-small` (1536 dims), GPT-4o for fact merging. |
| `anthropic/` | `LlmProvider` | Claude Sonnet for fact promotion (native JSON schema output). |
| `local-workspace/` | `WorkspaceManager` | Per-agent dirs under `~/.beevibe/workspaces/<agent_id>/`, manages `mcp-config.json`. |

## Auth

```ts
import { lookupApiKey, provisionAgent } from "@beevibe/core/auth";

// API key prefixes:
//   bv_a_…  → agent  (MCP calls)
//   bv_u_…  → user   (REST + SSE)
//   bv_d_…  → daemon (POST /runtime/* — claim, heartbeat, done, event)
const caller = await lookupApiKey(repos, "bv_a_…");
// → { source: "agent",  agent_id, hierarchy_level, … }
//   or { source: "human",  person_id, … }
//   or { source: "daemon", daemon_id, owner_person_id, … }
```

## Build / test

```bash
pnpm --filter @beevibe/core build
pnpm --filter @beevibe/core typecheck
pnpm --filter @beevibe/core test
```

Tests are colocated next to source (`*.test.ts`). Integration tests that need Postgres use `@beevibe/core/test-helpers` for setup/teardown.
