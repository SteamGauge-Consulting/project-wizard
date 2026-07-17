// ============================================================================
//  github-corpus.js — pull the linked GitHub repo into the Assess code corpus.
//
//  integrations.githubRepoUrl was historically a docs link only; this module
//  makes it a live corpus source: fetch the repo's default-branch zipball via
//  the GitHub API into a small on-disk cache, refreshed by commit SHA — one
//  cheap API call per assess, with the zip re-downloading only when the repo
//  actually changed. The cache is laid out so the zip sits ALONE in
//  <cacheDir>/zip/ — hand that subdir to reverse.buildCorpus alongside the
//  uploads dir and the corpus builder's existing *.zip expansion does the rest
//  (meta.json stays a level up so it never joins the corpus).
//
//      <cacheDir>/meta.json     — { sha, repoUrl, fetchedAt }
//      <cacheDir>/zip/repo.zip  — the repo zipball (a corpus root)
//
//  Fail-soft: when GitHub is unreachable (or the token went bad) but a cached
//  zip exists, the cache is served with stale:true so Assess still runs against
//  the last-known code. syncRepoCache throws only when no usable zip exists.
//  Dependency-light: global fetch + Node built-ins; github.com only.
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_ZIP_BYTES = Number(process.env.GITHUB_ZIP_MAX_BYTES || 150 * 1024 * 1024);
const SHA_TIMEOUT_MS = 10000;
const ZIP_TIMEOUT_MS = 180000;

// owner/repo from the URL forms people actually paste (https, with/without
// .git or a trailing /tree/... path, or the git@ SSH form); null otherwise.
function parseRepo(url) {
  const s = String(url || '').trim();
  let m = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(s);
  if (!m) m = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s?#]+?)(?:\.git)?(?:[/?#].*)?$/i.exec(s);
  return m ? { owner: m[1], repo: m[2] } : null;
}

function apiHeaders(token, accept) {
  const h = { 'user-agent': 'project-wizard', accept: accept || 'application/vnd.github+json' };
  if (token) h.authorization = 'Bearer ' + token;
  return h;
}

function zipDir(cacheDir) { return path.join(cacheDir, 'zip'); }
function zipPath(cacheDir) { return path.join(zipDir(cacheDir), 'repo.zip'); }
function hasZip(cacheDir) { try { return fs.statSync(zipPath(cacheDir)).size > 0; } catch (e) { return false; } }
function readMeta(cacheDir) {
  try { return JSON.parse(fs.readFileSync(path.join(cacheDir, 'meta.json'), 'utf-8')) || {}; }
  catch (e) { return {}; }
}

async function timedFetch(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, Object.assign({ signal: ctrl.signal }, opts)); }
  catch (e) { throw new Error(e.name === 'AbortError' ? 'GitHub request timed out' : ('could not reach GitHub: ' + (e.message || e))); }
  finally { clearTimeout(timer); }
}

// Latest commit SHA of the default branch — the vnd.github.sha media type
// returns the bare SHA, so this is one tiny request.
async function headSha(owner, repo, token) {
  const res = await timedFetch('https://api.github.com/repos/' + owner + '/' + repo + '/commits/HEAD',
    { headers: apiHeaders(token, 'application/vnd.github.sha') }, SHA_TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(res.status === 404
      ? (token ? 'repo not found — check the URL, and that the token can read it' : 'repo not found — a private repo needs a GitHub token')
      : (res.status === 401 || res.status === 403) ? 'GitHub rejected the token (HTTP ' + res.status + ')'
      : 'GitHub API HTTP ' + res.status);
  }
  const sha = (await res.text()).trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error('unexpected GitHub response for the latest commit');
  return sha;
}

// Download the zipball for a SHA. Redirects are followed by hand because the
// API 302s to codeload with a self-contained (tokened) URL — the Authorization
// header goes only to api.github.com, never wherever a redirect points.
async function downloadZip(owner, repo, sha, token, cacheDir) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ZIP_TIMEOUT_MS);
  try {
    let url = 'https://api.github.com/repos/' + owner + '/' + repo + '/zipball/' + sha;
    let res = null;
    for (let hop = 0; hop < 4; hop++) {
      const isApi = /^https:\/\/api\.github\.com\//i.test(url);
      res = await fetch(url, { headers: isApi ? apiHeaders(token) : { 'user-agent': 'project-wizard' }, redirect: 'manual', signal: ctrl.signal });
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) { url = new URL(loc, url).href; continue; }
      break;
    }
    if (!res || !res.ok) throw new Error('zip download failed (HTTP ' + (res ? res.status : '?') + ')');
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_ZIP_BYTES) {
        ctrl.abort();
        throw new Error('repo zip exceeds ' + Math.round(MAX_ZIP_BYTES / 1048576) + 'MB (raise GITHUB_ZIP_MAX_BYTES to allow it)');
      }
      chunks.push(Buffer.from(value));
    }
    const tmp = zipPath(cacheDir) + '.tmp';
    fs.writeFileSync(tmp, Buffer.concat(chunks));
    fs.renameSync(tmp, zipPath(cacheDir));
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'the zip download timed out' : (e.message || String(e)));
  } finally { clearTimeout(timer); }
}

// Ensure the cache holds the repo's latest default-branch zipball. Returns
// { dir, sha, refreshed, stale, warning } — dir is the corpus root to hand to
// buildCorpus. Throws only when no usable zip can be produced at all.
async function syncRepoCache(opts) {
  const repoUrl = String((opts && opts.repoUrl) || '').trim();
  const token = String((opts && opts.token) || '').trim();
  const cacheDir = (opts && opts.cacheDir) || '';
  const parsed = parseRepo(repoUrl);
  if (!parsed) throw new Error('unsupported GitHub repo URL "' + repoUrl + '" — expected https://github.com/owner/repo');
  fs.mkdirSync(zipDir(cacheDir), { recursive: true });
  const meta = readMeta(cacheDir);
  const cached = hasZip(cacheDir);
  const useCache = (why) => ({ dir: zipDir(cacheDir), sha: meta.sha || null, stale: true,
    warning: why + ' — using the cached repo copy' + (meta.fetchedAt ? ' from ' + meta.fetchedAt : '') });

  let sha;
  try { sha = await headSha(parsed.owner, parsed.repo, token); }
  catch (e) {
    if (cached) return useCache('could not check GitHub for new commits (' + (e.message || e) + ')');
    throw e;
  }
  if (cached && meta.sha === sha) return { dir: zipDir(cacheDir), sha, refreshed: false };
  try { await downloadZip(parsed.owner, parsed.repo, sha, token, cacheDir); }
  catch (e) {
    if (cached) return useCache('could not download the latest repo zip (' + (e.message || e) + ')');
    throw e;
  }
  try {
    fs.writeFileSync(path.join(cacheDir, 'meta.json'),
      JSON.stringify({ sha, repoUrl, fetchedAt: new Date().toISOString() }, null, 2) + '\n');
  } catch (e) { /* cache still works — the next sync just re-downloads */ }
  return { dir: zipDir(cacheDir), sha, refreshed: true };
}

module.exports = { parseRepo, syncRepoCache };
