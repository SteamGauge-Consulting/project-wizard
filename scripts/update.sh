#!/usr/bin/env bash
# ============================================================================
#  update.sh — pull the latest pushed code into THIS install and restart.
#
#  Usage:  bash scripts/update.sh [branch]      (defaults to main)
#
#  Installs TRACK the remote: this hard-resets the working tree to
#  origin/<branch> (discarding any local drift) and rebuilds the container.
#  Your data is safe — projects + uploaded reference files live in the
#  `project-wizard-data` Docker volume, which a rebuild never touches.
#
#  Requires read access to the repo from this server. One-time setup:
#  `bash scripts/setup-deploy-key.sh` (read-only SSH deploy key). See DEPLOY.md.
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."
BRANCH="${1:-main}"

echo "→ fetching origin/$BRANCH"
git fetch --prune origin "$BRANCH"

echo "→ syncing working tree to origin/$BRANCH"
git checkout -q "$BRANCH" 2>/dev/null || git checkout -q -b "$BRANCH" "origin/$BRANCH"
git reset --hard "origin/$BRANCH"

echo "→ rebuilding + restarting container"
# Stamp the build with the git short SHA so the wizard (and the pods it deploys)
# can show which version is running.
export BUILD_VERSION="$(git rev-parse --short HEAD)"
docker compose up -d --build
docker image prune -f >/dev/null 2>&1 || true

echo "✓ updated to $BUILD_VERSION on $BRANCH"
