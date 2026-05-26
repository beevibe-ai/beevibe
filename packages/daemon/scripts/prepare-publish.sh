#!/usr/bin/env bash
#
# Prepare an npm-publishable artifact for @beevibe/daemon.
#
# The daemon depends on the workspace package @beevibe/core, which is not
# published to npm. To produce a self-contained tarball we bundle the
# daemon's entire dependency graph (except node built-ins and the small
# set of npm packages it imports at runtime) into one JS file via
# `bun build --target=node`, then emit a publish-ready package.json that
# drops the workspace dep.
#
# Output: packages/daemon/publish-dist/. After this script runs:
#   cd packages/daemon/publish-dist && npm publish
# uploads to npm. Used by .github/workflows/release.yml on tag push.

set -euo pipefail

DAEMON_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$DAEMON_DIR/../.." && pwd)"

cd "$REPO_ROOT"
# Idempotent workspace-dep builds — skip per package if dist exists.
# The release workflow pre-builds via build-binaries.sh; ad-hoc runs
# handle the cold case. Both core and sandbox need dist/ for bun-bundle
# to resolve `@beevibe/core` and `@beevibe/sandbox/orchestrator`.
if [ ! -f packages/core/dist/index.js ]; then
  pnpm --filter @beevibe/core build >/dev/null
fi
if [ ! -f packages/sandbox/dist/orchestrator.js ]; then
  pnpm --filter @beevibe/sandbox build >/dev/null
fi

cd "$DAEMON_DIR"
OUTDIR="publish-dist"
rm -rf "$OUTDIR"
mkdir -p "$OUTDIR/dist"

VERSION="$(node -p "require('./package.json').version")"

# Bundle: --target=node produces ES modules consumable by `node dist/main.js`.
# --external ws keeps ws as a runtime dep (it has prebuilds) so it loads
# from the installer's node_modules rather than being inlined.
# __DEV_BUILD__=false flips the dev-only multi-instance gate
# (config.ts:isDevBuild()) to false, so the npm-published bundle rejects
# --config-root / BEEVIBE_CONFIG_ROOT with exit 2. Source-checkout runs
# never have the define applied; `typeof __DEV_BUILD__` returns
# "undefined" there → isDevBuild() returns true.
bun build src/main.ts \
  --target=node \
  --outfile="$OUTDIR/dist/main.js" \
  --external ws \
  --define "BEEVIBE_DAEMON_VERSION=\"$VERSION\"" \
  --define "__DEV_BUILD__=false"

# Make the bundled entry executable since `bin` points at it.
chmod +x "$OUTDIR/dist/main.js"

# Publish-only package.json: workspace dep on @beevibe/core gone (it's
# inlined into the bundle); ws remains as a runtime dep for the installer.
node <<JS
const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const wsVersion = pkg.dependencies && pkg.dependencies.ws;
if (!wsVersion) throw new Error("Expected 'ws' in dependencies — package.json drifted from publish script");
delete pkg.private;
delete pkg.devDependencies;
delete pkg.scripts;
delete pkg.types;
pkg.publishConfig = { access: "public", registry: "https://registry.npmjs.org/" };
pkg.dependencies = { ws: wsVersion };
pkg.files = ["dist", "README.md"];
pkg.main = "./dist/main.js";
pkg.bin = { "beevibe-daemon": "./dist/main.js" };
fs.writeFileSync("${OUTDIR}/package.json", JSON.stringify(pkg, null, 2) + "\n");
JS

# Copy README so the npm page isn't empty. Use the root README until the
# daemon grows its own.
if [ -f README.md ]; then
  cp README.md "$OUTDIR/README.md"
elif [ -f "$REPO_ROOT/README.md" ]; then
  cp "$REPO_ROOT/README.md" "$OUTDIR/README.md"
fi

echo "==> Publish artifact prepared at $DAEMON_DIR/$OUTDIR"
echo "    Bundle size: $(du -h "$OUTDIR/dist/main.js" | cut -f1)"
echo "    To publish:   cd $OUTDIR && npm publish"
