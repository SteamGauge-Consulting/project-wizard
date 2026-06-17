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
  .ms-table .name{color:var(--text);font-weight:600;white-space:nowrap;}
  .ms-table .target{display:inline-block;padding:3px 8px;border-radius:999px;font-size:10px;letter-spacing:.06em;background:var(--panel2);border:1px solid var(--line2);color:var(--text-dim);white-space:nowrap;}
  .ms-table td:last-child{width:42%;}
  .ms-table th:nth-child(2),.ms-table td:nth-child(2){white-space:nowrap;}
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

// Home landing: fill the four framework-phase pills, the milestone rollup bar,
// and the active milestone from /api/status (overall + per-milestone done/total).
const HOME_LIVE_SCRIPT = `<script>
(async () => {
  try {
    const s = await (await fetch('/api/status')).json();
    if (!s || !s.ok) return;
    const ov = s.overall || { done: 0, total: 0 };
    const mof = (n) => (s.milestones || {})[n];
    const pct = (d, t) => t ? Math.round(d * 100 / t) : 0;
    const bar = document.getElementById('ms-bar'); if (bar) bar.style.width = pct(ov.done, ov.total) + '%';
    let active = null;
    document.querySelectorAll('.ms-stop[data-ms]').forEach((el) => {
      const m = mof(el.getAttribute('data-ms'));
      if (m && !active && m.done < m.total) { active = el.getAttribute('data-ms'); el.classList.add('active'); }
    });
    const sum = document.getElementById('ms-summary');
    if (sum) sum.innerHTML = (active ? '<strong>' + active + '</strong> in progress.' : 'All milestones complete.') + ' Overall <strong>' + ov.done + ' / ' + ov.total + '</strong> sub-issues done.';
    document.querySelectorAll('.hs-phase[data-ms]').forEach((el) => {
      const spec = el.getAttribute('data-ms'); const future = el.getAttribute('data-future');
      let d = 0, t = 0;
      if (spec === '*') { d = ov.done; t = ov.total; } else { const m = mof(spec); if (m) { d = m.done; t = m.total; } }
      const pill = el.querySelector('.hs-pill'); if (!pill) return;
      const set = (c, txt) => { pill.className = 'hs-pill ' + c; pill.textContent = txt; el.classList.remove('done', 'warn'); if (c === 'done') el.classList.add('done'); else if (c === 'warn') el.classList.add('warn'); };
      if (!t) { set(future ? 'future' : 'todo', future ? '⏳ Upcoming' : '· Not started'); return; }
      if (d >= t) set('done', '✓ Complete');
      else if (d > 0) set('warn', '▶ In progress — ' + d + '/' + t);
      else set(future ? 'future' : 'todo', future ? '⏳ Upcoming' : '· Not started');
    });
  } catch (e) {}
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
  .arch-wrap{background:#141417;border:1px solid var(--line);border-radius:12px;padding:20px 16px 14px;margin:0 0 16px;}
  /* Scope the fit-to-width centering to the ARCH diagram only — the gantt keeps
     its natural min-width + horizontal scroll (see PLAN_CSS .gantt-wrap). */
  .arch-wrap .mermaid{overflow-x:auto;min-height:60px;}
  /* Fill the panel width (Mermaid sets an inline max-width at its natural size,
     which leaves the diagram small + lots of empty space) so text reads larger. */
  .arch-wrap .mermaid svg{width:100%!important;max-width:100%!important;height:auto;display:block;margin:0 auto;}
  .arch-legend{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:14px;padding-top:12px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);}
  .arch-legend .lg{display:inline-flex;align-items:center;}
  .arch-legend .lg:before{content:"";width:11px;height:11px;border-radius:3px;margin-right:7px;border:1px solid;}
  .arch-legend .app:before{background:#1b2412;border-color:#639922;}
  .arch-legend .saas:before{background:#1f1b30;border-color:#534AB7;}
  .arch-legend .data:before{background:#15212a;border-color:#3E7EA0;}
  .arch-legend .edge:before{background:#15171a;border-color:#3A3A40;}
  .arch-legend .infra:before{background:#2a2212;border-color:#876318;}
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
  // Themed to blend into the dark docs page: transparent canvas, the page's
  // line/text colors, htmlLabels so node labels can be multi-line (name + role +
  // tech/ADR like the reference architecture). The colour-coding per node comes
  // from the classDef palette injected by archThemed() below.
  const MERMAID_HEAD = '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>\n' +
    '<script>try{mermaid.initialize({startOnLoad:true,securityLevel:"loose",theme:"base",' +
    'themeVariables:{fontFamily:"-apple-system,system-ui,sans-serif",fontSize:"15px",background:"transparent",' +
    'primaryColor:"#161618",primaryBorderColor:"#3A3A40",primaryTextColor:"#E8E8E4",lineColor:"#5A5A60",' +
    'textColor:"#C8C8C2",clusterBkg:"rgba(255,255,255,.02)",clusterBorder:"#2A2A2E",edgeLabelBackground:"#141417",' +
    'titleColor:"#9A9A95",' +
    // gantt-specific (base theme drops sane gantt defaults — supply the dark palette)
    'sectionBkgColor:"rgba(255,255,255,.03)",altSectionBkgColor:"transparent",sectionBkgColor2:"rgba(255,255,255,.05)",' +
    'taskBkgColor:"#2b2f36",taskBorderColor:"#3A3A40",taskTextColor:"#E8E8E4",taskTextLightColor:"#E8E8E4",' +
    'taskTextDarkColor:"#E8E8E4",taskTextOutsideColor:"#C8C8C2",activeTaskBkgColor:"#2a2212",activeTaskBorderColor:"#876318",' +
    'doneTaskBkgColor:"#1b2412",doneTaskBorderColor:"#639922",critBkgColor:"#3a1d1d",critBorderColor:"#a05a5a",' +
    'gridColor:"#2A2A2E",todayLineColor:"#E0A848",sectionTextColor:"#C8C8C2"},' +
    'flowchart:{htmlLabels:true,curve:"basis",nodeSpacing:40,rankSpacing:54,padding:8}});}catch(e){}</script>';

  // Inject our fixed colour palette (matching the reference architecture: green =
  // our app, violet = third-party SaaS, blue = data, amber = CI/CD, grey = edge)
  // right after the `flowchart` header, so the diagram's colours are owned by us
  // regardless of what the model emits — it only assigns nodes to these classes.
  const ARCH_CLASSDEFS = [
    'classDef actor fill:#161618,stroke:#3A3A40,color:#E8E8E4,rx:7,ry:7;',
    'classDef edge fill:#15171a,stroke:#3A3A40,color:#C8C8C2,rx:7,ry:7;',
    'classDef app fill:#1b2412,stroke:#639922,color:#C0DD97,stroke-width:1.5px,rx:7,ry:7;',
    'classDef saas fill:#1f1b30,stroke:#534AB7,color:#A99BE0,rx:7,ry:7;',
    'classDef data fill:#15212a,stroke:#3E7EA0,color:#8FC5E0,rx:7,ry:7;',
    'classDef infra fill:#2a2212,stroke:#876318,color:#E0A848,rx:7,ry:7;',
  ].join('\n  ');
  const archThemed = (mmd) => {
    const lines = String(mmd || '').split('\n');
    let i = 0; while (i < lines.length && !lines[i].trim()) i++;       // skip blanks
    if (i >= lines.length) return mmd;
    lines.splice(i + 1, 0, '  ' + ARCH_CLASSDEFS);                     // after `flowchart …`
    return lines.join('\n');
  };

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
  // Home — canonical hub: centered hero, four framework-phase cards, and a
  // milestone rollup. The phase pills + rollup bar + active milestone are filled
  // live from /api/status (HOME_LIVE_SCRIPT); build-time render is the fallback.
  const totalSubs = (linear && Array.isArray(linear.phases)) ? linear.phases.reduce((n, ph) => n + ((ph.issues || []).length), 0) : 0;
  const firstMs = ms.length ? ms[0].name : '';
  const lastMs = ms.length ? ms[ms.length - 1].name : '';
  const cleanMsName = (s) => String(s || '').replace(/^\s*M\d+\s*[·:.\-–]*\s*/i, '').trim() || String(s || '').trim();
  const EMBLEM = '<svg class="hs-logo" width="56" height="56" viewBox="0 0 56 56" aria-hidden="true">' +
    '<rect x="5" y="33" width="11" height="18" rx="3" fill="#6A6A66"/>' +
    '<rect x="22" y="21" width="11" height="30" rx="3" fill="#9A9A95"/>' +
    '<rect x="39" y="7" width="11" height="44" rx="3" fill="#97C459"/></svg>';
  const phaseCards = [
    { n: 1, key: 'PLAN', what: 'Goal · Requirements + ACs · Architecture + ADRs · Governance · Milestones.', cls: 'done', pill: 'done', text: '✓ Complete' },
    { n: 2, key: 'SETUP', what: 'Repo · CI · issue tracker · branch protection · build + review agents.', mskey: firstMs },
    { n: 3, key: 'BUILD', what: 'Per-milestone build loop' + (ms.length ? ' — ' + ms.length + ' milestones · ' + totalSubs + ' sub-issues' : '') + '.', mskey: '*' },
    { n: 4, key: 'POST-LAUNCH', what: (lastMs ? cleanMsName(lastMs) + ' — operate, evolve, scale.' : 'Operate, evolve, and scale after launch.'), mskey: lastMs, future: true },
  ];
  const hsCard = (c) => {
    const live = c.mskey ? ' data-ms="' + escA(c.mskey) + '"' + (c.future ? ' data-future="1"' : '') : '';
    const pill = c.pill || (c.future ? 'future' : 'todo');
    const text = c.text || (c.future ? '⏳ Upcoming' : '· …');
    return '<div class="hs-phase' + (c.cls ? ' ' + c.cls : '') + '"' + live + '>' +
      '<div class="lab"><span class="num">' + c.n + '</span><span class="eyebrow">Phase ' + c.n + '</span></div>' +
      '<h3>' + c.key + '</h3><p class="what">' + esc(c.what) + '</p>' +
      '<span class="hs-pill ' + pill + '">' + text + '</span></div>';
  };
  const nextIssue = (linear && linear.phases && linear.phases[0] && (linear.phases[0].issues || [])[0]) || null;
  const hsNext = (nextIssue || firstMs) ? '<section class="hs-next"><p class="eyebrow">Next action</p>' +
    '<h2>' + (nextIssue
      ? 'Start <a href="' + escA(nextIssue.url || '#') + '" target="_blank" rel="noopener">' + esc(nextIssue.identifier) + ' · ' + esc(nextIssue.title) + '</a>'
      : 'Start <b>' + esc(firstMs) + '</b>') + '</h2>' +
    '<p style="margin:6px 0 0;color:var(--muted);font-size:14px">The first open issue in the tracker — see the <a href="/docs/plan">plan</a> for the full sequence.</p></section>' : '';
  const msRoll = ms.length ? '<div class="sec-head"><h2>Milestones</h2><span class="meta">live status on the Plan page</span></div>' +
    '<div class="ms-roll"><p class="lead" id="ms-summary"><strong>' + esc(firstMs) + '</strong> — milestone status loads from the live tracker.</p>' +
    '<div class="bar"><span id="ms-bar" style="width:0%"></span></div>' +
    '<div class="ms-track">' + ms.map((m, i) => {
      const key = (String(m.name).match(/\bM\d+\b/) || ['M' + (i + 1)])[0];
      return '<div class="ms-stop" data-ms="' + escA(m.name) + '"><span class="m">' + esc(key) + '</span><span class="n">' + esc(cleanMsName(m.name) || m.name) + '</span><span class="d">' + esc(m.target || '—') + '</span></div>';
    }).join('') + '</div>' +
    '<p class="more"><a href="/docs/plan">Full plan, Gantt &amp; per-issue status →</a>' + (linear && linear.url ? ' &nbsp;·&nbsp; <a href="' + escA(linear.url) + '" target="_blank" rel="noopener">Live in Linear →</a>' : '') + '</p></div>' : '';
  const HOME_CSS = '<style>' +
    '.wrap>h1{display:none;}' +
    '.hs-hero{text-align:center;padding:10px 0 30px;border-bottom:1px solid var(--line);margin-bottom:30px;}' +
    '.hs-hero .hs-logo{margin:0 auto 14px;display:block;}' +
    '.hs-hero h1{display:block;font-size:30px;margin:0 0 10px;letter-spacing:-.01em;}' +
    '.hs-hero p.lead{max-width:62ch;margin:0 auto;color:var(--text-dim);}' +
    '.hs-hero .dom{display:inline-block;margin-top:12px;font-size:12px;color:var(--muted);}' +
    '.hs-phases{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:8px 0 20px;}' +
    '@media(max-width:820px){.hs-phases{grid-template-columns:1fr 1fr;}}@media(max-width:520px){.hs-phases{grid-template-columns:1fr;}}' +
    '.hs-phase{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:15px;}' +
    '.hs-phase .lab{display:flex;align-items:center;gap:8px;margin-bottom:6px;}' +
    '.hs-phase .num{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:6px;background:var(--panel2);border:1px solid var(--line2);font-size:11px;color:var(--muted);}' +
    '.hs-phase .eyebrow{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);}' +
    '.hs-phase h3{font-size:14px;margin:0 0 8px;letter-spacing:.04em;}' +
    '.hs-phase .what{font-size:13px;color:var(--muted);line-height:1.4;margin:0 0 14px;}' +
    '.hs-pill{display:inline-block;font-size:11px;padding:5px 11px;border-radius:999px;border:1px solid var(--line2);color:var(--muted);}' +
    '.hs-pill.done{background:rgba(151,196,89,.10);color:var(--accent-br);border-color:#3f5a25;}' +
    '.hs-pill.warn{background:rgba(224,168,72,.10);color:var(--amber);border-color:#7a5a1f;}' +
    '.hs-pill.todo,.hs-pill.future{background:var(--panel2);color:var(--muted);border-color:var(--line);}' +
    '.hs-phase.done{border-color:#3f5a25;background:linear-gradient(180deg,rgba(151,196,89,.07),var(--panel));}' +
    '.hs-phase.warn{border-color:#7a5a1f;background:linear-gradient(180deg,rgba(224,168,72,.07),var(--panel));}' +
    '.hs-next{border:1px solid #7a5a1f;background:rgba(224,168,72,.05);border-radius:12px;padding:16px 18px;margin:0 0 30px;}' +
    '.hs-next .eyebrow{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--amber);margin:0 0 6px;}' +
    '.hs-next h2{font-size:18px;margin:0;border:none;padding:0;text-transform:none;letter-spacing:normal;color:var(--text);}' +
    '.sec-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;}.sec-head .meta{margin:0;}' +
    '.ms-roll{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px;}' +
    '.ms-roll .lead{font-size:13px;color:var(--muted);margin:0 0 2px;}.ms-roll .lead strong{color:var(--text);font-weight:600;}' +
    '.ms-roll .bar{height:7px;border-radius:999px;background:var(--panel2);border:1px solid var(--line);overflow:hidden;margin:8px 0 16px;}' +
    '.ms-roll .bar>span{display:block;height:100%;background:var(--accent);transition:width .5s;}' +
    '.ms-track{display:grid;grid-template-columns:repeat(' + Math.max(1, ms.length) + ',1fr);gap:8px;}@media(max-width:720px){.ms-track{grid-template-columns:1fr 1fr;}}' +
    '.ms-stop{background:var(--panel2);border:1px solid var(--line);border-radius:9px;padding:10px 12px;}' +
    '.ms-stop.active{border-color:#7a5a1f;background:linear-gradient(180deg,rgba(224,168,72,.08),var(--panel2));}' +
    '.ms-stop .m{font-size:11px;letter-spacing:.08em;color:var(--dim);font-weight:600;}' +
    '.ms-stop .n{display:block;font-size:13px;color:var(--text);margin:3px 0 2px;}.ms-stop .d{font-size:11px;color:var(--muted);}' +
    '.ms-roll .more{margin:14px 0 0;font-size:12px;}' +
    '</style>';
  const homeBody = HOME_CSS +
    '<header class="hs-hero">' + EMBLEM + '<h1>' + esc(name) + ' — project docs</h1>' +
    (oneliner ? '<p class="lead">' + esc(oneliner) + '</p>' : '') +
    (domain ? '<span class="dom">' + esc(domain) + '</span>' : '') + '</header>' +
    '<div class="sec-head"><h2>Project status</h2></div>' +
    '<section class="hs-phases">' + phaseCards.map(hsCard).join('') + '</section>' +
    hsNext +
    (msRoll ? '<section>' + msRoll + '</section>' : '') +
    '<div class="sec-head"><h2>Explore the docs</h2></div>' +
    '<p class="lead" style="margin:0 0 8px"><a href="/docs/plan">Plan</a> · <a href="/docs/requirements">Requirements</a> · <a href="/docs/architecture">Architecture</a> · <a href="/docs/build">Build</a> · <a href="/docs/view/' + docsDir + '/DESIGN.md">Design</a> · <a href="/docs/claude-init">Framework</a></p>' +
    (notBuilding.length ? '<h2>Not building</h2><ul class="dash">' + notBuilding.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '');
  writeFile(path.join(root, 'docs.html'), htmlShell(name + ' — project docs', '', homeBody, HOME_LIVE_SCRIPT));

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
  // Deterministic milestone-level gantt with stable task ids (gm0..gmN) and a
  // milestone→id map, so the live script can paint completed milestones green
  // from /api/status. Durations come from the milestone target dates when present.
  const gmMap = [];
  let ganttMermaid = '';
  if (ms.length) {
    const isoDay = (d) => d.toISOString().slice(0, 10);
    const parseD = (s) => { const d = new Date(s); return isNaN(d.getTime()) ? null : d; };
    const gl = ['gantt', '  title ' + name + ' — Build Timeline', '  dateFormat YYYY-MM-DD', '  axisFormat %b %d'];
    let cursor = parseD(intake.startDate);
    ms.forEach((m, i) => {
      const label = (cleanMsName(m.name) || m.name || ('Milestone ' + (i + 1))).replace(/[:#\n]/g, ' ').replace(/\s+/g, ' ').trim();
      const key = m.key || ('M' + (i + 1));
      const id = 'gm' + i;
      const end = parseD(m.target);
      let startTok;
      if (i === 0) { startTok = cursor ? isoDay(cursor) : (end ? isoDay(new Date(end.getTime() - 7 * 864e5)) : '2026-01-01'); if (!cursor && end) cursor = new Date(end.getTime() - 7 * 864e5); }
      else { startTok = 'after gm' + (i - 1); }
      let durDays;
      if (end && cursor && end > cursor) { durDays = Math.max(1, Math.round((end - cursor) / 864e5)); cursor = end; }
      else { durDays = 7; cursor = cursor ? new Date(cursor.getTime() + 7 * 864e5) : null; }
      gl.push('  section ' + key + ' ' + label);
      gl.push('  ' + label + ' :' + id + ', ' + startTok + ', ' + durDays + 'd');
      gmMap.push({ id: id, ms: m.name });
    });
    ganttMermaid = gl.join('\n');
  }
  const ganttHtml = ganttMermaid
    ? '<section class="panel"><div class="h2-row"><h2>Gantt — milestone view</h2><span class="meta">completed milestones light up green · renders via Mermaid</span></div>' +
      '<div class="gantt-wrap"><pre class="mermaid">' + ganttMermaid + '</pre></div></section>' : '';
  // Paint completed milestones green once Mermaid has rendered + /api/status loads.
  const GANTT_LIVE = gmMap.length
    ? '<script>window.__gmMap=' + JSON.stringify(gmMap) + ';</script>\n<script>\n' +
      '(async () => { try {\n' +
      "  const s = await (await fetch('/api/status')).json();\n" +
      '  if (!s || !s.ok || !s.milestones) return;\n' +
      '  const map = window.__gmMap || [];\n' +
      '  const done = (n) => { const m = s.milestones[n]; return m && m.total > 0 && m.done >= m.total; };\n' +
      '  let tries = 0;\n' +
      '  const paint = () => {\n' +
      "    if (!document.querySelector('.gantt-wrap rect.task')) { if (tries++ < 50) return setTimeout(paint, 150); return; }\n" +
      "    map.forEach((e) => { if (!done(e.ms)) return; const r = document.querySelector('.gantt-wrap rect[id$=\"-' + e.id + '\"]'); if (r) { r.style.fill = '#33611f'; r.style.stroke = '#97C459'; } });\n" +
      '  };\n  paint();\n} catch (e) {} })();\n</script>' : '';

  const phases = (linear && Array.isArray(linear.phases)) ? linear.phases : [];
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

  // Risks & constraints moved off the plan page → the Requirements reference page.
  const planBody = msRollup + ganttHtml + planOverview;
  const planHead = PLAN_CSS + (ganttHtml ? '\n' + MERMAID_HEAD : '') + '\n' + LIVE_STATUS_SCRIPT + (GANTT_LIVE ? '\n' + GANTT_LIVE : '');
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
    (risks.length ? '<h2>Risks &amp; constraints</h2><div class="panel"><table><thead><tr><th>Risk / constraint</th><th>Mitigation / hard limit</th></tr></thead><tbody>' +
      risks.map((r) => '<tr><td>' + esc(r.risk) + '</td><td>' + esc(r.mitigation) + '</td></tr>').join('') + '</tbody></table></div>' : '') +
    '<p class="meta" style="margin-top:14px">Full markdown: <a href="/docs/view/' + docsDir + '/REQUIREMENTS.md">REQUIREMENTS.md</a> · see also <a href="/docs/plan">Plan</a> · <a href="/docs/architecture">Architecture</a>.</p>';
  writeFile(path.join(root, 'requirements.html'), htmlShell(name + ' — requirements', 'Every requirement, its priority, and how you’d test it.', reqBody));

  // Architecture — Mermaid system diagram when enriched, then the stack tables.
  const ARCH_LEGEND = '<div class="arch-legend">' +
    '<span class="lg app">Our app</span><span class="lg saas">Third-party SaaS</span>' +
    '<span class="lg data">Data store</span><span class="lg edge">Edge / CDN</span>' +
    '<span class="lg infra">CI/CD · deploy</span></div>';
  const diagramHtml = (enrich && enrich.architectureMermaid)
    ? '<h2>System diagram</h2><div class="arch-wrap"><pre class="mermaid">' + archThemed(enrich.architectureMermaid) + '</pre>' + ARCH_LEGEND + '</div>' +
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
  rewriteNav(genDir, { name, docsDir, adrs, ms, wizardEditUrl: opts.wizardEditUrl || '' });
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

  // Optional "✎ Edit in wizard" link back to the wizard's editor (the living-docs
  // round-trip). External absolute URL, so check-docs (which only validates /docs
  // links) ignores it. Rendered just before the "← App" link.
  if (ctx.wizardEditUrl) {
    const editA = '<a href="' + ctx.wizardEditUrl.replace(/"/g, '&quot;') + '" style="color:#97C459;text-decoration:none;padding:5px 9px;border-radius:7px;margin-left:auto;">✎ Edit in wizard</a>';
    src = src.replace(/const APP\s*=\s*"[^]*?";/, 'const APP     = ' + JSON.stringify(editA + '\n') +
      ' + "<a href=\\"/\\" style=\\"color:#7A7A75;text-decoration:none;padding:5px 9px;border-radius:7px;\\">← App</a>";');
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
