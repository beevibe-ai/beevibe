# Beevibe Architecture

## System Overview

Beevibe is an agent-orchestration platform built as a TypeScript monorepo. It manages the full lifecycle of AI agent sessions: provisioning, dispatching, executing, and coordinating multi-agent workflows.

## Component Diagram

```mermaid
graph TB
    subgraph Humans["Humans"]
        Browser["Web Dashboard\n(Next.js)"]
        HumanChat["Human Chat\n/chat"]
    end

    subgraph ExternalAI["External AI Services"]
        Anthropic["Anthropic Claude\nClaude Code CLI\nFact promotion"]
        OpenAI["OpenAI\nEmbeddings\n(text-embedding-3-small)"]
    end

    subgraph API["@beevibe/api — Control Plane (Express.js :3000)"]
        direction TB
        REST["REST Routes\n/task /agent /session\n/escalation /room /me"]
        MCPServer["MCP Tool Server\n/mcp\n23 tools (IC/team/org tiers)"]
        DaemonHub["DaemonHub\nWSS /runtime/ws\nRuntime registry"]
        MeshServer["MeshServer\nA2A broker\nask/negotiate queues"]
        SSEFanout["SSE Manager\n/api/stream\npg LISTEN → browser"]
        ChatResolver["ChatResolver\nBlocking /chat\npromise registry"]
    end

    subgraph Core["@beevibe/core — Shared Library"]
        direction LR
        Domain["Domain\nagent / session / task\nmemory / escalation\nnegotiation / room"]
        Ports["Ports\nAgentRuntime\nLlmProvider\nSessionRepo\nAgentRepo\nTaskRepo\n…13 interfaces"]
        Services["Services\nAgentSession\nDispatchService\nTaskService\nEscalationService\nNegotiationService\nMemoryAgent\nOrphanReaper"]
        Adapters["Adapters\nPostgres repos (15)\nClaudeCodeRuntime\nOpenCodeRuntime\nAnthropicLlmProvider\nOpenAIEmbeddingService\nLocalWorkspaceManager"]
    end

    subgraph DB["PostgreSQL + pgvector"]
        Tables["Tables\nagents / sessions / tasks\nmemory_facts / escalations\nnegotiations / rooms\ndaemons / runtimes\nwork_products / core_memory_blocks"]
        PubSub["Pub/Sub\npg_notify bv_event\ncancel_task"]
    end

    subgraph Daemon["@beevibe/daemon — Local Worker (user machine)"]
        direction TB
        Claimer["Claimer\nHTTP poll /runtime/claim (30s)\nWS push fast-path"]
        Supervisor["Supervisor\nConcurrency cap (10)\nAbortControllers"]
        Spawner["Spawner\nwrite mcp-config.json\nClaudeCodeRuntime.execute()"]
    end

    subgraph Scheduler["@beevibe/scheduler — Server Fallback (:3001)"]
        PollLoop["Poll Loop (30s)\nServer-fallback mesh\nPID orphan reaper"]
        CancelListener["Cancel Listener\npg LISTEN cancel_task"]
    end

    subgraph AgentCLI["Agent Sessions (Claude Code CLI)"]
        CLIProcess["claude --dangerously-skip-permissions\nOne process per session"]
        ToolCalls["MCP tool calls\nPOST /mcp\nbv_a_ bearer token"]
    end

    %% Human ↔ API
    Browser -->|"HTTP REST + SSE"| REST
    Browser -->|"SSE /api/stream"| SSEFanout
    HumanChat -->|"POST /chat"| ChatResolver

    %% SSE fanout
    PubSub -->|"pg LISTEN bv_event"| SSEFanout

    %% API ↔ DB
    REST -->|SQL| DB
    MCPServer -->|SQL| DB
    DaemonHub -->|SQL| DB

    %% API ↔ Daemon
    DaemonHub <-->|"WSS /runtime/ws"| Claimer
    REST <-->|"HTTP /runtime/*\nclaim / heartbeat / done / events"| Claimer

    %% Daemon ↔ CLI
    Supervisor --> Spawner
    Spawner -->|"spawn process"| CLIProcess

    %% CLI ↔ API (MCP)
    ToolCalls <-->|"POST /mcp"| MCPServer
    CLIProcess --> ToolCalls

    %% Daemon ↔ API (streaming)
    Spawner -->|"POST /runtime/events\nPOST /runtime/done"| REST

    %% Scheduler ↔ DB
    PollLoop -->|SQL claim| DB
    CancelListener -->|"pg LISTEN cancel_task"| PubSub

    %% Scheduler ↔ CLI
    PollLoop -->|"in-process AgentSession.run()"| AgentCLI

    %% Core wiring
    API -->|imports| Core
    Daemon -->|imports| Core
    Scheduler -->|imports| Core
    Core --> DB
    Browser -.->|"types only\n@beevibe/core/domain"| Domain

    %% External AI
    Adapters -->|"ANTHROPIC_API_KEY"| Anthropic
    Adapters -->|"OPENAI_API_KEY"| OpenAI
    CLIProcess -->|"claude binary"| Anthropic
```

## Session Lifecycle

```mermaid
sequenceDiagram
    participant H as Human / Agent
    participant API as @beevibe/api
    participant DB as PostgreSQL
    participant D as @beevibe/daemon
    participant CLI as Claude Code CLI
    participant MCP as MCP Tool Server

    H->>API: Create task / trigger dispatch
    API->>DB: INSERT session status=pending
    DB-->>D: WS push (or 30s poll wakes)
    D->>API: POST /runtime/claim
    API->>DB: UPDATE status=running, runtime_id=...
    API-->>D: session row
    D->>D: write mcp-config.json
    D->>CLI: spawn claude --dangerously-skip-permissions
    loop Agent turn
        CLI->>MCP: POST /mcp (tool call)
        MCP->>DB: read/write state
        MCP-->>CLI: tool result
    end
    CLI-->>D: exit (done/failed)
    D->>API: POST /runtime/done (status + usage)
    API->>DB: UPDATE session status=done
    API->>DB: pg_notify bv_event
    DB-->>API: SSE fanout
    API-->>H: SSE update
```

## Memory Architecture

```mermaid
graph LR
    subgraph MemoryLayers["Agent Memory (3 layers)"]
        CoreMemory["Core Memory Blocks\nPersona / Domain / Constraints\nStable, in-prompt always"]
        ArchivalFacts["Archival Facts\n(memory_facts table)\nVector-indexed\nSearched via save_memory / search_context"]
        FactPromotion["Fact Promotion\nLLM-judged scope\nic → team → org\n(fact-promoter.ts)"]
    end

    CoreMemory --> ArchivalFacts
    ArchivalFacts --> FactPromotion
    FactPromotion -->|"team/org scope"| ArchivalFacts
```

## MCP Tool Tiers

| Tier | Tools Available | Count |
|------|----------------|-------|
| **IC (Individual Contributor)** | save_memory, update_core_memory, search_context, update_progress, find_up, get_agent_profile, get_task, create_work_product, list_work_products, get_work_product, respond_ask, report_blocker | 12 |
| **Team** | All IC tools + find_subordinates, find_peers, create_task, create_subordinate_agent, check_work_status, revise_task, ask, negotiate, respond_negotiate, escalate_to_humans, add_to_escalation | 23 |
| **Org** | All Team tools | 23 |

## Package Dependency Graph

```mermaid
graph TD
    Web["@beevibe/web\n(Next.js dashboard)"]
    API["@beevibe/api\n(Express + MCP)"]
    Daemon["@beevibe/daemon\n(local worker)"]
    Scheduler["@beevibe/scheduler\n(server fallback)"]
    Core["@beevibe/core\n(domain + ports + services + adapters)"]
    Sandbox["@beevibe/sandbox\n(helper)"]

    Web -.->|"types only"| Core
    API --> Core
    Daemon --> Core
    Daemon --> Sandbox
    Scheduler --> Core
    Core -.->|"no circular"| Core
```

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Session execution | Local daemon (claude CLI) | Agents run on user machines with full filesystem/tool access |
| Server fallback | In-process scheduler | Handles mesh asks when target daemon is offline |
| Pub/sub | Postgres pg_notify | No external broker required; SSE fanout via single LISTEN |
| Memory | pgvector + archival + core blocks | Stable blocks always in-prompt; facts recalled by semantic search |
| Inter-agent coordination | MeshServer in-process | ask/negotiate without external queue |
| Orphan recovery | Heartbeat + PID check | Detects crashed sessions, re-dispatches with --resume |
| Tool gating | hierarchy_level (ic/team/org) | Finer-grained capability control without separate auth layers |
