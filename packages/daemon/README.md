# @beevibe/daemon

The local worker. Runs on a user's machine, registers with the api as a `(daemon, runtime)` pair, then claims sessions whose agent's `preferred_runtime_id` matches and spawns the local CLI (`claude`, etc.) to fulfill them. Streams steps back via `/runtime/events` and finalizes with `/runtime/done`.

The daemon never proxies MCP tool calls — the spawned CLI calls the api's `/mcp` endpoint directly using the `bv_a_` agent token written into its workspace's `mcp-config.json`. The daemon only writes that file and supervises the subprocess.

For full setup, see the [root README](../../README.md).

## Run it

Three subcommands. `setup` once; `start` to claim sessions; `update` for the brew/curl install path.

```bash
# 1. one-time registration with an api server
beevibe-daemon setup --api https://api.beevibe.io --user-token bv_u_…
#   detects CLIs on PATH (claude, …), POSTs /runtime/register,
#   writes ~/.beevibe/config.json (mode 0600) with the bv_d_ token

# 2. start claiming
beevibe-daemon start
#   loads config, syncs ~/.beevibe/skills, opens WS to /runtime/ws,
#   polls /runtime/claim every 30s, heartbeats every 15s

# 3. update self (Bun-compiled binaries only)
beevibe-daemon update
#   downloads latest GitHub release, SHA-256 verifies, atomic rename.
#   For npm / source installs, prints the right install command and bails.
```

`setup` flags:

| Flag | Default | Purpose |
|---|---|---|
| `--api` / `-a` | (required) | Api base URL (http or https). |
| `--user-token` / `-t` | (required) | Your `bv_u_` user key — used once to mint the `bv_d_` daemon key. |
| `--device-name` | `<user>@<hostname>` | Human label shown in the Runtimes panel. |
| `--external-id` | `<hostname>` | Stable per-machine id; lets `setup` re-run idempotently. |

`start` takes no flags — everything comes from `~/.beevibe/config.json` + env. `update` takes `--yes` / `-y` to skip the confirmation prompt.

## Setup flow

1. **`setup`** probes `PATH` for known CLIs (`KNOWN_CLIS` from `@beevibe/core`), running `<cli> --version` for each one it finds.
2. POSTs `/runtime/register` with `{ external_id, device_name, runtimes }` and `Authorization: Bearer <bv_u_…>`.
3. Server returns `{ daemon_id, daemon_token, runtimes: [{id, cli}] }`. The daemon token is shown ONCE — saved straight to `~/.beevibe/config.json` (server stores only the SHA-256).
4. **`start`** loads config, fetches `/runtime/skills` (version-cached), syncs into `~/.beevibe/skills/`, opens the WS, and starts the claim/heartbeat loops.

`~/.beevibe/config.json` (dir `0700`, file `0600`):

```json
{
  "api_url": "https://api.beevibe.io",
  "external_id": "macbook-pro.local",
  "daemon_id": "dmn_…",
  "daemon_token": "bv_d_…",
  "runtimes": [{ "id": "rt_…", "cli": "claude" }]
}
```

## Concurrency cap

A single global hardware cap across all sessions on this machine. Default: **10**. Override:

```bash
BEEVIBE_DAEMON_MAX_CONCURRENT=4 beevibe-daemon start
```

The `Supervisor` tracks each session under its own `AbortController`; cancel frames received over the WS abort the named session. `SIGINT` / `SIGTERM` calls `cancelAll()` and exits.

Per-agent caps (`max_task_sessions=1`, mesh=3) are enforced server-side at claim time, so you don't have to set those here.

## Polling, heartbeat, reconnect

| Signal | Cadence | Source |
|---|---|---|
| WS push (`task_available`, `cancel`) | event-driven | api `DaemonHub.notify` |
| HTTP `/runtime/claim` poll | 30s | `claimer.ts` `DEFAULT_POLL_MS` |
| `/runtime/heartbeat` | 15s | `RUNTIME_HEARTBEAT_INTERVAL_MS` from `@beevibe/core` |
| WS reconnect | exponential 1s → 30s cap | `DEFAULT_WS_RECONNECT_MAX_MS` |

The WS push is the low-latency wakeup; the HTTP poll is the catch-up + safety net. Server stales a runtime after 60s of silence (`packages/core/src/services/orphan-reaper.ts`) — well over 2× the heartbeat interval.

When the WS opens, the daemon drains `/runtime/claim` until it returns 204 or the supervisor is full, then idles waiting for the next push.

## Workspaces + env

Per-agent workspace dirs are created lazily on first claim:

- Default: `~/.beevibe/workspaces/<agent_id>/`
- Override: `WORKSPACE_ROOT=/path/to/dir`

Each workspace contains `mcp-config.json` (mode `0600`) with `Bearer <bv_a_…>` for that agent and the api's `/mcp` URL. The CLI reads this file directly; the daemon never sees the `bv_a_` token in a request path.

Skills cache: `~/.beevibe/skills/`, version-gated via `.version`. Refreshed on every `start`.

## Multi-instance (dev only)

Two daemons can run on one machine, authenticated as two different `bv_u_` accounts, by giving each its own `--config-root`. The api already supports this — the `daemon` table is keyed by `(owner_person_id, external_id)`, so two daemons with the same hostname but different owners coexist as separate rows.

```bash
# Terminal 1 — account A
pnpm dev setup --config-root $HOME/.beevibe-A --api http://localhost:3000 --user-token bv_u_A…
pnpm dev start --config-root $HOME/.beevibe-A

# Terminal 2 — account B
pnpm dev setup --config-root $HOME/.beevibe-B --api http://localhost:3000 --user-token bv_u_B…
pnpm dev start --config-root $HOME/.beevibe-B
```

`BEEVIBE_CONFIG_ROOT` is an equivalent env-var entry point. Each instance writes its own `config.json`, skills cache, and workspaces under the override; defaults are unchanged (`~/.beevibe/...`) when neither the flag nor the env is set.

**Hard restrictions:**

- **Dev/source builds only.** Compiled binaries (brew/curl install path) and the npm-published bundle reject both `--config-root` and `BEEVIBE_CONFIG_ROOT` with exit code 2. The gate is the `__DEV_BUILD__` compile-time define set by `scripts/build-binaries.sh` and `scripts/prepare-publish.sh`, backed by a runtime check in `main.ts`. To run multi-instance, use `pnpm dev` against a source checkout.
- **`update` operates on the shared binary.** `beevibe-daemon update` rewrites `process.execPath`, which is the same file both instances spawn from. Running `update` from one instance affects the other on its next launch. Acceptable for dev testing of the update flow; the running daemon keeps its open inode on POSIX so it doesn't crash mid-session.
- **Device name is not auto-suffixed.** Both daemons register as `<user>@<hostname>` in the Runtimes panel by default. Use `--device-name "MBP (account-B)"` at `setup` time if you want them visually distinct.
- **Same OS user only.** Different OS users on one machine already isolate via `homedir()`; this flag is for running two accounts as the SAME OS user.

## What it doesn't do

- **No MCP proxy.** The CLI calls `/mcp` directly using the `bv_a_` token in `mcp-config.json`. The daemon's job stops at writing the file and supervising the subprocess.
- **No agent semantics.** `/runtime/claim` payloads are self-contained — agent_id, intent, prior_session_id (for `--resume`), workspace dir. The daemon never queries agents or tasks.
- **No persistence beyond config.** No DB connection, no cache of agent state. The token is plaintext locally; the server stores only the SHA-256.

## Source layout

```
src/
├── main.ts            CLI arg parser + subcommand dispatch
├── setup.ts           runSetup: detect CLIs, POST /runtime/register, write config
├── start.ts           runStart: load config, sync skills, build Supervisor + Claimer
├── update.ts          runUpdate: GitHub-release self-update for compiled binaries
├── config.ts          load/save ~/.beevibe/config.json (DaemonConfig shape)
├── api-client.ts      thin GET/POST/claim over /runtime/* with bv_d_ auth + WS open
├── claimer.ts         WS push + 30s HTTP poll + 15s heartbeat + WS reconnect
├── supervisor.ts      bounded concurrency cap with per-session AbortControllers
├── spawner.ts         runDispatch: workspace + ClaudeCodeRuntime + batched events
├── skills-cache.ts    syncSkillsCache: pull /runtime/skills into ~/.beevibe/skills/
└── supervisor.test.ts vitest unit tests
```

## Build distribution

For local dev:

```bash
pnpm --filter @beevibe/daemon build      # tsc → dist/
pnpm --filter @beevibe/daemon dev        # tsx watch
```

For releases (Bun-compiled standalone binaries — no Node required):

```bash
pnpm --filter @beevibe/daemon build:binaries
#   bun build --compile for darwin-{arm64,x64} + linux-{x64,arm64}
#   outputs dist-bin/ with size + SHA-256, ready for GitHub release upload
```

Used by `.github/workflows/release.yml`. The companion `scripts/prepare-publish.sh` bundles the workspace dep `@beevibe/core` into one ESM file via `bun build` for `npm publish`.

## Build / test

```bash
pnpm --filter @beevibe/daemon build
pnpm --filter @beevibe/daemon typecheck
pnpm --filter @beevibe/daemon test
```
