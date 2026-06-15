// ============================================================================
//  linear.js — stand up a project's tracker in Linear, matching the Sequence
//  template: project milestones (with target dates) → one PARENT issue per
//  milestone (governance-labeled) → build issues as gov-labeled SUB-issues.
//
//  GraphQL (raw fetch, no SDK). Key supplied per-request, never stored.
//  SAFETY: only ever creates a BRAND-NEW project — never writes into an existing
//  one, so it cannot pollute a tracker that already holds work.
// ============================================================================
'use strict';

const API = 'https://api.linear.app/graphql';

// The governance phase labels (the "governance tag"), matching the Sequence project.
const GOV_LABELS = ['gov:owner-action', 'gov:phase-01-requirements', 'gov:phase-02-architecture', 'gov:phase-03-design', 'gov:phase-04-implementation', 'gov:phase-05-review', 'gov:phase-06-testing', 'gov:phase-07-release'];
const OWNER_LABELS = ['Human', 'AI'];   // who owns the task (instead of an assignee)
const DEFAULT_GOV = 'gov:phase-04-implementation';
const MoSCoW = { Must: 1, Should: 2, May: 3, "Won't": 4 };

async function gql(key, query, variables) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Authorization': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || (data && data.errors)) {
    const msg = (data && data.errors && data.errors[0] && data.errors[0].message) || ('Linear HTTP ' + res.status);
    const err = new Error(msg); err.status = res.status === 200 ? 400 : res.status; throw err;
  }
  return data.data;
}

async function listTeams(key) {
  const d = await gql(key, '{ teams(first: 100) { nodes { id key name } } }');
  return (d.teams && d.teams.nodes) || [];
}

// Find-or-create the governance + owner labels for this team; return name → id.
async function ensureLabels(key, teamId) {
  const d = await gql(key, 'query($id:String!){ team(id:$id){ labels(first:250){ nodes{ id name } } } }', { id: teamId });
  const existing = {};
  ((d.team && d.team.labels && d.team.labels.nodes) || []).forEach((l) => { existing[l.name] = l.id; });
  const map = {};
  const colors = { Human: '#e0a848', AI: '#97c459' };
  for (const name of GOV_LABELS.concat(OWNER_LABELS)) {
    if (existing[name]) { map[name] = existing[name]; continue; }
    try {
      const r = await gql(key, 'mutation($input: IssueLabelCreateInput!){ issueLabelCreate(input:$input){ success issueLabel{ id name } } }',
        { input: { name, teamId, color: colors[name] || '#5e6ad2' } });
      if (r.issueLabelCreate && r.issueLabelCreate.success) map[name] = r.issueLabelCreate.issueLabel.id;
    } catch (e) { /* concurrent create / name clash — fallbacks cover it */ }
  }
  return map;
}

function govId(map, label) { return map[label] || map[DEFAULT_GOV] || undefined; }
function lid(map, name) { return map[name] || undefined; }

// A sub-issue's body: the "done when" + the ordered build steps as a checklist.
function stepsBody(it) {
  const out = [];
  if (it.detail) out.push(String(it.detail), '');
  const steps = Array.isArray(it.steps) ? it.steps.filter(Boolean) : [];
  if (steps.length) { out.push('**Steps:**'); steps.forEach((s) => out.push('- [ ] ' + String(s))); }
  return out.join('\n');
}

// Compute a milestone target date from the wizard's start date + a "Week N"
// target. Returns an ISO date (YYYY-MM-DD) or undefined.
function weekTargetDate(startDate, target) {
  if (!startDate) return undefined;
  const m = /week\s*(\d+)/i.exec(String(target || ''));
  if (!m) {
    const d = Date.parse(String(target || ''));
    return isNaN(d) ? undefined : new Date(d).toISOString().slice(0, 10);
  }
  const base = Date.parse(startDate + 'T00:00:00Z');
  if (isNaN(base)) return undefined;
  return new Date(base + Number(m[1]) * 7 * 86400000).toISOString().slice(0, 10);
}

async function createIssue(key, input) {
  const r = await gql(key, 'mutation($input: IssueCreateInput!){ issueCreate(input:$input){ success issue{ id identifier } } }', { input });
  return r.issueCreate && r.issueCreate.success ? r.issueCreate.issue : null;
}

// Create an issue, then prepend a kickoff line referencing its own id so the
// owner can tell Claude `start <ID>` to begin it (matches the Sequence workflow).
async function createWithKickoff(key, input, body) {
  const issue = await createIssue(key, Object.assign({}, input, body ? { description: body } : {}));
  if (issue && issue.identifier) {
    const full = '**▶ To build this, tell Claude:** `start ' + issue.identifier + '`\n\n' + (body || '');
    try { await gql(key, 'mutation($id:String!,$input:IssueUpdateInput!){ issueUpdate(id:$id, input:$input){ success } }', { id: issue.id, input: { description: full } }); } catch (e) {}
  }
  return issue;
}

// opts: { teamId, name, intake, startDate, plan }
async function createProjectWithIssues(key, opts) {
  const teamId = String(opts.teamId || '').trim();
  if (!teamId) { const e = new Error('a Linear team is required'); e.status = 400; throw e; }
  const intake = opts.intake || {};
  const prod = intake.product || {};
  const name = (opts.name || prod.name || intake.project || 'New project').trim();
  const summary = (prod.oneliner || '').slice(0, 250) || undefined;
  const startDate = opts.startDate || intake.startDate || '';

  const labels = await ensureLabels(key, teamId);

  // 1. brand-new project
  const pr = await gql(key, 'mutation($input: ProjectCreateInput!){ projectCreate(input:$input){ success project{ id url } } }',
    { input: Object.assign({ name, teamIds: [teamId] }, summary ? { description: summary } : {}) });
  if (!pr.projectCreate || !pr.projectCreate.success) { const e = new Error('Linear project create failed'); e.status = 502; throw e; }
  const project = pr.projectCreate.project;

  // 2. milestones (with target dates) → name → { id }
  const intakeMs = (intake.milestones || []).filter((m) => m && (m.name || m.done));
  const msByName = {};
  for (const m of intakeMs) {
    const targetDate = weekTargetDate(startDate, m.target);
    const desc = [m.done ? 'Done means: ' + m.done : '', m.target ? 'Target: ' + m.target : ''].filter(Boolean).join('\n');
    const r = await gql(key, 'mutation($input: ProjectMilestoneCreateInput!){ projectMilestoneCreate(input:$input){ success projectMilestone{ id } } }',
      { input: Object.assign({ name: (m.name || 'Milestone').slice(0, 80), projectId: project.id, description: desc || undefined }, targetDate ? { targetDate } : {}) });
    if (r.projectMilestoneCreate && r.projectMilestoneCreate.success) msByName[m.name] = { id: r.projectMilestoneCreate.projectMilestone.id };
  }

  // 3. the plan: per-milestone parent issue + gov-labeled sub-issues.
  //    Prefer the AI plan; else group requirements by declared order.
  let plan = Array.isArray(opts.plan) && opts.plan.length ? opts.plan : null;
  if (!plan) {
    const reqs = (intake.requirements || []).filter((r) => r && r.title);
    plan = intakeMs.length
      ? intakeMs.map((m, i) => ({ milestone: m.name, issues: reqs.filter((_, j) => Math.min(j, intakeMs.length - 1) === i).map((r) => ({ title: r.title, detail: r.test, label: DEFAULT_GOV, priority: r.priority })) }))
      : [{ milestone: null, issues: reqs.map((r) => ({ title: r.title, detail: r.test, label: DEFAULT_GOV, priority: r.priority })) }];
  }

  let parents = 0, subs = 0;
  for (const entry of plan) {
    const ms = entry.milestone ? msByName[entry.milestone] : null;
    const issues = Array.isArray(entry.issues) ? entry.issues : [];
    const govIds = Array.from(new Set(issues.map((i) => i.label).filter(Boolean))).map((l) => govId(labels, l)).filter(Boolean);
    const parent = await createIssue(key, Object.assign({
      teamId, projectId: project.id, title: (entry.milestone || name).slice(0, 250),
      description: 'Milestone parent issue. Build tasks are linked as sub-issues — start them in order.',
      labelIds: govIds.length ? govIds : [govId(labels, DEFAULT_GOV)].filter(Boolean),
    }, ms ? { projectMilestoneId: ms.id } : {}));
    if (!parent) continue;
    parents++;
    for (const it of issues) {
      const ids = [govId(labels, it.label || DEFAULT_GOV), lid(labels, it.owner === 'Human' ? 'Human' : 'AI')].filter(Boolean);
      const ok = await createWithKickoff(key, Object.assign({
        teamId, projectId: project.id, parentId: parent.id,
        title: String(it.title || 'Task').slice(0, 250),
        priority: MoSCoW[it.priority] || 0,
        labelIds: ids,
      }, ms ? { projectMilestoneId: ms.id } : {}), stepsBody(it));
      if (ok) subs++;
    }
  }

  return { url: project.url, counts: { milestones: Object.keys(msByName).length, parents, issues: subs } };
}

module.exports = { listTeams, createProjectWithIssues, GOV_LABELS };
