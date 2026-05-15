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

# Build core first — bun --compile resolves @beevibe/core via its package
# manifest's main field, which points at dist/.
cd "$REPO_ROOT"
# Idempotent core build — skip if dist is fresh enough. Ad-hoc local
# runs hit the cold case; the release workflow pre-builds once and the
# sibling prepare-publish.sh reuses the result.
if [ ! -f packages/core/dist/index.js ]; then
  pnpm --filter @beevibe/core build >/dev/null
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
  bun build src/main.ts \
    --compile \
    --no-compile-autoload-dotenv \
    --no-compile-autoload-bunfig \
    --target="$target" \
    --outfile="$OUTDIR/$outname" \
    --define "BEEVIBE_DAEMON_VERSION=\"$VERSION\""
done

echo ""
echo "==> Binaries built (size · sha256):"
for entry in "${TARGETS[@]}"; do
  outname="${entry##*:}"
  size="$(du -h "$OUTDIR/$outname" | cut -f1)"
  sha="$(shasum -a 256 "$OUTDIR/$outname" | cut -d' ' -f1)"
  printf "  %-40s  %6s  %s\n" "$outname" "$size" "$sha"
done
