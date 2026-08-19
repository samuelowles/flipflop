#!/usr/bin/env node
// Ponytail Graph — the merge gate.
//
// This is the reason a cheap model can be trusted with the keyboard. It is a
// script, not a model. It refuses to pass unless every condition below holds.
//
// Exit 0 = the branch may merge. Exit 1 = it may not.
//
// Usage: node engine/gate.mjs <branch>

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

const MAIN = "master";
const branch = process.argv[2];
if (!branch) { console.error("usage: gate.mjs <branch>"); process.exit(1); }

const sh = (cmd) => execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const trySh = (cmd) => { try { return sh(cmd); } catch { return null; } };

const failures = [];
const fail = (msg) => failures.push(msg);
const step = (name, fn) => {
  process.stderr.write(`  ${name} ... `);
  try { fn(); process.stderr.write("ok\n"); }
  catch (e) { process.stderr.write("FAIL\n"); fail(`${name}: ${e.message.split("\n")[0]}`); }
};

// Files the engine must never modify. Changing the gate, the CI config or a
// test config on a feature branch is how an autonomous system talks itself
// into passing.
const PROTECTED = [
  "engine/gate.mjs",
  "engine/graph.mjs",
  "engine/drift.mjs",
  "engine/preflight.mjs",
  ".github/workflows/ci.yml",
  "workers/tsconfig.json",
  "workers/vitest.config.ts",
  "workers/vitest.e2e.config.ts",
  "workers/eslint.config.js",
  ".gitattributes",
];

const SECRET_PATTERNS = [/^\.env/, /\.dev\.vars/, /^\.mcp\.json$/, /secrets?\.json$/i];

console.error(`\n  gate: ${branch}\n`);

// ------------------------------------------------------------ repo integrity

step("working tree clean", () => {
  const dirty = (trySh("git status --porcelain") || "").split("\n").filter(Boolean);
  if (dirty.length) throw new Error(`${dirty.length} uncommitted path(s)`);
});

step("branch is not the trunk", () => {
  if (branch === MAIN || branch === "main" || branch === "master") throw new Error("refusing");
});

step("branch name is safe", () => {
  if (!/^glm\/issue-\d+-[a-z0-9-]+$/.test(branch)) throw new Error(`unexpected shape: ${branch}`);
});

step("local branch matches pushed branch", () => {
  const local = sh("git rev-parse HEAD");
  const remote = trySh(`git rev-parse origin/${branch}`);
  if (!remote) throw new Error("branch not pushed");
  if (local !== remote) throw new Error("local and origin differ — push first");
});

step("PR exists, targets the trunk, and closes the issue", () => {
  const issue = Number((branch.match(/issue-(\d+)-/) || [])[1]);
  const prs = JSON.parse(sh(`gh pr list --head ${branch} --state open --json number,baseRefName,body`));
  if (prs.length === 0) throw new Error("no open PR");
  if (prs.length > 1) throw new Error(`${prs.length} open PRs`);
  const pr = prs[0];
  if (pr.baseRefName !== MAIN) throw new Error(`base is ${pr.baseRefName}, expected ${MAIN}`);
  if (!new RegExp(`(Fixes|Closes|Resolves)\\s+#${issue}\\b`, "i").test(pr.body || ""))
    throw new Error(`PR body must contain "Fixes #${issue}"`);
});

// ------------------------------------------------------------------- changes

const changed = sh(`git diff --name-only origin/${MAIN}...HEAD`).split("\n").filter(Boolean);

step("no protected file modified", () => {
  const hits = changed.filter((f) => PROTECTED.includes(f));
  if (hits.length) throw new Error(`protected: ${hits.join(", ")}`);
});

step("gate script unchanged on this branch", () => {
  // Belt and braces: compare the gate here against the trunk, as git blobs.
  //
  // This previously hashed readFileSync (raw bytes, trailing newline intact)
  // against sh("git show ..."), and sh() trims. The two could never be equal,
  // so this step failed on every branch and the gate could never pass. Git's
  // own object id is the honest comparison: it is computed identically on
  // both sides and applies the .gitattributes eol filter, so a CRLF working
  // copy on Windows does not read as a modified gate either.
  const here = sh("git hash-object engine/gate.mjs");
  const trunk = sh(`git rev-parse origin/${MAIN}:engine/gate.mjs`);
  if (here !== trunk) throw new Error("gate.mjs differs from the trunk");
});

step("no secret files touched", () => {
  const hits = changed.filter((f) => SECRET_PATTERNS.some((p) => p.test(f)));
  if (hits.length) throw new Error(`secret-bearing: ${hits.join(", ")}`);
});

step("no test file deleted", () => {
  const deleted = sh(`git diff --diff-filter=D --name-only origin/${MAIN}...HEAD`).split("\n").filter(Boolean);
  const tests = deleted.filter((f) => /\.(test|spec)\.[tjm]sx?$/.test(f) || /^python\/tests\//.test(f));
  if (tests.length) throw new Error(`deleted: ${tests.join(", ")}`);
});

step("assertion count did not fall", () => {
  // A cheap, effective guard against a model weakening a suite to pass.
  const countIn = (ref) => {
    const files = sh(`git ls-tree -r --name-only ${ref}`)
      .split("\n")
      // engine/*.test.mjs counts too: the control-plane tests guard the issue
      // selector, and leaving them out of the ratchet would let a branch delete
      // the checks on the very code that decides what gets built.
      .filter((f) => /\.(test|spec)\.(ts|mjs)$/.test(f) || /^python\/tests\/.*\.py$/.test(f));
    let n = 0;
    for (const f of files) {
      const src = trySh(`git show ${ref}:${f}`) || "";
      n += (src.match(/\b(expect|assert|assertEqual|assertRaises)\s*\(/g) || []).length;
    }
    return n;
  };
  const before = countIn(`origin/${MAIN}`);
  const after = countIn("HEAD");
  if (after < before) throw new Error(`${before} → ${after}`);
  process.stderr.write(`(${before} → ${after}) `);
});

step("no whitespace errors", () => { sh(`git diff --check origin/${MAIN}...HEAD`); });

// The selector and the dependency parser decide what gets built. They are
// stdlib-only and run in under a second, so there is no reason to gate them
// behind a path filter the way the workers and python steps are.
step("control-plane tests", () => { sh("node --test engine/engine.test.mjs"); });

// -------------------------------------------------------------------- build

const touched = (re) => changed.some((f) => re.test(f));

step("env docs in sync", () => { sh("npm --prefix workers run check:env-docs"); });

if (touched(/^workers\//)) {
  step("typecheck (workers)", () => { sh("npm --prefix workers run typecheck"); });
  step("lint (workers)", () => { sh("npm --prefix workers run lint"); });
  step("unit tests (workers)", () => { sh("npm --prefix workers test"); });
  step("e2e tests (workers)", () => { sh("npm --prefix workers run test:e2e"); });
  step("deploy dry-run", () => { sh("npx --prefix workers wrangler deploy --dry-run --cwd workers"); });
} else {
  process.stderr.write("  workers untouched — skipping workers build steps\n");
}

if (touched(/^python\//)) {
  step("pytest", () => { sh("pytest python/ -q"); });
  step("parser eval", () => { sh("python scripts/eval_parser.py"); });
} else {
  process.stderr.write("  python untouched — skipping python steps\n");
}

// -------------------------------------------------------------------- drift

step("documentation drift", () => {
  if (!existsSync("engine/drift.mjs")) throw new Error("drift.mjs missing");
  sh("node engine/drift.mjs");
});

// ------------------------------------------------------------------- report

if (failures.length) {
  console.error(`\n  GATE FAILED (${failures.length})\n`);
  for (const f of failures) console.error(`    ${f}`);
  console.error("");
  process.exit(1);
}

console.error("\n  gate passed\n");
