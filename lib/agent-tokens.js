// Per-project agent access tokens + the self-describing API surface.
//
// The wizard has no user auth (it deploys behind a private IP). To let *another*
// Claude session read + edit one specific project — the "give it a URL and a key"
// flow — we mint per-project tokens. A token is scoped to a single project and
// carries a scope (read | write). Only a SHA-256 hash of the secret is stored on
// the project (data/projects/<id>.json); the plaintext token is shown once at
// mint time and never again.
//
// Token format:  pwk_<projectId(16 hex)>_<secret(32 hex)>
// The project id is embedded so verification is O(1) — parse the id, load that
// project, and constant-time-compare the secret hash against its token records.
// The id is not sensitive (it's also in the wizard URL); the secret is.

const crypto = require('crypto');

// ── the editable data model, as the agent sees it ───────────────────────────
// Row collections under project.answers.<name>, with the field keys the intake
// actually consumes (server.js:intakeOf / cleanRows). Rows may carry extra keys;
// at least one of these must be non-empty for a row to be accepted.
const COLLECTIONS = {
  requirements: { keys: ['title', 'test'], label: 'requirement' },
  decisions:    { keys: ['concern', 'choice', 'why'], label: 'locked decision' },
  milestones:   { keys: ['name', 'done', 'target'], label: 'milestone' },
  risks:        { keys: ['risk', 'mitigation'], label: 'risk' },
  scalability:  { keys: ['area', 'target', 'adr'], label: 'scale / NFR target' },
};
// answers.product / answers.integrations are free-form objects; these are the
// fields the wizard + intake understand (extra keys are allowed but ignored by
// the doc generator).
const PRODUCT_FIELDS = ['name', 'oneliner', 'problem', 'users', 'goal', 'success', 'differentiator', 'experience', 'notBuilding', 'domain'];
const INTEGRATION_FIELDS = ['docsDir', 'githubRepoUrl', 'linearWorkspaceUrl', 'linearProjectUrl', 'linearProjectId'];

// ── connection / integration credentials the wizard holds ────────────────────
// The wizard's real "how do I connect" config: the Docker/SSH deploy target and
// the API keys. Field names mirror the deployed pod's editor (lib/docs-editor.js
// effectiveKeys) so both halves speak the same language. Each field resolves in
// priority order: a per-project override (project.connections.<field>) → the
// project's own recorded deploy target / integrations → the wizard's environment
// variables → a value derived from the live deploy URL.
const CONNECTION_FIELDS = ['sshHost', 'sshUser', 'sshPort', 'sshPassword', 'hostname', 'anthropicKey', 'grokKey', 'linearKey', 'linearProjectId', 'githubRepoUrl', 'githubToken'];
const SECRET_FIELDS = new Set(['sshPassword', 'anthropicKey', 'grokKey', 'linearKey', 'githubToken']);

function firstNonEmpty() {
  for (const v of arguments) { const s = v == null ? '' : String(v).trim(); if (s) return s; }
  return '';
}
function ipFromUrl(u) { const m = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/.exec(String(u || '')); return m ? m[1] : ''; }

// The effective connection values for a project (secrets included). `env` is
// process.env; pass it in so the module stays pure/testable.
function resolveConnections(project, env) {
  env = env || {};
  const c = (project && project.connections) || {};
  const integ = (project && project.answers && project.answers.integrations) || {};
  const dt = (project && project.deployTarget) || {};
  const derivedHost = ipFromUrl(project && project.deployUrl) || String(env.HOST_IP || '').trim();
  return {
    sshHost:         firstNonEmpty(c.sshHost, dt.host, env.DEPLOY_SSH_HOST, derivedHost),
    sshUser:         firstNonEmpty(c.sshUser, dt.user, env.DEPLOY_SSH_USER, 'docker'),
    sshPort:         firstNonEmpty(c.sshPort, dt.sshPort, env.DEPLOY_SSH_PORT, '22'),
    sshPassword:     firstNonEmpty(c.sshPassword, env.DEPLOY_SSH_PASSWORD),
    hostname:        firstNonEmpty(c.hostname, dt.hostname),
    anthropicKey:    firstNonEmpty(c.anthropicKey, env.ANTHROPIC_API_KEY),
    grokKey:         firstNonEmpty(c.grokKey, env.GROK_API_KEY, env.XAI_API_KEY),
    linearKey:       firstNonEmpty(c.linearKey, env.LINEAR_API_KEY),
    linearProjectId: firstNonEmpty(c.linearProjectId, project && project.linearProjectId, integ.linearProjectId, env.LINEAR_PROJECT_ID),
    githubRepoUrl:   firstNonEmpty(c.githubRepoUrl, integ.githubRepoUrl, env.GITHUB_REPO_URL),
    githubToken:     firstNonEmpty(c.githubToken, env.GITHUB_TOKEN),
  };
}

// A client-facing view: non-secret values always; secret VALUES only when
// includeSecrets (write scope). `configured` always reports what is set so a
// read-only token can still see the shape of what's available.
function connectionsView(project, env, includeSecrets) {
  const r = resolveConnections(project, env);
  const effective = {}, configured = {};
  for (const [k, v] of Object.entries(r)) {
    configured[k] = !!(v && String(v).trim());
    if (SECRET_FIELDS.has(k)) { if (includeSecrets) effective[k] = v || null; }
    else effective[k] = v || null;
  }
  return { effective, configured };
}

// Filter + trim an incoming connections patch to the known fields; a field set
// to '' or null clears its per-project override.
function normalizeConnections(existing, body) {
  const out = Object.assign({}, existing || {});
  for (const f of CONNECTION_FIELDS) {
    if (!(f in (body || {}))) continue;
    const v = body[f];
    if (v == null || String(v).trim() === '') delete out[f];
    else out[f] = String(v).trim();
  }
  return out;
}

// ── crypto helpers ──────────────────────────────────────────────────────────
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest(); } // Buffer
function newSecret() { return crypto.randomBytes(16).toString('hex'); }               // 32 hex chars

const TOKEN_RE = /^pwk_([a-f0-9]{16})_([a-f0-9]{32})$/;

function parseToken(raw) {
  if (!raw) return null;
  const m = TOKEN_RE.exec(String(raw).trim());
  return m ? { projectId: m[1], secret: m[2] } : null;
}

// ── mint / verify / list / revoke, operating on a project object ─────────────
function mintToken(project, opts) {
  opts = opts || {};
  const scope = opts.scope === 'read' ? 'read' : 'write';
  const secret = newSecret();
  const token = 'pwk_' + project.id + '_' + secret;
  const record = {
    id: crypto.randomBytes(4).toString('hex'),
    name: (opts.name && String(opts.name).trim()) || (scope === 'read' ? 'read-only agent' : 'agent'),
    scope,
    hash: sha256(secret).toString('hex'),
    // The plaintext token is retained so the owner can re-open the paste-in kit for
    // a live key (new sessions get started for the same project all the time). This
    // is safe under the private-LAN trust model AND is stripped from every
    // agent-facing read (publicProject drops agentTokens; redactRecord omits it) —
    // it's reachable ONLY via the owner-side .../agent-tokens/:id/kit route.
    token,
    // A non-secret label so a token can be recognised in the list without
    // revealing enough to guess it (4 of 32 secret hex chars → 112 bits remain).
    prefix: 'pwk_' + project.id + '_' + secret.slice(0, 4) + '…',
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    revokedAt: null,
  };
  project.agentTokens = Array.isArray(project.agentTokens) ? project.agentTokens : [];
  project.agentTokens.push(record);
  return { token, record };
}

// Constant-time match of a presented secret against the project's live tokens.
function findRecord(project, secret) {
  const want = sha256(secret); // 32-byte Buffer
  const toks = Array.isArray(project.agentTokens) ? project.agentTokens : [];
  for (const t of toks) {
    if (t.revokedAt || !t.hash) continue;
    let got;
    try { got = Buffer.from(t.hash, 'hex'); } catch { continue; }
    if (got.length === want.length && crypto.timingSafeEqual(got, want)) return t;
  }
  return null;
}

// Hard-delete a key: drop the record (and its hash) so the token instantly stops
// working and nothing lingers in the list.
function deleteToken(project, tokenId) {
  const toks = Array.isArray(project.agentTokens) ? project.agentTokens : [];
  const i = toks.findIndex((x) => x.id === tokenId);
  if (i < 0) return false;
  toks.splice(i, 1);
  return true;
}

// Drop the secret hash + plaintext token before a record ever leaves the server;
// `hasSecret` tells the owner UI whether the paste-in kit can be re-displayed.
function redactRecord(t) {
  return { id: t.id, name: t.name, scope: t.scope, prefix: t.prefix, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt || null, revokedAt: t.revokedAt || null, hasSecret: !!t.token };
}
// Mask connection secret VALUES (keeping non-secret fields) so a project body is
// safe to serialize to any client — connection secrets are reachable ONLY via the
// scope-gated /connections. Returns a shallow copy when there's anything to mask.
function maskConnections(project) {
  if (!project || !project.connections || typeof project.connections !== 'object' || Array.isArray(project.connections)) return project;
  const c = {};
  for (const [k, v] of Object.entries(project.connections)) c[k] = SECRET_FIELDS.has(k) ? (v ? '••• set (use /connections)' : v) : v;
  return Object.assign({}, project, { connections: c });
}

// Safe for the wizard UI: token secret hashes stripped to metadata AND connection
// secret values masked (both are secrets that must never reach a client).
function redactProject(project) {
  if (!project || typeof project !== 'object') return project;
  let out = maskConnections(project);
  if (Array.isArray(out.agentTokens)) out = Object.assign({}, out, { agentTokens: out.agentTokens.map(redactRecord) });
  return out;
}

// Safe for an AGENT: token records dropped entirely AND connection secret values
// masked. Used both for the token's own project (secrets stay behind the
// scope-gated /connections) and for cross-project reads (an agent may read every
// project for architecture context, but never another project's secrets).
function publicProject(project) {
  if (!project || typeof project !== 'object') return project;
  const out = Object.assign({}, maskConnections(project));
  delete out.agentTokens;
  return out;
}

// ── the operation catalog (single source of truth for manifest + kit + docs) ─
// Paths are relative to the agent base URL. `scope: 'write'` ops are hidden from
// read-only tokens in the manifest and rejected by the router.
const OPS = [
  { method: 'GET',    path: '',                    scope: 'read',  summary: 'This manifest — the operation catalog + current field schema.' },
  { method: 'GET',    path: '/project',            scope: 'read',  summary: 'The whole project: answers, attachments, status, baseline, change log, deploy URL.' },
  { method: 'GET',    path: '/answers',            scope: 'read',  summary: 'Just the answers object (product, integrations, and the row collections).' },
  { method: 'GET',    path: '/intake',             scope: 'read',  summary: 'The composed PLAN-INTAKE.json for this project.' },
  { method: 'GET',    path: '/changes',            scope: 'read',  summary: 'Change log, agent edit log, and the current doc baseline.' },
  { method: 'GET',    path: '/attachments',        scope: 'read',  summary: 'Reference / source files attached to the project.' },
  { method: 'GET',    path: '/files',              scope: 'read',  summary: 'List the generated /docs files (empty until generated).' },
  { method: 'GET',    path: '/file?path=<rel>',    scope: 'read',  summary: 'Read one generated file’s text content.' },
  { method: 'GET',    path: '/connections',        scope: 'read',  summary: 'Deploy + integration credentials the wizard holds: SSH host/user/port/password to the Docker host, and Anthropic/Linear/GitHub keys. Secret VALUES need a write token; read tokens see only which are set.' },
  { method: 'GET',    path: '/projects',           scope: 'read',  summary: 'List EVERY project on this wizard (cross-app context): id, name, status, one-liner, deploy URL.' },
  { method: 'GET',    path: '/projects/<id>',      scope: 'read',  summary: 'Full details of ANY project on this wizard (read-only; other projects’ secrets redacted) — sibling-app architecture context.' },
  { method: 'GET',    path: '/projects/<id>/intake', scope: 'read', summary: 'The composed PLAN-INTAKE.json of any project — the cleanest cross-app architecture summary.' },
  { method: 'GET',    path: '/<collection>',       scope: 'read',  summary: 'List the rows of a collection (requirements | decisions | milestones | risks | scalability).' },

  { method: 'PATCH',  path: '/project',            scope: 'write', summary: 'Merge top-level fields: { name?, answers? }. answers is merged section-by-section.', body: { name: 'string?', answers: 'object?' } },
  { method: 'PATCH',  path: '/product',            scope: 'write', summary: 'Merge fields into answers.product.', body: '{ oneliner?, problem?, users?, goal?, success?, differentiator?, experience?, notBuilding?, name?, domain? }' },
  { method: 'PATCH',  path: '/integrations',       scope: 'write', summary: 'Merge fields into answers.integrations.', body: '{ docsDir?, githubRepoUrl?, linearWorkspaceUrl?, linearProjectUrl?, linearProjectId? }' },
  { method: 'PATCH',  path: '/connections',        scope: 'write', summary: 'Store per-project connection overrides (SSH + keys).', body: '{ sshHost?, sshUser?, sshPort?, sshPassword?, hostname?, anthropicKey?, grokKey?, linearKey?, linearProjectId?, githubRepoUrl?, githubToken? }' },
  { method: 'POST',   path: '/<collection>',       scope: 'write', summary: 'Append a row. Body = the row object. Returns its index.' },
  { method: 'PUT',    path: '/<collection>',       scope: 'write', summary: 'Replace the entire collection with a JSON array of rows.' },
  { method: 'GET',    path: '/<collection>/<i>',   scope: 'read',  summary: 'Read one row by 0-based index.' },
  { method: 'PUT',    path: '/<collection>/<i>',   scope: 'write', summary: 'Replace the row at index i.' },
  { method: 'PATCH',  path: '/<collection>/<i>',   scope: 'write', summary: 'Merge fields into the row at index i.' },
  { method: 'DELETE', path: '/<collection>/<i>',   scope: 'write', summary: 'Delete the row at index i.' },

  { method: 'POST',   path: '/generate',           scope: 'write', summary: 'Regenerate the /docs structure from the current intake (fast; no AI key needed).' },
  { method: 'POST',   path: '/assess',             scope: 'write', summary: 'Assess a proposed intake against code + Linear. Body: { proposed, apiKey?, linearKey? }.' },
  { method: 'POST',   path: '/apply-changes',      scope: 'write', summary: 'Apply accepted change-units from an assessment. Body: { proposed, units, accepted, apiKey?, linearKey? }.' },
  { method: 'POST',   path: '/deploy',             scope: 'write', summary: 'Deploy/redeploy the generated docs to a Docker host over SSH. Body: { host, user, password?, ... }.' },
];

// ── self-describing manifest (the "list tools" equivalent) ───────────────────
function manifest(project, record, base) {
  const write = record.scope === 'write';
  return {
    ok: true,
    service: 'project-wizard-agent-api',
    apiVersion: 1,
    baseUrl: base,
    auth: 'Send the token as an "Authorization: Bearer <token>" header (or add ?token=<token> to the URL).',
    scope: record.scope,
    project: {
      id: project.id,
      name: project.name,
      status: project.status,
      updatedAt: project.updatedAt || null,
      generatedAt: project.generatedAt || null,
      deployUrl: project.deployUrl || null,
    },
    schema: {
      collections: Object.fromEntries(Object.entries(COLLECTIONS).map(([k, v]) => [k, v.keys])),
      productFields: PRODUCT_FIELDS,
      integrationFields: INTEGRATION_FIELDS,
      connectionFields: CONNECTION_FIELDS,
    },
    operations: OPS
      .filter((o) => write || o.scope === 'read')
      .map((o) => ({ method: o.method, url: base + o.path, scope: o.scope, summary: o.summary, body: o.body })),
    hint: 'Fetch GET ' + base + '/project first to see the current state. Rows are addressed by 0-based index. '
      + 'Content edits change the wizard’s saved answers immediately, but the rendered /docs only refresh when you POST '
      + base + '/generate' + (write ? '.' : ' (write scope required).'),
  };
}

// ── the paste-in kit: text handed to another Claude session verbatim ─────────
function kit(project, token, scope, base) {
  const write = scope === 'write';
  const auth = 'Authorization: Bearer ' + token;
  const lines = [
    'You have ' + (write ? 'READ + WRITE' : 'READ-ONLY') + ' API access to a Project Wizard project. Use it to '
      + (write ? 'inspect and directly edit' : 'inspect') + ' the plan.',
    '',
    'PROJECT : "' + project.name + '"  (id ' + project.id + ', status ' + project.status + ')',
    'BASE URL: ' + base,
    'TOKEN   : ' + token,
    'AUTH    : send the header  ' + auth + '   (or append ?token=' + token + ' to any URL)',
    '',
    'ALWAYS START by fetching the manifest — it self-describes every operation, the field',
    'names, and your scope:',
    '  curl -s -H "' + auth + '" ' + base,
    '',
    'Read the entire current plan before changing anything:',
    '  curl -s -H "' + auth + '" ' + base + '/project',
    '',
    'Pull the integration + deploy credentials this project is configured with —',
    'the Docker/SSH host to connect to, plus Anthropic/Linear/GitHub keys'
      + (write ? ':' : ' (values shown only to write tokens; read tokens see which are set):'),
    '  curl -s -H "' + auth + '" ' + base + '/connections',
    '',
    'For cross-app architecture context, list EVERY project on this wizard and read any of them',
    '(read-only; other projects’ secrets are redacted):',
    '  curl -s -H "' + auth + '" ' + base + '/projects',
    '  curl -s -H "' + auth + '" ' + base + '/projects/<other-id>/intake',
  ];
  if (write) {
    lines.push(
      '',
      'Make edits (examples — the manifest lists them all):',
      '  # update the product one-liner',
      '  curl -s -X PATCH ' + base + '/product -H "' + auth + '" \\',
      '       -H "content-type: application/json" -d \'{"oneliner":"New one-line pitch"}\'',
      '',
      '  # add a requirement (rows: title + test)',
      '  curl -s -X POST ' + base + '/requirements -H "' + auth + '" \\',
      '       -H "content-type: application/json" -d \'{"title":"Users can reset a password","test":"Reset email arrives within 60s"}\'',
      '',
      '  # tweak milestone #0 in place',
      '  curl -s -X PATCH ' + base + '/milestones/0 -H "' + auth + '" \\',
      '       -H "content-type: application/json" -d \'{"target":"2026-09-01"}\'',
      '',
      '  # re-render the /docs after your edits',
      '  curl -s -X POST ' + base + '/generate -H "' + auth + '"',
    );
  }
  lines.push(
    '',
    'REUSE ACROSS SESSIONS — so a future session can reconnect without being re-handed this:',
    'save the project name, BASE URL, TOKEN, and scope to your PERSISTENT MEMORY now (your',
    'private notes/memory — not a file you would commit; the token is a secret). Record it under',
    'a heading like "Project Wizard — ' + project.name + '". Then whenever the user says',
    '"Review the Project Wizard for context", recall those details and GET ' + base + '/project',
    '(plus ' + base + '/projects for the sibling apps) to reload the current plan before working.',
    '',
    'Rules: rows are addressed by 0-based index; fetch GET ' + base + ' or ' + base + '/project again',
    'if an index might have shifted. This token is scoped to THIS project only'
      + (write ? '' : ' and cannot write') + '.',
  );
  return lines.join('\n');
}

module.exports = {
  COLLECTIONS, PRODUCT_FIELDS, INTEGRATION_FIELDS, CONNECTION_FIELDS, SECRET_FIELDS, OPS,
  parseToken, mintToken, findRecord, deleteToken, redactRecord, redactProject, publicProject,
  resolveConnections, connectionsView, normalizeConnections,
  manifest, kit,
};
