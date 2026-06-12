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
        '<div style="display:flex;gap:10px">' +
        '<a class="btn sm" href="/api/projects/' + id + '/download">⬇ Download .zip</a>' +
        '<button class="btn sm" id="regen">↻ Re-run wizard</button></div></div>' +
        '<div class="browser"><div class="filetree" id="tree"></div>' +
        '<div class="viewer" id="viewer"><div class="placeholder">Select a file to view it.</div></div></div>';
      app.querySelector('#regen').addEventListener('click', function () { location.hash = '#/p/' + id + '/edit'; });

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

  route();
})();
