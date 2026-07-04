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
const agentApi = require('./lib/agent-api');
const agentTokens = require('./lib/agent-tokens');

const app = express();
const PORT = process.env.PORT || 4500;
const KIT = path.join(__dirname, 'lib', 'docs-kit.js');

// Remember the wizard's public origin from ANY browser request, so internally
// triggered deploys (update-apps over 127.0.0.1) bake real URLs into pods —
// not loopback ones. See publicWizardOrigin().
app.use((req, res, next) => { try { publicWizardOrigin(req); } catch (e) {} next(); });

// ── House defaults ───────────────────────────────────────────────────────────
// The org's standard stack lives in house-defaults.json inside the persistent
// data volume — NOT in the repo tree — so `scripts/update.sh` (which hard-resets
// to origin) never overwrites a customized config. On first run we seed it from
// the committed house-defaults.example.json. New projects pre-seed their
// architecture `decisions` from it, and the wizard UI reads it via /api/config.
const DATA_ROOT = path.dirname(process.env.DATA_DIR || path.join(__dirname, 'data', 'projects'));
const HOUSE_FILE = path.join(DATA_ROOT, 'house-defaults.json');
const HOUSE_EXAMPLE = path.join(__dirname, 'house-defaults.example.json');
function seedHouseDefaults() {
  try {
    if (!fs.existsSync(HOUSE_FILE) && fs.existsSync(HOUSE_EXAMPLE)) {
      fs.mkdirSync(DATA_ROOT, { recursive: true });
      fs.copyFileSync(HOUSE_EXAMPLE, HOUSE_FILE);
      console.log('[setup] seeded house defaults →', HOUSE_FILE, '(edit this file to set your org standard)');
    }
  } catch (e) { console.error('house-defaults seed failed (non-fatal):', e.message); }
}
function houseDefaults() {
  for (const f of [HOUSE_FILE, HOUSE_EXAMPLE]) {
    try { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { /* fall through */ }
  }
  return null;
}
seedHouseDefaults();

app.use(express.json({ limit: '2mb' }));

// Entra SSO gate (no-op unless AUTH_MODE=entra). Registered BEFORE static + the
// API so the whole wizard is protected; /auth/*, /healthz, /api/agent/* (own
// bearer), loopback, and the machine token are exempt. The machine token is
// baked into deployed pods so wizard↔pod callbacks keep working under the gate.
const auth = require('./lib/auth');
const gate = auth.mount(app, { secretDir: DATA_ROOT });
const MACHINE_TOKEN = auth.machineToken(DATA_ROOT);
// Header that lets a wizard→pod call pass the pod's Entra gate (and vice-versa).
const machineHeaders = (h) => Object.assign({ 'x-pw-machine': MACHINE_TOKEN }, h || {});
app.use(gate);

app.use(express.static(path.join(__dirname, 'public')));

// The wizard's own build (git short SHA, baked by scripts/update.sh) — shown in the
// GUI so you can confirm the page is running the latest version.
app.get('/api/version', (req, res) => res.json({ version: process.env.BUILD_VERSION || 'dev' }));

// ─── helpers ────────────────────────────────────────────────────────────────
const emptyAnswers = () => ({
  product: {}, integrations: {}, requirements: [], decisions: [], milestones: [], risks: [], scalability: [],
});

// The wizard's own base URL, from the incoming request — used to bake an
// "✎ Edit in wizard" deep-link into the deployed docs (the living-docs round-trip).
// The wizard's reachable origin, for URLs baked into pods (WIZARD_URL, the
// "← App" nav link, edit deep-links). Requests from a browser carry the real
// LAN origin — remember it — because internally-triggered work (update-apps →
// localhost deploy) only sees a loopback host, which is useless to a pod or a
// browser on another machine.
const WIZ_ORIGIN_FILE = path.join(DATA_ROOT, 'wizard-origin.json');
const LOOPBACK_RE = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)(:\d+)?$/i;
let wizOriginCache = null;
function publicWizardOrigin(req) {
  // Deterministic override for a proper install: set WIZARD_PUBLIC_URL (e.g.
  // https://projects.example.com) and every baked URL uses it, always.
  const forced = String(process.env.WIZARD_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (forced) return forced;
  const host = req && req.headers && req.headers.host;
  const proto = host ? String((req.headers['x-forwarded-proto'] || req.protocol || 'http')).split(',')[0].trim() : 'http';
  const seen = host ? proto + '://' + host : '';
  if (seen && !LOOPBACK_RE.test(seen)) {
    if (wizOriginCache !== seen) {
      wizOriginCache = seen;
      try { fs.mkdirSync(DATA_ROOT, { recursive: true }); fs.writeFileSync(WIZ_ORIGIN_FILE, JSON.stringify({ origin: seen }) + '\n'); } catch (e) {}
    }
    return seen;
  }
  if (!wizOriginCache) {
    try { const s = JSON.parse(fs.readFileSync(WIZ_ORIGIN_FILE, 'utf8')); if (s && s.origin) wizOriginCache = s.origin; } catch (e) {}
  }
  return wizOriginCache || seen;
}

function wizardEditUrl(req, id) {
  const origin = publicWizardOrigin(req);
  return origin ? origin + '/#/p/' + id + '/docs' : '';
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
    '4. Tracker: create milestones, one parent issue per phase, and sub-issues derived from requirements × milestones, each carrying its acceptance criteria; link them in the plan rows. End EVERY phase with a Human “Review & merge the PR” close-out gate issue (label gov:phase-07-release) carrying a ✅ Human acceptance checklist — a happy-path walk-through grounded in that phase’s build issues (real screen/field names + the milestone’s done-when criteria), at least one edge/negative case, a data-integrity/regression check, and 2–3 PR/diff spot-checks (migrations applied, tests green, no secrets/debug) — to be verified in the running app before a person merges. ⚠️ Only ever write to a tracker project DEDICATED to this app (empty, or already this app’s). If the configured Linear project/ID already holds unrelated issues, do NOT pollute it — create a new project for this app, or pause and ask the owner which project to use, before creating anything.',
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

// The generated /docs tree is a RENDER of the answers, and deploys ship the
// tree verbatim — so every intake edit must re-render it, or the next deploy
// ships stale ADR/requirement markdown that no longer matches the answers.
// Deterministic (no AI): reuses the cached enrichment + live Linear structure,
// like apply-changes. Best-effort — the edit is saved regardless.
function rerenderGenerated(p) {
  const dir = storage.generatedDir(p.id);
  if (!fs.existsSync(dir)) return false;
  const integ = (p.answers && p.answers.integrations) || {};
  try {
    renderIntake.render(dir, intakeOf(p), { docsDir: integ.docsDir || 'docs', enrich: p.lastEnrich || null, linear: p.linear || null });
    writeAux(p, dir);
    return true;
  } catch (e) { console.error('re-render after intake edit failed:', e.message); return false; }
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
  // Pre-seed the architecture decisions from the org house defaults; every value
  // stays fully editable per project in the wizard.
  const hd = houseDefaults();
  if (hd && Array.isArray(hd.decisions) && hd.decisions.length) {
    project.answers.decisions = hd.decisions.map((d) => ({
      concern: d.concern || '', choice: d.choice || '', why: d.why || '',
    }));
  }
  storage.saveProject(project);
  res.status(201).json(project);
});

app.get('/api/projects/:id', (req, res) => {
  const p = storage.getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  res.json(agentTokens.redactProject(p));   // never ship agent-token secret hashes to a client
});

app.put('/api/projects/:id', (req, res) => {
  const p = storage.getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (typeof req.body.name === 'string' && req.body.name.trim()) p.name = req.body.name.trim();
  const answersChanged = !!(req.body.answers && typeof req.body.answers === 'object');
  if (answersChanged) p.answers = req.body.answers;
  storage.saveProject(p);
  if (answersChanged) rerenderGenerated(p);
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
// In-memory build progress, keyed by project id — the long AI build (docs + one
// call per milestone + cohesion review) reports each step here so the UI can poll
// it. Cleared/overwritten on each new build.
const buildProgress = {};
app.get('/api/projects/:id/build-progress', (req, res) => {
  res.json(buildProgress[req.params.id] || { steps: [], current: null, done: true });
});
// Cooperative cancel — the agentic build checks this set between steps and aborts.
const cancelledBuilds = new Set();
app.post('/api/projects/:id/build-cancel', (req, res) => {
  cancelledBuilds.add(req.params.id);
  const pr = buildProgress[req.params.id];
  if (pr && !pr.done) { pr.current = 'Cancelling… (stopping after the current step)'; pr.agentRunning = false; }
  res.json({ ok: true });
});

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

  // One build at a time per project — a second start would run a parallel
  // duplicate (double AI spend, racing writes into the same generated tree)
  // and orphan the first run's progress view. The UI resumes the running
  // build's progress on 409 instead.
  const inFlight = buildProgress[p.id];
  if (inFlight && !inFlight.done) {
    return res.status(409).json({ error: 'a build is already running for this project', running: true });
  }

  // Progress sink — the AI emits structured phase events; the UI polls /build-progress
  // and renders the current phase, a live "agent running" indicator, per-phase token
  // counts, and running totals.
  const prog = buildProgress[p.id] = { phase: 'Starting…', current: 'Starting…', agentRunning: false, steps: [], totals: { fresh: 0, cached: 0, output: 0 }, liveTokens: null, done: false, startedAt: Date.now() };
  const onProgress = (ev) => {
    if (typeof ev === 'string') ev = { t: 'start', label: ev };
    if (ev.t === 'activity') { prog.current = ev.detail || prog.phase; prog.agentRunning = true; if (ev.tokens) prog.liveTokens = ev.tokens; }
    else if (ev.t === 'done') {
      if (ev.tokens) { prog.totals.fresh += ev.tokens.fresh || 0; prog.totals.cached += ev.tokens.cached || 0; prog.totals.output += ev.tokens.output || 0; }
      prog.steps.push({ label: ev.label, tokens: ev.tokens || null, note: ev.note || '' });
      prog.current = ev.label + ' ✓' + (ev.note ? ' — ' + ev.note : ''); prog.agentRunning = false; prog.liveTokens = null;
    } else { prog.phase = ev.label; prog.current = ev.label; prog.agentRunning = !!ev.agent; prog.liveTokens = null; }
  };
  cancelledBuilds.delete(p.id);   // clear any stale cancel from a prior run
  const checkCancel = () => cancelledBuilds.has(p.id);

  // 1. AI enrichment → produce the governance plan + rich doc content (Mermaid,
  //    Given/When/Then, ADR bodies). Optional: skipped when no key is available
  //    (docs stay as clean tables), so the Linear step below can still run.
  const apiKey = (b.apiKey && String(b.apiKey).trim()) || '';
  // Fast path: re-render from the CACHED enrichment (no AI call) — for template /
  // design changes that must NOT alter the AI-generated content the user accepted.
  const cachedEnrichPath = path.join(dir, '.deploy', 'enrich.json');
  if (b.reuseEnrich && fs.existsSync(cachedEnrichPath)) {
    try { enrich = JSON.parse(fs.readFileSync(cachedEnrichPath, 'utf-8')); plan = enrich.plan || null; out.reusedEnrich = true; out.enriched = true; }
    catch (e) { enrich = null; }
  }
  if (!enrich && (apiKey || enrichLib.aiEnabled())) {
    try {
      // AGENTIC enrichment: the model EXPLORES the upload on demand (list/read/search)
      // instead of prefilling the whole codebase — ~100× cheaper + grounds each issue
      // in code it actually read. buildFileIndex exposes the files; cleanup() after.
      let index = null;
      try { index = reverse.buildFileIndex(storage.attachmentsDir(p.id)); } catch (e) {}
      try {
        enrich = await enrichLib.enrich(intake, apiKey, index, onProgress, checkCancel);
        // Plan: a continuous agentic session, one milestone at a time (reads + prior
        // issues accumulate), compacting only near the context limit, then a cohesion
        // review. pr.usage carries per-call token counts; pr.review what it added/removed.
        try {
          const pr = await enrichLib.enrichPlan(intake, apiKey, index, onProgress, checkCancel);
          plan = pr.plan;
          out.planTokens = pr.usage;
          out.cohesion = pr.review;
        }
        catch (e) { if (e && e.cancelled) throw e; out.planError = 'plan enrichment failed: ' + (e.message || e); plan = null; }
      } finally { if (index && index.cleanup) { try { index.cleanup(); } catch (e) {} } }
      if (plan && plan.length) enrich.plan = plan;   // cache alongside the docs enrichment
      out.enriched = true;
      out.counts = { requirements: (intake.requirements || []).length, decisions: (intake.decisions || []).length, milestones: (intake.milestones || []).length };
    } catch (e) {
      cancelledBuilds.delete(p.id);
      if (e && (e.cancelled || checkCancel())) { prog.current = 'Cancelled — nothing was written'; prog.done = true; prog.cancelled = true; return res.json({ ok: false, cancelled: true }); }
      prog.done = true; prog.error = e.message || 'unknown error';
      return res.status(e.status || 500).json({ error: 'AI build failed: ' + (e.message || 'unknown error') });
    }
  }
  // Aborted right after the AI, before any Linear/render write? Bail cleanly.
  if (checkCancel()) { cancelledBuilds.delete(p.id); prog.current = 'Cancelled — nothing was written'; prog.done = true; prog.cancelled = true; return res.json({ ok: false, cancelled: true }); }

  // 2. Optional Linear tracker. Runs BEFORE the render so the Plan page can mirror
  //    the live tracker (milestone roll-up + per-issue overview + live status).
  //    Re-running the build must NEVER wipe or duplicate a live tracker: when
  //    this project is already linked to a Linear project that has issues, it is
  //    re-linked READ-ONLY (issues change only via per-issue change requests).
  //    A tracker is created only from a blank slate — no linked project, or a
  //    linked one with ZERO issues — and only when a team was chosen.
  // Resolve the Linear key without re-entry: request body → per-project
  // connection overrides → the deployed pod's Integrations tab → wizard env.
  let linearKey = (b.linearKey && String(b.linearKey).trim()) || '';
  if (!linearKey) {
    let podKeys = null;
    if (p.deployUrl) {
      try {
        const origin = String(p.deployUrl).replace(/\/docs\/?$/, '');
        const rr = await fetch(origin + '/api/integrations/keys.json', { headers: machineHeaders(), signal: AbortSignal.timeout(6000) });
        if (rr.ok) podKeys = await rr.json();
      } catch (e) { /* pod unreachable — overrides/env still apply */ }
    }
    try { linearKey = String(agentTokens.resolveConnections(p, process.env, podKeys).linearKey || '').trim(); } catch (e) {}
  }
  const existingProjectId = (b.linearProjectId && String(b.linearProjectId).trim()) || (p.linearProjectId && String(p.linearProjectId).trim()) || '';
  let linearSettled = false;
  if (!linearKey && existingProjectId) out.linearError = 'Linear: no key available — enter one in the dialog or on the pod’s Integrations tab.';
  if (linearKey && existingProjectId) {
    try {
      onProgress('Checking the linked Linear tracker');
      const probe = await linear.loadProjectStructure(linearKey, existingProjectId);  // read-only
      const total = (probe.counts && (probe.counts.totalIssues != null ? probe.counts.totalIssues : probe.counts.issues)) || 0;
      if (total > 0) {
        lr = probe; out.linear = lr; out.linearMode = 'existing';
        p.linear = lr;
        p.linearUrl = lr.url;
        p.linearProjectId = lr.projectId;
        linearSettled = true;                       // live tracker — never create
      }
      // zero issues → blank slate; fall through to creation if a team was chosen
    } catch (e) {
      out.linearError = 'Linear (pull existing): ' + (e.message || 'failed');
      // Only a definite "project not found" clears the way to create a fresh
      // tracker; any other failure (auth, network) must not risk a duplicate.
      if (!e || e.status !== 404) linearSettled = true;
    }
  }
  if (linearKey && !linearSettled && b.teamId) {
    try {
      onProgress('Creating Linear project + issues');
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
      onProgress('Rendering docs');
      renderIntake.render(dir, intake, { docsDir, enrich, linear: lr || p.linear || null, wizardEditUrl: wizardEditUrl(req, p.id) });
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
  cancelledBuilds.delete(p.id);
  prog.current = 'Done'; prog.done = true; prog.finishedAt = Date.now();
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
  const beforeMilestones = JSON.parse(JSON.stringify((p.answers && p.answers.milestones) || []));
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

  // 1b. Milestone edits propagate to the tracker: renaming a milestone row
  //     renames the Linear project milestone and its "Phase X — …" parent
  //     issues, so tracker names never drift from the docs.
  {
    const lk = (b.linearKey && String(b.linearKey).trim()) || '';
    if (lk && p.linearProjectId && applied.docSections.indexOf('milestones') !== -1) {
      try {
        const ms = await linear.syncMilestoneEdits(lk, p.linearProjectId, beforeMilestones, (p.answers.milestones || []), (p.answers.startDate || ''));
        ms.renamed.forEach((r) => applied.linear.push({ action: 'rename-milestone', title: r.from + ' → ' + r.to }));
        ms.skipped.forEach((s) => errors.push('milestone "' + s + '": no matching Linear milestone to rename'));
      } catch (e) { errors.push('milestone sync: ' + e.message); }
    }
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
      { method: get ? 'GET' : 'POST', headers: machineHeaders({ 'content-type': 'application/json' }) },
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
  // governance-gate is required by linear.js + enrich.js — omitting it made pods
  // crash on boot with MODULE_NOT_FOUND once that dependency was introduced.
  for (const m of ['docs-editor', 'assess', 'linear', 'render-intake', 'reverse-engineer', 'enrich', 'governance-gate', 'auth']) {
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
  // Also mount the Entra gate (no-op unless the pod's AUTH_MODE=entra) FIRST, so
  // it protects the editor + docs routes; the pod's .deploy dir holds its session
  // secret + machine token.
  const sd = path.join(stage, 'serve-docs.js');
  try {
    let src = fs.readFileSync(sd, 'utf-8');
    if (!/docs-editor/.test(src)) {
      // Anchor at column 0 (multiline) so we match the REAL statement, not the
      // `//   require('./lib/docs-server')(app);` example in the header comment.
      src = src.replace(/^(require\('\.\/lib\/docs-server'\)\(app[^;]*\);)/m,
        "app.use(require('./lib/auth').mount(app, { secretDir: __dirname + '/.deploy' }));\n" +
        "require('./lib/docs-editor')(app);\n$1");
      fs.writeFileSync(sd, src);
    }
  } catch (e) { console.error('makeBundleEditable: could not wire serve-docs.js:', e.message); }
}

// Deploy now — push a generated package to a Docker host over SSH and bring it
// up, all from inside this container (needs the SSH password; key auth isn't
// available here). Returns the live URL + the remote build output.
const deploysInFlight = new Set();
app.post('/api/projects/:id/deploy', (req, res) => {
  const p = storage.getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  // One deploy per project — concurrent rsync + compose runs against the same
  // pod race each other and can leave it half-updated.
  if (deploysInFlight.has(p.id)) return res.status(409).json({ ok: false, error: 'a deploy is already running for this project — wait for it to finish', running: true });
  const dir = storage.generatedDir(p.id);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'nothing generated' });
  const b = req.body || {};
  if (!b.host) return res.status(400).json({ ok: false, error: 'host is required' });
  // Two auth modes: a password (sshpass) OR SSH key. No password → key auth, which
  // uses the host's ~/.ssh mounted into this container (the key must be authorized
  // on the target). On a key-only server, leave the password blank.
  const usePassword = !!(b.password && String(b.password).trim());

  const wizardUrl = publicWizardOrigin(req);
  // Pods inherit the wizard's Entra config (one Azure app per org; each pod +
  // the wizard is a registered redirect URI) so the whole install is gated with
  // no extra secrets to enter. The pod's redirect origin (AUTH_PUBLIC_URL) is
  // derived from its own routed hostname by deploy-bundle unless overridden.
  const entra = {
    mode: process.env.AUTH_MODE || '',
    tenant: process.env.ENTRA_TENANT_ID || '',
    clientId: process.env.ENTRA_CLIENT_ID || '',
    clientSecret: process.env.ENTRA_CLIENT_SECRET || '',
    allowed: process.env.ENTRA_ALLOWED || '',
    publicUrl: (b.authPublicUrl && String(b.authPublicUrl).trim()) || '',
  };
  const params = { name: b.name || p.name, host: b.host, sshUser: b.user, sshPort: b.sshPort, port: b.port, hostname: b.hostname, linearKey: b.linearKey, anthropicKey: b.apiKey, linearProjectId: b.linearProjectId || p.linearProjectId, wizardUrl: wizardUrl, wizardProjectId: p.id, buildVersion: (process.env.BUILD_VERSION || 'dev'), machineToken: MACHINE_TOKEN, entra: entra };
  const name = deployBundle.slugify(params.name);
  const user = (b.user || 'docker').trim();
  const host = String(b.host).trim();
  const sshPort = String(b.sshPort || '22').trim();
  const target = user + '@' + host;
  const meta = deployBundle.files(params)._meta;
  const sshArgs = ['-F', '/dev/null', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=15', '-p', sshPort];
  const sshCmdStr = 'ssh -F /dev/null -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -p ' + sshPort;
  const env = usePassword ? Object.assign({}, process.env, { SSHPASS: String(b.password) }) : process.env;

  // Freshen the wizard's tree with the CURRENT engine before staging, so even a
  // pod that misses its post-deploy rerender never serves ancient page layouts.
  try { rerenderGenerated(p); } catch (e) { /* stage what exists */ }
  let stage;
  try { stage = stageDeploy(dir, params); }
  catch (e) { return res.status(500).json({ ok: false, error: 'stage failed: ' + String(e.message || e) }); }
  deploysInFlight.add(p.id);
  // The bundle must carry the enrichment cache — the pod's re-renders need it,
  // or every AI-enriched section (architecture diagram, request flows, ACs)
  // silently degrades to the deterministic fallback.
  try {
    const se = path.join(stage, '.deploy', 'enrich.json');
    if (!fs.existsSync(se) && p.lastEnrich) { fs.mkdirSync(path.dirname(se), { recursive: true }); fs.writeFileSync(se, JSON.stringify(p.lastEnrich)); }
  } catch (e) { /* best-effort */ }

  const out = [];
  const run = (cmd, args) => new Promise((resolve, reject) => {
    const ps = spawn(cmd, args, { env, cwd: stage });
    ps.stdout.on('data', (d) => out.push(d.toString()));
    ps.stderr.on('data', (d) => out.push(d.toString()));
    ps.on('error', reject);
    ps.on('close', (code) => (code === 0 ? resolve() : reject(new Error(cmd + ' exited ' + code))));
  });
  // Run ssh/rsync with a password (sshpass) or, in key mode, directly (uses the
  // mounted ~/.ssh key).
  const runRemote = (program, args) => usePassword ? run('sshpass', ['-e', program, ...args]) : run(program, args);

  (async () => {
    try {
      await runRemote('ssh', [...sshArgs, target, 'mkdir -p ~/apps/' + name]);
      // Is this an UPDATE of an existing pod (vs a first deploy)? If so, preserve
      // its content — the intake it's been edited to AND the AI enrichment it
      // accepted — not just keys + changelog, then re-render in place so the new
      // templates apply to ITS content rather than the wizard's.
      let existing = false;
      try { await runRemote('ssh', [...sshArgs, target, 'test -f ~/apps/' + name + '/PLAN-INTAKE.json']); existing = true; } catch (e) {}
      // Preserve the pod's enrichment cache only if it actually HAS one — a pod
      // missing enrich.json (older deploys never shipped it) must receive the
      // wizard's copy, or its re-renders lose the architecture diagram + flows.
      let podHasEnrich = false;
      if (existing) { try { await runRemote('ssh', [...sshArgs, target, 'test -s ~/apps/' + name + '/.deploy/enrich.json']); podHasEnrich = true; } catch (e) {} }
      const preserve = existing ? ['--exclude', 'PLAN-INTAKE.json', ...(podHasEnrich ? ['--exclude', '.deploy/enrich.json'] : [])] : [];
      await runRemote('rsync', ['-az', '--delete', '-e', sshCmdStr,
        '--exclude', 'node_modules', '--exclude', '.git', '--exclude', '_static', '--exclude', 'deploy.sh',
        // Always preserve host-side runtime state across redeploys: the integration
        // creds (Integrations tab) and the change log. On an update, also preserve
        // the pod's own intake + accepted enrichment (above).
        '--exclude', '.deploy/keys.json', '--exclude', '.deploy/changes.json',
        ...preserve,
        './', target + ':apps/' + name + '/']);
      // Run the container as the deploying (SSH) user, not root, so files it writes
      // into the bind-mounted app dir stay owned by that user — otherwise the next
      // deploy's rsync can't overwrite them (Permission denied / rsync exit 23).
      // --force-recreate: the code lives in a bind mount, so a same-image rebuild
      // would NOT restart the container — leaving node running the previous
      // in-memory modules (stale docs/version) even though the files on disk are
      // fresh. Force the restart so the new code is actually loaded.
      await runRemote('ssh', [...sshArgs, target, 'cd ~/apps/' + name + ' && PUID=$(id -u) PGID=$(id -g) docker compose up -d --build --force-recreate']);
      // Re-render the pod's docs from its own intake with the just-shipped
      // engine — ALWAYS, not only on updates: a fresh pod otherwise serves the
      // wizard's staged tree verbatim, which may predate engine changes (stale
      // Gantt/layout pages). Fresh containers npm-install on first boot, so
      // poll patiently and REPORT if it never lands instead of failing silent.
      {
        const origin = meta.reachUrl.replace(/\/docs\/?$/, '');
        let rerendered = false;
        for (let i = 0; i < 40 && !rerendered; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          try { const rr = await fetch(origin + '/api/rerender', { method: 'POST', headers: machineHeaders() }); if (rr.ok) { rerendered = true; out.push('\n→ re-rendered pod docs from its own intake\n'); } } catch (e) {}
        }
        if (!rerendered) out.push('\n⚠ pod did not answer /api/rerender within 2 min — its pages may be stale; open the docs and use ☰ → Sync from Linear\n');
      }
      // If this project was previously deployed under a DIFFERENT app-name slug
      // (e.g. the deploy dialog's App name changed, or was blank one time and set
      // another), the old container/folder is now orphaned AND may still claim
      // this hostname in Traefik — silently serving stale docs. Warn loudly with
      // the exact cleanup command instead of leaving a duplicate route.
      const prevName = p.deployTarget && p.deployTarget.name;
      if (prevName && prevName !== name) {
        out.push('\n⚠ This project was previously deployed as "' + prevName + '"; it is now "' + name +
          '". The old pod may still be running and claiming the same hostname (serving stale docs). Retire it on the host:\n' +
          '    cd ~/apps/' + prevName + ' && docker compose down\n');
      }
      // Remember where it's live so the homepage card can deep-link to the docs,
      // and record the SSH deploy target (no password) so the agent API can report
      // "how to reach the Docker host" and redeploy without re-entering it.
      p.deployUrl = meta.reachUrl; p.deployedAt = new Date().toISOString();
      p.deployTarget = { host: host, user: user, sshPort: sshPort, hostname: (b.hostname || '').trim(), name: name };
      try { storage.saveProject(p); } catch (e) {}
      res.json({ ok: true, url: meta.reachUrl, output: out.join('').slice(-6000) });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e), output: out.join('').slice(-6000) });
    } finally {
      deploysInFlight.delete(p.id);
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
    houseDefaults: houseDefaults(),   // org standard stack; seeds new-project decisions + wizard hints
  });
});

// ─── one-button update: wizard + every deployed app → latest main ────────────
// Redeploy each deployed project to the current engine (data-preserving). Reuses
// the deploy route with each project's stored target + resolved creds. Called by
// scripts/update-all.sh after the wizard itself has rebuilt.
app.post('/api/update-apps', async (req, res) => {
  const deployed = storage.listProjects().filter((p) => p.deployUrl || (p.deployTarget && p.deployTarget.host));
  const results = [];
  for (const s of deployed) {
    const p = storage.getProject(s.id); if (!p) continue;
    const c = agentTokens.resolveConnections(p, process.env);
    const dt = p.deployTarget || {};
    const body = {
      name: dt.name || p.name,
      host: dt.host || c.sshHost, user: dt.user || c.sshUser, sshPort: dt.sshPort || c.sshPort,
      password: (req.headers && req.headers['x-deploy-password']) || (req.body && req.body.password) || c.sshPassword || '',
      hostname: dt.hostname || c.hostname,
      apiKey: c.anthropicKey, linearKey: c.linearKey, linearProjectId: c.linearProjectId,
    };
    if (!body.host) { results.push({ id: p.id, name: p.name, ok: false, error: 'no known deploy host' }); continue; }
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/api/projects/' + p.id + '/deploy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      results.push({ id: p.id, name: p.name, ok: r.ok && j.ok !== false, url: j.url || null, error: j.error || null });
    } catch (e) { results.push({ id: p.id, name: p.name, ok: false, error: String(e.message || e) }); }
  }
  res.json({ ok: true, count: results.length, results });
});

// Host SSH creds for self-update live in the persistent data volume (so they
// survive the wizard rebuilding itself) — set once, then the Update button just
// works. Falls back to the DEPLOY_SSH_* env if nothing is stored.
const HOST_CREDS_FILE = path.join(DATA_ROOT, 'self-update-creds.json');
function readHostCreds() { try { return JSON.parse(fs.readFileSync(HOST_CREDS_FILE, 'utf8')) || {}; } catch { return {}; } }
function writeHostCreds(obj) { try { fs.mkdirSync(DATA_ROOT, { recursive: true }); fs.writeFileSync(HOST_CREDS_FILE, JSON.stringify(obj, null, 2)); return true; } catch (e) { return false; } }
function resolveHostCreds(body) {
  const s = readHostCreds();
  const user = String((body && body.user) || s.user || process.env.DEPLOY_SSH_USER || 'docker').trim();
  const password = String((body && body.password) || s.password || process.env.DEPLOY_SSH_PASSWORD || '');
  return {
    user, password, hasPassword: !!password.trim(),
    userSource: (body && body.user) ? 'request' : s.user ? 'stored' : process.env.DEPLOY_SSH_USER ? 'env' : 'default',
    passSource: (body && body.password) ? 'request' : s.password ? 'stored' : process.env.DEPLOY_SSH_PASSWORD ? 'env' : null,
    stored: !!(s.user || s.password),
  };
}

// Report the current self-update creds STATUS (never the password value).
app.get('/api/self-update/creds', (req, res) => {
  const c = resolveHostCreds(null);
  res.json({ hostIp: process.env.HOST_IP || null, user: c.user, hasPassword: c.hasPassword, userSource: c.userSource, passSource: c.passSource, stored: c.stored });
});
// Save host creds (persisted). Empty password clears the stored one (→ key auth).
app.post('/api/self-update/creds', (req, res) => {
  const b = req.body || {};
  const s = readHostCreds();
  if (typeof b.user === 'string') { const u = b.user.trim(); if (u) s.user = u; else delete s.user; }
  if (typeof b.password === 'string') { if (b.password === '') delete s.password; else s.password = b.password; }
  if (!writeHostCreds(s)) return res.status(500).json({ error: 'could not save credentials to the data volume' });
  const c = resolveHostCreds(null);
  res.json({ ok: true, user: c.user, hasPassword: c.hasPassword, stored: c.stored });
});

// Trigger a full self-update: SSH to this wizard's OWN host and launch the
// detached scripts/update-all.sh (rebuild wizard → wait → redeploy apps).
// Returns as soon as it's kicked off — the wizard restarts itself mid-run, so we
// can't await it. Creds come from the stored file / env (see resolveHostCreds);
// the request body may override them for a one-off run.
let selfUpdateStartedAt = 0;   // in-memory is enough — the container restarts mid-update anyway
app.post('/api/self-update', (req, res) => {
  // One update at a time: a double-click would launch two detached update-all
  // runs doing git reset + compose rebuild simultaneously on the host.
  if (selfUpdateStartedAt && Date.now() - selfUpdateStartedAt < 15 * 60 * 1000) {
    return res.status(409).json({ error: 'an update is already running (started ' + Math.round((Date.now() - selfUpdateStartedAt) / 60000) + ' min ago) — the wizard will restart when it lands', running: true });
  }
  const hostIp = (process.env.HOST_IP || '').trim();
  if (!hostIp) return res.status(400).json({ error: 'HOST_IP is not set on this wizard, so it can’t locate its own host to update. Set HOST_IP in the compose env, or update from the host with scripts/update.sh.', code: 'no_host_ip' });
  const sshPort = (process.env.DEPLOY_SSH_PORT || '22').trim();
  const appDir = (process.env.WIZARD_APP_DIR || '~/apps/project-wizard').trim();
  const creds = resolveHostCreds(req.body);
  const user = creds.user, password = creds.password, usePassword = creds.hasPassword;
  const target = user + '@' + hostIp;
  // BatchMode=yes on the key path so a bad key fails fast instead of hanging on a
  // password prompt (there's no tty); password path leaves it off so sshpass works.
  // -F /dev/null: ignore any ~/.ssh/config (the host's is bind-mounted read-only and
  // not root-owned, which SSH rejects as "Bad owner or permissions").
  const sshOpts = ['-F', '/dev/null', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=15', '-o', 'BatchMode=' + (usePassword ? 'no' : 'yes'), '-p', sshPort];
  const env = usePassword ? Object.assign({}, process.env, { SSHPASS: password }) : process.env;
  const program = usePassword ? 'sshpass' : 'ssh';
  const withAuth = (cmd) => usePassword ? ['-e', 'ssh', ...sshOpts, target, cmd] : [...sshOpts, target, cmd];
  const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"; // single-quote for the remote shell

  // 1. Fast, non-destructive auth check — so a wrong user/password/key comes back
  //    as a clean error, not a 502 later.
  execFile(program, withAuth('echo pw-ssh-ok'), { env, timeout: 20000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
    if (err || !String(stdout).includes('pw-ssh-ok')) {
      return res.status(502).json({
        error: 'could not SSH to the host (' + target + '): ' + String(stderr || (err && err.message) || 'no response').slice(0, 300),
        code: 'ssh_failed',
        hint: 'Check the Host SSH login/password (Edit creds). Authorize the wizard’s mounted key to skip the password.',
      });
    }
    // 2. Auth works — answer the browser NOW, before the wizard rebuilds itself.
    selfUpdateStartedAt = Date.now();
    res.json({ ok: true, started: true, target, message: 'Update started on ' + target + '. The wizard will rebuild (brief downtime) then redeploy your apps.' });
    // 3. Launch the detached updater; fire-and-forget. Pass the host password to
    //    update-all.sh via an env var (not a logged arg) so app redeploys on the
    //    same host reuse it.
    const passEnv = usePassword ? ('PW_APP_SSH_PASSWORD=' + shq(password) + ' ') : '';
    const launch = 'cd ' + appDir + ' && ' + passEnv + 'setsid nohup bash scripts/update-all.sh main </dev/null >/tmp/pw-update-all.boot 2>&1 & echo launched';
    execFile(program, withAuth(launch), { env, timeout: 20000, maxBuffer: 1 << 20 }, () => { /* fire-and-forget */ });
  });
});

// ─── agent API: token-authed read/edit access for another Claude session ─────
// Mounts the UI-side token mint/list/revoke routes and the token-authed
// /api/agent/* surface. See lib/agent-api.js + AGENT-API.md.
agentApi.mount(app, {
  storage, intakeOf, summarize, emptyAnswers, walkTree, safeGenPath, PORT, rerenderGenerated, dataRoot: DATA_ROOT,
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
