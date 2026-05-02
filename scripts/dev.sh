#!/usr/bin/env bash
#
# Dev orchestrator: brings up postgres, applies migrations, then spawns
# api + executor + web. Optionally exposes the api AND web via
# cloudflared so remote visitors can sign in with their bv_u_ keys and
# chat with their own team agent.
#
# Defaults:
#   - tunnel ON when cloudflared is on PATH (skipped gracefully otherwise)
#   - postgres via docker-compose
#   - api on $BEEVIBE_API_PORT (default 3000)
#   - executor health on $BEEVIBE_EXECUTOR_HEALTH_PORT (default 3001)
#   - web  on $BEEVIBE_WEB_PORT (default 3002)
#
# Tunnel flow: cloudflared starts for the api first, waits for its
# trycloudflare URL, writes that URL into packages/web/.env.local as
# NEXT_PUBLIC_BV_API_URL so the web bundle points at the public api.
# Then Next.js boots, then a second cloudflared exposes the web. Both
# public URLs are printed when ready.
#
# Usage:
#   pnpm dev              # postgres + api + executor + web + tunnels (if available)
#   pnpm dev --no-tunnel  # local-only (web reverts to http://localhost:<api>)
#   pnpm dev --no-web     # api + executor only
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
# OPENAI_API_KEY + ANTHROPIC_API_KEY are intentionally NOT required:
# memory operations degrade gracefully without each. Chat works either way.
required_vars=(DATABASE_URL)
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
export BEEVIBE_EXECUTOR_HEALTH_PORT="${BEEVIBE_EXECUTOR_HEALTH_PORT:-3001}"
export BEEVIBE_WEB_PORT="${BEEVIBE_WEB_PORT:-3002}"

# ─────────────────── flags ───────────────────
TUNNEL_ENABLED=1
WEB_ENABLED=1
for arg in "$@"; do
  case "$arg" in
    --no-tunnel) TUNNEL_ENABLED=0 ;;
    --tunnel)    TUNNEL_ENABLED=1 ;;
    --no-web)    WEB_ENABLED=0 ;;
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
echo "==> Starting services (watch the [api] / [exec] / [web] logs for ready signals)..."
echo "  API:           http://localhost:${BEEVIBE_API_PORT}"
echo "  Executor:      health on http://localhost:${BEEVIBE_EXECUTOR_HEALTH_PORT}/health"
[ "$WEB_ENABLED" = "1" ] && echo "  Web:           http://localhost:${BEEVIBE_WEB_PORT}"
[ "$TUNNEL_ENABLED" = "1" ] && echo "  Tunnel:        starting cloudflared..."
echo "  Workspace:     ${WORKSPACE_ROOT:-~/.beevibe/workspaces}"
echo ""

# Kill all children on exit (Ctrl+C, error, normal end).
trap 'kill 0' EXIT

# api + executor go up first so they're listening when cloudflared and
# the web dev server start probing.
pnpm --filter @beevibe/api dev 2>&1 \
  | sed -u 's/^/[api] /' &

pnpm --filter @beevibe/executor dev 2>&1 \
  | sed -u 's/^/[exec] /' &

WEB_ENV_FILE="packages/web/.env.local"

start_web() {
  if [ "$WEB_ENABLED" != "1" ]; then return; fi
  PORT="$BEEVIBE_WEB_PORT" pnpm --filter @beevibe/web dev 2>&1 \
    | sed -u 's/^/[web] /' &
}

# Persist the api URL the web bundle should use. In local-only mode this
# is http://localhost:<api>; with tunnel, we rewrite to the trycloudflare
# URL once cloudflared reports it.
write_web_api_url() {
  local url="$1"
  if [ ! -f "$WEB_ENV_FILE" ]; then
    echo "NEXT_PUBLIC_BV_API_URL=${url}" > "$WEB_ENV_FILE"
    return
  fi
  if grep -q "^NEXT_PUBLIC_BV_API_URL=" "$WEB_ENV_FILE"; then
    # macOS sed -i needs an empty backup-suffix arg; -i.bak then rm is portable.
    sed -i.bak "s|^NEXT_PUBLIC_BV_API_URL=.*|NEXT_PUBLIC_BV_API_URL=${url}|" "$WEB_ENV_FILE"
    rm -f "${WEB_ENV_FILE}.bak"
  else
    echo "NEXT_PUBLIC_BV_API_URL=${url}" >> "$WEB_ENV_FILE"
  fi
  # Also blank the global user key — visitors must sign in with their
  # own bv_u_ via the /sign-in page (the env fallback exists for solo
  # local dev only).
  if grep -q "^NEXT_PUBLIC_BV_USER_KEY=" "$WEB_ENV_FILE"; then
    sed -i.bak "s|^NEXT_PUBLIC_BV_USER_KEY=.*|NEXT_PUBLIC_BV_USER_KEY=|" "$WEB_ENV_FILE"
    rm -f "${WEB_ENV_FILE}.bak"
  fi
}

if [ "$TUNNEL_ENABLED" = "1" ]; then
  # Spawn cloudflared for the api; capture the trycloudflare URL from
  # its log stream, write it into the web env, then start web + a
  # second cloudflared for the web.
  (
    cloudflared tunnel --url "http://localhost:${BEEVIBE_API_PORT}" 2>&1 | while IFS= read -r line; do
      echo "[tunnel-api] $line"
      if [[ "$line" =~ (https://[^[:space:]]+\.trycloudflare\.com) ]]; then
        api_url="${BASH_REMATCH[1]}"
        write_web_api_url "$api_url"
        start_web
        # Give Next.js a couple seconds to bind the port before we
        # cloudflared-tunnel it; otherwise the first connection 502s.
        sleep 4
        cloudflared tunnel --url "http://localhost:${BEEVIBE_WEB_PORT}" 2>&1 | while IFS= read -r wline; do
          echo "[tunnel-web] $wline"
          if [[ "$wline" =~ (https://[^[:space:]]+\.trycloudflare\.com) ]]; then
            web_url="${BASH_REMATCH[1]}"
            cat <<EOF

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
beevibe is live. Public URLs:

  Web (sign-in): ${web_url}/sign-in
  API:           ${api_url}

Mint a key for a new visitor:
  pnpm provision-user --name "Alice" --email alice@example.com

Share the web URL + their bv_u_ key. They sign in via the page;
the key stays in their browser only and scopes everything they see
to their own person + agents.

Remote Claude CLI? Paste into ~/.config/claude/mcp.json:
  {
    "mcpServers": {
      "beevibe": {
        "type": "http",
        "url": "${api_url}/mcp",
        "headers": { "Authorization": "Bearer <YOUR_BV_U_TOKEN>" }
      }
    }
  }
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

EOF
            break
          fi
        done
        break
      fi
    done
  ) &
else
  # Local-only mode: web points at the local api port; no tunneling.
  write_web_api_url "http://localhost:${BEEVIBE_API_PORT}"
  start_web
fi

wait
