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

// Find-or-create labels for this team (governance + owner + any extra names,
// e.g. the dynamic Phase A/B/… labels); return name → id.
async function ensureLabels(key, teamId, extraNames) {
  const d = await gql(key, 'query($id:String!){ team(id:$id){ labels(first:250){ nodes{ id name } } } }', { id: teamId });
  const existing = {};
  ((d.team && d.team.labels && d.team.labels.nodes) || []).forEach((l) => { existing[l.name] = l.id; });
  const map = {};
  const colors = { Human: '#e0a848', AI: '#97c459' };
  const names = GOV_LABELS.concat(OWNER_LABELS).concat(extraNames || []);
  for (const name of names) {
    if (existing[name]) { map[name] = existing[name]; continue; }
    try {
      const r = await gql(key, 'mutation($input: IssueLabelCreateInput!){ issueLabelCreate(input:$input){ success issueLabel{ id name } } }',
        { input: { name, teamId, color: colors[name] || (/^Phase /.test(name) ? '#6e79d6' : '#5e6ad2') } });
      if (r.issueLabelCreate && r.issueLabelCreate.success) map[name] = r.issueLabelCreate.issueLabel.id;
    } catch (e) { /* concurrent create / name clash — fallbacks cover it */ }
  }
  return map;
}

function phaseLetter(i) { return String.fromCharCode(65 + i); }       // A, B, C, …
function phaseName(i) { return 'Phase ' + phaseLetter(i); }
function cleanMs(name) {
  // Strip a leading "Phase X — " (our milestone/parent naming) and/or "M1 ·" so the
  // bare milestone name resolves against the intake (target dates, M-number label).
  const s = String(name || '').replace(/^\s*Phase\s+[A-Z]+\s*[—\-–]\s*/i, '').replace(/^\s*M\d+\s*[·:.\-–]*\s*/i, '').trim();
  return s || String(name || '').trim();
}

function govId(map, label) { return map[label] || map[DEFAULT_GOV] || undefined; }
function lid(map, name) { return map[name] || undefined; }

// A sub-issue's body: objective + full ordered steps + execution notes + the
// acceptance check. Owner-tailored detail comes from the AI plan.
function richBody(it) {
  const out = [];
  const objective = it.objective || it.detail;
  if (objective) out.push('**Objective:** ' + String(objective), '');
  const steps = Array.isArray(it.steps) ? it.steps.filter(Boolean) : [];
  if (steps.length) { out.push('**Steps:**'); steps.forEach((s) => out.push('- [ ] ' + String(s))); out.push(''); }
  if (it.notes && String(it.notes).trim()) out.push('**Notes:**', String(it.notes), '');
  if (it.doneWhen && String(it.doneWhen).trim()) out.push('**Done when:** ' + String(it.doneWhen));
  return out.join('\n').trim();
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
  const r = await gql(key, 'mutation($input: IssueCreateInput!){ issueCreate(input:$input){ success issue{ id identifier url } } }', { input });
  return r.issueCreate && r.issueCreate.success ? r.issueCreate.issue : null;
}

// Create an issue, then prepend an owner-appropriate kickoff line. AI issues get the
// `start <ID>` Claude kickoff; HUMAN / owner-action issues do NOT (a person does those —
// accounts, infra, secrets, approvals — there's no Claude to start), so they get a
// human-action header instead.
async function createWithKickoff(key, input, body, owner) {
  const issue = await createIssue(key, Object.assign({}, input, body ? { description: body } : {}));
  if (issue && issue.identifier) {
    const head = owner === 'Human'
      ? '**▶ Human / owner-action task** — a person completes this (accounts, infrastructure, secrets, approvals, manual verification); it is NOT a Claude `start` task. Coordinate with IT where the steps say so, and record any secrets in your secret manager.'
      : '**▶ To build this, tell Claude:** `start ' + issue.identifier + '`  _(Claude: read AGENTS.md + the governance library first, then follow the defined workflow.)_';
    const full = head + '\n\n' + (body || '');
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

  // Compute the plan first so we know how many phases (→ phase labels) to make.
  const intakeMs = (intake.milestones || []).filter((m) => m && (m.name || m.done));
  let plan = Array.isArray(opts.plan) && opts.plan.length ? opts.plan : null;
  if (!plan) {
    // No AI enrichment plan available (the build ran without a successful AI step),
    // so there's no step-by-step runbook to write. Still split Human vs AI by the
    // task's nature instead of tagging everything AI: anything that needs a person
    // (accounts, keys, DNS/billing/domains, approvals, manual verification) is Human.
    const HUMAN_RE = /\b(sign[- ]?up|signup|account|register|registrat|api[- ]?key|secret|credential|token|o?auth app|dns|domain|billing|payment|invoice|purchase|subscrib|stripe|paypal|approv|manual|verif|provision|kyc|legal|contract|vendor|procure|set up an? account|create an? account|connect (your|the))/i;
    const ownerOf = (r) => HUMAN_RE.test((r.title || '') + ' ' + (r.test || '')) ? 'Human' : 'AI';
    const toIssue = (r) => ({ title: r.title, detail: r.test, label: DEFAULT_GOV, owner: ownerOf(r) });
    const reqs = (intake.requirements || []).filter((r) => r && r.title);
    plan = intakeMs.length
      ? intakeMs.map((m, i) => ({ milestone: m.name, issues: reqs.filter((_, j) => Math.min(j, intakeMs.length - 1) === i).map(toIssue) }))
      : [{ milestone: null, issues: reqs.map(toIssue) }];
  }

  // Order the plan by the intake's milestone order so phases come out A,B,… = M1,M2,…
  // (the model occasionally emits the milestones reversed); map each milestone to its
  // phase letter for naming the milestone + parent + the A-NN sub-issue titles.
  if (intakeMs.length) {
    const idx = {}; intakeMs.forEach((m, i) => { idx[m.name] = i; });
    plan = plan.slice().sort((a, b) => ((a.milestone in idx ? idx[a.milestone] : 999) - (b.milestone in idx ? idx[b.milestone] : 999)));
  }
  const msLetter = {};
  plan.forEach((e, i) => { if (e.milestone && !(e.milestone in msLetter)) msLetter[e.milestone] = phaseLetter(i); });

  // No per-phase "Phase A" labels — the title prefix (A-01…) + "Phase X" naming carry
  // the phase + order. (The gov:phase-NN labels stay — a different, useful axis.)
  const labels = await ensureLabels(key, teamId, []);

  // brand-new project
  const pr = await gql(key, 'mutation($input: ProjectCreateInput!){ projectCreate(input:$input){ success project{ id url } } }',
    { input: Object.assign({ name, teamIds: [teamId] }, summary ? { description: summary } : {}) });
  if (!pr.projectCreate || !pr.projectCreate.success) { const e = new Error('Linear project create failed'); e.status = 502; throw e; }
  const project = pr.projectCreate.project;

  // milestones (with target dates) → name → { id }. Named "Phase X — <name>" to
  // match the parent issue titles (keyed internally by the original intake name).
  const msByName = {};
  let msOrder = 0;
  for (const m of intakeMs) {
    const targetDate = weekTargetDate(startDate, m.target);
    const desc = [m.done ? 'Done means: ' + m.done : '', m.target ? 'Target: ' + m.target : ''].filter(Boolean).join('\n');
    const letter = msLetter[m.name];
    const msName = ((letter ? 'Phase ' + letter + ' — ' : '') + cleanMs(m.name)).slice(0, 80);
    const r = await gql(key, 'mutation($input: ProjectMilestoneCreateInput!){ projectMilestoneCreate(input:$input){ success projectMilestone{ id } } }',
      { input: Object.assign({ name: msName, projectId: project.id, sortOrder: msOrder++, description: desc || undefined }, targetDate ? { targetDate } : {}) });
    if (r.projectMilestoneCreate && r.projectMilestoneCreate.success) msByName[m.name] = { id: r.projectMilestoneCreate.projectMilestone.id };
  }

  // Phases: one parent issue per plan entry ("Phase A — …"); build tasks are
  // gov + owner-labeled sub-issues titled "A-01 …", "A-02 …" so everything sorts
  // by title. No priority is set (everything stays "No priority").
  let parents = 0, subs = 0, issueOrder = 0, subNum = 0;   // subNum → the running A-NN number
  const phases = [];   // for the docs plan page — mirrors the Sequence live plan
  for (let i = 0; i < plan.length; i++) {
    const entry = plan[i];
    const ms = entry.milestone ? msByName[entry.milestone] : null;
    const issues = Array.isArray(entry.issues) ? entry.issues : [];
    const govIds = Array.from(new Set(issues.map((x) => x.label).filter(Boolean))).map((l) => govId(labels, l)).filter(Boolean);
    const phaseTitle = ('Phase ' + phaseLetter(i) + (entry.milestone ? ' — ' + cleanMs(entry.milestone) : (name ? ' — ' + name : ''))).slice(0, 250);
    const parent = await createIssue(key, Object.assign({
      teamId, projectId: project.id, title: phaseTitle, sortOrder: issueOrder++,
      description: 'Phase parent issue. Build tasks are linked as sub-issues — start them in order.',
      labelIds: (govIds.length ? govIds : [govId(labels, DEFAULT_GOV)]).filter(Boolean),
    }, ms ? { projectMilestoneId: ms.id } : {}));
    if (!parent) continue;
    parents++;
    const phaseEntry = {
      letter: phaseLetter(i),
      name: phaseTitle,
      milestone: entry.milestone ? cleanMs(entry.milestone) : null,
      parent: { title: phaseTitle, identifier: parent.identifier, url: parent.url },
      issues: [],
    };
    for (const it of issues) {
      subNum++;
      const owner = it.owner === 'Human' ? 'Human' : 'AI';
      const numbered = (phaseLetter(i) + '-' + String(subNum).padStart(2, '0') + ' ' + String(it.title || 'Task')).slice(0, 250);
      const ids = [govId(labels, it.label || DEFAULT_GOV), lid(labels, owner)].filter(Boolean);
      const created = await createWithKickoff(key, Object.assign({
        teamId, projectId: project.id, parentId: parent.id, sortOrder: issueOrder++,
        title: numbered,
        labelIds: ids,
      }, ms ? { projectMilestoneId: ms.id } : {}), richBody(it), owner);
      if (created) {
        subs++;
        phaseEntry.issues.push({
          title: numbered,
          identifier: created.identifier,
          url: created.url,
          owner: owner,
          label: it.label || DEFAULT_GOV,
        });
      }
    }
    phases.push(phaseEntry);
  }

  return {
    url: project.url,
    projectId: project.id,
    counts: { milestones: Object.keys(msByName).length, phases: parents, issues: subs },
    phases: phases,
  };
}

// ─── live-edit / apply-changes write helpers ─────────────────────────────────

// Load a project's team + issues (with internal uuid, identifier, state) and the
// team's workflow states — everything apply-changes needs to comment on, update,
// cancel, or create issues. Returns { projectName, teamId, issues[], states[] }.
async function loadProject(key, projectId) {
  const d = await gql(key,
    'query($id:String!){ project(id:$id){ name teams(first:1){ nodes{ id } } issues(first:250){ nodes{ id identifier title url state{ name type } } } } }',
    { id: projectId });
  const proj = d.project;
  if (!proj) { const e = new Error('Linear project not found'); e.status = 404; throw e; }
  const teamId = (proj.teams && proj.teams.nodes && proj.teams.nodes[0] && proj.teams.nodes[0].id) || null;
  let states = [];
  if (teamId) {
    try {
      const s = await gql(key, 'query($id:String!){ team(id:$id){ states(first:50){ nodes{ id name type } } } }', { id: teamId });
      states = (s.team && s.team.states && s.team.states.nodes) || [];
    } catch (e) { /* states optional */ }
  }
  const issues = ((proj.issues && proj.issues.nodes) || []).map((n) => ({
    id: n.id, identifier: n.identifier, title: n.title,
    stateName: (n.state && n.state.name) || 'Unknown',
    stateType: (n.state && n.state.type) || 'unknown',
  }));
  return { projectName: proj.name, teamId, issues, states };
}

// Read an EXISTING project's structure into the SAME shape createProjectWithIssues
// returns, so the docs Plan page can render the live per-phase overview WITHOUT
// creating or modifying anything. Phases = parent issues (those with sub-issues),
// ordered by sortOrder; each phase's issues = its sub-issues. Purely read-only.
async function loadProjectStructure(key, projectId) {
  const d = await gql(key,
    'query($id:String!){ project(id:$id){ name url issues(first:250){ nodes{ ' +
    'identifier title url sortOrder parent{ identifier } projectMilestone{ name } ' +
    'labels{ nodes{ name } } } } } }',
    { id: projectId });
  const proj = d.project;
  if (!proj) { const e = new Error('Linear project not found'); e.status = 404; throw e; }
  const nodes = (proj.issues && proj.issues.nodes) || [];
  const childrenOf = {};
  nodes.forEach((n) => { const par = n.parent && n.parent.identifier; if (par) (childrenOf[par] = childrenOf[par] || []).push(n); });
  const labelsOf = (n) => ((n.labels && n.labels.nodes) || []).map((l) => l.name);
  // Deduce owner from the TASK, not the assignee (issues get reassigned to
  // whoever closed them). A 🔑-prefixed or gov:owner-action task — sign-ups,
  // minting keys, DNS, billing/account setup — needs a person → Human; the rest
  // are code/docs/tests an agent can do → AI.
  const ownerOf = (n) => (labelsOf(n).indexOf('Human') !== -1 || /🔑/.test(n.title || '') || labelsOf(n).indexOf('gov:owner-action') !== -1) ? 'Human' : 'AI';
  const govOf = (n) => labelsOf(n).find((x) => /^gov:/.test(x)) || DEFAULT_GOV;
  // Sort by TITLE — parents are "Phase A — …", "Phase B — …" and sub-issues are
  // "A-01 …", "A-02 …", so title order = build order. Grouping is still by parent
  // (childrenOf), so sub-issues stay nested under their phase; this only reorders
  // within each level. (numeric:true so A-2 < A-10 even without zero-padding.)
  const byTitle = (a, b) => String(a.title || '').localeCompare(String(b.title || ''), undefined, { numeric: true, sensitivity: 'base' });
  const parents = nodes.filter((n) => childrenOf[n.identifier]).sort(byTitle);
  let subs = 0; const msSet = {};
  const phases = parents.map((par, i) => {
    const kids = (childrenOf[par.identifier] || []).slice().sort(byTitle);
    const ms = (par.projectMilestone && par.projectMilestone.name)
      || (kids[0] && kids[0].projectMilestone && kids[0].projectMilestone.name) || null;
    if (ms) msSet[ms] = 1;
    const issues = kids.map((k) => {
      subs++;
      // owner is derived from the original title (🔑 = owner-action); strip the 🔑
      // from the DISPLAY title since the Human tag now conveys the same thing.
      return { title: String(k.title || '').replace(/🔑️?/g, '').replace(/\s{2,}/g, ' ').trim(),
        identifier: k.identifier, url: k.url, owner: ownerOf(k), label: govOf(k) };
    });
    return { letter: phaseLetter(i), name: par.title, milestone: ms ? cleanMs(ms) : null,
      parent: { title: par.title, identifier: par.identifier, url: par.url }, issues: issues };
  });
  return { url: proj.url, projectId: projectId,
    counts: { milestones: Object.keys(msSet).length, phases: phases.length, issues: subs }, phases: phases };
}

async function addComment(key, issueId, bodyMd) {
  const r = await gql(key, 'mutation($input: CommentCreateInput!){ commentCreate(input:$input){ success } }',
    { input: { issueId, body: bodyMd } });
  return !!(r.commentCreate && r.commentCreate.success);
}

// Update an existing issue's description by APPENDING a change note (keeps the
// original runbook intact) and drop a comment recording the Change ID.
async function updateIssue(key, issue, changeId, detail) {
  let current = '';
  try { const d = await gql(key, 'query($id:String!){ issue(id:$id){ description } }', { id: issue.id }); current = (d.issue && d.issue.description) || ''; }
  catch (e) {}
  const note = '\n\n---\n**' + changeId + ' update:** ' + detail;
  await gql(key, 'mutation($id:String!,$input:IssueUpdateInput!){ issueUpdate(id:$id, input:$input){ success } }',
    { id: issue.id, input: { description: (current + note).slice(0, 60000) } });
  await addComment(key, issue.id, '**' + changeId + '** updated this issue: ' + detail).catch(() => {});
  return true;
}

// Cancel (archive-style) an issue by moving it to the team's `canceled` workflow
// state and commenting the Change ID + reason. Reversible; keeps history.
async function cancelIssue(key, issue, states, changeId, reason) {
  const canceled = (states || []).find((s) => s.type === 'canceled');
  if (canceled) {
    await gql(key, 'mutation($id:String!,$input:IssueUpdateInput!){ issueUpdate(id:$id, input:$input){ success } }',
      { id: issue.id, input: { stateId: canceled.id } });
  }
  await addComment(key, issue.id, '**' + changeId + '** cancelled this issue as obsolete: ' + reason).catch(() => {});
  return true;
}

// Create a brand-new issue in an existing project (from an accepted change),
// gov + owner labeled, with the start-id kickoff and a Change ID note.
async function createIssueForChange(key, opts) {
  const { teamId, projectId, title, owner, label, objective, reason, changeId } = opts;
  const labels = await ensureLabels(key, teamId, []);
  const ids = [govId(labels, label || DEFAULT_GOV), lid(labels, owner === 'Human' ? 'Human' : 'AI')].filter(Boolean);
  const body = richBody({ objective, notes: reason }) + '\n\n_Created by ' + changeId + '._';
  const issue = await createWithKickoff(key, {
    teamId, projectId, title: String(title || 'New task').slice(0, 250), labelIds: ids,
  }, body, owner === 'Human' ? 'Human' : 'AI');
  return issue;
}

module.exports = {
  listTeams, createProjectWithIssues, GOV_LABELS,
  loadProject, loadProjectStructure, addComment, updateIssue, cancelIssue, createIssueForChange,
};
