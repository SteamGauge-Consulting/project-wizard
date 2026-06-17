// ============================================================================
//  reverse-engineer.js — turn an uploaded codebase into a draft PLAN intake.
//
//  Two modes, chosen by whether an ANTHROPIC_API_KEY is configured:
//   • auto    — read the uploaded code, call Claude (structured output) to draft
//               a full intake the owner reviews in the wizard.
//   • handoff — no key: emit a reverse-engineering prompt the owner runs in a
//               Claude Code session against their code, producing a
//               PLAN-INTAKE.json they then import.
//
//  Dependency-light: the Claude call is a raw fetch to /v1/messages (no SDK).
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.WIZARD_MODEL || 'claude-opus-4-8';
// Quality-over-cost: fill the 1M input window. Include EVERY reference upload (code
// AND docs/PDFs/etc.), not just code, and don't truncate to a tiny budget. Both are
// env-overridable. ~2.4M chars ≈ 600K tokens of corpus, leaving room for the intake,
// governance library, prior issues, and the output budget inside the 1M window.
const MAX_CORPUS_CHARS = Number(process.env.WIZARD_CORPUS_CHARS || 2400 * 1024);
const PER_FILE_BYTES = Number(process.env.WIZARD_PER_FILE_BYTES || 512 * 1024);
const DATA_SAMPLE_BYTES = Number(process.env.WIZARD_DATA_SAMPLE_BYTES || 32 * 1024);   // head sample of raw data dumps

const TEXT_EXT = new Set(['js','mjs','cjs','jsx','ts','tsx','py','rb','go','rs','java','kt','c','h','cpp','hpp','cs','php','swift','sql','sh','bash','json','yaml','yml','toml','xml','html','htm','css','scss','sass','less','md','markdown','txt','rst','ini','cfg','conf','vue','svelte','astro','prisma','graphql','gql','tf','gradle','properties','csv','tsv','rkt','ex','exs','lua','r','dart','scala','clj']);
const TEXT_NAME = new Set(['dockerfile','makefile','.gitignore','.dockerignore','.env.example','procfile','readme','license']);
const SKIP_DIR = new Set(['node_modules','.git','dist','build','.next','.nuxt','out','vendor','venv','.venv','env','__pycache__','.cache','coverage','.svelte-kit','target','.idea','.vscode','.terraform','tmp','.turbo','.manus','__MACOSX']);
const SKIP_FILE = /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|composer\.lock|\.min\.(js|css)$|\.map$|\.lock$|(^|\/)components\/ui\/[^/]+$)/i;

function isTextual(name) {
  const base = name.toLowerCase();
  if (TEXT_NAME.has(base)) return true;
  const m = /\.([a-z0-9]+)$/.exec(base);
  return m ? TEXT_EXT.has(m[1]) : false;
}

// Extract text from common BINARY reference uploads so docs/specs join the corpus
// too — not just code. pdftotext (poppler) for PDFs; docx is a zip of XML, so unzip
// its document part and strip tags. Both degrade gracefully if the tool is absent.
function extractPdf(fp) {
  try { return execFileSync('pdftotext', ['-q', '-enc', 'UTF-8', fp, '-'], { maxBuffer: 64 * 1024 * 1024 }).toString(); }
  catch { return ''; }
}
function extractDocx(fp) {
  try {
    const xml = execFileSync('unzip', ['-p', fp, 'word/document.xml'], { maxBuffer: 64 * 1024 * 1024 }).toString();
    return xml.replace(/<\/w:p>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&[a-z]+;/gi, ' ').replace(/\n{3,}/g, '\n\n').trim();
  } catch { return ''; }
}

// Return the text content for a file — code/text directly, PDFs/Word via extraction,
// Migration artifacts (drizzle/meta snapshots, numbered migration SQL, journals) are
// redundant with schema.ts and pure noise — excluded outright.
function isMigrationArtifact(rel) {
  const r = rel.toLowerCase();
  return /(\/meta\/.*\.json$|_journal\.json$|_snapshot\.json$)/.test(r) ||
         /(^|\/)(migrations?|drizzle)\/\d{3,}_[a-z0-9_]*\.(sql|json)$/.test(r);
}

// A raw DATA file (dump/seed/export), not code. We don't exclude these — the data
// SHAPE informs planning — but we SAMPLE them (head only) so the structure + example
// rows + scale come through without the full multi-thousand-row volume.
function isDataDump(rel, name, size) {
  const n = name.toLowerCase();
  const r = rel.toLowerCase();
  if (/\.(csv|tsv)$/.test(n)) return true;
  if (/\.sql$/.test(n)) return !/(^|\/)(schema|structure)\b/.test(r);
  if (/\.json$/.test(n)) {
    if (/(^|\/)(package|tsconfig|jsconfig|composer|components|theme|manifest|swagger|openapi|app|vercel|nest-cli|angular)\.?[a-z-]*\.json$/.test(n) || /\.config\.json$/.test(n)) return false;
    if (/(^|\/)(import|seed|dump|backup|leads|forecast|export|fixture|sample|data)/.test(r)) return true;
    return size > 40 * 1024;
  }
  return false;
}

// Read just the first `bytes` of a file (so a huge data dump never loads in full).
function readHead(fp, bytes) {
  try {
    const fd = fs.openSync(fp, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    fs.closeSync(fd);
    return buf.slice(0, n).toString('utf-8');
  } catch { return ''; }
}

// other binaries empty. Capped per file so one huge upload can't eat the whole budget.
function readContent(fp, name, size, rel) {
  rel = rel || name;
  if (isMigrationArtifact(rel)) return '';   // redundant with the schema — excluded
  if (isDataDump(rel, name, size) && /\.(sql|csv|tsv|json)$/.test(name.toLowerCase())) {
    // SAMPLE the data — structure + example rows inform the plan; the rest is volume.
    if (size <= DATA_SAMPLE_BYTES) return readHead(fp, DATA_SAMPLE_BYTES);
    const head = readHead(fp, DATA_SAMPLE_BYTES);
    return head ? head + '\n…[SAMPLE — ' + Math.round(size / 1024) + 'KB data file; the structure + example rows above inform the plan, the rest is repetitive volume]' : '';
  }
  const ext = (/\.([a-z0-9]+)$/.exec(name.toLowerCase()) || [])[1] || '';
  let c = '';
  try {
    if (ext === 'pdf') c = extractPdf(fp);
    else if (ext === 'docx') c = extractDocx(fp);
    else if (isTextual(name) && size <= PER_FILE_BYTES * 6) c = fs.readFileSync(fp, 'utf-8');
  } catch { c = ''; }
  if (c.length > PER_FILE_BYTES) c = c.slice(0, PER_FILE_BYTES) + '\n…[file truncated]';
  return c;
}

// Importance heuristic — when the corpus is bigger than the window, this ranking
// decides what survives (the fitter keeps the top of the list, trims the bottom). So
// it PROMOTES the files that reveal product + architecture intent and DEMOTES the
// budget-eating noise (raw data dumps, migration snapshots, generated UI libraries,
// tool logs) so real application code is what's kept.
function score(rel) {
  const r = rel.toLowerCase();
  let s = 0;
  // Promote — product intent + architecture.
  if (/readme/.test(r)) s += 100;
  if (/(package\.json|pyproject\.toml|go\.mod|composer\.json|requirements\.txt|cargo\.toml|gemfile)$/.test(r)) s += 90;
  if (/schema/.test(r)) s += 60;                       // the data model — gold for planning
  if (/\.(md|markdown)$/.test(r)) s += 35;
  if (/(^|\/)(src|app|server|api|lib|routes|pages|models|controllers|shared|hooks|services|store|domain)\//.test(r)) s += 40;
  if (/(model|route|controller|handler|endpoint|resolver|reducer|middleware)/.test(r)) s += 25;
  if (/(config|settings|\.env\.example|vite\.config|next\.config|drizzle\.config|tsconfig)/.test(r)) s += 12;
  // Demote — noise that eats the budget without informing the plan.
  if (/(test|spec|__tests__|\.test\.|\.spec\.|fixtures?|mock)/.test(r)) s -= 40;
  if (/(^|\/)(public|static|assets)\//.test(r)) s -= 15;
  if (/(^|\/)components\/ui\//.test(r)) s -= 70;        // generated UI component library (shadcn/radix wrappers)
  if (/(^|\/)(migrations?|meta)\/|_journal\.json$|(^|\/)\d{4}_[a-z0-9_]+\.(sql|json)$/.test(r)) s -= 80; // migration snapshots (also excluded)
  if (/(import[_-]|[_-]seed|seed[_-]|_forecasts?|leads[_-]|_dump|backup)/.test(r) && /\.(sql|json|csv|tsv|xlsx?)$/.test(r)) s -= 10; // data dumps — kept as SAMPLES, mild demote
  if (/\.manus(\/|$)/.test(r)) s -= 90;                // tool logs (also dir-skipped)
  return s;
}

// Expand any *.zip attachments into temp dirs so their contents join the corpus.
function gatherRoots(attachDir) {
  const roots = [attachDir];
  const temps = [];
  let zips = [];
  try { zips = fs.readdirSync(attachDir).filter((f) => /\.zip$/i.test(f)); } catch {}
  for (const z of zips) {
    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pwcorpus-'));
      execFileSync('unzip', ['-qq', '-o', path.join(attachDir, z), '-d', tmp], { stdio: 'ignore' });
      roots.push(tmp); temps.push(tmp);
    } catch { /* skip unreadable zip */ }
  }
  return { roots, temps };
}

function walk(root, rel, out) {
  let entries;
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const rp = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue;
      walk(root, rp, out);
    } else if (e.isFile()) {
      if (e.name.endsWith('.tmp') || e.name.startsWith('._')) continue;   // .tmp / macOS AppleDouble junk
      out.push({ root, rel: rp, name: e.name });
    }
  }
}

// Build the corpus from all uploaded files (recursively, zips expanded), most
// important files first, capped to a char budget. Returns a manifest + text.
function buildCorpus(attachDir) {
  const { roots, temps } = gatherRoots(attachDir);
  const files = [];
  for (const r of roots) walk(r, '', files);
  files.sort((a, b) => score(b.rel) - score(a.rel) || a.rel.localeCompare(b.rel));

  const seen = new Set();
  const manifest = [];
  const parts = [];
  let budget = MAX_CORPUS_CHARS;
  let truncated = false;

  for (const f of files) {
    if (seen.has(f.rel)) continue;
    seen.add(f.rel);
    const fp = path.join(f.root, f.rel);
    let size = 0;
    try { size = fs.statSync(fp).size; } catch {}
    let included = false;
    let content = (budget > 0 && !SKIP_FILE.test(f.rel)) ? readContent(fp, f.name, size, f.rel) : '';
    if (content) {
      if (content.length > budget) { content = content.slice(0, budget) + '\n…[truncated]'; truncated = true; }
      parts.push('=== ' + f.rel + ' ===\n' + content + '\n');
      budget -= content.length;
      included = true;
    } else if (budget <= 0) {
      truncated = true;
    }
    // Every upload is listed in the manifest — even binaries we can't extract — so the
    // model knows the full set of reference material that exists.
    manifest.push({ path: f.rel, bytes: size, included });
  }

  for (const t of temps) { try { fs.rmSync(t, { recursive: true, force: true }); } catch {} }
  return {
    manifest,
    text: parts.join('\n'),
    truncated,
    fileCount: manifest.length,
    includedCount: manifest.filter((m) => m.included).length,
  };
}

// ─── intake schema (structured output) ───────────────────────────────────────
const str = (description) => ({ type: 'string', description });
const obj = (properties, required) => ({ type: 'object', additionalProperties: false, properties, required });
const arr = (items, description) => ({ type: 'array', description, items });

const INTAKE_SCHEMA = obj({
  product: obj({
    name: str('Product name'),
    domain: str('Production domain if evident, else empty string'),
    oneliner: str('One sentence: what the product is, in plain language'),
    problem: str('The problem it solves and who hurts today'),
    users: str('Who it is for — one line per user type'),
    differentiator: str('What makes it better than how users solve this today'),
    experience: str('What using it should feel like (the experience bar)'),
    success: str('What success looks like, measurable if inferable'),
    notBuilding: str('Conspicuous non-goals — one per line; empty string if none'),
  }, ['name', 'domain', 'oneliner', 'problem', 'users', 'differentiator', 'experience', 'success', 'notBuilding']),
  requirements: arr(obj({
    title: str('Short requirement title'),
    priority: { type: 'string', enum: ['Must', 'Should', 'May', "Won't"], description: 'MoSCoW priority' },
    test: str('How you would test it, in plain English — concrete, observable, names an actor and an outcome; NOT implementation detail'),
  }, ['title', 'priority', 'test']), 'User-observable requirements reverse-engineered from the code (8–20)'),
  decisions: arr(obj({
    concern: str('e.g. Runtime, Storage, Auth, Frontend, Deploy'),
    choice: str('What the code actually uses'),
    why: str('The trade-off that choice implies'),
  }, ['concern', 'choice', 'why']), 'Notable tech/architecture choices visible in the code'),
  milestones: arr(obj({
    name: str('Milestone name'),
    done: str('Done means… (user-visible outcome)'),
    target: str('Target or empty string'),
  }, ['name', 'done', 'target']), 'A sensible build order to reach the current state'),
  risks: arr(obj({
    risk: str('Risk or constraint visible in the code or domain'),
    mitigation: str('Mitigation or hard limit'),
  }, ['risk', 'mitigation']), 'Real risks'),
  scalability: arr(obj({
    area: str('e.g. Availability, Performance, Observability, Security, Scale'),
    target: str('Target / requirement'),
    adr: str('The decision behind it'),
  }, ['area', 'target', 'adr']), 'Non-functional posture inferable from the code'),
}, ['product', 'requirements', 'decisions', 'milestones', 'risks', 'scalability']);

const SYSTEM =
  "You reverse-engineer a product plan from an existing application's source code. Infer the product's INTENT and user-observable behaviour — what the app lets people do and why — not a line-by-line code summary. Write requirements as plain-English, observable behaviours (an actor and an outcome), never implementation detail. Be faithful to what the code actually does; do not invent features that aren't present. Where the code is ambiguous, make a reasonable, clearly-worded inference the owner can correct. Produce a complete draft intake the owner will review and edit.";

function buildUserContent(projectName, corpus) {
  return [
    'Project name: ' + projectName,
    '',
    'Reverse-engineer the plan intake for this existing application from its code below.',
    corpus.truncated
      ? '(The corpus was truncated to fit — ' + corpus.includedCount + ' of ' + corpus.fileCount + ' files included. Infer from what is present and from the full file manifest.)'
      : '',
    '',
    'Guidance: 8–20 requirements covering the main user-facing capabilities, priorities reflecting how central each is. decisions = the notable tech/architecture choices the code reveals (runtime, storage, auth, frontend, deploy, key libraries) with the trade-off each implies. milestones = a sensible build order to reach the current state. risks = real risks visible in the code or its domain. scalability = the non-functional posture you can infer (availability, performance, observability, security, scale). For notBuilding, list capabilities conspicuously absent that a reader might expect.',
    '',
    '--- FILE MANIFEST (* = contents included below) ---',
    corpus.manifest.slice(0, 600).map((m) => (m.included ? '* ' : '  ') + m.path + ' (' + m.bytes + 'B)').join('\n'),
    '',
    '--- FILE CONTENTS ---',
    corpus.text,
  ].join('\n');
}

// Whether a server-side key exists. The GUI can also supply a key per-request,
// so auto mode is reachable even when this is false.
function serverKeyConfigured() { return !!process.env.ANTHROPIC_API_KEY; }

// Call Claude with structured output and return the parsed intake object.
// apiKey: caller-supplied (from the GUI, used transiently — never persisted);
// falls back to the ANTHROPIC_API_KEY env var when blank.
async function generateIntake(projectName, corpus, apiKey) {
  apiKey = (apiKey && String(apiKey).trim()) || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { const e = new Error('no Claude API key provided'); e.code = 'no_key'; throw e; }

  const body = {
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: INTAKE_SCHEMA }, effort: 'medium' },
    messages: [{ role: 'user', content: buildUserContent(projectName, corpus) }],
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 240000);
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    const err = new Error(e.name === 'AbortError' ? 'the analysis timed out — try a smaller upload' : ('could not reach the Claude API: ' + e.message));
    err.status = 504; throw err;
  } finally { clearTimeout(timer); }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error((data && data.error && data.error.message) || ('Claude API HTTP ' + res.status));
    err.status = res.status; throw err;
  }
  if (data && data.stop_reason === 'refusal') {
    const err = new Error('the model declined to analyze this codebase'); err.status = 422; throw err;
  }
  const text = ((data && data.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    const err = new Error('could not parse the model output as JSON'); err.status = 502; throw err;
  }
  return parsed;
}

// No-key path: a prompt the owner runs against their code with a coding agent.
function handoffPrompt(projectName, corpus) {
  return [
    '# Reverse-engineer a PLAN-INTAKE.json for: ' + projectName,
    '',
    'You are reverse-engineering a product plan from this existing application. Read the code in this folder and infer the product\'s INTENT and user-observable behaviour — what it lets people do and why — not a line-by-line code summary. Be faithful to what the code actually does; do not invent features. Where ambiguous, make a clearly-worded inference the owner can correct.',
    '',
    'Write a file **PLAN-INTAKE.json** in this exact shape (all fields required; arrays may be empty):',
    '',
    '```json',
    JSON.stringify({
      version: 1, kind: 'plan-intake', project: projectName,
      product: { name: '', domain: '', oneliner: '', problem: '', users: '', differentiator: '', experience: '', success: '', notBuilding: '' },
      requirements: [{ title: '', priority: 'Must', test: '' }],
      decisions: [{ concern: '', choice: '', why: '' }],
      milestones: [{ name: '', done: '', target: '' }],
      risks: [{ risk: '', mitigation: '' }],
      scalability: [{ area: '', target: '', adr: '' }],
    }, null, 2),
    '```',
    '',
    'Guidance: 8–20 requirements as plain-English observable behaviours (actor + outcome), priority is MoSCoW (Must/Should/May/Won\'t). decisions = notable tech/architecture choices the code reveals + the trade-off each implies. milestones = a sensible build order to reach the current state. risks = real risks. scalability = the non-functional posture (availability, performance, observability, security, scale). notBuilding = capabilities conspicuously absent.',
    '',
    'When done, the owner imports your PLAN-INTAKE.json back into the wizard (the "Import a PLAN-INTAKE.json" button on the same screen) to review and refine it.',
    corpus ? ('\n_Manifest: ' + corpus.fileCount + ' files uploaded; this prompt was generated by project-wizard._') : '',
  ].join('\n');
}

module.exports = { buildCorpus, generateIntake, handoffPrompt, serverKeyConfigured, INTAKE_SCHEMA, MODEL };
