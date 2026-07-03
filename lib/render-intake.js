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
  .ov{display:flex;flex-direction:column;gap:22px;}
  .ov-ms-head{display:flex;align-items:baseline;gap:10px;margin:2px 0;}
  .ov-ms-head h3{font-size:15px;margin:0;color:var(--text);}
  .ov-ms-head .tgt{font-size:11px;color:var(--muted);}
  .ov-ms-head .bar{flex:1;height:1px;background:var(--line);}
  .ov-phase{border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-top:8px;}
  .ov-issue{display:grid;grid-template-columns:88px 1fr auto;gap:12px;align-items:center;padding:8px 13px;border-top:1px solid var(--line);font-size:13px;text-decoration:none;color:inherit;transition:background .12s;}
  a.ov-issue:hover{background:rgba(151,196,89,0.07);}
  .ov-issue .iid{color:var(--text-dim);font-weight:600;font-size:12px;white-space:nowrap;}
  .ov-issue .del{color:var(--text);}
  .ov-phase .ov-issue:first-child{border-top:none;}
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
    let s = null;
    for (let t = 0; t < 3 && !(s && s.ok); t++) {
      if (t) await new Promise((r) => setTimeout(r, 2500));
      try { s = await (await fetch('/api/status')).json(); } catch (e) {}
    }
    if (!s || !s.ok) return;
    const by = {};
    (s.issues || []).forEach((i) => { by[i.id] = i; });
    const PILL = { completed:['st-done','Done'], started:['st-prog','In Progress'], unstarted:['st-todo','Todo'], backlog:['st-back','Backlog'], canceled:['st-back','Canceled'] };
    const idOf = (el) => ((el.getAttribute('href') || '').match(/issue\\/([A-Z]+-\\d+)/) || [])[1];
    const apply = (pill, it) => { if (!pill) return; const m = PILL[it.stateType] || ['st-back', it.state]; pill.className = 'pill-st ' + m[0]; pill.textContent = m[1]; };
    document.querySelectorAll('a.ov-issue').forEach((a) => { const it = by[idOf(a)]; if (!it) return; apply(a.querySelector('.pill-st'), it); });
  } catch (e) { /* keep static fallback */ }
})();
</script>`;

// Home landing: fill the four framework-phase pills, the milestone rollup bar,
// and the active milestone from /api/status (overall + per-milestone done/total).
const HOME_LIVE_SCRIPT = `<script>
(async () => {
  try {
    let s = null;
    for (let t = 0; t < 3 && !(s && s.ok); t++) {
      if (t) await new Promise((r) => setTimeout(r, 2500));
      try { s = await (await fetch('/api/status')).json(); } catch (e) {}
    }
    if (!s || !s.ok) return;
    const ov = s.overall || { done: 0, total: 0 };
    const cleanMs = (x) => { x = String(x||'').trim(); if (x.slice(0,6) !== 'Phase ') return x; var seps = [' — ',' – ',' - ']; for (var k=0;k<seps.length;k++){ var i=x.indexOf(seps[k]); if(i>=0) return x.slice(i+seps[k].length).trim(); } return x; };
    const byClean = {}; Object.keys(s.milestones || {}).forEach((k) => { byClean[cleanMs(k)] = s.milestones[k]; });
    const mof = (n) => (s.milestones || {})[n] || byClean[cleanMs(n)];
    const pct = (d, t) => t ? Math.round(d * 100 / t) : 0;
    const bar = document.getElementById('ms-bar'); if (bar) bar.style.width = pct(ov.done, ov.total) + '%';
    let active = null;
    document.querySelectorAll('.ms-stop[data-ms]').forEach((el) => {
      const m = mof(el.getAttribute('data-ms'));
      if (!m) return;
      if (m.total > 0 && m.done >= m.total) el.classList.add('done');
      else if (!active && m.done < m.total) { active = el.getAttribute('data-ms'); el.classList.add('active'); }
    });
    const sum = document.getElementById('ms-summary');
    if (sum) sum.innerHTML = (active ? '<strong>' + cleanMs(active) + '</strong> in progress.' : 'All milestones complete.') + ' Overall <strong>' + ov.done + ' / ' + ov.total + '</strong> sub-issues done.';
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
    document.querySelectorAll('.hs-phase[data-setup]').forEach((el) => {
      const pill = el.querySelector('.hs-pill'); if (!pill) return;
      const set = (c, txt) => { pill.className = 'hs-pill ' + c; pill.textContent = txt; el.classList.remove('done', 'warn'); if (c === 'done') el.classList.add('done'); else if (c === 'warn') el.classList.add('warn'); };
      if (ov.done > 0) set('done', '✓ Complete');
      else if (ov.total > 0) set('warn', '▶ In progress');
    });
    // Next action — the baked value is just the first plan row; replace it with
    // the first genuinely OPEN issue (milestone order, then title order),
    // skipping containers and canceled work.
    const naH = document.getElementById('hs-next-h2');
    if (naH && Array.isArray(s.issues)) {
      const ord = {}; (s.milestoneOrder || []).forEach((n, i) => { ord[n] = i; });
      const hasKids = {}; s.issues.forEach((i) => { if (i.parentId) hasKids[i.parentId] = 1; });
      const open = s.issues.filter((i) => i.milestone && ord[i.milestone] != null && !(!i.parentId && hasKids[i.id]) && i.stateType !== 'completed' && i.stateType !== 'canceled');
      open.sort((a, b) => (ord[a.milestone] - ord[b.milestone]) || String(a.title).localeCompare(String(b.title), undefined, { numeric: true, sensitivity: 'base' }));
      const f = open[0];
      const escT = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      if (f) naH.innerHTML = 'Start ' + (f.url
        ? '<a href="' + escT(f.url) + '" target="_blank" rel="noopener">' + escT(f.id + ' · ' + f.title) + '</a>'
        : '<b>' + escT(f.id + ' · ' + f.title) + '</b>');
    }
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
  /* Fit-to-width centering for the ARCH diagram. */
  .arch-wrap .mermaid{overflow-x:auto;min-height:60px;text-align:center;}
  /* Render at natural size (useMaxWidth:false) so node text stays at the page's
     16px rather than being scaled down; scroll horizontally if a wide diagram
     needs it. The enrich prompt keeps the diagram compact so this is rare. */
  .arch-wrap .mermaid svg{max-width:none;height:auto;display:inline-block;}
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

  // AGENTS.md — the tailored entry point for any coding agent (Claude Code, …).
  // Project-specific facts + what to read + where to start (query Linear for the
  // first Todo issue) + where the creds/deploy live (.deploy/keys.json). The deep
  // framework stays in claude_init + governance/, which this links to. Written to
  // the repo root so it serves at /docs/view/AGENTS.md.
  const cell = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
  const ghRepo = (integ.githubRepoUrl || '').trim();
  const linProj = (linear && linear.projectId) || (integ.linearProjectId || '').trim();
  const appSlug = (String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')) || 'app';
  const agentsMd = [
    '# AGENTS.md — entry point for any coding agent on ' + cell(name),
    '',
    'You are a coding agent (Claude Code, etc.) building **' + cell(name) + '**. Read this end-to-end before doing anything — this file plus the [docs hub](/docs) are your operating manual.',
    '',
    '## Project facts',
    '',
    '| Field | Value |',
    '|---|---|',
    '| Project | ' + cell(name) + ' |',
    '| What it is | ' + cell(oneliner || '—') + ' |',
    '| Code repo | ' + (ghRepo ? cell(ghRepo) : '_set it on the docs Integrations tab_') + ' |',
    '| Linear project | ' + (linProj ? '`' + cell(linProj) + '`' : '_set it on the docs Integrations tab_') + ' |',
    '| Docs hub | this `/docs` site |',
    '',
    '## Read these first',
    '',
    '- [Framework](/docs/claude-init) — the 7 governance phases + the global laws (how we work)',
    '- [Plan](/docs/plan) — milestones → phases → issues, with live status',
    '- [Requirements](/docs/view/' + docsDir + '/REQUIREMENTS.md) — what we are building + acceptance criteria',
    '- [Architecture](/docs/architecture) — stack, topology, and the ADRs (locked decisions — do not re-litigate)',
    '- [Build](/docs/build) — the exact per-issue process you follow',
    '- `governance/CLAUDE.md` + the phase guides `01`–`07` — the discipline for each phase',
    '',
    '## Where to start',
    '',
    'Query the **Linear project** for the first issue in **Todo** — that is your first BUILD task. ' +
      (linProj ? 'The project ID is `' + cell(linProj) + '` (also in `.deploy/keys.json`). ' : 'Its ID is in `.deploy/keys.json` as `linearProjectId`. ') +
      'Authenticate with the Linear key from `.deploy/keys.json`. Then work the issue under the governance phases on the [Build](/docs/build) page — tests first, the smallest change that passes, self-review (Phase 05), open a PR, and merge only on a green review.',
    '',
    '## Credentials & deploy',
    '',
    'Every integration credential lives in **`.deploy/keys.json`** — set on the docs **Integrations tab** (☰ → Edit the plan → Integrations). Read them from there at runtime; never hardcode or commit a secret. Keys:',
    '',
    '- `anthropicKey` — Claude API (the primary builder)',
    '- `grokKey` — Grok API (the cross-examiner agent, grok-build)',
    '- `linearKey` + `linearProjectId` — the tracker',
    '- `githubRepoUrl` + `githubToken` — the code repo',
    '- `sshHost` / `sshUser` / `sshPassword` / `sshPort` — the Docker deploy host',
    '',
    'To deploy, SSH to the host in `keys.json` (`sshHost` as `sshUser` on `sshPort`) and run the project\'s deploy step in the app directory (e.g. `docker compose up -d --build`).',
    '',
    '## Identity',
    '',
    'Prefix every commit, PR comment, and Linear update with `[agent:claude-code] <ISSUE-ID>: <message>` so your actions are traceable.',
    '',
  ].join('\n');
  writeFile(path.join(genDir, 'AGENTS.md'), agentsMd);

  // CLAUDE.md — the Claude-Code-specific overlay (AGENTS.md is the cross-agent
  // brief). Tailored to THIS project's deploy model + commands. Repo root → serves
  // at /docs/view/CLAUDE.md.
  const claudeMd = [
    '# CLAUDE.md — Claude Code orientation for ' + cell(name),
    '',
    'Read **[AGENTS.md](/docs/view/AGENTS.md)** first — the cross-agent brief (facts, what to read, where to start, creds). This file is the Claude-Code-specific overlay: how **' + cell(name) + '** deploys and the commands you run.',
    '',
    '## Deploy model',
    '',
    '- The project lives on the Docker host at `~/apps/' + appSlug + '/`, **bind-mounted into the pod at `/app`** — editing files there is live, no rebuild.',
    '- That folder holds the `/docs` site, `PLAN-INTAKE.json`, `governance/`, `AGENTS.md`, and `.deploy/keys.json`.',
    '- Routing is handled by the Traefik labels in `docker-compose.yml` (it joins the shared `web` network) — no manual proxy config.',
    '',
    '## Credentials',
    '',
    'Everything is in `.deploy/keys.json` (set on the docs **Integrations tab**): `anthropicKey`, `grokKey`, `linearKey` + `linearProjectId`, `githubRepoUrl` + `githubToken`, and `sshHost`/`sshUser`/`sshPassword`/`sshPort`. Read them from there; never hardcode or commit a secret.',
    '',
    '## Commands',
    '',
    '- **Connect:** `ssh <sshUser>@<sshHost>` (over the VPN if you are off the LAN). The target is the Docker **host**, not the pod.',
    '- **Deploy a change:** `cd ~/apps/' + appSlug + ' && docker compose up -d --build` — or, because the folder is bind-mounted, edit in place and it goes live.',
    '- **Tracker:** authenticate with `linearKey` and work the Linear project' + (linProj ? ' `' + cell(linProj) + '`' : ' in `linearProjectId`') + ' — start with the first issue in Todo.',
    '- **Code:** push and open PRs against ' + (ghRepo ? '`' + cell(ghRepo) + '`' : 'the repo in `githubRepoUrl`') + '; merge only on a green cross-examiner review.',
    '',
    '## Discipline',
    '',
    'Follow the governance phases on the [Build](/docs/build) page and the global laws in [the framework](/docs/claude-init). Prefix every commit, PR comment, and Linear update with `[agent:claude-code] <ISSUE-ID>:`.',
    '',
  ].join('\n');
  writeFile(path.join(genDir, 'CLAUDE.md'), claudeMd);

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
  const cleanMsName = (s) => String(s || '').replace(/^\s*Phase\s+[A-Z]+\s*[—\-–]\s*/i, '').replace(/^\s*M\d+\s*[·:.\-–]*\s*/i, '').trim() || String(s || '').trim();
  // Display milestones: 100% from the LINEAR tracker when one is linked (name,
  // order, target date, done-means all live from the project's milestones); the
  // intake list is only the no-tracker fallback. Intake targets ("Week 2") win
  // over raw ISO dates for display when the names still line up.
  const msLive = (linear && Array.isArray(linear.milestones)) ? linear.milestones : [];
  const msByCleanIntake = {};
  ms.forEach((m) => { msByCleanIntake[cleanMsName(m.name)] = m; });
  const dispMs = msLive.length
    ? msLive.map((m) => {
        const im = msByCleanIntake[m.cleanName || cleanMsName(m.name)];
        return { key: m.key, name: m.name, clean: m.cleanName || cleanMsName(m.name),
          target: (im && im.target) || m.targetDate || '', done: m.doneMeans || (im && im.done) || '',
          subs: (m.issues || []).length };
      })
    : ms.map((m) => ({ key: m.key, name: m.name, clean: cleanMsName(m.name), target: m.target || '', done: m.done || '', subs: null }));
  const totalSubs = msLive.reduce((n, m) => n + ((m.issues || []).length), 0);
  const firstMs = dispMs.length ? dispMs[0].name : '';
  const lastMs = dispMs.length ? dispMs[dispMs.length - 1].name : '';
  const EMBLEM = '<svg class="hs-logo" width="56" height="56" viewBox="0 0 56 56" aria-hidden="true">' +
    '<rect x="5" y="33" width="11" height="18" rx="3" fill="#6A6A66"/>' +
    '<rect x="22" y="21" width="11" height="30" rx="3" fill="#9A9A95"/>' +
    '<rect x="39" y="7" width="11" height="44" rx="3" fill="#97C459"/></svg>';
  const phaseCards = [
    { n: 1, key: 'PLAN', what: 'Goal · Requirements + ACs · Architecture + ADRs · Governance · Milestones.', cls: 'done', pill: 'done', text: '✓ Complete' },
    // Setup is complete once build execution has begun — completed sub-issues
    // prove the repo/CI/tracker/agent pipeline works. (Gating it on the first
    // milestone kept it orange forever: that milestone mixes setup with build
    // tasks and long-lived human follow-ups, and Phase 3 already counts them.)
    { n: 2, key: 'SETUP', what: 'Repo · CI · issue tracker · branch protection · build + review agents.', setup: true },
    { n: 3, key: 'BUILD', what: 'Per-milestone build loop' + (dispMs.length ? ' — ' + dispMs.length + ' milestones · ' + totalSubs + ' sub-issues' : '') + '.', mskey: '*' },
    { n: 4, key: 'POST-LAUNCH', what: (lastMs ? cleanMsName(lastMs) + ' — operate, evolve, scale.' : 'Operate, evolve, and scale after launch.'), mskey: lastMs, future: true },
  ];
  const hsCard = (c) => {
    const live = c.setup ? ' data-setup="1"' : (c.mskey ? ' data-ms="' + escA(c.mskey) + '"' + (c.future ? ' data-future="1"' : '') : '');
    const pill = c.pill || (c.future ? 'future' : 'todo');
    const text = c.text || (c.future ? '⏳ Upcoming' : '· …');
    return '<div class="hs-phase' + (c.cls ? ' ' + c.cls : '') + '"' + live + '>' +
      '<div class="lab"><span class="num">' + c.n + '</span><span class="eyebrow">Phase ' + c.n + '</span></div>' +
      '<h3>' + c.key + '</h3><p class="what">' + esc(c.what) + '</p>' +
      '<span class="hs-pill ' + pill + '">' + text + '</span></div>';
  };
  const nextIssue = (msLive.find((m) => (m.issues || []).length) || { issues: [] }).issues[0] || null;
  const hsNext = (nextIssue || firstMs) ? '<section class="hs-next"><p class="eyebrow">Next action</p>' +
    '<h2 id="hs-next-h2">' + (nextIssue
      ? 'Start <a href="' + escA(nextIssue.url || '#') + '" target="_blank" rel="noopener">' + esc(nextIssue.identifier) + ' · ' + esc(nextIssue.title) + '</a>'
      : 'Start <b>' + esc(cleanMsName(firstMs)) + '</b>') + '</h2>' +
    '<p style="margin:6px 0 0;color:var(--muted);font-size:14px">The first open issue in the tracker — see the <a href="/docs/plan">plan</a> for the full sequence.</p></section>' : '';
  const msRoll = dispMs.length ? '<div class="sec-head"><h2>Milestones</h2><span class="meta">live status on the Plan page</span></div>' +
    '<div class="ms-roll"><p class="lead" id="ms-summary"><strong>' + esc(cleanMsName(firstMs)) + '</strong> — milestone status loads from the live tracker.</p>' +
    '<div class="bar"><span id="ms-bar" style="width:0%"></span></div>' +
    '<div class="ms-track">' + dispMs.map((m) => {
      return '<div class="ms-stop" data-ms="' + escA(m.name) + '"><span class="m">' + esc(m.key) + '</span><span class="n">' + esc(m.clean || m.name) + '</span><span class="d">' + esc(m.target || '—') + '</span></div>';
    }).join('') + '</div>' +
    '<p class="more"><a href="/docs/plan">Full plan &amp; per-issue status →</a>' + (linear && linear.url ? ' &nbsp;·&nbsp; <a href="' + escA(linear.url) + '" target="_blank" rel="noopener">Live in Linear →</a>' : '') + '</p></div>' : '';
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
    // auto-fill + a real minimum keeps tiles readable at any milestone count
    // (a fixed repeat(count,1fr) squished them once the tracker grew).
    '.ms-track{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;}@media(max-width:720px){.ms-track{grid-template-columns:1fr 1fr;}}' +
    '.ms-stop{background:var(--panel2);border:1px solid var(--line);border-radius:9px;padding:10px 12px;}' +
    '.ms-stop.active{border-color:#7a5a1f;background:linear-gradient(180deg,rgba(224,168,72,.08),var(--panel2));}' +
    '.ms-stop.done{border-color:#3f5a25;background:linear-gradient(180deg,rgba(151,196,89,.10),var(--panel2));}' +
    '.ms-stop.done .m{color:var(--accent-br);}' +
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

  // Plan — mirrors the Sequence live plan page: a milestone roll-up and (when a
  // Linear tracker was created) a per-phase issue overview whose status pills
  // render live from /api/status. Requirements live on their own tab now
  // (requirements.html), not here. (The milestone Gantt was dropped — the live
  // roll-up + per-issue pills carry the same signal.)

  const hasLive = msLive.length > 0;

  // Milestone roll-up table — straight from the tracker's milestones when linked
  // (dispMs already falls back to the intake list otherwise).
  const msRollup = dispMs.length
    ? '<section class="panel panel--accent"><div class="h2-row"><h2>Milestones</h2>' +
      '<span class="meta">' + dispMs.length + ' milestone' + (dispMs.length === 1 ? '' : 's') +
        (hasLive ? ' · ' + totalSubs + ' sub-issues · live from Linear' : '') + '</span></div>' +
      '<table class="ms-table"><thead><tr><th></th><th>Milestone</th>' +
        (hasLive ? '<th>Subs</th>' : '') + '<th>Target</th><th>Done means</th></tr></thead><tbody>' +
      dispMs.map((m) => {
        return '<tr><td><span class="marker">' + esc(m.key) + '</span></td>' +
          '<td class="name">' + esc(m.clean) + '</td>' +
          (hasLive ? '<td>' + m.subs + '</td>' : '') +
          '<td>' + (m.target ? '<span class="target">' + esc(m.target) + '</span>' : '<span class="target">—</span>') + '</td>' +
          '<td>' + esc(m.done || '—') + '</td></tr>';
      }).join('') +
      '</tbody></table></section>'
    : '<p class="lead">No milestones captured yet.</p>';

  // Plan overview — 100% from the tracker: one group per Linear milestone (in
  // Linear order), one row per issue MAPPED to that milestone, nested under its
  // parent when the parent is mapped too. Unmapped issues stay off the plan by
  // design — assigning a milestone in Linear is what puts work on the plan.
  let planOverview = '';
  if (hasLive) {
    const ownChip = (o) => '<span class="own own-' + (o === 'Human' ? 'h' : 'ai') + '">' + (o === 'Human' ? 'Human' : 'AI') + '</span>';
    const ovHtml = msLive.map((g, gi) => {
      const dm = dispMs[gi];
      const head = esc(dm.key) + ' · ' + esc(dm.clean);
      const tgt = dm.target ? '<span class="tgt">target ' + esc(dm.target) + '</span>' : '';
      const issuesHtml = (g.issues || []).map((it) =>
        '<a class="ov-issue" href="' + escA(it.url || '#') + '" target="_blank" rel="noopener"' +
        (it.depth ? ' style="padding-left:' + (13 + Math.min(it.depth, 4) * 22) + 'px"' : '') + '>' +
        '<span class="iid">' + esc(it.identifier || '') + '</span>' +
        '<span class="del">' + esc(it.title) + ' ' + ownChip(it.owner) + '</span>' +
        '<span class="pill-st st-todo">Todo</span></a>').join('');
      return '<div class="ov-ms"><div class="ov-ms-head"><h3>' + head + '</h3>' + tgt + '<span class="bar"></span></div>' +
        (issuesHtml ? '<div class="ov-phase">' + issuesHtml + '</div>'
          : '<p class="lead" style="margin:8px 0 0">No issues mapped to this milestone yet.</p>') + '</div>';
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
  const planBody = msRollup + planOverview;
  const planHead = PLAN_CSS + '\n' + LIVE_STATUS_SCRIPT;
  writeFile(path.join(root, 'plan.html'), htmlShell(name + ' — build plan', 'Milestones, phases, and live issue status from the tracker.', planBody, planHead));

  // Requirements — its own tab, in the nice table format, with Given/When/Then
  // acceptance criteria when enriched and the "not building" boundary.
  const acRow = (kw, tx) => '<div class="ac-row"><span class="ac-kw ' + kw + '">' + kw.charAt(0).toUpperCase() + kw.slice(1) + '</span><span class="ac-tx">' + esc(tx) + '</span></div>';
  const acHtml = enrich ? reqs.map((r, i) => {
    const e = findEn(enReq, r.title, i) || {};
    if (!e.given && !e.when && !e.then) return '';
    const then = String(e.then || '').split('\n').filter(Boolean);
    let rows = acRow('given', e.given || '…') + acRow('when', e.when || '…');
    rows += then.length ? then.map((t, j) => acRow(j === 0 ? 'then' : 'and', t.replace(/^\s*(then|and)\s+/i, ''))).join('') : acRow('then', '…');
    return '<div class="ac-card"><div class="ac-h">' + esc(r.title) + '</div>' + rows + '</div>';
  }).filter(Boolean).join('') : '';
  const REQ_PAGE_CSS = '<style>' +
    '.ac-card{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:13px 16px;margin-bottom:10px;}' +
    '.ac-card .ac-h{font-size:14px;font-weight:600;margin-bottom:9px;color:var(--text);}' +
    '.ac-row{display:flex;gap:11px;align-items:baseline;padding:5px 0;}.ac-row+.ac-row{border-top:1px solid rgba(255,255,255,.035);}' +
    '.ac-kw{flex:0 0 52px;text-align:center;font-size:10px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;padding:3px 0;border-radius:999px;border:1px solid var(--line);}' +
    '.ac-kw.given{background:rgba(111,168,220,.12);border-color:#3a5a78;color:#8FC5E0;}' +
    '.ac-kw.when{background:rgba(224,168,72,.12);border-color:#876318;color:#E0A848;}' +
    '.ac-kw.then{background:rgba(151,196,89,.12);border-color:#639922;color:#b6d98a;}' +
    '.ac-kw.and{background:#1C1C1F;border-color:var(--line);color:var(--muted);}' +
    '.ac-tx{font-size:13.5px;color:#C8C8C2;line-height:1.5;}' +
    '</style>';
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
  writeFile(path.join(root, 'requirements.html'), htmlShell(name + ' — requirements', 'Every requirement, its priority, and how you’d test it.', reqBody, REQ_PAGE_CSS));

  // Architecture — Mermaid system diagram when enriched, then the stack tables.
  const ARCH_PAGE_CSS = '<style>' +
    '.flows{display:flex;flex-direction:column;gap:10px;}' +
    '.flow{border:1px solid var(--line);border-radius:10px;padding:13px 15px;background:var(--panel);}' +
    '.flow-h{display:flex;align-items:center;gap:10px;margin-bottom:5px;}.flow-h h3{font-size:14px;margin:0;}' +
    '.flow-badge{font-size:10px;text-transform:uppercase;letter-spacing:.06em;padding:2px 8px;border-radius:999px;border:1px solid var(--line2);color:var(--muted);white-space:nowrap;}' +
    '.flow-badge.live{color:var(--accent-br);border-color:#3f5a25;background:rgba(151,196,89,.10);}' +
    '.flow-badge.merge{color:var(--violet);border-color:#423882;background:rgba(169,155,224,.10);}' +
    '.flow p{margin:0;font-size:13px;color:var(--text-dim);line-height:1.55;}' +
    '.flow code{background:var(--code);border:1px solid var(--line);border-radius:5px;padding:.05em .35em;font:12px ui-monospace,Menlo,monospace;color:var(--text-dim);}' +
    '.stack{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--panel);}' +
    '.stack-row{display:grid;grid-template-columns:118px 160px 1fr 72px;gap:14px;align-items:baseline;padding:11px 16px;border-bottom:1px solid var(--line);font-size:13px;}' +
    '.stack-row:last-child{border-bottom:none;}' +
    '.stack-row .cat{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);}' +
    '.stack-row .comp{color:var(--text);font-weight:600;}.stack-row .det{color:var(--muted);}' +
    '.stack-row .adr{font-size:11px;color:var(--accent);text-align:right;white-space:nowrap;}' +
    '@media(max-width:680px){.stack-row{grid-template-columns:1fr;gap:2px;}}' +
    '</style>';
  // ── Architecture: deterministic swim-lane renderer (layers + edges from the
  //    assessment). Lanes + boxes are fixed by us; edges are drawn on an SVG
  //    overlay BEHIND the boxes (z-index) so node text is never covered.
  const arch = (enrich && enrich.architecture && Array.isArray(enrich.architecture.layers)) ? enrich.architecture : null;
  // Pre-layer-data enrichments carried `architecture` as a Mermaid flowchart
  // STRING. Old pods re-rendering under the new engine must keep their diagram
  // (rendered via Mermaid) — not silently lose it. An AI architecture refresh
  // upgrades them to the structured layer diagram whenever the user runs one.
  const legacyArchMermaid = (!arch && enrich && typeof enrich.architecture === 'string') ? enrich.architecture.trim() : '';
  const MERMAID_HEAD = '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>\n' +
    '<script>try{mermaid.initialize({startOnLoad:true,securityLevel:"loose",theme:"base",' +
    'themeVariables:{fontFamily:"-apple-system,system-ui,sans-serif",fontSize:"14px",background:"transparent",' +
    'primaryColor:"#161618",primaryBorderColor:"#3A3A40",primaryTextColor:"#E8E8E4",lineColor:"#5A5A60",' +
    'textColor:"#C8C8C2",clusterBkg:"rgba(255,255,255,.02)",clusterBorder:"#2A2A2E",edgeLabelBackground:"#141417",titleColor:"#9A9A95"},' +
    'flowchart:{htmlLabels:true,useMaxWidth:false,curve:"basis",nodeSpacing:26,rankSpacing:38,padding:6}});}catch(e){}</script>';
  const ARCH_SWIM_CSS = '<style>' +
    '.al-wrap{position:relative;background:#141417;border:1px solid var(--line);border-radius:14px;padding:6px 20px 16px;margin:0 0 14px;overflow-x:auto;}' +
    '.al-edges{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1;}' +
    '.al-layer{display:grid;grid-template-columns:150px 1fr;align-items:center;gap:18px;padding:17px 0;position:relative;z-index:2;}' +
    '.al-layer+.al-layer{border-top:1px solid rgba(255,255,255,.04);}' +
    '.al-label{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);font-weight:600;}' +
    '.al-row{display:flex;gap:16px;align-items:stretch;justify-content:center;flex-wrap:nowrap;}.al-row.pipe{justify-content:flex-start;}' +
    '.al-node{background:#161618;border:1px solid #3A3A40;border-radius:11px;padding:12px 15px;flex:0 1 auto;min-width:150px;max-width:300px;}' +
    '.al-node.app{max-width:420px;}' +
    '.al-node .eye{font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);margin-bottom:4px;}' +
    '.al-node .ti{font-size:15px;font-weight:600;margin:0 0 5px;color:var(--text);}' +
    '.al-node .ln{font-size:12.5px;color:var(--muted);line-height:1.45;}' +
    '.al-node .bu{font-size:12.5px;color:var(--muted);line-height:1.5;margin-top:3px;}' +
    '.al-subs{display:flex;gap:10px;margin-top:11px;}' +
    '.al-sub{flex:1;background:rgba(255,255,255,.02);border:1px solid var(--line);border-radius:8px;padding:8px 10px;}' +
    '.al-sub .sh{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);margin-bottom:4px;}' +
    '.al-sub .sl{font-size:11.5px;color:var(--muted);line-height:1.45;}' +
    '.al-node.app{background:linear-gradient(180deg,rgba(151,196,89,.08),#161618);border-color:#639922;}.al-node.app .ti{color:#C0DD97;}' +
    '.al-node.saas{background:#1f1b30;border-color:#534AB7;}.al-node.saas .ti{color:#A99BE0;}' +
    '.al-node.data{background:#15212a;border-color:#3E7EA0;}.al-node.data .ti{color:#8FC5E0;}' +
    '.al-node.edge{background:#15171a;border-color:#3A3A40;}' +
    '.al-node.infra{background:#2a2212;border-color:#876318;}.al-node.infra .ti{color:#E0A848;}' +
    '.al-node.actor{background:#161618;border-color:#3A3A40;}</style>';
  const nodeHtml = (n) => {
    const lines = (n.lines || []).length ? '<div class="ln">' + (n.lines || []).map(esc).join('<br>') + '</div>' : '';
    const bullets = (n.bullets || []).length ? '<div class="bu">' + (n.bullets || []).map((b) => '• ' + esc(b)).join('<br>') + '</div>' : '';
    const subs = (n.subs || []).length ? '<div class="al-subs">' + (n.subs || []).map((s) => '<div class="al-sub"><div class="sh">' + esc(s.head) + '</div><div class="sl">' + (s.lines || []).map(esc).join('<br>') + '</div></div>').join('') + '</div>' : '';
    return '<div class="al-node ' + esc(n.cls || 'edge') + '" id="al-' + esc(String(n.id)) + '">' + (n.eyebrow ? '<div class="eye">' + esc(n.eyebrow) + '</div>' : '') + '<div class="ti">' + esc(n.title) + '</div>' + lines + bullets + subs + '</div>';
  };
  const archEdges = arch ? (arch.edges || []).map((e) => [String(e.from), String(e.to), String(e.label || ''), String(e.kind || 'default')]) : [];
  const ARCH_EDGE_JS = (arch && archEdges.length)
    ? '<script>window.__alE=' + JSON.stringify(archEdges) + ';(function(){function d(){var w=document.getElementById("al-d");if(!w)return;var s=document.getElementById("al-edges");var W=w.scrollWidth,H=w.scrollHeight;s.setAttribute("viewBox","0 0 "+W+" "+H);s.setAttribute("width",W);s.setAttribute("height",H);var df=\'<defs><marker id="alar" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#6A6A6E"/></marker></defs>\';var P="",L="";var br=w.getBoundingClientRect();(window.__alE||[]).forEach(function(e){var a=document.getElementById("al-"+e[0]),b=document.getElementById("al-"+e[1]);if(!a||!b)return;var ra=a.getBoundingClientRect(),rb=b.getBoundingClientRect();var ax=ra.left+ra.width/2-br.left,ay,bx=rb.left+rb.width/2-br.left,by;if(rb.top>=ra.bottom-2){ay=ra.bottom-br.top;by=rb.top-br.top;}else if(rb.bottom<=ra.top+2){ay=ra.top-br.top;by=rb.bottom-br.top;}else{ay=ra.top+ra.height/2-br.top;by=rb.top+rb.height/2-br.top;if(bx>ax){ax=ra.right-br.left;bx=rb.left-br.left;}else{ax=ra.left-br.left;bx=rb.right-br.left;}}var c=e[3]==="deploy"||e[3]==="critical"?"#5d7a3a":e[3]==="webhook"?"#9a7a30":"#4a4a52";var ds=e[3]==="webhook"||e[3]==="backup"?\' stroke-dasharray="5 4"\':"";var my=(ay+by)/2;P+=\'<path d="M \'+ax+\' \'+ay+\' C \'+ax+\' \'+my+\' \'+bx+\' \'+my+\' \'+bx+\' \'+by+\'" fill="none" stroke="\'+c+\'" stroke-width="1.5"\'+ds+\' marker-end="url(#alar)"/>\';if(e[2]){var lw=e[2].length*6.6+8,lx=(ax+bx)/2;L+=\'<rect x="\'+(lx-lw/2)+\'" y="\'+(my-9)+\'" width="\'+lw+\'" height="16" rx="4" fill="#141417"/><text x="\'+lx+\'" y="\'+(my+3)+\'" fill="#9A9A95" font-size="11" text-anchor="middle">\'+e[2]+\'</text>\';}});s.innerHTML=df+P+L;}window.addEventListener("load",d);window.addEventListener("resize",d);setTimeout(d,250);setTimeout(d,800);})();</script>'
    : '';
  const ARCH_LEGEND = '<div class="arch-legend">' +
    '<span class="lg app">Our app</span><span class="lg saas">Third-party SaaS</span>' +
    '<span class="lg data">Data store</span><span class="lg edge">Edge / CDN</span>' +
    '<span class="lg infra">CI/CD · deploy</span></div>';
  const diagramHtml = (arch && arch.layers.length)
    ? '<h2>System diagram</h2><div class="al-wrap" id="al-d"><svg class="al-edges" id="al-edges"></svg>' +
      arch.layers.map((L) => '<div class="al-layer"><div class="al-label">' + esc(L.label) + '</div><div class="al-row' + (/ci|cd|deploy|build|pipeline/i.test(L.label) ? ' pipe' : '') + '">' + (L.nodes || []).map(nodeHtml).join('') + '</div></div>').join('') +
      '</div>' + ARCH_LEGEND +
      (enrich.architectureNote ? '<p class="lead">' + esc(enrich.architectureNote) + '</p>' : '')
    : legacyArchMermaid
    ? '<h2>System diagram</h2><div class="arch-wrap"><pre class="mermaid">' + archThemed(legacyArchMermaid) + '</pre></div>' +
      (enrich.architectureNote ? '<p class="lead">' + esc(enrich.architectureNote) + '</p>' : '')
    : '';
  // ── Key request flows (from enrich) ──
  const flows = (enrich && Array.isArray(enrich.requestFlows)) ? enrich.requestFlows : [];
  const inlineMd = (s) => esc(String(s || '')).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  const flowsHtml = flows.length
    ? '<h2>Key request flows</h2><div class="flows">' + flows.map((f) => {
        const st = String(f.status || '').toLowerCase();
        const cls = /live|done/.test(st) ? ' live' : /merge|deploy|auto/.test(st) ? ' merge' : '';
        return '<div class="flow"><div class="flow-h"><h3>' + esc(f.title) + '</h3>' +
          (f.status ? '<span class="flow-badge' + cls + '">' + esc(f.status) + '</span>' : '') + '</div>' +
          '<p>' + inlineMd(f.body) + '</p></div>';
      }).join('') + '</div>'
    : '';

  // ── Stack components (from enrich, fallback to the locked decisions) ──
  const adrByConcern = {};
  adrs.forEach((a) => { adrByConcern[String(a.concern || '').trim().toLowerCase()] = a; });
  const comps = (enrich && Array.isArray(enrich.stackComponents) && enrich.stackComponents.length)
    ? enrich.stackComponents
    : decs.map((d) => ({ category: d.concern, component: d.choice, detail: d.why, adr: d.concern }));
  const stackHtml = comps.length
    ? '<h2>Stack components</h2><div class="stack">' + comps.map((c) => {
        const adr = adrByConcern[String(c.adr || c.category || '').trim().toLowerCase()];
        const adrN = adr ? String(adrs.indexOf(adr) + 1).padStart(3, '0') : '';
        const adrFile = adr ? ('adr-' + adrN + '-' + slug(adr.concern) + '.md') : '';
        return '<div class="stack-row"><span class="cat">' + esc(c.category || '') + '</span>' +
          '<span class="comp">' + esc(c.component || '') + '</span>' +
          '<span class="det">' + esc(c.detail || '') + '</span>' +
          (adrFile ? '<a class="adr" href="/docs/view/' + docsDir + '/adr/' + adrFile + '">' + esc('ADR-' + adrN) + '</a>' : '<span></span>') +
          '</div>';
      }).join('') + '</div>'
    : '';

  const archBody =
    diagramHtml + flowsHtml + stackHtml +
    (scal.length ? '<h2>Non-functional &amp; scale</h2><div class="panel"><table><thead><tr><th>Area</th><th>Target</th><th>Decision</th></tr></thead><tbody>' +
      scal.map((s) => `<tr><td><b>${esc(s.area)}</b></td><td>${esc(s.target)}</td><td>${esc(s.adr)}</td></tr>`).join('') + '</tbody></table></div>' : '') +
    '<p class="meta" style="margin-top:14px">Each decision has an ADR under <a href="/docs/view/' + docsDir + '/adr/README.md">Decisions</a>.</p>';
  writeFile(path.join(root, 'architecture.html'), htmlShell(name + ' — architecture', 'The production stack, request flows, and components.', archBody, (diagramHtml ? ARCH_SWIM_CSS + ARCH_EDGE_JS : '') + (legacyArchMermaid ? MERMAID_HEAD : '') + ARCH_PAGE_CSS));

  // Build — exact reproduction of the reference /docs/build. The framework loop
  // (what we code with, how we track work, the per-issue process, resources) is a
  // SET workflow and is static; only the Product-stack/Ops cards and the live
  // tracker link are project-specific (derived from the decisions + architecture).
  const trackerUrl = (linear && linear.url) ? linear.url : null;
  const issueKey = (String(prod.name || '').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase()) || 'SEQ';
  const KNOWN_VENDOR = /\b(Fly\.io|Fly|Neon|Clerk|Stripe|Cloudflare|PostgreSQL|Postgres|Express|Node\.js|Next\.js|Vercel|AWS|GCP|Azure|Supabase|Auth0|Firebase|Resend|SendGrid|Postmark|Mailgun|Sentry|Datadog|Grafana|R2|S3|Redis|MongoDB|Mongo|Railway|Render|Netlify|Docker|Kubernetes|Twilio)\b/i;
  const SIDE_RE = /e-?mail|mail|monitor|observ|error|logging|\blog\b|backup|analytics|notification|queue|cache|metric|alert|tracing/i;
  const vendorOf = (d) => { const m = String(d.choice || '').match(KNOWN_VENDOR); return m ? m[0] : (String(d.concern || '').split(/[ ·,/]/)[0] || ''); };
  const coreDecs = decs.filter((d) => !SIDE_RE.test(d.concern || '')).slice(0, 5);
  const coreVendors = coreDecs.map(vendorOf).filter(Boolean).join(' · ') || 'your stack';
  const stackRoles = coreDecs.map((d) => vendorOf(d) + ' (' + String(d.concern || '').toLowerCase() + ')').filter(Boolean).join(', ');
  let sideTitles = decs.filter((d) => SIDE_RE.test(d.concern || '')).map(vendorOf).filter(Boolean);
  if (!sideTitles.length && enrich && enrich.architecture && Array.isArray(enrich.architecture.layers)) {
    const sl = enrich.architecture.layers.find((L) => /side|backup|observ|monitor/i.test(L.label || ''));
    if (sl) sideTitles = (sl.nodes || []).map((n) => String(n.title || '').split(/[ ·]/)[0].trim()).filter(Boolean);
  }
  const BUILD_PAGE_CSS = '<style>' +
    ':root{--you-bg:rgba(151,196,89,.10);--you-bd:#3f5a25;--cl-bg:rgba(169,155,224,.12);--cl-bd:#4a3f7a;--gr-bg:rgba(224,168,72,.12);--gr-bd:#7a5a1f;--violet:#A99BE0;--amber:#E0A848;--line2:#3A3A40;}' +
    '.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;}@media(max-width:760px){.cards{grid-template-columns:1fr;}}' +
    '.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:15px;}' +
    '.card .k{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);}' +
    '.card h3{margin:5px 0 4px;font-size:15px;}.card p{margin:0;font-size:13px;color:var(--muted);}.card a{font-size:13px;}' +
    '.legend{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 16px;font-size:11px;}' +
    '.chip{padding:3px 9px;border-radius:999px;border:1px solid var(--line2);color:var(--muted);}' +
    '.chip.you{background:var(--you-bg);border-color:var(--you-bd);color:#b6d98a;}' +
    '.chip.cl{background:var(--cl-bg);border-color:var(--cl-bd);color:var(--violet);}' +
    '.chip.gr{background:var(--gr-bg);border-color:var(--gr-bd);color:var(--amber);}' +
    '.flow{display:flex;flex-direction:column;align-items:center;gap:0;}' +
    '.node{width:min(560px,100%);background:var(--panel);border:1px solid var(--line2);border-left-width:3px;border-radius:10px;padding:11px 15px;box-sizing:border-box;}' +
    '.node .t{font-size:14px;font-weight:600;}.node .d{font-size:12px;color:var(--muted);margin-top:2px;}' +
    '.node.you{border-left-color:var(--accent);}.node.cl{border-left-color:var(--violet);}.node.gr,.node.gate{border-left-color:var(--amber);}' +
    '.node.gate{background:var(--gr-bg);}' +
    '.node .tag{float:right;font-size:9px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim);}' +
    '.arr{color:var(--dim);font-size:18px;line-height:1;padding:6px 0;text-align:center;}.arr .lab{font-size:10px;color:var(--muted);letter-spacing:.04em;}' +
    '.gate-row{width:min(560px,100%);display:flex;gap:12px;align-items:stretch;}.gate-row .node{flex:1;}' +
    '.branch{display:flex;flex-direction:column;justify-content:center;align-items:center;gap:4px;min-width:150px;}' +
    '.branch .toarr{font-size:10px;color:var(--amber);white-space:nowrap;}' +
    '.branch .fix{background:var(--cl-bg);border:1px dashed var(--cl-bd);border-radius:9px;padding:7px 10px;font-size:12px;color:var(--violet);text-align:center;}' +
    'ul.res{list-style:none;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:8px;}@media(max-width:760px){ul.res{grid-template-columns:1fr;}}' +
    'ul.res a{display:block;background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:10px 13px;text-decoration:none;}' +
    'ul.res a:hover{border-color:var(--line2);}ul.res .rt{color:var(--text);font-size:14px;font-weight:600;display:block;}ul.res .rd{color:var(--muted);font-size:12px;display:block;}' +
    'ol.setup{padding-left:22px;margin:14px 0;}ol.setup li{margin:9px 0;font-size:14px;line-height:1.6;color:var(--muted);}ol.setup li b{color:var(--text);font-weight:600;}ol.setup code{font-size:12.5px;}' +
    '.bs-note{font-size:12.5px;color:var(--muted);background:rgba(224,168,72,.06);border:1px solid #876318;border-radius:9px;padding:10px 13px;margin:12px 0;}' +
    '</style>';
  const card = (k, h, p) => '<div class="card"><div class="k">' + k + '</div><h3>' + h + '</h3><p>' + p + '</p></div>';
  const tagOf = (c) => c === 'you' ? 'you' : (c === 'gr' || c === 'gate') ? 'grok' : 'claude';
  const node = (c, t, d) => '<div class="node ' + c + '"><span class="tag">' + tagOf(c) + '</span><div class="t">' + t + '</div><div class="d">' + d + '</div></div>';
  const arr = (lab) => '<div class="arr">' + (lab ? '<span class="lab">' + lab + '</span><br>' : '') + '↓</div>';
  const opsCard = sideTitles.length ? card('Ops', esc(sideTitles.slice(0, 4).join(' · ')), 'Supporting services around the core app — email, error tracking, and off-site backups.') : '';
  const buildBody =
    '<h2>What we code with</h2><div class="cards">' +
      card('Builder agent', 'Claude Code', 'Writes the code in the repo session under the governance phases. Every commit is prefixed <code>[agent:claude-code]</code>.') +
      card('Cross-examiner', 'Grok (grok-build)', 'A different vendor independently reviews every PR before it can merge. Runs the Phase 05 checklist + AC trace.') +
      card('Discipline', 'Governance library', '7 phase guides (requirements → release) + the five global laws. <a href="/docs/claude-init">See the framework →</a>') +
      card('Source of truth', 'GitHub', 'Repo, PRs, branch protection, and the cross-examiner CI gate. <code>main</code> requires a green review to merge.') +
      card('Product stack', esc(coreVendors), 'Live in production: ' + (stackRoles ? esc(stackRoles) : 'the locked stack') + '. Decisions live in the <a href="/docs/architecture">ADRs</a>.') +
      opsCard +
    '</div>' +
    '<h2>How we track work</h2><div class="cards">' +
      card('Tracker', 'Linear', '5 milestones → phases → atomic sub-issues. Each issue&rsquo;s steps are checkboxes you tick as you go.' + (trackerUrl ? ' <a href="' + escA(trackerUrl) + '" target="_blank" rel="noopener">Open the project →</a>' : '')) +
      card('Overview', 'The plan', 'What every issue delivers + live status, for a high-level read. <a href="/docs/plan">See the plan →</a>') +
    '</div>' +
    '<h2>The per-issue process</h2>' +
    '<div class="legend"><span class="chip you">you — owner / human</span><span class="chip cl">claude — builder</span><span class="chip gr">grok — cross-examiner</span></div>' +
    '<div class="flow">' +
      node('you', '1 · Review the issue', 'Read the description, Done when, and acceptance criteria. If a requirement doesn&rsquo;t trace to an owner + a reason, ask before building.') + arr() +
      node('cl', '2 · Detect the phase', 'Open <code>governance/CLAUDE.md</code>, read the matching phase guide (1–7), announce &ldquo;Operating in Phase N.&rdquo;') + arr() +
      node('cl', '3 · Branch', 'From <code>main</code>, using the issue&rsquo;s git branch name (Linear → Copy branch name).') +
      arr('owner-action issues: you do the manual steps here (accounts, keys, settings) — never paste secrets in chat') +
      node('cl', '4 · Tests first (TDD)', 'Encode the acceptance criteria as failing tests. Tests are the requirements.') + arr() +
      node('cl', '5 · Implement', 'The smallest change that makes the tests pass. Delete before building; simplify only what survived.') + arr() +
      node('cl', '6 · Self-review', 'Run the Phase 05 checklist — correctness · security · AI failure modes. You own what you accept.') + arr() +
      node('cl', '7 · Commit + docs', '<code>[agent:claude-code] ' + issueKey + '-N:</code> … · update the /docs home + any affected docs in the same commit.') + arr() +
      node('cl', '8 · Open the PR', 'Body contains <code>Closes ' + issueKey + '-N</code>.') + arr() +
      '<div class="gate-row">' +
        node('gate', '9 · Cross-examiner gate', 'grok-build reviews the PR automatically and sets the required cross-examiner check.') +
        '<div class="branch"><div class="toarr">— ❌ changes requested →</div><div class="fix">Fix &amp; re-push<br>↺ re-runs the gate</div></div>' +
      '</div>' +
      arr('✅ approved — branch protection unblocks merge') +
      node('you', '10 · Owner merges', 'Approve + merge once the check is green. No PR lands without it.') + arr() +
      node('you', '11 · Close out', 'Verify the deploy, mark the issue Done in Linear, confirm /docs reflects reality.') +
    '</div>' +
    '<h2>Build setup — run Claude Code on this project</h2>' +
    '<p class="lead">How a developer points Claude Code at ' + esc(name) + ' and starts shipping. The whole project — docs, plan, and credentials — lives on the Docker host; Claude reaches it over SSH.</p>' +
    '<div class="bs-note">⚠ Assumes you are on the LAN with the Docker host. If you are off-site, <b>connect the VPN first</b> so the host&rsquo;s LAN IP is reachable.</div>' +
    '<ol class="setup">' +
      '<li><b>Install Claude Code on your Mac</b> and open it in a new, empty folder dedicated to this app — one folder per project keeps each session contained to that app.</li>' +
      '<li><b>Find the project on the host.</b> Everything lives at <code>~/apps/' + esc(appSlug) + '/</code> on the Docker host: the <code>/docs</code> site, <code>PLAN-INTAKE.json</code>, the <code>governance/</code> library, <code>AGENTS.md</code>, and <code>.deploy/keys.json</code>. That folder is bind-mounted into the pod, so editing it is live — no rebuild.</li>' +
      '<li><b>Give Claude persistent SSH to the host.</b> Add your Mac&rsquo;s key once with <code>ssh-copy-id &lt;user&gt;@&lt;host&gt;</code>, then confirm <code>ssh &lt;user&gt;@&lt;host&gt;</code> connects with no password. The real host / user / port are this project&rsquo;s <code>sshHost</code> / <code>sshUser</code> / <code>sshPort</code> in <code>.deploy/keys.json</code> — set them on the <b>Integrations tab</b> (the ☰ menu &rarr; Edit the plan &rarr; Integrations on this docs site).</li>' +
      '<li><b>Point Claude at the brief + creds.</b> Tell it to read <a href="/docs/view/AGENTS.md">AGENTS.md</a> (the agent brief) and <code>~/apps/' + esc(appSlug) + '/.deploy/keys.json</code> over SSH. That one file has the Linear key + project ID, the GitHub repo + token, and the SSH deploy host — everything it needs to read issues, push code, and deploy.</li>' +
      '<li><b>Wire write access.</b> From <code>keys.json</code>, give Claude the Linear API key and GitHub token so it can update issues and push / merge PRs as it works.</li>' +
      '<li><b>Start the loop.</b> Ask Claude to query the Linear project for the first <b>Todo</b> issue, then work it under the governance phases above: tests first &rarr; implement &rarr; self-review &rarr; open a PR &rarr; merge on a green review &rarr; mark the issue Done &rarr; next.</li>' +
      '<li><b>Deploy.</b> Each app&rsquo;s pod is stood up and routed automatically by its <code>docker-compose.yml</code> Traefik labels — no manual proxy setup. Ship a change with <code>ssh &lt;user&gt;@&lt;host&gt; "cd ~/apps/' + esc(appSlug) + ' &amp;&amp; docker compose up -d --build"</code>, or — since the folder is bind-mounted — just edit in place and it goes live, then test at the app&rsquo;s URL.</li>' +
    '</ol>' +
    '<p class="meta">Secrets never live in these docs — they stay in <code>.deploy/keys.json</code> on the host, which Claude reads over your SSH/VPN connection. The docs themselves are safe to browse over plain LAN HTTP.</p>' +
    '<h2>Resources</h2><ul class="res">' +
      '<a href="/docs/view/AGENTS.md"><span class="rt">AGENTS.md</span><span class="rd">Cross-agent contract — read first</span></a>' +
      '<a href="/docs/claude-init"><span class="rt">claude_init</span><span class="rd">The framework at a glance</span></a>' +
      '<a href="/docs/view/governance/CLAUDE.md"><span class="rt">Governance router</span><span class="rd">Which phase guide to load</span></a>' +
      '<a href="/docs/view/' + docsDir + '/WORKFLOW.md"><span class="rt">Workflow</span><span class="rd">Multi-agent contract + the loop checklist</span></a>' +
      '<a href="/docs/view/' + docsDir + '/REQUIREMENTS.md"><span class="rt">Requirements</span><span class="rd">What we&rsquo;re building (and not)</span></a>' +
      '<a href="/docs/view/' + docsDir + '/ARCHITECTURE.md"><span class="rt">Architecture</span><span class="rd">The build bible</span></a>' +
    '</ul>';
  writeFile(path.join(root, 'build.html'), htmlShell(name + ' — build', 'Everything a developer needs to pick up a Linear issue and ship it the way we work: the tools we code with, where work is tracked, and the exact process every issue follows.', buildBody, BUILD_PAGE_CSS));

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
  // Always start from the PRISTINE donor nav template (embedded in docs-kit.js) so
  // repeated builds can't accumulate corruption from earlier patches — rewriteNav's
  // edits are idempotent transforms of the clean base. Fall back to the genDir copy.
  try {
    const kit = fs.readFileSync(path.join(__dirname, 'docs-kit.js'), 'utf-8');
    const km = kit.match(/"lib\/docs-nav\.js":\s*"((?:[^"\\]|\\.)*)"/);
    if (km) src = JSON.parse('"' + km[1] + '"');
  } catch (e) { /* fall back below */ }
  if (!src) { try { src = fs.readFileSync(navPath, 'utf-8'); } catch { return; } }
  const d = ctx.docsDir;
  const A = (href, label) => '  <a href="' + href + '">' + label + '</a>';
  const refLines = [
    '<details class="nav-dd"><summary class="nav-step">Reference ▾</summary><div class="nav-dd-menu">',
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

  // Reorder + relabel the top nav (Overview → Framework → Requirements →
  // Architecture → Plan → Build → Reference) and render the steps as
  // right-pointing arrow segments so the docs read as a process you move through.
  src = src.replace(/const TOP = \[[\s\S]*?\];/,
    "const TOP = [\n" +
    "  { key: 'home',         href: '/docs',              label: 'Overview' },\n" +
    "  { key: 'framework',    href: '/docs/claude-init',  label: 'Framework' },\n" +
    "  { key: 'requirements', href: '/docs/requirements', label: 'Requirements' },\n" +
    "  { key: 'architecture', href: '/docs/architecture', label: 'Architecture' },\n" +
    "  { key: 'plan',         href: '/docs/plan',         label: 'Plan' },\n" +
    "  { key: 'build',        href: '/docs/build',        label: 'Build' },\n" +
    "];");
  src = src.replace(/function topLink\(item, active\) \{[\s\S]*?\n\}/,
    "function topLink(item, active, i) {\n" +
    "  var cls = 'nav-step' + (item.key === active ? ' on' : '') + (i === 0 ? ' first' : '');\n" +
    "  return '<a href=\"' + item.href + '\" class=\"' + cls + '\">' + item.label + '</a>';\n" +
    "}");
  src = src.replace(/const links = TOP\.map\(t => topLink\(t, activeKey\)\)\.join\([^)]*\);/,
    "const links = TOP.map(function (t, i) { return topLink(t, activeKey, i); }).join('\\n');");
  const navArrowCss = '<style>\n' +
    '  .nav-dd{position:relative;}\n' +
    '  .nav-dd>summary{list-style:none;cursor:pointer;color:#C8C8C2;padding:5px 9px;border-radius:7px;user-select:none;}\n' +
    '  .nav-dd>summary::-webkit-details-marker{display:none;}\n' +
    '  .nav-dd>summary::marker{content:"";}\n' +
    '  .nav-dd-menu{position:absolute;top:calc(100% + 6px);left:0;min-width:300px;max-height:72vh;overflow-y:auto;background:#161618;border:1px solid #2A2A2E;border-radius:10px;padding:6px;box-shadow:0 14px 34px rgba(0,0,0,.5);z-index:10001;}\n' +
    '  .nav-dd-menu a{display:block;color:#C8C8C2;text-decoration:none;padding:7px 10px;border-radius:6px;font-size:13px;white-space:nowrap;}\n' +
    '  .nav-dd-menu a:hover{background:rgba(255,255,255,.06);color:#fff;}\n' +
    '  .nav-dd-lab{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#6A6A66;padding:9px 10px 3px;}\n' +
    '  .docs-nav .nav-step{display:inline-block;color:#C8C8C2;text-decoration:none;font-size:13px;padding:5px 11px;border-radius:7px;transition:background .12s,color .12s;}\n' +
    '  .docs-nav .nav-step:hover{background:rgba(255,255,255,.05);color:#fff;}\n' +
    '  .docs-nav .nav-step.on{color:#97C459;background:rgba(151,196,89,.12);}\n' +
    '  .docs-nav .nav-dd>summary.nav-step{border-radius:7px;}\n' +
    '  .docs-nav .nav-dd[open]>summary.nav-step{color:#fff;background:rgba(255,255,255,.07);}\n' +
    '</style>';
  src = src.replace(/const STYLE\s*=\s*"(?:[^"\\]|\\.)*";/, 'const STYLE   = ' + JSON.stringify(navArrowCss) + ';');

  // (The old "✎ Edit in wizard" nav link was removed — editing now lives in the
  // in-page hamburger menu, so the top nav stays a clean process flow + ← App.)

  // "← App" returns to the project-wizard homepage (the project tiles) — NOT the
  // docs pod root. Bake the wizard's origin from the deploy request as a no-JS
  // default; the in-page editor refines it from the pod's own hostname at runtime.
  let appHref = '/';
  if (ctx.wizardEditUrl) { const wm = String(ctx.wizardEditUrl).match(/^https?:\/\/[^/]+/); if (wm) appHref = wm[0] + '/'; }
  src = src.replace(/const APP\s*=\s*"(?:[^"\\]|\\.)*";/,
    'const APP     = ' + JSON.stringify('<a href="' + appHref + '" class="nav-app" style="color:#7A7A75;text-decoration:none;padding:5px 9px;border-radius:7px;margin-left:auto;">← App</a>') + ';');
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
