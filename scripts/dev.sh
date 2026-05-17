#!/usr/bin/env bash
#
# Dev orchestrator: brings up postgres, applies migrations, then spawns
# api + scheduler as separate processes. Optionally exposes the api via
# cloudflared so a remote Claude CLI can connect with bv_u_ auth.
#
# Defaults:
#   - tunnel ON when cloudflared is on PATH (skipped gracefully otherwise)
#   - postgres via docker-compose
#   - api on $BEEVIBE_API_PORT (default 3000)
#   - scheduler health on $BEEVIBE_SCHEDULER_HEALTH_PORT (default 3001)
#
# Usage:
#   pnpm dev              # postgres + api + scheduler + tunnel (if available)
#   pnpm dev --no-tunnel  # local-only
#
# Ctrl+C → all children killed via `trap 'kill 0' EXIT`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# ─────────────────── prerequisites ───────────────────
missing=()
command -v node    >/dev/null 2>&1 || missing+=("node")
command -v pnpm    >/dev/null 2>&1 || missing+=("pnpm")
command -v docker  >/dev/null 2>&1 || missing+=("docker")
command -v claude  >/dev/null 2>&1 || missing+=("claude (Claude Code CLI)")

if [ ${#missing[@]} -gt 0 ]; then
  echo "✗ Missing prerequisites: ${missing[*]}"
  echo "  Install: Node.js v20+, pnpm v9+, Docker, and Claude Code CLI"
  exit 1
fi

# ─────────────────── env file ───────────────────
if [ ! -f .env ]; then
  echo "==> .env missing. Run \`pnpm bootstrap\` first to provision the local stack."
  exit 1
fi

set -a
# shellcheck disable=SC1090
. .env
set +a

# Required (no sensible default — must come from .env).
required_vars=(DATABASE_URL OPENAI_API_KEY ANTHROPIC_API_KEY)
for v in "${required_vars[@]}"; do
  if [ -z "${!v:-}" ]; then
    echo "✗ Missing required env var in .env: $v"
    exit 1
  fi
done

# Defaults filled in here so a stale .env (missing newer vars) still works.
# Spawned agent CLIs always connect via localhost on the dev host; the
# tunnel URL is only for remote human users (printed below if enabled).
export BEEVIBE_API_PORT="${BEEVIBE_API_PORT:-3000}"
export BEEVIBE_MCP_SERVER_URL="${BEEVIBE_MCP_SERVER_URL:-http://localhost:${BEEVIBE_API_PORT}/mcp}"
export BEEVIBE_SCHEDULER_HEALTH_PORT="${BEEVIBE_SCHEDULER_HEALTH_PORT:-3001}"
# M9.3: api + scheduler sync tier-filtered skills into <workspace>/.claude/skills/
# at every dispatch. Default points at this repo's /skills/ dir; pnpm --filter
# changes the cwd to each package, so we can't rely on process.cwd()/skills.
export BEEVIBE_SKILLS_DIR="${BEEVIBE_SKILLS_DIR:-${REPO_ROOT}/skills}"

# ─────────────────── flags ───────────────────
TUNNEL_ENABLED=1
for arg in "$@"; do
  case "$arg" in
    --no-tunnel) TUNNEL_ENABLED=0 ;;
    --tunnel)    TUNNEL_ENABLED=1 ;;
    *) echo "✗ unknown arg: $arg"; exit 1 ;;
  esac
done

if [ "$TUNNEL_ENABLED" = "1" ] && ! command -v cloudflared >/dev/null 2>&1; then
  echo "⚠️  cloudflared not found — running in local-only mode."
  echo "    Install: brew install cloudflared (macOS) or https://github.com/cloudflare/cloudflared"
  TUNNEL_ENABLED=0
fi

# ─────────────────── deps ───────────────────
echo "==> Installing dependencies (no-op if up to date)..."
pnpm install --frozen-lockfile

# ─────────────────── postgres ───────────────────
echo "==> Ensuring postgres is running..."
docker compose up -d postgres >/dev/null

for i in $(seq 1 30); do
  if docker compose exec -T postgres pg_isready -U beevibe -d beevibe >/dev/null 2>&1; then
    break
  fi
  if [ "$i" = "30" ]; then
    echo "✗ Postgres didn't become ready in 30s"
    exit 1
  fi
  sleep 1
done

# ─────────────────── migrations ───────────────────
echo "==> Applying migrations..."
pnpm migrate up >/dev/null

# ─────────────────── start services ───────────────────
echo ""
echo "==> Starting services (watch the [api] / [exec] logs for ready signals)..."
echo "  API:           http://localhost:${BEEVIBE_API_PORT}"
echo "  Scheduler:     health on http://localhost:${BEEVIBE_SCHEDULER_HEALTH_PORT}/health"
[ "$TUNNEL_ENABLED" = "1" ] && echo "  Tunnel:        starting cloudflared..."
echo "  Workspace:     ${WORKSPACE_ROOT:-~/.beevibe/workspaces}"
echo ""

# ─────────────────── kill stale processes ───────────────────
# Previous pnpm dev runs leave tsx/node children alive if the terminal
# was closed rather than Ctrl+C'd. Kill them so the new run gets clean
# ports and reloads the latest @beevibe/core dist.
echo "==> Killing any stale beevibe processes..."
pkill -f "beevibe/(packages|scripts)" 2>/dev/null || true
pkill -f "daemon/src/main" 2>/dev/null || true
sleep 1

# Kill all children on exit (Ctrl+C, error, normal end).
trap 'kill 0' EXIT

# ─────────────────── core watch (compile-on-save) ───────────────────
# @beevibe/core resolves to dist/ — changes to src/ are invisible to
# the API and daemon until tsc recompiles. Run tsc --watch in the
# background so edits land in dist/ automatically.
pnpm --filter @beevibe/core dev 2>&1 \
  | sed -u 's/^/[core] /' &

# Give tsc one initial compile pass before starting consumers.
sleep 3

# Prefix each service's logs so a single terminal stays readable.
pnpm --filter @beevibe/api dev 2>&1 \
  | sed -u 's/^/[api] /' &

pnpm --filter @beevibe/scheduler dev 2>&1 \
  | sed -u 's/^/[sched] /' &

if [ "$TUNNEL_ENABLED" = "1" ]; then
  # Spawn cloudflared. Capture the trycloudflare URL from its stderr and
  # print a paste-ready mcp-config snippet for any remote human users.
  (
    cloudflared tunnel --url "http://localhost:${BEEVIBE_API_PORT}" 2>&1 | while IFS= read -r line; do
      echo "[tunnel] $line"
      if [[ "$line" =~ (https://[^[:space:]]+\.trycloudflare\.com) ]]; then
        url="${BASH_REMATCH[1]}"
        # Persist for `scripts/provision-demo.ts` to auto-pick up.
        mkdir -p "$HOME/.beevibe"
        printf '%s\n' "$url" > "$HOME/.beevibe/last-tunnel-url"
        cat <<EOF

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Tunnel URL: ${url}

For a manual Claude CLI smoke, run in another terminal:
  pnpm tsx scripts/provision-demo.ts
which prints a paste-ready ~/.config/claude/mcp.json snippet
(captain + IC subordinates + bv_u_ token, pre-pointed at this tunnel).
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

EOF
      fi
    done
  ) &
fi

wait
