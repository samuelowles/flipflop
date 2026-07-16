// @generated · do not edit this comment
/**
 * #240 — Regenerate the live-protocol wire fixtures from the REAL captures.
 *
 * Reads the request/response pairs in `workers/tests/fixtures/powerswitch-live/`
 * (captured by scripts/capture-powerswitch.mjs) and emits the flight bodies the
 * parser/session/replay unit tests + the daily drift canary run against.
 *
 * CARDINAL RULE (issue #240): every byte here traces to a capture file — this
 * script invents nothing. The only transform applied is the drift variant, which
 * renames ONE field the parser keys on so the canary has a known-bad sample.
 *
 * Tests run under @cloudflare/vitest-pool-workers (no node:fs), so the captures
 * cannot be read at test time — they are inlined here as string constants.
 *
 * Run:  node scripts/gen-powerswitch-fixtures.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const FIX_DIR = join(root, 'workers', 'tests', 'fixtures', 'powerswitch-live');
const OUT = join(root, 'workers', 'src', 'services', 'powerswitchLiveFixtures.ts');

/** Extract the flight body (everything after the `---- body ----` delimiter). */
function readBody(filename) {
  const raw = readFileSync(join(FIX_DIR, filename), 'utf8');
  const marker = '---- body ----';
  const idx = raw.indexOf(marker);
  if (idx < 0) throw new Error(`${filename}: no "${marker}" delimiter`);
  // Drop the delimiter line + its newline; trim trailing whitespace.
  return raw.slice(idx + marker.length).replace(/^\r?\n/, '').trimEnd();
}

const autocompleteFlight = readBody('03-autocomplete.res.txt'); // POST / → completions
const householdFlight = readBody('07-q-household.res.txt'); // POST /questionnaire/household → locations
const insulationFlight = readBody('16-q-insulation.res.txt'); // POST /questionnaire/insulation → profile.id
const resultsFlight = readBody('18-results.res.txt'); // POST /results → plans (15 plans / 9 retailers)

// Drift variant: rename the usage field the parser keys on (electricity → annual_kwh).
// The real capture keys annual kWh on `household.usage.electricity`; the canary must
// reject any response that drifts off that shape. `"electricity":7007.6875` is unique.
const DRIFT_NEEDLE = '"electricity":7007.6875';
if (!resultsFlight.includes(DRIFT_NEEDLE)) {
  throw new Error(`drift needle "${DRIFT_NEEDLE}" not found in 18-results.res.txt — capture changed?`);
}
const resultsFlightDrift = resultsFlight.replace(DRIFT_NEEDLE, '"annual_kwh":7007.6875');

// Each constant is emitted via JSON.stringify so the literal backslash-escapes
// inside the JSON flight text (\r\n in description strings, \" etc.) survive the
// round-trip byte-for-byte. A raw template literal would reinterpret \r as a CR.
const lines = [
  '// @generated · DO NOT EDIT. Regenerate via `node scripts/gen-powerswitch-fixtures.mjs`.',
  '// Source of truth: workers/tests/fixtures/powerswitch-live/*.res.txt (issue #240 captures).',
  '// Every byte traces to a capture file — this file invents nothing.',
  '',
  '/** POST / autocomplete flight (03-autocomplete.res.txt) — 10 completions, base + units. */',
  `export const autocomplete_flight: string = ${JSON.stringify(autocompleteFlight)};`,
  '',
  '/** POST /questionnaire/household flight (07-q-household.res.txt) — result.address + locations. */',
  `export const household_flight: string = ${JSON.stringify(householdFlight)};`,
  '',
  '/** POST /questionnaire/insulation flight (16-q-insulation.res.txt) — profile.id (results token). */',
  `export const insulation_flight: string = ${JSON.stringify(insulationFlight)};`,
  '',
  '/** POST /results flight (18-results.res.txt) — 15 plans across 9 retailers, usage.electricity=7007.6875. */',
  `export const rsc_results_flight: string = ${JSON.stringify(resultsFlight)};`,
  '',
  '/** Drift variant: usage field renamed electricity→annual_kwh. The parser must REJECT this. */',
  `export const rsc_results_flight_drift: string = ${JSON.stringify(resultsFlightDrift)};`,
  '',
];

writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(`wrote ${OUT}`);
console.log(`  autocomplete_flight: ${autocompleteFlight.length} bytes`);
console.log(`  household_flight:    ${householdFlight.length} bytes`);
console.log(`  insulation_flight:   ${insulationFlight.length} bytes`);
console.log(`  rsc_results_flight:  ${resultsFlight.length} bytes (15 plans / 9 retailers)`);
console.log(`  rsc_results_flight_drift: ${resultsFlightDrift.length} bytes`);
