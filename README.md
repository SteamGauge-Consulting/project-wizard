# Project Wizard

A standalone, multi-project **planning + scaffolding** app. Each project walks a
human through the decisions only a human can make — product, requirements,
locked decisions, milestones, risks, non-functional/scale — then **generates the
project's full `/docs` structure** (pages, governance library, markdown corpus,
GitHub gate) plus a `PLAN-INTAKE.json` and an `AI-HANDOFF.md` for a coding agent
to build from. From the same screen you can **download it** or **deploy it as a
container** to a Docker host over SSH.

- **Home** — a tile per project + a **New project** button (also the empty state).
- **Draft tile → wizard.** A multi-step intake that autosaves server-side.
- **Generated tile → the doc structure**, browsable, with an **Export** menu:
  server bundle `.zip` · standalone static HTML · **Deploy to Docker** (over SSH).

It runs as one container. Stand it up once on a host (e.g. per client), and users
create projects in the browser and deploy them onto that same host.

---

## Stand it up on a host with Claude Code (over SSH)

This is the one-shot setup. Point a Claude Code session at this repo, give it a
target host, and it does the rest — ending with the wizard live at
`http://wizard.<HOST_IP>.nip.io/` and a working **New project** button.

**You provide:** this repo's URL, and the Docker host's **IP**, **SSH user**, and
**SSH password** (or a key). The host is any reachable **Ubuntu** box on your LAN
— a fresh VM is fine; Docker need not be installed yet.

**Paste this into a fresh Claude Code session** (fill in the blanks):

```text
Set up the Project Wizard on my Docker host, end to end.

Repo: https://github.com/SteamGauge-Consulting/project-wizard
Host IP: <HOST_IP>
SSH user: <USER>
SSH password: <PASSWORD>        (or: SSH key at <PATH>)

Do this:
1. Clone the repo locally.
2. Confirm SSH to the host: `ssh <USER>@<HOST_IP> 'echo ok'`
   (use sshpass for the password, or my key; accept the host key on first connect).
3. Copy the repo to ~/apps/project-wizard/ on the host with rsync, excluding
   node_modules, .git, and data.
4. On the host, run:  bash ~/apps/project-wizard/scripts/setup-host.sh <HOST_IP>
   (it installs Docker if missing, sets log rotation, creates the `web` network,
    brings up a Traefik reverse proxy, then builds + starts the wizard behind it).
5. Verify http://wizard.<HOST_IP>.nip.io/ returns 200, then give me that URL.

When done, the wizard homepage with the "New project" button should be live.
```

**What the host ends up running:** Docker + a Traefik reverse proxy + this wizard,
all reachable by hostname via [nip.io] (no DNS setup). The wizard lands at
`wizard.<HOST_IP>.nip.io`; every project a user later deploys from it lands at
`<name>.<HOST_IP>.nip.io` on the same box.

> **Repo access:** if this repo is private, Claude clones it with its own
> credentials and rsyncs to the host (the host needs no GitHub access). If you
> make it public, the host can `git clone` it directly instead of rsync.

**Prefer to run it yourself?** SSH to the host, get the repo there (`git clone` or
copy), then:

```bash
bash scripts/setup-host.sh        # uses the box's primary IP; or pass one explicitly
```

---

## How users use it

1. Open `http://wizard.<HOST_IP>.nip.io/` → **New project**.
2. Walk the steps (Product · Integrations · Requirements · Decisions · Milestones
   · Risks · Non-Functional & Scale), then **Generate**.
3. On the project's doc view, hit **Export**:
   - **Download — server bundle** (run with `npm start`),
   - **Download — standalone HTML** (flat pages, relative links, opens from a
     Downloads folder with no server), or
   - **Deploy to Docker** — enter the host IP, SSH user + **password**, an app
     name, and an optional `<name>.<HOST_IP>.nip.io` hostname, then **Deploy now**.
     The wizard rsyncs the package to the host and runs `docker compose up -d
     --build`, showing the live URL + build log.

Watch containers come up at the **Traefik dashboard** (`http://<HOST_IP>:8080`),
or add **Portainer** for a full GUI.

---

## Architecture

```
            ┌──────────────────────── Ubuntu Docker host ────────────────────────┐
  browser → │  Traefik (:80)  ──Host(`wizard.<ip>.nip.io`)──►  project-wizard      │
            │     │            ──Host(`<proj>.<ip>.nip.io`)──►  deployed project ◄─┐│
            │     └── dashboard :8080                                             ││
            │                                                                     ││
            │  project-wizard ── SSH/rsync + `docker compose up` ─────────────────┘│
            │  (deploys generated projects onto this same host)                    │
            └──────────────────────────────────────────────────────────────────────┘
```

- **One container per app**, all on a shared external `web` network; Traefik
  routes by `Host` header. No app publishes a port (Traefik owns :80).
- The wizard image carries `openssh-client` + `rsync` + `sshpass` so **Deploy
  now** can push to the host (incl. its own host) over SSH.
- `scripts/setup-host.sh` is idempotent — safe to re-run to update.

---

## Run locally (dev)

```bash
npm install
npm start          # http://localhost:4500
```

## Layout

```
project-wizard/
├── server.js              ← Express: projects API, generate (docs-kit), exports, deploy-over-SSH
├── Dockerfile             ← node:20-alpine + zip/openssh/rsync/sshpass
├── docker-compose.yml     ← portable base (publishes :4500); setup-host.sh adds a Traefik override
├── scripts/
│   └── setup-host.sh      ← one-shot host setup (Docker + Traefik + wizard)
├── lib/
│   ├── storage.js         ← atomic per-project JSON (data/projects/<id>.json)
│   ├── docs-kit.js        ← vendored generator (the one-file /docs bootstrap)
│   ├── static-site.js     ← build flat, relative-linked static HTML
│   └── deploy-bundle.js   ← Dockerfile/compose/deploy.sh for a target host
├── public/
│   ├── index.html · styles.css · app.js   ← shell, dark design system, router + tiles + export sheet
│   ├── wizard.js          ← the PLAN intake steps
│   └── demo-sequence.html ← worked example (a fully filled-in plan)
└── data/                  ← projects/ + generated/ (gitignored; a volume in prod)
```

## API

| Method | Path | Does |
|---|---|---|
| `GET/POST/PUT/DELETE` | `/api/projects[/:id]` | list / create / save answers / delete |
| `POST` | `/api/projects/:id/generate` | run docs-kit → materialize the structure |
| `GET` | `/api/projects/:id/files`, `/file?path=` | browse the generated tree |
| `GET` | `/api/projects/:id/download` | zip of the server bundle |
| `GET` | `/api/projects/:id/download-static` | zip of the standalone static HTML |
| `GET` | `/api/projects/:id/download-deploy?host=…` | zip of a runnable deploy bundle |
| `POST` | `/api/projects/:id/deploy` | push + `docker compose up` on a host over SSH |

## Notes

- **No secrets stored.** The wizard collects only non-secret integration values;
  generated structures ship key placeholders. An SSH password entered for
  **Deploy now** is used transiently and never persisted.
- The generated ADRs/requirements/milestones are docs-kit's **worked examples** —
  the project's real answers live in `PLAN-INTAKE.json`, and `AI-HANDOFF.md` tells
  a coding agent to rewrite the examples into the project's real artifacts
  (inferring implementation, covering common blind spots, and never polluting an
  existing tracker project).
- **Updating the generator:** `lib/docs-kit.js` is a vendored copy of the Sequence
  repo's root `docs-kit.js`. Refresh it with `cp ../Sequence/docs-kit.js
  lib/docs-kit.js` (adjust the path). The AI-handoff prompt lives in
  `handoffOf()` in `server.js`, so refreshing the kit never clobbers it.

[nip.io]: https://nip.io
