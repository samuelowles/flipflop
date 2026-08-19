#!/usr/bin/env node
// Ponytail Graph — documentation drift detector.
//
// Re-derives ground truth from source and compares it against what the docs
// assert. Without this, the five projects return to their August 2026 state
// within a quarter: 38 documented divergences in Flip alone.
//
// stdlib only. Exit 0 = docs and code agree. Exit 1 = they do not.
//
// Usage:
//   node engine/drift.mjs           check, fail on divergence
//   node engine/drift.mjs --report  check, print everything, always exit 0

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT = process.argv.includes("--report");

const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const ARCH = read(join(ROOT, "docs", "ARCHITECTURE.md"));
const OPS = read(join(ROOT, "docs", "OPERATIONS.md"));
const PRD = read(join(ROOT, "docs", "PRD.md"));
const WRANGLER = read(join(ROOT, "workers", "wrangler.toml"));

// Known drift may be exempted for a bounded period so it does not block every
// unrelated branch. An exemption must carry an issue and an expiry; once the
// expiry passes it becomes a hard failure again and cannot be silently renewed.
const EXEMPT = (() => {
  const p = join(ROOT, "engine", "drift-exemptions.json");
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, "utf8")).exemptions || []; } catch { return []; }
})();

const findings = [];
const exempted = [];

const drift = (check, detail) => {
  const now = new Date();
  const hit = EXEMPT.find(
    (e) => e.check === check && detail.includes(e.match) && new Date(e.expires) > now
  );
  if (hit) { exempted.push({ check, detail, issue: hit.issue, expires: hit.expires }); return; }
  const stale = EXEMPT.find((e) => e.check === check && detail.includes(e.match));
  if (stale) findings.push({ check, detail: `${detail}  [EXEMPTION EXPIRED ${stale.expires} — see #${stale.issue}]` });
  else findings.push({ check, detail });
};

function walk(dir, re = /\.ts$/, skip = /\.test\.ts$/) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, re, skip));
    else if (re.test(entry) && !skip.test(entry)) out.push(full);
  }
  return out;
}

const srcFiles = walk(join(ROOT, "workers", "src"));
const srcText = srcFiles.map(read).join("\n");

// Captured fixture modules embed third-party URLs as data, never as call sites.
// Scanning them for outbound hosts produces noise, not findings.
const liveSrcText = srcFiles.filter((f) => !/fixtures?\.ts$/i.test(f)).map(read).join("\n");

// ---------------------------------------------------------------- 1. routes

// Ground truth: every route registered on the Hono app in index.ts.
const indexTs = read(join(ROOT, "workers", "src", "index.ts"));
const routes = [
  ...indexTs.matchAll(/app\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g),
].map((m) => `${m[1].toUpperCase()} ${m[2]}`);

const undocumentedRoutes = [...new Set(routes)].filter((r) => {
  const path = r.split(" ")[1];
  // The doc writes paths in a table; a literal substring match is enough and
  // avoids false positives from prose.
  return !ARCH.includes(path);
});
if (undocumentedRoutes.length) drift("routes", `not in ARCHITECTURE.md §3: ${undocumentedRoutes.join(", ")}`);

// ----------------------------------------------------------------- 2. tables

// Ground truth: every CREATE TABLE across the migration set, minus anything
// later dropped.
const migDir = join(ROOT, "workers", "migrations");
const migrations = existsSync(migDir)
  ? readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort()
  : [];

// Replay the migrations in order. A set-union of CREATEs minus a set of DROPs
// is wrong here: SQLite column changes are done by create-copy-drop-rename, so
// a naive subtraction deletes tables that were immediately recreated.
// Down-migrations live in these same files as commented-out blocks. Parsing
// without stripping comments treats every rollback as if it had run — which is
// how a first pass reported 4 tables instead of 14.
const stripSql = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

const created = new Set();
for (const file of migrations) {
  const sql = stripSql(read(join(migDir, file)));
  const ops = [
    ...[...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?(\w+)[`"']?/gi)]
      .map((m) => ({ i: m.index, op: "create", name: m[1] })),
    ...[...sql.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?[`"']?(\w+)[`"']?/gi)]
      .map((m) => ({ i: m.index, op: "drop", name: m[1] })),
    ...[...sql.matchAll(/ALTER\s+TABLE\s+[`"']?(\w+)[`"']?\s+RENAME\s+TO\s+[`"']?(\w+)[`"']?/gi)]
      .map((m) => ({ i: m.index, op: "rename", name: m[1], to: m[2] })),
  ].sort((a, b) => a.i - b.i);

  for (const o of ops) {
    if (o.op === "create") created.add(o.name);
    else if (o.op === "drop") created.delete(o.name);
    else { created.delete(o.name); created.add(o.to); }
  }
}
// Scratch tables from rebuild patterns, and Cloudflare's own ledger.
for (const t of [...created]) if (/_new$|_old$|_tmp$|^d1_|^sqlite_/.test(t)) created.delete(t);

const undocumentedTables = [...created].filter((t) => !ARCH.includes(t));
if (undocumentedTables.length) drift("schema", `tables not in ARCHITECTURE.md §5: ${undocumentedTables.join(", ")}`);

// ------------------------------------------------------------------- 3. cron

const cronBlock = WRANGLER.match(/crons\s*=\s*\[([^\]]+)\]/);
const crons = cronBlock ? [...cronBlock[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]) : [];
const undocumentedCrons = crons.filter((c) => {
  const short = c.replace(/\s*\*\s*\*\s*\*\s*$/, "").trim(); // "0 3 * * *" → "0 3"
  return !ARCH.includes(c) && !ARCH.includes(short);
});
if (undocumentedCrons.length) drift("cron", `schedules not in ARCHITECTURE.md §4.3: ${undocumentedCrons.join(", ")}`);

// ------------------------------------------------------------------ 4. flags

const varsBlock = WRANGLER.match(/\[vars\]([\s\S]*?)(?=\n\[|$)/);
const vars = varsBlock
  ? [...varsBlock[1].matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*["']?([^"'\n]*)["']?/gm)].map((m) => [m[1], m[2].trim()])
  : [];

for (const [name, value] of vars) {
  if (!ARCH.includes(name)) { drift("flags", `${name} is set in wrangler.toml and absent from ARCHITECTURE.md §2.2`); continue; }
  // Catch a flag whose documented value no longer matches the deployed one.
  // Match only the row where the flag is the FIRST cell — other rows merely
  // mention it in prose and would produce false positives.
  const row = ARCH.split("\n").find((l) => new RegExp(`^\\s*\\|\\s*\`?${name}\`?\\s*\\|`).test(l));
  if (row && value && !row.includes(value))
    drift("flags", `${name} = "${value}" in wrangler.toml; its ARCHITECTURE.md §2.2 row says otherwise`);
}

// -------------------------------------------------------------- 5. env vars

const envRefs = new Set([...srcText.matchAll(/env\??\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]));
const BINDINGS = new Set(["DB", "KV", "BILLS", "PARSE_QUEUE", "COMPARE_QUEUE", "NOTIFY_QUEUE", "RATE_LIMITER", "TEST_MIGRATIONS"]);
const undocumentedEnv = [...envRefs].filter((n) => !BINDINGS.has(n) && !OPS.includes(n) && !WRANGLER.includes(n));
if (undocumentedEnv.length) drift("env", `read by the Worker, absent from OPERATIONS.md §2: ${undocumentedEnv.join(", ")}`);

// ------------------------------------------------------- 6. external services

const hosts = new Set(
  [...liveSrcText.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map((m) => m[1].toLowerCase())
);
// Hosts that appear only as user-facing strings, never fetched: NZ retailer
// sites emitted as switch instructions, and Flip's own domains.
const IGNORE = /(^|\.)(flip\.nz|flipflop\.co\.nz)$|\.nz$|^rate-limiter$|^localhost$/;
const undocumentedHosts = [...hosts].filter((h) => !IGNORE.test(h) && !OPS.includes(h) && !PRD.includes(h) && !ARCH.includes(h));
if (undocumentedHosts.length) drift("processors", `outbound hosts not listed as processors: ${undocumentedHosts.join(", ")}`);

// --------------------------------------------------- 7. model identifiers

// DeepSeek retired deepseek-chat and deepseek-reasoner on 24 July 2026.
const RETIRED = ["deepseek-chat", "deepseek-reasoner"];
for (const model of RETIRED) {
  if (new RegExp(`["']${model}["']`).test(srcText))
    drift("models", `${model} was retired by the provider on 2026-07-24 — use deepseek-v4-pro`);
}

// ------------------------------------------------ 8. acceptance coverage

const manifestPath = join(ROOT, "acceptance", "manifest.json");
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(read(manifestPath));
  const covered = new Set((manifest.probes || []).map((p) => p.claim));
  const claims = [...PRD.matchAll(/^##+\s+(\d+(?:\.\d+)*)\s/gm)].map((m) => `PRD §${m[1]}`);
  const uncovered = claims.filter((c) => !covered.has(c));
  if (uncovered.length) drift("acceptance", `PRD sections with no probe: ${uncovered.join(", ")}`);
} else if (REPORT) {
  drift("acceptance", "acceptance/manifest.json does not exist yet");
}

// ------------------------------------------------------------------- report

if (REPORT) {
  console.log("\n  drift report — Flip\n");
  console.log(`  routes derived      ${new Set(routes).size}`);
  console.log(`  tables derived      ${created.size}`);
  console.log(`  crons derived       ${crons.length}`);
  console.log(`  flags derived       ${vars.length}`);
  console.log(`  env refs derived    ${envRefs.size}`);
  console.log(`  outbound hosts      ${hosts.size}`);
  console.log(`  migrations          ${migrations.length}\n`);
}

if (exempted.length) {
  console.log(`\n  ${exempted.length} exempted finding(s) — these still need fixing:`);
  for (const e of exempted) console.log(`    [${e.check}] ${e.detail}  → #${e.issue}, expires ${e.expires}`);
  console.log("");
}

if (findings.length === 0) {
  console.log(`drift OK — docs match code (${new Set(routes).size} routes, ${created.size} tables, ${crons.length} crons).`);
  process.exit(0);
}

console.error(`\n  DOCUMENTATION DRIFT (${findings.length})\n`);
for (const f of findings) console.error(`    [${f.check}] ${f.detail}`);
console.error(
  `\n  Either the code changed and the doc did not, or the doc is describing\n` +
  `  something that was never built. Fix whichever is wrong — do not silence\n` +
  `  this check.\n`
);
process.exit(REPORT ? 0 : 1);
