// ============================================================================
//  entra-graph.js — Microsoft Graph people search for the wizard's Stakeholders
//  step. Client-credentials token (the OIDC flow never retains an access
//  token), so the org directory can be searched server-side without per-user
//  consent. Needs the **User.Read.All APPLICATION permission + admin consent**
//  (one-time, Azure portal); without it Graph returns 403 and the endpoint
//  reports exactly that.
//
//  ⚠ The SSO registration's ENTRA_CLIENT_SECRET is baked into every deployed
//  pod's compose file — granting IT directory-read widens what a leaked pod
//  secret can do. Prefer a SECOND registration used only here: set
//  GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET on the wizard
//  (never forwarded to pods) and grant User.Read.All to that app instead.
//  Falls back to the ENTRA_* SSO creds when GRAPH_* is unset.
//
//  Zero deps, fail-soft: when AUTH_MODE isn't entra (or creds are incomplete)
//  enabled() is false and the wizard hides the lookup — manual entry still works.
// ============================================================================
'use strict';

const https = require('https');

function cfg() {
  return {
    tenant: (process.env.GRAPH_TENANT_ID || process.env.ENTRA_TENANT_ID || '').trim(),
    clientId: (process.env.GRAPH_CLIENT_ID || process.env.ENTRA_CLIENT_ID || '').trim(),
    clientSecret: (process.env.GRAPH_CLIENT_SECRET || process.env.ENTRA_CLIENT_SECRET || '').trim(),
  };
}
function enabled() {
  // Same AUTH_MODE normalization as lib/auth.js:32 — 'Entra ' in a compose
  // .env must not enable SSO while silently disabling the lookup.
  const mode = String(process.env.AUTH_MODE || '').trim().toLowerCase();
  const c = cfg();
  return mode === 'entra' && !!(c.tenant && c.clientId && c.clientSecret);
}

function httpsJson(url, opts, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: (opts && opts.method) || 'GET', headers: (opts && opts.headers) || {},
      timeout: 8000,
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(data); } catch (e) {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// App-only token for Graph, cached until ~1 min before expiry.
let tok = { value: '', exp: 0 };
async function appToken() {
  if (tok.value && Date.now() < tok.exp) return tok.value;
  const c = cfg();
  const form = 'client_id=' + encodeURIComponent(c.clientId) +
    '&client_secret=' + encodeURIComponent(c.clientSecret) +
    '&grant_type=client_credentials&scope=' + encodeURIComponent('https://graph.microsoft.com/.default');
  const r = await httpsJson('https://login.microsoftonline.com/' + encodeURIComponent(c.tenant) + '/oauth2/v2.0/token',
    { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } }, form);
  if (!r.json || !r.json.access_token) {
    throw new Error('Entra token request failed: ' + ((r.json && (r.json.error_description || r.json.error)) || ('HTTP ' + r.status)));
  }
  tok = { value: r.json.access_token, exp: Date.now() + (Number(r.json.expires_in || 3599) - 60) * 1000 };
  return tok.value;
}

// Directory search by display name / mail prefix. Returns rows shaped for the
// wizard's stakeholder table; extra Graph identity kept as entraId.
async function searchPeople(q) {
  const t = await appToken();
  const term = String(q || '').replace(/["\\]/g, ' ').trim();
  const search = '"displayName:' + term + '" OR "mail:' + term + '"';
  const url = 'https://graph.microsoft.com/v1.0/users?$search=' + encodeURIComponent(search) +
    '&$select=id,displayName,mail,userPrincipalName,jobTitle,businessPhones,mobilePhone&$top=10&$count=true';
  const r = await httpsJson(url, {
    headers: { authorization: 'Bearer ' + t, ConsistencyLevel: 'eventual' },
  });
  if (r.status === 403) {
    throw new Error('Graph denied the search — grant the app registration the User.Read.All APPLICATION permission (+ admin consent) in the Azure portal.');
  }
  if (!r.json || !Array.isArray(r.json.value)) {
    throw new Error('Graph search failed: ' + ((r.json && r.json.error && r.json.error.message) || ('HTTP ' + r.status)));
  }
  return r.json.value.map((u) => ({
    entraId: u.id || '',
    name: u.displayName || '',
    email: u.mail || u.userPrincipalName || '',
    phone: (Array.isArray(u.businessPhones) && u.businessPhones[0]) || u.mobilePhone || '',
    title: u.jobTitle || '',
  }));
}

// Errors can carry raw AADSTS descriptions with trace/correlation IDs — log
// those server-side; hand the browser only the leading, actionable part.
function publicError(e) {
  const first = String((e && e.message) || 'Entra lookup failed').split(/[.,]?\s*Trace ID/i)[0].split('\n')[0].trim();
  return first.length > 220 ? first.slice(0, 220) + '…' : first;
}

module.exports = { enabled, searchPeople, publicError };
