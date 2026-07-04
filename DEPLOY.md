# Deploying & updating a project-wizard install

Each install is a **git checkout** on the target Docker host. Updates are
pull-based: you push to GitHub, then each install pulls and rebuilds. No file
copying from anyone's laptop.

```
push to GitHub  →  on each server:  bash scripts/update.sh  →  pulls + rebuilds
```

Projects and uploaded reference files live in the **`project-wizard-data`**
Docker volume, so rebuilds and updates never touch your data.

## Git auth for a server — pick the method your org allows

A server needs read access to pull this private repo. Two ways:

- **Classic PAT over HTTPS — use this for `SteamGauge-Consulting`.** This org has
  **deploy keys *and* fine-grained tokens disabled**, so a *classic* PAT (made at
  github.com/settings/tokens, **`repo`** scope, on your personal account) is the
  one that works. The repo stays private. Setup is in "First-time install" below.
- **SSH deploy key** (`scripts/setup-deploy-key.sh`) — cleaner per-server,
  read-only, but only if your org *allows* deploy keys. It does not work for
  `SteamGauge-Consulting` today. Use it only on an org/repo where deploy keys are
  enabled.

## First-time install on a new server (classic PAT)

```bash
# 1. clone with a classic PAT, then strip the token back out of git config
git clone https://<CLASSIC_PAT>@github.com/SteamGauge-Consulting/project-wizard.git ~/apps/project-wizard
cd ~/apps/project-wizard
git remote set-url origin https://github.com/SteamGauge-Consulting/project-wizard.git

# 2. store the token so future pulls / update.sh run unattended
git config credential.helper store
git fetch origin main          # Username = your GitHub login · Password = the PAT

# 3. start it
docker compose up -d --build
```

### Set your house defaults (org standard stack)

On first start the server seeds **`house-defaults.json`** into the persistent
data volume (`/app/data/house-defaults.json`) from the committed
`house-defaults.example.json`. This is your org's default stack — every new
project pre-seeds its architecture **decisions** from it (database, auth,
hosting, secrets, …), and the wizard's Decisions step + "Load examples" read it.
Each value stays editable per project.

Edit it to match your standard; it then sticks, because it lives in the data
volume (so `scripts/update.sh`'s hard-reset never touches it):

```bash
docker compose exec project-wizard sh -lc 'vi /app/data/house-defaults.json'
# set a choice to "" to ship no opinion for that concern
```

Nothing stack-specific is baked into the code or the AI prompts — change the
default in one place here.

## Microsoft Entra (Azure AD) SSO

Gate the wizard **and every docs pod it deploys** behind corporate sign-in.
Off by default; turn it on with an `.env` next to `docker-compose.yml` (untracked,
so `update.sh`'s hard-reset never discards it):

```bash
# ~/apps/project-wizard/.env
AUTH_MODE=entra
ENTRA_TENANT_ID=<your-tenant-guid>
ENTRA_CLIENT_ID=<app-registration-client-id>
ENTRA_CLIENT_SECRET=<client-secret-value>
ENTRA_ALLOWED=@treebrandapps.com          # comma list of emails and/or @domains
AUTH_PUBLIC_URL=https://projects.treebrandapps.com   # the wizard's own https origin
AUTH_SESSION_HOURS=12
```

Then `docker compose up -d --build`. How it works:

- **One Azure app registration per org** serves the wizard and all its pods. Add
  a **redirect URI** for each surface: `https://projects.<domain>/auth/callback`
  (wizard) and `https://<app-host>/docs/auth/callback` for each pod exposed at
  `/docs`. Pods inherit the wizard's tenant/client/secret automatically at deploy
  — you only register their redirect URI in Azure.
- **Authorization is the `ENTRA_ALLOWED` allow-list.** A valid tenant sign-in is
  necessary but not sufficient — the account's email (or its `@domain`) must be
  listed, or it's rejected with a "not authorized" page.
- **Machine surfaces stay open**: loopback (internal forwards, `update.sh`),
  `/api/agent/*` (its own bearer tokens), and the shared machine token the wizard
  bakes into pods keep the wizard↔pod deploy callbacks working under the gate.
- **Misconfig fails closed**: `AUTH_MODE=entra` with missing `ENTRA_*` returns 503
  everywhere rather than serving open.

**Reproduce for another domain** (e.g. `steamgaugeconsulting.com`): stand up a
separate install with that org's own `.env` (its tenant/client/secret,
`AUTH_PUBLIC_URL`, and `ENTRA_ALLOWED`). Nothing is shared between installs.

Redeploy each existing pod once after enabling so it picks up the gate (the
wizard forwards the Entra config into the pod's compose on deploy).

## Updating an existing install

```bash
cd ~/apps/project-wizard
bash scripts/update.sh          # fetch origin/main, hard-reset, rebuild
# bash scripts/update.sh <branch>   # to track a non-main branch
```

`update.sh` hard-resets the working tree to `origin/<branch>`, so an install
always mirrors the repo (any local drift from an earlier manual copy is
discarded cleanly). Data is preserved in the named volume.

## Fixing auth on a server that already exists

If `git pull`/`update.sh` fails with `Permission denied (publickey)` (remote is
SSH but the org blocks deploy keys) or prompts for a password it then rejects
(HTTPS password auth is gone), put it on the classic-PAT path:

```bash
cd ~/apps/project-wizard
git remote set-url origin https://github.com/SteamGauge-Consulting/project-wizard.git
git config --unset core.sshCommand 2>/dev/null || true   # drop any leftover SSH-key override
git config credential.helper store
rm -f ~/.git-credentials                                 # clear any stale/bad stored cred
git fetch origin main          # Username = your GitHub login · Password = a classic PAT
git reset --hard origin/main
docker compose up -d --build
```

Rotate the PAT in GitHub if it's ever exposed, then `rm ~/.git-credentials` and
re-run one `git fetch origin main` to store the new one.

## Optional: auto-update on a schedule

To have a host self-update (e.g. nightly), add a cron entry:

```bash
# crontab -e   — pull + rebuild every night at 03:17
17 3 * * * cd $HOME/apps/project-wizard && bash scripts/update.sh >> $HOME/apps/project-wizard-update.log 2>&1
```

Leave this off if you prefer to update deliberately after each push.
