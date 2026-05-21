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
set -e

cd /app

echo "[start-api] migration-name fix"
node scripts/pre-deploy-fix-migration-names.cjs

echo "[start-api] applying pending migrations"
packages/api/node_modules/.bin/node-pg-migrate up

echo "[start-api] launching api"
exec node packages/api/dist/main.js
