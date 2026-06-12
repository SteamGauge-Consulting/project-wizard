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
const { spawn, execFile } = require('child_process');
const storage = require('./lib/storage');
const staticSite = require('./lib/static-site');
const deployBundle = require('./lib/deploy-bundle');

const app = express();
const PORT = process.env.PORT || 4500;
const KIT = path.join(__dirname, 'lib', 'docs-kit.js');

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── helpers ────────────────────────────────────────────────────────────────
const emptyAnswers = () => ({
  product: {}, integrations: {}, requirements: [], decisions: [], milestones: [], risks: [], scalability: [],
});

function summarize(p) {
  return {
    id: p.id, name: p.name, status: p.status,
    createdAt: p.createdAt, updatedAt: p.updatedAt, generatedAt: p.generatedAt || null,
    oneliner: (p.answers && p.answers.product && p.answers.product.oneliner) || '',
    docsDir: (p.answers && p.answers.integrations && p.answers.integrations.docsDir) || 'docs',
    fileCount: p.manifest ? p.manifest.fileCount : 0,
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
    product: a.product || {}, integrations: a.integrations || {},
    requirements: cleanRows(a.requirements, ['title', 'test']),
    decisions: cleanRows(a.decisions, ['concern', 'choice', 'why']),
    milestones: cleanRows(a.milestones, ['name', 'done', 'target']),
    risks: cleanRows(a.risks, ['risk', 'mitigation']),
    scalability: cleanRows(a.scalability, ['area', 'target', 'adr']),
  };
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
    '',
    '--- PLAN-INTAKE.json ---',
    JSON.stringify(intakeOf(p), null, 2),
  ].join('\n');
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
    // Drop the project's own intake + handoff into the generated tree.
    try {
      fs.writeFileSync(path.join(dir, 'PLAN-INTAKE.json'), JSON.stringify(intakeOf(p), null, 2) + '\n');
      fs.writeFileSync(path.join(dir, 'AI-HANDOFF.md'), handoffOf(p) + '\n');
    } catch (e) { /* non-fatal */ }

    const files = walkTree(dir);
    p.status = 'generated';
    p.generatedAt = new Date().toISOString();
    p.manifest = { fileCount: files.length, docsDir: integ.docsDir || 'docs' };
    storage.saveProject(p);
    res.json({ ok: true, project: summarize(p), fileCount: files.length });
  });
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
  return stage;
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

  const params = { name: b.name || p.name, host: b.host, sshUser: b.user, sshPort: b.sshPort, port: b.port, hostname: b.hostname };
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
  try { stage = stageDeploy(dir, { name: q.name || p.name, host: q.host, sshUser: q.user, sshPort: q.sshPort, port: q.port, hostname: q.hostname }); }
  catch (e) { return res.status(500).json({ error: 'bundle failed', detail: String(e.message || e).slice(0, 300) }); }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="' + deployBundle.slugify(q.name || p.name) + '-deploy.zip"');
  const zip = spawn('zip', ['-rq', '-', '.'], { cwd: stage });
  zip.stdout.pipe(res); zip.stderr.on('data', () => {});
  const cleanup = () => { try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e) {} };
  res.on('close', cleanup);
  zip.on('error', () => { if (!res.headersSent) res.status(500).end('zip unavailable'); cleanup(); });
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log('project-wizard on http://localhost:' + PORT);
});
