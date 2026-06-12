// Router + home (project tiles) + generated-docs browser.
(function () {
  'use strict';
  var app = document.getElementById('app');

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
  function fmtDate(iso) { if (!iso) return ''; var d = new Date(iso); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
  function api(url, opts) { return fetch(url, opts).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); }); }
  function toast(msg, isErr) { var t = document.createElement('div'); t.className = 'toast' + (isErr ? ' err' : ''); t.textContent = msg; document.body.appendChild(t); setTimeout(function () { t.remove(); }, 2600); }

  // ─── router ────────────────────────────────────────────────────────────────
  function route() {
    var h = location.hash.replace(/^#/, '') || '/';
    var m;
    if (h === '/' || h === '') return home();
    if ((m = h.match(/^\/p\/([a-f0-9]{16})\/edit$/))) return window.Wizard.render(app, m[1]);
    if ((m = h.match(/^\/p\/([a-f0-9]{16})\/docs$/))) return docs(m[1]);
    location.hash = '#/';
  }
  window.addEventListener('hashchange', route);

  // ─── home ────────────────────────────────────────────────────────────────
  function home() {
    app.innerHTML = '<div class="loading">loading…</div>';
    fetch('/api/projects').then(function (r) { return r.json(); }).then(function (projects) {
      if (!projects.length) {
        app.innerHTML =
          '<div class="empty"><h2>No projects yet</h2>' +
          '<p>Start one and the wizard walks you through the decisions only a human can make — then generates the project’s full /docs structure.</p>' +
          '<button class="btn primary" id="new-empty">+ New project</button>' +
          '<a class="hint" href="/demo-sequence.html">See a worked example → Sequence</a></div>';
        app.querySelector('#new-empty').addEventListener('click', newProject);
        return;
      }
      var tiles = projects.map(tileHtml).join('');
      app.innerHTML =
        '<div class="home-head"><h1>Projects<span class="count">' + projects.length + '</span></h1>' +
        '<div style="display:flex;gap:12px;align-items:center"><a class="hint" href="/demo-sequence.html">Worked example</a>' +
        '<button class="btn primary" id="new-top">+ New project</button></div></div>' +
        '<div class="tiles">' + tiles +
        '<div class="tile new" id="new-tile"><div class="plus">+</div><div>New project</div></div></div>';
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
      '<div class="row"><button class="btn ghost" id="np-cancel">Cancel</button><button class="btn primary" id="np-create">Create &amp; start</button></div></div>';
    document.body.appendChild(bg);
    var input = bg.querySelector('#np-name'); input.focus();
    function close() { bg.remove(); }
    bg.querySelector('#np-cancel').addEventListener('click', close);
    bg.addEventListener('click', function (e) { if (e.target === bg) close(); });
    function create() {
      var name = input.value.trim();
      api('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name }) })
        .then(function (res) { close(); location.hash = '#/p/' + res.j.id + '/edit'; });
    }
    bg.querySelector('#np-create').addEventListener('click', create);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') create(); });
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
        '<button class="btn sm primary" id="export-btn">⬇ Export…</button>' +
        '<button class="btn sm" id="regen">↻ Re-run wizard</button></div></div>' +
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
      '<a class="btn sm primary" href="/api/projects/' + id + '/download">⬇ .zip</a></div>' +
      '<div class="exp-opt"><div><b>Download — standalone HTML</b><div class="hint">Flat pages with relative links — opens straight from your Downloads folder, no server needed.</div></div>' +
      '<a class="btn sm primary" href="/api/projects/' + id + '/download-static">⬇ .zip</a></div>' +
      '<div class="exp-opt col"><div><b>Deploy to Docker (LAN, over SSH)</b><div class="hint">Builds a bundle wired to your host; unzip and run <code>bash deploy.sh</code>. Fill in the target:</div></div>' +
        '<div class="dform">' +
          '<label>SSH host / IP</label><input type="text" id="d-host" placeholder="10.10.0.208" />' +
          '<div class="row2"><div><label>SSH user</label><input type="text" id="d-user" value="docker" /></div><div><label>SSH port</label><input type="text" id="d-sshport" value="22" /></div></div>' +
          '<label>SSH password</label><input type="password" id="d-pass" placeholder="needed so the wizard can push over SSH" />' +
          '<div class="row2"><div><label>App name</label><input type="text" id="d-name" placeholder="my-docs" /></div><div><label>Container port</label><input type="text" id="d-port" value="3000" /></div></div>' +
          '<label>Hostname for Traefik <span style="text-transform:none;letter-spacing:0">(optional)</span></label><input type="text" id="d-hostname" placeholder="docs.10.10.0.208.nip.io" />' +
          '<div class="hint">Leave blank to publish the container port directly instead of going through a proxy.</div>' +
          '<div style="display:flex;gap:8px;margin-top:12px"><button class="btn sm primary" id="d-deploy">🚀 Deploy now</button><button class="btn sm" id="d-dl">⬇ Download bundle</button></div>' +
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
