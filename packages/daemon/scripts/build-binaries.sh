#!/usr/bin/env bash
#
# Build native daemon binaries for distribution.
#
# Produces 4 standalone binaries via Bun's --compile mode:
#   - beevibe-daemon-darwin-arm64  (Apple Silicon)
#   - beevibe-daemon-darwin-x64    (Intel Mac)
#   - beevibe-daemon-linux-x64
#   - beevibe-daemon-linux-arm64
#
# Each binary is ~50-60MB and self-contained (bundles the Bun runtime).
# Output: packages/daemon/dist-bin/. Prints SHA256s at the end for the
# release manifest. Used by .github/workflows/release.yml on tag push.

set -euo pipefail

DAEMON_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$DAEMON_DIR/../.." && pwd)"

# Build workspace deps first — bun --compile resolves their imports via
# package.json `main` / `exports` which point at `dist/`. Without these
# pre-builds, bun-bundle errors with "Could not resolve" on cold checkouts
# (e.g., CI's fresh clone after pnpm install --frozen-lockfile).
#
# Idempotent — skip per package if dist is already fresh. Ad-hoc local
# runs hit the cold case; the release workflow pre-builds once and the
# sibling prepare-publish.sh reuses the result.
cd "$REPO_ROOT"
if [ ! -f packages/core/dist/index.js ]; then
  pnpm --filter @beevibe/core build >/dev/null
fi
# Capability Network (#153): daemon's repo-runs.ts imports
# @beevibe/sandbox/orchestrator whose package exports point at
# packages/sandbox/dist/. Needs the same treatment as core.
if [ ! -f packages/sandbox/dist/orchestrator.js ]; then
  pnpm --filter @beevibe/sandbox build >/dev/null
fi

cd "$DAEMON_DIR"
OUTDIR="dist-bin"
rm -rf "$OUTDIR"
mkdir -p "$OUTDIR"

VERSION="$(node -p "require('./package.json').version")"

# target → output filename
declare -a TARGETS=(
  "bun-darwin-arm64:beevibe-daemon-darwin-arm64"
  "bun-darwin-x64:beevibe-daemon-darwin-x64"
  "bun-linux-x64:beevibe-daemon-linux-x64"
  "bun-linux-arm64:beevibe-daemon-linux-arm64"
)

for entry in "${TARGETS[@]}"; do
  target="${entry%%:*}"
  outname="${entry##*:}"
  echo "==> Building $outname ($target)"
  # --no-compile-autoload-dotenv / --no-compile-autoload-bunfig (Bun
  # ≥1.3.3): standalone executables normally auto-load .env + bunfig.toml
  # from the cwd at startup. The daemon's own config lives in
  # ~/.beevibe/config.json — a repo-checkout .env has no business
  # leaking in. Disable both at build time so launching the daemon from
  # any directory is deterministic.
  # __DEV_BUILD__=false flips the dev-only multi-instance gate
  # (config.ts:isDevBuild()) to false, so the compiled binary rejects
  # --config-root / BEEVIBE_CONFIG_ROOT with exit 2. tsx / tsc-built
  # runs never have the define applied; `typeof __DEV_BUILD__` returns
  # "undefined" there → isDevBuild() returns true.
  bun build src/main.ts \
    --compile \
    --no-compile-autoload-dotenv \
    --no-compile-autoload-bunfig \
    --target="$target" \
    --outfile="$OUTDIR/$outname" \
    --define "BEEVIBE_DAEMON_VERSION=\"$VERSION\"" \
    --define "__DEV_BUILD__=false"
done

echo ""
echo "==> Binaries built (size · sha256):"
for entry in "${TARGETS[@]}"; do
  outname="${entry##*:}"
  size="$(du -h "$OUTDIR/$outname" | cut -f1)"
  sha="$(shasum -a 256 "$OUTDIR/$outname" | cut -d' ' -f1)"
  printf "  %-40s  %6s  %s\n" "$outname" "$size" "$sha"
done
