# project-wizard

A standalone, multi-project planning app. Each project walks a human through the
PLAN-phase decisions only a human can make (product, requirements, locked
decisions, milestones, risks), then **generates that project's full `/docs`
structure** by running [docs-kit](../docs-kit.js) with the project's values.

- **Home** — a tile per project + a **New project** button (also the empty state).
- **Draft tile → wizard.** A multi-step intake that autosaves to the server.
- **Generated tile → the doc structure.** A browsable file tree of everything
  docs-kit produced (pages, governance library, markdown corpus, the GitHub
  gate) plus the project's `PLAN-INTAKE.json` and `AI-HANDOFF.md`, with a
  **Download .zip**.

Server-side JSON storage; no auth (deploy behind a private IP / its own network).

## Run locally

```bash
npm install
npm start          # http://localhost:4500
```

## Docker

```bash
docker build -t project-wizard .
docker run -d --name project-wizard \
  -p 4500:4500 \
  -v project-wizard-data:/app/data \
  project-wizard
```

Give it its own IP however you wire the container (macvlan, a reverse proxy, a
dedicated host). The named volume `project-wizard-data` keeps projects + their
generated trees across restarts.

## Layout

```
project-wizard/
├── server.js            ← Express: projects API, generate (runs docs-kit), file browse, zip
├── lib/
│   ├── storage.js       ← atomic per-project JSON (data/projects/<id>.json)
│   └── docs-kit.js      ← vendored generator (the one-file /docs bootstrap)
├── public/
│   ├── index.html       ← shell
│   ├── styles.css       ← dark design system (shared with the Sequence /docs)
│   ├── app.js           ← hash router + home tiles + generated-docs browser
│   └── wizard.js        ← the PLAN intake steps, API-backed
├── data/                ← projects/ + generated/ (gitignored; mount as a volume)
└── Dockerfile
```

## API

| Method | Path | Does |
|---|---|---|
| `GET` | `/api/projects` | list (summaries) |
| `POST` | `/api/projects` | create `{name}` → project |
| `GET` | `/api/projects/:id` | full project (answers) |
| `PUT` | `/api/projects/:id` | save `{name, answers}` (wizard autosave) |
| `DELETE` | `/api/projects/:id` | delete project + generated tree |
| `POST` | `/api/projects/:id/generate` | run docs-kit → materialize the structure |
| `GET` | `/api/projects/:id/files` | generated file tree |
| `GET` | `/api/projects/:id/file?path=` | one generated file's content |
| `GET` | `/api/projects/:id/download` | zip of the generated structure |

## Updating the generator

`lib/docs-kit.js` is a copy of the repo-root `docs-kit.js`. When that's
regenerated (`npm run build-docs-kit` in the parent repo), refresh the copy:

```bash
cp ../docs-kit.js lib/docs-kit.js
```

## Notes

- **No secrets here.** The wizard collects only non-secret integration values;
  the generated structure ships key placeholders. Pass real keys to docs-kit on
  the CLI at deploy time (see the generated `.github/CLAUDE-APP-SETUP.md` and the
  kit's `--help`).
- The generated ADRs/requirements/milestones are docs-kit's **worked examples** —
  the project's actual answers live in `PLAN-INTAKE.json`, and `AI-HANDOFF.md` is
  the prompt that tells a coding agent to rewrite the examples into the project's
  real artifacts.
```
