// ============================================================================
//  render-intake.js — turn a project's PLAN-INTAKE into its OWN /docs content.
//
//  docs-kit scaffolds the donor (example) project's pages. This runs right after,
//  on the generated tree, and replaces the project-specific content with content
//  built from THIS project's intake — so a freshly generated/deployed site shows
//  only the wizard's project, never the donor's. It also rewires the nav + route
//  map + governance scrub so the link-checker still passes.
//
//  Pure string templating, no deps. Safe to run on any docs-kit tree.
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

// ─── helpers ─────────────────────────────────────────────────────────────────
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escA(s) { return esc(s).replace(/"/g, '&quot;'); }
function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'item'; }
function clean(rows, keys) { return (Array.isArray(rows) ? rows : []).filter((r) => r && keys.some((k) => String(r[k] || '').trim())); }
function mdEsc(s) { return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim(); }
function writeFile(p, body) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); }
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }

const PALETTE = ':root{--bg:#0E0E10;--panel:#161618;--panel2:#1C1C1F;--line:#2A2A2E;--line2:#3A3A40;--text:#E8E8E4;--text-dim:#C8C8C2;--muted:#9A9A95;--dim:#6A6A66;--accent:#97C459;--accent-br:#C0DD97;--amber:#E0A848;--violet:#A99BE0;--code:#1A1A1D;}';

// Plan-page styling — mirrors the Sequence live plan (milestone roll-up table,
// Gantt container, per-phase issue overview, status pills), mapped onto this
// project's palette.
const PLAN_CSS = `<style>
  .h2-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;}
  .h2-row h2{margin:0;}
  .h2-row .meta{font-size:11px;color:var(--muted);}
  section.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:22px 24px;margin:0 0 18px;}
  section.panel--accent{background:linear-gradient(180deg,rgba(151,196,89,0.06),var(--panel));border-color:#3f5a25;}
  .ms-table{width:100%;border-collapse:collapse;font-size:13px;}
  .ms-table th{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line);color:var(--muted);font-weight:600;font-size:10px;letter-spacing:.12em;text-transform:uppercase;}
  .ms-table td{padding:11px 8px;border-bottom:1px solid var(--line);color:var(--text-dim);vertical-align:top;}
  .ms-table tr:last-child td{border-bottom:none;}
  .ms-table .marker{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:8px;background:var(--panel2);border:1px solid var(--line2);font-size:11px;font-weight:700;color:var(--text);}
  .ms-table .name{color:var(--text);font-weight:600;}
  .ms-table .target{display:inline-block;padding:3px 8px;border-radius:999px;font-size:10px;letter-spacing:.06em;background:var(--panel2);border:1px solid var(--line2);color:var(--text-dim);}
  .gantt-wrap{background:#141417;border-radius:10px;padding:16px;overflow-x:auto;}
  .gantt-wrap .mermaid{background:transparent;min-width:760px;}
  .ov{display:flex;flex-direction:column;gap:22px;}
  .ov-ms-head{display:flex;align-items:baseline;gap:10px;margin:2px 0;}
  .ov-ms-head h3{font-size:15px;margin:0;color:var(--text);}
  .ov-ms-head .tgt{font-size:11px;color:var(--muted);}
  .ov-ms-head .bar{flex:1;height:1px;background:var(--line);}
  .ov-phase{border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-top:8px;}
  .ov-phase-head{display:flex;align-items:center;gap:10px;padding:9px 13px;background:var(--panel2);font-size:13px;font-weight:600;}
  .ov-phase-head .gloss{color:var(--muted);font-weight:400;}
  .ov-phase-head .ph-link{color:inherit;text-decoration:none;}
  .ov-phase-head .ph-link:hover{color:var(--accent-br);text-decoration:underline;}
  .ov-issue{display:grid;grid-template-columns:88px 1fr auto;gap:12px;align-items:center;padding:8px 13px;border-top:1px solid var(--line);font-size:13px;text-decoration:none;color:inherit;transition:background .12s;}
  a.ov-issue:hover{background:rgba(151,196,89,0.07);}
  .ov-issue .iid{color:var(--text-dim);font-weight:600;font-size:12px;white-space:nowrap;}
  .ov-issue .del{color:var(--text);}
  .own{font-size:9px;letter-spacing:.06em;text-transform:uppercase;padding:1px 6px;border-radius:999px;margin-left:6px;border:1px solid var(--line2);color:var(--muted);}
  .own-h{color:var(--amber);border-color:#7a5a1f;background:rgba(224,168,72,.10);}
  .own-ai{color:var(--accent-br);border-color:#3f5a25;background:rgba(151,196,89,.10);}
  .pill-st{font-size:10px;letter-spacing:.04em;text-transform:uppercase;padding:2px 9px;border-radius:999px;white-space:nowrap;border:1px solid var(--line2);color:var(--text-dim);}
  .pill-st.st-done{color:var(--accent-br);border-color:#3f5a25;background:rgba(151,196,89,.12);}
  .pill-st.st-prog{color:var(--violet);border-color:#423882;background:rgba(169,155,224,.12);}
  .pill-st.st-todo{color:var(--amber);border-color:#7a5a1f;background:rgba(224,168,72,.10);}
  .pill-st.st-back{color:var(--muted);border-color:var(--line2);background:var(--panel2);}
</style>`;

// Live status: rewrite each issue row's pill (and phase-head pill) from Linear
// via /api/status, matching the issue identifier in the row's href. Generic to
// any team prefix (SEQ-12, ACME-3, …). Falls back to the static pills if down.
const LIVE_STATUS_SCRIPT = `<script>
(async () => {
  try {
    const s = await (await fetch('/api/status')).json();
    if (!s || !s.ok) return;
    const by = {};
    (s.issues || []).forEach((i) => { by[i.id] = i; });
    const PILL = { completed:['st-done','Done'], started:['st-prog','In Progress'], unstarted:['st-todo','Todo'], backlog:['st-back','Backlog'], canceled:['st-back','Canceled'] };
    const idOf = (el) => ((el.getAttribute('href') || '').match(/issue\\/([A-Z]+-\\d+)/) || [])[1];
    const apply = (pill, it) => { if (!pill) return; const m = PILL[it.stateType] || ['st-back', it.state]; pill.className = 'pill-st ' + m[0]; pill.textContent = m[1]; };
    document.querySelectorAll('a.ov-issue').forEach((a) => { const it = by[idOf(a)]; if (!it) return; apply(a.querySelector('.pill-st'), it); });
    document.querySelectorAll('.ov-phase-head').forEach((h) => { const link = h.querySelector('a.ph-link'); if (!link) return; const it = by[idOf(link)]; if (!it) return; apply(h.querySelector('.pill-st'), it); });
  } catch (e) { /* keep static fallback */ }
})();
</script>`;

function htmlShell(title, intro, bodyHtml, extraHead) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escA(title)}</title>
${extraHead || ''}
<style>
  ${PALETTE}
  *{box-sizing:border-box;}
  body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;}
  .wrap{max-width:1040px;margin:0 auto;padding:30px 22px 90px;}
  h1{font-size:28px;margin:0 0 6px;letter-spacing:-.01em;}
  h2{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:38px 0 12px;}
  h3{font-size:15px;margin:0 0 4px;}
  a{color:var(--accent);text-decoration:none;} a:hover{color:var(--accent-br);}
  p.lead{color:var(--text-dim);max-width:74ch;margin:0 0 8px;font-size:16px;}
  .meta{color:var(--dim);font-size:13px;margin:0 0 8px;}
  code{background:var(--code);border:1px solid var(--line);border-radius:5px;padding:.1em .4em;font:13px/1.4 ui-monospace,"SF Mono",Menlo,monospace;}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin:0 0 16px;}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:15px;}
  .card h3{font-size:14px;margin:0 0 4px;} .card p{margin:0;font-size:13px;color:var(--muted);}
  .card .k{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);}
  table{border-collapse:collapse;width:100%;font-size:14px;margin:4px 0 0;}
  th{text-align:left;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);font-weight:600;padding:6px 10px 8px;border-bottom:1px solid var(--line);}
  td{padding:9px 10px;border-bottom:1px solid var(--line);color:var(--text-dim);vertical-align:top;}
  tr:last-child td{border-bottom:none;}
  .pill{display:inline-block;font-size:10px;letter-spacing:.04em;text-transform:uppercase;border-radius:999px;padding:2px 9px;border:1px solid var(--line2);color:var(--muted);white-space:nowrap;}
  .pill.must{color:var(--accent-br);border-color:#3f5a25;background:rgba(151,196,89,.10);}
  .pill.should{color:var(--amber);border-color:#7a5a1f;background:rgba(224,168,72,.10);}
  .pill.todo{color:var(--muted);background:var(--panel2);}
  .next-action .k{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--amber);margin-right:8px;}
  ul.dash{list-style:none;padding:0;margin:6px 0 0;} ul.dash li{padding:4px 0 4px 18px;position:relative;color:var(--text-dim);font-size:14px;}
  ul.dash li:before{content:"—";position:absolute;left:0;color:var(--dim);}
  .mermaid{background:#141417;border:1px solid var(--line);border-radius:12px;padding:16px;overflow-x:auto;margin:0 0 16px;}
  .foot{margin-top:48px;padding-top:16px;border-top:1px solid var(--line);color:var(--dim);font-size:12px;}
</style>
</head>
<body>
<!--DOCS_NAV-->
<div class="wrap">
  <h1>${esc(title)}</h1>
  ${intro ? '<p class="lead">' + esc(intro) + '</p>' : ''}
${bodyHtml}
  <div class="foot">Generated from this project's PLAN-INTAKE · <a href="/docs">docs hub</a></div>
</div>
</body>
</html>`;
}

function priClass(p) { return /must/i.test(p) ? 'must' : (/should/i.test(p) ? 'should' : ''); }

// ─── main ────────────────────────────────────────────────────────────────────
function render(genDir, intake, opts) {
  opts = opts || {};
  intake = intake || {};
  const prod = intake.product || {};
  const integ = intake.integrations || {};
  const docsDir = opts.docsDir || integ.docsDir || 'saas-launch';
  const root = path.join(genDir, docsDir);

  const name = (prod.name || intake.project || 'Project').trim();
  const domain = (prod.domain || '').trim();
  const oneliner = (prod.oneliner || '').trim();

  const reqs = clean(intake.requirements, ['title', 'test']);
  const decs = clean(intake.decisions, ['concern', 'choice', 'why']);
  const miles = clean(intake.milestones, ['name', 'done']);
  const risks = clean(intake.risks, ['risk', 'mitigation']);
  const scal = clean(intake.scalability, ['area', 'target', 'adr']);
  const notBuilding = String(prod.notBuilding || '').split('\n').map((s) => s.trim()).filter(Boolean);

  // Live Linear tracker (from createProjectWithIssues): { url, projectId,
  // phases:[{letter,name,milestone,parent:{identifier,url}, issues:[{identifier,url,title,owner,label}]}] }.
  // When present, the Plan page mirrors the Sequence live plan (milestone roll-up
  // + per-phase issue overview with live status pills via /api/status).
  const linear = opts.linear || null;

  // Stage-3 AI enrichment (Mermaid diagrams, Given/When/Then, ADR bodies). When
  // absent, pages fall back to the clean deterministic tables.
  const enrich = opts.enrich || null;
  const enReq = (enrich && enrich.requirements) || [];
  const enAdr = (enrich && enrich.adrs) || [];
  const findEn = (list, title, i) => list.find((x) => String(x.title || x.concern || '').trim().toLowerCase() === String(title || '').trim().toLowerCase()) || list[i];
  const MERMAID_HEAD = '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>\n<script>try{mermaid.initialize({startOnLoad:true,theme:"dark",themeVariables:{fontFamily:"-apple-system,system-ui,sans-serif"}});}catch(e){}</script>';

  // Stable ids for ADR + milestone files.
  const adrs = decs.map((d, i) => {
    const n = String(i + 1).padStart(3, '0');
    return { n, file: 'adr-' + n + '-' + slug(d.concern) + '.md', concern: d.concern || ('Decision ' + (i + 1)), choice: d.choice || '', why: d.why || '' };
  });
  const ms = miles.map((m, i) => {
    const key = (String(m.name || '').match(/\bM\d+\b/) || ['M' + (i + 1)])[0];
    return { key, file: key + '-' + slug(m.name || ('milestone-' + (i + 1))) + '.md', name: m.name || ('Milestone ' + (i + 1)), done: m.done || '', target: m.target || '' };
  });

  // ── 1. delete donor project-specific content ──
  rm(path.join(genDir, docsDir, 'app-store-mockups.html'));
  rm(path.join(genDir, docsDir, 'website-mockup.html'));
  for (const f of ['LAUNCH-PLAN.md', 'HOSTING-SETUP.md', 'DEPLOY-DOCS.md', 'WORKFLOW.md']) rm(path.join(root, f));
  rm(path.join(root, 'adr'));
  rm(path.join(root, 'milestones'));

  // ── 2. markdown corpus, rebuilt from the intake ──
  // REQUIREMENTS.md — table always; Given/When/Then acceptance criteria when enriched.
  const acBlocks = enrich ? reqs.map((r, i) => {
    const e = findEn(enReq, r.title, i) || {};
    if (!e.given && !e.when && !e.then) return '';
    return ['### ' + (i + 1) + '. ' + r.title + (r.priority ? '  · ' + r.priority : ''), '', '```',
      'Given ' + (e.given || '…'), 'When  ' + (e.when || '…'),
      ...String(e.then || '…').split('\n').map((t, j) => (j === 0 ? 'Then  ' : ' And  ') + t.replace(/^\s*(then|and)\s+/i, '')),
      '```', ''].join('\n');
  }).filter(Boolean) : [];
  const reqMd = [
    '# ' + name + ' — Requirements', '',
    oneliner ? '> ' + oneliner : '',
    '', '*Captured in the wizard. One row per requirement; priority is MoSCoW; the test is the plain-English check.*', '',
    '| # | Requirement | Priority | How you’d test it |',
    '|---|---|---|---|',
    ...reqs.map((r, i) => `| ${i + 1} | ${mdEsc(r.title)} | ${mdEsc(r.priority || '')} | ${mdEsc(r.test)} |`),
    '',
    acBlocks.length ? '## Acceptance criteria\n\n' + acBlocks.join('\n') : '',
    notBuilding.length ? '## Not building\n\n' + notBuilding.map((x) => '- ' + x).join('\n') + '\n' : '',
    '*See also: [Architecture](/docs/view/' + docsDir + '/ARCHITECTURE.md) · [Project plan](/docs/view/' + docsDir + '/PROJECT-PLAN.md) · [Decisions](/docs/view/' + docsDir + '/adr/README.md)*', '',
  ].join('\n');
  writeFile(path.join(root, 'REQUIREMENTS.md'), reqMd);

  // ARCHITECTURE.md (stack from decisions + non-functional)
  const archMd = [
    '# ' + name + ' — Architecture', '',
    '*Locked decisions and non-functional posture from the intake. Each decision has its own ADR under [`adr/`](/docs/view/' + docsDir + '/adr/README.md).*', '',
    '## Locked decisions', '',
    decs.length ? ['| Concern | Decision | Why |', '|---|---|---|', ...decs.map((d) => `| ${mdEsc(d.concern)} | ${mdEsc(d.choice)} | ${mdEsc(d.why)} |`)].join('\n')
      : '_No decisions captured yet._',
    '',
    scal.length ? ['## Non-functional & scale', '', '| Area | Target | Decision |', '|---|---|---|', ...scal.map((s) => `| ${mdEsc(s.area)} | ${mdEsc(s.target)} | ${mdEsc(s.adr)} |`)].join('\n') : '',
    '',
  ].join('\n');
  writeFile(path.join(root, 'ARCHITECTURE.md'), archMd);

  // PROJECT-PLAN.md (milestones)
  const planMd = [
    '# ' + name + ' — Project plan', '',
    '*Milestones in shipping order. "Done means" is the user-visible outcome.*', '',
    ms.length ? ['| Milestone | Done means | Target |', '|---|---|---|', ...ms.map((m) => `| ${mdEsc(m.name)} | ${mdEsc(m.done)} | ${mdEsc(m.target)} |`)].join('\n') : '_No milestones captured yet._',
    '',
    risks.length ? ['## Risks', '', '| Risk / constraint | Mitigation |', '|---|---|', ...risks.map((r) => `| ${mdEsc(r.risk)} | ${mdEsc(r.mitigation)} |`)].join('\n') : '',
    '',
  ].join('\n');
  writeFile(path.join(root, 'PROJECT-PLAN.md'), planMd);

  // INDEX.md (hub)
  const indexMd = [
    '# ' + name + ' — Project index', '',
    oneliner ? '> ' + oneliner : '',
    '', (prod.problem ? '**Problem.** ' + prod.problem + '\n' : ''),
    (prod.users ? '**Users.** ' + prod.users + '\n' : ''),
    (prod.differentiator ? '**Differentiator.** ' + prod.differentiator + '\n' : ''),
    '## Read these first', '',
    '- [Requirements](/docs/view/' + docsDir + '/REQUIREMENTS.md) — ' + reqs.length + ' requirements',
    '- [Architecture](/docs/view/' + docsDir + '/ARCHITECTURE.md) — ' + decs.length + ' decisions',
    '- [Project plan](/docs/view/' + docsDir + '/PROJECT-PLAN.md) — ' + ms.length + ' milestones',
    '- [Decisions (ADRs)](/docs/view/' + docsDir + '/adr/README.md)',
    '',
  ].join('\n');
  writeFile(path.join(root, 'INDEX.md'), indexMd);

  // ADRs
  const adrIndex = [
    '# Architecture Decision Records', '',
    '*One ADR per locked decision from the intake.*', '',
    adrs.length ? ['| # | Concern | Decision |', '|---|---|---|', ...adrs.map((a, i) => `| [ADR-${a.n}](/docs/view/${docsDir}/adr/${a.file}) | ${mdEsc(a.concern)} | ${mdEsc(a.choice)} |`)].join('\n') : '_No decisions captured yet._',
    '',
  ].join('\n');
  writeFile(path.join(root, 'adr', 'README.md'), adrIndex);
  for (let i = 0; i < adrs.length; i++) {
    const a = adrs[i];
    const e = enrich ? (findEn(enAdr, a.concern, i) || {}) : {};
    const lines = ['# ADR-' + a.n + ' · ' + a.concern, '', '- **Status:** Accepted', ''];
    if (e.context) lines.push('## Context', '', e.context, '');
    lines.push('## Decision', '', a.choice || '_(not specified)_', '');
    lines.push('## Trade-off accepted', '', e.tradeoff || a.why || '_(not specified)_', '');
    if (e.revisit) lines.push('## Revisit when', '', e.revisit, '');
    if (!enrich) lines.push('*A coding agent can expand this into full Context · Decision · Trade-off · Revisit-trigger.*', '');
    writeFile(path.join(root, 'adr', a.file), lines.join('\n'));
  }

  // Milestones
  for (const m of ms) {
    writeFile(path.join(root, 'milestones', m.file), [
      '# ' + m.name, '', m.target ? '**Target:** ' + m.target + '\n' : '',
      '## Done means', '', m.done || '_(not specified)_', '',
    ].join('\n'));
  }

  // ── 3. HTML pages, rebuilt from the intake ──
  // Home
  const productCards = [
    ['Problem', prod.problem], ['Users', prod.users], ['Differentiator', prod.differentiator],
    ['Experience', prod.experience], ['Success', prod.success],
  ].filter(([, v]) => String(v || '').trim())
    .map(([k, v]) => `<div class="card"><div class="k">${esc(k)}</div><p>${esc(v)}</p></div>`).join('');
  // Project status — every milestone starts "Not started"; next action = first one.
  var statusHtml = '';
  if (ms.length) {
    var nextName = ms[0].name;
    statusHtml =
      '<h2>Project status</h2>' +
      '<div class="panel"><div class="next-action"><span class="k">Next action</span> Start <b>' + esc(nextName) + '</b> — its first issue in the tracker.</div>' +
      '<table style="margin-top:12px"><thead><tr><th>Milestone</th><th>Target</th><th>Status</th></tr></thead><tbody>' +
      ms.map((m) => `<tr><td><b>${esc(m.name)}</b></td><td>${esc(m.target || '—')}</td><td><span class="pill todo">Not started</span></td></tr>`).join('') +
      '</tbody></table></div>';
  }
  const homeBody =
    (domain ? '<p class="meta">' + esc(domain) + '</p>' : '') +
    '<div class="grid">' + (productCards || '<div class="card"><p>Fill in the product details in the wizard.</p></div>') + '</div>' +
    statusHtml +
    '<h2>Explore</h2><p class="lead"><a href="/docs/plan">Plan</a> · <a href="/docs/requirements">Requirements</a> · <a href="/docs/architecture">Architecture</a> · <a href="/docs/build">Build</a> · <a href="/docs/view/' + docsDir + '/DESIGN.md">Design</a></p>' +
    (notBuilding.length ? '<h2>Not building</h2><ul class="dash">' + notBuilding.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '');
  writeFile(path.join(root, 'docs.html'), htmlShell(name + ' — project docs', oneliner, homeBody));

  // DESIGN.md — the experience/design intent from the intake.
  const designMd = [
    '# ' + name + ' — Design', '',
    oneliner ? '> ' + oneliner : '', '',
    prod.experience ? '## Experience bar\n\n' + prod.experience + '\n' : '',
    prod.differentiator ? '## What makes it different\n\n' + prod.differentiator + '\n' : '',
    prod.users ? '## Who it’s for\n\n' + prod.users + '\n' : '',
    '*Visual/interaction detail is the builder’s to choose under the quality baseline — see [Requirements](/docs/view/' + docsDir + '/REQUIREMENTS.md).*', '',
  ].join('\n');
  writeFile(path.join(root, 'DESIGN.md'), designMd);

  // Plan — mirrors the Sequence live plan page: a milestone roll-up, the Gantt,
  // and (when a Linear tracker was created) a per-phase issue overview whose
  // status pills render live from /api/status. Requirements live on their own
  // tab now (requirements.html), not here.
  const ganttHtml = (enrich && enrich.ganttMermaid)
    ? '<section class="panel"><div class="h2-row"><h2>Gantt — milestone view</h2><span class="meta">renders via Mermaid</span></div>' +
      '<div class="gantt-wrap"><pre class="mermaid">' + enrich.ganttMermaid + '</pre></div></section>' : '';

  const phases = (linear && Array.isArray(linear.phases)) ? linear.phases : [];
  const cleanMsName = (s) => String(s || '').replace(/^\s*M\d+\s*[·:.\-–]*\s*/i, '').trim() || String(s || '').trim();
  const msByClean = {};
  ms.forEach((m) => { msByClean[cleanMsName(m.name)] = m; });
  const liveByMs = {};
  phases.forEach((ph) => {
    const k = ph.milestone || '';
    (liveByMs[k] = liveByMs[k] || { phases: [], subs: 0 });
    liveByMs[k].phases.push(ph.letter);
    liveByMs[k].subs += (ph.issues || []).length;
  });
  const hasLive = phases.length > 0;

  // Milestone roll-up table.
  const msRollup = ms.length
    ? '<section class="panel panel--accent"><div class="h2-row"><h2>Milestones</h2>' +
      '<span class="meta">' + ms.length + ' milestone' + (ms.length === 1 ? '' : 's') +
        (hasLive ? ' · ' + phases.reduce((n, p) => n + (p.issues || []).length, 0) + ' sub-issues · live from Linear' : '') + '</span></div>' +
      '<table class="ms-table"><thead><tr><th></th><th>Milestone</th>' +
        (hasLive ? '<th>Phases</th><th>Subs</th>' : '') + '<th>Target</th><th>Done means</th></tr></thead><tbody>' +
      ms.map((m) => {
        const live = liveByMs[cleanMsName(m.name)];
        return '<tr><td><span class="marker">' + esc(m.key) + '</span></td>' +
          '<td class="name">' + esc(cleanMsName(m.name)) + '</td>' +
          (hasLive ? '<td>' + (live ? esc(live.phases.join(' + ')) : '—') + '</td><td>' + (live ? live.subs : '—') + '</td>' : '') +
          '<td>' + (m.target ? '<span class="target">' + esc(m.target) + '</span>' : '<span class="target">—</span>') + '</td>' +
          '<td>' + esc(m.done || '—') + '</td></tr>';
      }).join('') +
      '</tbody></table></section>'
    : '<p class="lead">No milestones captured yet.</p>';

  // Plan overview — only when a Linear tracker exists. Groups phases by milestone
  // (creation order), one ov-phase per phase, one ov-issue row per sub-issue.
  let planOverview = '';
  if (hasLive) {
    const groups = []; const gidx = {};
    phases.forEach((ph) => {
      const k = ph.milestone || name;
      if (gidx[k] == null) { gidx[k] = groups.length; groups.push({ ms: k, phases: [] }); }
      groups[gidx[k]].phases.push(ph);
    });
    const phaseGloss = (ph) => {
      const m = /^Phase\s+[A-Z]\s*[—\-–]\s*(.+)$/.exec(ph.name || '');
      return m ? m[1] : '';
    };
    const ownChip = (o) => '<span class="own own-' + (o === 'Human' ? 'h' : 'ai') + '">' + (o === 'Human' ? 'Human' : 'AI') + '</span>';
    const ovHtml = groups.map((g) => {
      const m = msByClean[g.ms];
      const head = (m ? esc(m.key) + ' · ' : '') + esc(g.ms);
      const tgt = m && m.target ? '<span class="tgt">target ' + esc(m.target) + '</span>' : '';
      const phasesHtml = g.phases.map((ph) => {
        const gloss = phaseGloss(ph);
        const pLink = ph.parent && ph.parent.url
          ? '<a class="ph-link" href="' + escA(ph.parent.url) + '" target="_blank" rel="noopener">Phase ' + esc(ph.letter) + '</a>'
          : '<span>Phase ' + esc(ph.letter) + '</span>';
        const issuesHtml = (ph.issues || []).map((it) =>
          '<a class="ov-issue" href="' + escA(it.url || '#') + '" target="_blank" rel="noopener">' +
          '<span class="iid">' + esc(it.identifier || '') + '</span>' +
          '<span class="del">' + esc(it.title) + ' ' + ownChip(it.owner) + '</span>' +
          '<span class="pill-st st-todo">Todo</span></a>').join('');
        return '<div class="ov-phase"><div class="ov-phase-head">' + pLink +
          (gloss ? '<span class="gloss">— ' + esc(gloss) + '</span>' : '') +
          '<span style="margin-left:auto"></span><span class="pill-st st-todo">Todo</span></div>' +
          issuesHtml + '</div>';
      }).join('');
      return '<div class="ov-ms"><div class="ov-ms-head"><h3>' + head + '</h3>' + tgt + '<span class="bar"></span></div>' + phasesHtml + '</div>';
    }).join('');
    planOverview = '<section class="panel"><div class="h2-row"><h2>Plan overview</h2>' +
      '<span class="meta">what each issue delivers · live status from Linear</span></div>' +
      '<div class="ov">' + ovHtml + '</div></section>';
  } else {
    planOverview = '<section class="panel"><div class="h2-row"><h2>Plan overview</h2>' +
      '<span class="meta">create a Linear tracker on “Build plan” to see live issue status here</span></div>' +
      '<p class="lead">No tracker linked yet — the milestone roll-up above reflects the intake.</p></section>';
  }

  const risksHtml = risks.length
    ? '<section class="panel"><div class="h2-row"><h2>Risks &amp; constraints</h2></div>' +
      '<table class="ms-table"><thead><tr><th>Risk / constraint</th><th>Mitigation</th></tr></thead><tbody>' +
      risks.map((r) => '<tr><td>' + esc(r.risk) + '</td><td>' + esc(r.mitigation) + '</td></tr>').join('') +
      '</tbody></table></section>' : '';

  const planBody = msRollup + ganttHtml + planOverview + risksHtml;
  const planHead = PLAN_CSS + (ganttHtml ? '\n' + MERMAID_HEAD : '') + '\n' + LIVE_STATUS_SCRIPT;
  writeFile(path.join(root, 'plan.html'), htmlShell(name + ' — build plan', 'Milestones, phases, and live issue status from the tracker.', planBody, planHead));

  // Requirements — its own tab, in the nice table format, with Given/When/Then
  // acceptance criteria when enriched and the "not building" boundary.
  const acHtml = enrich ? reqs.map((r, i) => {
    const e = findEn(enReq, r.title, i) || {};
    if (!e.given && !e.when && !e.then) return '';
    const then = String(e.then || '').split('\n').filter(Boolean);
    return '<div class="card" style="margin-bottom:10px"><div class="k">' + esc(r.title) + '</div>' +
      '<pre style="margin:6px 0 0;white-space:pre-wrap;font:13px/1.5 ui-monospace,Menlo,monospace;color:var(--text-dim)">' +
      'Given ' + esc(e.given || '…') + '\nWhen  ' + esc(e.when || '…') + '\n' +
      (then.length ? then.map((t, j) => (j === 0 ? 'Then  ' : ' And  ') + esc(t.replace(/^\s*(then|and)\s+/i, ''))).join('\n') : 'Then  …') +
      '</pre></div>';
  }).filter(Boolean).join('') : '';
  const reqBody =
    '<h2>Requirements</h2>' +
    (reqs.length ? '<div class="panel"><table><thead><tr><th>#</th><th>Requirement</th><th>Priority</th><th>How you’d test it</th></tr></thead><tbody>' +
      reqs.map((r, i) => `<tr><td>${i + 1}</td><td><b>${esc(r.title)}</b></td><td><span class="pill ${priClass(r.priority)}">${esc(r.priority || '')}</span></td><td>${esc(r.test)}</td></tr>`).join('') + '</tbody></table></div>'
      : '<p class="lead">No requirements captured yet.</p>') +
    (acHtml ? '<h2>Acceptance criteria</h2><p class="lead">Given / When / Then — the checks that prove each requirement is done.</p>' + acHtml : '') +
    (notBuilding.length ? '<h2>Not building</h2><p class="lead">The boundary the agent defends against scope creep.</p><ul class="dash">' + notBuilding.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '') +
    '<p class="meta" style="margin-top:14px">Full markdown: <a href="/docs/view/' + docsDir + '/REQUIREMENTS.md">REQUIREMENTS.md</a> · see also <a href="/docs/plan">Plan</a> · <a href="/docs/architecture">Architecture</a>.</p>';
  writeFile(path.join(root, 'requirements.html'), htmlShell(name + ' — requirements', 'Every requirement, its priority, and how you’d test it.', reqBody));

  // Architecture — Mermaid system diagram when enriched, then the stack tables.
  const diagramHtml = (enrich && enrich.architectureMermaid)
    ? '<h2>System diagram</h2><pre class="mermaid">' + enrich.architectureMermaid + '</pre>' +
      (enrich.architectureNote ? '<p class="lead">' + esc(enrich.architectureNote) + '</p>' : '') : '';
  const archBody =
    diagramHtml +
    '<h2>Locked decisions</h2>' +
    (decs.length ? '<div class="panel"><table><thead><tr><th>Concern</th><th>Decision</th><th>Why</th></tr></thead><tbody>' +
      decs.map((d) => `<tr><td><b>${esc(d.concern)}</b></td><td>${esc(d.choice)}</td><td>${esc(d.why)}</td></tr>`).join('') + '</tbody></table></div>'
      : '<p class="lead">No decisions captured yet.</p>') +
    (scal.length ? '<h2>Non-functional &amp; scale</h2><div class="panel"><table><thead><tr><th>Area</th><th>Target</th><th>Decision</th></tr></thead><tbody>' +
      scal.map((s) => `<tr><td><b>${esc(s.area)}</b></td><td>${esc(s.target)}</td><td>${esc(s.adr)}</td></tr>`).join('') + '</tbody></table></div>' : '') +
    '<p class="meta" style="margin-top:14px">Each decision has an ADR under <a href="/docs/view/' + docsDir + '/adr/README.md">Decisions</a>.</p>';
  writeFile(path.join(root, 'architecture.html'), htmlShell(name + ' — architecture', 'The locked stack and non-functional posture.', archBody, diagramHtml ? MERMAID_HEAD : ''));

  // Build (generic, project-named)
  const stackChips = decs.slice(0, 6).map((d) => esc(d.choice || d.concern)).filter(Boolean).join(' · ') || 'your chosen stack';
  const buildBody =
    '<h2>What we build with</h2><div class="grid">' +
    '<div class="card"><div class="k">Stack</div><h3>' + esc(stackChips) + '</h3><p>The locked decisions — see <a href="/docs/architecture">Architecture</a>.</p></div>' +
    '<div class="card"><div class="k">Discipline</div><h3>Governance library</h3><p>7 phase guides. <a href="/docs/claude-init">See the framework →</a></p></div>' +
    '<div class="card"><div class="k">Source of truth</div><h3>The intake</h3><p>Every page here is rendered from this project\'s PLAN-INTAKE.</p></div>' +
    '</div>' +
    '<h2>How to build it</h2><p class="lead">Pick a requirement from the <a href="/docs/plan">plan</a>, work it under the governance phases, and ship. The requirements doc is the contract.</p>';
  writeFile(path.join(root, 'build.html'), htmlShell(name + ' — build', 'How this project ships.', buildBody));

  // ── 4. rewire nav + routes + standalone server (live status) ──
  rewriteNav(genDir, { name, docsDir, adrs, ms });
  rewriteRoutes(genDir, { docsDir });
  if (linear && linear.projectId) rewriteServeDocs(genDir, linear.projectId);

  // ── 5. scrub residual donor brand tokens in kept generic files ──
  scrubBrand(genDir, { name, domain });

  return { requirements: reqs.length, decisions: decs.length, milestones: ms.length };
}

// Regenerate lib/docs-nav.js so the Reference dropdown points at the files we
// just wrote, the brand is the project, and the donor "Design" dropdown is gone.
function rewriteNav(genDir, ctx) {
  const navPath = path.join(genDir, 'lib', 'docs-nav.js');
  let src;
  try { src = fs.readFileSync(navPath, 'utf-8'); } catch { return; }
  const d = ctx.docsDir;
  const A = (href, label) => '  <a href="' + href + '">' + label + '</a>';
  const refLines = [
    '<details class="nav-dd"><summary>Reference ▾</summary><div class="nav-dd-menu">',
    '  <div class="nav-dd-lab">Dev governance library</div>',
    '  <a href="/docs/view/governance/CLAUDE.md">Governance overview</a>',
    '  <a href="/docs/library/00-library-guide">00 · Library guide</a>',
    '  <a href="/docs/library/01-requirements">01 · Requirements &amp; planning</a>',
    '  <a href="/docs/library/02-architecture">02 · Architecture</a>',
    '  <a href="/docs/library/03-design">03 · Design</a>',
    '  <a href="/docs/library/04-implementation">04 · Implementation</a>',
    '  <a href="/docs/library/05-review">05 · Review</a>',
    '  <a href="/docs/library/06-testing">06 · Testing</a>',
    '  <a href="/docs/library/07-release">07 · Release</a>',
    '  <div class="nav-dd-lab">Specs &amp; contracts</div>',
    '  <a href="/docs/view/AGENTS.md">AGENTS contract</a>',
    A('/docs/view/' + d + '/INDEX.md', 'Project index'),
    A('/docs/view/' + d + '/REQUIREMENTS.md', 'Requirements'),
    A('/docs/view/' + d + '/ARCHITECTURE.md', 'Architecture reference'),
    A('/docs/view/' + d + '/PROJECT-PLAN.md', 'Project plan'),
    A('/docs/view/' + d + '/DESIGN.md', 'Design'),
    '  <div class="nav-dd-lab">Decisions (ADRs)</div>',
    A('/docs/view/' + d + '/adr/README.md', 'ADR index'),
    ...ctx.adrs.map((a) => A('/docs/view/' + d + '/adr/' + a.file, a.n + ' · ' + a.concern)),
  ];
  if (ctx.ms.length) {
    refLines.push('  <div class="nav-dd-lab">Milestones</div>');
    for (const m of ctx.ms) refLines.push(A('/docs/view/' + d + '/milestones/' + m.file, m.key + ' · ' + m.name.replace(/^M\d+\s*[·:.-]?\s*/, '')));
  }
  refLines.push('</div></details>');
  const refDd = JSON.stringify(refLines.join('\n'));

  // Replace BRAND, REF_DD; neutralize DES_DD to empty; drop it from navHtml + navLinks.
  src = src.replace(/const BRAND\s*=\s*"[^]*?";/, 'const BRAND   = ' + JSON.stringify('<a href="/docs" style="color:#97C459;text-decoration:none;font-weight:600;margin-right:8px;">' + ctx.name + '&nbsp;docs</a>') + ';');
  src = src.replace(/const REF_DD\s*=\s*"[^]*?";/, 'const REF_DD  = ' + refDd + ';');
  src = src.replace(/const DES_DD\s*=\s*"[^]*?";/, 'const DES_DD  = "";');
  src = src.replace(/REF_DD \+ '\\n' \+ DES_DD \+ '\\n' \+ APP/, "REF_DD + '\\n' + APP");
  src = src.replace(/for \(const block of \[REF_DD, DES_DD\]\)/, 'for (const block of [REF_DD])');

  // Add a top-level "Requirements" tab (between Plan and Architecture).
  if (!/key: 'requirements'/.test(src)) {
    src = src.replace(/(\{ key: 'plan',[^}]*\},\n)/,
      "$1  { key: 'requirements', href: '/docs/requirements', label: 'Requirements' },\n");
  }
  fs.writeFileSync(navPath, src);
}

// Drop the two mockup rows from the route map and register the Requirements
// page, so routes / nav / check-docs stay in sync.
function rewriteRoutes(genDir, ctx) {
  const p = path.join(genDir, 'lib', 'docs-routes.js');
  let src;
  try { src = fs.readFileSync(p, 'utf-8'); } catch { return; }
  src = src.split('\n').filter((l) => !/website-mockup|app-store-mockups/.test(l)).join('\n');
  const d = (ctx && ctx.docsDir) || 'docs';
  if (!/\/docs\/requirements'/.test(src)) {
    const row = "  { path: '/docs/requirements',    file: '" + d + "/requirements.html', navKey: 'requirements', serves: 'Requirements — table + acceptance criteria + the not-building boundary' },\n";
    src = src.replace(/(\{ path: '\/docs\/plan',[^}]*\},\n)/, '$1' + row);
  }
  fs.writeFileSync(p, src);
}

// Point the standalone server's /docs mount at the freshly-created Linear
// project so the deployed app's live status (/api/status) tracks it. The API
// key is supplied at deploy time via the LINEAR_API_KEY env var.
function rewriteServeDocs(genDir, projectId) {
  const p = path.join(genDir, 'serve-docs.js');
  let src;
  try { src = fs.readFileSync(p, 'utf-8'); } catch { return; }
  // Anchor on the real statement at column 0 — not the `//   require(...)` usage
  // example in the header comment.
  src = src.replace(/^require\('\.\/lib\/docs-server'\)\(app\);/m,
    "require('./lib/docs-server')(app, { linearProjectId: " + JSON.stringify(projectId) + " });");
  fs.writeFileSync(p, src);
}

// Replace identifiable donor brand tokens in the generic files we keep
// (framework page, AGENTS, governance) — without mangling generic prose.
function scrubBrand(genDir, ctx) {
  const targets = ['claude_init.html', 'AGENTS.md', 'governance/CLAUDE.md'];
  try {
    const lib = path.join(genDir, 'governance', 'library');
    for (const f of fs.readdirSync(lib)) if (f.endsWith('.html')) targets.push('governance/library/' + f);
  } catch {}
  for (const rel of targets) {
    const fp = path.join(genDir, rel);
    let s;
    try { s = fs.readFileSync(fp, 'utf-8'); } catch { continue; }
    s = s.replace(/Sequence SaaS/g, ctx.name)
         .replace(/sequenceapp\.life/g, ctx.domain || (ctx.name.toLowerCase().replace(/[^a-z0-9]+/g, '') + '.app'))
         .replace(/\bSEQ-\d+\b/g, 'ISSUE')
         .replace(/ SaaS\b/g, '');
    fs.writeFileSync(fp, s);
  }
}

module.exports = { render };
