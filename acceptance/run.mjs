#!/usr/bin/env node
// acceptance/run.mjs — live acceptance probe runner (issue #284).
//
// Where the workers unit suite tests the code against its own assertions,
// these probes test the DEPLOYED product against docs/PRD.md: each probe is
// an executable proof of one numbered PRD claim, driven over HTTP against a
// staging deployment. Without a staging base URL they skip — loudly — and
// they never run against production. That refusal lives here, in the runner,
// so no individual probe can bypass it.
//
// stdlib only. Exit 0 = the run completed: skips and declared-but-unproven
// claims are a known, reported gap, not a failure. Exit 1 = a probe FAILED,
// the base URL points at production or an undeclared host, or the invocation
// was wrong.
//
// Usage:
//   node acceptance/run.mjs                run every implemented probe
//   node acceptance/run.mjs --probe <id>   run one probe

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ACCEPTANCE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(ACCEPTANCE, "manifest.json");

const die = (message) => {
  console.error(`acceptance: ${message}`);
  process.exit(1);
};

// ------------------------------------------------------------------- usage

const argv = process.argv.slice(2);
let only = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--probe" && i + 1 < argv.length) only = argv[++i];
  else die(`unexpected argument "${argv[i] || ""}" — usage: node acceptance/run.mjs [--probe <id>]`);
}

// -------------------------------------------------------- production refusal
//
// Refusing production is a safety property of the runner, not a convenience
// of the probes: nothing under probes/ is imported until the base URL has
// been cleared here, so no probe can opt out.

// flipflop.co.nz is where production is GOING (docs/ARCHITECTURE.md §1); the
// Worker actually serving production today is `flip-api` on workers.dev
// (workers/wrangler.toml declares no route). Both are denied — a deny list that
// only names the future domain leaves the live one reachable.
const PRODUCTION_HOSTS = [/(^|\.)flipflop\.co\.nz$/i, /^flip-api\.[^.]+\.workers\.dev$/i];
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Hosts the operator has declared to be staging, comma-separated. Production
// hosts are refused even if they appear here — the deny rule is absolute.
const declaredStaging = () =>
  new Set(
    (process.env.FLIP_ACCEPTANCE_STAGING_HOSTS || "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean)
  );

const baseUrl = (process.env.FLIP_ACCEPTANCE_BASE_URL || "").trim();

if (baseUrl) {
  let host;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    die(`FLIP_ACCEPTANCE_BASE_URL is not a valid URL: ${baseUrl}`);
  }
  if (PRODUCTION_HOSTS.some((re) => re.test(host)))
    die(`refusing to run — FLIP_ACCEPTANCE_BASE_URL host "${host}" is production. Probes never touch production.`);
  if (!LOCAL_HOSTS.has(host) && !declaredStaging().has(host))
    die(
      `refusing to run — "${host}" is not a known staging host. ` +
        `Declare it via FLIP_ACCEPTANCE_STAGING_HOSTS (production hosts can never be declared).`
    );
}

// ----------------------------------------------------------------- manifest

let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
} catch (e) {
  die(`cannot read manifest.json: ${e.message}`);
}
const entries = manifest.probes || [];
const implemented = entries.filter((p) => p.file);
const declared = entries.filter((p) => !p.file);

const selected = only === null ? implemented : entries.filter((p) => p.id === only);
if (only !== null && selected.length === 0) {
  die(
    `unknown probe id "${only}".\n` +
      `  runnable: ${implemented.map((p) => p.id).join(", ") || "(none)"}\n` +
      `  declared with no probe yet: ${declared.map((p) => p.id).join(", ") || "(none)"}`
  );
}

// ----------------------------------------------------------- probe context
//
// fetch is guarded here too: with no base URL configured it refuses every
// call outright, and with one it confines probes to that origin — a probe
// cannot reach past staging even by accident.

const origin = baseUrl ? new URL(baseUrl).origin : null;
const guardedFetch = (url, options) => {
  if (!origin) return Promise.reject(new Error("probe issued a network request but FLIP_ACCEPTANCE_BASE_URL is not set"));
  const target = new URL(url, origin);
  if (target.origin !== origin)
    return Promise.reject(new Error(`probe fetch refused — ${target.origin} is outside the staging origin ${origin}`));
  return fetch(target, options);
};

const ctx = {
  baseUrl: baseUrl || null,
  fetch: guardedFetch,
  log: (message) => console.log(`    ${message}`),
};

// --------------------------------------------------------------------- run

const tally = { pass: 0, fail: 0, skip: 0 };
const passedIds = new Set();

for (const entry of selected) {
  if (!entry.file) {
    tally.skip++;
    console.log(`SKIP  ${entry.id}  [${entry.claim}] — declared but not implemented (manifest file is null)`);
    continue;
  }
  let probe;
  try {
    probe = (await import(pathToFileURL(join(ACCEPTANCE, entry.file)).href)).default;
  } catch (e) {
    tally.fail++;
    console.log(`FAIL  ${entry.id}  [${entry.claim}] — cannot load ${entry.file}: ${e.message}`);
    continue;
  }
  if (probe.id !== entry.id) {
    tally.fail++;
    console.log(`FAIL  ${entry.id}  [${entry.claim}] — ${entry.file} exports id "${probe.id}", manifest says "${entry.id}"`);
    continue;
  }
  try {
    await probe.run(ctx);
    tally.pass++;
    passedIds.add(entry.id);
    console.log(`PASS  ${entry.id}  [${entry.claim}]`);
  } catch (e) {
    const reason = e && e.message ? e.message : String(e);
    if (e && e.skip === true) {
      tally.skip++;
      console.log(`SKIP  ${entry.id}  [${entry.claim}] — ${reason}`);
    } else {
      tally.fail++;
      console.log(`FAIL  ${entry.id}  [${entry.claim}] — ${reason}`);
    }
  }
}

// ---------------------------------------------------------------- coverage
//
// Printed on every run. The 22 declared-with-no-proof claims are the point:
// the manifest is an honest inventory, not a silencer.

console.log("");
console.log(
  `run summary: ${selected.length} probe(s) — ${tally.pass} pass, ${tally.fail} fail, ${tally.skip} skip`
);
console.log(
  `coverage: ${implemented.length}/${entries.length} PRD claims have an executable probe — ` +
    `${declared.length} declared with no proof`
);
if (declared.length) console.log(`  unproven: ${declared.map((p) => p.claim).join(", ")}`);

// -------------------------------------------------------- manifest write-back
//
// Only a PASS advances lastGreen, and only then is the file rewritten. A run
// with no passes leaves manifest.json byte-identical — the engine gate
// refuses a dirty tree.

if (passedIds.size > 0) {
  const stamp = new Date().toISOString();
  for (const entry of entries) if (passedIds.has(entry.id)) entry.lastGreen = stamp;
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

if (tally.fail > 0) {
  console.error(`\nacceptance: ${tally.fail} probe(s) FAILED`);
  // exitCode, not process.exit: probes have done network I/O by now, and a
  // hard exit racing the open keep-alive sockets aborts libuv's teardown
  // (observed as a failed assertion on Windows) instead of exiting cleanly.
  process.exitCode = 1;
}
