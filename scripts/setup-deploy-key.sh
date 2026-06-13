#!/usr/bin/env bash
# ============================================================================
#  setup-deploy-key.sh — one-time, per-server: give THIS install read-only git
#  access to the repo so `git pull` / scripts/update.sh work without a password.
#
#  Run it once on a new server, paste the printed public key into the repo's
#  Deploy keys (read-only), then use scripts/update.sh forever after.
#
#  Why a deploy key (not a password / PAT): GitHub dropped password auth over
#  HTTPS; a per-server read-only deploy key is the standard, least-privilege way
#  for an install to pull updates. It can only read this one repo.
# ============================================================================
set -euo pipefail

REPO_SSH="git@github.com:SteamGauge-Consulting/project-wizard.git"
KEY="$HOME/.ssh/project-wizard-deploy"

mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"
if [ ! -f "$KEY" ]; then
  echo "→ generating a read-only deploy key for $(hostname)"
  ssh-keygen -t ed25519 -N "" -C "project-wizard-deploy@$(hostname)" -f "$KEY"
fi

# Use this key only for git in this repo, and talk to GitHub over SSH.
cd "$(dirname "$0")/.."
git config core.sshCommand "ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
git remote set-url origin "$REPO_SSH"

cat <<EOF

────────────────────────────────────────────────────────────────────────────
1. Add this PUBLIC key as a READ-ONLY deploy key (leave "Allow write" OFF):
     https://github.com/SteamGauge-Consulting/project-wizard/settings/keys/new

$(cat "$KEY.pub")

2. Then update this install:
     bash scripts/update.sh
────────────────────────────────────────────────────────────────────────────
EOF
