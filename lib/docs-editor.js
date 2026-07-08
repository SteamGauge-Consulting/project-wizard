// ============================================================================
//  lib/docs-editor.js — in-container editor backend for the DEPLOYED docs site.
//
//  Mounts the "living docs" endpoints onto the same Express app docs-server uses,
//  so the live site (behind the hamburger menu) can re-open the wizard intake,
//  assess edits against the real codebase + live Linear tracker, accept/revert,
//  and apply them — writing straight into the bind-mounted project folder, so an
//  applied change is live immediately with no redeploy.
//
//      require('./lib/docs-editor')(app);
//
//  The wizard (server.js) keeps projects in a storage DB; here the bind-mounted
//  filesystem IS the project:
//    PLAN-INTAKE.json      — the live baseline intake (advanced on every apply)
//    reference/            — the code corpus used for impact analysis
//    .deploy/changes.json  — the applied change log (persists on the mount)
//
//  Keys are baked into the container at deploy time (the chosen deploy model):
//    ANTHROPIC_API_KEY   — drives Assess + the re-enrich on Apply
//    LINEAR_API_KEY      — syncs the tracker (also read from .deploy/linear-key)
//    LINEAR_PROJECT_ID   — the project whose issues Assess/Apply act on
//
//  Routes (all under /api, JSON):
//    GET  /api/intake  — the current baseline + capability flags for the editor
//    POST /api/assess  — diff → corpus → live Linear → AI impact; saves nothing
//    POST /api/apply   — merge accepted units → re-render → sync Linear → advance
// ============================================================================

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const express = require('express');
const assessLib = require('./assess');
const linear = require('./linear');
const reverse = require('./reverse-engineer');
const enrichLib = require('./enrich');
const renderIntake = require('./render-intake');

module.exports = function mountEditor(app, opts) {
  opts = opts || {};
  const ROOT = opts.repoRoot || path.join(__dirname, '..');
  const jsonBody = express.json({ limit: '8mb' });

  // ── filesystem-as-project helpers ──────────────────────────────────────────
  // Integration keys/settings live in .deploy/keys.json — editable on the LIVE pod
  // via the Integrations tab — and fall back to the deploy-baked env vars. keys.json
  // is never web-served (the markdown renderer blocks dotdirs) and never returned
  // to the client (only set/not-set booleans are advertised).
  const KEYS_FILE = path.join(ROOT, '.deploy', 'keys.json');
  function readKeys() { try { return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf-8')) || {}; } catch (e) { return {}; } }
  function writeKeys(obj) { fs.mkdirSync(path.join(ROOT, '.deploy'), { recursive: true }); fs.writeFileSync(KEYS_FILE, JSON.stringify(obj, null, 2) + '\n'); }
  function anthropicKey() { return String(readKeys().anthropicKey || process.env.ANTHROPIC_API_KEY || '').trim(); }
  function linearKey() {
    const k = readKeys().linearKey; if (k) return String(k).trim();
    if (process.env.LINEAR_API_KEY) return process.env.LINEAR_API_KEY.trim();
    try { return fs.readFileSync(path.join(ROOT, '.deploy', 'linear-key'), 'utf-8').trim(); }
    catch (e) { return null; }
  }
  function linearProjectId() { return String(readKeys().linearProjectId || opts.linearProjectId || process.env.LINEAR_PROJECT_ID || '').trim(); }
  function githubCfg() { const k = readKeys(); return { repoUrl: String(k.githubRepoUrl || process.env.GITHUB_REPO_URL || '').trim(), hasToken: !!(k.githubToken || process.env.GITHUB_TOKEN) }; }
  // Integration status advertised to the client + written for Claude Code to read.
  // Secrets → set/not-set booleans only; non-secret IDs/URLs/host → plain values.
  function integrationsStatus(intake) {
    const k = readKeys(), gh = githubCfg();
    return {
      hasClaude: !!anthropicKey(), hasGrok: !!(k.grokKey || process.env.GROK_API_KEY || process.env.XAI_API_KEY), hasLinearKey: !!linearKey(), linearProjectId: linearProjectId(),
      githubRepoUrl: gh.repoUrl, hasGithubToken: gh.hasToken,
      sshHost: String(k.sshHost || process.env.DEPLOY_SSH_HOST || '').trim(),
      sshUser: String(k.sshUser || process.env.DEPLOY_SSH_USER || '').trim(),
      sshPort: String(k.sshPort || process.env.DEPLOY_SSH_PORT || '').trim(),
      hasSshPassword: !!(k.sshPassword || process.env.DEPLOY_SSH_PASSWORD),
      docsDir: intake ? docsDirOf(intake) : 'docs',
    };
  }
  // The EFFECTIVE creds (keys.json overlay + env fallback), WITH secret values —
  // only used by the keys.json download so a dev can drop them into a local clone.
  function effectiveKeys() {
    const k = readKeys();
    return {
      anthropicKey: anthropicKey() || '',
      grokKey: String(k.grokKey || process.env.GROK_API_KEY || process.env.XAI_API_KEY || ''),
      linearKey: linearKey() || '',
      linearProjectId: linearProjectId(),
      githubRepoUrl: githubCfg().repoUrl,
      githubToken: String(k.githubToken || process.env.GITHUB_TOKEN || ''),
      sshHost: String(k.sshHost || process.env.DEPLOY_SSH_HOST || ''),
      sshUser: String(k.sshUser || process.env.DEPLOY_SSH_USER || ''),
      sshPassword: String(k.sshPassword || process.env.DEPLOY_SSH_PASSWORD || ''),
      sshPort: String(k.sshPort || process.env.DEPLOY_SSH_PORT || ''),
    };
  }
  function readIntake() { return JSON.parse(fs.readFileSync(path.join(ROOT, 'PLAN-INTAKE.json'), 'utf-8')); }
  function writeIntake(intake) { fs.writeFileSync(path.join(ROOT, 'PLAN-INTAKE.json'), JSON.stringify(intake, null, 2) + '\n'); }
  function referenceDir() { return path.join(ROOT, 'reference'); }
  function docsDirOf(intake) { return (intake && intake.integrations && intake.integrations.docsDir) || 'docs'; }

  // Change log persists on the bind-mounted FS so it survives restarts/redeploys.
  function deployDir() { const d = path.join(ROOT, '.deploy'); try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} return d; }
  function readChanges() {
    try { return JSON.parse(fs.readFileSync(path.join(deployDir(), 'changes.json'), 'utf-8')); }
    catch (e) { return { seq: 0, changes: [] }; }
  }
  function writeChanges(c) {
    try { fs.writeFileSync(path.join(deployDir(), 'changes.json'), JSON.stringify(c, null, 2) + '\n'); } catch (e) {}
  }

  // Plain-English label per doc section, for the changelog "what changed" line.
  const SECTION_LABELS = {
    product: 'Product overview', requirements: 'Requirements', decisions: 'Decisions (ADRs)',
    milestones: 'Milestones', risks: 'Risks & constraints', scalability: 'Non-functional & scale',
    stakeholders: 'Stakeholders',
  };
  // Friendly + technical description of one accepted change unit, stored on the
  // change-log entry so the Changelog tab can show easy language up top and the
  // technical detail underneath without re-deriving it.
  function describeUnit(u) {
    if (u.group === 'doc') {
      const counts = [];
      if ((u.added || []).length) counts.push((u.added.length) + ' added');
      if ((u.removed || []).length) counts.push((u.removed.length) + ' removed');
      if ((u.modified || []).length) counts.push((u.modified.length) + ' changed');
      if ((u.scalars || []).length) counts.push((u.scalars.length) + ' field' + (u.scalars.length === 1 ? '' : 's') + ' edited');
      return { kind: 'doc', plain: 'Updated ' + (SECTION_LABELS[u.section] || u.section) + (counts.length ? ' (' + counts.join(', ') + ')' : ''), tech: u.impact || '' };
    }
    if (u.group === 'linear') {
      const verb = u.action === 'create' ? 'Created' : u.action === 'cancel' ? 'Cancelled' : 'Updated';
      return { kind: 'linear', plain: verb + ' tracker issue' + (u.issueIdentifier ? ' ' + u.issueIdentifier : '') + (u.title ? ' — ' + u.title : ''), tech: u.objective || u.reason || '' };
    }
    if (u.group === 'affected-closed') {
      return { kind: 'closed', plain: 'Flagged completed issue ' + u.issueIdentifier + ' for review', tech: u.reason || '' };
    }
    if (u.group === 'code') {
      const fns = (u.functions || []).map((f) => f.name + (f.file ? ' (' + f.file + ')' : '')).join(', ');
      return { kind: 'code', plain: 'Code impact — ' + (u.area || 'affected area'), tech: (u.detail || '') + (fns ? '\nFunctions: ' + fns : '') };
    }
    return { kind: u.group || 'change', plain: 'Change applied', tech: '' };
  }

  // Flatten the deterministic diff + AI result into accept/revert change units.
  // (Identical shape to the wizard's server.js so the accept/revert UI is shared.)
  function buildChangeUnits(diff, ai) {
    const units = [];
    const impactBySection = {};
    (ai.sectionImpacts || []).forEach((s) => { impactBySection[s.section] = s.impact; });
    diff.forEach((d, i) => {
      units.push({
        id: 'doc-' + i, group: 'doc', section: d.section,
        added: d.added || [], removed: d.removed || [], modified: d.modified || [], scalars: d.scalars || [],
        impact: impactBySection[d.section] || '',
      });
    });
    (ai.linearActions || []).forEach((a, i) => units.push(Object.assign({ id: 'lin-' + i, group: 'linear' }, a)));
    (ai.affectedClosed || []).forEach((a, i) => units.push(Object.assign({ id: 'closed-' + i, group: 'affected-closed' }, a)));
    (ai.codeImpacts || []).forEach((a, i) => units.push(Object.assign({ id: 'code-' + i, group: 'code' }, a)));
    return units;
  }

  // ── /docs-prefixed aliases for every live endpoint ───────────────────────────
  // The whole docs SITE already lives under /docs; its live endpoints did not.
  // Serving them at /docs/api/* and /docs/_editor/* too lets a reverse proxy
  // expose the entire pod at <app-domain>/docs with ONE path rule — no separate
  // public hostname, and no collision with the app's own /api namespace. Root
  // paths keep working for pods reached by their own hostname.
  app.use(function (req, res, next) {
    if (/^\/docs\/(api|_editor)(\/|$)/.test(req.url)) req.url = req.url.slice('/docs'.length);
    next();
  });

  // ── Inject the editor client into every docs HTML page ──────────────────────
  // A response-wrapping middleware (registered before docs-server's page routes,
  // because serve-docs mounts the editor first) appends one <script> before
  // </body> on text/html responses only — so the hamburger menu, Edit wizard, and
  // Changelog tab appear on every page without editing the generated nav.
  const CLIENT_TAG = '<script src="/docs/_editor/client.js" defer></script>';
  app.use(function (req, res, next) {
    const send = res.send.bind(res);
    res.send = function (body) {
      try {
        const ct = String(res.get('Content-Type') || '');
        if (typeof body === 'string' && ct.indexOf('html') !== -1 && body.indexOf('/_editor/client.js') === -1) {
          body = body.indexOf('</body>') !== -1 ? body.replace('</body>', CLIENT_TAG + '\n</body>') : body + CLIENT_TAG;
        }
      } catch (e) {}
      return send(body);
    };
    next();
  });

  // Serve the editor client (shipped beside this module by makeBundleEditable).
  app.get('/_editor/client.js', function (req, res) {
    res.type('application/javascript');
    fs.readFile(path.join(__dirname, 'docs-editor-client.js'), 'utf-8', function (err, js) {
      if (err) return res.status(404).send('// editor client not bundled');
      res.set('Cache-Control', 'public, max-age=300');
      res.send(js);
    });
  });

  // ── GET /api/changes — the full applied change log (newest first) ───────────
  app.get('/api/changes', function (req, res) {
    const changes = (readChanges().changes || []).slice().reverse();
    res.json({ ok: true, changes: changes });
  });

  // ── Export / code: browse the bind-mounted project + download it ────────────
  // The hamburger "Export / code" panel mirrors the wizard's code browser, but
  // against the live container filesystem. (SSH deploy is a wizard-only action,
  // so the pod offers browse + download rather than a deploy form.)
  const EXCLUDE = /(^|[\\/])(node_modules|\.git|\.deploy)([\\/]|$)/;
  const BINARY = /\.(zip|tar|t?gz|tgz|png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|eot|mp4|mov|zipx)$/i;

  function safePath(rel) {
    if (!rel || rel.indexOf('..') !== -1 || rel.charAt(0) === '/') return null;
    const full = path.join(ROOT, rel);
    if (full !== ROOT && full.indexOf(ROOT + path.sep) !== 0) return null;
    return full;
  }
  function walkFiles() {
    const out = [];
    (function walk(dir, rel) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
      for (const e of entries) {
        const rp = rel ? rel + '/' + e.name : e.name;
        if (EXCLUDE.test(rp)) continue;
        if (e.isDirectory()) { out.push({ path: rp, type: 'dir' }); walk(path.join(dir, e.name), rp); }
        else { let size = 0; try { size = fs.statSync(path.join(dir, e.name)).size; } catch (x) {} out.push({ path: rp, type: 'file', size: size }); }
      }
    })(ROOT, '');
    return out;
  }

  app.get('/api/files', function (req, res) { res.json({ ok: true, files: walkFiles() }); });

  app.get('/api/file', function (req, res) {
    const rel = String(req.query.path || '');
    const full = safePath(rel);
    if (!full) return res.status(400).json({ error: 'bad path' });
    let st;
    try { st = fs.statSync(full); } catch (e) { return res.status(404).json({ error: 'not found' }); }
    if (st.isDirectory()) return res.status(400).json({ error: 'is a directory' });
    if (BINARY.test(rel)) return res.json({ path: rel, size: st.size, binary: true });
    if (st.size > 2 * 1024 * 1024) return res.json({ path: rel, tooLarge: true, size: st.size });
    res.json({ path: rel, size: st.size, content: fs.readFileSync(full, 'utf-8') });
  });

  // Download the whole project as a .tar.gz (tar ships with the alpine image; we
  // list top-level entries so node_modules/.git are simply never included).
  app.get('/api/export', function (req, res) {
    let entries;
    try { entries = fs.readdirSync(ROOT).filter((n) => n !== 'node_modules' && n !== '.git'); }
    catch (e) { return res.status(500).type('text').send('cannot read project'); }
    if (!entries.length) return res.status(404).type('text').send('nothing to export');
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', 'attachment; filename="project-docs.tar.gz"');
    const tar = spawn('tar', ['-czf', '-', '-C', ROOT].concat(entries));
    tar.stdout.pipe(res);
    tar.stderr.on('data', () => {});
    tar.on('error', () => { if (!res.headersSent) res.status(500).end('tar unavailable'); });
  });

  // ── GET /api/intake — seed the in-page editor + advertise capabilities ──────
  app.get('/api/intake', function (req, res) {
    let intake;
    try { intake = readIntake(); }
    catch (e) { return res.status(500).json({ ok: false, error: 'PLAN-INTAKE.json missing or unreadable in this deploy' }); }
    let corpus = null;
    try { corpus = reverse.buildCorpus(referenceDir()); } catch (e) {}
    res.json({
      ok: true,
      intake: intake,
      hasClaude: !!anthropicKey(),
      hasLinear: !!(linearProjectId() && linearKey()),
      hasCorpus: !!(corpus && corpus.includedCount),
      integrations: integrationsStatus(intake),
      buildVersion: process.env.BUILD_VERSION || 'dev',
      changes: (readChanges().changes || []).slice(-20),
    });
  });

  // ── GET /api/version — the build this pod is running (shown in the ☰ menu) ────
  // Also carries the wizard's URL (baked at deploy) so the client can point the
  // "← App" nav link at the real wizard instead of guessing from the hostname.
  app.get('/api/version', function (req, res) {
    res.json({ version: process.env.BUILD_VERSION || 'dev', wizardUrl: String(process.env.WIZARD_URL || '').replace(/\/$/, '') });
  });

  // ── POST /api/integrations — set keys / IDs / URLs on the LIVE pod ───────────
  // Writes .deploy/keys.json (overrides the deploy-baked env). Secrets are only
  // overwritten when a non-empty value is supplied (blank leaves them untouched);
  // non-secret IDs/URLs are set as given. Returns the new status, never the keys.
  app.post('/api/integrations', jsonBody, function (req, res) {
    const b = req.body || {};
    const keys = readKeys();
    ['anthropicKey', 'grokKey', 'linearKey', 'githubToken', 'sshPassword'].forEach(function (k) {
      if (b[k] === null) { delete keys[k]; return; }            // explicit null clears a secret
      if (typeof b[k] === 'string' && b[k].trim()) keys[k] = b[k].trim();  // blank leaves it as-is
    });
    ['linearProjectId', 'githubRepoUrl', 'sshHost', 'sshUser', 'sshPort'].forEach(function (k) {
      if (typeof b[k] === 'string') keys[k] = b[k].trim();
    });
    try { writeKeys(keys); }
    catch (e) { return res.status(500).json({ error: 'could not save integration settings: ' + (e.message || e) }); }
    res.json({ ok: true, integrations: integrationsStatus() });
  });

  // ── GET /api/integrations/keys.json — download the effective creds ───────────
  // Returns the REAL secret values (keys.json overlay + env) as a downloadable
  // file, so a dev can drop it into a local clone when running Claude Code off the
  // host. This is the one endpoint that exposes secrets — only reachable by whoever
  // can already reach the pod's editor (same trust boundary as Assess/Apply).
  app.get('/api/integrations/keys.json', function (req, res) {
    res.setHeader('content-disposition', 'attachment; filename="keys.json"');
    res.setHeader('cache-control', 'no-store');
    res.type('application/json').send(JSON.stringify(effectiveKeys(), null, 2) + '\n');
  });

  // Linear is the source of truth for milestones once a tracker is linked:
  // mirror its milestone list into the intake rows (name / done-means / target)
  // so enrichment and fallback renders never use stale names. A matching old
  // row's human target label ("Week 2") is kept over the raw ISO date.
  function syncIntakeMilestones(intake, lr) {
    const live = (lr && lr.milestones) || [];
    if (!live.length) return false;
    const clean = (s) => String(s || '').replace(/^\s*Phase\s+[A-Z]+\s*[—\-–]\s*/i, '').replace(/^\s*M\d+\s*[·:.\-–]*\s*/i, '').trim();
    const olds = Array.isArray(intake.milestones) ? intake.milestones : [];
    const byClean = {};
    olds.forEach((r) => { const k = clean(r && r.name).toLowerCase(); if (k) byClean[k] = r; });
    const next = live.map((m) => {
      const prev = byClean[clean(m.cleanName || m.name).toLowerCase()];
      return { name: m.cleanName || clean(m.name), done: m.doneMeans || (prev && prev.done) || '', target: (prev && prev.target) || m.targetDate || '' };
    });
    const shape = (rows) => JSON.stringify(rows.map((r) => ({ name: r.name || '', done: r.done || '', target: r.target || '' })));
    if (shape(next) === shape(olds)) return false;
    intake.milestones = next;
    return true;
  }

  // ── POST /api/rerender — re-render THIS pod's docs from its own intake ───────
  // No AI, no content change: regenerates the docs from PLAN-INTAKE.json +
  // .deploy/enrich.json (re-pulling the live Linear structure for the plan page,
  // and mirroring its milestones into the intake) using the current engine.
  // Used after an "Update app" and by the ☰ "Sync from Linear" menu item.
  app.post('/api/rerender', jsonBody, async function (req, res) {
    let intake;
    try { intake = readIntake(); } catch (e) { return res.status(500).json({ error: 'PLAN-INTAKE.json missing' }); }
    let enrich = null;
    try { enrich = JSON.parse(fs.readFileSync(path.join(deployDir(), 'enrich.json'), 'utf-8')); } catch (e) {}
    let lr = null;
    const lk = linearKey(), lp = linearProjectId();
    if (lk && lp) { try { lr = await linear.loadProjectStructure(lk, lp); } catch (e) {} }
    if (lr && syncIntakeMilestones(intake, lr)) { try { writeIntake(intake); } catch (e) {} }
    try {
      renderIntake.render(ROOT, intake, { docsDir: docsDirOf(intake), enrich: enrich, linear: lr });
      res.json({ ok: true, synced: !!lr });
    } catch (e) { res.status(500).json({ error: 'render failed: ' + (e.message || e) }); }
  });

  // ── Linear → pod live sync ────────────────────────────────────────────────
  // Poll the tracker and re-render in place when its STRUCTURE changes
  // (milestones or issues added / renamed / re-mapped), so the project can be
  // managed in Linear day-to-day and these docs follow — no wizard round-trip.
  // Status flips don't need this (the live pills poll /api/status directly).
  // LINEAR_SYNC_MS overrides the 5-minute default; 0 disables.
  const SYNC_MS = Math.max(0, Number(process.env.LINEAR_SYNC_MS != null ? process.env.LINEAR_SYNC_MS : 300000) || 0);
  let lastShape = null, syncBusy = false;
  async function linearSyncTick() {
    if (syncBusy) return;
    const lk = linearKey(), lp = linearProjectId();
    if (!lk || !lp) return;
    syncBusy = true;
    try {
      const lr = await linear.loadProjectStructure(lk, lp);
      const shape = JSON.stringify((lr.milestones || []).map((m) =>
        [m.name, m.targetDate, m.doneMeans, (m.issues || []).map((i) => i.identifier + '|' + i.title + '|' + i.depth)]));
      const prev = lastShape;
      lastShape = shape;
      if (prev === null || prev === shape) return;   // first tick = baseline; unchanged = nothing to do
      let intake;
      try { intake = readIntake(); } catch (e) { return; }
      if (syncIntakeMilestones(intake, lr)) { try { writeIntake(intake); } catch (e) {} }
      let enrich = null;
      try { enrich = JSON.parse(fs.readFileSync(path.join(deployDir(), 'enrich.json'), 'utf-8')); } catch (e) {}
      renderIntake.render(ROOT, intake, { docsDir: docsDirOf(intake), enrich: enrich, linear: lr });
      console.log('linear-sync: tracker structure changed — docs re-rendered in place');
    } catch (e) { /* transient — try again next tick */ }
    finally { syncBusy = false; }
  }
  if (SYNC_MS) {
    const tick = setInterval(linearSyncTick, SYNC_MS);
    if (tick.unref) tick.unref();
    const boot = setTimeout(linearSyncTick, 20000);   // record the baseline soon after boot
    if (boot.unref) boot.unref();
  }

  // ── GET /api/status — live Linear roll-up, Integrations-keys-aware ──────────
  // docs-server.js (baked into the pod at generate time) registers /api/status
  // too, but reads only LINEAR_API_KEY / .deploy/linear-key — and a redeploy
  // regenerates compose WITHOUT the key (the wizard never stores it), killing
  // the live pills. This route mounts FIRST (docs-editor is wired ahead of
  // docs-server in serve-docs.js) and reads keys.json — the one store redeploys
  // preserve — so live status survives updates. Same response shape.
  const STATUS_TTL_MS = 60 * 1000;
  let statusCache = { at: 0, payload: null };
  app.get('/api/status', async function (req, res) {
    res.set('Cache-Control', 'public, max-age=30');
    const now = Date.now();
    if (statusCache.payload && now - statusCache.at < STATUS_TTL_MS) {
      return res.json(Object.assign({}, statusCache.payload, { cached: true }));
    }
    const key = linearKey(), pid = linearProjectId();
    if (!key) return res.json({ ok: false, reason: 'no-key' });
    if (!pid) return res.json({ ok: false, reason: 'no-project' });
    try {
      // Paginate (Linear caps a page at 250 issues — this tracker is close) and
      // time-box each call so a slow Linear response degrades to the stale cache
      // instead of hanging the page's fetch forever.
      const QUERY = 'query($id:String!,$after:String){ project(id:$id){ name ' +
        'projectMilestones(first:50){ nodes{ name sortOrder } } ' +
        'issues(first:250, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ identifier title url sortOrder state{ name type } parent{ identifier } projectMilestone{ name } } } } }';
      let proj = null; const nodes = []; let after = null;
      for (let page = 0; page < 4; page++) {
        const r = await fetch('https://api.linear.app/graphql', {
          method: 'POST',
          headers: { 'Authorization': key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: QUERY, variables: { id: pid, after } }),
          signal: AbortSignal.timeout(8000),
        });
        const json = await r.json().catch(() => null);
        const pr = json && json.data && json.data.project;
        if (!pr || !pr.issues || !Array.isArray(pr.issues.nodes)) {
          return res.json({ ok: false, reason: 'bad-response', detail: JSON.stringify((json && json.errors) || json).slice(0, 300) });
        }
        proj = proj || pr;
        nodes.push(...pr.issues.nodes);
        const pi = pr.issues.pageInfo || {};
        if (!pi.hasNextPage) break;
        after = pi.endCursor;
      }
      const issues = nodes.map((n) => ({
        id: n.identifier, title: n.title, url: n.url || null, sortOrder: n.sortOrder,
        state: (n.state && n.state.name) || 'Unknown',
        stateType: (n.state && n.state.type) || 'unknown',
        parentId: (n.parent && n.parent.identifier) || null,
        milestone: (n.projectMilestone && n.projectMilestone.name) || null,
      }));
      // Roll-ups (overall + per-milestone → home tiles, phase cards) count ONLY
      // issues MAPPED to a milestone — the same filter the Plan page uses — so
      // unmapped tracker clutter can't skew the numbers. Top-level container
      // issues ("Phase A — …" wrappers: children but no parent) are grouping
      // artifacts, not work — excluded. CANCELED issues are out of scope, not
      // open work — excluded too, so one canceled issue can't pin a milestone
      // at "in progress" forever. The full issues list still ships for
      // per-pill painting.
      const kidsOf = {};
      issues.forEach((i) => { if (i.parentId) (kidsOf[i.parentId] = kidsOf[i.parentId] || []).push(i); });
      const isContainer = (i) => !!kidsOf[i.id] && !i.parentId;
      const subs = issues.filter((i) => i.milestone && !isContainer(i) && i.stateType !== 'canceled');
      const milestones = {};
      subs.forEach((i) => {
        const m = i.milestone || 'Unscheduled';
        (milestones[m] = milestones[m] || { done: 0, total: 0 }).total += 1;
        if (i.stateType === 'completed') milestones[m].done += 1;
      });
      const milestoneOrder = ((proj.projectMilestones && proj.projectMilestones.nodes) || [])
        .slice().sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)).map((m) => m.name);
      const payload = {
        ok: true, generatedAt: new Date().toISOString(), project: proj.name,
        overall: { done: subs.filter((i) => i.stateType === 'completed').length, total: subs.length },
        milestones: milestones, milestoneOrder: milestoneOrder, issues: issues,
      };
      statusCache = { at: now, payload: payload };
      return res.json(payload);
    } catch (e) {
      if (statusCache.payload) return res.json(Object.assign({}, statusCache.payload, { stale: true }));
      return res.json({ ok: false, reason: 'fetch-failed', detail: String(e.message || e) });
    }
  });

  // ── POST /api/integrations/link-linear — (re)link a Linear project + refresh ──
  // Saves the Linear key (if supplied) + project (URL or ID), pulls its LIVE
  // structure, and re-renders the Plan page with those milestones + issues. This
  // is what makes the Plan page show tracker detail after linking a project.
  app.post('/api/integrations/link-linear', jsonBody, async function (req, res) {
    const b = req.body || {};
    const raw = String(b.linearProjectUrl || b.linearProjectId || '').trim();
    if (!raw) return res.status(400).json({ error: 'Enter a Linear project URL or ID.' });
    const m = raw.match(/\/project\/([^/?#]+)/i);
    const pid = m ? m[1] : raw;                       // URL → slug-id segment, else assume it's an id
    const keys = readKeys();
    if (typeof b.linearKey === 'string' && b.linearKey.trim()) keys.linearKey = b.linearKey.trim();
    const lk = String(keys.linearKey || process.env.LINEAR_API_KEY || '').trim();
    if (!lk) return res.status(400).json({ error: 'A Linear API key is required — add it, then link.' });
    // Validate + pull the live structure BEFORE persisting anything.
    let lr;
    try { lr = await linear.loadProjectStructure(lk, pid); }
    catch (e) { return res.status(e.status === 404 ? 404 : 502).json({ error: 'Could not load that Linear project — check the API key and the project URL/ID. (' + (e.message || 'error') + ')' }); }
    keys.linearProjectId = pid;
    try { writeKeys(keys); } catch (e) { return res.status(500).json({ error: 'could not save: ' + (e.message || e) }); }
    // Re-render the docs (Plan page) with the live tracker structure.
    let intake; try { intake = readIntake(); } catch (e) { return res.status(500).json({ error: 'PLAN-INTAKE.json missing' }); }
    let enrich = null; try { enrich = JSON.parse(fs.readFileSync(path.join(deployDir(), 'enrich.json'), 'utf-8')); } catch (e) {}
    try { renderIntake.render(ROOT, intake, { docsDir: docsDirOf(intake), enrich: enrich, linear: lr }); }
    catch (e) { return res.status(500).json({ error: 'linked, but re-render failed: ' + (e.message || e) }); }
    res.json({ ok: true, integrations: integrationsStatus(), url: lr.url || null, projectId: pid, counts: lr.counts || null });
  });

  // ── POST /api/update-app — pull the latest engine by asking the wizard to ────
  // re-deploy this pod (data-preserving). Uses the SSH creds from the Integrations
  // tab + the wizard callback baked at deploy. The wizard ships the new code,
  // preserves this pod's intake/keys/changelog, and triggers /api/rerender above.
  app.post('/api/update-app', jsonBody, function (req, res) {
    const wiz = String(process.env.WIZARD_URL || '').replace(/\/$/, '');
    const pid = process.env.WIZARD_PROJECT_ID || '';
    if (!wiz || !pid) return res.status(400).json({ error: 'No wizard callback configured (WIZARD_URL/WIZARD_PROJECT_ID). Re-deploy this pod once from the wizard to enable Update app.' });
    const k = readKeys();
    const host = String(k.sshHost || process.env.DEPLOY_SSH_HOST || '').trim();
    const password = String(k.sshPassword || process.env.DEPLOY_SSH_PASSWORD || '');
    // Password is optional: blank means key-auth (the wizard uses its mounted SSH key).
    if (!host) return res.status(400).json({ error: 'Set the deploy host (SSH host) on the Integrations tab first — Update app re-deploys over SSH.' });
    const body = {
      name: process.env.APP_NAME || '', host: host, user: String(k.sshUser || process.env.DEPLOY_SSH_USER || 'docker'),
      sshPort: String(k.sshPort || process.env.DEPLOY_SSH_PORT || '22'), password: password,
      port: String(process.env.PORT || '3000'), hostname: process.env.APP_HOSTNAME || '',
      apiKey: anthropicKey(), linearKey: linearKey() || '', linearProjectId: linearProjectId(),
    };
    // Fire-and-forget: the wizard's deploy restarts THIS pod, so we can't await its
    // response (we'd die mid-request). Kick it off; the client polls for the pod to
    // come back on the new version. (Config/cred errors are caught above.) The
    // machine token (baked into this pod) passes the wizard's Entra gate.
    const mh = { 'content-type': 'application/json' };
    if (process.env.PW_MACHINE_TOKEN) mh['x-pw-machine'] = String(process.env.PW_MACHINE_TOKEN).trim();
    fetch(wiz + '/api/projects/' + pid + '/deploy', { method: 'POST', headers: mh, body: JSON.stringify(body) }).catch(function () {});
    res.json({ ok: true, started: true });
  });

  // ── POST /api/assess — diff, fetch live tracker, run AI impact. Saves nothing.
  app.post('/api/assess', jsonBody, async function (req, res) {
    const b = req.body || {};
    const proposed = b.proposed && typeof b.proposed === 'object' ? b.proposed : null;
    if (!proposed) return res.status(400).json({ error: 'no proposed edits supplied' });

    // Code-impact needs the real source — hard gate, same as the wizard.
    let corpus = null;
    try { corpus = reverse.buildCorpus(referenceDir()); } catch (e) {}
    if (!corpus || !corpus.includedCount) {
      return res.status(400).json({ error: 'No codebase bundled with this deploy', code: 'no_corpus',
        detail: 'Assess analyzes code impact against the real source, so it needs a code/zip upload in reference/. Re-deploy this project with a codebase attached, then assess.' });
    }

    let baseline;
    try { baseline = readIntake(); }
    catch (e) { return res.status(500).json({ error: 'baseline (PLAN-INTAKE.json) missing' }); }

    const docDiff = assessLib.diffIntake(baseline, proposed);
    if (!docDiff.length) return res.json({ ok: true, empty: true, message: 'No changes to assess — the docs match the live baseline.' });

    const lk = linearKey();
    let linearIssues = [];
    if (linearProjectId() && lk) {
      try { const meta = await linear.loadProject(lk, linearProjectId()); linearIssues = meta.issues; }
      catch (e) { /* assess still runs without the live tracker */ }
    }

    let ai;
    try { ai = await assessLib.assess({ baseline, proposed, docDiff, linearIssues, corpus }, anthropicKey()); }
    catch (e) { return res.status(e.status || 500).json({ error: 'Assessment failed: ' + (e.message || 'unknown error') }); }

    // Regenerate the architecture diagram when the change affects it (decisions,
    // product, or non-functional posture) so the preview can show the updated
    // diagram DRAFT for review before committing — not just the text.
    let architectureDraft = null;
    const archAffecting = docDiff.some((d) => ['decisions', 'product', 'scalability'].includes(d.section));
    if (archAffecting && anthropicKey()) {
      try { architectureDraft = await enrichLib.enrichArchitecture(proposed, anthropicKey(), corpus); }
      catch (e) { /* non-fatal — assess still returns without the diagram draft */ }
    }

    res.json({
      ok: true, summary: ai.summary,
      units: buildChangeUnits(docDiff, ai),
      hasLinear: !!(linearProjectId() && lk),
      corpus: { files: corpus.fileCount, included: corpus.includedCount },
      architectureDraft: architectureDraft,
    });
  });

  // ── POST /api/apply — merge accepted units, re-render in place, sync Linear ──
  app.post('/api/apply', jsonBody, async function (req, res) {
    const b = req.body || {};
    const proposed = b.proposed && typeof b.proposed === 'object' ? b.proposed : null;
    const units = Array.isArray(b.units) ? b.units : null;
    const accepted = new Set(Array.isArray(b.accepted) ? b.accepted : []);
    if (!proposed || !units) return res.status(400).json({ error: 'proposed edits and the change set are required' });

    let baseline;
    try { baseline = readIntake(); }
    catch (e) { return res.status(500).json({ error: 'baseline (PLAN-INTAKE.json) missing' }); }

    const log = readChanges();
    const changeId = 'CHG-' + (log.seq = (log.seq || 0) + 1);
    const acceptedUnits = units.filter((u) => accepted.has(u.id));
    const applied = { docSections: [], linear: [], affectedClosed: [], code: [] };
    const errors = [];

    // 1. Merge accepted DOC sections into a new intake (reverted sections keep
    //    their baseline values). Start from the baseline so unaccepted edits drop.
    const merged = JSON.parse(JSON.stringify(baseline));
    for (const u of acceptedUnits) {
      if (u.group !== 'doc') continue;
      if (u.section === 'product') {
        if (proposed.product) merged.product = proposed.product;
        if ('startDate' in proposed) merged.startDate = proposed.startDate;
      } else if (proposed[u.section] !== undefined) {
        merged[u.section] = proposed[u.section];
      }
      applied.docSections.push(u.section);
    }

    // 1b. Milestone edits propagate to the tracker BEFORE the structure re-pull:
    //     renaming a milestone row renames the Linear project milestone and its
    //     "Phase X — …" parent issues, so tracker names never drift from the
    //     docs and the re-render below already sees the new names.
    const lkSync = linearKey();
    if (lkSync && linearProjectId() && applied.docSections.indexOf('milestones') !== -1) {
      try {
        const ms = await linear.syncMilestoneEdits(lkSync, linearProjectId(), baseline.milestones || [], merged.milestones || [], merged.startDate || '');
        ms.renamed.forEach((r) => applied.linear.push({ action: 'rename-milestone', title: r.from + ' → ' + r.to }));
        ms.skipped.forEach((s) => errors.push('milestone "' + s + '": no matching Linear milestone to rename'));
      } catch (e) { errors.push('milestone sync: ' + e.message); }
    }

    // 2. Re-render the docs in place from the merged intake. Apply is meant to be
    //    FAST, so we reuse the enrichment captured at build time (.deploy/enrich.json)
    //    rather than re-running the (multi-minute) AI build — the deterministic
    //    pages (tables, plan, requirements) update immediately; the AI artifacts
    //    (diagrams, acceptance criteria) refresh on a full rebuild from the wizard.
    //    The live /api/status script keeps the Plan page current regardless.
    const docsDir = docsDirOf(merged);
    let enrich = null;
    try { enrich = JSON.parse(fs.readFileSync(path.join(deployDir(), 'enrich.json'), 'utf-8')); } catch (e) {}
    // Commit an accepted architecture-diagram draft from the assess step (so the
    // re-render shows the new diagram) and persist it for future fast re-renders.
    if (b.architecture && b.architecture.architecture && Array.isArray(b.architecture.architecture.layers)) {
      enrich = enrich || {};
      enrich.architecture = b.architecture.architecture;
      if (b.architecture.architectureNote) enrich.architectureNote = b.architecture.architectureNote;
      try { fs.writeFileSync(path.join(deployDir(), 'enrich.json'), JSON.stringify(enrich)); } catch (e) {}
      if (applied.docSections.indexOf('architecture') === -1) applied.docSections.push('architecture');
    }
    // Re-pull the live Linear structure so applying a change doesn't wipe the
    // tracker off the Plan page (previously rendered with linear:null).
    let lrApply = null;
    { const lk0 = linearKey(), lp0 = linearProjectId(); if (lk0 && lp0) { try { lrApply = await linear.loadProjectStructure(lk0, lp0); } catch (e) { errors.push('Linear structure: ' + e.message); } } }
    try { renderIntake.render(ROOT, merged, { docsDir: docsDir, enrich: enrich, linear: lrApply }); }
    catch (e) { errors.push('render: ' + e.message); }

    // 3. Run accepted LINEAR actions, each recording the Change ID.
    const lk = linearKey();
    if (linearProjectId() && lk && acceptedUnits.some((u) => u.group === 'linear' || u.group === 'affected-closed')) {
      let meta = null;
      try { meta = await linear.loadProject(lk, linearProjectId()); } catch (e) { errors.push('Linear load: ' + e.message); }
      if (meta) {
        const byId = {}; meta.issues.forEach((i) => { byId[i.identifier] = i; });
        for (const u of acceptedUnits) {
          try {
            if (u.group === 'linear' && u.action === 'create') {
              const issue = await linear.createIssueForChange(lk, { teamId: meta.teamId, projectId: linearProjectId(), title: u.title, owner: u.owner, label: u.label, objective: u.objective, reason: u.reason, changeId: changeId });
              applied.linear.push({ action: 'create', identifier: issue && issue.identifier, url: issue && issue.url, title: u.title });
            } else if (u.group === 'linear' && (u.action === 'update' || u.action === 'cancel')) {
              const issue = byId[u.issueIdentifier];
              if (!issue) { errors.push('issue ' + u.issueIdentifier + ' not found'); continue; }
              if (u.action === 'update') { await linear.updateIssue(lk, issue, changeId, u.objective || u.reason); applied.linear.push({ action: 'update', identifier: issue.identifier, url: issue.url, title: issue.title }); }
              else { await linear.cancelIssue(lk, issue, meta.states, changeId, u.objective || u.reason); applied.linear.push({ action: 'cancel', identifier: issue.identifier, url: issue.url, title: issue.title }); }
            } else if (u.group === 'affected-closed') {
              const issue = byId[u.issueIdentifier];
              if (!issue) { errors.push('issue ' + u.issueIdentifier + ' not found'); continue; }
              await linear.addComment(lk, issue.id, '**' + changeId + '** — a doc change affects this completed issue: ' + u.reason + '\n\n_Review whether it needs reopening._');
              applied.affectedClosed.push({ identifier: issue.identifier, url: issue.url, title: issue.title });
            }
          } catch (e) { errors.push((u.issueIdentifier || u.title || u.id) + ': ' + e.message); }
        }
      }
    }

    // 4. Record code-impact notes (informational) in the change log.
    for (const u of acceptedUnits) if (u.group === 'code') applied.code.push({ area: u.area, detail: u.detail, functions: u.functions || [] });

    // 5. Persist: advance the baseline (write the merged intake) + append the log.
    writeIntake(merged);
    log.changes = Array.isArray(log.changes) ? log.changes : [];
    log.changes.push({
      id: changeId, at: new Date().toISOString(),
      summary: b.summary || '',
      items: acceptedUnits.map(describeUnit),
      applied: applied, errors: errors,
    });
    writeChanges(log);

    res.json({ ok: true, changeId: changeId, applied: applied, errors: errors });
  });
};
