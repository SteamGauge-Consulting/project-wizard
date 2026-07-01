#!/usr/bin/env bash
# ============================================================================
#  update-all.sh — update THIS wizard AND every app it has deployed to the
#  latest origin/<branch>, then exit.
#
#  Launched DETACHED by the wizard's POST /api/self-update (via SSH from the
#  container to its own host). It must be detached because rebuilding the wizard
#  recreates the very container that triggered it — anything tied to that request
#  would be killed mid-run. Progress is logged to /tmp/pw-update-all.log.
#
#  Order matters: rebuild the wizard FIRST (so its baked image carries the new
#  engine), wait for it to come back, THEN ask it to redeploy each deployed app
#  (which ships that new engine to the pods).
# ============================================================================
set -uo pipefail

cd "$(dirname "$0")/.."
BRANCH="${1:-main}"
PORT="${PORT:-4500}"
LOG="${PW_UPDATE_LOG:-/tmp/pw-update-all.log}"

{
  echo "=== $(date -u '+%Y-%m-%dT%H:%M:%SZ') update-all start (branch=$BRANCH) ==="

  # Let the wizard's HTTP response to the browser flush before we recreate its
  # container out from under it.
  sleep 4

  # 1. Update + rebuild the wizard itself (force-recreate so BUILD_VERSION refreshes).
  if ! bash scripts/update.sh "$BRANCH"; then
    echo "!! wizard update failed — aborting"; exit 1
  fi

  # 2. Wait for the rebuilt wizard to answer again.
  echo "-> waiting for wizard health on http://localhost:${PORT}/healthz"
  up=0
  for i in $(seq 1 60); do
    if curl -fsS "http://localhost:${PORT}/healthz" >/dev/null 2>&1; then up=1; echo "   wizard is up"; break; fi
    sleep 3
  done
  if [ "$up" != "1" ]; then echo "!! wizard did not come back in time — skipping app redeploys"; exit 1; fi

  # 3. Redeploy every deployed app to the new engine (data-preserving).
  echo "-> redeploying deployed apps"
  if curl -fsS -X POST "http://localhost:${PORT}/api/update-apps" -H 'content-type: application/json' -H "x-deploy-password: ${PW_APP_SSH_PASSWORD:-}" -d '{}'; then
    echo ""
  else
    echo "!! update-apps call failed (apps may need SSH creds) — wizard itself is updated"
  fi

  echo "=== $(date -u '+%Y-%m-%dT%H:%M:%SZ') update-all done ==="
} >>"$LOG" 2>&1
