// ============================================================================
//  claude-model.js — which Claude model every wizard AI call runs on.
//
//  Primary: Claude Fable 5 (Anthropic's most capable model). Fallback: Claude
//  Opus 5. A request the primary refuses, or that this org's API key can't run
//  on the primary at all, is re-run WHOLE on the fallback — so the wizard keeps
//  working everywhere (Fable requires 30-day data retention and returns 400 on
//  every request under zero-data-retention).
//
//  Shared by enrich.js, assess.js and reverse-engineer.js. Zero dependencies —
//  those modules stay dependency-light.
// ============================================================================
'use strict';

const MODEL = process.env.WIZARD_MODEL || 'claude-fable-5';
const FALLBACK_MODEL = process.env.WIZARD_FALLBACK_MODEL || 'claude-opus-5';

// Failures worth re-running on the fallback model. 422 = a policy refusal (the
// safety classifiers can decline a benign codebase); 400/403/404 = the model is
// not served to this org; the rest = Anthropic-side capacity, where the fallback
// genuinely helps because each model has its own rate-limit pool.
// Deliberately absent: 401 (the same key would fail again) and 504 (the wait has
// already been spent — re-running would double it with a user watching).
const FALLBACK_STATUS = new Set([400, 403, 404, 422, 429, 500, 502, 503, 529]);

// "This key cannot use this model" — unlike a refusal or a capacity blip, that
// stays true for every later call, so the first one pins the process to the
// fallback rather than burning a doomed request on each of the ~50 turns of an
// agent run. A malformed body also lands here; the cost of that misdiagnosis is
// only that later calls go straight to the fallback, which is where they were
// headed anyway, and the pin is logged.
const PIN_STATUS = new Set([400, 403, 404]);

let pinned = null;

// The model new requests start on.
function current() { return pinned || MODEL; }

// The models to try, in order, for one logical request.
function chain() {
  const primary = current();
  return primary === FALLBACK_MODEL ? [primary] : [primary, FALLBACK_MODEL];
}

// Is this failure worth trying the next model? Pins the process when the status
// says the model is unavailable rather than busy or unwilling.
function retryable(err, model) {
  const status = err && err.status;
  if (!FALLBACK_STATUS.has(status)) return false;
  if (PIN_STATUS.has(status) && !pinned && model !== FALLBACK_MODEL) {
    pinned = FALLBACK_MODEL;
    console.log('[model] ' + model + ' is not available to this API key (HTTP ' + status + ': ' +
      ((err && err.message) || '') + ') — using ' + FALLBACK_MODEL + ' for the rest of this process');
  }
  return true;
}

// Run `attempt(model)` against the chain until one succeeds. Rethrows the last
// error when every model failed, or the first error when it isn't worth a retry.
// `label` only tags the log line (e.g. 'import', 'assess', 'enrich').
async function withFallback(label, attempt) {
  const models = chain();
  for (let i = 0; ; i++) {
    try { return await attempt(models[i]); }
    catch (e) {
      if (i === models.length - 1 || !retryable(e, models[i])) throw e;
      console.log('[' + label + '] ' + models[i] + ' failed (HTTP ' + (e && e.status) + ': ' +
        ((e && e.message) || e) + ') — retrying on ' + models[i + 1]);
    }
  }
}

module.exports = { MODEL, FALLBACK_MODEL, current, chain, retryable, withFallback };
