// Wizard component — renders the PLAN intake for one project, autosaving answers
// to the server, and on finish triggers docs-kit generation. Exposed as window.Wizard.
(function () {
  'use strict';

  var TABLES = {
    requirements: { label: 'requirement', cols: [
      { k: 'title', th: 'Requirement', ph: 'Users can sign up and pay', w: '30%' },
      { k: 'priority', th: 'Priority', sel: ['Must', 'Should', 'May', 'Won’t'], w: '12%' },
      { k: 'test', th: 'How you’d test it (plain English)', ph: 'A new visitor finishes checkout in under 3 minutes', w: '58%' }] },
    decisions: { label: 'decision', cols: [
      { k: 'concern', th: 'Concern', ph: 'Database', w: '22%' },
      { k: 'choice', th: 'Decision', ph: 'Managed Postgres (Neon)', w: '30%' },
      { k: 'why', th: 'Why (the trade-off you accept)', ph: 'Zero ops; vendor lock-in acceptable', w: '48%' }] },
    milestones: { label: 'milestone', cols: [
      { k: 'name', th: 'Milestone', ph: 'M1 · Foundation', w: '26%' },
      { k: 'done', th: 'Done means…', ph: 'App deployed, reachable over HTTPS', w: '52%' },
      { k: 'target', th: 'Target', ph: 'Week 2', w: '22%' }] },
    risks: { label: 'risk', cols: [
      { k: 'risk', th: 'Risk / constraint', ph: 'Sales-tax exposure', w: '50%' },
      { k: 'mitigation', th: 'Mitigation / hard limit', ph: 'Launch US + Canada only', w: '50%' }] },
    scalability: { label: 'scalability item', title: 'Non-Functional & Scale', cols: [
      { k: 'area', th: 'Area', ph: 'Availability', w: '24%' },
      { k: 'target', th: 'Target / requirement', ph: '99.9% uptime; p95 API < 200ms at 10k req/min', w: '50%' },
      { k: 'adr', th: 'ADR / decision', ph: 'Multi-AZ, autoscaling workers, read replicas', w: '26%' }] },
  };

  // Strong starter rows for the "Load examples" button on each table.
  var EXAMPLES = {
    requirements: [
      { title: 'Users can sign up and pay', priority: 'Must', test: 'A new visitor creates an account, enters card details, and reaches the paid dashboard in under 3 minutes' },
      { title: 'Owner can invite teammates', priority: 'Should', test: 'An owner sends an invite and the invitee accepts and sees the shared workspace within the same session' },
      { title: 'Users can export their data', priority: 'Should', test: 'A user exports all their records as CSV and the downloaded file contains every row with no truncation' },
    ],
    decisions: [
      { concern: 'Database', choice: 'Managed Postgres (Neon)', why: 'Zero ops and preview branching; vendor lock-in acceptable at this scale' },
      { concern: 'Auth', choice: 'Clerk (hosted)', why: 'Offload security-critical auth; faster than rolling our own, cost is acceptable' },
      { concern: 'Hosting', choice: 'Fly.io containers', why: 'Simple multi-region + scale-to-zero; revisit if egress cost spikes' },
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

  var HINTS = {
    requirements: 'One row per requirement. Priority is MoSCoW. Describe what the user should EXPERIENCE, in plain English — concrete and observable, naming an actor and an outcome — not how to build it. Say “reordering feels smooth and works by touch”, not “350ms SortableJS drag with forceFallback”. The agent picks the libraries, timings, and patterns, and turns each line into a Given/When/Then.',
    decisions: 'Each row becomes an ADR. Lock only what you want to stop re-litigating.',
    milestones: '3–6 milestones in shipping order. “Done means” is the user-visible outcome.',
    risks: 'What could sink it, and any hard constraints (optional).',
    scalability: 'Capture the non-functional needs that shape architecture and ops — availability, latency/throughput targets, data volume & growth, concurrency, observability, security, compliance, and disaster recovery. These drive the agent’s scaling decisions and ADRs; strong entries here produce a much stronger architecture.',
  };

  // Archetypes — pick one to pre-fill the tables with sensible defaults for that
  // kind of app, then edit only the deltas. Each seeds requirements/decisions/
  // milestones/risks/scalability (intent-level; the agent fills implementation).
  var ARCHETYPES = [
    { key: 'household', icon: '🏡', name: 'Household / family coordinator', blurb: 'Shared chores, members, a glanceable display — calm and low-ops.',
      product: { success: 'Every member uses it daily; the shared display becomes the default “what’s next”; no nagging or guilt.' },
      requirements: [
        { title: 'Member login', priority: 'Must', test: 'A household member picks their name and (if set) enters a PIN to get in; the shared display needs no login.' },
        { title: 'One shared list everyone sees', priority: 'Must', test: 'Everyone sees the same up-to-date list; one person’s change shows for everyone.' },
        { title: 'Assign and complete chores', priority: 'Must', test: 'A task can be assigned to a person or shared, and checking it off feels good and clears it with no shame.' },
        { title: 'Recurring chores', priority: 'Should', test: 'A chore set to repeat comes back on schedule after it’s done.' },
        { title: 'Glanceable shared display', priority: 'Should', test: 'A TV or tablet shows what’s next, large and readable from across the room, refreshing on its own.' } ],
      decisions: [
        { concern: 'Storage', choice: 'Simple file/JSON or a small managed DB', why: 'Household-scale data; keep ops near zero.' },
        { concern: 'Auth', choice: 'Lightweight per-member PIN + session', why: 'Low friction for non-technical family members.' },
        { concern: 'Hosting', choice: 'Single small container, self-hostable', why: 'Cheap, private, no per-seat cost.' } ],
      milestones: [
        { name: 'M1 · Core list', done: 'A member can add, see, and complete shared tasks.', target: 'Week 2' },
        { name: 'M2 · Shared display', done: 'Glanceable display is live.', target: 'Week 3' },
        { name: 'M3 · Recurring + reminders', done: 'Recurring chores and reminders work.', target: 'Week 4' } ],
      risks: [
        { risk: 'It starts to feel like nagging or shaming.', mitigation: 'No streaks, overdue-red, or guilt UI; completing just clears the task.' },
        { risk: 'Only the tech-savvy parent ever sets it up.', mitigation: 'Dead-simple onboarding; sensible defaults; no config required.' } ],
      scalability: [
        { area: 'Availability', target: 'Always-on at home; survives reboots.', adr: 'Auto-restart + auto-update.' },
        { area: 'Simplicity', target: 'One household; tens of items.', adr: 'No multi-tenant complexity in v1.' } ] },

    { key: 'saas', icon: '🏢', name: 'B2B SaaS (multi-tenant)', blurb: 'Sign-up, teams, tenant isolation, billing — the classic paid product.',
      requirements: [
        { title: 'Sign up & subscribe', priority: 'Must', test: 'A new customer creates an account, starts a trial, upgrades to a paid plan, and reaches the product.' },
        { title: 'Teams & roles', priority: 'Must', test: 'An owner invites teammates and assigns roles; each sees only their org’s data.' },
        { title: 'Tenant isolation', priority: 'Must', test: 'A user from one org can never see or act on another org’s data.' },
        { title: 'Billing & plan limits', priority: 'Should', test: 'Plan limits are enforced and a customer can manage billing self-serve.' },
        { title: 'Admin audit log', priority: 'Should', test: 'Admins can review a log of significant actions with who and when.' } ],
      decisions: [
        { concern: 'Hosting', choice: 'Containerized on a managed platform', why: 'Scale with near-zero ops.' },
        { concern: 'Database', choice: 'Managed Postgres', why: 'Relational integrity for multi-tenant; no DB ops.' },
        { concern: 'Auth', choice: 'Managed auth provider', why: 'Offload security-critical auth; SSO later.' },
        { concern: 'Payments', choice: 'Stripe (Checkout + Billing + Portal)', why: 'Trusted billing, tax, and self-serve.' } ],
      milestones: [
        { name: 'M1 · Foundation', done: 'Containerized app deployed, reachable over HTTPS.', target: 'Week 2' },
        { name: 'M2 · Multi-tenant + auth', done: 'Sign up, log in, org isolation.', target: 'Week 4' },
        { name: 'M3 · Billing', done: 'Trial → paid; plan limits enforced.', target: 'Week 6' },
        { name: 'M4 · Launch-ready', done: 'Marketing site, monitoring, hardening.', target: 'Week 8' } ],
      risks: [
        { risk: 'A tenant-isolation bug leaks data across orgs.', mitigation: 'Scope every query by tenant at the data layer; tests for cross-tenant access.' },
        { risk: 'Billing edge cases (failed payments, proration).', mitigation: 'Use the provider’s hosted billing; reconcile via webhooks.' } ],
      scalability: [
        { area: 'Availability', target: '99.9% uptime; graceful degradation.', adr: 'Multi-AZ, health checks, circuit breakers.' },
        { area: 'Performance', target: 'p95 < 300ms at target load; load-tested.', adr: 'Caching + read replicas; load tests in CI.' },
        { area: 'Observability', target: 'Logs, metrics, traces, alerting on SLOs.', adr: 'OpenTelemetry → managed backend.' },
        { area: 'Security', target: 'Authn/z, least privilege, dependency scanning.', adr: 'Managed auth, scoped tokens, CVE scans.' } ] },

    { key: 'internal', icon: '🛠️', name: 'Internal tool / admin dashboard', blurb: 'SSO, roles, CRUD, audit — a back-office system staff trust.',
      requirements: [
        { title: 'SSO login', priority: 'Must', test: 'Staff log in with the company SSO; no separate passwords.' },
        { title: 'Role-based access', priority: 'Must', test: 'Each role sees and can do only what it’s permitted.' },
        { title: 'CRUD on core records', priority: 'Must', test: 'Authorized staff can list, search, create, edit, and archive records.' },
        { title: 'Audit log', priority: 'Must', test: 'Every change records who did what and when.' },
        { title: 'Bulk actions & export', priority: 'Should', test: 'Staff can act on many records at once and export to CSV.' } ],
      decisions: [
        { concern: 'Auth', choice: 'Company SSO (OIDC/SAML)', why: 'No new credentials; central control.' },
        { concern: 'Database', choice: 'Managed Postgres', why: 'Relational and audit-friendly.' },
        { concern: 'Exposure', choice: 'Internal network / VPN-only', why: 'Not public; reduce attack surface.' } ],
      milestones: [
        { name: 'M1 · Read-only', done: 'SSO login + read-only views.', target: 'Week 2' },
        { name: 'M2 · CRUD + roles', done: 'Create/edit with role permissions.', target: 'Week 4' },
        { name: 'M3 · Audit + bulk', done: 'Audit log, bulk actions, export.', target: 'Week 6' } ],
      risks: [
        { risk: 'Over-broad permissions leak sensitive data.', mitigation: 'Least-privilege roles; audit log; periodic access review.' },
        { risk: 'It becomes a shadow system of record.', mitigation: 'Define the source of truth and clear sync/export boundaries.' } ],
      scalability: [
        { area: 'Security', target: 'Least privilege + full audit.', adr: 'RBAC + immutable audit log.' },
        { area: 'Availability', target: 'Business-hours reliability.', adr: 'Managed host + backups.' } ] },

    { key: 'consumer', icon: '📱', name: 'Consumer app / installable PWA', blurb: 'Fast onboarding, offline core, push — an app-like web product.',
      requirements: [
        { title: 'Fast onboarding', priority: 'Must', test: 'A first-time user is doing the core thing within a minute, with no forced signup wall.' },
        { title: 'Core loop works offline', priority: 'Should', test: 'The main action works without a connection and syncs when back online.' },
        { title: 'Installable to home screen', priority: 'Should', test: 'The app installs as a PWA and launches full-screen.' },
        { title: 'Opt-in push re-engagement', priority: 'Should', test: 'Users can opt into notifications and get timely, non-spammy nudges.' },
        { title: 'Fast, accessible UI', priority: 'Must', test: 'The UI is fast and touch-friendly, usable with a screen reader and with good contrast.' } ],
      decisions: [
        { concern: 'Frontend', choice: 'Installable, offline-capable PWA', why: 'App-like without an app store.' },
        { concern: 'Storage', choice: 'Local-first + sync to a small backend', why: 'Instant UX; works offline.' },
        { concern: 'Auth', choice: 'Passwordless / social login', why: 'Lowest friction for consumers.' } ],
      milestones: [
        { name: 'M1 · Core loop', done: 'Core loop on web, mobile-first.', target: 'Week 2' },
        { name: 'M2 · Offline + install', done: 'Works offline and installs to home screen.', target: 'Week 4' },
        { name: 'M3 · Accounts + push', done: 'Accounts and opt-in notifications.', target: 'Week 6' } ],
      risks: [
        { risk: 'Retention is low after first use.', mitigation: 'Nail the first-minute value; opt-in nudges, not spam.' },
        { risk: 'Offline sync conflicts.', mitigation: 'Last-write-wins or CRDTs for core data; clear conflict UX.' } ],
      scalability: [
        { area: 'Performance', target: 'Instant interactions; fast p95 on mid-range phones.', adr: 'Local-first + small payloads.' },
        { area: 'Availability', target: 'Works offline; degrades gracefully.', adr: 'Service worker + background sync.' } ] },
  ];

  var SCALAR_STEPS = [
    { title: 'Product', hint: 'Plain language. The agent uses this as the source of truth for scope — if it isn’t written here, it isn’t a requirement.', fields: [
      ['product.name', 'App name', 'Acme', 'text'],
      ['product.domain', 'Production domain', 'acme.app', 'text'],
      ['product.oneliner', 'One-liner — what is it?', 'A privacy-first time tracker for freelancers', 'text'],
      ['product.problem', 'The problem it solves (2–4 sentences)', 'Who hurts today, how, and why existing tools don’t fix it.', 'area'],
      ['product.users', 'Target users — who exactly?', 'One line per user type: who they are, what they need.', 'area'],
      ['product.success', 'What does success look like in 6 months?', 'Measurable if possible.', 'area'],
      ['product.notBuilding', 'Explicitly NOT building (the “won’t” list)', 'One per line.', 'area'],
    ] },
    { title: 'Integrations', hint: 'The non-secret values docs-kit and the docs pages need. Blank is fine — the export marks it as a setup step. API keys are never collected here.', fields: [
      ['integrations.githubRepoUrl', 'GitHub repo URL', 'https://github.com/me/acme', 'text'],
      ['integrations.linearWorkspaceUrl', 'Linear workspace URL', 'https://linear.app/acme', 'text'],
      ['integrations.linearProjectUrl', 'Linear project URL', 'https://linear.app/acme/project/launch-…', 'text'],
      ['integrations.linearProjectId', 'Linear project ID (UUID — powers live status)', '', 'text'],
      ['integrations.docsDir', 'Docs directory name', 'docs', 'text'],
    ], warn: '🔑 API keys stay out of this tool. The generated structure ships placeholders; pass keys to docs-kit on the CLI at deploy time.' },
  ];

  // Tables render in object order: requirements, decisions, milestones, risks,
  // then scalability (Non-Functional & Scale) — placed after Risks and before Generate.
  var STEP_DEFS = [].concat(
    [{ kind: 'archetype', title: 'Start' }],
    SCALAR_STEPS.map(function (s) { return { kind: 'scalar', title: s.title, def: s }; }),
    Object.keys(TABLES).map(function (t) { return { kind: 'table', title: TABLES[t].title || cap(t), key: t }; }),
    [{ kind: 'generate', title: 'Generate' }]
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
      '<div class="wiz-top"><div class="title" id="wiz-title"></div><div class="save" id="wiz-save"></div></div>' +
      '<a href="#/" class="hint">← all projects</a>' +
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
      if (def.kind === 'archetype') return renderArchetype();
      if (def.kind === 'scalar') return renderScalar(def.def);
      if (def.kind === 'table') return renderTable(def.key);
      return renderGenerate();
    }

    function renderArchetype() {
      var sel = answers._archetype || '';
      var tiles = ARCHETYPES.map(function (a) {
        return '<div class="arch-tile' + (sel === a.key ? ' on' : '') + '" data-arch="' + a.key + '">' +
          '<div class="arch-ico">' + a.icon + '</div><div class="arch-name">' + a.name + '</div>' +
          '<div class="arch-blurb">' + a.blurb + '</div></div>';
      }).join('');
      bodyEl.innerHTML = '<div class="step on"><h2>Start from a template</h2>' +
        '<p class="stephint">Pick the closest kind of app and the wizard pre-fills requirements, decisions, milestones, risks, and non-functional defaults — then you just edit the deltas. Or start blank. You can change or clear any of it later.</p>' +
        '<div class="arch-grid">' + tiles +
        '<div class="arch-tile' + (sel === '' ? ' on' : '') + '" data-arch=""><div class="arch-ico">✦</div><div class="arch-name">Blank</div><div class="arch-blurb">Start from scratch and fill everything in yourself.</div></div>' +
        '</div></div>';
      bodyEl.querySelectorAll('[data-arch]').forEach(function (el) {
        el.addEventListener('click', function () { applyArchetype(el.getAttribute('data-arch')); go(cur + 1); });
      });
    }

    function applyArchetype(key) {
      var a = key ? null : { key: '' };
      ARCHETYPES.forEach(function (x) { if (x.key === key) a = x; });
      var tableKeys = ['requirements', 'decisions', 'milestones', 'risks', 'scalability'];
      var hasData = tableKeys.some(function (t) { return (answers[t] || []).some(function (r) { return !rowEmpty(t, r); }); });
      if (hasData && answers._archetype !== key &&
          !window.confirm('Replace your current entries with this starting point?')) return;
      answers._archetype = key;
      if (a && a.requirements) {
        tableKeys.forEach(function (t) {
          if (a[t]) answers[t] = a[t].map(function (r) { return Object.assign(emptyRow(t), r); });
        });
        if (a.product) Object.keys(a.product).forEach(function (k) { if (!answers.product[k]) answers.product[k] = a.product[k]; });
      } else if (!key) {
        // Blank — leave whatever's there (don't wipe edits).
      }
      scheduleSave();
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

    function renderTable(t) {
      var spec = TABLES[t];
      var html = '<div class="step on"><h2>' + (spec.title || cap(t)) + '</h2><p class="stephint">' + HINTS[t] + '</p><div id="rowhost"></div></div>';
      bodyEl.innerHTML = html;
      drawRows(t, bodyEl.querySelector('#rowhost'), spec);
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
      var html = '<table class="rows"><thead><tr>';
      spec.cols.forEach(function (c) { html += '<th style="width:' + c.w + '">' + c.th + '</th>'; });
      html += '<th></th></tr></thead><tbody>';
      answers[t].forEach(function (row, i) {
        html += '<tr>';
        spec.cols.forEach(function (c) {
          html += '<td>';
          if (c.sel) {
            html += '<select data-i="' + i + '" data-c="' + c.k + '">';
            c.sel.forEach(function (o) { html += '<option' + (row[c.k] === o ? ' selected' : '') + '>' + o + '</option>'; });
            html += '</select>';
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
      host.querySelectorAll('input,select').forEach(function (el) {
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

      bodyEl.innerHTML =
        '<div class="step on"><h2>Generate the doc structure</h2>' +
        '<p class="stephint">This runs docs-kit with your answers and materializes the full /docs file tree for the project — pages, governance library, the markdown corpus, the GitHub gate, plus your PLAN-INTAKE.json and AI handoff prompt. You can regenerate any time.</p>' +
        '<ul class="hint" style="line-height:1.9">' +
        '<li><b>' + esc(p.name || project.name) + '</b>' + (p.domain ? ' · ' + esc(p.domain) : '') + '</li>' +
        '<li>docs dir: <code>' + esc(v.docsDir || 'docs') + '</code>' + (v.githubRepoUrl ? ' · repo: ' + esc(v.githubRepoUrl) : '') + '</li>' +
        '<li>' + reqs.length + ' requirements · ' + decs.length + ' decisions · ' + miles.length + ' milestones</li>' +
        '<li>' + scal.length + ' non-functional / scale item' + (scal.length === 1 ? '' : 's') + ' — strong entries here sharpen the architecture the agent produces' +
        (scal.length === 0 ? ' <span style="color:var(--amber)">(none yet — the agent will still apply a baseline)</span>' : '') + '</li>' +
        '</ul>' +
        '<div class="warn" style="border-left-color:var(--accent)">You only owe <b>intent</b>. The agent fills in implementation (libraries, timings, patterns) and the usual things requirements forget — empty / first-run states, auth edge cases, accessibility, undo, backups, the timezone boundary, concurrency, notifications, and a pause mode — so you don’t have to list them.</div>' +
        warnHtml +
        '<div style="margin-top:18px;display:flex;gap:10px;align-items:center">' +
        '<button class="btn primary" id="gen-btn">⚙ Generate doc structure</button>' +
        '<span id="gen-status" class="hint"></span></div></div>';
      bodyEl.querySelector('#gen-btn').addEventListener('click', function () {
        var btn = this; btn.disabled = true;
        var status = bodyEl.querySelector('#gen-status'); status.textContent = 'generating…';
        doSave();
        fetch('/api/projects/' + project.id + '/generate', { method: 'POST' })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
          .then(function (res) {
            if (!res.ok) throw new Error(res.j.detail || res.j.error || 'failed');
            location.hash = '#/p/' + project.id + '/docs';
          })
          .catch(function (e) { status.textContent = 'failed: ' + e.message; btn.disabled = false; });
      });
    }

    mount.querySelector('#wiz-back').addEventListener('click', function () { go(cur - 1); });
    mount.querySelector('#wiz-next').addEventListener('click', function () { go(cur + 1); });
    go(0);
  }

  window.Wizard = { render: render };
})();
