// ============================================================================
//  docs-editor-client.js — the in-page editor for the DEPLOYED docs site.
//
//  Injected into every /docs page by lib/docs-editor.js (served at
//  /_editor/client.js). Adds, on the docs nav:
//    • a "Changelog" tab  — every Edit→Assess→Apply, newest first, each row
//      expandable: plain-English summary up top, technical detail below.
//    • a hamburger (☰) menu — "Edit" opens the wizard intake in an overlay.
//
//  Edit mirrors the onboarding wizard: numbered pills, drag-to-reorder rows,
//  add/remove. NOTHING is saved until you click "Save & Assess": that posts the
//  buffer to /api/assess, shows accept/revert cards, and /api/apply writes the
//  docs in place (the project folder is bind-mounted, so changes go live) and
//  records the change in the log this same script renders.
//
//  Vanilla, dependency-free, namespaced `pwe-` to avoid clashing with the page.
// ============================================================================
(function () {
  'use strict';
  if (window.__pweLoaded) return; window.__pweLoaded = true;

  // ── tiny helpers ────────────────────────────────────────────────────────────
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function el(html) { var d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; }
  function api(url, opts) { return fetch(url, opts).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }, function () { return { ok: r.ok, j: {} }; }); }); }
  function fmtWhen(iso) { if (!iso) return ''; var d = new Date(iso); if (isNaN(d)) return iso; return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) + ' · ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
  function toast(msg, isErr) {
    var t = el('<div class="pwe-toast' + (isErr ? ' err' : '') + '"></div>'); t.textContent = msg;
    document.body.appendChild(t); setTimeout(function () { t.classList.add('go'); }, 10);
    setTimeout(function () { t.classList.remove('go'); setTimeout(function () { t.remove(); }, 300); }, 3400);
  }

  // ── intake model (subset of the wizard's, minus deploy-only steps) ───────────
  var TABLES = {
    requirements: { label: 'requirement', title: 'Requirements', cols: [
      { k: 'title', th: 'Requirement', ph: 'Users can sign up and pay', w: '28%' },
      { k: 'priority', th: 'Priority', sel: ['Must', 'Should', 'May', 'Won’t'], w: '12%' },
      { k: 'test', th: 'How you’d test it (plain English)', ph: 'A new visitor finishes checkout in under 3 minutes', w: '60%', ml: true }] },
    decisions: { label: 'decision', title: 'Decisions', cols: [
      { k: 'concern', th: 'Concern', ph: 'Database', w: '20%' },
      { k: 'choice', th: 'Decision', ph: 'Managed Postgres (Neon)', w: '28%' },
      { k: 'why', th: 'Why (the trade-off you accept)', ph: 'Zero ops; vendor lock-in acceptable', w: '52%', ml: true }] },
    milestones: { label: 'milestone', title: 'Milestones', cols: [
      { k: 'name', th: 'Milestone', ph: 'M1 · Foundation', w: '24%' },
      { k: 'done', th: 'Done means…', ph: 'App deployed, reachable over HTTPS', w: '54%', ml: true },
      { k: 'target', th: 'Target', ph: 'Week 2', w: '22%' }] },
    risks: { label: 'risk', title: 'Risks', cols: [
      { k: 'risk', th: 'Risk / constraint', ph: 'Sales-tax exposure across regions', w: '50%', ml: true },
      { k: 'mitigation', th: 'Mitigation / hard limit', ph: 'Launch US + Canada only; use a tax provider', w: '50%', ml: true }] },
    scalability: { label: 'scalability item', title: 'Non-functional & scale', cols: [
      { k: 'area', th: 'Area', ph: 'Availability', w: '22%' },
      { k: 'target', th: 'Target / requirement', ph: '99.9% uptime; p95 API < 200ms at 10k req/min', w: '46%', ml: true },
      { k: 'adr', th: 'ADR / decision', ph: 'Multi-AZ, autoscaling workers, read replicas', w: '32%', ml: true }] },
  };
  var TABLE_ORDER = ['requirements', 'decisions', 'milestones', 'risks', 'scalability'];
  var PRODUCT_FIELDS = [
    ['oneliner', 'One-liner — what is it, in your own words?', 'text'],
    ['problem', 'The problem — who hurts today, and why current options fail', 'area'],
    ['users', 'Who exactly is it for — and what do they need that others don’t?', 'area'],
    ['differentiator', 'What makes it unmistakably better than how they solve this today?', 'area'],
    ['experience', 'What should using it FEEL like? (the experience bar)', 'area'],
    ['success', 'What does success look like in 6 months?', 'area'],
    ['notBuilding', 'Explicitly NOT building (one per line)', 'area'],
  ];
  function emptyRow(t) { var r = {}; TABLES[t].cols.forEach(function (c) { r[c.k] = c.sel ? c.sel[0] : ''; }); return r; }

  // ── styles (dark theme matching the docs nav + onboarding wizard) ────────────
  var CSS = [
    '.pwe-hide{display:none!important}',
    '.pwe-navbtn{color:#C8C8C2;text-decoration:none;padding:5px 9px;border-radius:7px;cursor:pointer;background:none;border:none;font:inherit;font-size:14px}',
    '.pwe-navbtn:hover{color:#fff;background:rgba(255,255,255,.06)}',
    '.pwe-burger{font-size:17px;line-height:1}',
    '.pwe-menu{position:absolute;top:46px;right:12px;z-index:10050;background:#161618;border:1px solid #2A2A2E;border-radius:10px;padding:6px;min-width:210px;box-shadow:0 14px 34px rgba(0,0,0,.5)}',
    '.pwe-menu button{display:flex;gap:9px;align-items:center;width:100%;text-align:left;color:#E8E8E4;background:none;border:none;padding:9px 11px;border-radius:7px;cursor:pointer;font:inherit;font-size:14px}',
    '.pwe-menu button:hover{background:rgba(255,255,255,.06)}',
    '.pwe-menu .pwe-sub{font-size:11px;color:#6A6A66;padding:7px 11px 3px;letter-spacing:.1em;text-transform:uppercase}',
    '.pwe-bg{position:fixed;inset:0;z-index:10060;background:rgba(8,8,10,.72);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);display:flex;align-items:flex-start;justify-content:center;padding:34px 16px;overflow:auto}',
    '.pwe-modal{width:100%;max-width:1280px;background:#0E0E10;border:1px solid #2A2A2E;border-radius:14px;color:#E8E8E4;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;box-shadow:0 30px 80px rgba(0,0,0,.6);overflow:hidden}',
    '.pwe-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 20px;border-bottom:1px solid #2A2A2E;position:sticky;top:0;background:#0E0E10;z-index:2}',
    '.pwe-head h2{margin:0;font-size:19px}',
    '.pwe-x{background:none;border:none;color:#9A9A95;font-size:22px;cursor:pointer;line-height:1;padding:2px 6px;border-radius:6px}',
    '.pwe-x:hover{color:#fff;background:rgba(255,255,255,.06)}',
    '.pwe-pills{display:flex;flex-wrap:wrap;gap:2px;padding:10px 20px 0;border-bottom:1px solid #2A2A2E}',
    '.pwe-pill{background:none;border:none;border-bottom:2px solid transparent;color:#9A9A95;border-radius:0;padding:9px 14px;font-size:13.5px;cursor:pointer;margin-bottom:-1px}',
    '.pwe-pill:hover{color:#E8E8E4}',
    '.pwe-pill.on{color:#97C459;border-bottom-color:#97C459;font-weight:600}',
    '.pwe-pill.done{color:#C8C8C2}',
    '.pwe-body{padding:16px 20px 4px}',
    '.pwe-body h3{font-size:17px;margin:6px 0 4px}',
    '.pwe-hint{color:#9A9A95;font-size:13px;margin:0 0 14px}',
    '.pwe-body label{display:block;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#9A9A95;margin:12px 0 5px}',
    '.pwe-body input[type=text],.pwe-body input[type=date],.pwe-body textarea,.pwe-cell{width:100%;background:#161618;border:1px solid #2A2A2E;border-radius:8px;color:#E8E8E4;padding:9px 11px;font:inherit;font-size:14px}',
    '.pwe-body textarea{resize:vertical;min-height:66px;line-height:1.5}',
    '.pwe-cell{min-height:66px}',
    '.pwe-body input:focus,.pwe-body textarea:focus,.pwe-body select:focus{outline:none;border-color:#97C459}',
    '.pwe-row2{display:flex;gap:12px}.pwe-row2>div{flex:1}',
    '.pwe-tbl{width:100%;border-collapse:collapse;margin-top:6px}',
    '.pwe-tbl th{text-align:left;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#6A6A66;padding:6px 6px;font-weight:600}',
    '.pwe-tbl td{padding:4px 6px;vertical-align:top}',
    '.pwe-tbl select{width:100%;background:#161618;border:1px solid #2A2A2E;border-radius:8px;color:#E8E8E4;padding:8px;font:inherit;font-size:13px}',
    '.pwe-grip{cursor:grab;color:#6A6A66;text-align:center;width:22px;user-select:none;padding-top:12px!important}',
    '.pwe-tr.drag{opacity:.4}.pwe-tr.drop{box-shadow:inset 0 2px 0 #97C459}',
    '.pwe-del{background:none;border:none;color:#6A6A66;font-size:18px;cursor:pointer;padding:6px}.pwe-del:hover{color:#E0A848}',
    '.pwe-add{background:#161618;border:1px solid #2A2A2E;color:#C8C8C2;border-radius:8px;padding:7px 12px;font-size:13px;cursor:pointer;margin-top:10px}.pwe-add:hover{border-color:#97C459;color:#97C459}',
    '.pwe-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:14px 20px;border-top:1px solid #2A2A2E;position:sticky;bottom:0;background:#0E0E10}',
    '.pwe-btn{border-radius:8px;padding:9px 15px;font:inherit;font-size:14px;cursor:pointer;border:1px solid #2A2A2E;background:#161618;color:#E8E8E4}',
    '.pwe-btn:hover{border-color:#3a3a40}',
    '.pwe-btn.primary{background:#97C459;border-color:#97C459;color:#0E0E10;font-weight:600}',
    '.pwe-btn.primary:hover{background:#a7d069}',
    '.pwe-btn:disabled{opacity:.5;cursor:default}',
    '.pwe-status{color:#9A9A95;font-size:13px}.pwe-status.err{color:#E06A6A}',
    '.pwe-warn{background:rgba(224,168,72,.1);border:1px solid rgba(224,168,72,.4);border-radius:8px;padding:10px 12px;font-size:13px;color:#E0A848;margin:0 20px 4px}',
    // accept/revert cards
    '.pwe-card{border:1px solid #2A2A2E;border-radius:10px;padding:12px 14px;margin:10px 0;background:#131315}',
    '.pwe-card .pwe-acc{display:flex;gap:8px;align-items:center;font-size:13px;color:#9A9A95;margin-bottom:8px;cursor:pointer}',
    '.pwe-kind{display:inline-block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;border-radius:999px;padding:3px 9px;margin-bottom:6px}',
    '.pwe-kind.doc{background:rgba(111,168,220,.14);color:#6FA8DC}.pwe-kind.linear{background:rgba(169,155,224,.14);color:#A99BE0}.pwe-kind.code{background:rgba(151,196,89,.14);color:#97C459}.pwe-kind.closed{background:rgba(224,168,72,.14);color:#E0A848}',
    '.pwe-chg{font-size:13px;color:#C8C8C2;margin:3px 0}.pwe-chg .was{color:#E06A6A}.pwe-chg .now{color:#97C459}',
    '.pwe-grp{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#6A6A66;margin:16px 0 2px}',
    // changelog
    '.pwe-cl{padding:8px 20px 16px}',
    '.pwe-cl-entry{border:1px solid #2A2A2E;border-radius:10px;margin:10px 0;overflow:hidden;background:#131315}',
    '.pwe-cl-h{display:flex;gap:12px;align-items:flex-start;padding:13px 15px;cursor:pointer}',
    '.pwe-cl-h:hover{background:rgba(255,255,255,.03)}',
    '.pwe-cl-tw{flex:1;min-width:0}',
    '.pwe-cl-when{font-size:12px;color:#6A6A66;margin-bottom:3px}',
    '.pwe-cl-sum{font-size:14px;color:#E8E8E4}',
    '.pwe-cl-id{font-size:11px;color:#97C459;font-family:ui-monospace,Menlo,monospace;background:rgba(151,196,89,.1);border-radius:6px;padding:2px 7px;white-space:nowrap}',
    '.pwe-cl-caret{color:#6A6A66;transition:transform .15s;margin-top:2px}',
    '.pwe-cl-entry.open .pwe-cl-caret{transform:rotate(90deg)}',
    '.pwe-cl-detail{padding:2px 15px 14px;border-top:1px solid #2A2A2E}',
    '.pwe-cl-item{margin:11px 0}',
    '.pwe-cl-plain{font-size:14px;color:#E8E8E4;display:flex;gap:8px}',
    '.pwe-cl-tech{font-size:12.5px;color:#9A9A95;margin:3px 0 0 22px;white-space:pre-wrap}',
    '.pwe-cl-dot{color:#97C459}',
    '.pwe-cl-err{color:#E06A6A;font-size:12.5px;margin-top:8px}',
    '.pwe-applied{border:1px solid #2A2A2E;border-radius:10px;overflow:hidden}',
    '.pwe-applied-row{padding:10px 14px;border-bottom:1px solid #2A2A2E;font-size:14px;color:#E8E8E4}',
    '.pwe-applied-row:last-child{border-bottom:none}',
    '.pwe-applied-row a{color:#97C459;font-family:ui-monospace,Menlo,monospace}',
    // diagram draft preview (swim-lane) — mirrors the docs architecture page
    '.pwe-diag{border:1px solid #534AB7;background:rgba(169,155,224,.06);border-radius:11px;padding:12px 14px;margin:10px 0}',
    '.pwe-diag .pwe-diag-h{display:flex;align-items:center;gap:10px;margin-bottom:8px}',
    '.pwe-diag .pwe-diag-h b{font-size:14px}.pwe-diag .pwe-diag-h .grow{flex:1}',
    '.pwe-fs{position:fixed;inset:0;z-index:10080;background:#0E0E10;overflow:auto;padding:24px}',
    '.pwe-fs .pwe-fs-x{position:fixed;top:16px;right:20px;background:#161618;border:1px solid #2A2A2E;color:#E8E8E4;border-radius:8px;padding:8px 14px;cursor:pointer;z-index:2}',
    '.al-wrap{position:relative;background:#141417;border:1px solid #2A2A2E;border-radius:14px;padding:6px 20px 16px;overflow-x:auto}',
    '.al-edges{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1}',
    '.al-layer{display:grid;grid-template-columns:140px 1fr;align-items:center;gap:18px;padding:16px 0;position:relative;z-index:2}',
    '.al-layer+.al-layer{border-top:1px solid rgba(255,255,255,.04)}',
    '.al-label{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#6A6A66;font-weight:600}',
    '.al-row{display:flex;gap:16px;align-items:stretch;justify-content:center;flex-wrap:nowrap}.al-row.pipe{justify-content:flex-start}',
    '.al-node{background:#161618;border:1px solid #3A3A40;border-radius:11px;padding:11px 14px;flex:0 1 auto;min-width:140px;max-width:300px}.al-node.app{max-width:420px}',
    '.al-node .eye{font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:#6A6A66;margin-bottom:4px}',
    '.al-node .ti{font-size:14px;font-weight:600;margin:0 0 4px;color:#E8E8E4}',
    '.al-node .ln,.al-node .bu{font-size:12px;color:#9A9A95;line-height:1.45}.al-node .bu{margin-top:3px}',
    '.al-subs{display:flex;gap:10px;margin-top:10px}.al-sub{flex:1;background:rgba(255,255,255,.02);border:1px solid #2A2A2E;border-radius:8px;padding:7px 9px}',
    '.al-sub .sh{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#6A6A66;margin-bottom:3px}.al-sub .sl{font-size:11px;color:#9A9A95;line-height:1.4}',
    '.al-node.app{background:linear-gradient(180deg,rgba(151,196,89,.08),#161618);border-color:#639922}.al-node.app .ti{color:#C0DD97}',
    '.al-node.saas{background:#1f1b30;border-color:#534AB7}.al-node.saas .ti{color:#A99BE0}',
    '.al-node.data{background:#15212a;border-color:#3E7EA0}.al-node.data .ti{color:#8FC5E0}',
    '.al-node.edge{background:#15171a;border-color:#3A3A40}.al-node.infra{background:#2a2212;border-color:#876318}.al-node.infra .ti{color:#E0A848}',
    '.pwe-empty{color:#9A9A95;font-size:14px;padding:24px 4px;text-align:center}',
    // file browser (Export / code)
    '.pwe-brow{display:flex;height:64vh;min-height:360px;border-top:1px solid #2A2A2E}',
    '.pwe-tree{width:300px;flex:none;overflow:auto;border-right:1px solid #2A2A2E;padding:8px 0;background:#0d0d0f}',
    '.pwe-trow{padding:4px 10px;font-size:13px;color:#C8C8C2;cursor:pointer;white-space:nowrap;font-family:ui-monospace,Menlo,monospace}',
    '.pwe-trow:hover{background:rgba(255,255,255,.04)}.pwe-trow.on{background:rgba(151,196,89,.12);color:#97C459}',
    '.pwe-trow.dir{color:#9A9A95;cursor:default}',
    '.pwe-view{flex:1;overflow:auto;background:#0E0E10}',
    '.pwe-vh{display:flex;justify-content:space-between;gap:10px;padding:9px 14px;border-bottom:1px solid #2A2A2E;font-size:12px;color:#9A9A95;position:sticky;top:0;background:#0E0E10;font-family:ui-monospace,Menlo,monospace}',
    '.pwe-view pre{margin:0;padding:14px;font:12.5px/1.6 ui-monospace,Menlo,monospace;color:#E8E8E4;white-space:pre;overflow:auto}',
    '.pwe-ph{color:#6A6A66;padding:30px;text-align:center;font-size:13px}',
    '.pwe-toast{position:fixed;left:50%;bottom:26px;transform:translate(-50%,16px);opacity:0;transition:.3s;background:#161618;border:1px solid #2A2A2E;color:#E8E8E4;padding:11px 18px;border-radius:10px;z-index:10090;font:14px/1.4 -apple-system,sans-serif;max-width:80vw;box-shadow:0 12px 30px rgba(0,0,0,.5)}',
    '.pwe-toast.go{opacity:1;transform:translate(-50%,0)}.pwe-toast.err{border-color:#E06A6A;color:#E06A6A}',
    '.pwe-spin{display:inline-block;width:13px;height:13px;border:2px solid #3a3a40;border-top-color:#97C459;border-radius:50%;animation:pwe-rot .7s linear infinite;vertical-align:-2px;margin-right:6px}',
    '@keyframes pwe-rot{to{transform:rotate(360deg)}}',
  ].join('\n');

  function injectStyles() { var s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); }

  // ── nav wiring: Changelog tab + hamburger menu ───────────────────────────────
  var caps = null; // { hasClaude, hasLinear, hasCorpus }

  function mountNav() {
    var nav = document.querySelector('nav.docs-nav');
    if (!nav) return;
    var appLink = nav.querySelector('a[href="/"]'); // the "← App" link (margin-left:auto)

    var clBtn = el('<button class="pwe-navbtn" title="Change history">Changelog</button>');
    clBtn.addEventListener('click', openChangelog);

    var burger = el('<button class="pwe-navbtn pwe-burger" title="Edit & tools" aria-label="menu">☰</button>');
    var menu = null;
    burger.addEventListener('click', function (e) {
      e.stopPropagation();
      if (menu) { menu.remove(); menu = null; return; }
      menu = buildMenu();
      document.body.appendChild(menu);
      var r = burger.getBoundingClientRect();
      menu.style.top = (r.bottom + 6) + 'px'; menu.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
      setTimeout(function () { document.addEventListener('click', closeMenu); }, 0);
    });
    function closeMenu(ev) { if (menu && !menu.contains(ev.target)) { menu.remove(); menu = null; document.removeEventListener('click', closeMenu); } }

    if (appLink) { nav.insertBefore(clBtn, appLink); nav.insertBefore(burger, appLink); }
    else { nav.appendChild(clBtn); nav.appendChild(burger); }
  }

  function buildMenu() {
    var m = el('<div class="pwe-menu"></div>');
    var edit = el('<button>Edit the plan</button>');
    edit.addEventListener('click', function () { m.remove(); openEdit(); });
    m.appendChild(edit);
    var log = el('<button>Changelog</button>');
    log.addEventListener('click', function () { m.remove(); openChangelog(); });
    m.appendChild(log);
    var code = el('<button>Export / code</button>');
    code.addEventListener('click', function () { m.remove(); openBrowse(); });
    m.appendChild(code);
    return m;
  }

  // ── modal shell ─────────────────────────────────────────────────────────────
  function modal(title) {
    var bg = el('<div class="pwe-bg"></div>');
    var mod = el('<div class="pwe-modal"></div>');
    var head = el('<div class="pwe-head"><h2></h2><button class="pwe-x" title="Close">×</button></div>');
    head.querySelector('h2').textContent = title;
    head.querySelector('.pwe-x').addEventListener('click', function () { bg.remove(); });
    bg.addEventListener('click', function (e) { if (e.target === bg) bg.remove(); });
    mod.appendChild(head); bg.appendChild(mod); document.body.appendChild(bg);
    return { bg: bg, mod: mod, head: head, close: function () { bg.remove(); } };
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  EDIT — wizard intake in an overlay (deferred save → Assess → Apply)
  // ════════════════════════════════════════════════════════════════════════════
  function openEdit() {
    var m = modal('Edit the plan');
    var loading = el('<div class="pwe-body"><p class="pwe-hint"><span class="pwe-spin"></span>loading the current plan…</p></div>');
    m.mod.appendChild(loading);
    api('/api/intake').then(function (res) {
      loading.remove();
      if (!res.ok || !res.j.ok) { m.mod.appendChild(el('<div class="pwe-body"><p class="pwe-warn">Couldn’t load the plan: ' + esc((res.j && res.j.error) || 'unknown') + '</p></div>')); return; }
      caps = { hasClaude: res.j.hasClaude, hasLinear: res.j.hasLinear, hasCorpus: res.j.hasCorpus };
      runEditor(m, res.j.intake);
    });
  }

  function runEditor(m, baseline) {
    // working buffer — nothing here is saved until Assess→Apply
    var buf = JSON.parse(JSON.stringify(baseline || {}));
    buf.product = buf.product || {};
    TABLE_ORDER.forEach(function (t) { if (!Array.isArray(buf[t]) || !buf[t].length) buf[t] = [emptyRow(t)]; });

    var STEPS = [{ key: 'product', title: 'Product' }].concat(TABLE_ORDER.map(function (t) { return { key: t, title: TABLES[t].title }; }));
    var cur = 0;

    var pills = el('<div class="pwe-pills"></div>');
    var body = el('<div class="pwe-body"></div>');
    var warn = caps && caps.hasCorpus ? null : el('<div class="pwe-warn">No codebase is bundled with this deploy, so Assess can’t analyze code impact. Doc + tracker changes still work.</div>');
    var foot = el('<div class="pwe-foot"></div>');
    var assessBtn = el('<button class="pwe-btn primary">✦ Save &amp; Assess</button>');
    var cancelBtn = el('<button class="pwe-btn">Cancel</button>');
    var status = el('<span class="pwe-status"></span>');
    foot.appendChild(assessBtn); foot.appendChild(cancelBtn); foot.appendChild(status);

    STEPS.forEach(function (s, i) {
      var p = el('<button class="pwe-pill"></button>'); p.textContent = (i + 1) + ' · ' + s.title;
      p.addEventListener('click', function () { go(i); });
      pills.appendChild(p);
    });
    m.mod.appendChild(pills);
    if (warn) m.mod.appendChild(warn);
    m.mod.appendChild(body);
    m.mod.appendChild(foot);
    cancelBtn.addEventListener('click', m.close);

    function go(i) {
      cur = Math.max(0, Math.min(STEPS.length - 1, i));
      Array.prototype.forEach.call(pills.children, function (p, j) { p.classList.toggle('on', j === cur); p.classList.toggle('done', j < cur); });
      renderStep(STEPS[cur].key);
      m.mod.scrollIntoView ? m.mod.parentNode.scrollTo(0, 0) : null;
    }

    function renderStep(key) {
      if (key === 'product') return renderProduct();
      return renderTable(key);
    }

    function renderProduct() {
      var h = '<h3>Product</h3><p class="pwe-hint">The source of truth for scope. Specific beats generic.</p>' +
        '<div class="pwe-row2"><div><label>App name</label><input type="text" data-prod="name" value="' + esc(buf.product.name || '') + '"></div>' +
        '<div><label>Domain</label><input type="text" data-prod="domain" value="' + esc(buf.product.domain || '') + '"></div></div>' +
        '<label>Target start date</label><input type="date" data-top="startDate" value="' + esc(buf.startDate || '') + '">';
      PRODUCT_FIELDS.forEach(function (f) {
        h += '<label>' + esc(f[1]) + '</label>' + (f[2] === 'area'
          ? '<textarea rows="3" data-prod="' + f[0] + '">' + esc(buf.product[f[0]] || '') + '</textarea>'
          : '<input type="text" data-prod="' + f[0] + '" value="' + esc(buf.product[f[0]] || '') + '">');
      });
      body.innerHTML = h;
      body.querySelectorAll('[data-prod]').forEach(function (e) { e.addEventListener('input', function () { buf.product[e.getAttribute('data-prod')] = e.value; }); });
      var d = body.querySelector('[data-top]'); if (d) d.addEventListener('input', function () { buf.startDate = d.value; });
    }

    function renderTable(t) {
      body.innerHTML = '<h3>' + esc(TABLES[t].title) + '</h3><div id="pwe-host"></div>';
      drawRows(t, body.querySelector('#pwe-host'));
    }

    function drawRows(t, host) {
      var spec = TABLES[t];
      var h = '<table class="pwe-tbl"><thead><tr><th></th>';
      spec.cols.forEach(function (c) { h += '<th style="width:' + c.w + '">' + esc(c.th) + '</th>'; });
      h += '<th></th></tr></thead><tbody>';
      buf[t].forEach(function (row, i) {
        h += '<tr class="pwe-tr" data-row="' + i + '"><td class="pwe-grip" draggable="true" title="drag to reorder">⠿</td>';
        spec.cols.forEach(function (c) {
          h += '<td>';
          if (c.sel) { h += '<select data-i="' + i + '" data-c="' + c.k + '">' + c.sel.map(function (o) { return '<option' + (row[c.k] === o ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('') + '</select>'; }
          else if (c.ml) { h += '<textarea class="pwe-cell" rows="3" data-i="' + i + '" data-c="' + c.k + '" placeholder="' + esc(c.ph) + '">' + esc(row[c.k] || '') + '</textarea>'; }
          else { h += '<input class="pwe-cell" type="text" data-i="' + i + '" data-c="' + c.k + '" value="' + esc(row[c.k] || '') + '" placeholder="' + esc(c.ph) + '">'; }
          h += '</td>';
        });
        h += '<td><button class="pwe-del" data-del="' + i + '" title="remove">×</button></td></tr>';
      });
      h += '</tbody></table><button class="pwe-add" data-add="1">+ add ' + esc(spec.label) + '</button>';
      host.innerHTML = h;
      host.querySelectorAll('input,select,textarea').forEach(function (e) {
        e.addEventListener('input', function () { buf[t][+e.getAttribute('data-i')][e.getAttribute('data-c')] = e.value; });
      });
      host.querySelectorAll('[data-del]').forEach(function (b) {
        b.addEventListener('click', function () { buf[t].splice(+b.getAttribute('data-del'), 1); if (!buf[t].length) buf[t].push(emptyRow(t)); drawRows(t, host); });
      });
      host.querySelector('[data-add]').addEventListener('click', function () { buf[t].push(emptyRow(t)); drawRows(t, host); });

      // drag-to-reorder by the grip
      var from = null;
      host.querySelectorAll('tr.pwe-tr').forEach(function (tr) {
        var grip = tr.querySelector('.pwe-grip');
        grip.addEventListener('dragstart', function (e) { from = +tr.getAttribute('data-row'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(from)); } catch (x) {} tr.classList.add('drag'); });
        grip.addEventListener('dragend', function () { tr.classList.remove('drag'); host.querySelectorAll('tr.drop').forEach(function (r) { r.classList.remove('drop'); }); });
        tr.addEventListener('dragover', function (e) { e.preventDefault(); tr.classList.add('drop'); });
        tr.addEventListener('dragleave', function () { tr.classList.remove('drop'); });
        tr.addEventListener('drop', function (e) { e.preventDefault(); var to = +tr.getAttribute('data-row'); if (from === null || from === to) return; var moved = buf[t].splice(from, 1)[0]; buf[t].splice(to, 0, moved); from = null; drawRows(t, host); });
      });
    }

    function proposedIntake() {
      var out = JSON.parse(JSON.stringify(baseline || {}));
      out.product = buf.product; out.startDate = buf.startDate || '';
      TABLE_ORDER.forEach(function (t) { out[t] = (buf[t] || []).filter(function (r) { return TABLES[t].cols.some(function (c) { return !c.sel && String(r[c.k] || '').trim(); }); }); });
      return out;
    }

    assessBtn.addEventListener('click', function () {
      assessBtn.disabled = true; status.className = 'pwe-status'; status.innerHTML = '<span class="pwe-spin"></span>Assessing against the code' + (caps && caps.hasLinear ? ' + live Linear' : '') + '…';
      api('/api/assess', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proposed: proposedIntake() }) })
        .then(function (res) {
          assessBtn.disabled = false; var j = res.j || {};
          if (!res.ok) { status.className = 'pwe-status err'; status.textContent = '✗ ' + (j.error || 'assess failed') + (j.detail ? ' — ' + j.detail : ''); return; }
          if (j.empty) { status.className = 'pwe-status'; status.textContent = j.message || 'No changes to assess.'; return; }
          status.textContent = '';
          openAssess(m, proposedIntake(), j);
        }).catch(function (e) { assessBtn.disabled = false; status.className = 'pwe-status err'; status.textContent = '✗ ' + e.message; });
    });

    go(0);
  }

  // ── accept/revert review, then Apply ─────────────────────────────────────────
  function unitCard(u) {
    var inner = '';
    if (u.group === 'doc') {
      var det = '';
      (u.scalars || []).forEach(function (s) { det += '<div class="pwe-chg"><b>' + esc(s.field) + '</b>: <span class="was">' + esc(s.before || '∅') + '</span> → <span class="now">' + esc(s.after || '∅') + '</span></div>'; });
      (u.added || []).forEach(function (r) { det += '<div class="pwe-chg"><span class="now">+ ' + esc(JSON.stringify(r).slice(0, 160)) + '</span></div>'; });
      (u.removed || []).forEach(function (r) { det += '<div class="pwe-chg"><span class="was">− ' + esc(JSON.stringify(r).slice(0, 160)) + '</span></div>'; });
      (u.modified || []).forEach(function (mm) { det += '<div class="pwe-chg">~ ' + esc(JSON.stringify(mm.after || mm).slice(0, 160)) + '</div>'; });
      inner = '<span class="pwe-kind doc">DOC · ' + esc(u.section) + '</span>' + (u.impact ? '<div class="pwe-hint" style="margin:0 0 6px">' + esc(u.impact) + '</div>' : '') + det;
    } else if (u.group === 'linear') {
      inner = '<span class="pwe-kind linear">LINEAR · ' + esc(u.action) + (u.issueIdentifier ? ' ' + esc(u.issueIdentifier) : '') + '</span><div>' + esc(u.title || '') + '</div>' + (u.objective ? '<div class="pwe-hint" style="margin:4px 0 0">' + esc(u.objective) + '</div>' : '') + (u.reason ? '<div class="pwe-hint" style="margin:2px 0 0">' + esc(u.reason) + '</div>' : '');
    } else if (u.group === 'affected-closed') {
      inner = '<span class="pwe-kind closed">CLOSED ISSUE · ' + esc(u.issueIdentifier) + '</span><div>' + esc(u.title || '') + '</div><div class="pwe-hint" style="margin:4px 0 0">' + esc(u.reason || '') + '</div>';
    } else if (u.group === 'code') {
      inner = '<span class="pwe-kind code">CODE IMPACT · ' + esc(u.area || '') + '</span><div class="pwe-hint" style="margin:0 0 4px">' + esc(u.detail || '') + '</div>' +
        (u.functions || []).map(function (f) { return '<div class="pwe-chg"><code>' + esc(f.name) + '</code>' + (f.file ? ' <span style="color:#6A6A66">' + esc(f.file) + '</span>' : '') + ' — ' + esc(f.impact || '') + '</div>'; }).join('');
    }
    var card = el('<div class="pwe-card"><label class="pwe-acc"><input type="checkbox" class="pwe-cb" checked> accept this change</label><div>' + inner + '</div></div>');
    card.querySelector('.pwe-cb').setAttribute('data-uid', u.id);
    return card;
  }

  function openAssess(editM, proposed, result) {
    var units = result.units || [];
    var m = modal('Review changes');
    var sum = el('<div class="pwe-body"></div>');
    sum.appendChild(el('<p class="pwe-hint">' + esc(result.summary || 'Review each change, then apply the ones you accept.') + '</p>'));
    if (!result.hasLinear) sum.appendChild(el('<p class="pwe-hint">No Linear tracker linked — doc changes apply but no issues sync.</p>'));

    // Architecture diagram draft — the assessment regenerated it because the
    // change affects the architecture. Preview it (full-screen) before committing.
    var draft = result.architectureDraft;
    var draftOk = draft && draft.architecture && (draft.architecture.layers || []).length;
    if (draftOk) {
      sum.appendChild(el('<div class="pwe-grp">Architecture diagram (updated)</div>'));
      var dcard = el('<div class="pwe-diag"><div class="pwe-diag-h"><label class="pwe-acc" style="margin:0"><input type="checkbox" class="pwe-diag-cb" checked> accept the updated diagram</label><span class="grow"></span><button class="pwe-btn" type="button" id="pwe-fs-btn">⛶ Full screen</button></div></div>');
      var swEl = buildSwim(draft.architecture);
      dcard.appendChild(swEl);
      dcard.querySelector('#pwe-fs-btn').addEventListener('click', function () { openDiagramFull(draft.architecture); });
      sum.appendChild(dcard);
      setTimeout(function () { drawSwim(swEl, draft.architecture.edges); }, 80);
    }
    var groups = { doc: 'Documentation', linear: 'Linear issues', 'affected-closed': 'Affected completed issues', code: 'Code impact' };
    Object.keys(groups).forEach(function (g) {
      var arr = units.filter(function (u) { return u.group === g; });
      if (!arr.length) return;
      sum.appendChild(el('<div class="pwe-grp">' + groups[g] + ' (' + arr.length + ')</div>'));
      arr.forEach(function (u) { sum.appendChild(unitCard(u)); });
    });
    if (!units.length) sum.appendChild(el('<p class="pwe-empty">No actionable changes detected.</p>'));
    m.mod.appendChild(sum);

    var foot = el('<div class="pwe-foot"></div>');
    var applyBtn = el('<button class="pwe-btn primary">✦ Apply accepted</button>');
    var backBtn = el('<button class="pwe-btn">Back to editing</button>');
    var status = el('<span class="pwe-status"></span>');
    foot.appendChild(applyBtn); foot.appendChild(backBtn); foot.appendChild(status);
    m.mod.appendChild(foot);
    backBtn.addEventListener('click', m.close);

    applyBtn.addEventListener('click', function () {
      var accepted = Array.prototype.slice.call(m.mod.querySelectorAll('.pwe-cb:checked')).map(function (cb) { return cb.getAttribute('data-uid'); });
      var diagCb = m.mod.querySelector('.pwe-diag-cb');
      var archBody = (diagCb && diagCb.checked && result.architectureDraft) ? result.architectureDraft : null;
      applyBtn.disabled = true; status.className = 'pwe-status'; status.innerHTML = '<span class="pwe-spin"></span>Applying ' + accepted.length + ' change(s) — writing docs' + (archBody ? ' + diagram' : '') + (result.hasLinear ? ' + syncing Linear' : '') + '…';
      api('/api/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proposed: proposed, units: units, accepted: accepted, summary: result.summary, architecture: archBody }) })
        .then(function (res) {
          applyBtn.disabled = false; var j = res.j || {};
          if (!res.ok) { status.className = 'pwe-status err'; status.textContent = '✗ ' + (j.error || 'apply failed'); return; }
          showApplied(m, editM, j);
        }).catch(function (e) { applyBtn.disabled = false; status.className = 'pwe-status err'; status.textContent = '✗ ' + e.message; });
    });
  }

  // Applied summary — clickable links to every Linear issue created/updated/
  // cancelled or flagged, then a Done button that reloads the (now-live) docs.
  function showApplied(m, editM, j) {
    var a = j.applied || {};
    var VERB = { create: 'Created', update: 'Updated', cancel: 'Cancelled' };
    function issueLink(x, prefix) {
      var id = (x && (x.identifier || x.title)) || (typeof x === 'string' ? x : '');
      var url = x && x.url;
      var tail = (x && x.title && x.identifier) ? ' <span style="color:var(--muted,#9A9A95)">— ' + esc(x.title) + '</span>' : '';
      return '<div class="pwe-applied-row">' + esc(prefix) + ' ' +
        (url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(id) + '</a>' : '<b>' + esc(id) + '</b>') + tail + '</div>';
    }
    var rows = (a.linear || []).map(function (x) { return issueLink(x, VERB[x.action] || x.action); }).join('') +
      (a.affectedClosed || []).map(function (x) { return issueLink(x, 'Flagged (completed)'); }).join('');
    m.head.querySelector('h2').textContent = j.changeId + ' applied';
    var body = el('<div class="pwe-body"></div>');
    body.appendChild(el('<p class="pwe-hint">' + (a.docSections || []).length + ' doc section(s) updated' +
      ((a.linear || []).length ? ' · ' + a.linear.length + ' Linear issue(s)' : '') +
      ((a.affectedClosed || []).length ? ' · ' + a.affectedClosed.length + ' flagged' : '') + '. The docs are now live.</p>'));
    if (rows) { body.appendChild(el('<div class="pwe-grp">Linear issues</div>')); body.appendChild(el('<div class="pwe-applied">' + rows + '</div>')); }
    else { body.appendChild(el('<p class="pwe-hint">No tracker changes were applied.</p>')); }
    if ((j.errors || []).length) body.appendChild(el('<div class="pwe-cl-err">⚠ ' + j.errors.map(esc).join('<br>⚠ ') + '</div>'));
    // replace the assess body + foot with the summary
    var oldBody = m.mod.querySelector('.pwe-body'); if (oldBody) oldBody.remove();
    var oldFoot = m.mod.querySelector('.pwe-foot'); if (oldFoot) oldFoot.remove();
    m.mod.appendChild(body);
    var foot = el('<div class="pwe-foot"></div>');
    var done = el('<button class="pwe-btn primary">Done — reload docs</button>');
    function finish() { m.close(); if (editM) editM.close(); location.reload(); }
    done.addEventListener('click', finish);
    foot.appendChild(done); m.mod.appendChild(foot);
    toast(j.changeId + ' applied');
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  CHANGELOG — newest first, each entry expandable (plain on top, tech below)
  // ════════════════════════════════════════════════════════════════════════════
  function openChangelog() {
    var m = modal('Changelog');
    var wrap = el('<div class="pwe-cl"><p class="pwe-hint"><span class="pwe-spin"></span>loading…</p></div>');
    m.mod.appendChild(wrap);
    api('/api/changes').then(function (res) {
      wrap.innerHTML = '';
      var changes = (res.j && res.j.changes) || [];
      if (!changes.length) { wrap.appendChild(el('<div class="pwe-empty">No changes yet. Use the ☰ menu → <b>Edit the plan</b> to make your first edit &amp; assess.</div>')); return; }
      changes.forEach(function (c) { wrap.appendChild(changeEntry(c)); });
    });
  }

  function changeEntry(c) {
    var items = c.items || [];
    var entry = el('<div class="pwe-cl-entry"></div>');
    var head = el('<div class="pwe-cl-h">' +
      '<span class="pwe-cl-caret">▸</span>' +
      '<div class="pwe-cl-tw"><div class="pwe-cl-when">' + esc(fmtWhen(c.at)) + '</div>' +
      '<div class="pwe-cl-sum">' + esc(c.summary || plainTitle(c)) + '</div></div>' +
      '<span class="pwe-cl-id">' + esc(c.id || '') + '</span></div>');
    var detail = el('<div class="pwe-cl-detail pwe-hide"></div>');

    // plain-English items up top
    if (items.length) {
      items.forEach(function (it) {
        var d = '<div class="pwe-cl-item"><div class="pwe-cl-plain"><span class="pwe-cl-dot">●</span><span>' + esc(it.plain || '') + '</span></div>';
        if (it.tech) d += '<div class="pwe-cl-tech">' + esc(it.tech) + '</div>';
        d += '</div>';
        detail.appendChild(el(d));
      });
    } else {
      // older entries without items[] — fall back to the applied breakdown
      var a = c.applied || {};
      if ((a.docSections || []).length) detail.appendChild(el('<div class="pwe-cl-item"><div class="pwe-cl-plain"><span class="pwe-cl-dot">●</span><span>Updated: ' + esc(a.docSections.join(', ')) + '</span></div></div>'));
      (a.linear || []).forEach(function (l) { detail.appendChild(el('<div class="pwe-cl-item"><div class="pwe-cl-plain"><span class="pwe-cl-dot">●</span><span>' + esc(l.action) + ' ' + esc(l.identifier || l.title || '') + '</span></div></div>')); });
    }
    // technical footer: change id + any errors
    if ((c.errors || []).length) detail.appendChild(el('<div class="pwe-cl-err">⚠ ' + c.errors.map(esc).join('<br>⚠ ') + '</div>'));

    head.addEventListener('click', function () { entry.classList.toggle('open'); detail.classList.toggle('pwe-hide'); });
    entry.appendChild(head); entry.appendChild(detail);
    return entry;
  }
  function plainTitle(c) { var a = c.applied || {}; var n = (a.docSections || []).length; return n ? 'Updated ' + n + ' section(s)' : 'Change ' + (c.id || ''); }

  // ════════════════════════════════════════════════════════════════════════════
  //  EXPORT / CODE — browse the live container files + download the project
  // ════════════════════════════════════════════════════════════════════════════
  function fmtBytes(n) { n = +n || 0; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; return (n / 1048576).toFixed(1) + ' MB'; }

  function openBrowse() {
    var m = modal('Export / code');
    var dl = el('<a class="pwe-btn primary" href="/api/export" download style="text-decoration:none">⤓ Download (.tar.gz)</a>');
    m.head.insertBefore(dl, m.head.querySelector('.pwe-x'));
    var brow = el('<div class="pwe-brow"><div class="pwe-tree"><div class="pwe-ph">loading…</div></div><div class="pwe-view"><div class="pwe-ph">Select a file to view it.</div></div></div>');
    m.mod.appendChild(brow);
    var tree = brow.querySelector('.pwe-tree'), view = brow.querySelector('.pwe-view');

    api('/api/files').then(function (res) {
      var files = (res.j && res.j.files) || [];
      if (!files.length) { tree.innerHTML = '<div class="pwe-ph">no files</div>'; return; }
      tree.innerHTML = files.map(function (f) {
        var depth = f.path.split('/').length - 1;
        var name = f.path.split('/').pop();
        var pad = 'padding-left:' + (10 + depth * 13) + 'px';
        if (f.type === 'dir') return '<div class="pwe-trow dir" style="' + pad + '">▸ ' + esc(name) + '</div>';
        return '<div class="pwe-trow" data-path="' + esc(f.path) + '" style="' + pad + '">· ' + esc(name) + '</div>';
      }).join('');
      tree.querySelectorAll('.pwe-trow[data-path]').forEach(function (row) {
        row.addEventListener('click', function () {
          tree.querySelectorAll('.pwe-trow').forEach(function (r) { r.classList.remove('on'); });
          row.classList.add('on');
          var rel = row.getAttribute('data-path');
          view.innerHTML = '<div class="pwe-ph">loading…</div>';
          api('/api/file?path=' + encodeURIComponent(rel)).then(function (r) {
            var d = r.j || {};
            if (d.binary) { view.innerHTML = '<div class="pwe-vh"><span>' + esc(rel) + '</span><span>' + fmtBytes(d.size) + '</span></div><div class="pwe-ph">Binary file — use Download to get it.</div>'; return; }
            if (d.tooLarge) { view.innerHTML = '<div class="pwe-vh"><span>' + esc(rel) + '</span><span>' + fmtBytes(d.size) + '</span></div><div class="pwe-ph">Too large to preview (' + fmtBytes(d.size) + ').</div>'; return; }
            var pre = document.createElement('pre'); pre.textContent = d.content || '';
            view.innerHTML = '<div class="pwe-vh"><span>' + esc(rel) + '</span><span>' + fmtBytes(d.size) + '</span></div>';
            view.appendChild(pre);
          });
        });
      });
      // open a sensible first file (PLAN-INTAKE.json or the first doc)
      var first = tree.querySelector('.pwe-trow[data-path]'); if (first) first.click();
    });
  }

  // ── swim-lane diagram renderer (for the Assess diagram-draft preview) ─────────
  function buildSwim(arch) {
    var wrap = el('<div class="al-wrap"><svg class="al-edges"></svg></div>');
    (arch.layers || []).forEach(function (L) {
      var pipe = /ci|cd|deploy|build|pipeline/i.test(L.label) ? ' pipe' : '';
      var nodes = (L.nodes || []).map(function (n) {
        var lines = (n.lines || []).length ? '<div class="ln">' + (n.lines || []).map(esc).join('<br>') + '</div>' : '';
        var bullets = (n.bullets || []).length ? '<div class="bu">' + (n.bullets || []).map(function (b) { return '• ' + esc(b); }).join('<br>') + '</div>' : '';
        var subs = (n.subs || []).length ? '<div class="al-subs">' + (n.subs || []).map(function (s) { return '<div class="al-sub"><div class="sh">' + esc(s.head) + '</div><div class="sl">' + (s.lines || []).map(esc).join('<br>') + '</div></div>'; }).join('') + '</div>' : '';
        return '<div class="al-node ' + esc(n.cls || 'edge') + '" data-id="' + esc(String(n.id)) + '">' + (n.eyebrow ? '<div class="eye">' + esc(n.eyebrow) + '</div>' : '') + '<div class="ti">' + esc(n.title) + '</div>' + lines + bullets + subs + '</div>';
      }).join('');
      wrap.appendChild(el('<div class="al-layer"><div class="al-label">' + esc(L.label) + '</div><div class="al-row' + pipe + '">' + nodes + '</div></div>'));
    });
    return wrap;
  }
  function drawSwim(wrap, edges) {
    var svg = wrap.querySelector('.al-edges'); if (!svg) return;
    var W = wrap.scrollWidth, H = wrap.scrollHeight;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.setAttribute('width', W); svg.setAttribute('height', H);
    var br = wrap.getBoundingClientRect(), byId = {};
    wrap.querySelectorAll('.al-node[data-id]').forEach(function (n) { byId[n.getAttribute('data-id')] = n; });
    var P = '', Lb = '', defs = '<defs><marker id="alarp" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#6A6A6E"/></marker></defs>';
    (edges || []).forEach(function (e) {
      var a = byId[e.from], b = byId[e.to]; if (!a || !b) return;
      var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      var ax = ra.left + ra.width / 2 - br.left, ay, bx = rb.left + rb.width / 2 - br.left, by;
      if (rb.top >= ra.bottom - 2) { ay = ra.bottom - br.top; by = rb.top - br.top; }
      else if (rb.bottom <= ra.top + 2) { ay = ra.top - br.top; by = rb.bottom - br.top; }
      else { ay = ra.top + ra.height / 2 - br.top; by = rb.top + rb.height / 2 - br.top; if (bx > ax) { ax = ra.right - br.left; bx = rb.left - br.left; } else { ax = ra.left - br.left; bx = rb.right - br.left; } }
      var k = e.kind, col = (k === 'deploy' || k === 'critical') ? '#5d7a3a' : k === 'webhook' ? '#9a7a30' : '#4a4a52';
      var ds = (k === 'webhook' || k === 'backup') ? ' stroke-dasharray="5 4"' : '', my = (ay + by) / 2;
      P += '<path d="M ' + ax + ' ' + ay + ' C ' + ax + ' ' + my + ' ' + bx + ' ' + my + ' ' + bx + ' ' + by + '" fill="none" stroke="' + col + '" stroke-width="1.5"' + ds + ' marker-end="url(#alarp)"/>';
      if (e.label) { var lw = String(e.label).length * 6.6 + 8, lx = (ax + bx) / 2; Lb += '<rect x="' + (lx - lw / 2) + '" y="' + (my - 9) + '" width="' + lw + '" height="16" rx="4" fill="#141417"/><text x="' + lx + '" y="' + (my + 3) + '" fill="#9A9A95" font-size="11" text-anchor="middle">' + esc(e.label) + '</text>'; }
    });
    svg.innerHTML = defs + P + Lb;
  }
  function openDiagramFull(arch) {
    var fs = el('<div class="pwe-fs"></div>');
    var x = el('<button class="pwe-fs-x">✕ Close</button>');
    x.addEventListener('click', function () { fs.remove(); });
    var w = buildSwim(arch); fs.appendChild(x); fs.appendChild(w); document.body.appendChild(fs);
    setTimeout(function () { drawSwim(w, arch.edges); }, 60);
  }

  // ── boot ─────────────────────────────────────────────────────────────────────
  function boot() { injectStyles(); mountNav(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
