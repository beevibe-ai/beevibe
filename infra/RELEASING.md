# Cutting a release

The release workflow ([.github/workflows/release.yml](../.github/workflows/release.yml))
fires on tag push (`v*`) and produces three artifacts:

1. **GitHub release** with 4 native daemon binaries + `.sha256` companion files
2. **npm package** `@beevibe/daemon@<version>` (bundled, no workspace deps)
3. **Homebrew formula update** in [`beevibe-ai/homebrew-tap`](https://github.com/beevibe-ai/homebrew-tap)

## One-time setup

These pieces have to exist before the first tag push:

### 1. npm Trusted Publisher (no token needed)

The release workflow authenticates to npm via GitHub Actions OIDC —
no long-lived secret in this repo's GitHub Secrets. Setup is one-time
via npm's web UI:

1. Log into [npmjs.com](https://npmjs.com) as an owner of the `@beevibe`
   org. (If the org doesn't exist, create it first at
   [npmjs.com/org/create](https://www.npmjs.com/org/create) — free
   plan is fine for public packages.)
2. Navigate to the `@beevibe/daemon` package settings. The package
   doesn't exist yet, but npm supports pre-configuring a Trusted
   Publisher for new packages:
   - Org page → Packages → "Add Trusted Publisher" (or similar)
   - OR direct URL pattern: `npmjs.com/package/@beevibe/daemon/access` once
     the package exists; for pre-publish config, use the org settings
3. Add the trusted publisher with:
   - **Publisher**: GitHub Actions
   - **Repository owner**: `beevibe-ai`
   - **Repository name**: `beevibe`
   - **Workflow filename**: `release.yml`
   - **Environment**: (leave blank)

That's it — no token to generate, no secret to add. The release workflow
authenticates via OIDC on every run.

### 2. `HOMEBREW_TAP_TOKEN` secret + tap repo

1. Create a public repo named `homebrew-tap` under `beevibe-ai` (must be
   public so brew can fetch from it):
   ```bash
   gh repo create beevibe-ai/homebrew-tap --public \
     --description "Homebrew formulas for Beevibe tools"
   ```
2. Add a minimal README and an empty `Formula/` directory (the release
   workflow will populate `Formula/beevibe-daemon.rb` on first run).
3. Generate a fine-grained personal access token with:
   - Repository access: `beevibe-ai/homebrew-tap`
   - Permissions: Contents (read + write)
4. In this repo's secrets: name `HOMEBREW_TAP_TOKEN`, value: the PAT.

### 3. Verify `pnpm`, `node`, and `bun` versions are pinned

The workflow pins:
- pnpm `9.12.0` (matches root `package.json#packageManager`)
- node `20`
- bun `1.3.11` (matches `packages/daemon/scripts/build-binaries.sh`)

Bump them in lockstep when upgrading.

## Cutting a release

```bash
# Make sure main is clean and CI is green.
git checkout main && git pull

# Pick a version. Follow semver: bump MAJOR for breaking, MINOR for new
# features, PATCH for fixes.
VERSION=0.1.0

# Tag and push.
git tag -s -m "beevibe v${VERSION}" "v${VERSION}"
git push origin "v${VERSION}"
```

That's it. The workflow handles:
- Bumping `packages/daemon/package.json` version to match the tag
- Building 4 platform binaries via Bun compile
- Generating `.sha256` files
- Creating the GitHub release with all assets
- Bundling and publishing `@beevibe/daemon@${VERSION}` to npm
- Generating + committing `Formula/beevibe-daemon.rb` to the tap repo

Watch the workflow run: https://github.com/beevibe-ai/beevibe/actions/workflows/release.yml

## After release: smoke test

```bash
# 1. Brew install
brew tap beevibe-ai/tap
brew install beevibe-daemon
beevibe-daemon --help

# 2. npm install
npx -y @beevibe/daemon@latest --help

# 3. Direct GitHub download
curl -fsSL -o /tmp/beevibe-daemon \
  "https://github.com/beevibe-ai/beevibe/releases/latest/download/beevibe-daemon-darwin-arm64"
chmod +x /tmp/beevibe-daemon
/tmp/beevibe-daemon --help

# 4. Auto-update path: install an older version, then run `update`
beevibe-daemon update
# (no-op if you're already on latest)
```

## Yanking a release

If a release ships a bug bad enough that you'd rather not have anyone on it:

```bash
# 1. Mark the GitHub release as a pre-release or draft to remove from "latest"
gh release edit "v${VERSION}" --prerelease

# 2. Deprecate the npm version (deprecation reason shows on install)
npm deprecate @beevibe/daemon@${VERSION} "use ${PREV_VERSION} until v${VERSION + 1}"

# 3. Manually revert the homebrew-tap commit (or push a new formula tagged at
#    the prior version)
```

Don't unpublish from npm — it breaks dependents and is generally hostile.
Deprecation is the standard path.

## Known issues / footguns

### Railway deploy: first deploy crashes if no public domain is set

When deploying the api to a Railway service that doesn't yet have a public
domain generated, the auto-derivation of `BEEVIBE_MCP_SERVER_URL` from
`RAILWAY_PUBLIC_DOMAIN` falls back to undefined and the api crashes at
startup with `Missing required env vars: BEEVIBE_MCP_SERVER_URL`.

**Mitigation in the eventual Railway template (PR C work):** the template
definition pre-generates the public domain for the api service so the
first deploy has `RAILWAY_PUBLIC_DOMAIN` set in its environment.

**For manual setups:** generate the api service's domain (`railway domain
--service api`) before triggering the first deploy, then trigger a
redeploy if needed. Subsequent deploys carry the env var fine.
