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

  // ── Inject the editor client into every docs HTML page ──────────────────────
  // A response-wrapping middleware (registered before docs-server's page routes,
  // because serve-docs mounts the editor first) appends one <script> before
  // </body> on text/html responses only — so the hamburger menu, Edit wizard, and
  // Changelog tab appear on every page without editing the generated nav.
  const CLIENT_TAG = '<script src="/_editor/client.js" defer></script>';
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
    const gh = githubCfg();
    res.json({
      ok: true,
      intake: intake,
      hasClaude: !!anthropicKey(),
      hasLinear: !!(linearProjectId() && linearKey()),
      hasCorpus: !!(corpus && corpus.includedCount),
      // Integration status for the Integrations tab — booleans for secrets, plain
      // values for the non-secret IDs/URLs. Raw keys are never sent to the client.
      integrations: {
        hasClaude: !!anthropicKey(),
        hasLinearKey: !!linearKey(),
        linearProjectId: linearProjectId(),
        githubRepoUrl: gh.repoUrl,
        hasGithubToken: gh.hasToken,
        docsDir: docsDirOf(intake),
      },
      changes: (readChanges().changes || []).slice(-20),
    });
  });

  // ── POST /api/integrations — set keys / IDs / URLs on the LIVE pod ───────────
  // Writes .deploy/keys.json (overrides the deploy-baked env). Secrets are only
  // overwritten when a non-empty value is supplied (blank leaves them untouched);
  // non-secret IDs/URLs are set as given. Returns the new status, never the keys.
  app.post('/api/integrations', jsonBody, function (req, res) {
    const b = req.body || {};
    const keys = readKeys();
    ['anthropicKey', 'linearKey', 'githubToken'].forEach(function (k) {
      if (typeof b[k] === 'string' && b[k].trim()) keys[k] = b[k].trim();
    });
    ['linearProjectId', 'githubRepoUrl'].forEach(function (k) {
      if (typeof b[k] === 'string') keys[k] = b[k].trim();
    });
    try { writeKeys(keys); }
    catch (e) { return res.status(500).json({ error: 'could not save integration settings: ' + (e.message || e) }); }
    const gh = githubCfg();
    res.json({ ok: true, integrations: { hasClaude: !!anthropicKey(), hasLinearKey: !!linearKey(), linearProjectId: linearProjectId(), githubRepoUrl: gh.repoUrl, hasGithubToken: gh.hasToken } });
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
    try { renderIntake.render(ROOT, merged, { docsDir: docsDir, enrich: enrich, linear: null }); }
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
