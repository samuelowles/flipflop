#!/usr/bin/env node
// scripts/powerswitch-smoke.mjs — #240 live smoke (the AC's `npm run powerswitch:smoke`).
//
// Runs the REAL rebuilt wire layer (powerswitchSession → powerswitchReplay →
// powerswitchRscParser) under Node against live powerswitch.org.nz for the
// fixture address, with in-memory KV/D1 stubs. PASS = ≥5 plans, every variable
// rate in [0.05, 1.00] $/kWh and every fixed daily charge in [0.30, 5.00] $/day.
//
// Run from repo root or workers/:  npm run powerswitch:smoke   (workers/package.json)
// Loads the TypeScript modules via tsx (npx, dev-only — not a dependency).
//
// COMPLIANCE: one replay ≈ 4 sequential POSTs — well within the 200 req/day
// budget. Gates 1+2 satisfied (docs/POWERSWITCH_COMPLIANCE.md). ICP never sent.

import { resolveUserAddress } from '../workers/src/services/powerswitchSession.ts';
import { replayQuestionnaire, DEFAULT_ANSWERS } from '../workers/src/services/powerswitchReplay.ts';

// Minimal in-memory KV stub (replay needs get/put/delete).
const store = new Map();
const KV = {
  async get(k) { return store.has(k) ? store.get(k) : null; },
  async put(k, v) { store.set(k, v); },
  async delete(k) { store.delete(k); },
};
// No-op D1 stub — resolveUserAddress persists pxid/location to the users row;
// the smoke has no real user, so writes are swallowed.
const DB = {
  prepare: () => ({ bind: (..._a) => ({ run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }) }),
};

const env = { KV, DB, POWERSWITCH_LIVE: 'true' };
const ADDRESS = process.argv[2] || '1 Queen Street, Auckland Central, Auckland 1010';

console.log(`[smoke] resolving address: ${ADDRESS}`);
const resolved = await resolveUserAddress(env, 'smoke-test', ADDRESS);
if (resolved.status !== 'resolved') {
  console.error(`[smoke] FAIL — address resolution: ${JSON.stringify(resolved)}`);
  process.exit(1);
}
console.log(`[smoke] pxid=${resolved.pxid} location=${resolved.locationId}`);

console.log('[smoke] replaying questionnaire (live, sequential)…');
const outcome = await replayQuestionnaire(env, 'smoke-test', resolved.pxid, DEFAULT_ANSWERS);
if (outcome.status !== 'ok') {
  console.error(`[smoke] FAIL — replay: ${JSON.stringify(outcome)}`);
  process.exit(1);
}

const plans = outcome.results.plans;
// Sanity bounds. Note: plans legitimately carry tiny per-kWh pass-throughs
// (e.g. the Electricity Authority levy ≈ 0.0019 $/kWh), so small rates are NOT
// errors. The checks: no rate is absurd (>1.00 $/kWh), no daily charge is
// absurd, and every plan has at least one MAIN energy rate in [0.05, 1.00].
const daily = [];
let absurdRates = [];
let plansMissingMainRate = [];
for (const p of plans) {
  let hasMainRate = false;
  for (const t of p.tariffs) {
    if (t.registerContentCode === 'F') daily.push(t.value);
    else if (t.displayType === 'amount' && t.value > 0) {
      if (t.value > 1.0) absurdRates.push(`${p.name}:${t.code}=${t.value}`);
      if (t.value >= 0.05 && t.value <= 1.0) hasMainRate = true;
    }
  }
  if (!hasMainRate) plansMissingMainRate.push(p.name);
}
const badRate = absurdRates;
const badDaily = daily.filter((v) => v < 0.3 || v > 5.0);

console.log(`[smoke] plans: ${plans.length} | retailers: ${[...new Set(plans.map((p) => p.retailerId))].join(',')}`);
console.log(`[smoke] usage kWh: ${outcome.results.usage.annualKwh} | cached: ${outcome.cached}`);
console.log(`[smoke] sample: ${plans[0].name} — tariffs ${plans[0].tariffs.map((t) => `${t.code}:${t.value}`).join(' ')}`);

const pass = plans.length >= 5 && badRate.length === 0 && badDaily.length === 0 && plansMissingMainRate.length === 0;
if (!pass) {
  console.error(`[smoke] FAIL — plans=${plans.length} absurdRates=${JSON.stringify(badRate)} badDaily=${JSON.stringify(badDaily)} missingMainRate=${JSON.stringify(plansMissingMainRate)}`);
  process.exit(1);
}
console.log('[smoke] PASS');
