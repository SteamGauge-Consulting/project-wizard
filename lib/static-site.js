// Build a STANDALONE static version of a generated /docs package: every page as
// a flat .html file with relative links, so it opens straight from a Downloads
// folder over file:// with no server. Uses the package's OWN engine (lib/md.js,
// docs-nav.js, docs-routes.js) so the output matches the served version exactly.
const fs = require('fs');
const path = require('path');

// Map a /docs route to its static file path (relative to the static root).
function routeToFile(href) {
  href = String(href).split('#')[0].split('?')[0];
  if (href === '/' || href === '/docs' || href === '') return 'index.html';
  if (href === '/docs/claude-init') return 'framework.html';
  let m;
  if ((m = href.match(/^\/docs\/library\/(.+)$/))) return 'library/' + m[1] + '.html';
  if ((m = href.match(/^\/docs\/view\/(.+)\.md$/))) return 'view/' + m[1] + '.html';
  if ((m = href.match(/^\/docs\/(.+)$/))) return m[1] + '.html';
  return null; // not a /docs route
}

// Rewrite root-absolute href/src to paths relative to a page `depth` dirs deep.
function rewriteLinks(html, depth) {
  const up = '../'.repeat(depth);
  return html.replace(/(href|src)="(\/[^"]*)"/g, function (full, attr, url) {
    if (url === '/') return attr + '="' + (up || './') + 'index.html"';
    const f = routeToFile(url);
    if (f) return attr + '="' + up + f + '"';
    return full; // /api/* etc. — left as-is (degrades quietly under file://)
  });
}
const depthOf = (rel) => rel.split('/').length - 1;

function build(genDir) {
  const outDir = path.join(genDir, '_static');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const libDir = path.join(genDir, 'lib');
  const md = require(path.join(libDir, 'md.js'));
  const docsNav = require(path.join(libDir, 'docs-nav.js'));
  const docsRoutes = require(path.join(libDir, 'docs-routes.js'));

  let count = 0;
  const writeOut = (rel, html) => {
    const dest = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, rewriteLinks(html, depthOf(rel)));
    count++;
  };

  // 1. Static single-file pages (docs.html → index.html, plan.html, …).
  docsRoutes.STATIC_PAGES.forEach(function (pg) {
    const src = path.join(genDir, pg.file);
    if (!fs.existsSync(src)) return;
    const html = fs.readFileSync(src, 'utf-8').replace('<!--DOCS_NAV-->', docsNav.navHtml(pg.navKey || ''));
    writeOut(routeToFile(pg.path) || path.basename(pg.file), html);
  });

  // 2. Governance library pages.
  const libPagesDir = path.join(genDir, 'governance', 'library');
  if (fs.existsSync(libPagesDir)) {
    fs.readdirSync(libPagesDir).filter((f) => f.endsWith('.html')).forEach(function (f) {
      const html = fs.readFileSync(path.join(libPagesDir, f), 'utf-8').replace('<!--DOCS_NAV-->', docsNav.navHtml(''));
      writeOut('library/' + f, html);
    });
  }

  // 3. Every markdown doc → rendered to view/<relpath>.html.
  const skip = new Set(['node_modules', '.git', '_static', '_deploy']);
  const walk = (dir, rel) => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
      if (skip.has(e.name) || e.name.startsWith('.')) return;
      const rp = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) return walk(path.join(dir, e.name), rp);
      if (!e.name.endsWith('.md')) return;
      let src = fs.readFileSync(path.join(dir, e.name), 'utf-8');
      src = src.replace('<!-- AUTOGEN:routes -->', docsRoutes.routesTableMarkdown());
      const html = md.docPage(e.name.replace(/\.md$/, ''), src, ''); // no GitHub source link offline
      writeOut('view/' + rp.replace(/\.md$/, '.html'), html);
    });
  };
  walk(genDir, '');

  // A tiny README so the bundle explains itself.
  fs.writeFileSync(path.join(outDir, 'README.txt'),
    'Standalone docs — open index.html in any browser (works from this folder, no server needed).\n');
  return { outDir, count };
}

module.exports = { build, routeToFile, rewriteLinks };
