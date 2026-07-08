// Wizard component — renders the PLAN intake for one project, autosaving answers
// to the server, and on finish triggers docs-kit generation. Exposed as window.Wizard.
(function () {
  'use strict';

  // `ml: true` = detailed-text column → renders as a multi-line textarea.
  // Title / short-label / select columns stay single-line.
  var TABLES = {
    stakeholders: { label: 'stakeholder', cols: [
      { k: 'name', th: 'Name', ph: 'Jane Doe', w: '22%' },
      { k: 'email', th: 'Email', ph: 'jane@acme.com', w: '26%' },
      { k: 'phone', th: 'Phone', ph: '+1 555 0100', w: '16%' },
      { k: 'role', th: 'Role in project', ph: 'Product owner / sponsor', w: '36%' }] },
    requirements: { label: 'requirement', cols: [
      { k: 'title', th: 'Requirement', ph: 'Users can sign up and pay', w: '28%' },
      { k: 'priority', th: 'Priority', sel: ['Must', 'Should', 'May', 'Won’t'], w: '12%' },
      { k: 'test', th: 'How you’d test it (plain English)', ph: 'A new visitor finishes checkout in under 3 minutes', w: '60%', ml: true }] },
    decisions: { label: 'decision', cols: [
      { k: 'concern', th: 'Concern', ph: 'Database', w: '20%' },
      { k: 'choice', th: 'Decision', ph: 'your decision (e.g. database, auth, hosting)', w: '28%' },
      { k: 'why', th: 'Why (the trade-off you accept)', ph: 'the trade-off you accept', w: '52%', ml: true }] },
    milestones: { label: 'milestone', cols: [
      { k: 'name', th: 'Milestone', ph: 'M1 · Foundation', w: '24%' },
      { k: 'done', th: 'Done means…', ph: 'App deployed, reachable over HTTPS', w: '54%', ml: true },
      { k: 'target', th: 'Target', ph: 'Week 2', w: '22%' }] },
    risks: { label: 'risk', cols: [
      { k: 'risk', th: 'Risk / constraint', ph: 'Sales-tax exposure across regions', w: '50%', ml: true },
      { k: 'mitigation', th: 'Mitigation / hard limit', ph: 'Launch US + Canada only; use a tax provider', w: '50%', ml: true }] },
    scalability: { label: 'scalability item', title: 'Non-Functional & Scale', cols: [
      { k: 'area', th: 'Area', ph: 'Availability', w: '22%' },
      { k: 'target', th: 'Target / requirement', ph: '99.9% uptime; p95 API < 200ms at 10k req/min', w: '46%', ml: true },
      { k: 'adr', th: 'ADR / decision', ph: 'Multi-AZ, autoscaling workers, read replicas', w: '32%', ml: true }] },
  };

  // Strong starter rows for the "Load examples" button on each table.
  var EXAMPLES = {
    stakeholders: [
      { name: 'Jane Doe', email: 'jane@acme.com', phone: '+1 555 0100', role: 'Product owner / sponsor' },
      { name: 'Sam Rivera', email: 'sam@vendor.io', phone: '', role: 'Vendor contact (external)' },
    ],
    requirements: [
      { title: 'Users can sign up and pay', priority: 'Must', test: 'A new visitor creates an account, enters card details, and reaches the paid dashboard in under 3 minutes' },
      { title: 'Owner can invite teammates', priority: 'Should', test: 'An owner sends an invite and the invitee accepts and sees the shared workspace within the same session' },
      { title: 'Users can export their data', priority: 'Should', test: 'A user exports all their records as CSV and the downloaded file contains every row with no truncation' },
    ],
    // Neutral fallback only — the real seed comes from the org house defaults
    // (house-defaults.json, served via /api/config) and is applied below. No
    // specific architecture is hardcoded here.
    decisions: [
      { concern: 'Database', choice: '', why: '' },
      { concern: 'Auth', choice: '', why: '' },
      { concern: 'Hosting', choice: '', why: '' },
    ],
    milestones: [
      { name: 'M1 · Foundation', done: 'App containerized and deployed; a stranger can reach it over HTTPS', target: 'Week 2' },
      { name: 'M2 · Auth & multi-tenant', done: 'A user can sign up, log in, and only ever sees their own data', target: 'Week 4' },
      { name: 'M3 · Billing', done: 'A user can subscribe and the paywall enforces plan limits', target: 'Week 6' },
    ],
    risks: [
      { risk: 'Sales-tax / compliance exposure across regions', mitigation: 'Launch US + Canada only; use a tax provider from day one' },
      { risk: 'Vendor lock-in on managed services', mitigation: 'Keep domain logic transport-agnostic (ports & adapters) so vendors are swappable' },
    ],
    scalability: [
      { area: 'Availability', target: '99.9% monthly uptime; graceful degradation when a dependency is down', adr: 'Multi-AZ, health checks, timeouts + circuit breakers' },
      { area: 'Performance', target: 'p95 API latency < 200ms at 10k req/min; load-tested before launch', adr: 'Caching + read replicas; k6 load tests wired into CI' },
      { area: 'Observability', target: 'Structured logs, RED metrics, traces, and alerting on SLO burn', adr: 'OpenTelemetry → managed backend; dashboards + on-call alerts' },
    ],
  };

  // House defaults: the org's standard stack lives in house-defaults.json (set at
  // install/setup), exposed via /api/config. We use it to seed the Decisions
  // "Load examples" button and placeholder hints, so no specific architecture is
  // baked into this file. New projects are also pre-seeded server-side; per
  // project everything stays editable.
  // (Also carries capability flags — entraLookup gates the Stakeholders
  // directory search, so steps that need config await CONFIG_READY.)
  var CONFIG_READY = fetch('/api/config').then(function (r) { return r.json(); }).then(function (c) {
    c = c || {};
    var hd = c.houseDefaults;
    if (hd) {
      if (Array.isArray(hd.decisions) && hd.decisions.length) EXAMPLES.decisions = hd.decisions;
      if (hd.placeholders && hd.placeholders.decisions) {
        var dp = hd.placeholders.decisions, cols = TABLES.decisions.cols;
        if (dp.choice) cols[1].ph = dp.choice;
        if (dp.why) cols[2].ph = dp.why;
      }
    }
    return c;
  }).catch(function () { return {}; });

  var HINTS = {
    stakeholders: 'Who is involved and how to reach them — shows on the Stakeholders tab of the generated docs. Look people up in your Microsoft Entra directory (when connected) or type anyone in manually, including people outside the org.',
    requirements: 'One row per requirement. Priority is MoSCoW. Describe what the user should EXPERIENCE, in plain English — concrete and observable, naming an actor and an outcome — not how to build it. Say “reordering feels smooth and works by touch”, not “350ms SortableJS drag with forceFallback”. The agent picks the libraries, timings, and patterns, and turns each line into a Given/When/Then.',
    decisions: 'Each row becomes an ADR. Lock only what you want to stop re-litigating.',
    milestones: '3–6 milestones in shipping order. “Done means” is the user-visible outcome.',
    risks: 'What could sink it, and any hard constraints (optional).',
    scalability: 'Capture the non-functional needs that shape architecture and ops — availability, latency/throughput targets, data volume & growth, concurrency, observability, security, compliance, and disaster recovery. These drive the agent’s scaling decisions and ADRs; strong entries here produce a much stronger architecture.',
  };

  var SCALAR_STEPS = [
    { title: 'Product', hint: 'Plain language, specific to YOUR product — this is the source of truth for scope. Describe the one you’re building, not a generic app: the sharper and more particular you are here, the better the plan. There are no templates — these questions are meant to pull out what makes your product itself.', fields: [
      ['product.name', 'App name', 'Acme', 'text'],
      ['product.domain', 'Production domain', 'acme.app', 'text'],
      ['product.oneliner', 'One-liner — what is it, in your own words?', 'A calm, ordered to-do list for ADHD households', 'text'],
      ['product.goal', 'Goal of this project — the master objective (WHY it exists + the outcome it must achieve)', 'The north star that every requirement serves and the agent keeps the plan focused on. e.g. “Move our sales team off the Manus prototype onto a self-hosted CRM we own — running on-prem with our real pipeline data — so we stop paying per-seat and can customize freely.”', 'area'],
      ['product.problem', 'The problem — who hurts today, how, and why their current options fail them', 'Be specific about the pain and why the obvious alternatives don’t solve it.', 'area'],
      ['product.users', 'Who exactly is it for — and what do they need that others don’t?', 'One line per user type: who they are and the unmet need.', 'area'],
      ['product.differentiator', 'What makes it unmistakably better than how they solve this today?', 'The one thing that, if you nail it, makes people switch — the heart of the product.', 'area'],
      ['product.experience', 'What should using it FEEL like? (the experience bar)', 'e.g. “calm and glanceable, never nagging” — the qualities that define “great” for this, not features.', 'area'],
      ['product.success', 'What does success look like in 6 months? (measurable if you can)', 'Daily active members, retention, time-to-value…', 'area'],
      ['product.notBuilding', 'Explicitly NOT building (the “won’t” list)', 'One per line — the agent defends this boundary against scope creep.', 'area'],
    ] },
    { title: 'Integrations', hint: 'The non-secret values docs-kit and the docs pages need. Blank is fine — the export marks it as a setup step. API keys are never collected here. You do NOT enter any Linear URLs or project IDs — on “Build plan” you just supply a Linear write key and pick the team, and the wizard creates a brand-new Linear project (named after this app) and wires its live status in automatically.', fields: [
      ['integrations.githubRepoUrl', 'GitHub repo URL', 'https://github.com/me/acme', 'text'],
      ['integrations.docsDir', 'Docs directory name', 'docs', 'text'],
    ], warn: '🔑 API keys stay out of this tool. The generated structure ships placeholders; pass keys to docs-kit on the CLI at deploy time.' },
  ];

  // Tables render in object order: stakeholders, requirements, decisions,
  // milestones, risks, then scalability (Non-Functional & Scale) — placed after
  // Risks and before Generate.
  // A "Reference" step (file uploads) sits right after the scalar steps.
  var STEP_DEFS = [].concat(
    SCALAR_STEPS.map(function (s) { return { kind: 'scalar', title: s.title, def: s }; }),
    [{ kind: 'reference', title: 'Reference' }],
    Object.keys(TABLES).map(function (t) { return { kind: 'table', title: TABLES[t].title || cap(t), key: t }; }),
    [{ kind: 'generate', title: 'Build plan' }]
  );

  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
  function get(o, path) { var p = path.split('.'); return (o[p[0]] || {})[p[1]] || ''; }
  function set(o, path, v) { var p = path.split('.'); (o[p[0]] = o[p[0]] || {})[p[1]] = v; }
  function emptyRow(t) { var r = {}; TABLES[t].cols.forEach(function (c) { r[c.k] = c.sel ? c.sel[0] : ''; }); return r; }
  function stepIndex(key) { for (var i = 0; i < STEP_DEFS.length; i++) { if (STEP_DEFS[i].key === key) return i; } return 0; }
  function rowEmpty(t, row) { return !TABLES[t].cols.some(function (c) { return !c.sel && String(row[c.k] || '').trim(); }); }
  function isGeneric(test) {
    var s = String(test || '').trim().toLowerCase();
    if (!s) return true;
    if (s.split(/\s+/).length < 4) return true;
    return ['works', 'it works', 'should work', 'works correctly', 'test', 'tbd', 'n/a', 'todo', 'pass'].indexOf(s) !== -1;
  }

  function render(mount, projectId) {
    fetch('/api/projects/' + projectId).then(function (r) {
      if (!r.ok) throw new Error('not found');
      return r.json();
    }).then(function (project) {
      run(mount, project);
    }).catch(function () { mount.innerHTML = '<p class="hint">Project not found. <a href="#/">Back</a></p>'; });
  }

  function run(mount, project) {
    var answers = project.answers || {};
    ['product', 'integrations'].forEach(function (k) { answers[k] = answers[k] || {}; });
    // Initialize every table (incl. scalability) without disturbing existing data —
    // older PLAN-INTAKE shapes that predate scalability simply get an empty row.
    Object.keys(TABLES).forEach(function (t) { if (!answers[t] || !answers[t].length) answers[t] = [emptyRow(t)]; });
    var cur = 0, saveTimer = null, saveEl;
    var deployed = !!project.deployUrl;   // already live → edits "Assess changes" against the pod

    function scheduleSave() {
      if (saveEl) saveEl.textContent = 'saving…';
      clearTimeout(saveTimer);
      saveTimer = setTimeout(doSave, 600);
    }
    function doSave() {
      fetch('/api/projects/' + project.id, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: answers.product.name || project.name, answers: answers }),
      }).then(function () { if (saveEl) saveEl.textContent = 'saved ✓'; })
        .catch(function () { if (saveEl) saveEl.textContent = 'save failed'; });
    }

    mount.innerHTML =
      '<div class="wiz-top"><div class="title" id="wiz-title"></div>' +
        (deployed ? '<div class="wiz-tools"><span class="wiz-live" title="' + esc(project.deployUrl) + '">● live</span>' +
          '<button class="btn primary sm" id="wiz-assess">✦ Assess changes</button>' +
          '<button class="btn sm" id="wiz-discard">Discard edits</button></div>' : '') +
        '<div class="save" id="wiz-save"></div></div>' +
      '<a href="#/" class="hint">← all projects</a>' +
      (project.draftFromCode ? '<div class="warn" style="margin:14px 0 0">✦ <b>Drafted from your uploaded app.</b> Review and correct each field — these are inferred from the code, not confirmed by you.</div>' : '') +
      '<div class="steps" id="wiz-steps"></div>' +
      '<div id="wiz-body"></div>' +
      '<div class="wiz-nav"><button class="btn ghost" id="wiz-back">← Back</button><button class="btn primary" id="wiz-next">Next →</button></div>';
    saveEl = mount.querySelector('#wiz-save');

    var titleEl = mount.querySelector('#wiz-title');
    var stepsEl = mount.querySelector('#wiz-steps');
    var bodyEl = mount.querySelector('#wiz-body');
    STEP_DEFS.forEach(function (s, i) {
      var b = document.createElement('button');
      b.textContent = (i + 1) + ' · ' + s.title;
      b.addEventListener('click', function () { go(i); });
      stepsEl.appendChild(b);
    });

    function go(i) {
      cur = Math.max(0, Math.min(STEP_DEFS.length - 1, i));
      Array.prototype.forEach.call(stepsEl.children, function (b, j) {
        b.classList.toggle('on', j === cur); b.classList.toggle('done', j < cur);
      });
      titleEl.textContent = project.name;
      mount.querySelector('#wiz-back').style.visibility = cur === 0 ? 'hidden' : 'visible';
      mount.querySelector('#wiz-next').style.visibility = cur === STEP_DEFS.length - 1 ? 'hidden' : 'visible';
      renderStep(STEP_DEFS[cur]);
      window.scrollTo(0, 0);
    }

    function renderStep(def) {
      if (def.kind === 'scalar') return renderScalar(def.def);
      if (def.kind === 'reference') return renderReference();
      if (def.kind === 'table') return renderTable(def.key);
      return renderGenerate();
    }

    function renderScalar(s) {
      var html = '<div class="step on"><h2>' + s.title + '</h2><p class="stephint">' + s.hint + '</p>';
      s.fields.forEach(function (f) {
        var k = f[0], lab = f[1], ph = f[2], type = f[3];
        html += '<label>' + lab + '</label>';
        html += type === 'area'
          ? '<textarea data-k="' + k + '" placeholder="' + esc(ph) + '">' + esc(get(answers, k)) + '</textarea>'
          : '<input type="text" data-k="' + k + '" value="' + esc(get(answers, k)) + '" placeholder="' + esc(ph) + '" />';
      });
      if (s.warn) html += '<div class="warn">' + s.warn + '</div>';
      html += '</div>';
      bodyEl.innerHTML = html;
      bodyEl.querySelectorAll('[data-k]').forEach(function (el) {
        el.addEventListener('input', function () { set(answers, el.getAttribute('data-k'), el.value); scheduleSave(); });
      });
    }

    function fmtBytes(n) {
      n = Number(n) || 0;
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
      return (n / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function renderReference() {
      var maxBytes = 64 * 1024 * 1024;
      bodyEl.innerHTML =
        '<div class="step on"><h2>Reference material</h2>' +
        '<p class="stephint">Optional. Attach existing material the agent should read <b>alongside</b> your requirements — a PDF spec, design notes, or a <b>zip of an existing codebase</b> to reuse as a pattern. These are reference, not scope: the agent mines them for context but still builds only what the requirements describe, and the “won’t build” list still wins. Documents (pdf, md, txt, docx, csv, json, images…) and code/archives (zip, tar, common source files) up to ' + fmtBytes(maxBytes) + ' each.</p>' +
        '<div class="dropzone" id="dz"><input type="file" id="fileinput" multiple hidden />' +
        '<div class="dz-inner"><div class="dz-icon">⬆</div><div>Drop files here, or <span class="dz-link">browse</span></div>' +
        '<div class="hint" id="dz-hint">PDFs, docs, or a codebase .zip</div></div></div>' +
        '<div id="att-status" class="hint" aria-live="polite"></div>' +
        '<div id="att-list"></div></div>';

      var dz = bodyEl.querySelector('#dz');
      var input = bodyEl.querySelector('#fileinput');
      var statusEl = bodyEl.querySelector('#att-status');
      var listEl = bodyEl.querySelector('#att-list');

      function drawList(atts) {
        if (!atts || !atts.length) { listEl.innerHTML = '<p class="hint" style="margin-top:14px">No reference files yet.</p>'; return; }
        listEl.innerHTML = '<table class="rows att-rows" style="margin-top:14px"><tbody>' + atts.map(function (a) {
          return '<tr><td class="att-ic">' + (a.kind === 'code' ? '❮❯' : '🖹') + '</td>' +
            '<td class="att-name">' + esc(a.name) + '</td>' +
            '<td class="att-kind">' + (a.kind === 'code' ? 'code / archive' : 'document') + '</td>' +
            '<td class="att-size">' + fmtBytes(a.size) + '</td>' +
            '<td><button class="del-row" data-del-att="' + esc(a.name) + '" title="remove">×</button></td></tr>';
        }).join('') + '</tbody></table>';
        listEl.querySelectorAll('[data-del-att]').forEach(function (b) {
          b.addEventListener('click', function () {
            var nm = b.getAttribute('data-del-att');
            fetch('/api/projects/' + project.id + '/attachments?name=' + encodeURIComponent(nm), { method: 'DELETE' })
              .then(function (r) { return r.json(); })
              .then(function (j) { drawList(j.attachments || []); });
          });
        });
      }

      function refresh() {
        fetch('/api/projects/' + project.id + '/attachments')
          .then(function (r) { return r.json(); })
          .then(function (j) { if (j.maxBytes) maxBytes = j.maxBytes; drawList(j.attachments || []); })
          .catch(function () { drawList([]); });
      }

      function uploadOne(file) {
        return new Promise(function (resolve) {
          if (file.size > maxBytes) { resolve({ name: file.name, error: 'too large (' + fmtBytes(file.size) + ')' }); return; }
          fetch('/api/projects/' + project.id + '/attachments?name=' + encodeURIComponent(file.name), {
            method: 'POST',
            headers: { 'content-type': file.type || 'application/octet-stream' },
            body: file,
          }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
            .then(function (res) { resolve(res.ok ? { name: file.name } : { name: file.name, error: (res.j && res.j.error) || 'failed' }); })
            .catch(function () { resolve({ name: file.name, error: 'upload failed' }); });
        });
      }

      function handleFiles(fileList) {
        var files = Array.prototype.slice.call(fileList || []);
        if (!files.length) return;
        statusEl.textContent = 'uploading ' + files.length + ' file' + (files.length === 1 ? '' : 's') + '…';
        var errors = [];
        (function next(i) {
          if (i >= files.length) {
            statusEl.textContent = errors.length
              ? 'done — couldn’t add: ' + errors.map(function (e) { return e.name + ' (' + e.error + ')'; }).join('; ')
              : 'added ' + files.length + ' file' + (files.length === 1 ? '' : 's') + ' ✓';
            refresh();
            return;
          }
          uploadOne(files[i]).then(function (res) { if (res.error) errors.push(res); next(i + 1); });
        })(0);
      }

      dz.addEventListener('click', function () { input.click(); });
      input.addEventListener('change', function () { handleFiles(input.files); input.value = ''; });
      ['dragenter', 'dragover'].forEach(function (ev) {
        dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('drag'); });
      });
      ['dragleave', 'drop'].forEach(function (ev) {
        dz.addEventListener(ev, function (e) { e.preventDefault(); if (ev === 'dragleave' && dz.contains(e.relatedTarget)) return; dz.classList.remove('drag'); });
      });
      dz.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files); });

      refresh();
    }

    function renderTable(t) {
      var spec = TABLES[t];
      var dateField = (t === 'milestones')
        ? '<label style="margin-top:0">Target start date</label>' +
          '<input type="date" id="ms-start" value="' + esc(answers.startDate || '') + '" style="max-width:220px" />' +
          '<div class="hint" style="margin-bottom:8px">Anchors milestone target dates — a “Week N” target becomes start + N weeks in Linear.</div>'
        : '';
      var lookup = (t === 'stakeholders') ? '<div id="entra-host"></div>' : '';
      var html = '<div class="step on"><h2>' + (spec.title || cap(t)) + '</h2><p class="stephint">' + HINTS[t] + '</p>' + dateField + lookup + '<div id="rowhost"></div></div>';
      bodyEl.innerHTML = html;
      if (t === 'milestones') {
        var ds = bodyEl.querySelector('#ms-start');
        ds.addEventListener('input', function () { answers.startDate = ds.value; scheduleSave(); });
      }
      drawRows(t, bodyEl.querySelector('#rowhost'), spec);
      if (t === 'stakeholders') entraLookup(bodyEl.querySelector('#entra-host'), bodyEl.querySelector('#rowhost'), spec);
    }

    // Entra directory lookup on the Stakeholders step — shown only when the
    // server reports entraLookup (AUTH_MODE=entra + Graph creds). Picking a
    // person appends a prefilled row (source:'entra'); people outside the org
    // are added manually via the table, which always works.
    function entraLookup(host, rowHost, spec) {
      if (!host) return;
      CONFIG_READY.then(function (c) {
        if (!c || !c.entraLookup || !host.isConnected) return;
        host.innerHTML = '<div class="entra-look"><label style="margin-top:0">Look up in Microsoft Entra</label>' +
          '<input type="text" id="ent-q" placeholder="Type a name or email, then pick a person to add them" autocomplete="off" />' +
          '<div id="ent-res"></div>' +
          '<div class="hint">Someone outside the org? Add a row below and type their details.</div></div>';
        var q = host.querySelector('#ent-q'), out = host.querySelector('#ent-res'), timer = null, seq = 0;
        q.addEventListener('input', function () {
          clearTimeout(timer);
          var term = q.value.trim();
          if (term.length < 2) { seq++; out.innerHTML = ''; return; }   // also invalidates any in-flight search
          timer = setTimeout(function () {
            var mine = ++seq;
            out.innerHTML = '<div class="hint">searching…</div>';
            fetch('/api/entra/people?q=' + encodeURIComponent(term))
              .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
              .then(function (res) {
                if (mine !== seq) return;
                var j = res.j || {};
                if (!res.ok || !j.ok) { out.innerHTML = '<div class="hint" style="color:var(--red)">✗ ' + esc(j.error || 'lookup unavailable') + '</div>'; return; }
                if (!(j.people || []).length) { out.innerHTML = '<div class="hint">no matches in the directory</div>'; return; }
                out.innerHTML = j.people.map(function (u, i) {
                  return '<button type="button" class="ent-hit" data-hit="' + i + '"><b>' + esc(u.name) + '</b>' +
                    (u.title ? ' <span class="ent-t">· ' + esc(u.title) + '</span>' : '') +
                    '<span class="ent-m">' + esc(u.email) + (u.phone ? ' · ' + esc(u.phone) : '') + '</span></button>';
                }).join('');
                out.querySelectorAll('[data-hit]').forEach(function (b) {
                  b.addEventListener('click', function () {
                    var u = j.people[+b.getAttribute('data-hit')];
                    var kept = answers.stakeholders.filter(function (row) { return !rowEmpty('stakeholders', row); });
                    kept.push({ name: u.name || '', email: u.email || '', phone: u.phone || '', role: '', source: 'entra', entraId: u.entraId || '' });
                    answers.stakeholders = kept;
                    q.value = ''; out.innerHTML = '';
                    scheduleSave(); drawRows('stakeholders', rowHost, spec);
                  });
                });
              }).catch(function () { if (mine === seq) out.innerHTML = '<div class="hint" style="color:var(--red)">✗ lookup failed</div>'; });
          }, 300);
        });
      });
    }

    // Seed strong starter rows. Drops empty placeholder rows, then appends the
    // examples (so it never clobbers data the user already typed).
    function loadExamples(t) {
      var kept = answers[t].filter(function (row) { return !rowEmpty(t, row); });
      EXAMPLES[t].forEach(function (ex) { kept.push(JSON.parse(JSON.stringify(ex))); });
      answers[t] = kept.length ? kept : [emptyRow(t)];
      scheduleSave();
    }

    function drawRows(t, host, spec) {
      var html = '<table class="rows"><thead><tr><th class="grip-h"></th>';
      spec.cols.forEach(function (c) { html += '<th style="width:' + c.w + '">' + c.th + '</th>'; });
      html += '<th></th></tr></thead><tbody>';
      answers[t].forEach(function (row, i) {
        html += '<tr data-row="' + i + '"><td class="grip" draggable="true" title="drag to reorder">⠿</td>';
        spec.cols.forEach(function (c) {
          html += '<td>';
          if (c.sel) {
            html += '<select data-i="' + i + '" data-c="' + c.k + '">';
            c.sel.forEach(function (o) { html += '<option' + (row[c.k] === o ? ' selected' : '') + '>' + o + '</option>'; });
            html += '</select>';
          } else if (c.ml) {
            html += '<textarea class="cell-ml" data-i="' + i + '" data-c="' + c.k + '" rows="3" placeholder="' + esc(c.ph) + '">' + esc(row[c.k]) + '</textarea>';
          } else {
            html += '<input type="text" data-i="' + i + '" data-c="' + c.k + '" value="' + esc(row[c.k]) + '" placeholder="' + esc(c.ph) + '" />';
          }
          html += '</td>';
        });
        html += '<td><button class="del-row" data-del="' + i + '" title="remove">×</button></td></tr>';
      });
      html += '</tbody></table>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
        '<button class="add" data-add="1">+ add ' + spec.label + '</button>' +
        '<button class="add" data-examples="1">✦ Load examples</button></div>';
      host.innerHTML = html;
      host.querySelectorAll('input,select,textarea').forEach(function (el) {
        el.addEventListener('input', function () { answers[t][+el.getAttribute('data-i')][el.getAttribute('data-c')] = el.value; scheduleSave(); });
      });
      host.querySelectorAll('[data-del]').forEach(function (b) {
        b.addEventListener('click', function () {
          answers[t].splice(+b.getAttribute('data-del'), 1);
          if (!answers[t].length) answers[t].push(emptyRow(t));
          scheduleSave(); drawRows(t, host, spec);
        });
      });
      host.querySelector('[data-add]').addEventListener('click', function () { answers[t].push(emptyRow(t)); scheduleSave(); drawRows(t, host, spec); });
      host.querySelector('[data-examples]').addEventListener('click', function () { loadExamples(t); drawRows(t, host, spec); });

      // Drag-to-reorder rows by the grip handle.
      var dragFrom = null;
      host.querySelectorAll('tr[data-row]').forEach(function (tr) {
        var grip = tr.querySelector('.grip');
        if (grip) grip.addEventListener('dragstart', function (e) {
          dragFrom = +tr.getAttribute('data-row');
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/plain', String(dragFrom)); } catch (x) {}
          tr.classList.add('dragging');
        });
        if (grip) grip.addEventListener('dragend', function () { tr.classList.remove('dragging'); host.querySelectorAll('tr.drop-to').forEach(function (r) { r.classList.remove('drop-to'); }); });
        tr.addEventListener('dragover', function (e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; tr.classList.add('drop-to'); });
        tr.addEventListener('dragleave', function () { tr.classList.remove('drop-to'); });
        tr.addEventListener('drop', function (e) {
          e.preventDefault();
          var to = +tr.getAttribute('data-row');
          if (dragFrom === null || dragFrom === to) return;
          var moved = answers[t].splice(dragFrom, 1)[0];
          answers[t].splice(to, 0, moved);
          dragFrom = null;
          scheduleSave(); drawRows(t, host, spec);
        });
      });
    }

    function renderGenerate() {
      var p = answers.product, v = answers.integrations;
      var reqs = answers.requirements.filter(function (r) { return (r.title || '').trim(); });
      var decs = answers.decisions.filter(function (r) { return (r.why || '').trim(); });
      var miles = answers.milestones.filter(function (r) { return (r.done || '').trim(); });
      var scal = answers.scalability.filter(function (r) { return (r.area || '').trim() || (r.target || '').trim(); });

      // Hard requirements — block generation until met (but easy to fix).
      var problems = [];
      if (reqs.length < 3) problems.push({ msg: 'at least 3 requirements (you have ' + reqs.length + ')', key: 'requirements' });
      if (decs.length < 2) problems.push({ msg: 'at least 2 decisions with a “why” (you have ' + decs.length + ')', key: 'decisions' });
      if (miles.length < 2) problems.push({ msg: 'at least 2 milestones with a “done means” (you have ' + miles.length + ')', key: 'milestones' });

      if (problems.length) {
        bodyEl.innerHTML = '<div class="step on"><h2>Generate the doc structure</h2>' +
          '<p class="stephint">A few essentials first — strong inputs here produce a far better architecture.</p>' +
          '<div class="warn" style="border-left-color:var(--red)"><b>Add a little more before generating:</b><ul style="margin:.4em 0 0">' +
          problems.map(function (pr) { return '<li>' + pr.msg + ' — <a href="#" data-fix="' + pr.key + '">fix</a></li>'; }).join('') +
          '</ul></div></div>';
        bodyEl.querySelectorAll('[data-fix]').forEach(function (a) {
          a.addEventListener('click', function (e) { e.preventDefault(); go(stepIndex(a.getAttribute('data-fix'))); });
        });
        return;
      }

      // Soft warning — thin/generic requirement tests (does not block).
      var weak = reqs.filter(function (r) { var tt = (r.test || '').trim(); return tt.length < 20 || isGeneric(tt); })
        .map(function (r) { return r.title; });
      var warnHtml = weak.length
        ? '<div class="warn"><b>Heads up:</b> these requirements have a thin or generic test — the agent will have to ask you for detail: ' + weak.map(esc).join('; ') + '.</div>'
        : '';

      var LS_KEY = 'pw_anthropic_key', LS_DEPLOY = 'pw_deploy', LS_SEC = 'pw_deploy_secrets';
      var savedKey = '', dep = {}, sec = {};
      try { savedKey = localStorage.getItem(LS_KEY) || ''; dep = JSON.parse(localStorage.getItem(LS_DEPLOY) || '{}'); sec = JSON.parse(localStorage.getItem(LS_SEC) || '{}'); } catch (e) {}
      var defName = (p.name || project.name || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

      bodyEl.innerHTML =
        '<div class="step on"><h2>Build plan</h2>' +
        '<p class="stephint">One step: AI builds your project’s docs (architecture &amp; Gantt diagrams, Given/When/Then acceptance criteria, ADRs), optionally creates a Linear project with issues, then deploys it to a Docker host and hands you the live URL.</p>' +
        '<ul class="hint" style="line-height:1.9">' +
        '<li><b>' + esc(p.name || project.name) + '</b>' + (p.domain ? ' · ' + esc(p.domain) : '') + ' — ' + reqs.length + ' requirements · ' + decs.length + ' decisions · ' + miles.length + ' milestones</li>' +
        '<li id="gen-refs">reference files: …</li>' +
        '</ul>' + warnHtml +
        '<div class="dform">' +
          '<label>Claude API key</label><input type="password" id="bp-ai" placeholder="sk-ant-… (drives the AI build)" value="' + esc(savedKey) + '" autocomplete="off" />' +
          '<label class="chk"><input type="checkbox" id="bp-remember"' + ((savedKey || sec.sshPass || sec.linearKey) ? ' checked' : '') + ' /> Remember keys + SSH/Linear creds on this device (same server each time)</label>' +

          '<div class="bp-sec">Deploy target (Docker host over SSH)</div>' +
          '<label>SSH host / IP</label><input type="text" id="bp-host" placeholder="10.10.0.208" value="' + esc(dep.host || '') + '" />' +
          '<div class="row2"><div><label>SSH user</label><input type="text" id="bp-user" value="' + esc(dep.user || 'docker') + '" /></div><div><label>SSH port</label><input type="text" id="bp-sshport" value="' + esc(dep.sshPort || '22') + '" /></div></div>' +
          '<label>SSH password</label><input type="password" id="bp-pass" placeholder="needed so the wizard can push over SSH" value="' + esc(sec.sshPass || '') + '" autocomplete="off" />' +
          '<div class="row2"><div><label>App name</label><input type="text" id="bp-name" value="' + esc(dep.name || defName) + '" /></div><div><label>Container port</label><input type="text" id="bp-port" value="' + esc(dep.port || '3000') + '" /></div></div>' +
          '<label>Hostname for Traefik <span style="text-transform:none;letter-spacing:0">(optional)</span></label><input type="text" id="bp-hostname" placeholder="' + esc(defName) + '.10.10.0.208.nip.io" value="' + esc(dep.hostname || '') + '" />' +
          '<div class="hint">Leave the host blank to just build the docs in the wizard (no deploy). Keys &amp; password are used per-request, never stored on the server.</div>' +

          '<div class="bp-sec">Linear tracker <span style="text-transform:none;letter-spacing:0">(optional)</span></div>' +
          '<div class="row2" style="align-items:flex-end"><div style="flex:2"><label>Linear API key</label><input type="password" id="bp-lin" placeholder="lin_api_… (write access)" value="' + esc(sec.linearKey || '') + '" autocomplete="off" /></div><div style="flex:1"><button class="btn sm" id="bp-teams">Load teams</button></div></div>' +
          '<label>Team</label><select id="bp-team" disabled><option value="">— enter a key, then Load teams —</option></select>' +
          '<div class="hint">Creates a <b>brand-new</b> Linear project with milestones + issues — never writes into an existing project.</div>' +

          '<div style="margin-top:16px"><button class="btn primary" id="bp-go">⚙ Build plan</button> <button class="btn" id="bp-stop" style="display:none;color:#E0A848;border-color:#E0A848">■ Stop build</button></div>' +
          '<div id="bp-prog"></div>' +
        '</div></div>';

      var cfg = {};
      fetch('/api/config').then(function (r) { return r.json(); }).then(function (c) { cfg = c || {}; }).catch(function () {});
      fetch('/api/projects/' + project.id + '/attachments').then(function (r) { return r.json(); }).then(function (j) {
        var el = bodyEl.querySelector('#gen-refs'); if (!el) return;
        var n = (j.attachments || []).length;
        el.innerHTML = n ? n + ' reference file' + (n === 1 ? '' : 's') + ' bundled into <code>reference/</code>' : 'no reference files <span class="hint">(optional)</span>';
      }).catch(function () {});

      var sel = bodyEl.querySelector('#bp-team'), prog = bodyEl.querySelector('#bp-prog');
      function val(id) { var e = bodyEl.querySelector(id); return e ? e.value.trim() : ''; }
      function step(msg, cls) { prog.innerHTML = '<div class="bp-step ' + (cls || '') + '">' + msg + '</div>'; }

      function loadTeams(preselect) {
        var k = val('#bp-lin'); if (!k) { step('Enter a Linear key first', 'err'); return; }
        step('Loading teams…');
        fetch('/api/linear/teams', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: k }) })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
          .then(function (res) {
            if (!res.ok) { step('✗ ' + (res.j.error || 'failed'), 'err'); return; }
            prog.innerHTML = ''; sel.disabled = false;
            sel.innerHTML = '<option value="">— pick a team —</option>' + res.j.teams.map(function (t) { return '<option value="' + esc(t.id) + '">' + esc(t.name) + ' (' + esc(t.key) + ')</option>'; }).join('');
            if (preselect) sel.value = preselect;
          }).catch(function (e) { step('✗ ' + e.message, 'err'); });
      }
      bodyEl.querySelector('#bp-teams').addEventListener('click', function () { loadTeams(); });
      // Same server each time → if a Linear key was remembered, auto-load teams + reselect.
      if (sec.linearKey) loadTeams(sec.teamId);

      bodyEl.querySelector('#bp-go').addEventListener('click', function () {
        var btn = this;
        var stopBtn = bodyEl.querySelector('#bp-stop');
        var key = val('#bp-ai'), host = val('#bp-host'), linKey = val('#bp-lin'), teamId = sel.value;
        var deploy = { host: host, user: val('#bp-user') || 'docker', sshPort: val('#bp-sshport') || '22', password: val('#bp-pass'), name: val('#bp-name') || defName, port: val('#bp-port') || '3000', hostname: val('#bp-hostname') };
        try {
          var remember = bodyEl.querySelector('#bp-remember').checked;
          if (remember && key) localStorage.setItem(LS_KEY, key); else localStorage.removeItem(LS_KEY);
          localStorage.setItem(LS_DEPLOY, JSON.stringify({ host: host, user: deploy.user, sshPort: deploy.sshPort, name: deploy.name, port: deploy.port, hostname: deploy.hostname }));
          // Same server every deploy — also keep the SSH password, Linear key + team so
          // they're pre-filled next time (only when "Remember on this device" is checked).
          if (remember) localStorage.setItem(LS_SEC, JSON.stringify({ sshPass: deploy.password, linearKey: linKey, teamId: teamId })); else localStorage.removeItem(LS_SEC);
        } catch (e) {}
        if (host && !deploy.password) { step('Enter the SSH password to deploy (or clear the host to just build).', 'err'); return; }
        btn.disabled = true; doSave();
        var P = function (url, body) { return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); }); };

        // Live agentic-build progress during the 2/3 step (phase, agent indicator, tokens).
        if (!document.getElementById('pw-pulse-kf')) { var _st = document.createElement('style'); _st.id = 'pw-pulse-kf'; _st.textContent = '@keyframes pw-pulse{0%,100%{opacity:1}50%{opacity:.25}}'; document.head.appendChild(_st); }
        var bpPoll = null;
        var fmtK = function (n) { return Math.round((n || 0) / 1000) + 'K'; };
        var renderBP = function (pg) {
          if (!pg) return;
          var rows = [];
          var dot = pg.agentRunning ? '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#97C459;margin-right:7px;animation:pw-pulse 1s infinite;vertical-align:1px"></span>' : '<span style="color:#6A6A66;margin-right:7px">•</span>';
          var live = pg.liveTokens ? ' <span style="color:#6A6A66">· ' + fmtK(pg.liveTokens.fresh) + ' fresh / ' + fmtK(pg.liveTokens.cached) + ' cached / ' + fmtK(pg.liveTokens.output) + ' out</span>' : '';
          rows.push('<div class="bp-step">' + dot + esc(pg.current || pg.phase || '') + live + '</div>');
          (pg.steps || []).forEach(function (s) {
            var tk = s.tokens ? '<span style="color:#6A6A66;font-family:ui-monospace,Menlo,monospace;font-size:11px;white-space:nowrap">' + fmtK(s.tokens.fresh) + ' / ' + fmtK(s.tokens.cached) + ' / ' + fmtK(s.tokens.output) + '</span>' : '';
            rows.push('<div style="display:flex;justify-content:space-between;gap:12px;color:#9A9A95;font-size:12.5px;padding:1px 0"><span>✓ ' + esc(s.label) + (s.note ? ' <span style="color:#6A6A66">(' + esc(s.note) + ')</span>' : '') + '</span>' + tk + '</div>');
          });
          var t = pg.totals || {};
          if (t.fresh || t.cached || t.output) rows.push('<div style="margin-top:6px;color:#6A6A66;font-size:11px">totals: ' + fmtK(t.fresh) + ' fresh · ' + fmtK(t.cached) + ' cached · ' + fmtK(t.output) + ' out</div>');
          prog.innerHTML = rows.join('');
        };
        var clearBP = function () { if (bpPoll) { clearInterval(bpPoll); bpPoll = null; } };

        step('1/3 · Generating the doc structure…');
        P('/api/projects/' + project.id + '/generate').then(function (g) {
          if (!g.ok) throw new Error(g.j.detail || g.j.error || 'generate failed');
          var wantAI = key || cfg.aiServerKey;
          if (!wantAI) { step('2/3 · No Claude key — skipping AI build (clean tables only)…'); return { ok: true, j: { skipped: true } }; }
          step('2/3 · Building docs with AI' + (linKey && teamId ? ' + creating Linear issues' : '') + '… (agent explores your code — several minutes)');
          stopBtn.style.display = ''; stopBtn.disabled = false; stopBtn.textContent = '■ Stop build';
          stopBtn.onclick = function () { stopBtn.disabled = true; stopBtn.textContent = '■ Stopping…'; fetch('/api/projects/' + project.id + '/build-cancel', { method: 'POST' }).catch(function () {}); };
          bpPoll = setInterval(function () {
            fetch('/api/projects/' + project.id + '/build-progress').then(function (r) { return r.json(); }).then(function (pg) { if (pg && !pg.done) renderBP(pg); }).catch(function () {});
          }, 1500);
          return P('/api/projects/' + project.id + '/build-full', { apiKey: key, linearKey: linKey, teamId: teamId });
        }).then(function (b) {
          clearBP(); stopBtn.style.display = 'none';
          if (b && b.j && b.j.cancelled) { btn.disabled = false; step('■ Build cancelled — nothing was written to Linear or the docs.'); return Promise.reject({ cancelled: true }); }
          if (b && !b.ok) throw new Error(b.j.error || 'AI build failed');
          window.__bp_linear = b && b.j && b.j.linear;
          if (!host) { return { ok: true, j: { noDeploy: true } }; }
          // If a Linear tracker was created, hand the key to the container so its
          // /docs plan page shows live status (the project id is baked into serve-docs.js).
          if (window.__bp_linear && linKey) deploy.linearKey = linKey;
          // Bake the Claude key so the deployed site's hamburger Edit flow can run
          // Assess + re-enrich on the pod without re-entering a key.
          if (key) deploy.apiKey = key;
          step('3/3 · Deploying to ' + esc(host) + '… (first build can take a minute)');
          return P('/api/projects/' + project.id + '/deploy', deploy);
        }).then(function (d) {
          btn.disabled = false;
          var lin = window.__bp_linear;
          var linHtml = lin ? '<div class="bp-step ok">Linear: ' + lin.counts.issues + ' issues, ' + lin.counts.milestones + ' milestones · <a href="' + esc(lin.url) + '" target="_blank">open ↗</a></div>' : '';
          if (d.j && d.j.noDeploy) {
            prog.innerHTML = '<div class="bp-step ok">✓ Docs built in the wizard. <a href="#/p/' + project.id + '/docs">Open the docs browser →</a> Add an SSH host above to deploy.</div>' + linHtml;
            return;
          }
          if (!d.ok || !d.j.ok) { prog.innerHTML = '<div class="bp-step err">✗ Deploy failed: ' + esc((d.j && d.j.error) || 'unknown') + '</div>' + linHtml + (d.j && d.j.output ? '<pre class="bp-out">' + esc(d.j.output.slice(-2000)) + '</pre>' : ''); return; }
          prog.innerHTML = '<div class="bp-step ok">✓ Live at <a href="' + esc(d.j.url) + '" target="_blank"><b>' + esc(d.j.url) + '</b></a></div>' + linHtml;
        }).catch(function (e) { clearBP(); stopBtn.style.display = 'none'; btn.disabled = false; if (e && e.cancelled) return; step('✗ ' + (e.message || e), 'err'); });
      });
    }

    // ── deployed-project editing: Assess changes against the LIVE pod ───────────
    // The pod owns its data; we proxy assess/apply to it (no rebuild) and review
    // the proposed doc/tracker/diagram changes before committing.
    function proposedFromAnswers() {
      var out = { product: answers.product || {}, integrations: answers.integrations || {}, startDate: answers.startDate || '' };
      Object.keys(TABLES).forEach(function (t) {
        out[t] = (answers[t] || []).filter(function (r) { return TABLES[t].cols.some(function (c) { return !c.sel && String(r[c.k] || '').trim(); }); });
      });
      return out;
    }
    function pod(action, body) {
      return fetch('/api/projects/' + project.id + '/pod/' + action, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }, function () { return { ok: r.ok, j: {} }; }); });
    }
    function E(html) { var d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; }
    // No backdrop-click dismiss — an accidental click must never throw away an
    // assess review; every caller provides its own close/cancel control.
    function bgModal(inner) { var b = document.createElement('div'); b.className = 'modal-bg'; b.innerHTML = '<div class="modal edit-modal">' + inner + '</div>'; document.body.appendChild(b); return b; }
    function swim(arch) {
      var wrap = E('<div class="al-wrap"><svg class="al-edges"></svg></div>');
      (arch.layers || []).forEach(function (L) {
        var pipe = /ci|cd|deploy|build|pipeline/i.test(L.label) ? ' pipe' : '';
        var nodes = (L.nodes || []).map(function (n) {
          var ln = (n.lines || []).length ? '<div class="ln">' + n.lines.map(esc).join('<br>') + '</div>' : '';
          var bu = (n.bullets || []).length ? '<div class="bu">' + n.bullets.map(function (b) { return '• ' + esc(b); }).join('<br>') + '</div>' : '';
          var su = (n.subs || []).length ? '<div class="al-subs">' + n.subs.map(function (s) { return '<div class="al-sub"><div class="sh">' + esc(s.head) + '</div><div class="sl">' + (s.lines || []).map(esc).join('<br>') + '</div></div>'; }).join('') + '</div>' : '';
          return '<div class="al-node ' + esc(n.cls || 'edge') + '" data-id="' + esc(String(n.id)) + '">' + (n.eyebrow ? '<div class="eye">' + esc(n.eyebrow) + '</div>' : '') + '<div class="ti">' + esc(n.title) + '</div>' + ln + bu + su + '</div>';
        }).join('');
        wrap.appendChild(E('<div class="al-layer"><div class="al-label">' + esc(L.label) + '</div><div class="al-row' + pipe + '">' + nodes + '</div></div>'));
      });
      return wrap;
    }
    function drawSwim(wrap, edges) {
      var svg = wrap.querySelector('.al-edges'); if (!svg) return;
      var W = wrap.scrollWidth, H = wrap.scrollHeight; svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.setAttribute('width', W); svg.setAttribute('height', H);
      var br = wrap.getBoundingClientRect(), byId = {}; wrap.querySelectorAll('.al-node[data-id]').forEach(function (n) { byId[n.getAttribute('data-id')] = n; });
      var P = '', Lb = '', defs = '<defs><marker id="wlar" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#6A6A6E"/></marker></defs>';
      (edges || []).forEach(function (e) {
        var a = byId[e.from], b = byId[e.to]; if (!a || !b) return;
        var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        var ax = ra.left + ra.width / 2 - br.left, ay, bx = rb.left + rb.width / 2 - br.left, by;
        if (rb.top >= ra.bottom - 2) { ay = ra.bottom - br.top; by = rb.top - br.top; }
        else if (rb.bottom <= ra.top + 2) { ay = ra.top - br.top; by = rb.bottom - br.top; }
        else { ay = ra.top + ra.height / 2 - br.top; by = rb.top + rb.height / 2 - br.top; if (bx > ax) { ax = ra.right - br.left; bx = rb.left - br.left; } else { ax = ra.left - br.left; bx = rb.right - br.left; } }
        var k = e.kind, col = (k === 'deploy' || k === 'critical') ? '#5d7a3a' : k === 'webhook' ? '#9a7a30' : '#4a4a52', ds = (k === 'webhook' || k === 'backup') ? ' stroke-dasharray="5 4"' : '', my = (ay + by) / 2;
        P += '<path d="M ' + ax + ' ' + ay + ' C ' + ax + ' ' + my + ' ' + bx + ' ' + my + ' ' + bx + ' ' + by + '" fill="none" stroke="' + col + '" stroke-width="1.5"' + ds + ' marker-end="url(#wlar)"/>';
        if (e.label) { var lw = String(e.label).length * 6.6 + 8, lx = (ax + bx) / 2; Lb += '<rect x="' + (lx - lw / 2) + '" y="' + (my - 9) + '" width="' + lw + '" height="16" rx="4" fill="#141417"/><text x="' + lx + '" y="' + (my + 3) + '" fill="#9A9A95" font-size="11" text-anchor="middle">' + esc(e.label) + '</text>'; }
      });
      svg.innerHTML = defs + P + Lb;
    }
    function unitCard(u) {
      var inner = '';
      if (u.group === 'doc') {
        (u.scalars || []).forEach(function (s) { inner += '<div class="chg-row"><b>' + esc(s.field) + '</b>: <span class="was">' + esc(s.before || '∅') + '</span> → <span class="now">' + esc(s.after || '∅') + '</span></div>'; });
        (u.added || []).forEach(function (r) { inner += '<div class="chg-row add">+ ' + esc(JSON.stringify(r).slice(0, 150)) + '</div>'; });
        (u.removed || []).forEach(function (r) { inner += '<div class="chg-row del">− ' + esc(JSON.stringify(r).slice(0, 150)) + '</div>'; });
        (u.modified || []).forEach(function (m) { inner += '<div class="chg-row">~ ' + esc(JSON.stringify(m.after || m).slice(0, 150)) + '</div>'; });
        inner = '<div class="chg-kind doc">DOC · ' + esc(u.section) + '</div>' + (u.impact ? '<div class="chg-impact">' + esc(u.impact) + '</div>' : '') + inner;
      } else if (u.group === 'linear') {
        inner = '<div class="chg-kind lin">LINEAR · ' + esc(u.action) + (u.issueIdentifier ? ' ' + esc(u.issueIdentifier) : '') + '</div><div class="chg-title">' + esc(u.title || '') + '</div>' + (u.reason ? '<div class="chg-reason">' + esc(u.reason) + '</div>' : '');
      } else if (u.group === 'affected-closed') {
        inner = '<div class="chg-kind closed">CLOSED · ' + esc(u.issueIdentifier) + '</div><div class="chg-reason">' + esc(u.reason || '') + '</div>';
      } else if (u.group === 'code') {
        inner = '<div class="chg-kind code">CODE · ' + esc(u.area || '') + '</div><div class="chg-impact">' + esc(u.detail || '') + '</div>';
      }
      var c = E('<div class="chg-card"><label class="chg-acc"><input type="checkbox" class="chg-cb" checked> accept</label><div class="chg-main">' + inner + '</div></div>');
      c.querySelector('.chg-cb').setAttribute('data-uid', u.id);
      return c;
    }
    function assessReview(result, proposed) {
      var units = result.units || [];
      var b = bgModal('<h3>✦ Assess changes</h3><p class="chg-summary">' + esc(result.summary || '') + '</p>' +
        '<div class="edit-body" id="wz-rev"></div>' +
        '<div class="edit-foot"><div style="display:flex;gap:8px;align-items:center"><button class="btn sm primary" id="wz-apply">Apply accepted</button><button class="btn sm" id="wz-cancel">Back to editing</button><span class="hint" id="wz-st"></span></div></div>');
      var body = b.querySelector('#wz-rev'), st = b.querySelector('#wz-st');
      var draft = result.architectureDraft, draftOk = draft && draft.architecture && (draft.architecture.layers || []).length;
      if (draftOk) {
        body.appendChild(E('<h4 class="chg-grp">Architecture diagram (updated)</h4>'));
        var dc = E('<div class="chg-card"><label class="chg-acc"><input type="checkbox" id="wz-diag-cb" checked> accept the updated diagram</label> <button class="btn xs" id="wz-fs" type="button">⛶ Full screen</button></div>');
        var sw = swim(draft.architecture); dc.appendChild(sw); body.appendChild(dc);
        dc.querySelector('#wz-fs').addEventListener('click', function () { var fb = document.createElement('div'); fb.className = 'modal-bg'; var w = swim(draft.architecture); w.style.maxWidth = '95vw'; var box = E('<div class="modal" style="max-width:96vw;width:96vw"><h3 style="display:flex;align-items:center;justify-content:space-between;gap:12px">Architecture — updated <button class="btn sm" id="wz-fs-close" type="button">Close</button></h3></div>'); box.appendChild(w); fb.appendChild(box); document.body.appendChild(fb); box.querySelector('#wz-fs-close').addEventListener('click', function () { fb.remove(); }); setTimeout(function () { drawSwim(w, draft.architecture.edges); }, 60); });
        setTimeout(function () { drawSwim(sw, draft.architecture.edges); }, 90);
      }
      var groups = { doc: 'Documentation', linear: 'Linear issues', 'affected-closed': 'Affected completed issues', code: 'Code impact' };
      Object.keys(groups).forEach(function (g) { var arr = units.filter(function (u) { return u.group === g; }); if (!arr.length) return; body.appendChild(E('<h4 class="chg-grp">' + groups[g] + ' (' + arr.length + ')</h4>')); arr.forEach(function (u) { body.appendChild(unitCard(u)); }); });
      if (!units.length && !draftOk) body.appendChild(E('<p class="hint">No actionable changes detected.</p>'));
      b.querySelector('#wz-cancel').addEventListener('click', function () { b.remove(); });
      b.querySelector('#wz-apply').addEventListener('click', function () {
        var accepted = Array.prototype.slice.call(b.querySelectorAll('.chg-cb:checked')).map(function (cb) { return cb.getAttribute('data-uid'); });
        var dcb = b.querySelector('#wz-diag-cb');
        var btn = this; btn.disabled = true; st.textContent = 'Applying to the live pod…';
        pod('apply', { proposed: proposed, units: units, accepted: accepted, summary: result.summary, architecture: (dcb && dcb.checked && draft) ? draft : null }).then(function (res) {
          btn.disabled = false; var j = res.j || {};
          if (!res.ok) { st.style.color = 'var(--red)'; st.textContent = '✗ ' + (j.error || 'apply failed'); return; }
          var a = j.applied || {}, lin = (a.linear || []).concat(a.affectedClosed || []);
          var links = lin.map(function (x) { var id = x.identifier || x; return x.url ? '<a href="' + esc(x.url) + '" target="_blank">' + esc(id) + '</a>' : esc(id); }).join(', ');
          b.querySelector('.edit-body').innerHTML = '<p>✓ <b>' + esc(j.changeId) + '</b> applied to the live pod · ' + (a.docSections || []).length + ' section(s)' + (links ? '<br>Linear: ' + links : '') + '</p><p class="hint">The docs update live — no redeploy.</p>';
          st.textContent = '';
          b.querySelector('#wz-apply').textContent = 'Done'; b.querySelector('#wz-apply').onclick = function () { b.remove(); };
          b.querySelector('#wz-cancel').textContent = 'Open live docs ↗'; b.querySelector('#wz-cancel').onclick = function () { window.open(project.deployUrl, '_blank'); };
        }).catch(function (e) { btn.disabled = false; st.style.color = 'var(--red)'; st.textContent = '✗ ' + e.message; });
      });
    }
    function doAssess() {
      doSave();
      var b = bgModal('<h3>✦ Assess changes</h3><p class="hint" id="wz-as">Assessing against the live pod — code, tracker, and diagram… (can take a minute)</p>');
      pod('assess', { proposed: proposedFromAnswers() }).then(function (res) {
        b.remove(); var j = res.j || {};
        if (!res.ok) { bgModal('<h3>Assess</h3><p class="warn">✗ ' + esc(j.error || 'assess failed') + (j.detail ? '<br>' + esc(j.detail) : '') + '</p><div class="row"><button class="btn" onclick="this.closest(\'.modal-bg\').remove()">Close</button></div>'); return; }
        if (j.empty) { bgModal('<h3>Assess</h3><p class="hint">' + esc(j.message || 'No changes to assess.') + '</p><div class="row"><button class="btn" onclick="this.closest(\'.modal-bg\').remove()">Close</button></div>'); return; }
        assessReview(j, proposedFromAnswers());
      }).catch(function (e) { b.remove(); bgModal('<h3>Assess</h3><p class="warn">✗ ' + esc(e.message) + '</p><div class="row"><button class="btn" onclick="this.closest(\'.modal-bg\').remove()">Close</button></div>'); });
    }
    function doDiscard() {
      if (!confirm('Discard your edits and reload the live plan from the pod?')) return;
      pod('intake').then(function (res) {
        if (res.ok && res.j && res.j.intake) {
          var k = res.j.intake; answers.product = k.product || {}; answers.integrations = k.integrations || answers.integrations || {}; answers.startDate = k.startDate || '';
          // Reset each table from the pod — but a table the pod's intake
          // predates entirely (no key, e.g. stakeholders on an old pod) keeps
          // its local rows instead of being silently wiped.
          Object.keys(TABLES).forEach(function (t) {
            if (k[t] && k[t].length) answers[t] = k[t];
            else if (t in k || !answers[t] || !answers[t].length) answers[t] = [emptyRow(t)];
          });
          doSave(); go(cur);
        }
      });
    }
    if (deployed) {
      var ab = mount.querySelector('#wiz-assess'), db = mount.querySelector('#wiz-discard');
      if (ab) ab.addEventListener('click', doAssess);
      if (db) db.addEventListener('click', doDiscard);
    }

    mount.querySelector('#wiz-back').addEventListener('click', function () { go(cur - 1); });
    mount.querySelector('#wiz-next').addEventListener('click', function () { go(cur + 1); });
    go(0);
  }

  window.Wizard = { render: render };
})();
