# Contributing to Beevibe

Thanks for your interest. The project is small and moves fast — PRs are
welcome but please skim this first.

## Code of conduct

Be kind. Disagreement is fine; rudeness is not. The maintainers will close
issues / PRs that don't meet this bar.

## Local development

The container stack in [docker-compose.quickstart.yml](./docker-compose.quickstart.yml)
is the right answer for "I just want to try it." For an iterative dev loop
with file watching, hot reload, and breakpoints, run the services on the
host instead.

### Prerequisites

- Node.js v20+ — [nodejs.org](https://nodejs.org/)
- pnpm v9 — `corepack enable && corepack prepare pnpm@9.12.0 --activate`
- Docker — for the local Postgres
- Claude Code CLI on `PATH` — [claude.ai/code](https://claude.ai/code).
  Run `claude login` once before dispatching real agent work.
- Provider keys: `OPENAI_API_KEY` (embeddings) + `ANTHROPIC_API_KEY` (LLM).

### First-run setup

```bash
git clone https://github.com/beevibe-ai/beevibe.git && cd beevibe
pnpm install
pnpm bootstrap
```

`pnpm bootstrap` writes `.env` from `.env.example` (prompting for provider
keys), starts local Postgres via docker-compose, runs migrations, and
provisions an admin person + team agent. Re-running is safe — it detects
existing setup and skips.

### Daily loop

```bash
pnpm dev                                # postgres + api + scheduler
pnpm --filter @beevibe/web dev -- -p 3030   # in a second terminal
```

Open <http://localhost:3030>. Edit code; api/scheduler use `tsx watch` and
web uses Next dev — both restart on save.

### Minting a `bv_u_` token for the daemon

`pnpm bootstrap` creates an admin and writes its `bv_u_` key into both
root `.env` and `packages/web/.env.local`. To mint another user (or a
clean demo topology):

```bash
pnpm provision-user                       # one extra person + team agent
pnpm tsx scripts/provision-demo.ts        # captain + 2 ICs + paste-ready mcp.json
```

Then register your daemon against the dev api:

```bash
pnpm tsx packages/daemon/src/main.ts setup \
  --api http://localhost:3000 --user-token <bv_u_…>
pnpm tsx packages/daemon/src/main.ts start
```

### Common commands

```bash
pnpm build              # build all packages (turbo)
pnpm typecheck          # TypeScript across the workspace
pnpm lint               # ESLint
pnpm test               # unit + integration (CI runs this — see below for setup)
pnpm migrate up         # apply migrations to DATABASE_URL
pnpm db:reset           # wipe + recreate the local DB
pnpm install-skills     # sync /skills/* into ~/.claude/skills/
pnpm sync-core-memory   # re-sync core memory block descriptions
```

### Running the full test suite

`pnpm test` is **not** hermetic. The integration tests talk to a real
Postgres, and the embedding/LLM adapter tests make live provider calls —
by design, missing prerequisites fail the suite loudly rather than
silently skipping. One suite is deliberately gated instead:
`packages/api/src/routes/mcp.test.ts` is `describe.skipIf`'d on both
provider keys, so it runs in CI (which supplies them) but skips on a
keyless local run.

Separately, the opt-in e2e/smoke suites (`BEEVIBE_E2E_DOCKER`,
`BEEVIBE_E2E_MULTI_INSTANCE`, `RUN_CLAUDE_SMOKE`) and the
`it.skipIf(process.platform === "win32")` gates skip unless you enable
them — each carries its enable instructions in its own file header.

Prerequisites:

| Requirement | Why | Symptom when missing |
| --- | --- | --- |
| Postgres on `:5433` + a `beevibe_test` DB | `createTestPool()` in `packages/core/src/test-helpers.ts` | `DATABASE_URL_TEST env var is required…`, then `Cannot read properties of undefined (reading 'end')` in `afterAll` |
| `OPENAI_API_KEY` | `OpenAIEmbeddingService` / `OpenAILlmProvider` tests | `OPENAI_API_KEY missing` |
| `ANTHROPIC_API_KEY` | `AnthropicLlmProvider` tests | `ANTHROPIC_API_KEY missing` |

Full setup from a clean checkout (this mirrors `.github/workflows/ci.yml`,
which is the source of truth):

```bash
# 1. Postgres (pgvector/pgvector:pg16, same image CI uses)
docker compose up -d --wait postgres

# 2. Create the dedicated test database — separate from the dev DB,
#    because the suite TRUNCATEs every table between cases.
docker exec beevibe-postgres \
  psql -U beevibe -d beevibe -c 'CREATE DATABASE beevibe_test;'

# 3. .env must carry both URLs plus the provider keys.
#    `pnpm bootstrap` writes this for you; otherwise copy .env.example.
cat > .env <<'EOF'
DATABASE_URL=postgresql://beevibe:beevibe@localhost:5433/beevibe
DATABASE_URL_TEST=postgresql://beevibe:beevibe@localhost:5433/beevibe_test
OPENAI_API_KEY=sk-…
ANTHROPIC_API_KEY=sk-ant-…
EOF

# 4. Migrate both databases
pnpm migrate up
pnpm migrate:test up

# 5. Run it
pnpm test
```

Narrower loops while iterating:

```bash
pnpm --filter @beevibe/core test              # one package
pnpm --filter @beevibe/api test -- routes/     # one path
pnpm --filter @beevibe/core test -- --watch    # watch mode
```

Pure-unit packages need no setup at all — `@beevibe/sandbox` and the
non-DB suites in `api`/`scheduler` pass against an empty environment, so
a quick `pnpm --filter @beevibe/api test` still exercises ~300 cases
without Postgres.

Not run in CI: the live Claude CLI smoke test. Run it manually
pre-release with a real `claude` binary on `PATH`:

```bash
RUN_CLAUDE_SMOKE=1 pnpm --filter @beevibe/core test smoke
```

### Building behind an HTTP proxy

Turbo 2.x runs tasks in **strict env mode**, which passes only declared
variables through to each task. `turbo.json` declares no
`globalPassThroughEnv`, so `HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS` are
stripped before the task starts. Behind a TLS-terminating proxy (a
corporate network, or a cloud dev sandbox) `next build` then fails while
`next/font` fetches Google Fonts:

```
FetchError: request to https://fonts.googleapis.com/… failed,
  reason: self-signed certificate in certificate chain
```

The network is fine — the task just can't see the CA bundle. Either
build the package directly, bypassing Turbo:

```bash
pnpm --filter @beevibe/web exec next build
```

…or let Turbo forward the proxy variables by adding to `turbo.json`:

```json
"globalPassThroughEnv": [
  "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
  "NO_PROXY", "no_proxy", "NODE_EXTRA_CA_CERTS"
]
```

Passthrough variables don't contribute to Turbo's cache keys, so this
won't invalidate caches when the proxy address changes.

### Monorepo layout

```text
packages/
├── api/         MCP tools, REST API, SSE, chat, mesh broker, /runtime
├── core/        domain types, ports, services, adapters, auth
├── daemon/      local process that claims sessions and spawns CLIs
├── scheduler/   server-side fallback claimant + orphan reaper
└── web/         Next.js dashboard

infra/railway/   Dockerfiles + Railway config-as-code per service
migrations/      node-pg-migrate SQL migrations
scripts/         dev orchestration + provisioning + skills sync
skills/          shipped Anthropic Agent Skills (synced into workspaces)
```

Each `packages/<name>/README.md` is the source of truth for that subsystem.

## How to contribute

1. **Open an issue first** for non-trivial work (anything beyond a typo,
   doc fix, or self-contained bug). It's much easier to align on direction
   in an issue than to rewrite a 500-line PR.
2. **Fork, branch, PR.** Branch off `main`. PRs should be focused — one
   logical change per PR.
3. **Tests.** New behavior needs tests. The repo runs `pnpm -w test` in
   CI; your PR must keep that green. New features in `packages/api` or
   `packages/core` should include unit tests; UI changes in
   `packages/web` should include a vitest case where it makes sense.
4. **Commits.** Descriptive subject lines. Body explains *why*, not
   *what* — the diff already shows what changed. Squash WIP commits
   before requesting review.
5. **Sign your commits** (see below) — required, CI will block PRs
   without it.

## Developer Certificate of Origin (DCO)

Every commit in this repository must include a `Signed-off-by:` trailer.
This is a legally meaningful attestation that you have the right to
contribute the code under the project's license. It is **not** the same as
a CLA; it adds about three keystrokes to your workflow.

To sign off, append `-s` (or `--signoff`) to your commit:

```bash
git commit -s -m "your message"
```

Or set it once for the repo so you don't have to remember:

```bash
git config --local format.signoff true
```

Either form adds a line like:

```
Signed-off-by: Your Name <your.email@example.com>
```

The full DCO text is reproduced below — by signing off, you certify
this for each commit you submit.

A GitHub Action checks every PR for the sign-off and blocks merge if any
commit is missing it. If you forgot to sign off existing commits, the
quickest fix is:

```bash
git rebase --signoff origin/main
git push --force-with-lease
```

## License of contributions

By submitting a contribution to this repository:

1. You certify the Developer Certificate of Origin v1.1 (the text below).
2. You agree that your contribution is licensed under the **Apache License,
   Version 2.0** — the same license that covers the rest of the
   repository.
3. You grant Zhe Pang (and Beevibe Inc. upon its formation, to whom these
   rights will be assigned) a perpetual, irrevocable, non-exclusive,
   worldwide, royalty-free license to use, modify, sublicense, and
   relicense your contribution under any open-source or commercial license
   the project may adopt in the future.

This last clause is what lets the project add commercial-license terms
later (for example, to support an enterprise SKU) without re-asking every
past contributor for permission. Without it, every contributor's copyright
would be independent, and a future relicense would be impossible.

The project does not currently require a separate signed CLA — the DCO
sign-off + the agreement above is sufficient. When the project graduates
to a more formal contribution flow (typically when there are many outside
contributors, or at the time of company formation), maintainers may
introduce a signed CLA via [CLA Assistant](https://cla-assistant.io) or
similar, and existing contributors will be asked to sign retroactively.

## Trademark

The "Beevibe" name and logo are trademarks of the project — see
[TRADEMARK.md](./TRADEMARK.md). Apache 2.0 grants rights to the source
code; it does not grant rights to use the project's name or marks.

## Developer Certificate of Origin v1.1

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```
