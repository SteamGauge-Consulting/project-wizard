// ============================================================================
//  lib/auth.js — shared Microsoft Entra ID (Azure AD) OIDC gate.
//
//  One env-gated module used by BOTH the wizard (server.js) and every deployed
//  docs pod (serve-docs.js). Zero external deps — OIDC auth-code + PKCE, id_token
//  RS256 validation against the tenant JWKS, and an HMAC-signed session cookie
//  are all built on Node's `crypto`, so it ships to pods that run built-ins only.
//
//  Enable per install with AUTH_MODE=entra + the ENTRA_* env (see DEPLOY.md).
//  AUTH_MODE unset/off → the gate is a no-op, so existing installs are unchanged.
//
//  Authorization is an EMAIL / @DOMAIN allow-list (ENTRA_ALLOWED): a valid tenant
//  sign-in is necessary but not sufficient — the account must be on the list.
//
//  Machine surfaces stay open under the gate: loopback requests (internal
//  forwards, update scripts) and any request carrying the shared machine token
//  (X-PW-Machine) are exempt, plus /auth/*, /healthz, and /api/agent/* (own
//  bearer auth). This keeps the wizard↔pod deploy callbacks working.
// ============================================================================
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const b64urlToBuf = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

function cfg() {
  const mode = String(process.env.AUTH_MODE || 'off').trim().toLowerCase();
  return {
    enabled: mode === 'entra',
    tenant: String(process.env.ENTRA_TENANT_ID || '').trim(),
    clientId: String(process.env.ENTRA_CLIENT_ID || '').trim(),
    clientSecret: String(process.env.ENTRA_CLIENT_SECRET || '').trim(),
    allowed: String(process.env.ENTRA_ALLOWED || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    publicUrl: String(process.env.AUTH_PUBLIC_URL || '').trim().replace(/\/+$/, ''),
    ttlH: Math.max(1, Number(process.env.AUTH_SESSION_HOURS || 12) || 12),
  };
}

// The machine token shared between the wizard and the pods it deploys: read from
// env (baked into pods at deploy) or a data-volume file (the wizard generates +
// persists it). Requests carrying it in X-PW-Machine bypass the human gate.
function machineToken(secretDir) {
  const env = String(process.env.PW_MACHINE_TOKEN || '').trim();
  if (env) return env;
  try { return fs.readFileSync(path.join(secretDir, 'machine-token'), 'utf8').trim(); } catch (e) {}
  try {
    fs.mkdirSync(secretDir, { recursive: true });
    const t = b64url(crypto.randomBytes(24));
    fs.writeFileSync(path.join(secretDir, 'machine-token'), t + '\n', { mode: 0o600 });
    return t;
  } catch (e) { return ''; }
}

// A stable session-signing secret persisted alongside the machine token.
function sessionSecret(secretDir) {
  const env = String(process.env.AUTH_SESSION_SECRET || '').trim();
  if (env) return env;
  const f = path.join(secretDir, 'session-secret');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch (e) {}
  try {
    fs.mkdirSync(secretDir, { recursive: true });
    const s = b64url(crypto.randomBytes(32));
    fs.writeFileSync(f, s + '\n', { mode: 0o600 });
    return s;
  } catch (e) { return b64url(crypto.randomBytes(32)); }  // ephemeral fallback
}

// ── compact HMAC-signed token (session + the login-request state cookie) ──────
function signToken(secret, payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  return body + '.' + sig;
}
function verifyToken(secret, token) {
  if (!token || token.indexOf('.') === -1) return null;
  const [body, sig] = token.split('.');
  const expect = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  let p; try { p = JSON.parse(b64urlToBuf(body).toString('utf8')); } catch (e) { return null; }
  if (p && p.exp && Date.now() / 1000 > p.exp) return null;
  return p;
}

// ── cookies ──────────────────────────────────────────────────────────────────
function parseCookies(req) {
  const out = {};
  const raw = (req.headers && req.headers.cookie) || '';
  raw.split(';').forEach((c) => { const i = c.indexOf('='); if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); });
  return out;
}
function isHttps(req, conf) {
  if (conf.publicUrl) return conf.publicUrl.slice(0, 6) === 'https:';
  return String((req.headers && req.headers['x-forwarded-proto']) || '').split(',')[0].trim() === 'https';
}
function setCookie(res, req, conf, name, value, maxAgeSec) {
  const parts = [name + '=' + encodeURIComponent(value), 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAgeSec != null) parts.push('Max-Age=' + maxAgeSec);
  if (maxAgeSec === 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  if (isHttps(req, conf)) parts.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', (prev ? (Array.isArray(prev) ? prev : [prev]) : []).concat(parts.join('; ')));
}

// The install's public scheme://host — from AUTH_PUBLIC_URL (path stripped) or
// the request. The PATH of AUTH_PUBLIC_URL becomes the auth base path, so a pod
// exposed at <app>/docs registers its /auth routes under /docs (the only prefix
// the proxy routes to it) and builds a matching redirect URI.
function schemeHost(u) { const m = String(u || '').match(/^(https?:\/\/[^/]+)/i); return m ? m[1] : ''; }
function basePathOf(conf) {
  if (!conf.publicUrl) return '';
  const p = conf.publicUrl.slice(schemeHost(conf.publicUrl).length).replace(/\/+$/, '');
  return p || '';
}
function originOf(req, conf) {
  if (conf.publicUrl) return schemeHost(conf.publicUrl);
  const proto = String((req.headers && req.headers['x-forwarded-proto']) || 'http').split(',')[0].trim();
  const host = (req.headers && req.headers.host) || 'localhost';
  return proto + '://' + host;
}

function emailAllowed(email, allowed) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return false;
  const dom = e.slice(e.indexOf('@'));   // "@treebrandapps.com"
  return allowed.some((a) => a === e || a === dom || (a[0] === '@' && a === dom) || a === '*');
}

// ── Entra endpoints + JWKS (cached) ───────────────────────────────────────────
function httpsJson(url, opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, opts || {}, (r) => {
      let d = ''; r.on('data', (c) => (d += c));
      r.on('end', () => { try { resolve({ status: r.statusCode, json: JSON.parse(d) }); } catch (e) { resolve({ status: r.statusCode, json: null, raw: d }); } });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('Entra request timed out')));
    if (body) req.write(body);
    req.end();
  });
}

function makeJwks(tenant) {
  let cache = { at: 0, keys: null };
  return async function key(kid) {
    if (!cache.keys || Date.now() - cache.at > 3600000) {
      const r = await httpsJson('https://login.microsoftonline.com/' + tenant + '/discovery/v2.0/keys', { method: 'GET' });
      if (r.json && Array.isArray(r.json.keys)) cache = { at: Date.now(), keys: r.json.keys };
    }
    return (cache.keys || []).find((k) => k.kid === kid) || null;
  };
}

// Validate an Entra id_token: RS256 signature against the JWKS, plus iss / aud /
// exp / nonce. Returns the claims or throws.
async function validateIdToken(idToken, conf, jwks, nonce) {
  const [h, p, s] = String(idToken).split('.');
  if (!h || !p || !s) throw new Error('malformed id_token');
  const header = JSON.parse(b64urlToBuf(h).toString('utf8'));
  const claims = JSON.parse(b64urlToBuf(p).toString('utf8'));
  if (header.alg !== 'RS256') throw new Error('unexpected token alg');
  const jwk = await jwks(header.kid);
  if (!jwk) throw new Error('signing key not found');
  const pub = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const ok = crypto.verify('RSA-SHA256', Buffer.from(h + '.' + p), pub, b64urlToBuf(s));
  if (!ok) throw new Error('bad token signature');
  if (String(claims.aud) !== conf.clientId) throw new Error('token audience mismatch');
  if (String(claims.iss || '').indexOf(conf.tenant) === -1) throw new Error('token issuer mismatch');
  if (claims.exp && Date.now() / 1000 > claims.exp + 120) throw new Error('token expired');
  if (nonce && claims.nonce !== nonce) throw new Error('nonce mismatch');
  return claims;
}

// ── mount ─────────────────────────────────────────────────────────────────────
// opts: { secretDir, exempt?(req)->bool }. Registers /auth/* and returns a gate
// middleware to app.use() BEFORE the protected routes. When AUTH_MODE!=entra it
// registers nothing and returns a pass-through.
function mount(app, opts) {
  opts = opts || {};
  const conf = cfg();
  const secretDir = opts.secretDir || path.join(__dirname, '..', '.deploy');
  const token = machineToken(secretDir);

  if (!conf.enabled) {
    return function passthrough(req, res, next) { next(); };
  }
  if (!conf.tenant || !conf.clientId || !conf.clientSecret) {
    console.error('[auth] AUTH_MODE=entra but ENTRA_TENANT_ID / ENTRA_CLIENT_ID / ENTRA_CLIENT_SECRET are incomplete — refusing to run OPEN. Set them or unset AUTH_MODE.');
    return function fail(req, res) { res.status(503).type('text').send('Auth misconfigured — the server is closed. Check ENTRA_* env.'); };
  }
  if (!conf.allowed.length) console.warn('[auth] ENTRA_ALLOWED is empty — NO account will be authorized. Set an email/@domain allow-list.');

  const secret = sessionSecret(secretDir);
  const jwks = makeJwks(conf.tenant);
  const SESSION_COOKIE = 'pw_session', REQ_COOKIE = 'pw_authreq';
  const BASE = basePathOf(conf);                 // '' for the wizard, '/docs' for path-mounted pods
  const A = (sub) => BASE + '/auth' + sub;        // route + redirect path builder
  const redirectUri = (req) => originOf(req, conf) + BASE + '/auth/callback';

  function currentUser(req) {
    const c = parseCookies(req);
    const s = verifyToken(secret, c[SESSION_COOKIE]);
    if (!s || !emailAllowed(s.email, conf.allowed)) return null;
    return s;
  }

  app.get(A('/login'), function (req, res) {
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(sha256(verifier));
    const state = b64url(crypto.randomBytes(16));
    const nonce = b64url(crypto.randomBytes(16));
    const next = typeof req.query.next === 'string' && req.query.next[0] === '/' ? req.query.next : (BASE || '/');
    setCookie(res, req, conf, REQ_COOKIE, signToken(secret, { verifier, nonce, state, next, exp: Math.floor(Date.now() / 1000) + 600 }), 600);
    const url = 'https://login.microsoftonline.com/' + conf.tenant + '/oauth2/v2.0/authorize?' + [
      'client_id=' + encodeURIComponent(conf.clientId),
      'response_type=code', 'response_mode=query',
      'redirect_uri=' + encodeURIComponent(redirectUri(req)),
      'scope=' + encodeURIComponent('openid profile email'),
      'state=' + state, 'nonce=' + nonce,
      'code_challenge=' + challenge, 'code_challenge_method=S256',
    ].join('&');
    res.redirect(url);
  });

  app.get(A('/callback'), async function (req, res) {
    try {
      const c = parseCookies(req);
      const rq = verifyToken(secret, c[REQ_COOKIE]);
      if (!rq) return res.status(400).type('text').send('Login session expired — start again at ' + A('/login') + '.');
      if (!req.query.code || req.query.state !== rq.state) return res.status(400).type('text').send('Invalid login state.');
      const form = [
        'client_id=' + encodeURIComponent(conf.clientId),
        'client_secret=' + encodeURIComponent(conf.clientSecret),
        'grant_type=authorization_code',
        'code=' + encodeURIComponent(String(req.query.code)),
        'redirect_uri=' + encodeURIComponent(redirectUri(req)),
        'code_verifier=' + encodeURIComponent(rq.verifier),
      ].join('&');
      const tok = await httpsJson('https://login.microsoftonline.com/' + conf.tenant + '/oauth2/v2.0/token',
        { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(form) } }, form);
      if (!tok.json || !tok.json.id_token) return res.status(502).type('text').send('Token exchange failed.');
      const claims = await validateIdToken(tok.json.id_token, conf, jwks, rq.nonce);
      const email = String(claims.preferred_username || claims.email || claims.upn || '').toLowerCase();
      if (!emailAllowed(email, conf.allowed)) {
        setCookie(res, req, conf, REQ_COOKIE, '', 0);
        return res.status(403).type('html').send(page('Not authorized', 'Signed in as <b>' + esc(email || 'unknown') + '</b>, but this account is not on the allow-list for this site.<br><br><a href="' + A('/logout') + '">Sign out</a>'));
      }
      setCookie(res, req, conf, SESSION_COOKIE, signToken(secret, { sub: claims.sub, email, name: claims.name || email, exp: Math.floor(Date.now() / 1000) + conf.ttlH * 3600 }), conf.ttlH * 3600);
      setCookie(res, req, conf, REQ_COOKIE, '', 0);
      res.redirect(rq.next || BASE || '/');
    } catch (e) {
      res.status(400).type('text').send('Sign-in failed: ' + (e.message || e));
    }
  });

  app.get(A('/logout'), function (req, res) {
    setCookie(res, req, conf, SESSION_COOKIE, '', 0);
    const post = encodeURIComponent(originOf(req, conf) + (BASE || '/'));
    res.redirect('https://login.microsoftonline.com/' + conf.tenant + '/oauth2/v2.0/logout?post_logout_redirect_uri=' + post);
  });

  app.get(A('/me'), function (req, res) {
    const u = currentUser(req);
    res.json(u ? { ok: true, email: u.email, name: u.name } : { ok: false });
  });

  // The gate: allow machine surfaces + authenticated allow-listed humans; send
  // everyone else to Entra (HTML) or 401 (API/XHR).
  return function gate(req, res, next) {
    const p = req.path || req.url || '';
    if (p === '/healthz' || p === BASE + '/healthz' || p.indexOf('/auth/') !== -1 || p.indexOf('/api/agent') === 0) return next();
    if (opts.exempt && opts.exempt(req)) return next();
    // loopback: internal forwards + update scripts (raw socket only — never trust XFF)
    const ra = (req.socket && req.socket.remoteAddress) || '';
    if (ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1') return next();
    // machine token (wizard↔pod calls)
    const mt = String((req.headers && req.headers['x-pw-machine']) || '').trim();
    if (token && mt && mt.length === token.length && crypto.timingSafeEqual(Buffer.from(mt), Buffer.from(token))) return next();

    if (currentUser(req)) return next();

    const wantsHtml = String((req.headers && req.headers.accept) || '').indexOf('text/html') !== -1 && req.method === 'GET';
    if (wantsHtml) return res.redirect(A('/login') + '?next=' + encodeURIComponent(req.originalUrl || req.url || (BASE || '/')));
    res.status(401).json({ error: 'authentication required', login: A('/login') });
  };
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function page(title, bodyHtml) {
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + esc(title) + '</title><style>body{margin:0;background:#0E0E10;color:#E8E8E4;font:16px/1.6 -apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}' +
    '.card{max-width:440px;padding:34px 30px;border:1px solid #2A2A2E;border-radius:14px;background:#161618;text-align:center}h1{font-size:20px;margin:0 0 14px}a{color:#97C459}</style>' +
    '<div class="card"><h1>' + esc(title) + '</h1><div>' + bodyHtml + '</div></div>';
}

module.exports = { mount, machineToken, emailAllowed, _internal: { signToken, verifyToken, validateIdToken, makeJwks, sessionSecret } };
