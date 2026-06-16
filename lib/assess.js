// ============================================================================
//  assess.js — the "Assess Changes" engine for living docs.
//
//  Given the BASELINE intake (what's currently live in the docs + Linear), the
//  PROPOSED intake (the human's buffered edits), the deterministic doc diff,
//  the CURRENT Linear issues (with completion state), and the project's CODE
//  corpus, one structured-output Claude call (raw fetch, no SDK) returns an
//  impact analysis: a narrative, per-section impact notes, the Linear issues
//  that should be created / updated / cancelled, previously-closed issues the
//  change touches, and the code functions likely affected (a summary, not a
//  diff). The server turns each into an accept/revert change unit.
//
//  Mirrors lib/enrich.js (same API wiring, model, refusal handling).
// ============================================================================
'use strict';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.WIZARD_MODEL || 'claude-opus-4-8';

const GOV_LABELS = ['gov:owner-action', 'gov:phase-01-requirements', 'gov:phase-02-architecture', 'gov:phase-03-design', 'gov:phase-04-implementation', 'gov:phase-05-review', 'gov:phase-06-testing', 'gov:phase-07-release'];

const str = (d) => ({ type: 'string', description: d });
const obj = (p, r) => ({ type: 'object', additionalProperties: false, properties: p, required: r });
const arr = (items, d) => ({ type: 'array', description: d, items });

const ASSESS_SCHEMA = obj({
  summary: str('A 2–4 sentence plain-English narrative of what changed in the docs and what it means for the build and the tracker.'),
  sectionImpacts: arr(obj({
    section: { type: 'string', enum: ['product', 'requirements', 'decisions', 'milestones', 'risks', 'scalability', 'startDate'], description: 'Which intake section this note is about' },
    impact: str('What this section change implies — for the plan, the architecture, and the work already done. One short paragraph.'),
  }, ['section', 'impact']), 'One impact note per changed section (only for sections that actually changed).'),
  linearActions: arr(obj({
    action: { type: 'string', enum: ['create', 'update', 'cancel'], description: 'create = a new issue the change introduces; update = an existing open issue whose scope/acceptance shifts; cancel = an existing issue the change makes obsolete' },
    issueIdentifier: str('For update/cancel: the EXACT existing issue identifier (e.g. SEQ-42). Empty for create.'),
    title: str('For create: the new issue title. For update/cancel: the existing issue title (for display).'),
    owner: { type: 'string', enum: ['Human', 'AI'], description: 'For create: who owns it. Else echo the existing owner or "AI".' },
    label: { type: 'string', enum: GOV_LABELS, description: 'For create: the governance phase label. Else best guess.' },
    objective: str('For create: one-sentence objective of the new issue. For update: a precise description of what to change about the issue (scope/acceptance). For cancel: why it is now obsolete.'),
    reason: str('Why this action follows from the doc change — the justification shown to the human.'),
  }, ['action', 'issueIdentifier', 'title', 'owner', 'label', 'objective', 'reason']), 'The Linear issue actions this change set implies. Be conservative — only propose actions that clearly follow from the doc changes.'),
  affectedClosed: arr(obj({
    issueIdentifier: str('The EXACT identifier of a DONE/closed/cancelled issue this change touches (e.g. SEQ-12).'),
    title: str('The issue title (for display).'),
    reason: str('How this completed work is affected — e.g. its acceptance criteria changed, or it may need reopening.'),
  }, ['issueIdentifier', 'title', 'reason']), 'Previously-completed issues this change affects. A comment (with the Change ID) will be posted on each accepted one — it does NOT reopen them automatically.'),
  codeImpacts: arr(obj({
    area: str('A short label for the affected area (e.g. "Auth", "Billing webhook").'),
    detail: str('A summary (NOT a diff) of how the code is likely affected by this doc change.'),
    functions: arr(obj({
      name: str('The function / method / symbol likely affected'),
      file: str('Its file path within the uploaded code, if identifiable (else empty)'),
      impact: str('One line: how it is affected'),
    }, ['name', 'file', 'impact']), 'Specific functions likely affected, grounded in the uploaded code.'),
  }, ['area', 'detail', 'functions']), 'Code likely affected by the doc changes, grounded in the uploaded codebase. Summary-level only — never a full diff.'),
}, ['summary', 'sectionImpacts', 'linearActions', 'affectedClosed', 'codeImpacts']);

const SYSTEM =
  'You are a change-impact analyst for a living software-project documentation system. The documentation (requirements, decisions, milestones, risks, non-functional targets, product framing) is the source of truth that drives a Linear tracker and the codebase. A human has edited the docs. You are given: the BASELINE intake (what is currently live in the docs and reflected in the tracker), the PROPOSED intake (the edited version), a deterministic DIFF of exactly what changed, the CURRENT Linear issues with their completion state, and excerpts of the actual CODEBASE.\n\n' +
  'Produce a precise, conservative impact analysis:\n' +
  '• A short narrative summary of the change and its consequences.\n' +
  '• Per changed section, one impact note.\n' +
  '• The Linear actions the change implies: NEW issues to create (with owner/label/objective), existing OPEN issues to update (name the exact identifier and say precisely what to change), and issues to cancel as obsolete. Only propose what clearly follows — do not pad.\n' +
  '• Previously-COMPLETED issues the change affects (e.g. an AC changed under a done issue), by exact identifier, with the reason.\n' +
  '• The code functions likely affected, grounded in the uploaded code — name real functions/files where you can. This is a SUMMARY of impact, never a diff and never new code.\n\n' +
  'Be faithful to the diff: do not invent changes that are not in it, and do not propose scope the docs do not support. Owner is "Human" for work only a person can do (signups, keys, DNS, billing, approvals, manual verification) or "AI" for code/docs/tests. Match existing issue identifiers EXACTLY as given; never fabricate an identifier.';

// Deterministic per-section diff of baseline vs proposed intake. Returns one
// entry per changed section with row-level detail, so the popup shows exactly
// what moved and the applier is exact (not AI-guessed).
const TABLES = {
  requirements: ['title', 'priority', 'test'],
  decisions: ['concern', 'choice', 'why'],
  milestones: ['name', 'done', 'target'],
  risks: ['risk', 'mitigation'],
  scalability: ['area', 'target', 'adr'],
};
const rowLabel = { requirements: 'title', decisions: 'concern', milestones: 'name', risks: 'risk', scalability: 'area' };

function rowKey(section, r) { return String((r && r[rowLabel[section]]) || '').trim().toLowerCase(); }
function sameRow(keys, a, b) { return keys.every((k) => String((a && a[k]) || '').trim() === String((b && b[k]) || '').trim()); }

function diffIntake(baseline, proposed) {
  baseline = baseline || {}; proposed = proposed || {};
  const out = [];

  // product scalars + startDate
  const prodKeys = new Set([...Object.keys(baseline.product || {}), ...Object.keys(proposed.product || {})]);
  const prodMods = [];
  for (const k of prodKeys) {
    const before = String((baseline.product || {})[k] || '').trim();
    const after = String((proposed.product || {})[k] || '').trim();
    if (before !== after) prodMods.push({ field: k, before, after });
  }
  if (String(baseline.startDate || '') !== String(proposed.startDate || '')) {
    prodMods.push({ field: 'startDate', before: String(baseline.startDate || ''), after: String(proposed.startDate || ''), top: true });
  }
  if (prodMods.length) out.push({ section: 'product', changed: true, scalars: prodMods, added: [], removed: [], modified: [] });

  // tables
  for (const section of Object.keys(TABLES)) {
    const keys = TABLES[section];
    const b = (baseline[section] || []).filter((r) => keys.some((k) => String(r[k] || '').trim()));
    const p = (proposed[section] || []).filter((r) => keys.some((k) => String(r[k] || '').trim()));
    const bByKey = {}; b.forEach((r) => { bByKey[rowKey(section, r)] = r; });
    const pByKey = {}; p.forEach((r) => { pByKey[rowKey(section, r)] = r; });
    const added = p.filter((r) => !(rowKey(section, r) in bByKey));
    const removed = b.filter((r) => !(rowKey(section, r) in pByKey));
    const modified = [];
    for (const r of p) {
      const k = rowKey(section, r);
      if (k in bByKey && !sameRow(keys, bByKey[k], r)) modified.push({ before: bByKey[k], after: r });
    }
    if (added.length || removed.length || modified.length) {
      out.push({ section, changed: true, added, removed, modified, scalars: [] });
    }
  }
  return out;
}

function buildUserContent({ baseline, proposed, docDiff, linearIssues, corpus }) {
  const slim = (it) => ({
    product: it.product || {}, startDate: it.startDate || '',
    requirements: (it.requirements || []).map((r) => ({ title: r.title, priority: r.priority, test: r.test })),
    decisions: (it.decisions || []).map((d) => ({ concern: d.concern, choice: d.choice, why: d.why })),
    milestones: (it.milestones || []).map((m) => ({ name: m.name, done: m.done, target: m.target })),
    risks: (it.risks || []).map((r) => ({ risk: r.risk, mitigation: r.mitigation })),
    scalability: it.scalability || [],
  });
  let out = 'BASELINE intake (currently live):\n' + JSON.stringify(slim(baseline), null, 2) +
    '\n\nPROPOSED intake (edited):\n' + JSON.stringify(slim(proposed), null, 2) +
    '\n\nDETERMINISTIC DIFF (exactly what changed):\n' + JSON.stringify(docDiff, null, 2);
  if (Array.isArray(linearIssues) && linearIssues.length) {
    out += '\n\nCURRENT LINEAR ISSUES (identifier · state · title):\n' +
      linearIssues.map((i) => '- ' + i.identifier + ' · ' + (i.stateType || i.state) + ' · ' + i.title).join('\n');
  } else {
    out += '\n\nCURRENT LINEAR ISSUES: (none linked — propose create actions only if a tracker clearly should exist; otherwise leave linearActions empty)';
  }
  if (corpus && corpus.text) {
    out += '\n\n--- CODEBASE (' + corpus.includedCount + ' of ' + corpus.fileCount + ' files' + (corpus.truncated ? ', truncated' : '') + ') — ground code impact in this ---\n' + corpus.text;
  }
  out += '\n\nReturn the impact analysis. Reference issue identifiers EXACTLY as listed; never invent one.';
  return out;
}

async function assess(input, apiKey) {
  apiKey = (apiKey && String(apiKey).trim()) || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { const e = new Error('no Claude API key provided'); e.code = 'no_key'; e.status = 400; throw e; }

  const body = {
    model: MODEL,
    max_tokens: 32000,
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: ASSESS_SCHEMA }, effort: 'medium' },
    messages: [{ role: 'user', content: buildUserContent(input) }],
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
    const err = new Error(e.name === 'AbortError' ? 'the assessment timed out' : ('could not reach the Claude API: ' + e.message));
    err.status = 504; throw err;
  } finally { clearTimeout(timer); }

  const data = await res.json().catch(() => null);
  if (!res.ok) { const err = new Error((data && data.error && data.error.message) || ('Claude API HTTP ' + res.status)); err.status = res.status; throw err; }
  if (data && data.stop_reason === 'refusal') { const err = new Error('the model declined this request'); err.status = 422; throw err; }
  const text = ((data && data.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let parsed;
  try { parsed = JSON.parse(text); } catch { const err = new Error('could not parse the AI output'); err.status = 502; throw err; }
  return sanitize(parsed);
}

function sanitize(p) {
  p = p || {};
  return {
    summary: String(p.summary || '').trim(),
    sectionImpacts: Array.isArray(p.sectionImpacts) ? p.sectionImpacts : [],
    linearActions: Array.isArray(p.linearActions) ? p.linearActions : [],
    affectedClosed: Array.isArray(p.affectedClosed) ? p.affectedClosed : [],
    codeImpacts: Array.isArray(p.codeImpacts) ? p.codeImpacts : [],
  };
}

module.exports = { assess, diffIntake, ASSESS_SCHEMA, MODEL, GOV_LABELS };
