// Router + home (project tiles) + generated-docs browser.
(function () {
  'use strict';
  var app = document.getElementById('app');

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
  function fmtDate(iso) { if (!iso) return ''; var d = new Date(iso); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
  function api(url, opts) { return fetch(url, opts).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); }); }
  // Minimal Lucide-style line icons (inherit color/size from .btn svg rules).
  var ICONS = {
    box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
    nodes: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>',
    upload: '<path d="M4 14.9A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.24"/><path d="M12 12v9"/><path d="m16 16-4-4-4 4"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
    sparkles: '<path d="M12 3l1.9 4.8L18.7 9.7 13.9 11.6 12 16.4 10.1 11.6 5.3 9.7 10.1 7.8z"/><path d="M19 14l.8 2 .2.8 2 .8-2 .8-.2.8-.8 2-.8-2-.2-.8-2-.8 2-.8.2-.8z"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
    edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>'
  };
  function ic(name) { return '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICONS[name] + '</svg>'; }

  function toast(msg, isErr) { var t = document.createElement('div'); t.className = 'toast' + (isErr ? ' err' : ''); t.textContent = msg; document.body.appendChild(t); setTimeout(function () { t.remove(); }, 2600); }

  // ─── router ────────────────────────────────────────────────────────────────
  function route() {
    var h = location.hash.replace(/^#/, '') || '/';
    var m;
    if (h === '/' || h === '') return home();
    if ((m = h.match(/^\/p\/([a-f0-9]{16})\/edit$/))) return window.Wizard.render(app, m[1]);
    if ((m = h.match(/^\/p\/([a-f0-9]{16})\/import$/))) return importScreen(m[1]);
    if ((m = h.match(/^\/p\/([a-f0-9]{16})\/docs$/))) return docs(m[1]);
    location.hash = '#/';
  }
  window.addEventListener('hashchange', route);

  // Management links (Portainer + Traefik) — from /api/config when the wizard
  // knows its HOST_IP, else derived from the nip.io hostname we're served on.
  function hostLinks() {
    return fetch('/api/config').then(function (r) { return r.json(); }).catch(function () { return {}; })
      .then(function (cfg) {
        cfg = cfg || {};
        var portainer = cfg.portainerUrl, proxy = cfg.proxyUrl;
        if (!portainer || !proxy) {
          var m = String(location.hostname).match(/(\d+\.\d+\.\d+\.\d+)\.nip\.io$/) ||
                  String(location.hostname).match(/^(\d+\.\d+\.\d+\.\d+)$/);
          if (m) {
            var ip = m[1];
            if (!portainer) portainer = 'http://portainer.' + ip + '.nip.io/';
            if (!proxy) proxy = 'http://' + ip + ':8080/dashboard/';
          }
        }
        return { portainer: portainer, proxy: proxy };
      });
  }
  function mgmtBarHtml(links) {
    return (links.portainer ? '<a class="btn sm ghost" target="_blank" href="' + esc(links.portainer) + '" title="Portainer — container management">' + ic('box') + 'Containers</a>' : '') +
           (links.proxy ? '<a class="btn sm ghost" target="_blank" href="' + esc(links.proxy) + '" title="Traefik — reverse-proxy dashboard">' + ic('nodes') + 'Proxy</a>' : '') +
           // Always available: hand another Claude session API access to a project.
           '<button class="btn sm ghost" id="connect-agent" title="Give a Claude session API access to a project">' + ic('sparkles') + 'Connect Agent</button>';
  }
  function fillMgmt() {
    var slot = app.querySelector('#mgmt-links');
    if (!slot) return;
    hostLinks().then(function (links) {
      slot.innerHTML = mgmtBarHtml(links);
      var cb = slot.querySelector('#connect-agent');
      if (cb) cb.addEventListener('click', function () { connectorSheet(); });
    });
  }

  // ─── home ────────────────────────────────────────────────────────────────
  function home() {
    app.innerHTML = '<div class="loading">loading…</div>';
    fetch('/api/projects').then(function (r) { return r.json(); }).then(function (projects) {
      if (!projects.length) {
        app.innerHTML =
          '<div class="home-head"><span></span><div id="mgmt-links" style="display:flex;gap:8px"></div></div>' +
          '<div class="empty"><h2>No projects yet</h2>' +
          '<p>Start one and the wizard walks you through the decisions only a human can make — then generates the project’s full /docs structure.</p>' +
          '<button class="btn primary" id="new-empty">+ New project</button>' +
          '<a class="hint" href="/demo-sequence.html">See a worked example → Sequence</a></div>';
        app.querySelector('#new-empty').addEventListener('click', newProject);
        fillMgmt();
        return;
      }
      var tiles = projects.map(tileHtml).join('');
      app.innerHTML =
        '<div class="home-head"><h1>Projects<span class="count">' + projects.length + '</span></h1>' +
        '<div style="display:flex;gap:12px;align-items:center"><div id="mgmt-links" style="display:flex;gap:8px"></div>' +
        '<a class="hint" href="/demo-sequence.html">Worked example</a>' +
        '<button class="btn primary" id="new-top">+ New project</button></div></div>' +
        '<div class="tiles">' + tiles +
        '<div class="tile new" id="new-tile"><div class="plus">+</div><div>New project</div></div></div>';
      fillMgmt();
      app.querySelector('#new-top').addEventListener('click', newProject);
      app.querySelector('#new-tile').addEventListener('click', newProject);
      app.querySelectorAll('.tile[data-id]').forEach(function (el) {
        el.addEventListener('click', function (e) {
          if (e.target.closest('.del')) return;
          var id = el.getAttribute('data-id'), status = el.getAttribute('data-status'), deploy = el.getAttribute('data-deploy');
          // The ⚙ on a deployed tile opens the internal manage/re-deploy view.
          if (e.target.closest('.manage')) { location.hash = '#/p/' + id + '/docs'; return; }
          // A deployed project's card deep-links to its LIVE /docs — edit & code
          // tools now live under the hamburger menu on that deployed page.
          if (deploy) { window.open(deploy, '_blank', 'noopener'); return; }
          location.hash = status === 'generated' ? '#/p/' + id + '/docs' : '#/p/' + id + '/edit';
        });
        var del = el.querySelector('.del');
        if (del) del.addEventListener('click', function () {
          if (!confirm('Delete “' + el.getAttribute('data-name') + '” and its generated docs?')) return;
          fetch('/api/projects/' + el.getAttribute('data-id'), { method: 'DELETE' }).then(home);
        });
      });
    });
  }

  function tileHtml(p) {
    var live = p.deployUrl ? esc(p.deployUrl) : '';
    return '<div class="tile" data-id="' + p.id + '" data-status="' + p.status + '" data-name="' + esc(p.name) + '" data-deploy="' + live + '">' +
      '<button class="del" title="delete">×</button>' +
      (live ? '<button class="manage" title="manage / re-deploy">⚙</button>' : '') +
      '<div class="name">' + esc(p.name) + '</div>' +
      '<div class="one">' + (esc(p.oneliner) || '<span style="color:var(--dim)">no description yet</span>') + '</div>' +
      '<div class="meta">' +
      (live
        ? '<span class="pill live" title="' + live + '">live</span><span>open docs ↗</span>'
        : '<span class="pill ' + p.status + '">' + (p.status === 'generated' ? 'generated' : 'draft') + '</span>' +
          (p.status === 'generated' ? '<span>' + p.fileCount + ' files · ' + esc(p.docsDir) + '/</span>' : '<span>updated ' + fmtDate(p.updatedAt) + '</span>')) +
      '</div></div>';
  }

  function newProject() {
    var bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = '<div class="modal"><h3>New project</h3>' +
      '<label>Project name</label><input type="text" id="np-name" placeholder="Acme" />' +
      '<p class="hint" style="margin:14px 0 8px">How do you want to start?</p>' +
      '<div class="start-choice">' +
        '<button class="choice" id="np-scratch"><span class="ic">' + ic('sparkles') + '</span>' +
          '<span class="ct"><b>Start from scratch</b><span>Answer the wizard — product, requirements, decisions…</span></span></button>' +
        '<button class="choice" id="np-existing"><span class="ic">' + ic('upload') + '</span>' +
          '<span class="ct"><b>Use an existing app</b><span>Upload its code and reverse-engineer a draft to review</span></span></button>' +
      '</div>' +
      '<div class="row"><button class="btn ghost" id="np-cancel">Cancel</button></div></div>';
    document.body.appendChild(bg);
    var input = bg.querySelector('#np-name'); input.focus();
    function close() { bg.remove(); }
    bg.querySelector('#np-cancel').addEventListener('click', close);
    bg.addEventListener('click', function (e) { if (e.target === bg) close(); });
    function create(dest) {
      var name = input.value.trim();
      api('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name }) })
        .then(function (res) { close(); location.hash = '#/p/' + res.j.id + '/' + dest; });
    }
    bg.querySelector('#np-scratch').addEventListener('click', function () { create('edit'); });
    bg.querySelector('#np-existing').addEventListener('click', function () { create('import'); });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') create('edit'); });
  }

  // ─── import: reverse-engineer requirements from an existing app ──────────────
  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function importScreen(id) {
    app.innerHTML = '<div class="loading">loading…</div>';
    Promise.all([
      fetch('/api/projects/' + id).then(function (r) { return r.json(); }),
      fetch('/api/config').then(function (r) { return r.json(); }).catch(function () { return {}; }),
    ]).then(function (out) {
      var p = out[0], cfg = out[1] || {};
      var KEY_LS = 'pw_anthropic_key';
      var savedKey = '';
      try { savedKey = localStorage.getItem(KEY_LS) || ''; } catch (e) {}

      app.innerHTML =
        '<a href="#/" class="hint">← all projects</a>' +
        '<div class="wiz-top"><div class="title">' + esc(p.name) + '</div></div>' +
        '<div class="step on"><h2>Use an existing app to start</h2>' +
        '<p class="stephint">Upload your app’s <b>code</b> — individual files, a whole folder, or a <code>.zip</code> — and the wizard reverse-engineers a draft plan (requirements, decisions, milestones, risks) for you to <b>review and correct</b> instead of writing from scratch.</p>' +

        '<div class="dropzone" id="dz">' +
          '<input type="file" id="fi-files" multiple hidden />' +
          '<input type="file" id="fi-dir" webkitdirectory directory multiple hidden />' +
          '<div class="dz-inner"><div class="dz-icon">⬆</div>' +
          '<div>Drop files here, or <span class="dz-link" id="pick-files">choose files</span> · <span class="dz-link" id="pick-dir">choose a folder</span></div>' +
          '<div class="hint">Source files, a project folder, or a <code>.zip</code> — node_modules / .git are skipped automatically</div></div>' +
        '</div>' +
        '<div id="up-status" class="hint" aria-live="polite"></div>' +
        '<div id="up-summary"></div>' +

        '<label style="margin-top:20px">Claude API key' + (cfg.aiServerKey ? ' <span style="text-transform:none;letter-spacing:0">(optional — a server key is configured)</span>' : '') + '</label>' +
        '<input type="password" id="ai-key" placeholder="' + (cfg.aiServerKey ? 'leave blank to use the server key' : 'sk-ant-…') + '" value="' + esc(savedKey) + '" autocomplete="off" />' +
        '<label class="chk"><input type="checkbox" id="ai-remember"' + (savedKey ? ' checked' : '') + ' /> Remember on this device</label>' +
        '<div class="hint">Used only to generate the draft, sent per-request — <b>never written to disk on the server</b>. Model: <code>' + esc(cfg.aiModel || 'claude-opus-4-8') + '</code>. No key? You’ll get a reverse-engineering prompt to run yourself.</div>' +

        '<div style="margin-top:18px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
          '<button class="btn primary" id="gen-btn">' + ic('sparkles') + 'Generate draft requirements</button>' +
          '<a class="hint" id="to-import">Import a PLAN-INTAKE.json</a> ·' +
          '<a class="hint" href="#/p/' + id + '/edit">skip — start blank</a>' +
          '<span id="gen-status" class="hint"></span>' +
        '</div>' +
        '<input type="file" id="fi-intake" accept=".json,application/json" hidden />' +
        '<div id="handoff"></div>' +
        '</div>';

      var dz = app.querySelector('#dz');
      var fiFiles = app.querySelector('#fi-files');
      var fiDir = app.querySelector('#fi-dir');
      var statusEl = app.querySelector('#up-status');
      var summaryEl = app.querySelector('#up-summary');

      function drawSummary(atts) {
        if (!atts || !atts.length) { summaryEl.innerHTML = ''; return; }
        var total = atts.reduce(function (n, a) { return n + a.size; }, 0);
        var preview = atts.slice(0, 8).map(function (a) { return '<li>' + esc(a.name) + ' <span class="dim">' + fmtBytes(a.size) + '</span></li>'; }).join('');
        summaryEl.innerHTML = '<div class="up-card"><div class="up-head"><b>' + atts.length + ' file' + (atts.length === 1 ? '' : 's') + '</b> · ' + fmtBytes(total) +
          ' <button class="link-danger" id="clear-up">clear</button></div><ul class="up-list">' + preview +
          (atts.length > 8 ? '<li class="dim">…and ' + (atts.length - 8) + ' more</li>' : '') + '</ul></div>';
        var c = summaryEl.querySelector('#clear-up');
        if (c) c.addEventListener('click', function () {
          fetch('/api/projects/' + id + '/attachments', { method: 'DELETE' }).then(function (r) { return r.json(); })
            .then(function (j) { drawSummary(j.attachments || []); statusEl.textContent = ''; });
        });
      }
      function refresh() {
        fetch('/api/projects/' + id + '/attachments').then(function (r) { return r.json(); })
          .then(function (j) { drawSummary(j.attachments || []); }).catch(function () {});
      }
      function uploadOne(file) {
        var rel = (file.webkitRelativePath && file.webkitRelativePath.length) ? file.webkitRelativePath : file.name;
        return fetch('/api/projects/' + id + '/attachments?path=' + encodeURIComponent(rel), {
          method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file,
        }).then(function (r) { return r.ok ? null : r.json().then(function (j) { return { name: rel, error: (j && j.error) || 'failed' }; }); })
          .catch(function () { return { name: rel, error: 'upload failed' }; });
      }
      function handleFiles(list) {
        var files = Array.prototype.slice.call(list || []);
        if (!files.length) return;
        statusEl.textContent = 'uploading ' + files.length + ' file' + (files.length === 1 ? '' : 's') + '…';
        var errors = [], i = 0;
        (function next() {
          if (i >= files.length) {
            statusEl.textContent = errors.length ? ('uploaded with ' + errors.length + ' skipped') : ('uploaded ' + files.length + ' file' + (files.length === 1 ? '' : 's') + ' ✓');
            refresh(); return;
          }
          uploadOne(files[i++]).then(function (e) { if (e) errors.push(e); next(); });
        })();
      }
      app.querySelector('#pick-files').addEventListener('click', function (e) { e.stopPropagation(); fiFiles.click(); });
      app.querySelector('#pick-dir').addEventListener('click', function (e) { e.stopPropagation(); fiDir.click(); });
      dz.addEventListener('click', function () { fiFiles.click(); });
      fiFiles.addEventListener('change', function () { handleFiles(fiFiles.files); fiFiles.value = ''; });
      fiDir.addEventListener('change', function () { handleFiles(fiDir.files); fiDir.value = ''; });
      ['dragenter', 'dragover'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('drag'); }); });
      ['dragleave', 'drop'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); if (ev === 'dragleave' && dz.contains(e.relatedTarget)) return; dz.classList.remove('drag'); }); });
      dz.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files); });

      // Generate draft
      var genStatus = app.querySelector('#gen-status');
      var handoffEl = app.querySelector('#handoff');
      app.querySelector('#gen-btn').addEventListener('click', function () {
        var btn = this; var key = app.querySelector('#ai-key').value.trim();
        try {
          if (app.querySelector('#ai-remember').checked && key) localStorage.setItem(KEY_LS, key);
          else localStorage.removeItem(KEY_LS);
        } catch (e) {}
        btn.disabled = true; handoffEl.innerHTML = '';
        genStatus.textContent = key || cfg.aiServerKey ? 'analyzing your code with Claude… (can take a minute)' : 'building reverse-engineering prompt…';
        api('/api/projects/' + id + '/generate-draft', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: key }) })
          .then(function (res) {
            btn.disabled = false;
            var j = res.j || {};
            if (!res.ok) { genStatus.textContent = '✗ ' + (j.error || 'failed'); return; }
            if (j.mode === 'auto') {
              genStatus.textContent = '';
              toast('Drafted ' + j.counts.requirements + ' requirements from your code — review them');
              location.hash = '#/p/' + id + '/edit';
              return;
            }
            // handoff mode (no key)
            genStatus.textContent = '';
            showHandoff(j.prompt);
          })
          .catch(function (e) { btn.disabled = false; genStatus.textContent = '✗ ' + e.message; });
      });

      function showHandoff(prompt) {
        handoffEl.innerHTML = '<div class="warn" style="margin-top:18px">' +
          '<b>No API key — run this yourself.</b> Save the prompt below into the folder with your app’s code, run it with a coding agent (e.g. Claude Code), and it writes a <code>PLAN-INTAKE.json</code>. Then click <b>Import a PLAN-INTAKE.json</b> to load it here for review.' +
          '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">' +
          '<button class="btn sm" id="ho-copy">' + ic('file') + 'Copy prompt</button>' +
          '<button class="btn sm" id="ho-dl">' + ic('download') + 'Download .md</button></div>' +
          '<textarea class="ho-text" readonly>' + esc(prompt) + '</textarea></div>';
        handoffEl.querySelector('#ho-copy').addEventListener('click', function () {
          navigator.clipboard && navigator.clipboard.writeText(prompt); toast('Prompt copied');
        });
        handoffEl.querySelector('#ho-dl').addEventListener('click', function () {
          var b = new Blob([prompt], { type: 'text/markdown' });
          var a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'reverse-engineer-prompt.md'; a.click();
        });
      }

      // Import a PLAN-INTAKE.json
      var fiIntake = app.querySelector('#fi-intake');
      app.querySelector('#to-import').addEventListener('click', function () { fiIntake.click(); });
      fiIntake.addEventListener('change', function () {
        var f = fiIntake.files && fiIntake.files[0]; if (!f) return;
        var reader = new FileReader();
        reader.onload = function () {
          var parsed; try { parsed = JSON.parse(reader.result); } catch (e) { genStatus.textContent = '✗ not valid JSON'; return; }
          api('/api/projects/' + id + '/import-intake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ intake: parsed }) })
            .then(function (res) {
              if (!res.ok) { genStatus.textContent = '✗ ' + (res.j.error || 'import failed'); return; }
              toast('Imported — review it in the wizard'); location.hash = '#/p/' + id + '/edit';
            });
        };
        reader.readAsText(f);
        fiIntake.value = '';
      });

      refresh();
    }).catch(function () { app.innerHTML = '<p class="hint">Project not found. <a href="#/">Back</a></p>'; });
  }

  // ─── generated-docs browser ────────────────────────────────────────────────
  function docs(id) {
    app.innerHTML = '<div class="loading">loading…</div>';
    Promise.all([
      fetch('/api/projects/' + id).then(function (r) { return r.json(); }),
      fetch('/api/projects/' + id + '/files').then(function (r) { return r.json(); }),
    ]).then(function (out) {
      var p = out[0], files = (out[1].files || []);
      app.innerHTML =
        '<a href="#/" class="hint">← all projects</a>' +
        '<div class="docs-head"><div><h1>' + esc(p.name) + '</h1>' +
        '<div class="sub">' + files.filter(function (f) { return f.type === 'file'; }).length + ' files · generated ' + fmtDate(p.generatedAt) + '</div></div>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
        '<button class="btn sm primary" id="build-btn">' + ic('sparkles') + 'Build full docs + Linear</button>' +
        '<button class="btn sm" id="edit-btn">' + ic('edit') + 'Edit &amp; assess</button>' +
        '<button class="btn sm" id="export-btn">' + ic('download') + 'Export / Deploy…</button>' +
        '<button class="btn sm" id="share-btn">' + ic('nodes') + 'Share with agent</button>' +
        '<button class="btn sm" id="regen">' + ic('refresh') + 'Re-run wizard</button></div></div>' +
        (p.enrichedAt ? '<div class="ok-note">✦ AI-built ' + fmtDate(p.enrichedAt) + (p.linearUrl ? ' · <a href="' + esc(p.linearUrl) + '" target="_blank">Linear project ↗</a>' : '') + '</div>' : '') +
        '<div class="browser"><div class="filetree" id="tree"></div>' +
        '<div class="viewer" id="viewer"><div class="placeholder">Select a file to view it.</div></div></div>';
      app.querySelector('#regen').addEventListener('click', function () { location.hash = '#/p/' + id + '/edit'; });
      app.querySelector('#export-btn').addEventListener('click', function () { exportSheet(id); });
      app.querySelector('#build-btn').addEventListener('click', function () { buildSheet(id); });
      app.querySelector('#edit-btn').addEventListener('click', function () { editSheet(id, p); });
      app.querySelector('#share-btn').addEventListener('click', function () { shareSheet(id); });

      var tree = app.querySelector('#tree');
      tree.innerHTML = files.map(function (f) {
        var depth = f.path.split('/').length - 1;
        var name = f.path.split('/').pop();
        var pad = 'style="padding-left:' + (8 + depth * 14) + 'px"';
        if (f.type === 'dir') return '<div class="row dir" ' + pad + '><span class="ic">▸</span>' + esc(name) + '</div>';
        return '<div class="row" data-path="' + esc(f.path) + '" ' + pad + '><span class="ic">·</span>' + esc(name) + '</div>';
      }).join('');
      var viewer = app.querySelector('#viewer');
      tree.querySelectorAll('.row[data-path]').forEach(function (row) {
        row.addEventListener('click', function () {
          tree.querySelectorAll('.row').forEach(function (r) { r.classList.remove('on'); });
          row.classList.add('on');
          var rel = row.getAttribute('data-path');
          viewer.innerHTML = '<div class="placeholder">loading…</div>';
          fetch('/api/projects/' + id + '/file?path=' + encodeURIComponent(rel)).then(function (r) { return r.json(); }).then(function (d) {
            if (d.tooLarge) { viewer.innerHTML = '<div class="placeholder">' + esc(rel) + ' is too large to preview (' + d.size + ' bytes).</div>'; return; }
            viewer.innerHTML = '<div class="vh"><span>' + esc(rel) + '</span><span>' + (d.size || 0) + ' bytes</span></div><pre></pre>';
            viewer.querySelector('pre').textContent = d.content || '';
          });
        });
      });
      // auto-open a sensible first file
      var first = tree.querySelector('.row[data-path]');
      if (first) first.click();
    });
  }

  // ─── export sheet ──────────────────────────────────────────────────────────
  // ─── Stage 3: AI build + Linear ──────────────────────────────────────────
  function buildSheet(id) {
    var KEY_LS = 'pw_anthropic_key';
    var savedKey = '';
    try { savedKey = localStorage.getItem(KEY_LS) || ''; } catch (e) {}
    var bg = document.createElement('div'); bg.className = 'modal-bg';
    bg.innerHTML = '<div class="modal exp-modal"><h3>Build full docs + Linear</h3>' +
      '<p class="hint">AI rewrites the docs <b>in the wizard’s copy</b> — a Mermaid architecture diagram, a Gantt, and Given/When/Then acceptance criteria — and, optionally, creates a brand-new Linear project with milestones + issues. <b>This does not deploy</b>; afterward use <b>Export / Deploy</b> to push the updated docs to your Docker host. Requires a Claude API key.</p>' +
      '<div class="dform">' +
        '<label>Claude API key</label><input type="password" id="b-ai" placeholder="sk-ant-… (or leave blank if a server key is set)" value="' + esc(savedKey) + '" autocomplete="off" />' +
        '<label class="chk"><input type="checkbox" id="b-remember"' + (savedKey ? ' checked' : '') + ' /> Remember on this device</label>' +
        '<hr style="border:none;border-top:1px solid var(--line);margin:14px 0" />' +
        '<label>Linear API key <span style="text-transform:none;letter-spacing:0">(optional — to create the tracker)</span></label>' +
        '<div class="row2" style="align-items:flex-end"><div style="flex:2"><input type="password" id="b-lin" placeholder="lin_api_… (write access)" autocomplete="off" /></div>' +
        '<div style="flex:1"><button class="btn sm" id="b-teams">Load teams</button></div></div>' +
        '<label>Team</label><select id="b-team" disabled><option value="">— enter a key, then Load teams —</option></select>' +
        '<div class="hint">Keys are used per-request and never stored on the server. The tracker is always a <b>new</b> project — it never writes into an existing one.</div>' +
        '<div style="display:flex;gap:8px;margin-top:14px;align-items:center"><button class="btn sm primary" id="b-go">' + ic('sparkles') + 'Build</button>' +
        '<button class="btn sm" id="b-stop" style="display:none;color:#E0A848;border-color:#E0A848">■ Stop</button>' +
        '<span class="hint" id="b-status"></span></div>' +
        '<style>@keyframes pw-pulse{0%,100%{opacity:1}50%{opacity:.25}}</style>' +
        '<div id="b-prog" style="display:none;margin-top:12px;border-top:1px solid var(--line);padding-top:10px;font-size:12.5px;max-height:340px;overflow:auto"></div>' +
      '</div>' +
      '<div class="row"><button class="btn" id="b-close">Close</button></div></div>';
    document.body.appendChild(bg);
    bg.addEventListener('click', function (e) { if (e.target === bg) bg.remove(); });
    bg.querySelector('#b-close').addEventListener('click', function () { bg.remove(); });
    var status = bg.querySelector('#b-status'), sel = bg.querySelector('#b-team');

    bg.querySelector('#b-teams').addEventListener('click', function () {
      var k = bg.querySelector('#b-lin').value.trim();
      if (!k) { status.textContent = 'enter a Linear key first'; return; }
      status.textContent = 'loading teams…';
      api('/api/linear/teams', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: k }) })
        .then(function (res) {
          if (!res.ok) { status.textContent = '✗ ' + (res.j.error || 'failed'); return; }
          status.textContent = '';
          sel.disabled = false;
          sel.innerHTML = '<option value="">— pick a team —</option>' +
            res.j.teams.map(function (t) { return '<option value="' + esc(t.id) + '">' + esc(t.name) + ' (' + esc(t.key) + ')</option>'; }).join('');
        }).catch(function (e) { status.textContent = '✗ ' + e.message; });
    });

    bg.querySelector('#b-go').addEventListener('click', function () {
      var btn = this; var key = bg.querySelector('#b-ai').value.trim();
      var linKey = bg.querySelector('#b-lin').value.trim(), teamId = sel.value;
      try { if (bg.querySelector('#b-remember').checked && key) localStorage.setItem(KEY_LS, key); else localStorage.removeItem(KEY_LS); } catch (e) {}
      btn.disabled = true;
      status.style.color = '';
      status.textContent = 'starting… (this build explores your code with an agent — it can take several minutes)';
      // The build emits structured phase events; poll them and render the live phase,
      // an "agent running" indicator, per-phase token counts, and running totals.
      var progEl = bg.querySelector('#b-prog');
      var fmtK = function (n) { return Math.round((n || 0) / 1000) + 'K'; };
      var renderProgress = function (pg) {
        if (!pg) return;
        status.textContent = '';
        progEl.style.display = 'block';
        var rows = [];
        var dot = pg.agentRunning
          ? '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#97C459;margin-right:7px;animation:pw-pulse 1s infinite;vertical-align:1px"></span>'
          : '<span style="color:#6A6A66;margin-right:7px">•</span>';
        var live = pg.liveTokens ? ' <span style="color:#6A6A66">· ' + fmtK(pg.liveTokens.fresh) + ' fresh / ' + fmtK(pg.liveTokens.cached) + ' cached / ' + fmtK(pg.liveTokens.output) + ' out</span>' : '';
        rows.push('<div style="color:#E8E8E4;margin-bottom:8px">' + dot + esc(pg.current || pg.phase || '') + live + '</div>');
        (pg.steps || []).forEach(function (s) {
          var tk = s.tokens ? '<span style="color:#6A6A66;font-family:ui-monospace,Menlo,monospace;font-size:11px;white-space:nowrap">' + fmtK(s.tokens.fresh) + ' / ' + fmtK(s.tokens.cached) + ' / ' + fmtK(s.tokens.output) + '</span>' : '';
          rows.push('<div style="display:flex;justify-content:space-between;gap:12px;color:#9A9A95;padding:2px 0"><span>✓ ' + esc(s.label) + (s.note ? ' <span style="color:#6A6A66">(' + esc(s.note) + ')</span>' : '') + '</span>' + tk + '</div>');
        });
        var t = pg.totals || {};
        if (t.fresh || t.cached || t.output) rows.push('<div style="margin-top:8px;border-top:1px solid var(--line);padding-top:6px;color:#6A6A66;font-size:11px">totals: <b style="color:#9A9A95">' + fmtK(t.fresh) + '</b> fresh · <b style="color:#9A9A95">' + fmtK(t.cached) + '</b> cached · <b style="color:#9A9A95">' + fmtK(t.output) + '</b> out  <span style="color:#4a4a52">(fresh billed full, cached ~10%)</span></div>');
        progEl.innerHTML = rows.join('');
      };
      var stopBtn = bg.querySelector('#b-stop');
      stopBtn.style.display = ''; stopBtn.disabled = false; stopBtn.textContent = '■ Stop';
      stopBtn.onclick = function () { stopBtn.disabled = true; stopBtn.textContent = '■ Stopping…'; api('/api/projects/' + id + '/build-cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(function () {}); };
      var poll = setInterval(function () {
        fetch('/api/projects/' + id + '/build-progress').then(function (r) { return r.json(); }).then(function (pg) {
          if (pg && !pg.done) renderProgress(pg);
        }).catch(function () {});
      }, 1500);
      var stopPoll = function () { clearInterval(poll); stopBtn.style.display = 'none'; };
      api('/api/projects/' + id + '/build-full', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: key, linearKey: linKey, teamId: teamId }) })
        .then(function (res) {
          stopPoll(); btn.disabled = false;
          var j = res.j || {};
          if (j && j.cancelled) { status.style.color = ''; status.textContent = '■ Build cancelled — nothing was written.'; progEl.style.display = 'none'; return; }
          if (!res.ok) { status.style.color = 'var(--red)'; status.textContent = '✗ ' + (j.error || 'failed'); return; }
          var msg = 'Docs rebuilt in the wizard';
          if (j.linear) msg += ' · Linear: ' + j.linear.counts.issues + ' issues, ' + j.linear.counts.milestones + ' milestones';
          else if (j.linearError) msg += ' · ' + j.linearError;
          if (j.cohesion) msg += ' · cohesion +' + j.cohesion.added + '/−' + j.cohesion.removed;
          toast(msg + ' — now Export / Deploy to push it live');
          bg.remove(); docs(id);
        }).catch(function (e) { stopPoll(); btn.disabled = false; status.style.color = 'var(--red)'; status.textContent = '✗ ' + e.message; });
    });
  }

  // ─── living docs: Edit → Assess Changes → accept/revert → apply ────────────
  var EDIT_TABLES = {
    requirements: { title: 'Requirements', cols: [['title', 'Requirement'], ['priority', 'Priority'], ['test', 'How you’d test it']] },
    decisions:    { title: 'Decisions',    cols: [['concern', 'Concern'], ['choice', 'Decision'], ['why', 'Why']] },
    milestones:   { title: 'Milestones',   cols: [['name', 'Milestone'], ['done', 'Done means'], ['target', 'Target']] },
    risks:        { title: 'Risks',        cols: [['risk', 'Risk / constraint'], ['mitigation', 'Mitigation']] },
    scalability:  { title: 'Non-functional & scale', cols: [['area', 'Area'], ['target', 'Target'], ['adr', 'Decision']] },
  };
  var EDIT_PRODUCT = [['oneliner', 'One-liner'], ['goal', 'Goal of this project (master objective)'], ['problem', 'Problem'], ['users', 'Users'], ['differentiator', 'Differentiator'], ['experience', 'Experience'], ['success', 'Success'], ['notBuilding', 'Not building (one per line)']];

  function bufToIntake(buf) {
    return {
      product: buf.product || {}, startDate: buf.startDate || '',
      requirements: buf.requirements || [], decisions: buf.decisions || [],
      milestones: buf.milestones || [], risks: buf.risks || [], scalability: buf.scalability || [],
    };
  }

  function editSheet(id, p) {
    var buf = JSON.parse(JSON.stringify(p.answers || {}));
    buf.product = buf.product || {};
    Object.keys(EDIT_TABLES).forEach(function (s) { if (!Array.isArray(buf[s])) buf[s] = []; });
    var savedKey = ''; try { savedKey = localStorage.getItem('pw_anthropic_key') || ''; } catch (e) {}

    var bg = document.createElement('div'); bg.className = 'modal-bg';
    bg.innerHTML = '<div class="modal edit-modal"><h3>' + ic('edit') + 'Edit docs</h3>' +
      '<p class="hint">Edit any value; add or remove rows. <b>Nothing saves</b> until you Assess Changes and accept them. Assess analyzes your edits against the live Linear tracker and the uploaded codebase, then lets you accept or revert each change.</p>' +
      '<div class="edit-body" id="edit-body"></div>' +
      '<div class="edit-foot">' +
        '<div class="row2"><div><label>Claude API key</label><input type="password" id="e-ai" placeholder="sk-ant-… (drives the analysis)" value="' + esc(savedKey) + '" autocomplete="off" /></div>' +
        '<div><label>Linear API key <span style="text-transform:none;letter-spacing:0">(to sync the tracker)</span></label><input type="password" id="e-lin" placeholder="lin_api_… (write access)" autocomplete="off" /></div></div>' +
        '<div style="display:flex;gap:8px;margin-top:12px;align-items:center">' +
          '<button class="btn sm primary" id="e-assess">' + ic('sparkles') + 'Assess Changes</button>' +
          '<button class="btn sm" id="e-discard">Discard edits</button>' +
          '<span class="hint" id="e-status"></span></div>' +
      '</div></div>';
    document.body.appendChild(bg);
    var body = bg.querySelector('#edit-body'), status = bg.querySelector('#e-status');
    bg.querySelector('#e-discard').addEventListener('click', function () { bg.remove(); });

    function rowsHtml(sec) {
      var cols = EDIT_TABLES[sec].cols;
      return (buf[sec] || []).map(function (r, i) {
        var cells = cols.map(function (c) {
          return '<td><textarea rows="2" data-sec="' + sec + '" data-idx="' + i + '" data-key="' + c[0] + '">' + esc(r[c[0]] || '') + '</textarea></td>';
        }).join('');
        return '<tr>' + cells + '<td class="rm"><button class="x" data-rm="' + sec + '" data-idx="' + i + '" title="Remove row">×</button></td></tr>';
      }).join('');
    }
    function tableHtml(sec) {
      var t = EDIT_TABLES[sec];
      return '<div class="edit-sec"><div class="edit-sec-h">' + esc(t.title) + ' <button class="btn xs" data-add="' + sec + '">+ Add row</button></div>' +
        '<table class="edit-tbl" data-tbl="' + sec + '"><thead><tr>' + t.cols.map(function (c) { return '<th>' + esc(c[1]) + '</th>'; }).join('') + '<th></th></tr></thead>' +
        '<tbody>' + rowsHtml(sec) + '</tbody></table></div>';
    }
    function render() {
      var prodFields = '<div class="row2"><div><label>Product name</label><input type="text" data-prod="name" value="' + esc(buf.product.name || p.name || '') + '" /></div>' +
        '<div><label>Domain</label><input type="text" data-prod="domain" value="' + esc(buf.product.domain || '') + '" /></div></div>' +
        '<label>Target start date</label><input type="date" data-top="startDate" value="' + esc(buf.startDate || '') + '" />' +
        EDIT_PRODUCT.map(function (f) { return '<label>' + esc(f[1]) + '</label><textarea rows="2" data-prod="' + f[0] + '">' + esc(buf.product[f[0]] || '') + '</textarea>'; }).join('');
      body.innerHTML = '<div class="edit-sec"><div class="edit-sec-h">Product</div>' + prodFields + '</div>' +
        Object.keys(EDIT_TABLES).map(tableHtml).join('');
    }
    render();

    body.addEventListener('input', function (e) {
      var el = e.target;
      if (el.dataset.prod) { buf.product[el.dataset.prod] = el.value; }
      else if (el.dataset.top) { buf[el.dataset.top] = el.value; }
      else if (el.dataset.sec) { (buf[el.dataset.sec][+el.dataset.idx] = buf[el.dataset.sec][+el.dataset.idx] || {})[el.dataset.key] = el.value; }
    });
    body.addEventListener('click', function (e) {
      var add = e.target.getAttribute && e.target.getAttribute('data-add');
      var rm = e.target.getAttribute && e.target.getAttribute('data-rm');
      if (add) { buf[add].push({}); render(); }
      else if (rm) { buf[rm].splice(+e.target.getAttribute('data-idx'), 1); render(); }
    });

    bg.querySelector('#e-assess').addEventListener('click', function () {
      var btn = this; var apiKey = bg.querySelector('#e-ai').value.trim(), linKey = bg.querySelector('#e-lin').value.trim();
      try { if (apiKey) localStorage.setItem('pw_anthropic_key', apiKey); } catch (e) {}
      btn.disabled = true; status.style.color = ''; status.textContent = 'Assessing changes against Linear + code… (can take a minute)';
      api('/api/projects/' + id + '/assess', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proposed: bufToIntake(buf), apiKey: apiKey, linearKey: linKey }) })
        .then(function (res) {
          btn.disabled = false; var j = res.j || {};
          if (!res.ok) {
            status.style.color = 'var(--red)';
            status.innerHTML = '✗ ' + esc(j.error || 'failed') + (j.code === 'no_corpus' ? ' — <a href="#/p/' + id + '/edit">add a code/zip upload</a>, then assess.' : '');
            return;
          }
          if (j.empty) { status.style.color = ''; status.textContent = j.message || 'No changes to assess.'; return; }
          status.textContent = '';
          assessPopup(id, bufToIntake(buf), j, apiKey, linKey, function () { bg.remove(); });
        }).catch(function (e) { btn.disabled = false; status.style.color = 'var(--red)'; status.textContent = '✗ ' + e.message; });
    });
  }

  function unitCardHtml(u) {
    var pieces = '';
    if (u.group === 'doc') {
      var det = [];
      (u.scalars || []).forEach(function (s) { det.push('<div class="chg-row"><b>' + esc(s.field) + '</b>: <span class="was">' + esc(s.before || '∅') + '</span> → <span class="now">' + esc(s.after || '∅') + '</span></div>'); });
      (u.added || []).forEach(function (r) { det.push('<div class="chg-row add">+ ' + esc(JSON.stringify(r).slice(0, 160)) + '</div>'); });
      (u.removed || []).forEach(function (r) { det.push('<div class="chg-row del">− ' + esc(JSON.stringify(r).slice(0, 160)) + '</div>'); });
      (u.modified || []).forEach(function (m) { det.push('<div class="chg-row">~ ' + esc(JSON.stringify(m.after).slice(0, 160)) + '</div>'); });
      pieces = '<div class="chg-kind doc">DOC · ' + esc(u.section) + '</div>' +
        (u.impact ? '<div class="chg-impact">' + esc(u.impact) + '</div>' : '') + det.join('');
    } else if (u.group === 'linear') {
      pieces = '<div class="chg-kind lin lin-' + esc(u.action) + '">LINEAR · ' + esc(u.action) + (u.issueIdentifier ? ' ' + esc(u.issueIdentifier) : '') + '</div>' +
        '<div class="chg-title">' + esc(u.title || '') + '</div>' +
        (u.objective ? '<div class="chg-impact">' + esc(u.objective) + '</div>' : '') +
        '<div class="chg-reason">' + esc(u.reason || '') + (u.action === 'create' ? ' · ' + esc(u.owner) + ' · ' + esc(u.label) : '') + '</div>';
    } else if (u.group === 'affected-closed') {
      pieces = '<div class="chg-kind closed">CLOSED ISSUE · ' + esc(u.issueIdentifier) + '</div>' +
        '<div class="chg-title">' + esc(u.title || '') + '</div><div class="chg-reason">' + esc(u.reason || '') + '</div>' +
        '<div class="chg-note">Accepting comments the Change ID here — it does not reopen the issue.</div>';
    } else if (u.group === 'code') {
      pieces = '<div class="chg-kind code">CODE IMPACT · ' + esc(u.area || '') + '</div>' +
        '<div class="chg-impact">' + esc(u.detail || '') + '</div>' +
        (u.functions || []).map(function (f) { return '<div class="chg-row"><code>' + esc(f.name) + '</code>' + (f.file ? ' <span class="muted">' + esc(f.file) + '</span>' : '') + ' — ' + esc(f.impact) + '</div>'; }).join('');
    }
    return '<div class="chg-card"><label class="chg-acc"><input type="checkbox" class="chg-cb" data-uid="' + esc(u.id) + '" checked /> <span>accept</span></label>' +
      '<div class="chg-main">' + pieces + '</div></div>';
  }

  function assessPopup(id, proposed, assessResult, apiKey, linKey, onApplied) {
    var units = assessResult.units || [];
    var bg = document.createElement('div'); bg.className = 'modal-bg';
    var grouped = { doc: [], linear: [], 'affected-closed': [], code: [] };
    units.forEach(function (u) { (grouped[u.group] || (grouped[u.group] = [])).push(u); });
    function section(title, arr) { return arr.length ? '<h4 class="chg-grp">' + title + ' <span>(' + arr.length + ')</span></h4>' + arr.map(unitCardHtml).join('') : ''; }
    bg.innerHTML = '<div class="modal edit-modal"><h3>' + ic('sparkles') + 'Assess Changes</h3>' +
      '<p class="chg-summary">' + esc(assessResult.summary || '') + '</p>' +
      (assessResult.hasLinear ? '' : '<p class="hint">No Linear key/tracker linked — doc changes apply but no issues sync.</p>') +
      '<div class="edit-body">' +
        section('Documentation', grouped.doc) +
        section('Linear issues', grouped.linear) +
        section('Affected completed issues', grouped['affected-closed']) +
        section('Code impact', grouped.code) +
        (units.length ? '' : '<p class="hint">No actionable changes detected.</p>') +
      '</div>' +
      '<div class="edit-foot"><div style="display:flex;gap:8px;align-items:center">' +
        '<button class="btn sm primary" id="c-apply">' + ic('sparkles') + 'Apply accepted</button>' +
        '<button class="btn sm" id="c-cancel">Back to editing</button>' +
        '<span class="hint" id="c-status"></span></div></div></div>';
    document.body.appendChild(bg);
    var cstatus = bg.querySelector('#c-status');
    bg.querySelector('#c-cancel').addEventListener('click', function () { bg.remove(); });

    bg.querySelector('#c-apply').addEventListener('click', function () {
      var btn = this;
      var accepted = Array.prototype.slice.call(bg.querySelectorAll('.chg-cb:checked')).map(function (cb) { return cb.getAttribute('data-uid'); });
      btn.disabled = true; cstatus.style.color = ''; cstatus.textContent = 'Applying ' + accepted.length + ' change(s)… saving docs + syncing Linear';
      api('/api/projects/' + id + '/apply-changes', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proposed: proposed, units: units, accepted: accepted, apiKey: apiKey, linearKey: linKey, summary: assessResult.summary }) })
        .then(function (res) {
          btn.disabled = false; var j = res.j || {};
          if (!res.ok) { cstatus.style.color = 'var(--red)'; cstatus.textContent = '✗ ' + (j.error || 'failed'); return; }
          var a = j.applied || {};
          var msg = j.changeId + ' applied · ' + (a.docSections || []).length + ' doc section(s)' +
            (a.linear && a.linear.length ? ', ' + a.linear.length + ' Linear action(s)' : '') +
            (a.affectedClosed && a.affectedClosed.length ? ', ' + a.affectedClosed.length + ' closed-issue note(s)' : '');
          if (j.errors && j.errors.length) msg += ' · ' + j.errors.length + ' warning(s)';
          toast(msg);
          bg.remove(); if (onApplied) onApplied(); docs(id);
        }).catch(function (e) { btn.disabled = false; cstatus.style.color = 'var(--red)'; cstatus.textContent = '✗ ' + e.message; });
    });
  }

  function exportSheet(id) {
    var bg = document.createElement('div'); bg.className = 'modal-bg';
    bg.innerHTML = '<div class="modal exp-modal"><h3>Export</h3>' +
      '<div class="exp-opt"><div><b>Download — server bundle</b><div class="hint">The full docs app. Unzip, <code>npm install &amp;&amp; npm start</code>, open <code>/docs</code>.</div></div>' +
      '<a class="btn sm primary" href="/api/projects/' + id + '/download">' + ic('download') + '.zip</a></div>' +
      '<div class="exp-opt"><div><b>Download — standalone HTML</b><div class="hint">Flat pages with relative links — opens straight from your Downloads folder, no server needed.</div></div>' +
      '<a class="btn sm primary" href="/api/projects/' + id + '/download-static">' + ic('download') + '.zip</a></div>' +
      '<div class="exp-opt col"><div><b>Deploy to Docker (LAN, over SSH)</b><div class="hint">Builds a bundle wired to your host; unzip and run <code>bash deploy.sh</code>. Fill in the target:</div></div>' +
        '<div class="dform">' +
          '<label>SSH host / IP</label><input type="text" id="d-host" placeholder="10.10.0.208" />' +
          '<div class="row2"><div><label>SSH user</label><input type="text" id="d-user" value="docker" /></div><div><label>SSH port</label><input type="text" id="d-sshport" value="22" /></div></div>' +
          '<label>SSH password</label><input type="password" id="d-pass" placeholder="needed so the wizard can push over SSH" />' +
          '<div class="row2"><div><label>App name</label><input type="text" id="d-name" placeholder="my-docs" /></div><div><label>Container port</label><input type="text" id="d-port" value="3000" /></div></div>' +
          '<label>Hostname for Traefik <span style="text-transform:none;letter-spacing:0">(optional)</span></label><input type="text" id="d-hostname" placeholder="docs.10.10.0.208.nip.io" />' +
          '<div class="hint">Leave blank to publish the container port directly instead of going through a proxy.</div>' +
          '<div style="display:flex;gap:8px;margin-top:12px"><button class="btn sm primary" id="d-deploy">' + ic('upload') + 'Deploy now</button><button class="btn sm" id="d-dl">' + ic('download') + 'Download bundle</button></div>' +
          '<div class="hint" id="d-note" style="margin-top:8px"></div>' +
          '<pre id="d-out"></pre>' +
        '</div></div>' +
      '<div class="row"><button class="btn" id="exp-close">Close</button></div></div>';
    document.body.appendChild(bg);
    bg.addEventListener('click', function (e) { if (e.target === bg) bg.remove(); });
    bg.querySelector('#exp-close').addEventListener('click', function () { bg.remove(); });
    var note = bg.querySelector('#d-note'), outEl = bg.querySelector('#d-out');
    function vals() {
      return {
        host: bg.querySelector('#d-host').value.trim(),
        user: bg.querySelector('#d-user').value.trim() || 'docker',
        sshPort: bg.querySelector('#d-sshport').value.trim() || '22',
        password: bg.querySelector('#d-pass').value,
        name: bg.querySelector('#d-name').value.trim() || '',
        port: bg.querySelector('#d-port').value.trim() || '3000',
        hostname: bg.querySelector('#d-hostname').value.trim(),
      };
    }
    function showOut(t) { if (t) { outEl.textContent = t; outEl.style.display = 'block'; } }
    bg.querySelector('#d-dl').addEventListener('click', function () {
      var v = vals(); if (!v.host) { bg.querySelector('#d-host').focus(); return; }
      var q = { host: v.host, user: v.user, sshPort: v.sshPort, name: v.name, port: v.port, hostname: v.hostname };
      window.location.href = '/api/projects/' + id + '/download-deploy?' + new URLSearchParams(q).toString();
      note.innerHTML = '✓ Downloaded — unzip and run <code>bash deploy.sh</code> from a machine with SSH access to <b>' + esc(v.host) + '</b>.';
    });
    bg.querySelector('#d-deploy').addEventListener('click', function () {
      var v = vals();
      if (!v.host) { bg.querySelector('#d-host').focus(); return; }
      if (!v.password) { note.innerHTML = 'Enter the SSH password so the wizard can push — or use <b>Download bundle</b> and deploy with your own key.'; bg.querySelector('#d-pass').focus(); return; }
      var btn = this; btn.disabled = true; outEl.style.display = 'none';
      note.textContent = 'Deploying… (rsync + docker compose up — can take a minute on first build)';
      api('/api/projects/' + id + '/deploy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(v) }).then(function (res) {
        btn.disabled = false;
        var j = (res && res.j) || {};
        if (j.ok) { note.innerHTML = '✓ Deployed — open <a href="' + esc(j.url) + '" target="_blank">' + esc(j.url) + '</a>'; showOut(j.output); }
        else { note.innerHTML = '✗ ' + esc(j.error || 'deploy failed'); showOut(j.output); }
      }).catch(function (e) { btn.disabled = false; note.textContent = '✗ ' + e.message; });
    });
  }

  // ─── agent API: mint keys + paste-in kit ───────────────────────────────────
  // The LAN-reachable wizard origin (e.g. http://wizard.192.168.1.220.nip.io) so
  // a key's paste-in kit is reachable from another machine even if this page was
  // opened on localhost. Falls back to whatever origin we're served on.
  function wizardLanBase() {
    return fetch('/api/config').then(function (r) { return r.json(); }).catch(function () { return {}; })
      .then(function (cfg) {
        var ip = cfg && cfg.hostIp;
        if (!ip) {
          var m = String(location.hostname).match(/(\d+\.\d+\.\d+\.\d+)\.nip\.io$/) ||
                  String(location.hostname).match(/^(\d+\.\d+\.\d+\.\d+)$/);
          if (m) ip = m[1];
        }
        return ip ? 'http://wizard.' + ip + '.nip.io' : location.origin;
      });
  }

  function fallbackCopy(text) { var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (e) {} ta.remove(); }
  function copyText(text, btn) {
    var orig = btn.textContent;
    function done() { btn.textContent = 'Copied ✓'; setTimeout(function () { btn.textContent = orig; }, 1400); }
    if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); }); }
    else { fallbackCopy(text); done(); }
  }

  // Renders the key-minting UI + existing-key list for one project into `body`.
  // `baseOverride` is the LAN origin baked into the kit so it's reachable off-box.
  function agentKeyPanel(body, id, baseOverride) {
    body.innerHTML =
      '<div class="dform">' +
        '<div id="ak-list" style="margin-bottom:14px">' + '<div class="hint">Loading keys…</div>' + '</div>' +
        '<div style="border-top:1px solid var(--line);padding-top:14px"><b style="font-size:13.5px">Create a new key</b></div>' +
        '<div class="row2" style="margin-top:10px">' +
          '<div><label>Access</label><select id="ak-scope"><option value="write">Read + write (edit, deploy, keys)</option><option value="read">Read only</option></select></div>' +
          '<div><label>Label (optional)</label><input type="text" id="ak-name" placeholder="e.g. build session" /></div>' +
        '</div>' +
        '<div style="margin-top:10px"><button class="btn sm primary" id="ak-create">' + ic('sparkles') + 'Create key</button></div>' +
        '<div id="ak-result" style="display:none;margin-top:14px"></div>' +
      '</div>';
    var result = body.querySelector('#ak-result');
    var list = body.querySelector('#ak-list');

    function refreshList() {
      fetch('/api/projects/' + id + '/agent-tokens').then(function (r) { return r.json(); }).then(function (d) {
        var toks = (d && d.tokens) || [];
        if (!toks.length) { list.innerHTML = '<div class="hint">No keys yet for this project.</div>'; return; }
        list.innerHTML = '<div class="hint" style="margin-bottom:6px">Existing keys</div>' + toks.map(function (t) {
          var state = t.revokedAt ? ' · <span style="color:var(--dim)">revoked</span>' : '';
          var used = t.lastUsedAt ? ' · last used ' + fmtDate(t.lastUsedAt) : '';
          return '<div class="exp-opt" style="align-items:center">' +
            '<div><b>' + esc(t.name) + '</b> <span class="pill ' + (t.scope === 'write' ? 'generated' : 'draft') + '">' + esc(t.scope) + '</span>' +
            '<div class="hint">' + esc(t.prefix) + ' · created ' + fmtDate(t.createdAt) + used + state + '</div></div>' +
            (t.revokedAt ? '' : '<button class="btn sm" data-revoke="' + t.id + '">Revoke</button>') +
          '</div>';
        }).join('');
        list.querySelectorAll('[data-revoke]').forEach(function (b) {
          b.addEventListener('click', function () {
            if (!confirm('Revoke this key? Any session using it loses access immediately.')) return;
            fetch('/api/projects/' + id + '/agent-tokens/' + b.getAttribute('data-revoke'), { method: 'DELETE' }).then(function () { refreshList(); });
          });
        });
      });
    }
    refreshList();

    body.querySelector('#ak-create').addEventListener('click', function () {
      var scope = body.querySelector('#ak-scope').value;
      var name = body.querySelector('#ak-name').value.trim();
      var btn = this; btn.disabled = true;
      api('/api/projects/' + id + '/agent-tokens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: scope, name: name, base: baseOverride || '' }) })
        .then(function (res) {
          btn.disabled = false;
          var j = res.j || {};
          result.style.display = 'block';
          if (!res.ok) { result.innerHTML = '<div class="hint" style="color:#c0392b">' + esc(j.error || 'could not create key') + '</div>'; return; }
          result.innerHTML =
            '<div class="ok-note">✦ Key created — copy it now. For security the secret is shown <b>only once</b>.</div>' +
            '<label style="margin-top:10px">Paste this into a new Claude session</label>' +
            '<pre id="ak-kit" style="white-space:pre-wrap;word-break:break-word;max-height:340px;overflow:auto;background:var(--code);color:var(--text);border:1px solid var(--line);padding:10px;border-radius:6px;font-size:12px;line-height:1.45"></pre>' +
            '<div style="display:flex;gap:8px;margin-top:8px"><button class="btn sm primary" id="ak-copy">Copy for Claude</button>' +
            '<button class="btn sm" id="ak-copytok">Copy token only</button></div>';
          result.querySelector('#ak-kit').textContent = j.kit || '';
          result.querySelector('#ak-copy').addEventListener('click', function () { copyText(j.kit || '', this); });
          result.querySelector('#ak-copytok').addEventListener('click', function () { copyText(j.token || '', this); });
          refreshList();
        }).catch(function (e) { btn.disabled = false; result.style.display = 'block'; result.innerHTML = '<div class="hint">' + esc(e.message) + '</div>'; });
    });
  }

  // Per-project: "Share with agent" on the generated-docs page.
  function shareSheet(id) {
    var bg = document.createElement('div'); bg.className = 'modal-bg';
    bg.innerHTML = '<div class="modal exp-modal" style="width:min(640px,94vw);max-width:640px"><h3>' + ic('nodes') + 'Share this project with a Claude session</h3>' +
      '<p class="hint">Create a key scoped to <b>this project</b>. Paste the block into another Claude session and it can read the full plan, make edits over the API, pull the deploy/SSH details &amp; API keys, and read every other project on this wizard for cross-app context.</p>' +
      '<div id="share-base" class="hint" style="margin:4px 0 10px"></div>' +
      '<div id="share-body"></div>' +
      '<div class="row"><button class="btn" id="share-close">Close</button></div></div>';
    document.body.appendChild(bg);
    bg.addEventListener('click', function (e) { if (e.target === bg) bg.remove(); });
    bg.querySelector('#share-close').addEventListener('click', function () { bg.remove(); });
    wizardLanBase().then(function (base) {
      bg.querySelector('#share-base').innerHTML = 'API base: <code>' + esc(base + '/api/agent') + '</code>';
      agentKeyPanel(bg.querySelector('#share-body'), id, base);
    });
  }

  // Global: "Connect Agent" in the home management bar — lists every project's
  // keys up front (grouped by project), with a create-a-key form below.
  function connectorSheet() {
    var bg = document.createElement('div'); bg.className = 'modal-bg';
    bg.innerHTML = '<div class="modal exp-modal" style="width:min(640px,94vw);max-width:640px"><h3>' + ic('nodes') + 'Connect a Claude session</h3>' +
      '<p class="hint">Give another Claude session direct API access to a project on this wizard — read the plan, edit it, pull the connection details (Docker/SSH host, API keys), and see every other project for cross-app architecture context. Connect over your LAN.</p>' +
      '<div class="dform">' +
        '<label>Wizard API base (LAN)</label>' +
        '<div style="display:flex;gap:8px;align-items:center"><code id="conn-base" style="flex:1;padding:8px;background:var(--code);color:var(--text);border:1px solid var(--line);border-radius:6px;overflow:auto;white-space:nowrap">…</code><button class="btn sm" id="conn-base-copy">Copy</button></div>' +
        '<div id="conn-keys" style="margin-top:16px"><div class="hint">Loading keys…</div></div>' +
        '<div style="border-top:1px solid var(--line);padding-top:14px;margin-top:16px"><b style="font-size:13.5px">Create a key</b></div>' +
        '<div class="row2" style="margin-top:10px">' +
          '<div><label>Project</label><select id="conn-proj"><option value="">Loading…</option></select></div>' +
          '<div><label>Access</label><select id="conn-scope"><option value="write">Read + write (edit, deploy, keys)</option><option value="read">Read only</option></select></div>' +
        '</div>' +
        '<div class="row2" style="margin-top:10px;align-items:end">' +
          '<div><label>Label (optional)</label><input type="text" id="conn-name" placeholder="e.g. build session" /></div>' +
          '<div><button class="btn sm primary" id="conn-create" style="width:100%">' + ic('sparkles') + 'Create key</button></div>' +
        '</div>' +
        '<div id="conn-result" style="display:none;margin-top:14px"></div>' +
      '</div>' +
      '<div class="row"><button class="btn" id="conn-close">Close</button></div></div>';
    document.body.appendChild(bg);
    bg.addEventListener('click', function (e) { if (e.target === bg) bg.remove(); });
    bg.querySelector('#conn-close').addEventListener('click', function () { bg.remove(); });

    var baseEl = bg.querySelector('#conn-base');
    var lanBase = location.origin;
    wizardLanBase().then(function (base) { lanBase = base; baseEl.textContent = base + '/api/agent'; });
    bg.querySelector('#conn-base-copy').addEventListener('click', function () { copyText(baseEl.textContent, this); });

    var keysEl = bg.querySelector('#conn-keys');
    var projSel = bg.querySelector('#conn-proj');
    var result = bg.querySelector('#conn-result');
    var nameById = {};

    function loadProjects() {
      return fetch('/api/projects').then(function (r) { return r.json(); }).then(function (projects) {
        nameById = {};
        projects.forEach(function (p) { nameById[p.id] = p.name; });
        projSel.innerHTML = projects.length
          ? projects.map(function (p) { return '<option value="' + p.id + '">' + esc(p.name) + '</option>'; }).join('')
          : '<option value="">No projects yet — create one first</option>';
        return projects;
      });
    }

    // Fetch every project's keys and render them grouped by project.
    function refreshKeys() {
      keysEl.innerHTML = '<div class="hint">Loading keys…</div>';
      loadProjects().then(function (projects) {
        if (!projects.length) { keysEl.innerHTML = ''; return; }
        return Promise.all(projects.map(function (p) {
          return fetch('/api/projects/' + p.id + '/agent-tokens').then(function (r) { return r.json(); })
            .then(function (d) { return { p: p, tokens: (d && d.tokens) || [] }; })
            .catch(function () { return { p: p, tokens: [] }; });
        })).then(function (groups) {
          var withKeys = groups.filter(function (g) { return g.tokens.length; });
          if (!withKeys.length) { keysEl.innerHTML = '<div class="hint">No keys yet on any project. Create one below.</div>'; return; }
          keysEl.innerHTML = '<div class="hint" style="margin-bottom:6px">Existing keys</div>' + withKeys.map(function (g) {
            return '<div style="margin-bottom:10px"><div style="font-weight:600;font-size:13px;margin-bottom:4px">' + esc(g.p.name) + '</div>' +
              g.tokens.map(function (t) {
                var state = t.revokedAt ? ' · <span style="color:var(--dim)">revoked</span>' : '';
                var used = t.lastUsedAt ? ' · last used ' + fmtDate(t.lastUsedAt) : '';
                return '<div class="exp-opt" style="align-items:center">' +
                  '<div><b>' + esc(t.name) + '</b> <span class="pill ' + (t.scope === 'write' ? 'generated' : 'draft') + '">' + esc(t.scope) + '</span>' +
                  '<div class="hint">' + esc(t.prefix) + ' · created ' + fmtDate(t.createdAt) + used + state + '</div></div>' +
                  (t.revokedAt ? '' : '<button class="btn sm" data-revoke="' + t.id + '" data-proj="' + g.p.id + '">Revoke</button>') +
                '</div>';
              }).join('') + '</div>';
          }).join('');
          keysEl.querySelectorAll('[data-revoke]').forEach(function (b) {
            b.addEventListener('click', function () {
              if (!confirm('Revoke this key? Any session using it loses access immediately.')) return;
              fetch('/api/projects/' + b.getAttribute('data-proj') + '/agent-tokens/' + b.getAttribute('data-revoke'), { method: 'DELETE' }).then(function () { refreshKeys(); });
            });
          });
        });
      });
    }
    refreshKeys();

    bg.querySelector('#conn-create').addEventListener('click', function () {
      var pid = projSel.value;
      if (!pid) { projSel.focus(); return; }
      var scope = bg.querySelector('#conn-scope').value;
      var name = bg.querySelector('#conn-name').value.trim();
      var btn = this; btn.disabled = true;
      api('/api/projects/' + pid + '/agent-tokens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: scope, name: name, base: lanBase || '' }) })
        .then(function (res) {
          btn.disabled = false;
          var j = res.j || {};
          result.style.display = 'block';
          if (!res.ok) { result.innerHTML = '<div class="hint" style="color:#c0392b">' + esc(j.error || 'could not create key') + '</div>'; return; }
          result.innerHTML =
            '<div class="ok-note">✦ Key created for <b>' + esc(nameById[pid] || '') + '</b> — copy it now. The secret is shown <b>only once</b>.</div>' +
            '<label style="margin-top:10px">Paste this into a new Claude session</label>' +
            '<pre id="conn-kit" style="white-space:pre-wrap;word-break:break-word;max-height:340px;overflow:auto;background:var(--code);color:var(--text);border:1px solid var(--line);padding:10px;border-radius:6px;font-size:12px;line-height:1.45"></pre>' +
            '<div style="display:flex;gap:8px;margin-top:8px"><button class="btn sm primary" id="conn-copy">Copy for Claude</button>' +
            '<button class="btn sm" id="conn-copytok">Copy token only</button></div>';
          result.querySelector('#conn-kit').textContent = j.kit || '';
          result.querySelector('#conn-copy').addEventListener('click', function () { copyText(j.kit || '', this); });
          result.querySelector('#conn-copytok').addEventListener('click', function () { copyText(j.token || '', this); });
          refreshKeys();
        }).catch(function (e) { btn.disabled = false; result.style.display = 'block'; result.innerHTML = '<div class="hint">' + esc(e.message) + '</div>'; });
    });
  }

  route();
})();
