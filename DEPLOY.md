# Deploying & updating a project-wizard install

Each install is a **git checkout** on the target Docker host. Updates are
pull-based: you push to GitHub, then each install pulls and rebuilds. No file
copying from anyone's laptop.

```
push to GitHub  →  on each server:  bash scripts/update.sh  →  pulls + rebuilds
```

Projects and uploaded reference files live in the **`project-wizard-data`**
Docker volume, so rebuilds and updates never touch your data.

## First-time install on a new server

```bash
# 1. clone (read-only access set up in step 2)
git clone https://github.com/SteamGauge-Consulting/project-wizard.git ~/apps/project-wizard
cd ~/apps/project-wizard

# 2. one-time: give THIS server read-only pull access via a deploy key
bash scripts/setup-deploy-key.sh
#    → paste the printed public key at the repo's Deploy keys (read-only),
#      then the script's remote switch to SSH lets this box pull forever.

# 3. start it
docker compose up -d --build
```

## Updating an existing install

```bash
cd ~/apps/project-wizard
bash scripts/update.sh          # fetch origin/main, hard-reset, rebuild
# bash scripts/update.sh <branch>   # to track a non-main branch
```

`update.sh` hard-resets the working tree to `origin/<branch>`, so an install
always mirrors the repo (any local drift from an earlier manual copy is
discarded cleanly). Data is preserved in the named volume.

## One-time auth on a server that already exists (e.g. cloned over HTTPS)

If `git pull` prompts for a GitHub username/password and fails (HTTPS password
auth is no longer supported), give the box a deploy key once:

```bash
cd ~/apps/project-wizard
bash scripts/setup-deploy-key.sh   # generates key, switches remote to SSH, prints the pubkey
# add the printed key at: Repo → Settings → Deploy keys → Add (read-only)
bash scripts/update.sh
```

## Optional: auto-update on a schedule

To have a host self-update (e.g. nightly), add a cron entry:

```bash
# crontab -e   — pull + rebuild every night at 03:17
17 3 * * * cd $HOME/apps/project-wizard && bash scripts/update.sh >> $HOME/apps/project-wizard-update.log 2>&1
```

Leave this off if you prefer to update deliberately after each push.
