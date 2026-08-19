#!/usr/bin/env node
// Ponytail Graph — the ledger.
//
// Append-only record of what the engine did, what it cost, and which model did
// it. This is the governor's only data source and the only honest answer to
// "is the split actually 15-20% Anthropic?".
//
// Usage:
//   node engine/ledger.mjs record '<json>'   append one row
//   node engine/ledger.mjs report            summary + model share
//   node engine/ledger.mjs check             exit 1 if the band is breached

import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, ".engine");
const FILE = join(DIR, "ledger.jsonl");

// The band, as designed. Anthropic does judgement; GLM does volume.
const BAND = { min: 0.15, max: 0.20 };
const ESCALATION_ALERT = 0.25;
const WINDOW = 50; // rolling issues

const rows = () => {
  if (!existsSync(FILE)) return [];
  return readFileSync(FILE, "utf8").split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
};

function record(payload) {
  if (!payload) { console.error("usage: ledger.mjs record '<json>'"); process.exit(1); }
  const row = { at: new Date().toISOString(), ...JSON.parse(payload) };
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  appendFileSync(FILE, JSON.stringify(row) + "\n");
  console.log("recorded");
}

const tokens = (r) => (r.tokensIn || 0) + (r.tokensOut || 0);
const isAnthropic = (r) => /opus|sonnet|haiku|fable/i.test(r.model || "");
const isGlm = (r) => /glm/i.test(r.model || "");

export const share = (data) => {
  const aRows = data.filter(isAnthropic);
  const gRows = data.filter(isGlm);
  const anthropic = aRows.reduce((n, r) => n + tokens(r), 0);
  const glm = gRows.reduce((n, r) => n + tokens(r), 0);
  const total = anthropic + glm;
  return {
    anthropic, glm, total,
    ratio: total ? anthropic / total : 0,

    // The orchestrator cannot read its own token usage, so its rows are
    // routinely recorded as zeroes with `estimated: true` (engine/LAUNCH.md
    // says to do exactly that rather than invent figures). That makes the
    // Anthropic side structurally 0, and a ratio of 0 is NOT a low ratio --
    // it is an absent measurement. Conflating the two made the governor
    // advise "below 15%, the system is under-reviewing, re-enable review on
    // trivial issues" from no data at all: a governor biased towards
    // spending more of the expensive model, which is the one thing it exists
    // to prevent.
    measurable: anthropic > 0 && glm > 0,
    unmeasured: aRows.filter((r) => tokens(r) === 0).length,

    // Needs no token counts, so it stays honest when the split does not.
    // Coarser than tokens, but a real signal: how much of the work was
    // decided by the expensive model rather than typed by the cheap one.
    nodes: { anthropic: aRows.length, glm: gRows.length },
  };
};

function report() {
  const data = rows();
  if (!data.length) return console.log("ledger empty — no runs recorded yet");

  const issues = [...new Set(data.map((r) => r.issue).filter((n) => n !== undefined && n !== null))];
  const recent = data.filter((r) => issues.slice(-WINDOW).includes(r.issue));
  const s = share(recent);

  const outcomes = data.reduce((acc, r) => { if (r.outcome) acc[r.outcome] = (acc[r.outcome] || 0) + 1; return acc; }, {});
  const escalations = data.filter((r) => r.node === "ESCALATE").length;
  const gateRuns = data.filter((r) => r.node === "GATE").length;
  const escRate = gateRuns ? escalations / gateRuns : 0;

  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  const k = (n) => `${(n / 1000).toFixed(1)}k`;

  console.log(`\n  Ponytail Graph — run report\n`);
  console.log(`  issues touched      ${issues.length}`);
  console.log(`  rows               ${data.length}`);
  console.log(`  outcomes           ${Object.entries(outcomes).map(([k2, v]) => `${k2}=${v}`).join("  ") || "none"}`);
  console.log(`\n  model share (last ${Math.min(issues.length, WINDOW)} issues)`);
  if (s.measurable) {
    console.log(`    Anthropic        ${k(s.anthropic)} tokens   ${pct(s.ratio)}`);
    console.log(`    GLM              ${k(s.glm)} tokens   ${pct(1 - s.ratio)}`);
    console.log(`    band             ${pct(BAND.min)} – ${pct(BAND.max)}   ${s.ratio >= BAND.min && s.ratio <= BAND.max ? "within" : "** OUT OF BAND **"}`);
  } else {
    console.log(`    Anthropic        ${k(s.anthropic)} tokens   (${s.unmeasured} row(s) carry no count)`);
    console.log(`    GLM              ${k(s.glm)} tokens`);
    console.log(`    band             NOT MEASURABLE — do not read a split from this`);
  }
  console.log(`\n  node share         Anthropic ${s.nodes.anthropic} · GLM ${s.nodes.glm}   (always measurable)`);
  console.log(`\n  escalation rate    ${pct(escRate)}   ${escRate > ESCALATION_ALERT ? "** ABOVE 25% — investigate **" : "ok"}`);
  console.log("");
}

function check() {
  const data = rows();
  if (data.length < 10) { console.log("ledger: too few rows to judge the band"); process.exit(0); }
  const s = share(data);
  const escalations = data.filter((r) => r.node === "ESCALATE").length;
  const gateRuns = data.filter((r) => r.node === "GATE").length || 1;
  const escRate = escalations / gateRuns;

  if (!s.measurable) {
    console.log(
      `ledger: band NOT MEASURABLE - ${s.unmeasured} Anthropic row(s) carry no token count. ` +
      `Node share: Anthropic ${s.nodes.anthropic}, GLM ${s.nodes.glm}. ` +
      `Judging the band from this reports 0% Anthropic and advises more review, which is backwards.`
    );
    process.exit(0);
  }

  const problems = [];
  if (s.ratio > BAND.max) problems.push(`Anthropic share ${(s.ratio * 100).toFixed(1)}% is above ${BAND.max * 100}% — skip review on small-radius issues, or route escalations to GLM at max effort`);
  if (s.ratio < BAND.min) problems.push(`Anthropic share ${(s.ratio * 100).toFixed(1)}% is below ${BAND.min * 100}% — the system is under-reviewing; re-enable review on trivial issues`);
  if (escRate > ESCALATION_ALERT) problems.push(`escalation rate ${(escRate * 100).toFixed(1)}% is above 25% — a cascade that escalates most of its traffic costs more than no routing at all`);

  if (!problems.length) { console.log(`ledger: within band (${(s.ratio * 100).toFixed(1)}% Anthropic, ${(escRate * 100).toFixed(1)}% escalation)`); process.exit(0); }
  console.error("\n  GOVERNOR\n");
  for (const p of problems) console.error(`    ${p}`);
  console.error("");
  process.exit(1);
}

// Guarded so share() can be imported by the control-plane tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , cmd, arg] = process.argv;
  if (cmd === "record") record(arg);
  else if (cmd === "report") report();
  else if (cmd === "check") check();
  else { console.log("usage: ledger.mjs record '<json>' | report | check"); process.exit(1); }
}
