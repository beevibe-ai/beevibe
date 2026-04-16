# beevibe

Beevibe core — modular monolith for the agent runtime platform.

## Architecture

```
beevibe/
├── packages/
│   ├── core/          shared library: domain, ports, services, adapters, auth
│   ├── mcp-server/    binary: HTTP tool surface + in-process MeshServer (port 3002)
│   └── executor/      binary: task polling + session dispatch
│
├── migrations/        Drizzle migrations (populated in M1)
└── docker-compose.yml Postgres with pgvector
```

### Dependency direction (enforced via ESLint)

```
core/domain     → nothing
core/ports      → domain
core/services   → domain + ports  (NEVER adapters)
core/adapters   → ports it implements + domain
mcp-server/     → core (composition root)
executor/       → core (composition root)
```

## Tech stack

- TypeScript strict (ES2022, NodeNext)
- pnpm workspaces + Turborepo
- Postgres 16 + pgvector
- Drizzle ORM (from M1)
- Claude Code CLI runtime
- `@modelcontextprotocol/sdk`

## Dev setup

Requires Node ≥ 20 and pnpm 9.

```bash
pnpm install
docker compose up -d
cp .env.example .env
# fill in ANTHROPIC_API_KEY, OPENAI_API_KEY
```

### Common commands

```bash
pnpm build        # tsc across all packages
pnpm typecheck    # typecheck without emit
pnpm lint         # eslint
pnpm test         # vitest
pnpm dev          # (from M5+) run services in watch mode
```

## Status

- **M0**: scaffold ✅
- **M1**: domain + ports + postgres adapter + schema + migrations
- **M2**: claude-code runtime adapter + git adapter
- **M3**: services + pgvector + llm providers
- **M4**: auth
- **M5**: executor binary (polling + dispatch)
- **M6**: mcp-server binary (HTTP + OAuth + mesh + tools)
- **M7**: integration test
- **M8+**: web package (Next.js UI + API routes)

See the old repo's project memory for the full migration plan and schema review.
