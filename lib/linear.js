// ============================================================================
//  linear.js — create a project's tracker in Linear from the intake.
//
//  GraphQL (raw fetch, no SDK). The key is supplied per-request (from the GUI),
//  used transiently, never stored.
//
//  SAFETY: this ONLY ever creates a BRAND-NEW project, then adds milestones +
//  issues to it. It never writes into an existing project — so it cannot pollute
//  a tracker that already holds unrelated work.
// ============================================================================
'use strict';

const API = 'https://api.linear.app/graphql';

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

// List teams so the GUI can offer a picker (also validates the key).
async function listTeams(key) {
  const d = await gql(key, '{ teams(first: 100) { nodes { id key name } } }');
  return (d.teams && d.teams.nodes) || [];
}

const MoSCoW = { Must: 1, Should: 2, May: 3, "Won't": 4 }; // → Linear priority (1 urgent … 4 low)

// Create a NEW project + milestones + one issue per requirement (linked to a
// milestone where the requirement maps to one). Returns { url, counts }.
async function createProjectWithIssues(key, opts) {
  const teamId = String(opts.teamId || '').trim();
  if (!teamId) { const e = new Error('a Linear team is required'); e.status = 400; throw e; }
  const intake = opts.intake || {};
  const prod = intake.product || {};
  const name = (opts.name || prod.name || intake.project || 'New project').trim();
  const summary = (prod.oneliner || '').slice(0, 250) || undefined;

  // 1. brand-new project
  const projRes = await gql(key,
    'mutation($input: ProjectCreateInput!){ projectCreate(input:$input){ success project{ id url } } }',
    { input: Object.assign({ name, teamIds: [teamId] }, summary ? { description: summary } : {}) });
  if (!projRes.projectCreate || !projRes.projectCreate.success) { const e = new Error('Linear project create failed'); e.status = 502; throw e; }
  const project = projRes.projectCreate.project;

  // 2. milestones (in order) — keep ids to link issues
  const miles = (intake.milestones || []).filter((m) => m && (m.name || m.done));
  const milestoneIds = [];
  for (const m of miles) {
    const desc = [m.done ? 'Done means: ' + m.done : '', m.target ? 'Target: ' + m.target : ''].filter(Boolean).join('\n');
    const r = await gql(key,
      'mutation($input: ProjectMilestoneCreateInput!){ projectMilestoneCreate(input:$input){ success projectMilestone{ id } } }',
      { input: { name: (m.name || 'Milestone').slice(0, 80), projectId: project.id, description: desc || undefined } });
    milestoneIds.push(r.projectMilestoneCreate && r.projectMilestoneCreate.projectMilestone && r.projectMilestoneCreate.projectMilestone.id);
  }

  // 3. one issue per requirement, assigned to a milestone round-robin-ish by
  //    declared order if milestones exist (best-effort; owner can re-sort).
  const reqs = (intake.requirements || []).filter((r) => r && r.title);
  let made = 0;
  for (let i = 0; i < reqs.length; i++) {
    const r = reqs[i];
    const msId = milestoneIds.length ? milestoneIds[Math.min(i, milestoneIds.length - 1)] : undefined;
    const description = [
      r.test ? '**How you’d test it:** ' + r.test : '',
      r.priority ? '\nMoSCoW: ' + r.priority : '',
    ].join('');
    const input = {
      teamId, projectId: project.id, title: r.title.slice(0, 250),
      description: description || undefined,
      priority: MoSCoW[r.priority] || 0,
    };
    if (msId) input.projectMilestoneId = msId;
    const ir = await gql(key,
      'mutation($input: IssueCreateInput!){ issueCreate(input:$input){ success } }', { input });
    if (ir.issueCreate && ir.issueCreate.success) made++;
  }

  return { url: project.url, counts: { milestones: milestoneIds.filter(Boolean).length, issues: made } };
}

module.exports = { listTeams, createProjectWithIssues };
