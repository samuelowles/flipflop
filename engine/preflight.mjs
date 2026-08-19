#!/usr/bin/env node
// Ponytail Graph — preflight. Run this BEFORE the loop, every time.
// Refuses to green-light a run when anything the engine depends on is missing
// or when the repo is in a state where a diff cannot be trusted.
//
// stdlib only. Exit 0 = safe to run. Exit 1 = do not run.

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const sh = (cmd, opts = {}) =>
  execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const trySh = (cmd) => { try { return sh(cmd); } catch { return null; } };

const results = [];
const check = (name, fn, { fatal = true, fix = null } = {}) => {
  let ok = false, detail = "";
  try { const r = fn(); ok = r === true || (r && r.ok); detail = (r && r.detail) || ""; }
  catch (e) { ok = false; detail = e.message.split("\n")[0]; }
  results.push({ name, ok, detail, fatal, fix });
};

// ---------------------------------------------------------------- environment

check("git available", () => !!trySh("git --version"));

check("gh CLI available", () => {
  const v = trySh("gh --version");
  return { ok: !!v, detail: v ? v.split("\n")[0] : "install from cli.github.com" };
}, { fix: "winget install GitHub.cli   (then: gh auth login)" });

check("gh authenticated", () => {
  const out = trySh("gh auth status 2>&1");
  return { ok: !!out && /Logged in/i.test(out), detail: out ? out.split("\n").find(l => /Logged in/i.test(l)) || "" : "not logged in" };
}, { fix: "gh auth login" });

check("node >= 20", () => {
  const major = Number(process.versions.node.split(".")[0]);
  return { ok: major >= 20, detail: `v${process.versions.node}` };
});

// ---------------------------------------------------------------------- repo

check("inside the Flip repo", () => {
  const remote = trySh("git remote get-url origin") || "";
  return { ok: /flipflop/.test(remote), detail: remote };
});

check("on master", () => {
  const b = trySh("git branch --show-current");
  return { ok: b === "master", detail: `on '${b}'` };
}, { fix: "git checkout master && git pull" });

check("up to date with origin/master", () => {
  trySh("git fetch origin master --quiet");
  const counts = trySh("git rev-list --left-right --count origin/master...HEAD") || "0\t0";
  const [behind, ahead] = counts.split(/\s+/).map(Number);
  return { ok: behind === 0 && ahead === 0, detail: `behind ${behind}, ahead ${ahead}` };
}, { fix: "git pull --ff-only origin master" });

// The single most important check. A tree full of CRLF churn makes every diff
// unreadable, which disables the review node entirely.
check("working tree clean", () => {
  const dirty = (trySh("git status --porcelain") || "").split("\n").filter(Boolean);
  return { ok: dirty.length === 0, detail: `${dirty.length} dirty path(s)` };
}, { fix: "run: node engine/normalise-line-endings.mjs   (one-off, see engine/README.md)" });

check(".gitattributes normalises line endings", () => {
  if (!existsSync(".gitattributes")) return { ok: false, detail: "missing" };
  const s = readFileSync(".gitattributes", "utf8");
  return { ok: /^\*\s+text=auto/m.test(s), detail: /text=auto/.test(s) ? "present" : "no '* text=auto' rule" };
}, { fix: "the foundations epic adds this; see engine/README.md §1" });

// ------------------------------------------------------------------ tooling

check("workers deps installed", () => existsSync("workers/node_modules"), { fix: "cd workers && npm ci" });

check("gate script present", () => existsSync("engine/gate.mjs"));
check("graph script present", () => existsSync("engine/graph.mjs"));
check("drift script present", () => existsSync("engine/drift.mjs"));

check("glm-delegate configured for GLM-5.3", () => {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  // The plugin reads user overrides from ~/.config/glm-delegate/config.json.
  // ~/.glm-delegate is stateDir — jobs and worktrees, never config.
  const cfgPath = `${home}/.config/glm-delegate/config.json`;
  if (!existsSync(cfgPath)) return { ok: false, detail: "config.json not found" };
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const primary = cfg?.models?.primary || "";
  return { ok: primary === "glm-5.3", detail: `primary = ${primary || "unset"}` };
}, { fatal: false, fix: 'set models.primary and models.standard to "glm-5.3" in ~/.glm-delegate/config.json' });

// ------------------------------------------------------------------- safety

check("no production deploy path from this run", () => {
  // Flip deploys to production on merge to master via Workers Builds.
  // MERGE_MODE=pr means the engine never merges, so nothing can deploy.
  const mode = process.env.MERGE_MODE || "pr";
  return { ok: true, detail: `MERGE_MODE=${mode}${mode === "pr" ? " (no auto-merge, no deploy)" : " ** MERGES AND DEPLOYS **"}` };
}, { fatal: false });

check("epic label exists", () => {
  const out = trySh(`gh label list --limit 200 --json name -q ".[].name"`) || "";
  const has = out.split("\n").includes("epic:E-F");
  return { ok: has, detail: has ? "epic:E-F found" : "epic:E-F not found" };
}, { fix: "run: node engine/seed-foundations.mjs" });

// ------------------------------------------------------------------- report

const pad = (s, n) => (s + " ".repeat(n)).slice(0, n);
console.log("\n  Ponytail Graph — preflight (Flip)\n");
for (const r of results) {
  const mark = r.ok ? "  ok  " : r.fatal ? " FAIL " : " warn ";
  console.log(`${mark} ${pad(r.name, 42)} ${r.detail}`);
}

const fatals = results.filter((r) => !r.ok && r.fatal);
const warns = results.filter((r) => !r.ok && !r.fatal);

if (warns.length) {
  console.log("\n  Warnings:");
  for (const w of warns) console.log(`    ${w.name}${w.fix ? `\n      fix: ${w.fix}` : ""}`);
}

if (fatals.length) {
  console.log("\n  Blocked. Fix these before starting:\n");
  for (const f of fatals) console.log(`    ${f.name}${f.fix ? `\n      fix: ${f.fix}` : ""}`);
  console.log("");
  process.exit(1);
}

console.log("\n  Preflight passed. Safe to start the loop.\n");
