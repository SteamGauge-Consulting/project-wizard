// ============================================================================
//  governance-gate.js — the deterministic phase-end HUMAN close-out gate issue.
//
//  Every phase (milestone) ends with one "Review & merge the PR" Human issue,
//  labeled gov:phase-07-release, that a person must close before the milestone
//  is done. It carries a "✅ Human acceptance checklist" verified in the RUNNING
//  app before merge: a happy-path walk-through grounded in that phase's build
//  issues, an edge/negative case, a data-integrity/regression check, and a few
//  PR/diff spot-checks.
//
//  Built here (one source of truth) so BOTH issue-creation paths emit the same
//  gate: the AI plan (lib/enrich.js, with an AI-generated checklist) and the
//  no-AI fallback (lib/linear.js, with the deterministic templated checklist).
// ============================================================================
'use strict';

const GATE_LABEL = 'gov:phase-07-release';

// The standard PR/diff spot-checks — the same for every phase, appended to the
// checklist whether it was AI-generated or templated.
const PR_SPOT_CHECKS = [
  'Migration(s) in this PR actually applied — run them and confirm the schema matches (no pending or failed migration).',
  "Tests were added for this phase's new behavior and the full suite is green in CI.",
  'No secrets, API keys, or `.env` values in the diff, and no leftover debug / `console` logging.',
];

// Assemble the "✅ Human acceptance checklist" markdown section from its parts.
// parts: { happyPath: string[], edgeCase?: string, dataIntegrity?: string }.
// Always ends with the standard PR/diff spot-checks, so the section is complete
// even when only a happy path was supplied.
function checklistSection(parts) {
  const p = parts || {};
  const happy = (Array.isArray(p.happyPath) ? p.happyPath : []).map((s) => String(s || '').trim()).filter(Boolean);
  const out = [
    '## ✅ Human acceptance checklist — verify in the running app before merging',
    '',
    "_Run the app and confirm THIS phase's work end-to-end — do not merge on green CI alone._",
    '',
    '**Happy path** (this phase’s features, end-to-end)',
  ];
  (happy.length ? happy : ["Exercise each feature this phase shipped and confirm its done-when outcome in the UI."])
    .forEach((s) => out.push('- [ ] ' + s));
  out.push('', '**Edge / negative case**',
    '- [ ] ' + (String(p.edgeCase || '').trim() || 'Submit a key form with missing, invalid, or boundary input → a clear validation error appears and nothing is persisted.'));
  out.push('', '**Data integrity / regression**',
    '- [ ] ' + (String(p.dataIntegrity || '').trim() || "Earlier phases’ data still loads and adjacent features still work — this phase’s migration changed no column already in use."));
  out.push('', '**PR / diff spot-checks**');
  PR_SPOT_CHECKS.forEach((s) => out.push('- [ ] ' + s));
  return out.join('\n');
}

// Deterministic fallback checklist: ground the happy path in the milestone's own
// AI build issues (one line each, using the issue's done-when / acceptance text).
// Works for both the enrich issue shape ({title, doneWhen, objective}) and the
// no-AI fallback shape ({title, detail}). Used when the AI checklist pass is
// skipped or fails, so the section is ALWAYS present.
function templateChecklist(issues) {
  const build = (Array.isArray(issues) ? issues : []).filter((it) => it && it.owner !== 'Human' && it.title);
  const happyPath = build.map((it) => {
    const title = String(it.title).trim();
    const crit = it.doneWhen || it.detail || it.objective;
    return crit ? (title + ' — confirm: ' + String(crit).trim()) : title;
  }).slice(0, 12);
  return checklistSection({ happyPath: happyPath });
}

// The Human close-out gate issue for a milestone, with its acceptance checklist
// markdown attached (the `acceptance` field is rendered as its own section by
// lib/linear.js richBody, below the boilerplate).
function closeoutGate(milestoneName, acceptance) {
  const name = String(milestoneName || 'this milestone');
  return {
    owner: 'Human',
    title: 'Review & merge the PR for "' + name + '"',
    objective: "Human close-out gate — review the milestone's changes and merge the PR; the milestone is not done until this is closed.",
    steps: [
      "Open the pull request for this milestone's branch against `main` (push it first if the agent has not).",
      'Work through the ✅ Human acceptance checklist below in the RUNNING app — every box must be checked before you merge.',
      "Review the full diff and confirm the milestone's done-when acceptance criteria are met.",
      'Confirm CI and the cross-examiner gate pass on the PR.',
      "Merge the PR, delete the branch, and close the milestone's issues.",
    ],
    notes: 'The human sign-off that closes the milestone — do not skip it even if the work looks complete. The acceptance checklist below is the minimum bar: verify it against the live app, not just the diff.',
    doneWhen: "The acceptance checklist passes in the running app and the milestone's PR is merged to `main` with its issues closed.",
    label: GATE_LABEL,
    acceptance: acceptance || checklistSection({}),
  };
}

module.exports = { GATE_LABEL, PR_SPOT_CHECKS, checklistSection, templateChecklist, closeoutGate };
