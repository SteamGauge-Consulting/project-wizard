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
  architecture: obj({
    layers: arr(obj({
      label: str('The layer label shown on the left edge, e.g. "User", "DNS · Cloudflare", "Edge", "Data · Auth · Payments", "Side services · Backups", "CI / CD". Order layers top→bottom: people/clients first, then edge/CDN, the application, data/auth/payments, side services, and the CI/CD pipeline last.'),
      nodes: arr(obj({
        id: str('a short unique lowercase id, e.g. "app", "neon", "ghactions"'),
        title: str('the node title, e.g. "Fly.io · sequenceapp.life" or "Neon · Postgres 15"'),
        eyebrow: str('a small label above the title, e.g. "Our app · Fly.io" or "Third-party · Clerk", or "" '),
        lines: arr(str('a plain detail line (tech/config)'), 'detail lines under the title (no bullet)'),
        bullets: arr(str('a key specific'), 'bullet specifics, shown with a • '),
        subs: arr(obj({ head: str('sub-box heading, e.g. "Middleware" or "Endpoints"'), lines: arr(str('a line'), 'lines in the sub-box') }, ['head', 'lines']), 'optional sub-boxes inside this node (e.g. the application\'s Middleware + Endpoints)'),
        cls: { type: 'string', enum: ['actor', 'edge', 'app', 'saas', 'data', 'infra'], description: 'actor=users; edge=CDN/DNS/proxy; app=OUR app/runtime; saas=third-party SaaS; data=databases/stores; infra=CI/CD/registry/deploy' },
      }, ['id', 'title', 'cls']), 'nodes in this layer, left→right'),
    }, ['label', 'nodes']), 'The ordered architectural layers, top→bottom. Be DETAILED and technically precise (tech + version + ADR + key specifics, incl. the app\'s middleware/endpoints as subs). Ground every detail in the locked decisions and the real codebase.'),
    edges: arr(obj({
      from: str('source node id'), to: str('target node id'),
      label: str('a short edge label, e.g. "HTTPS", "verify JWT", "webhook", "deploy", or ""'),
      kind: { type: 'string', enum: ['default', 'critical', 'webhook', 'backup', 'deploy'] },
    }, ['from', 'to']), 'connections between node ids — the runtime data flows, the CI/CD pipeline chain, and the deploy edge into the application.'),
  }, ['layers']),
  architectureNote: str('1–2 sentences describing the architecture in plain language.'),
  ganttMermaid: str('A Mermaid `gantt` chart from the milestones (use each milestone name as a section/task; derive durations from targets like "Week 2"). Valid Mermaid only, no code fences.'),
  stackComponents: arr(obj({
    category: str('The role in the stack, e.g. "App host", "Database", "Auth", "Payments", "Marketing", "Email", "Errors", "Registry", "Backups", "CI/CD".'),
    component: str('The chosen product/tech, e.g. "Fly.io", "Neon", "Clerk".'),
    detail: str('A terse, technical one-liner of the key specifics, e.g. "Managed Postgres 15 · pooled · main + dev branch".'),
    adr: str('The matching ADR concern label to link (match an intake decision\'s concern), or "" if none.'),
  }, ['category', 'component', 'detail']), 'EVERY component of the stack as a labeled row, like a senior architect\'s "Stack components" table. Cover the locked decisions AND the supporting services the architecture implies (CDN, email, error-tracking, registry, backups, CI/CD).'),
  requestFlows: arr(obj({
    title: str('The flow name, e.g. "Sign up + first session", "Pay for a subscription", "Production deploy", "Backup + disaster recovery".'),
    status: str('A 1–3 word status tag, e.g. "live", "every merge", "planned".'),
    body: str('A precise TECHNICAL narrative of the end-to-end flow: the services touched, the real endpoints, and what happens at each step (2–4 sentences). You may use `code` for endpoints/identifiers.'),
  }, ['title', 'status', 'body']), 'The KEY request/operational flows end-to-end (sign-up, payment, billing, deploy, backup) — concrete and technical, naming the real endpoints and services.'),
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
}, ['architecture', 'architectureNote', 'ganttMermaid', 'stackComponents', 'requestFlows', 'requirements', 'adrs', 'plan']);

const SYSTEM =
  'You expand a software project plan into richer documentation and a governance-phased build runbook. You are given the project intake (product, requirements, decisions, milestones) and, when available, excerpts of the existing/related codebase. Produce: a DETAILED, reference-quality architecture as structured LAYER DATA (the `architecture` field — ordered top→bottom layers of detailed nodes, plus edges), grounded in the locked decisions and the real codebase. The TOP "User" lane holds the end User AND the Developer + Claude Code (the AI coding agent); lower lanes are the category layers (Edge, Application, Data·Auth·Payments, Side services, CI/CD). Draw the dev pipeline as edges — Developer → Claude Code → GitHub → registry → deploy → the app — alongside the runtime data flows. Nodes carry tech + version + ADR + bullet specifics (the application also gets middleware/endpoints sub-boxes), exactly as the architecture field describes; a "Stack components" list covering every component (decisions + supporting services); the KEY request/operational flows end-to-end (sign-up, payment, billing, deploy, backup) as concrete technical narratives; a Mermaid Gantt from the milestones; one Given/When/Then acceptance criterion per requirement (concrete and observable — an actor and an outcome, never implementation detail); a full ADR body per decision (context, trade-off accepted, revisit trigger); and a `plan` that breaks the work into the intake milestones, each with build tasks (sub-issues) in build order.\n\n' +
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
  // The architecture diagram is now structured DATA (layers + edges) rendered by
  // a deterministic swim-lane renderer, so no layout-refinement pass is needed.
  return sanitize(parsed);
}

// The design rules the diagram must satisfy — shared by the generator prompt and
// the refinement pass below.
const ARCH_RULES =
  'A DETAILED, reference-quality Mermaid `flowchart TB` drawn as stacked LAYERS, top → bottom. ' +
  '(1) Top row = the people: a "User" node (end user) and a "Developer" node, plain nodes side by side, NOT wrapped in a subgraph box. ' +
  '(2) One `subgraph` per layer, each with `direction LR` — typically "Edge" (DNS · CDN · marketing), "Application", "Data · Auth · Payments", "Side services" (email · errors · backups, if used), and "CI / CD". ' +
  '(3) Node labels are DETAILED and technically precise via <br/>: name; concrete tech + version; the relevant ADR; then 2–4 "• " bullet lines of key specifics. Do NOT dumb it down — engineers read this. The "Application" node also surfaces its key middleware and main endpoints as bullets. ' +
  '(4) Show the dev/CI pipeline as a chain: Developer → Claude Code → GitHub (repo + Actions) → container registry → deploy (flyctl rolling release) → the Application, with labeled edges. ' +
  '(5) Show the runtime path: User → Edge → Application → Data·Auth·Payments, with protocol-labeled edges (HTTPS · JWT verify · SQL · webhook). ' +
  '(6) Every node gets exactly one style class via `class <id> <class>` from: actor (User, Developer), edge, app, saas (incl. Claude Code), data, infra (GitHub/CI/registry/deploy). ' +
  '(7) Information-rich but balanced and uncrossed. No `classDef`/`style` lines. Valid Mermaid only — no code fences, no prose.';

const REFINE_SYSTEM =
  'You are a senior software architect and information designer. You refine Mermaid architecture diagrams for LAYOUT, BALANCE, GROUPING, and CLARITY without changing their technical accuracy. You output only valid Mermaid — no code fences, no commentary.';

const REFINE_SCHEMA = { type: 'object', additionalProperties: false, required: ['mermaid'],
  properties: { mermaid: { type: 'string', description: 'The refined Mermaid flowchart source — no code fences.' } } };

// Focused Opus pass that polishes the diagram's design. Any failure returns the
// original diagram unchanged, so the build never regresses on this.
async function refineArch(mmd, intake, apiKey) {
  apiKey = (apiKey && String(apiKey).trim()) || process.env.ANTHROPIC_API_KEY;
  mmd = String(mmd || '').trim();
  if (!apiKey || !mmd) return mmd;
  const prod = (intake && intake.product) || {};
  const userMsg = 'Refine this architecture diagram for ' + (prod.name || 'the product') +
    ' so it is clean, compact, balanced, and well-designed. Keep it technically faithful — improve grouping, layer ordering, spacing/balance, label wording, and reduce crossing edges. Make sure it satisfies EVERY rule.\n\n' +
    ARCH_RULES + '\n\nCURRENT DIAGRAM:\n' + mmd + '\n\nReturn ONLY the improved Mermaid in the `mermaid` field.';
  const body = {
    model: MODEL, max_tokens: 6000, system: REFINE_SYSTEM,
    output_config: { format: { type: 'json_schema', schema: REFINE_SCHEMA }, effort: 'high' },
    messages: [{ role: 'user', content: userMsg }],
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(process.env.ENRICH_TIMEOUT_MS) || 600000);
  try {
    const res = await fetch(API_URL, { method: 'POST', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
    const data = await res.json().catch(() => null);
    if (!res.ok) return mmd;
    const text = ((data && data.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    let parsed; try { parsed = JSON.parse(text); } catch (e) { return mmd; }
    const refined = fence(parsed && parsed.mermaid);
    return (refined && /flowchart/i.test(refined)) ? refined : mmd;   // sanity-gate
  } catch (e) { return mmd; }
  finally { clearTimeout(timer); }
}

// Strip stray code fences the model sometimes wraps Mermaid in, and clamp shapes.
function fence(s) {
  return String(s || '').replace(/^\s*```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();
}
function sanitize(p) {
  p = p || {};
  return {
    architectureMermaid: fence(p.architectureMermaid),
    architecture: (p.architecture && Array.isArray(p.architecture.layers)) ? { layers: p.architecture.layers, edges: Array.isArray(p.architecture.edges) ? p.architecture.edges : [] } : { layers: [], edges: [] },
    architectureNote: String(p.architectureNote || '').trim(),
    stackComponents: Array.isArray(p.stackComponents) ? p.stackComponents : [],
    requestFlows: Array.isArray(p.requestFlows) ? p.requestFlows : [],
    ganttMermaid: fence(p.ganttMermaid),
    requirements: Array.isArray(p.requirements) ? p.requirements : [],
    adrs: Array.isArray(p.adrs) ? p.adrs : [],
    plan: Array.isArray(p.plan) ? p.plan : [],
  };
}

module.exports = { enrich, aiEnabled, ENRICH_SCHEMA, MODEL, GOV_LABELS };
