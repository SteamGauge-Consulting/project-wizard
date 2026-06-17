// ============================================================================
//  enrich.js — Stage 3 (AI): turn a plain intake into richer docs content.
//
//  One structured-output Claude call (raw fetch, no SDK) that returns:
//   - a Mermaid architecture diagram (from the locked decisions),
//   - a Mermaid Gantt (from the milestones),
//   - Given/When/Then acceptance criteria per requirement,
//   - full ADR bodies (context / trade-off / revisit) per decision.
//  render-intake injects these into the generated pages.
// ============================================================================
'use strict';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.WIZARD_MODEL || 'claude-opus-4-8';

// Governance phase labels — must match lib/linear.js GOV_LABELS.
const GOV_LABELS = ['gov:owner-action', 'gov:phase-01-requirements', 'gov:phase-02-architecture', 'gov:phase-03-design', 'gov:phase-04-implementation', 'gov:phase-05-review', 'gov:phase-06-testing', 'gov:phase-07-release'];

const str = (d) => ({ type: 'string', description: d });
const obj = (p, r) => ({ type: 'object', additionalProperties: false, properties: p, required: r });
const arr = (items, d) => ({ type: 'array', description: d, items });

const ENRICH_SCHEMA = obj({
  architectureMermaid: str('A Mermaid `flowchart TB` modeling the PRODUCTION system from the locked decisions. Requirements, all of them: (1) Group nodes into `subgraph` layers that fit the stack — typically "Client", "Edge", "Application", "Data & Services", and "CI/CD & Deploy". (2) Give EVERY node a multi-line label with <br/>: first line the name, then 1–3 short lines of role · key tech · the relevant ADR, e.g. A["Fly.io<br/>Node · Express · Docker<br/>Stateless (ADR-005)"]. (3) Assign EVERY node exactly one style class via `class <id> <class>` using ONLY these names: actor (end users/clients), edge (CDN/DNS/proxy/static), app (OUR application/runtime/API — the thing we build), saas (third-party SaaS: auth, billing, email, etc.), data (databases/caches/object stores), infra (CI/CD, registry, deploy target). (4) Label the important edges with the protocol/action, e.g. -->|HTTPS| , -->|JWT verify| , -->|webhook| . Do NOT emit `classDef` or `style` lines — the renderer supplies the palette. Output valid Mermaid only: no code fences, no markdown.'),
  architectureNote: str('1–2 sentences describing the architecture in plain language.'),
  ganttMermaid: str('A Mermaid `gantt` chart from the milestones (use each milestone name as a section/task; derive durations from targets like "Week 2"). Valid Mermaid only, no code fences.'),
  requirements: arr(obj({
    title: str('The requirement title, matched to the intake'),
    priority: { type: 'string', enum: ['Must', 'Should', 'May', "Won't"] },
    given: str('Given … (precondition)'),
    when: str('When … (the action)'),
    then: str('Then … (the observable outcome; may include " And …" lines separated by \\n)'),
  }, ['title', 'priority', 'given', 'when', 'then']), 'One Given/When/Then acceptance criterion per intake requirement, in the same order'),
  adrs: arr(obj({
    concern: str('The decision concern, matched to the intake'),
    choice: str('The decision'),
    context: str('Why this decision needed making (the forces)'),
    tradeoff: str('The trade-off accepted by choosing it'),
    revisit: str('The trigger that would make us revisit this decision'),
  }, ['concern', 'choice', 'context', 'tradeoff', 'revisit']), 'One ADR body per intake decision, in the same order'),
  plan: arr(obj({
    milestone: str('The EXACT intake milestone name this group of work belongs to'),
    issues: arr(obj({
      title: str('A concrete build task / Linear issue title'),
      owner: { type: 'string', enum: ['Human', 'AI'], description: 'Who does it: "Human" for things only a person can (signups, minting API keys, DNS/billing/account setup, approvals, manual verification) or "AI" for code/docs/tests a coding agent can do' },
      objective: str('One sentence: what this task accomplishes'),
      steps: arr(str('One step. For HUMAN tasks: a precise click-by-click action (where to go, what to enter, what value to copy). For AI tasks: a precise build instruction a coding agent can execute (what to create/change, in which file/module, with what approach).'), 'The full, ordered step-by-step — detailed enough to execute without re-deriving the plan (typically 4–10 steps)'),
      notes: str('Extra execution detail. For AI tasks: the approach, key files/modules/commands, data shapes, libraries, and gotchas — AI-optimized and specific. For Human tasks: tips, links, or what to have ready. Markdown allowed. May be empty.'),
      doneWhen: str('The acceptance check — how you know this task is complete and correct'),
      label: { type: 'string', enum: GOV_LABELS, description: 'The governance phase this task belongs to' },
    }, ['title', 'owner', 'objective', 'steps', 'notes', 'doneWhen', 'label']), 'The build issues under this milestone (sub-issues), in build order'),
  }, ['milestone', 'issues']), 'The build plan: each intake milestone with the governance-phased build tasks under it. Cover the requirements; add the obvious setup/architecture/review/release tasks the governance phases imply.'),
}, ['architectureMermaid', 'architectureNote', 'ganttMermaid', 'requirements', 'adrs', 'plan']);

const SYSTEM =
  'You expand a software project plan into richer documentation and a governance-phased build runbook. You are given the project intake (product, requirements, decisions, milestones) and, when available, excerpts of the existing/related codebase. Produce: a Mermaid architecture diagram grounded in the locked decisions — a layered `flowchart TB` with subgraphs per layer, multi-line node labels (name + role + key tech + ADR), every node assigned one style class (actor/edge/app/saas/data/infra), and labeled edges, exactly as the architectureMermaid field describes; a Mermaid Gantt from the milestones; one Given/When/Then acceptance criterion per requirement (concrete and observable — an actor and an outcome, never implementation detail); a full ADR body per decision (context, trade-off accepted, revisit trigger); and a `plan` that breaks the work into the intake milestones, each with build tasks (sub-issues) in build order.\n\n' +
  'These tasks become Linear issues a person or a coding agent will execute, so make each one a complete, self-contained runbook entry with FULL detail — never a one-line stub. For EACH task give: the owner ("Human" for work only a person can do — signups, minting API keys, DNS/billing/account setup, approvals, manual verification — or "AI" for code/docs/tests a coding agent can do); a one-sentence objective; detailed ordered steps; execution notes; a done-when acceptance check; and the single best governance label (requirements → architecture → design → implementation → review → testing → release; owner-action for human-only setup).\n\n' +
  'Tailor the depth to the owner:\n' +
  '• HUMAN tasks → precise, click-by-click steps a non-expert can follow: exactly where to go, what to click, what to enter, and what value to copy and where to put it. Spell out the manual workflow end to end.\n' +
  '• AI tasks → AI-optimized build instructions a coding agent can execute without re-deriving the plan: name the specific files/modules to create or change, the approach, data shapes, libraries, exact commands to run, and how to verify. Be concrete and imperative; ground it in the locked decisions and the uploaded code where present.\n\n' +
  'Cover every requirement and add the obvious phase tasks (setup, architecture, review, testing, release) a disciplined team would. The issue is kicked off by a human telling Claude `start <issue-id>`, so the steps must be directly actionable. Be faithful to the intake and the code; do not invent scope. Output Mermaid as raw diagram source with NO code fences and NO surrounding markdown.';

function buildUserContent(intake, corpus) {
  const slim = {
    product: intake.product || {},
    requirements: (intake.requirements || []).map((r) => ({ title: r.title, priority: r.priority, test: r.test })),
    decisions: (intake.decisions || []).map((d) => ({ concern: d.concern, choice: d.choice, why: d.why })),
    milestones: (intake.milestones || []).map((m) => ({ name: m.name, done: m.done, target: m.target })),
    scalability: intake.scalability || [],
  };
  let out = 'Project intake:\n\n' + JSON.stringify(slim, null, 2) +
    '\n\nProduce the enrichment. Keep requirements and adrs in the SAME ORDER and titled the same as the intake. In `plan`, use the EXACT milestone names from the intake.';
  if (corpus && corpus.text) {
    out += '\n\n--- EXISTING CODE (' + corpus.includedCount + ' of ' + corpus.fileCount + ' uploaded files' + (corpus.truncated ? ', truncated' : '') + ') — use it to ground the diagram, decisions, and tasks ---\n' + corpus.text;
  }
  return out;
}

function aiEnabled() { return !!process.env.ANTHROPIC_API_KEY; }

async function enrich(intake, apiKey, corpus) {
  apiKey = (apiKey && String(apiKey).trim()) || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { const e = new Error('no Claude API key provided'); e.code = 'no_key'; throw e; }

  const body = {
    model: MODEL,
    max_tokens: 32000,
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: ENRICH_SCHEMA }, effort: 'medium' },
    messages: [{ role: 'user', content: buildUserContent(intake, corpus) }],
  };
  const ctrl = new AbortController();
  // A rich build (max_tokens 32k on Opus, plus a large code corpus) can run well
  // past 4 min; allow 10 by default, tunable via ENRICH_TIMEOUT_MS.
  const timer = setTimeout(() => ctrl.abort(), Number(process.env.ENRICH_TIMEOUT_MS) || 600000);
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    const err = new Error(e.name === 'AbortError' ? 'the AI build timed out' : ('could not reach the Claude API: ' + e.message));
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

// Strip stray code fences the model sometimes wraps Mermaid in, and clamp shapes.
function fence(s) {
  return String(s || '').replace(/^\s*```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();
}
function sanitize(p) {
  p = p || {};
  return {
    architectureMermaid: fence(p.architectureMermaid),
    architectureNote: String(p.architectureNote || '').trim(),
    ganttMermaid: fence(p.ganttMermaid),
    requirements: Array.isArray(p.requirements) ? p.requirements : [],
    adrs: Array.isArray(p.adrs) ? p.adrs : [],
    plan: Array.isArray(p.plan) ? p.plan : [],
  };
}

module.exports = { enrich, aiEnabled, ENRICH_SCHEMA, MODEL, GOV_LABELS };
