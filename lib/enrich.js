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

const str = (d) => ({ type: 'string', description: d });
const obj = (p, r) => ({ type: 'object', additionalProperties: false, properties: p, required: r });
const arr = (items, d) => ({ type: 'array', description: d, items });

const ENRICH_SCHEMA = obj({
  architectureMermaid: str('A Mermaid `flowchart TD` (or LR) modeling the system from the locked decisions — actors, frontend, backend/API, datastore, auth, external services, deploy target. Valid Mermaid only, no code fences, no markdown.'),
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
}, ['architectureMermaid', 'architectureNote', 'ganttMermaid', 'requirements', 'adrs']);

const SYSTEM =
  'You expand a software project plan into richer documentation. You are given the project intake (product, requirements, decisions, milestones). Produce: a Mermaid architecture diagram grounded in the locked decisions, a Mermaid Gantt from the milestones, one Given/When/Then acceptance criterion per requirement (concrete and observable — an actor and an outcome, never implementation detail), and a full ADR body per decision (context, trade-off accepted, revisit trigger). Be faithful to the intake; do not invent scope. Output Mermaid as raw diagram source with NO code fences and NO surrounding markdown.';

function buildUserContent(intake) {
  const slim = {
    product: intake.product || {},
    requirements: (intake.requirements || []).map((r) => ({ title: r.title, priority: r.priority, test: r.test })),
    decisions: (intake.decisions || []).map((d) => ({ concern: d.concern, choice: d.choice, why: d.why })),
    milestones: (intake.milestones || []).map((m) => ({ name: m.name, done: m.done, target: m.target })),
    scalability: intake.scalability || [],
  };
  return 'Project intake:\n\n' + JSON.stringify(slim, null, 2) +
    '\n\nProduce the enrichment. Keep requirements and adrs in the SAME ORDER and titled the same as the intake so they can be matched up.';
}

function aiEnabled() { return !!process.env.ANTHROPIC_API_KEY; }

async function enrich(intake, apiKey) {
  apiKey = (apiKey && String(apiKey).trim()) || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { const e = new Error('no Claude API key provided'); e.code = 'no_key'; throw e; }

  const body = {
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: ENRICH_SCHEMA }, effort: 'medium' },
    messages: [{ role: 'user', content: buildUserContent(intake) }],
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
  };
}

module.exports = { enrich, aiEnabled, ENRICH_SCHEMA, MODEL };
