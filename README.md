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

### Recommended: Claude Code running *on* the Ubuntu box

The cleanest setup (and the one these instructions assume) is to run **Claude Code
on the Ubuntu host itself**, driven by **Claude Desktop** on your Windows PC over a
remote connection. Because the agent lives on the host, the work **keeps running
even after you shut the Windows PC down** — and there's no SSH hop to babysit.

Install Claude Code on the box once (`curl -fsSL https://claude.ai/install.sh | bash`,
or see the docs), connect Claude Desktop to it, then paste the prompt below.

**Paste this into the Claude Code session on the host** (fill in the blanks):

```text
Set up the Project Wizard on this Docker host, end to end. You are running ON the
target Ubuntu box, so run everything locally — no SSH.

Repo: https://github.com/SteamGauge-Consulting/project-wizard
GitHub token: <GH_TOKEN>        (classic PAT, `repo` scope — to clone the private repo)
Host IP: <HOST_IP>              (optional — omit to use this box's primary LAN IP)

Run this single command (it installs git, clones the repo with the token, strips
the token back out of git config, then runs the setup):

   sudo apt-get update -qq && sudo apt-get install -y -qq git \
   && rm -rf ~/apps/project-wizard \
   && git clone https://<GH_TOKEN>@github.com/SteamGauge-Consulting/project-wizard.git ~/apps/project-wizard \
   && git -C ~/apps/project-wizard remote set-url origin https://github.com/SteamGauge-Consulting/project-wizard.git \
   && bash ~/apps/project-wizard/scripts/setup-host.sh <HOST_IP>

setup-host.sh installs Docker (+ log rotation), creates the `web` network, brings
up a Traefik reverse proxy AND Portainer, then builds + starts the wizard behind
the proxy. When it finishes, verify http://wizard.<HOST_IP>.nip.io/ returns 200
and give me that URL.
```

### Alternative: drive it over SSH from your own machine

If you'd rather run Claude Code on your laptop and reach the host over SSH (works
from macOS, Linux, or Windows — Windows has `ssh` built in), use this prompt
instead. Everything still executes ON the host inside one SSH session:

```text
Set up the Project Wizard on my Docker host, end to end.

Repo: https://github.com/SteamGauge-Consulting/project-wizard
GitHub token: <GH_TOKEN>        (classic PAT, `repo` scope — to clone the private repo)
Host IP: <HOST_IP>
SSH user: <USER>
SSH auth: <key at <PATH>  OR  password: <PASSWORD>>

1. SSH to the host. If a key path was given use `ssh -i <PATH> <USER>@<HOST_IP>`;
   if a password was given, authenticate with it (accept the host key on first
   connect). On Windows with password auth, run the ssh command interactively.
2. On the host, run the same single command shown above (apt-get install git →
   git clone with the token → strip the token → bash setup-host.sh <HOST_IP>).
3. Verify http://wizard.<HOST_IP>.nip.io/ returns 200, then give me that URL.
```

**What the host ends up running:** Docker + a Traefik reverse proxy + Portainer +
this wizard, all reachable by hostname via [nip.io] (no DNS setup). The wizard
lands at `wizard.<HOST_IP>.nip.io`; Portainer at `portainer.<HOST_IP>.nip.io`; the
Traefik dashboard at `<HOST_IP>:8080`; and every project a user later deploys from
the wizard lands at `<name>.<HOST_IP>.nip.io` on the same box. The wizard homepage
also carries **🐳 Containers** (Portainer) and **🔌 Proxy** (Traefik) buttons.

> **Repo access — it stays private; pick one:**
> 1. **No key** — Claude clones with the GitHub access already in your session,
>    then rsyncs to the host (the host needs no GitHub access). Simplest.
> 2. **A token** — give Claude a **classic PAT** (`repo` scope; read is enough)
>    and it clones over HTTPS: `git clone https://<TOKEN>@github.com/…`. Use this
>    when you want the *host itself* to clone or `git pull` updates later.
>    ⚠️ This org has **deploy keys and fine-grained tokens disabled**, so a
>    *classic* PAT is the kind that works — make one at
>    github.com/settings/tokens. (Personal account, not org settings.)
> 3. **Make it public** — then no key at all.
>
> Whichever you use, the repo never needs to be public. To rotate, revoke the
> classic PAT and issue a new one — nothing on the host is hard-wired to it
> unless you chose option 2's `git clone` (then update the stored credential).

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

Watch containers come up from the homepage buttons — **🐳 Containers** (Portainer,
a full container GUI) and **🔌 Proxy** (the Traefik dashboard) — both deployed by
`setup-host.sh` and reachable at `portainer.<HOST_IP>.nip.io` and
`<HOST_IP>:8080`.

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
│   └── setup-host.sh      ← one-shot host setup (Docker + Traefik + Portainer + wizard)
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
