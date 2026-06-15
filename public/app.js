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
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'
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
    if (!links.portainer && !links.proxy) return '';
    return (links.portainer ? '<a class="btn sm ghost" target="_blank" href="' + esc(links.portainer) + '" title="Portainer — container management">' + ic('box') + 'Containers</a>' : '') +
           (links.proxy ? '<a class="btn sm ghost" target="_blank" href="' + esc(links.proxy) + '" title="Traefik — reverse-proxy dashboard">' + ic('nodes') + 'Proxy</a>' : '');
  }
  function fillMgmt() {
    var slot = app.querySelector('#mgmt-links');
    if (!slot) return;
    hostLinks().then(function (links) { slot.innerHTML = mgmtBarHtml(links); });
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
          var id = el.getAttribute('data-id'), status = el.getAttribute('data-status');
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
    return '<div class="tile" data-id="' + p.id + '" data-status="' + p.status + '" data-name="' + esc(p.name) + '">' +
      '<button class="del" title="delete">×</button>' +
      '<div class="name">' + esc(p.name) + '</div>' +
      '<div class="one">' + (esc(p.oneliner) || '<span style="color:var(--dim)">no description yet</span>') + '</div>' +
      '<div class="meta"><span class="pill ' + p.status + '">' + (p.status === 'generated' ? 'generated' : 'draft') + '</span>' +
      (p.status === 'generated' ? '<span>' + p.fileCount + ' files · ' + esc(p.docsDir) + '/</span>' : '<span>updated ' + fmtDate(p.updatedAt) + '</span>') +
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
        '<button class="btn sm primary" id="export-btn">' + ic('download') + 'Export…</button>' +
        '<button class="btn sm" id="regen">' + ic('refresh') + 'Re-run wizard</button></div></div>' +
        '<div class="browser"><div class="filetree" id="tree"></div>' +
        '<div class="viewer" id="viewer"><div class="placeholder">Select a file to view it.</div></div></div>';
      app.querySelector('#regen').addEventListener('click', function () { location.hash = '#/p/' + id + '/edit'; });
      app.querySelector('#export-btn').addEventListener('click', function () { exportSheet(id); });

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

  route();
})();
