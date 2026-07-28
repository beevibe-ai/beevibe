#!/bin/sh
# Beevibe API startup wrapper.
#
# Runs the pre-deploy migration-name fix + applies pending migrations BEFORE
# exec'ing the api process. We do this in startCommand (not Railway's
# preDeployCommand) because the preDeploy step has been failing silently in
# our setup — likely because node-pg-migrate was a root devDep that the
# api image's filtered install skipped. Running here guarantees migrations
# apply on every container start; in steady state it's a fast no-op.
#
# node-pg-migrate is now a direct dep of @beevibe/api, so its binary lives
# at packages/api/node_modules/.bin/node-pg-migrate inside the image.
#
# DO NOT remove "node-pg-migrate" from packages/api/package.json. It is
# never imported from api/src — it is invoked as a BINARY on the line
# below, at container start. Import-based dead-code tools (knip, eslint,
# depcheck) all report it as an unused dependency; it isn't. Dropping it
# makes the api container exit here under `set -e`, before the process
# ever launches, and the Railway healthcheck fails the deploy. Regressed
# exactly this way in PR #256, reverted in #257.
set -e

cd /app

echo "[start-api] migration-name fix"
node scripts/pre-deploy-fix-migration-names.cjs

echo "[start-api] applying pending migrations"
# --no-check-order: prod has 1780900000000_add-work-product-body recorded
# (via PR #187's rename) but the older 1780800000000_add-capability-network
# never applied. Default ordering check refuses to run a "preceding" file
# after a later one was recorded. We need exactly this out-of-order apply
# to unstick prod; once all four are in, subsequent boots are no-ops.
packages/api/node_modules/.bin/node-pg-migrate --no-check-order up

echo "[start-api] launching api"
exec node packages/api/dist/main.js
