// Wizard component — renders the PLAN intake for one project, autosaving answers
// to the server, and on finish triggers docs-kit generation. Exposed as window.Wizard.
(function () {
  'use strict';

  var TABLES = {
    requirements: { label: 'requirement', cols: [
      { k: 'title', th: 'Requirement', ph: 'Users can sign up and pay', w: '30%' },
      { k: 'priority', th: 'Priority', sel: ['Must', 'Should', 'May', 'Won’t'], w: '12%' },
      { k: 'test', th: 'How you’d test it (plain English)', ph: 'New visitor finishes checkout in under 3 minutes', w: '58%' }] },
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
  };

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

  var STEP_DEFS = [].concat(
    SCALAR_STEPS.map(function (s) { return { kind: 'scalar', title: s.title, def: s }; }),
    Object.keys(TABLES).map(function (t) { return { kind: 'table', title: cap(t), key: t }; }),
    [{ kind: 'generate', title: 'Generate' }]
  );

  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
  function get(o, path) { var p = path.split('.'); return (o[p[0]] || {})[p[1]] || ''; }
  function set(o, path, v) { var p = path.split('.'); (o[p[0]] = o[p[0]] || {})[p[1]] = v; }

  function emptyRow(t) { var r = {}; TABLES[t].cols.forEach(function (c) { r[c.k] = c.sel ? c.sel[0] : ''; }); return r; }

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
      if (def.kind === 'scalar') return renderScalar(def.def);
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

    function renderTable(t) {
      var spec = TABLES[t];
      var hint = { requirements: 'One row per requirement. Priority is MoSCoW; the test is plain English — the agent turns it into Given/When/Then.',
        decisions: 'Each row becomes an ADR. Lock only what you want to stop re-litigating.',
        milestones: '3–6 milestones in shipping order. “Done means” is the user-visible outcome.',
        risks: 'What could sink it, and any hard constraints (optional).' }[t];
      var html = '<div class="step on"><h2>' + cap(t) + '</h2><p class="stephint">' + hint + '</p><div id="rowhost"></div></div>';
      bodyEl.innerHTML = html;
      drawRows(t, bodyEl.querySelector('#rowhost'), spec);
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
      html += '</tbody></table><button class="add" data-add="1">+ add ' + spec.label + '</button>';
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
    }

    function renderGenerate() {
      var p = answers.product, v = answers.integrations;
      var nReq = answers.requirements.filter(function (r) { return (r.title || '').trim(); }).length;
      var nDec = answers.decisions.filter(function (r) { return (r.choice || '').trim(); }).length;
      var nMile = answers.milestones.filter(function (r) { return (r.name || '').trim(); }).length;
      bodyEl.innerHTML =
        '<div class="step on"><h2>Generate the doc structure</h2>' +
        '<p class="stephint">This runs docs-kit with your answers and materializes the full /docs file tree for the project — pages, governance library, the markdown corpus, the GitHub gate, plus your PLAN-INTAKE.json and AI handoff prompt. You can regenerate any time.</p>' +
        '<ul class="hint" style="line-height:1.9">' +
        '<li><b>' + esc(p.name || project.name) + '</b>' + (p.domain ? ' · ' + esc(p.domain) : '') + '</li>' +
        '<li>docs dir: <code>' + esc(v.docsDir || 'docs') + '</code>' + (v.githubRepoUrl ? ' · repo: ' + esc(v.githubRepoUrl) : '') + '</li>' +
        '<li>' + nReq + ' requirements · ' + nDec + ' decisions · ' + nMile + ' milestones</li>' +
        '</ul>' +
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
