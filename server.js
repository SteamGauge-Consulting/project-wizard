// ============================================================================
//  project-wizard — standalone multi-project PLAN wizard.
//
//  Home: tiles for each project + a "New project" button. A project starts as a
//  draft; you walk the wizard (the human-only decisions); on finish the app runs
//  docs-kit with the project's values to materialize a real /docs structure, and
//  the tile then opens that browsable structure (+ zip download).
//
//  Server-side JSON storage (data/projects/<id>.json); generated trees under
//  data/generated/<id>/. No auth — deploy behind a private IP / its own network.
// ============================================================================

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const storage = require('./lib/storage');
const staticSite = require('./lib/static-site');
const deployBundle = require('./lib/deploy-bundle');
const reverse = require('./lib/reverse-engineer');
const renderIntake = require('./lib/render-intake');
const enrichLib = require('./lib/enrich');
const assessLib = require('./lib/assess');
const linear = require('./lib/linear');

const app = express();
const PORT = process.env.PORT || 4500;
const KIT = path.join(__dirname, 'lib', 'docs-kit.js');

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── helpers ────────────────────────────────────────────────────────────────
const emptyAnswers = () => ({
  product: {}, integrations: {}, requirements: [], decisions: [], milestones: [], risks: [], scalability: [],
});

// The wizard's own base URL, from the incoming request — used to bake an
// "✎ Edit in wizard" deep-link into the deployed docs (the living-docs round-trip).
function wizardEditUrl(req, id) {
  const host = req.headers && req.headers.host;
  if (!host) return '';
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  return proto + '://' + host + '/#/p/' + id + '/docs';
}

function summarize(p) {
  return {
    id: p.id, name: p.name, status: p.status,
    createdAt: p.createdAt, updatedAt: p.updatedAt, generatedAt: p.generatedAt || null,
    oneliner: (p.answers && p.answers.product && p.answers.product.oneliner) || '',
    docsDir: (p.answers && p.answers.integrations && p.answers.integrations.docsDir) || 'docs',
    fileCount: p.manifest ? p.manifest.fileCount : 0,
    attachmentCount: Array.isArray(p.attachments) ? p.attachments.length : 0,
    deployUrl: p.deployUrl || null, deployedAt: p.deployedAt || null,
  };
}

// Compose the structured intake + the AI handoff prompt from a project's answers.
// (Server-side twin of the wizard's export step, so generated artifacts are
// consistent regardless of the client.)
function cleanRows(rows, keys) {
  return (rows || []).filter((r) => keys.some((k) => String(r[k] || '').trim()));
}
function intakeOf(p) {
  const a = p.answers || emptyAnswers();
  return {
    version: 1, kind: 'plan-intake', project: p.name,
    startDate: (a.startDate || '').trim ? (a.startDate || '').trim() : (a.startDate || ''),
    product: a.product || {}, integrations: a.integrations || {},
    requirements: cleanRows(a.requirements, ['title', 'test']),
    decisions: cleanRows(a.decisions, ['concern', 'choice', 'why']),
    milestones: cleanRows(a.milestones, ['name', 'done', 'target']),
    risks: cleanRows(a.risks, ['risk', 'mitigation']),
    scalability: cleanRows(a.scalability, ['area', 'target', 'adr']),
  };
}
function refsSection(p) {
  const atts = Array.isArray(p.attachments) ? p.attachments : [];
  if (!atts.length) return [];
  const lines = atts.map((a) =>
    '- `reference/' + a.name + '` (' + (a.kind === 'code' ? 'code / archive' : 'document') + ', ' + fmtBytes(a.size) + ')'
    + (a.kind === 'code' ? ' — existing code/archive: read it as a pattern and constraint, not as scope' : ''));
  return [
    '',
    '--- REFERENCE MATERIAL (./reference/) ---',
    'The owner attached ' + atts.length + ' supporting file(s) as additional context — read them ALONGSIDE this intake before writing. They are reference, NOT scope: use them to understand the existing codebase, prior art, or domain detail, but every NEW user-facing behavior must still trace to a PLAN-INTAKE.json field, and the Not-building list still governs. If a reference file contradicts the intake, surface the conflict instead of silently following either one. Codebase archives (.zip/.tar) describe how things are or could be built — mine them for patterns, data shapes, and constraints; do not treat their incidental features as requirements.',
    ...lines,
  ];
}

function handoffOf(p) {
  const d = (p.answers && p.answers.integrations && p.answers.integrations.docsDir) || 'docs';
  return [
    'You are the planning agent for the project described in PLAN-INTAKE.json (in this repo root). The repo was bootstrapped with docs-kit, so the /docs hub, governance library, and ' + d + '/ docs exist but still carry the donor project’s example content. Replace that content with this project’s, translating the intake into engineering artifacts under governance/CLAUDE.md phase discipline (Phase 01 — Requirements, then 02 — Architecture).',
    '',
    'From the intake, produce — questioning anything ambiguous before writing:',
    '1. ' + d + '/REQUIREMENTS.md — requirements table (MoSCoW from my priorities), one Given/When/Then acceptance criterion per "how you’d test it" line, and the Not-building list verbatim.',
    '2. ' + d + '/adr/ — one ADR per locked decision (context, decision, trade-off accepted, revisit trigger). Update the locked-stack table wherever the docs show it.',
    '3. ' + d + '/milestones/ — one note per milestone with its "done means" outcome; update the Plan page + Mermaid Gantt to match.',
    '4. Tracker: create milestones, one parent issue per phase, and sub-issues derived from requirements × milestones, each carrying its acceptance criteria; link them in the plan rows. ⚠️ Only ever write to a tracker project DEDICATED to this app (empty, or already this app’s). If the configured Linear project/ID already holds unrelated issues, do NOT pollute it — create a new project for this app, or pause and ask the owner which project to use, before creating anything.',
    '5. Diagrams: update the architecture page (system diagram from the locked decisions) and any flow diagrams the requirements imply.',
    '5b. Nav links: keep the shared nav’s structure and styling intact, but DO update the Reference / ADR / milestone link lists (in lib/docs-nav.js) to point at THIS app’s actual files — when you add or rename ADR/milestone/spec docs, the old donor links become dead and fail check-docs. Updating those per-file links is required, not a deviation; leave unrelated nav sections (e.g. product-mockup links) alone if the intake has no scope for them.',
    '6. Tests-as-requirements: emit the initial test list (one named test per AC) into the requirements doc.',
    '7. Risks: fold risks/constraints into the requirements and the review checklist.',
    '8. Non-functional coverage: produce a dedicated section (or a new ADR) for each of — observability (structured logging, metrics, tracing, dashboards, alerting), resilience patterns (timeouts, retries with backoff, circuit breakers, graceful degradation, idempotency), async/background processing (queues, workers, scheduled jobs), performance targets & load testing (SLIs/SLOs plus a load-test plan and tooling), secret management (injection, rotation, none in the image), cost controls (budgets, autoscaling ceilings, right-sizing), and security hardening (authn/z, input validation, dependency/CVE scanning, least privilege, TLS).',
    '9. Microservices readiness: even if the locked choice is a modular monolith first, document the bounded contexts, a ports-and-adapters (hexagonal) layering recommendation that keeps domain logic transport-agnostic, and the event-driven implications (which interactions should become async events) so the monolith can be split later without a rewrite.',
    '10. IaC & deployment notes: specify the Dockerfile, fly.toml (or equivalent), a CI/CD pipeline (test → build → deploy), secret injection at deploy time, the DB migration strategy (forward-only, run-on-deploy), and monitoring/alerting wiring.',
    '11. Infer the implementation — the intake captures INTENT and user-observable behavior, NOT implementation. Choose idiomatic, well-supported tech yourself (libraries, patterns, animation timings, state management, data shapes). The owner is never expected to name a drag-and-drop library, an animation duration, or a framework. Apply a tasteful quality-and-robustness baseline by default unless a requirement overrides it: smooth, touch-capable interactions; optimistic UI reconciled with the server; empty / loading / error / first-run states; undo (soft-delete) for destructive actions; keyboard + screen-reader access and adequate color contrast (never signal by color alone); responsive layouts; and atomic, crash-safe persistence.',
    '12. Cover the commonly-omitted concerns proactively — treat each as part of the spec even when the intake is silent: choose a sensible default, implement it, and flag ONLY the ones that need a genuine product decision. The usual blind spots: first-run / seed / empty state; auth edge cases (bad credentials, session expiry, lockout / rate-limiting); the "today" / timezone boundary and clock rollover; concurrency and multi-device live refresh; data lifecycle (export, archival, retention, undo, audit log of who-did-what-when); notification permissions, triggers, and quiet hours; offline / installable behavior; backup & restore; and a global pause / quiet mode.',
    '',
    'Rules: distinguish SCOPE from IMPLEMENTATION. Do not invent new scope/features that aren’t in the intake — ask. But DO supply implementation detail, the quality baseline (#11), and sensible defaults for the cross-cutting concerns (#12) without asking — only escalate genuine product decisions. Prefer the owner’s plain-English intent over inventing detail, and keep their wording where it is clearer. Every user-facing behavior must trace to an intake field; everything else is yours to choose well. Treat the scalability / non-functional rows as first-class; if sparse, still produce a minimal observability + resilience baseline and call out the gaps.',
  ].concat(refsSection(p)).concat([
    '',
    '--- PLAN-INTAKE.json ---',
    JSON.stringify(intakeOf(p), null, 2),
  ]).join('\n');
}

// ─── reference attachments ───────────────────────────────────────────────────
// Uploaded supporting files (docs + codebase archives) the agent reads alongside
// the intake. Stored under data/attachments/<id>/; copied into the generated
// tree's reference/ folder so they ride along in every export.
const MAX_ATTACH_BYTES = 64 * 1024 * 1024;          // per file
const DOC_EXT  = ['pdf','txt','md','markdown','rst','doc','docx','odt','rtf','csv','tsv','json','yaml','yml','toml','xml','html','htm','png','jpg','jpeg','gif','svg','webp'];
const CODE_EXT = ['zip','tar','tgz','gz','bz2','7z','js','mjs','cjs','ts','tsx','jsx','py','rb','go','rs','java','kt','c','h','cpp','hpp','cs','php','swift','sql','sh','ipynb'];
const ALLOWED_EXT = new Set([...DOC_EXT, ...CODE_EXT]);

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}
function extOf(name) { const m = /\.([a-z0-9]+)$/i.exec(name || ''); return m ? m[1].toLowerCase() : ''; }
function kindOf(name) { return CODE_EXT.indexOf(extOf(name)) !== -1 ? 'code' : 'doc'; }

// Strip any path, keep a safe basename. Returns '' if nothing usable remains.
function safeFileName(raw) {
  let n = String(raw || '').replace(/\\/g, '/');
  n = n.slice(n.lastIndexOf('/') + 1);              // basename only
  n = n.normalize('NFC').replace(/[\x00-\x1f]/g, '');
  n = n.replace(/[^A-Za-z0-9._ \-()+]/g, '_').replace(/\s+/g, ' ').trim();
  n = n.replace(/^\.+/, '');                          // no leading dots (no dotfiles / traversal)
  if (n.length > 120) { const e = extOf(n); n = n.slice(0, 110) + (e ? '.' + e : ''); }
  return n;
}

// Sanitize a RELATIVE path (for folder/codebase uploads) — each segment cleaned,
// '..' and empty segments dropped, so it can never escape the attachments dir.
function safeRelPath(raw) {
  return String(raw || '').replace(/\\/g, '/').split('/')
    .map((seg) => safeFileName(seg)).filter((seg) => seg && seg !== '.').join('/');
}

// List every uploaded file (recursively — folder/zip uploads nest), disk is the
// source of truth. Returns relative paths with size + kind.
function walkAttach(dir, rel, out) {
  let entries;
  try { entries = fs.readdirSync(path.join(dir, rel || ''), { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.endsWith('.tmp')) continue;
    const rp = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) walkAttach(dir, rp, out);
    else if (e.isFile()) { let s = 0; try { s = fs.statSync(path.join(dir, rp)).size; } catch {} out.push({ name: rp, size: s, kind: kindOf(rp) }); }
  }
}
function listAttachments(p) {
  const out = [];
  walkAttach(storage.attachmentsDir(p.id), '', out);
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// Mirror current attachments into <genDir>/reference/ (clears stale ones first).
function syncReferenceDir(p) {
  const genDir = storage.generatedDir(p.id);
  if (!fs.existsSync(genDir)) return;
  const refDir = path.join(genDir, 'reference');
  try { fs.rmSync(refDir, { recursive: true, force: true }); } catch {}
  const atts = listAttachments(p);
  if (!atts.length) return;
  const src = storage.attachmentsDir(p.id);
  for (const a of atts) {
    const dest = path.join(refDir, a.name);
    try { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(src, a.name), dest); } catch {}
  }
}

// Map a parsed intake (from the model, or an imported PLAN-INTAKE.json) into the
// wizard's answers shape. Tables become rows; product fields merge in.
function strOf(v) { return typeof v === 'string' ? v : (v == null ? '' : String(v)); }
function rowsOf(list, keys) {
  return (Array.isArray(list) ? list : []).map((r) => {
    const o = {}; keys.forEach((k) => { o[k] = strOf(r && r[k]); }); return o;
  }).filter((o) => Object.keys(o).some((k) => o[k].trim()));
}
function applyIntake(p, intake) {
  intake = intake || {};
  const a = p.answers || emptyAnswers();
  a.product = a.product || {};
  const prod = intake.product || {};
  ['name', 'domain', 'oneliner', 'problem', 'users', 'differentiator', 'experience', 'success', 'notBuilding']
    .forEach((k) => { if (strOf(prod[k]).trim()) a.product[k] = strOf(prod[k]); });
  a.requirements = rowsOf(intake.requirements, ['title', 'priority', 'test']);
  a.decisions = rowsOf(intake.decisions, ['concern', 'choice', 'why']);
  a.milestones = rowsOf(intake.milestones, ['name', 'done', 'target']);
  a.risks = rowsOf(intake.risks, ['risk', 'mitigation']);
  a.scalability = rowsOf(intake.scalability, ['area', 'target', 'adr']);
  a.requirements.forEach((r) => { if (['Must', 'Should', 'May', "Won't"].indexOf(r.priority) === -1) r.priority = 'Should'; });
  if ((!p.name || p.name === 'Untitled project') && strOf(prod.name).trim()) p.name = strOf(prod.name).trim();
  p.answers = a;
}

// Write the project's own intake + handoff (+ reference files) into a tree.
// Shared by generate and by attachment add/delete (to keep an already-generated
// tree consistent without forcing a full re-run).
function writeAux(p, dir) {
  try {
    fs.writeFileSync(path.join(dir, 'PLAN-INTAKE.json'), JSON.stringify(intakeOf(p), null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'AI-HANDOFF.md'), handoffOf(p) + '\n');
  } catch (e) { /* non-fatal */ }
  syncReferenceDir(p);
}

// ─── projects CRUD ──────────────────────────────────────────────────────────
app.get('/api/projects', (req, res) => {
  res.json(storage.listProjects().map(summarize));
});

app.post('/api/projects', (req, res) => {
  const name = String((req.body && req.body.name) || '').trim() || 'Untitled project';
  const now = new Date().toISOString();
  const project = {
    id: storage.newId(), name, status: 'draft',
    createdAt: now, updatedAt: now, answers: emptyAnswers(),
  };
  storage.saveProject(project);
  res.status(201).json(project);
});

app.get('/api/projects/:id', (req, res) => {
  const p = storage.getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  res.json(p);
});

app.put('/api/projects/:id', (req, res) => {
  const p = storage.getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (typeof req.body.name === 'string' && req.body.name.trim()) p.name = req.body.name.trim();
  if (req.body.answers && typeof req.body.answers === 'object') p.answers = req.body.answers;
  storage.saveProject(p);
  res.json(summarize(p));
});

app.delete('/api/projects/:id', (req, res) => {
  storage.deleteProject(req.params.id);
  res.json({ ok: true });
});

// ─── reference / source attachments: list / upload / delete ──────────────────
app.get('/api/projects/:id/attachments', (req, res) => {
  const p = storage.getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const atts = listAttachments(p);
  res.json({ attachments: atts, maxBytes: MAX_ATTACH_BYTES, totalBytes: atts.reduce((n, a) => n + a.size, 0) });
});

// Raw-body upload — one file per request. ?name= = a single reference doc
// (type allow-listed, flat). ?path= = a file within a folder/codebase upload
// (relative path preserved, lenient — the corpus builder filters by type later).
// Dependency-light: the browser POSTs the File as the body, no multipart parser.
app.post('/api/projects/:id/attachments',
  express.raw({ type: () => true, limit: MAX_ATTACH_BYTES }),
  (req, res) => {
    const p = storage.getProject(req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    const usePath = typeof req.query.path === 'string' && req.query.path.length > 0;
    const rel = usePath ? safeRelPath(req.query.path) : safeFileName(req.query.name);
    if (!rel) return res.status(400).json({ error: 'a valid filename is required' });
    if (!usePath && !ALLOWED_EXT.has(extOf(rel))) {
      return res.status(415).json({ error: 'unsupported file type “.' + (extOf(rel) || '?') + '”. Allowed: documents (pdf, md, txt, docx, csv, json, images…) and code/archives (zip, tar, and common source files).' });
    }
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!buf.length) return res.status(400).json({ error: 'empty file' });

    const dir = storage.attachmentsDir(p.id);
    const full = path.join(dir, rel);
    if (!path.resolve(full).startsWith(path.resolve(dir) + path.sep)) return res.status(400).json({ error: 'bad path' });
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const tmp = path.join(dir, '.' + crypto.randomBytes(4).toString('hex') + '.tmp');
    try {
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, full);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch {}
      return res.status(500).json({ error: 'could not store file' });
    }

    p.attachments = listAttachments(p);
    storage.saveProject(p);
    writeAux(p, storage.generatedDir(p.id));        // keep an already-generated tree in sync
    res.status(201).json({ ok: true, attachment: { name: rel, size: buf.length, kind: kindOf(rel) }, count: p.attachments.length });
  });

// Delete one file (?name=<relative path>) or clear all (no name).
app.delete('/api/projects/:id/attachments', (req, res) => {
  const p = storage.getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const dir = storage.attachmentsDir(p.id);
  if (req.query.name) {
    const rel = safeRelPath(req.query.name);
    if (rel) { try { fs.rmSync(path.join(dir, rel), { force: true }); } catch {} }
  } else {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  p.attachments = listAttachments(p);
  storage.saveProject(p);
  writeAux(p, storage.generatedDir(p.id));
  res.json({ ok: true, attachments: listAttachments(p) });
});

// ─── reverse-engineer an intake from uploaded code ───────────────────────────
app.post('/api/projects/:id/generate-draft', async (req, res) => {
  const p = storage.getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  let corpus;
  try { corpus = reverse.buildCorpus(storage.attachmentsDir(p.id)); }
  catch (e) { return res.status(500).json({ error: 'could not read the uploaded files: ' + (e.message || e) }); }
  if (!corpus.includedCount) {
    return res.status(400).json({ error: 'no readable source found — upload your app’s code (files, a folder, or a .zip) first' });
  }
  const apiKey = (req.body && req.body.apiKey) || '';
  const hasKey = !!String(apiKey).trim() || reverse.serverKeyConfigured();
  const meta = { fileCount: corpus.fileCount, includedCount: corpus.includedCount, truncated: corpus.truncated };

  if (!hasKey) {
    return res.json(Object.assign({ ok: true, mode: 'handoff', prompt: reverse.handoffPrompt(p.name, corpus) }, meta));
  }
  try {
    const intake = await reverse.generateIntake(p.name, corpus, apiKey);
    applyIntake(p, intake);
    p.draftFromCode = true;
    storage.saveProject(p);
    res.json(Object.assign({ ok: true, mode: 'auto', model: reverse.MODEL, counts: {
      requirements: p.answers.requirements.length,
      decisions: p.answers.decisions.length,
      milestones: p.answers.milestones.length,
    } }, meta));
  } catch (e) {
    res.status(e.status || 500).json({ error: 'draft generation failed: ' + (e.message || 'unknown error') });
  }
});

// Import a PLAN-INTAKE.json (e.g. produced by the handoff path) into a project.
app.post('/api/projects/:id/import-intake', (req, res) => {
  const p = storage.getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const body = req.body || {};
  const intake = body.intake !== undefined ? body.intake : body;
  if (!intake || typeof intake !== 'object' || Array.isArray(intake)) {
    return res.status(400).json({ error: 'expected a PLAN-INTAKE JSON object' });
  }
  const data = intake.answers ? intake.answers : intake;
  if (!data.product && !Array.isArray(data.requirements)) {
    return res.status(400).json({ error: 'that doesn’t look like a PLAN-INTAKE — expected product / requirements fields' });
  }
  applyIntake(p, data);
  p.draftFromCode = true;
  storage.saveProject(p);
  res.json({ ok: true });
});

// ─── generate the doc structure via docs-kit ────────────────────────────────
app.post('/api/projects/:id/generate', (req, res) => {
  const p = storage.getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });

  const dir = storage.generatedDir(p.id);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(dir, { recursive: true });

  const a = p.answers || emptyAnswers();
  const prod = a.product || {}, integ = a.integrations || {};
  const args = [KIT, dir, '--yes', '--no-github', '--force',
    '--app-name=' + (prod.name || p.name || 'MyApp'),
    '--app-domain=' + (prod.domain || 'app.example'),
    '--docs-dir=' + (integ.docsDir || 'docs'),
  ];
  if (integ.githubRepoUrl) args.push('--github-repo-url=' + integ.githubRepoUrl);
  if (integ.linearWorkspaceUrl) args.push('--linear-workspace-url=' + integ.linearWorkspaceUrl);
  if (integ.linearProjectUrl) args.push('--linear-project-url=' + integ.linearProjectUrl);
  if (integ.linearProjectId) args.push('--linear-project-id=' + integ.linearProjectId);

  execFile('node', args, { timeout: 60000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) {
      return res.status(500).json({ error: 'generation failed', detail: String(stderr || err.message).slice(0, 500) });
    }
    // Replace the donor's example pages with THIS project's content (from the
    // intake), so a generated/deployed site shows only the wizard's project.
    try { renderIntake.render(dir, intakeOf(p), { docsDir: integ.docsDir || 'docs' }); }
    catch (e) { console.error('render-intake failed (non-fatal):', e.message); }

    // Drop the project's own intake + handoff + reference files into the tree.
    writeAux(p, dir);

    const files = walkTree(dir);
    p.status = 'generated';
    p.generatedAt = new Date().toISOString();
    p.manifest = { fileCount: files.length, docsDir: integ.docsDir || 'docs' };
    storage.saveProject(p);
    res.json({ ok: true, project: summarize(p), fileCount: files.length });
  });
});

// ─── Stage 3: AI build (rich docs) + Linear tracker ──────────────────────────
// List Linear teams for the GUI picker (also validates the key). POST so the
// key isn't logged in a URL.
app.post('/api/linear/teams', async (req, res) => {
  const key = (req.body && req.body.key && String(req.body.key).trim()) || '';
  if (!key) return res.status(400).json({ error: 'a Linear API key is required' });
  try { res.json({ ok: true, teams: await linear.listTeams(key) }); }
  catch (e) { res.status(e.status || 500).json({ error: 'Linear: ' + (e.message || 'request failed') }); }
});

// Enrich the generated docs with AI (Mermaid diagrams, Given/When/Then, ADR
// bodies) and — if a Linear key + team are supplied — create a brand-new Linear
// project with milestones + issues from the intake.
app.post('/api/projects/:id/build-full', async (req, res) => {
  const p = storage.getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const dir = storage.generatedDir(p.id);
  if (!fs.existsSync(dir)) return res.status(400).json({ error: 'generate the doc structure first, then build full docs' });

  const b = req.body || {};
  const intake = intakeOf(p);
  const docsDir = (p.answers && p.answers.integrations && p.answers.integrations.docsDir) || 'docs';
  const out = { ok: true };
  let plan = null, enrich = null, lr = null;

  // 1. AI enrichment → produce the governance plan + rich doc content (Mermaid,
  //    Given/When/Then, ADR bodies). Optional: skipped when no key is available
  //    (docs stay as clean tables), so the Linear step below can still run.
  const apiKey = (b.apiKey && String(b.apiKey).trim()) || '';
  if (apiKey || enrichLib.aiEnabled()) {
    try {
      let corpus = null;
      try { corpus = reverse.buildCorpus(storage.attachmentsDir(p.id)); } catch (e) {}
      enrich = await enrichLib.enrich(intake, apiKey, corpus && corpus.includedCount ? corpus : null);
      plan = enrich.plan;
      out.enriched = true;
      out.counts = { requirements: (intake.requirements || []).length, decisions: (intake.decisions || []).length, milestones: (intake.milestones || []).length };
    } catch (e) {
      return res.status(e.status || 500).json({ error: 'AI build failed: ' + (e.message || 'unknown error') });
    }
  }

  // 2. Optional Linear tracker. Runs BEFORE the render so the Plan page can mirror
  //    the live tracker (milestone roll-up + per-phase issue overview + live
  //    status). Two modes: pull an EXISTING project read-only (linearProjectId),
  //    or create a brand-new one (teamId). Existing-pull never writes.
  const linearKey = (b.linearKey && String(b.linearKey).trim()) || '';
  const existingProjectId = (b.linearProjectId && String(b.linearProjectId).trim()) || '';
  if (linearKey && existingProjectId) {
    try {
      lr = await linear.loadProjectStructure(linearKey, existingProjectId);  // read-only
      out.linear = lr; out.linearMode = 'existing';
      p.linear = lr;
      p.linearUrl = lr.url;
      p.linearProjectId = lr.projectId;
    } catch (e) {
      out.linearError = 'Linear (pull existing): ' + (e.message || 'failed');
    }
  } else if (linearKey && b.teamId) {
    try {
      lr = await linear.createProjectWithIssues(linearKey, { teamId: b.teamId, name: p.name, intake, startDate: intake.startDate, plan });
      out.linear = lr;
      p.linear = lr;                  // persisted so apply-changes can re-render the Plan overview
      p.linearUrl = lr.url;
      p.linearProjectId = lr.projectId;
    } catch (e) {
      out.linearError = 'Linear: ' + (e.message || 'failed'); // non-fatal — docs still built
    }
  }

  // 3. Re-render the docs from the intake with whatever we produced (enrichment
  //    and/or the live Linear tracker). Skipped only when neither ran.
  if (enrich || lr) {
    try {
      renderIntake.render(dir, intake, { docsDir, enrich, linear: lr, wizardEditUrl: wizardEditUrl(req, p.id) });
      writeAux(p, dir);
    } catch (e) {
      console.error('render-intake (build-full) failed:', e.message);
    }
  }
  // Persist the enrichment beside the docs so the DEPLOYED in-page editor can
  // re-render with diagrams/criteria on Apply WITHOUT re-running the AI build.
  if (enrich) {
    try { fs.mkdirSync(path.join(dir, '.deploy'), { recursive: true }); fs.writeFileSync(path.join(dir, '.deploy', 'enrich.json'), JSON.stringify(enrich)); }
    catch (e) { console.error('enrich.json persist failed:', e.message); }
  }
  // Snapshot this as the live BASELINE for future "Assess Changes" diffs, and
  // remember the last enrichment so apply-changes can re-render with diagrams.
  if (enrich) p.lastEnrich = enrich;
  p.baseline = intake;
  p.enrichedAt = new Date().toISOString();
  storage.saveProject(p);
  res.json(out);
});

// ─── living docs: Edit → Assess Changes → accept/revert → apply ──────────────
// Build the {baseline, proposed, docDiff, linearIssues, corpus} for an assess
// run and turn the AI result into a flat list of accept/revert change units.
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

// Assess: diff the docs, fetch the live tracker, run the AI impact analysis.
// Saves NOTHING — returns the change set for the accept/revert popup.
app.post('/api/projects/:id/assess', async (req, res) => {
  const p = storage.getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const proposed = b.proposed && typeof b.proposed === 'object' ? b.proposed : null;
  if (!proposed) return res.status(400).json({ error: 'no proposed edits supplied' });

  // Code-impact requires the current codebase — hard gate (per the chosen design).
  let corpus = null;
  try { corpus = reverse.buildCorpus(storage.attachmentsDir(p.id)); } catch (e) {}
  if (!corpus || !corpus.includedCount) {
    return res.status(400).json({ error: 'Attach the current codebase first', code: 'no_corpus',
      detail: 'Assess Changes analyzes code impact against the real source, so it needs a code/zip upload in this project’s reference files. Add one, then assess.' });
  }

  const baseline = p.baseline || intakeOf(p);
  const docDiff = assessLib.diffIntake(baseline, proposed);
  if (!docDiff.length) return res.json({ ok: true, empty: true, message: 'No changes to assess — the docs match the live baseline.' });

  const linearKey = (b.linearKey && String(b.linearKey).trim()) || '';
  let linearIssues = [], linearMeta = null;
  if (p.linearProjectId && linearKey) {
    try { linearMeta = await linear.loadProject(linearKey, p.linearProjectId); linearIssues = linearMeta.issues; }
    catch (e) { /* assess can still run without the live tracker */ }
  }

  const apiKey = (b.apiKey && String(b.apiKey).trim()) || '';
  let ai;
  try {
    ai = await assessLib.assess({ baseline, proposed, docDiff, linearIssues, corpus }, apiKey);
  } catch (e) {
    return res.status(e.status || 500).json({ error: 'Assessment failed: ' + (e.message || 'unknown error') });
  }

  res.json({
    ok: true, summary: ai.summary,
    units: buildChangeUnits(docDiff, ai),
    hasLinear: !!(p.linearProjectId && linearKey),
    corpus: { files: corpus.fileCount, included: corpus.includedCount },
  });
});

// Apply: take the accepted change-unit ids + the proposed intake, assign a
// Change ID, merge accepted doc sections, re-render, run accepted Linear
// actions (each commenting the Change ID), and advance the baseline.
app.post('/api/projects/:id/apply-changes', async (req, res) => {
  const p = storage.getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const proposed = b.proposed && typeof b.proposed === 'object' ? b.proposed : null;
  const units = Array.isArray(b.units) ? b.units : null;
  const accepted = new Set(Array.isArray(b.accepted) ? b.accepted : []);
  if (!proposed || !units) return res.status(400).json({ error: 'proposed edits and the change set are required' });

  const changeId = 'CHG-' + (p.changeSeq = (p.changeSeq || 0) + 1);
  const acceptedUnits = units.filter((u) => accepted.has(u.id));
  const docsDir = (p.answers && p.answers.integrations && p.answers.integrations.docsDir) || 'docs';
  const applied = { docSections: [], linear: [], affectedClosed: [], code: [] };
  const errors = [];

  // 1. Merge accepted DOC sections into the project's answers (reverted sections
  //    keep their baseline values). Tables/scalars copied wholesale per section.
  p.answers = p.answers || emptyAnswers();
  for (const u of acceptedUnits) {
    if (u.group !== 'doc') continue;
    if (u.section === 'product') {
      if (proposed.product) p.answers.product = proposed.product;
      if ('startDate' in proposed) p.answers.startDate = proposed.startDate;
    } else if (proposed[u.section] !== undefined) {
      p.answers[u.section] = proposed[u.section];
    }
    applied.docSections.push(u.section);
  }

  // 2. Re-render the docs from the merged intake. Re-enrich when a Claude key is
  //    present (refreshes diagrams + acceptance criteria for the new content),
  //    else reuse the last enrichment. Reuse the live Linear structure if any.
  const mergedIntake = intakeOf(p);
  const dir = storage.generatedDir(p.id);
  if (fs.existsSync(dir)) {
    let enrich = p.lastEnrich || null;
    const apiKey = (b.apiKey && String(b.apiKey).trim()) || '';
    if (applied.docSections.length && (apiKey || enrichLib.aiEnabled())) {
      try {
        let corpus = null; try { corpus = reverse.buildCorpus(storage.attachmentsDir(p.id)); } catch (e) {}
        enrich = await enrichLib.enrich(mergedIntake, apiKey, corpus && corpus.includedCount ? corpus : null);
        p.lastEnrich = enrich;
      } catch (e) { errors.push('re-enrich skipped: ' + e.message); }
    }
    try { renderIntake.render(dir, mergedIntake, { docsDir, enrich, linear: p.linear || null, wizardEditUrl: wizardEditUrl(req, p.id) }); writeAux(p, dir); }
    catch (e) { errors.push('render: ' + e.message); }
  }

  // 3. Run accepted LINEAR actions, each recording the Change ID.
  const linearKey = (b.linearKey && String(b.linearKey).trim()) || '';
  if (p.linearProjectId && linearKey && acceptedUnits.some((u) => u.group === 'linear' || u.group === 'affected-closed')) {
    let meta = null;
    try { meta = await linear.loadProject(linearKey, p.linearProjectId); } catch (e) { errors.push('Linear load: ' + e.message); }
    if (meta) {
      const byId = {}; meta.issues.forEach((i) => { byId[i.identifier] = i; });
      for (const u of acceptedUnits) {
        try {
          if (u.group === 'linear' && u.action === 'create') {
            const issue = await linear.createIssueForChange(linearKey, { teamId: meta.teamId, projectId: p.linearProjectId, title: u.title, owner: u.owner, label: u.label, objective: u.objective, reason: u.reason, changeId });
            applied.linear.push({ action: 'create', identifier: issue && issue.identifier, url: issue && issue.url, title: u.title });
          } else if (u.group === 'linear' && (u.action === 'update' || u.action === 'cancel')) {
            const issue = byId[u.issueIdentifier];
            if (!issue) { errors.push('issue ' + u.issueIdentifier + ' not found'); continue; }
            if (u.action === 'update') { await linear.updateIssue(linearKey, issue, changeId, u.objective || u.reason); applied.linear.push({ action: 'update', identifier: issue.identifier }); }
            else { await linear.cancelIssue(linearKey, issue, meta.states, changeId, u.objective || u.reason); applied.linear.push({ action: 'cancel', identifier: issue.identifier }); }
          } else if (u.group === 'affected-closed') {
            const issue = byId[u.issueIdentifier];
            if (!issue) { errors.push('issue ' + u.issueIdentifier + ' not found'); continue; }
            await linear.addComment(linearKey, issue.id, '**' + changeId + '** — a doc change affects this completed issue: ' + u.reason + '\n\n_Review whether it needs reopening._');
            applied.affectedClosed.push(issue.identifier);
          }
        } catch (e) { errors.push((u.issueIdentifier || u.title || u.id) + ': ' + e.message); }
      }
    }
  }

  // 4. Record code-impact notes (informational) in the change log.
  for (const u of acceptedUnits) if (u.group === 'code') applied.code.push({ area: u.area, detail: u.detail, functions: u.functions || [] });

  // 5. Persist: advance the baseline, append the change-log entry.
  p.baseline = mergedIntake;
  p.changes = Array.isArray(p.changes) ? p.changes : [];
  p.changes.push({ id: changeId, at: new Date().toISOString(), summary: b.summary || '', applied, errors });
  p.enrichedAt = new Date().toISOString();
  storage.saveProject(p);

  res.json({ ok: true, changeId, applied, errors, project: summarize(p) });
});

// Proxy an edit to the DEPLOYED pod's own editor API, so editing a deployed
// project from the wizard updates the pod's LIVE data (no rebuild, no SSH — the
// pod re-renders in place via its bind mount, using its baked keys + corpus).
function podOrigin(p) { return p.deployUrl ? String(p.deployUrl).replace(/\/docs\/?$/, '') : null; }
app.all('/api/projects/:id/pod/:action(assess|apply|intake|changes)', async (req, res) => {
  const p = storage.getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const origin = podOrigin(p);
  if (!origin) return res.status(400).json({ error: 'this project is not deployed yet — use Build plan first', code: 'not_deployed' });
  const get = req.method === 'GET' || req.params.action === 'intake' || req.params.action === 'changes';
  try {
    const r = await fetch(origin + '/api/' + req.params.action, Object.assign(
      { method: get ? 'GET' : 'POST', headers: { 'content-type': 'application/json' } },
      get ? {} : { body: JSON.stringify(req.body || {}) }));
    const text = await r.text();
    res.status(r.status).type('application/json').send(text);
  } catch (e) { res.status(502).json({ error: 'could not reach the deployed pod (' + origin + '): ' + (e.message || e) }); }
});

// ─── browse / download the generated structure ──────────────────────────────
function walkTree(root) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((x, y) => (x.isDirectory() === y.isDirectory() ? x.name.localeCompare(y.name) : x.isDirectory() ? -1 : 1))) {
      const rp = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { out.push({ path: rp, type: 'dir' }); walk(path.join(dir, e.name), rp); }
      else { let size = 0; try { size = fs.statSync(path.join(dir, e.name)).size; } catch {} out.push({ path: rp, type: 'file', size }); }
    }
  };
  walk(root, '');
  return out;
}

function safeGenPath(id, rel) {
  const root = storage.generatedDir(id);
  if (rel.includes('..') || rel.startsWith('/')) return null;
  const full = path.join(root, rel);
  if (!full.startsWith(root + path.sep) && full !== root) return null;
  return full;
}

app.get('/api/projects/:id/files', (req, res) => {
  const p = storage.getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  res.json({ files: walkTree(storage.generatedDir(p.id)) });
});

app.get('/api/projects/:id/file', (req, res) => {
  const rel = String(req.query.path || '');
  const full = safeGenPath(req.params.id, rel);
  if (!full) return res.status(400).json({ error: 'bad path' });
  let stat;
  try { stat = fs.statSync(full); } catch { return res.status(404).json({ error: 'not found' }); }
  if (stat.isDirectory()) return res.status(400).json({ error: 'is a directory' });
  if (stat.size > 2 * 1024 * 1024) return res.json({ path: rel, tooLarge: true, size: stat.size });
  res.json({ path: rel, size: stat.size, content: fs.readFileSync(full, 'utf-8') });
});

app.get('/api/projects/:id/download', (req, res) => {
  const p = storage.getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const dir = storage.generatedDir(p.id);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'nothing generated' });
  const slug = (p.name || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="' + slug + '-docs.zip"');
  // `zip -r - .` streams a zip of the tree to stdout (zip is in the image).
  const zip = spawn('zip', ['-rq', '-', '.'], { cwd: dir });
  zip.stdout.pipe(res);
  zip.stderr.on('data', () => {});
  zip.on('error', () => { if (!res.headersSent) res.status(500).end('zip unavailable'); });
});

// Stage a deploy bundle (package copy + Dockerfile/compose/deploy.sh) in a temp
// dir and return its path. Caller cleans up.
function stageDeploy(genDir, params) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'pwdeploy-'));
  fs.cpSync(genDir, stage, { recursive: true, filter: (src) => !/(^|[\\/])(_static|_deploy|node_modules|\.git)([\\/]|$)/.test(src) });
  const f = deployBundle.files(params);
  Object.keys(f).forEach((k) => { if (k !== '_meta') fs.writeFileSync(path.join(stage, k), f[k]); });
  fs.chmodSync(path.join(stage, 'deploy.sh'), 0o755);
  makeBundleEditable(stage);
  return stage;
}

// Ship the in-page editor backend + the brain libs it needs into the bundle, and
// wire serve-docs.js to mount it — so the deployed site's hamburger Edit flow can
// Assess/Apply in the container. The bundle already carries PLAN-INTAKE.json and
// reference/ (the editor's baseline + corpus); these libs only require Node
// built-ins, so no package.json change is needed.
function makeBundleEditable(stage) {
  const libDst = path.join(stage, 'lib');
  try { fs.mkdirSync(libDst, { recursive: true }); } catch (e) {}
  for (const m of ['docs-editor', 'assess', 'linear', 'render-intake', 'reverse-engineer', 'enrich']) {
    try { fs.copyFileSync(path.join(__dirname, 'lib', m + '.js'), path.join(libDst, m + '.js')); }
    catch (e) { console.error('makeBundleEditable: could not ship lib/' + m + '.js:', e.message); }
  }
  // Ship the in-page editor client (hamburger menu, Edit wizard, Changelog) beside
  // docs-editor.js, which serves it at /_editor/client.js.
  try { fs.copyFileSync(path.join(__dirname, 'public', 'docs-editor-client.js'), path.join(libDst, 'docs-editor-client.js')); }
  catch (e) { console.error('makeBundleEditable: could not ship docs-editor-client.js:', e.message); }

  // Mount the editor BEFORE docs-server so its HTML-injection middleware wraps the
  // page responses (it appends the client <script>). Idempotent; matches both the
  // plain `(app)` form and the rewritten `(app, { linearProjectId: … })` form.
  const sd = path.join(stage, 'serve-docs.js');
  try {
    let src = fs.readFileSync(sd, 'utf-8');
    if (!/docs-editor/.test(src)) {
      // Anchor at column 0 (multiline) so we match the REAL statement, not the
      // `//   require('./lib/docs-server')(app);` example in the header comment.
      src = src.replace(/^(require\('\.\/lib\/docs-server'\)\(app[^;]*\);)/m,
        "require('./lib/docs-editor')(app);\n$1");
      fs.writeFileSync(sd, src);
    }
  } catch (e) { console.error('makeBundleEditable: could not wire serve-docs.js:', e.message); }
}

// Deploy now — push a generated package to a Docker host over SSH and bring it
// up, all from inside this container (needs the SSH password; key auth isn't
// available here). Returns the live URL + the remote build output.
app.post('/api/projects/:id/deploy', (req, res) => {
  const p = storage.getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const dir = storage.generatedDir(p.id);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'nothing generated' });
  const b = req.body || {};
  if (!b.host) return res.status(400).json({ ok: false, error: 'host is required' });
  if (!b.password) return res.status(400).json({ ok: false, error: 'SSH password is required — the wizard pushes from inside the container, so it needs the password (key auth isn’t wired here). You can still use “Download bundle” and run deploy.sh with your own key.' });

  const params = { name: b.name || p.name, host: b.host, sshUser: b.user, sshPort: b.sshPort, port: b.port, hostname: b.hostname, linearKey: b.linearKey, anthropicKey: b.apiKey, linearProjectId: b.linearProjectId || p.linearProjectId };
  const name = deployBundle.slugify(params.name);
  const user = (b.user || 'docker').trim();
  const host = String(b.host).trim();
  const sshPort = String(b.sshPort || '22').trim();
  const target = user + '@' + host;
  const meta = deployBundle.files(params)._meta;
  const sshArgs = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15', '-p', sshPort];
  const sshCmdStr = 'ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -p ' + sshPort;
  const env = Object.assign({}, process.env, { SSHPASS: String(b.password) });

  let stage;
  try { stage = stageDeploy(dir, params); }
  catch (e) { return res.status(500).json({ ok: false, error: 'stage failed: ' + String(e.message || e) }); }

  const out = [];
  const run = (cmd, args) => new Promise((resolve, reject) => {
    const ps = spawn(cmd, args, { env, cwd: stage });
    ps.stdout.on('data', (d) => out.push(d.toString()));
    ps.stderr.on('data', (d) => out.push(d.toString()));
    ps.on('error', reject);
    ps.on('close', (code) => (code === 0 ? resolve() : reject(new Error(cmd + ' exited ' + code))));
  });

  (async () => {
    try {
      await run('sshpass', ['-e', 'ssh', ...sshArgs, target, 'mkdir -p ~/apps/' + name]);
      await run('sshpass', ['-e', 'rsync', '-az', '--delete', '-e', sshCmdStr,
        '--exclude', 'node_modules', '--exclude', '.git', '--exclude', '_static', '--exclude', 'deploy.sh',
        './', target + ':apps/' + name + '/']);
      await run('sshpass', ['-e', 'ssh', ...sshArgs, target, 'cd ~/apps/' + name + ' && docker compose up -d --build']);
      // Remember where it's live so the homepage card can deep-link to the docs.
      p.deployUrl = meta.reachUrl; p.deployedAt = new Date().toISOString();
      try { storage.saveProject(p); } catch (e) {}
      res.json({ ok: true, url: meta.reachUrl, output: out.join('').slice(-6000) });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e), output: out.join('').slice(-6000) });
    } finally {
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e2) {}
    }
  })();
});

// Standalone static site — flat HTML with relative links, opens from file://.
app.get('/api/projects/:id/download-static', (req, res) => {
  const p = storage.getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const dir = storage.generatedDir(p.id);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'nothing generated' });
  let outDir;
  try { outDir = staticSite.build(dir).outDir; }
  catch (e) { return res.status(500).json({ error: 'static build failed', detail: String(e.message || e).slice(0, 300) }); }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="' + deployBundle.slugify(p.name) + '-docs-static.zip"');
  const zip = spawn('zip', ['-rq', '-', '.'], { cwd: outDir });
  zip.stdout.pipe(res); zip.stderr.on('data', () => {});
  zip.on('error', () => { if (!res.headersSent) res.status(500).end('zip unavailable'); });
});

// Docker deploy bundle — the package + Dockerfile/compose/deploy.sh prefilled
// with the target host so `bash deploy.sh` ships it over SSH.
app.get('/api/projects/:id/download-deploy', (req, res) => {
  const p = storage.getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const dir = storage.generatedDir(p.id);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'nothing generated' });
  const q = req.query || {};
  if (!q.host) return res.status(400).json({ error: 'host is required' });
  let stage;
  try { stage = stageDeploy(dir, { name: q.name || p.name, host: q.host, sshUser: q.user, sshPort: q.sshPort, port: q.port, hostname: q.hostname, linearProjectId: p.linearProjectId }); }
  catch (e) { return res.status(500).json({ error: 'bundle failed', detail: String(e.message || e).slice(0, 300) }); }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="' + deployBundle.slugify(q.name || p.name) + '-deploy.zip"');
  const zip = spawn('zip', ['-rq', '-', '.'], { cwd: stage });
  zip.stdout.pipe(res); zip.stderr.on('data', () => {});
  const cleanup = () => { try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e) {} };
  res.on('close', cleanup);
  zip.on('error', () => { if (!res.headersSent) res.status(500).end('zip unavailable'); cleanup(); });
});

// Host management links for the homepage. HOST_IP is injected by setup-host.sh
// (the wizard's compose override). When unset — e.g. running locally — the
// client falls back to parsing window.location for the nip.io IP.
app.get('/api/config', (req, res) => {
  const ip = process.env.HOST_IP || '';
  res.json({
    hostIp: ip || null,
    portainerUrl: process.env.PORTAINER_URL || (ip ? `http://portainer.${ip}.nip.io/` : null),
    proxyUrl: process.env.PROXY_URL || (ip ? `http://${ip}:8080/dashboard/` : null),
    aiServerKey: reverse.serverKeyConfigured(),   // a server-side ANTHROPIC_API_KEY is set (GUI can also supply one)
    aiModel: reverse.MODEL,
  });
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

// JSON error handler — so an oversized upload (express.raw 413) and friends come
// back as JSON the client can read, not Express's default HTML error page.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const tooBig = err && (err.type === 'entity.too.large' || err.status === 413);
  if (tooBig) return res.status(413).json({ error: 'file is too large (max ' + fmtBytes(MAX_ATTACH_BYTES) + ' per file)' });
  res.status(err.status || 500).json({ error: String((err && err.message) || 'server error') });
});

const server = app.listen(PORT, () => {
  console.log('project-wizard on http://localhost:' + PORT);
});
// Draft generation calls the Claude API and can take minutes on a large
// codebase — don't let the server time out the request mid-analysis.
server.requestTimeout = 600000;
server.headersTimeout = 620000;
