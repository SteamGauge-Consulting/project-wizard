// The agent API: a token-authenticated HTTP surface that lets another Claude
// session (or any client) read + edit ONE project directly — the "give it a URL
// and a key" flow. Two halves:
//
//   • UI-side, no auth (trusted like the rest of the wizard UI):
//       POST   /api/projects/:id/agent-tokens        mint a token (returns it once + a paste-in kit)
//       GET    /api/projects/:id/agent-tokens        list token metadata
//       DELETE /api/projects/:id/agent-tokens/:tid   revoke a token
//
//   • Agent-side, token auth, everything under /api/agent (see lib/agent-tokens
//     OPS for the catalog). The token is scoped to a single project and to a
//     scope (read | write); it resolves the project — no :id in the URL.
//
// Lifecycle operations (generate/assess/apply-changes/deploy) are forwarded to
// the wizard's own existing internal routes over localhost, so this layer stays
// thin and the heavy logic has exactly one implementation.

const express = require('express');
const fs = require('fs');
const tokens = require('./agent-tokens');

function agentBase(req, deps) {
  const host = (req.headers && req.headers.host) || ('localhost:' + deps.PORT);
  const proto = ((req.headers && req.headers['x-forwarded-proto']) || req.protocol || 'http').split(',')[0].trim();
  return proto + '://' + host + '/api/agent';
}

// The base URL to bake into a token's paste-in kit. Prefer an explicit override
// (the UI passes the LAN URL, e.g. http://wizard.<ip>.nip.io, so the kit is
// reachable from another machine even if this page was opened on localhost);
// otherwise derive it from the request. The base is display/instruction only —
// it never affects what the token authorizes.
function kitBase(req, deps, explicit) {
  const raw = explicit && String(explicit).trim();
  if (raw && /^https?:\/\/[^\s/]+/i.test(raw)) {
    const b = raw.replace(/\/+$/, '');
    return /\/api\/agent$/.test(b) ? b : b + '/api/agent';
  }
  return agentBase(req, deps);
}

function mount(app, deps) {
  const { storage, intakeOf, summarize, emptyAnswers, walkTree, safeGenPath, PORT } = deps;

  // ── UI-side token management ───────────────────────────────────────────────
  app.post('/api/projects/:id/agent-tokens', (req, res) => {
    const p = storage.getProject(req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    const { token, record } = tokens.mintToken(p, { name: b.name, scope: b.scope });
    storage.saveProject(p);
    const base = kitBase(req, deps, b.base);
    res.status(201).json({
      ok: true,
      token,                                  // shown once — never recoverable after this
      base,
      record: tokens.redactRecord(record),
      kit: tokens.kit(p, token, record.scope, base),
    });
  });

  app.get('/api/projects/:id/agent-tokens', (req, res) => {
    const p = storage.getProject(req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    res.json({ tokens: (p.agentTokens || []).map(tokens.redactRecord), base: agentBase(req, deps) });
  });

  app.delete('/api/projects/:id/agent-tokens/:tid', (req, res) => {
    const p = storage.getProject(req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    if (!tokens.revokeToken(p, req.params.tid)) return res.status(404).json({ error: 'token not found' });
    storage.saveProject(p);
    res.json({ ok: true });
  });

  // ── agent-side router (token auth) ─────────────────────────────────────────
  const r = express.Router();

  function bearer(req) {
    const h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
    if (/^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
    if (typeof req.query.token === 'string') return req.query.token.trim();
    return '';
  }

  // Authenticate + authorize every agent request. Resolves the token to its
  // project + scope; write methods require a write-scope token.
  r.use((req, res, next) => {
    const parsed = tokens.parseToken(bearer(req));
    if (!parsed) return res.status(401).json({ error: 'missing or malformed agent token', hint: 'send header "Authorization: Bearer pwk_<projectId>_<secret>"' });
    const project = storage.getProject(parsed.projectId);
    // Same generic message whether the project or the secret is wrong — don't
    // let the API confirm which project ids exist.
    if (!project) return res.status(401).json({ error: 'invalid or revoked token' });
    const record = tokens.findRecord(project, parsed.secret);
    if (!record) return res.status(401).json({ error: 'invalid or revoked token' });
    if (req.method !== 'GET' && req.method !== 'HEAD' && record.scope !== 'write') {
      return res.status(403).json({ error: 'this token is read-only', hint: 'mint a write-scope token to edit' });
    }
    req.pwProject = project;
    req.pwToken = record;
    next();
  });

  // Persist a write + append to the agent edit log (best-effort attribution).
  function commit(req, op, detail) {
    const p = req.pwProject;
    p.agentLog = Array.isArray(p.agentLog) ? p.agentLog : [];
    p.agentLog.push({ at: new Date().toISOString(), token: req.pwToken.id, name: req.pwToken.name, op, detail: detail || '' });
    if (p.agentLog.length > 200) p.agentLog = p.agentLog.slice(-200);
    req.pwToken.lastUsedAt = new Date().toISOString();
    storage.saveProject(p);
  }

  function answers(req) {
    if (!req.pwProject.answers || typeof req.pwProject.answers !== 'object') req.pwProject.answers = emptyAnswers();
    return req.pwProject.answers;
  }

  // ─── discovery + reads (available to read + write tokens) ─────────────────
  r.get('/', (req, res) => res.json(tokens.manifest(req.pwProject, req.pwToken, agentBase(req, deps))));
  r.get('/project', (req, res) => res.json(tokens.publicProject(req.pwProject)));

  // Cross-app context: any valid token may READ every project on this wizard
  // (never edit them, never see their secrets) so an agent building one app has
  // the org's other apps' architecture on hand.
  r.get('/projects', (req, res) => {
    res.json({ projects: storage.listProjects().map((pp) => Object.assign(summarize(pp), { current: pp.id === req.pwProject.id })) });
  });
  r.get('/projects/:id', (req, res) => {
    const other = storage.getProject(req.params.id);
    if (!other) return res.status(404).json({ error: 'project not found' });
    res.json(tokens.publicProject(other));
  });
  r.get('/projects/:id/intake', (req, res) => {
    const other = storage.getProject(req.params.id);
    if (!other) return res.status(404).json({ error: 'project not found' });
    res.json(intakeOf(other));
  });
  r.get('/answers', (req, res) => res.json(answers(req)));
  r.get('/intake', (req, res) => res.json(intakeOf(req.pwProject)));
  r.get('/changes', (req, res) => res.json({
    changes: req.pwProject.changes || [],
    agentLog: req.pwProject.agentLog || [],
    baseline: req.pwProject.baseline || null,
  }));
  r.get('/attachments', (req, res) => res.json({ attachments: Array.isArray(req.pwProject.attachments) ? req.pwProject.attachments : [] }));
  r.get('/files', (req, res) => {
    const dir = storage.generatedDir(req.pwProject.id);
    if (!fs.existsSync(dir)) return res.json({ generated: false, files: [] });
    res.json({ generated: true, files: walkTree(dir) });
  });
  r.get('/file', (req, res) => {
    const rel = String(req.query.path || '');
    const full = rel && safeGenPath(req.pwProject.id, rel);
    if (!full || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return res.status(404).json({ error: 'file not found', hint: 'use GET /files for valid paths' });
    res.json({ path: rel, size: fs.statSync(full).size, content: fs.readFileSync(full, 'utf-8') });
  });

  // Deploy + integration credentials the wizard holds for this project. Secret
  // VALUES (SSH password, API keys) only for write tokens; read tokens see which
  // fields are configured. `deployUrl` shows where it's currently live.
  r.get('/connections', (req, res) => {
    const write = req.pwToken.scope === 'write';
    const { effective, configured } = tokens.connectionsView(req.pwProject, process.env, write);
    res.json({
      ok: true,
      scope: req.pwToken.scope,
      includesSecrets: write,
      effective,
      configured,
      deployUrl: req.pwProject.deployUrl || null,
      deployedAt: req.pwProject.deployedAt || null,
      hint: write
        ? 'These are the live credentials this wizard holds. To reach the Docker host, SSH to sshHost as sshUser on sshPort (sshPassword if set, else the wizard’s mounted SSH key). Use anthropicKey / linearKey / githubToken with those services. POST /deploy uses the same values when host/user/password are omitted.'
        : 'Secret values are withheld from read-only tokens — `configured` shows which are set. Mint a write-scope token to retrieve the actual keys and SSH password.',
    });
  });

  // ─── content edits (write scope) ──────────────────────────────────────────
  r.patch('/project', (req, res) => {
    const p = req.pwProject, b = req.body || {};
    if (typeof b.name === 'string' && b.name.trim()) p.name = b.name.trim();
    if (b.answers && typeof b.answers === 'object' && !Array.isArray(b.answers)) {
      // Validate section shapes — a row collection persisted as a non-array would
      // crash intakeOf/cleanRows (and hang the wizard's own build/assess). The
      // dedicated collection routes enforce this; PATCH /project must too.
      const bad = [];
      for (const [k, v] of Object.entries(b.answers)) {
        if (UNSAFE_KEYS.has(k)) continue;
        if (tokens.COLLECTIONS[k]) { if (!Array.isArray(v)) bad.push(k + ' must be an array of rows'); }
        else if (k === 'product' || k === 'integrations') { if (!v || typeof v !== 'object' || Array.isArray(v)) bad.push(k + ' must be an object'); }
        else if (k === 'startDate') { if (v != null && typeof v !== 'string') bad.push('startDate must be a string'); }
      }
      if (bad.length) return res.status(400).json({ error: 'invalid answers — ' + bad.join('; ') });
      const a = answers(req);
      for (const [k, v] of Object.entries(b.answers)) {
        if (UNSAFE_KEYS.has(k)) continue;
        if (tokens.COLLECTIONS[k]) a[k] = v.filter((x) => x && typeof x === 'object' && !Array.isArray(x)).map(trimStrings);
        else if (k === 'product' || k === 'integrations') a[k] = trimStrings(v);
        else a[k] = v;
      }
    }
    commit(req, 'patch:project');
    res.json({ ok: true, project: tokens.publicProject(p) });
  });

  function mergeInto(req, res, section, op) {
    const b = req.body;
    if (!b || typeof b !== 'object' || Array.isArray(b)) return res.status(400).json({ error: 'expected a JSON object of fields to merge' });
    const a = answers(req);
    a[section] = Object.assign({}, a[section] || {}, trimStrings(b));
    commit(req, op);
    res.json({ ok: true, [section]: a[section] });
  }
  r.patch('/product', (req, res) => mergeInto(req, res, 'product', 'patch:product'));
  r.patch('/integrations', (req, res) => mergeInto(req, res, 'integrations', 'patch:integrations'));

  // Store per-project connection overrides (SSH target + keys). A field set to
  // '' or null clears its override (falling back to env / derived).
  r.patch('/connections', (req, res) => {
    const b = req.body;
    if (!b || typeof b !== 'object' || Array.isArray(b)) return res.status(400).json({ error: 'expected a JSON object of connection fields', fields: tokens.CONNECTION_FIELDS });
    req.pwProject.connections = tokens.normalizeConnections(req.pwProject.connections, b);
    commit(req, 'patch:connections');
    const { effective, configured } = tokens.connectionsView(req.pwProject, process.env, true);
    res.json({ ok: true, effective, configured });
  });

  // ─── lifecycle: forward to the wizard's own internal routes ───────────────
  async function forward(req, res, action, body) {
    const id = req.pwProject.id;
    const url = 'http://127.0.0.1:' + PORT + '/api/projects/' + id + '/' + action;
    let r2, text;
    try {
      r2 = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || req.body || {}) });
      text = await r2.text();
    } catch (e) {
      return res.status(502).json({ error: 'internal ' + action + ' call failed: ' + (e.message || e) });
    }
    // Attribute the action once it has succeeded (reload — the forwarded route
    // just mutated + saved the project).
    if (r2.ok) {
      try {
        const fresh = storage.getProject(id);
        if (fresh) {
          req.pwProject = fresh;
          // Re-point the token record into the reloaded project so commit()'s
          // lastUsedAt bump is persisted (the pre-reload record is now detached).
          const rec = Array.isArray(fresh.agentTokens) && fresh.agentTokens.find((t) => t.id === req.pwToken.id);
          if (rec) req.pwToken = rec;
          commit(req, 'lifecycle:' + action);
        }
      } catch { /* logging is best-effort */ }
    }
    res.status(r2.status).type('application/json').send(text);
  }
  r.post('/generate', (req, res) => forward(req, res, 'generate'));
  r.post('/assess', (req, res) => forward(req, res, 'assess'));
  r.post('/apply-changes', (req, res) => forward(req, res, 'apply-changes'));
  // Deploy backfills SSH target + keys from the project's resolved connections so
  // an agent can redeploy without re-supplying credentials it can already read.
  r.post('/deploy', (req, res) => {
    const c = tokens.resolveConnections(req.pwProject, process.env);
    const b = req.body || {};
    const pick = (v, d) => (v == null || String(v).trim() === '' ? d : v);
    const body = Object.assign({}, b, {
      host: pick(b.host, c.sshHost),
      user: pick(b.user, c.sshUser),
      sshPort: pick(b.sshPort, c.sshPort),
      password: pick(b.password, c.sshPassword),
      hostname: pick(b.hostname, c.hostname),
      apiKey: pick(b.apiKey, c.anthropicKey),
      linearKey: pick(b.linearKey, c.linearKey),
      linearProjectId: pick(b.linearProjectId, c.linearProjectId),
    });
    forward(req, res, 'deploy', body);
  });

  // ─── row collections (registered LAST so fixed routes above win) ──────────
  function loadCollection(req, res, next) {
    const name = req.params.collection;
    if (!Object.prototype.hasOwnProperty.call(tokens.COLLECTIONS, name)) {
      return res.status(404).json({ error: 'unknown collection "' + name + '"', collections: Object.keys(tokens.COLLECTIONS) });
    }
    const a = answers(req);
    if (!Array.isArray(a[name])) a[name] = [];
    req.coll = a[name];
    req.collName = name;
    next();
  }
  // Resolve + validate a row index; on failure it answers and returns -1.
  function rowIndex(req, res) {
    const i = Number(req.params.index);
    if (!Number.isInteger(i) || i < 0 || i >= req.coll.length) {
      res.status(404).json({ error: 'row index ' + req.params.index + ' out of range (0..' + (req.coll.length - 1) + ')' });
      return -1;
    }
    return i;
  }
  function normalizeRow(name, body) {
    const keys = tokens.COLLECTIONS[name].keys;
    const row = trimStrings(body && typeof body === 'object' && !Array.isArray(body) ? body : {});
    const hasKnown = keys.some((k) => String(row[k] == null ? '' : row[k]).trim());
    return { row, hasKnown, keys };
  }

  r.get('/:collection', loadCollection, (req, res) => {
    res.json({ collection: req.collName, keys: tokens.COLLECTIONS[req.collName].keys, rows: req.coll });
  });
  r.post('/:collection', loadCollection, (req, res) => {
    const { row, hasKnown, keys } = normalizeRow(req.collName, req.body);
    if (!hasKnown) return res.status(400).json({ error: 'a ' + tokens.COLLECTIONS[req.collName].label + ' row needs at least one of: ' + keys.join(', ') });
    req.coll.push(row);
    commit(req, 'add:' + req.collName);
    res.status(201).json({ ok: true, index: req.coll.length - 1, row });
  });
  r.put('/:collection', loadCollection, (req, res) => {
    if (!Array.isArray(req.body)) return res.status(400).json({ error: 'expected a JSON array of rows' });
    req.pwProject.answers[req.collName] = req.body.map((rw) => normalizeRow(req.collName, rw).row);
    commit(req, 'replace:' + req.collName);
    res.json({ ok: true, rows: req.pwProject.answers[req.collName] });
  });
  r.get('/:collection/:index', loadCollection, (req, res) => {
    const i = rowIndex(req, res); if (i < 0) return;
    res.json({ collection: req.collName, index: i, row: req.coll[i] });
  });
  r.put('/:collection/:index', loadCollection, (req, res) => {
    const i = rowIndex(req, res); if (i < 0) return;
    const { row, hasKnown, keys } = normalizeRow(req.collName, req.body);
    if (!hasKnown) return res.status(400).json({ error: 'a ' + tokens.COLLECTIONS[req.collName].label + ' row needs at least one of: ' + keys.join(', ') });
    req.coll[i] = row;
    commit(req, 'update:' + req.collName);
    res.json({ ok: true, index: i, row });
  });
  r.patch('/:collection/:index', loadCollection, (req, res) => {
    const i = rowIndex(req, res); if (i < 0) return;
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ error: 'expected a JSON object of fields to merge' });
    req.coll[i] = Object.assign({}, req.coll[i], trimStrings(req.body));
    commit(req, 'patch:' + req.collName);
    res.json({ ok: true, index: i, row: req.coll[i] });
  });
  r.delete('/:collection/:index', loadCollection, (req, res) => {
    const i = rowIndex(req, res); if (i < 0) return;
    const [removed] = req.coll.splice(i, 1);
    commit(req, 'delete:' + req.collName);
    res.json({ ok: true, removed });
  });

  app.use('/api/agent', r);
}

// Keys that could reach an object's prototype — never copied from agent input.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Trim string values one level deep; pass non-strings through untouched. Drops
// prototype-polluting keys so agent-supplied JSON can't alter object prototypes.
function trimStrings(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (UNSAFE_KEYS.has(k)) continue;
    out[k] = typeof v === 'string' ? v.trim() : v;
  }
  return out;
}

module.exports = { mount };
