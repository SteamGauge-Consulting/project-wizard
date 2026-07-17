# Agent API — give another Claude session direct access to a project

The wizard exposes a small, **token-authenticated HTTP API** so a *different*
Claude session (or any client) can read and edit an in-flight project directly —
the "here's a URL and a key, go work on it" flow, MCP-server in spirit but with
nothing to install: just `curl`/`fetch`.

A token is **scoped to one project** and to a **scope** (`read` or `write`). A
write token can edit the plan, regenerate the docs, run assess/apply, deploy, and
read that project's integration secrets (SSH + API keys). Any token can also read
*every other* project on the wizard for cross-app architecture context — but never
another project's secrets.

The API is **self-describing**: `GET {base}` returns the full operation catalog
and the current field schema, so a session pointed at the base URL + token can
discover everything without this doc.

---

## 1. Get a key

**From the UI (easiest).**
- **Connect Agent** — button in the home management bar (next to *Containers* /
  *Proxy*). Shows the LAN API base, lets you pick any project, mint a key, and
  copy a ready-to-paste block for a new Claude session.
- **Share with agent** — button on a generated project's page. Same thing, scoped
  to that project.

Either way you get a **paste-in kit** — drop it into the other session verbatim.
The secret is shown **once**; mint a new key if you lose it.

**From the API (for scripting).**
```bash
# mint a write key for project <id>
curl -s -X POST http://wizard.<ip>.nip.io/api/projects/<id>/agent-tokens \
  -H 'content-type: application/json' \
  -d '{"name":"build session","scope":"write"}'
# -> { token: "pwk_<id>_<secret>", base: "...", kit: "<paste-in text>", record: {...} }
```
List / revoke:
```bash
curl -s http://wizard.<ip>.nip.io/api/projects/<id>/agent-tokens          # metadata only
curl -s -X DELETE http://wizard.<ip>.nip.io/api/projects/<id>/agent-tokens/<tokenId>
```
> These UI-side mint/list/revoke routes are **unauthenticated**, like the rest of
> the wizard UI — the app is meant to run behind a private LAN IP. Anyone who can
> reach the wizard can mint a key; anyone with a key can use the agent API.

---

## 2. Authenticate

Base URL: `http://wizard.<ip>.nip.io/api/agent` (over the LAN via nip.io).

Send the token as a bearer header (preferred) or a query param:
```bash
curl -s -H "Authorization: Bearer pwk_<id>_<secret>" {base}
curl -s "{base}/project?token=pwk_<id>_<secret>"
```
The token embeds the project id, so no `:id` appears in agent URLs — the token
*is* the project selector. Token format: `pwk_<projectId 16hex>_<secret 32hex>`.
Only `sha256(secret)` is stored server-side.

---

## 3. Discover — `GET {base}`

Returns a manifest: the project summary, your scope, the field schema, and the
list of operations available to your scope. **Always fetch this first.** Then
`GET {base}/project` for the full current state.

---

## 4. Operations

### Read (read + write tokens)
| Method & path | What |
|---|---|
| `GET {base}` | Manifest: operations + schema. |
| `GET {base}/project` | The whole project (answers, attachments, status, baseline, changes, deploy). Secrets masked; token hashes dropped. |
| `GET {base}/answers` | Just the `answers` object. |
| `GET {base}/intake` | The composed `PLAN-INTAKE.json`. |
| `GET {base}/changes` | Change log + agent edit log + current baseline. |
| `GET {base}/attachments` | Reference / source files. |
| `GET {base}/files` | List generated `/docs` files (empty until generated). |
| `GET {base}/file?path=<rel>` | Read one generated file's text. |
| `GET {base}/connections` | Deploy + integration credentials (see §5). |
| `GET {base}/projects` | **Every** project on the wizard (cross-app context). |
| `GET {base}/projects/<id>` | Full details of any project (read-only; its secrets redacted). |
| `GET {base}/projects/<id>/intake` | Any project's composed intake. |
| `GET {base}/<collection>` | List rows of a collection. |
| `GET {base}/<collection>/<i>` | Read row `i`. |

### Edit content (write token)
| Method & path | What |
|---|---|
| `PATCH {base}/project` | Merge `{ name?, answers? }` (answers merged per section). |
| `PATCH {base}/product` | Merge fields into `answers.product`. |
| `PATCH {base}/integrations` | Merge fields into `answers.integrations`. |
| `PATCH {base}/connections` | Store per-project connection overrides (see §5). |
| `POST {base}/<collection>` | Append a row (body = the row object) → returns its index. |
| `PUT {base}/<collection>` | Replace the whole collection (JSON array of rows). |
| `PUT {base}/<collection>/<i>` | Replace row `i`. |
| `PATCH {base}/<collection>/<i>` | Merge fields into row `i`. |
| `DELETE {base}/<collection>/<i>` | Delete row `i`. |

Rows are addressed by **0-based index**; re-fetch if an index may have shifted.
Every write is appended to the project's **agent edit log** (`GET {base}/changes`).

### Lifecycle (write token)
| Method & path | What |
|---|---|
| `POST {base}/generate` | Regenerate the `/docs` structure from the current intake. |
| `POST {base}/assess` | Assess a proposed intake vs code + Linear. Body: `{ proposed, apiKey?, linearKey? }`. |
| `POST {base}/apply-changes` | Apply accepted change-units. Body: `{ proposed, units, accepted, apiKey?, linearKey? }`. |
| `POST {base}/deploy` | Deploy/redeploy to the Docker host over SSH. Omitted fields are backfilled from the project's resolved connections (§5), so an empty body redeploys to the last-known target. |

Content edits change the saved answers immediately, but the rendered `/docs` only
refresh when you `POST {base}/generate` (or apply changes).

### Data model (collections + fields)
| Collection | Row fields |
|---|---|
| `requirements` | `title`, `test` |
| `decisions` | `concern`, `choice`, `why` |
| `milestones` | `name`, `done`, `target` |
| `risks` | `risk`, `mitigation` |
| `scalability` | `area`, `target`, `adr` |
| `stakeholders` | `name`, `email`, `phone`, `role` |

`answers.product`: `name, oneliner, problem, users, goal, success, differentiator,
experience, notBuilding, domain`.
`answers.integrations`: `docsDir, githubRepoUrl, linearWorkspaceUrl,
linearProjectUrl, linearProjectId`.

---

## 5. Connections — the "how do I reach the Docker host / which keys" endpoint

`GET {base}/connections` returns the deploy + integration credentials the wizard
holds for the project, resolved in priority order:

**per-project override (`PATCH {base}/connections`) → the project's recorded
deploy target / integrations → the wizard's environment variables
(`DEPLOY_SSH_*`, `ANTHROPIC_API_KEY`, `LINEAR_API_KEY`, `GITHUB_TOKEN`,
`GROK_API_KEY`/`XAI_API_KEY`, `LINEAR_PROJECT_ID`, `GITHUB_REPO_URL`) → a host IP
derived from the live deploy URL / `HOST_IP`.**

```jsonc
{
  "ok": true,
  "scope": "write",
  "includesSecrets": true,
  "effective": {
    "sshHost": "10.10.0.208", "sshUser": "deployer", "sshPort": "2222",
    "sshPassword": "…",          // secret — write token only
    "hostname": "docs.10.10.0.208.nip.io",
    "anthropicKey": "sk-ant-…",  // secret — write token only
    "grokKey": "…", "linearKey": "…", "githubToken": "…",  // secrets — write only
    "linearProjectId": "…", "githubRepoUrl": "…"
  },
  "configured": { "sshHost": true, "sshPassword": true, "anthropicKey": true, ... },
  "deployUrl": "http://docs.10.10.0.208.nip.io/docs"
}
```

- **Write token:** secret *values* included (`includesSecrets: true`). Use
  `sshHost`/`sshUser`/`sshPort`/`sshPassword` to SSH to the Docker host;
  `anthropicKey`/`linearKey`/`githubToken` for those services. `githubRepoUrl`
  (+ `githubToken` for private repos) also feeds Assess: the repo's latest
  default-branch commit is pulled into the code corpus alongside the uploads.
- **Read token:** secret values withheld; `configured` still shows what's set.

Fields (secrets marked ★): `sshHost, sshUser, sshPort, sshPassword★, hostname,
anthropicKey★, grokKey★, linearKey★, linearProjectId, githubRepoUrl, githubToken★`.

`PATCH {base}/connections` stores overrides on the project (so a never-deployed
project can be handed its target/keys). Set a field to `""`/`null` to clear the
override and fall back to env.

---

## 6. Security notes

- Tokens are per-project and per-scope; only `sha256(secret)` is stored. Secret
  comparison is constant-time. Revocation is immediate.
- The generic `/project` read and all **cross-project** reads mask connection
  secret values and drop token records. Secret *values* are returned only to a
  **write** token, only for its **own** project, only via `/connections`.
- Cross-project access is **read-only** — a token can never edit or deploy a
  project other than its own.
- Everything trusts the private-network deployment model: the wizard has no
  app-level auth and no rate limiting. Don't expose it to the public internet.
- Agent-supplied JSON keys are stripped of `__proto__`/`constructor`/`prototype`;
  `/file` is confined to the project's generated tree.

---

## 7. Example session

```bash
BASE=http://wizard.192.168.1.220.nip.io/api/agent
TOK=pwk_ab12…_ff… ; H="Authorization: Bearer $TOK"

curl -s -H "$H" $BASE                     # what can I do?
curl -s -H "$H" $BASE/project             # current plan
curl -s -H "$H" $BASE/connections         # how to reach the host + keys
curl -s -H "$H" $BASE/projects            # sibling apps for architecture context

# edit
curl -s -X PATCH $BASE/product -H "$H" -H 'content-type: application/json' \
  -d '{"oneliner":"Fastest widgets on the LAN"}'
curl -s -X POST $BASE/requirements -H "$H" -H 'content-type: application/json' \
  -d '{"title":"Password reset","test":"reset email within 60s"}'

# re-render docs, then redeploy to the known target
curl -s -X POST $BASE/generate -H "$H"
curl -s -X POST $BASE/deploy   -H "$H"
```
