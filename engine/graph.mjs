#!/usr/bin/env node
// Ponytail Graph — the deterministic control plane.
//
// This file owns the parts a model must never decide:
//   which issue is next, whether the gate passed, and whether anything merges.
//
// Adapted from the Wondura epic-loop, generalised to a dependency graph.
// stdlib only. GitHub issue and PR state IS the state store.
//
// Usage:
//   node engine/graph.mjs next [EPIC]        → JSON: the next actionable issue
//   node engine/graph.mjs list [EPIC]        → human-readable graph state
//   node engine/graph.mjs start <issue>      → create and check out the branch
//   node engine/graph.mjs merge <branch>     → run the gate, then merge (or stop)
//   node engine/graph.mjs status             → run summary from the ledger

import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const EPIC_DEFAULT = "E-F";
const MERGE_MODE = process.env.MERGE_MODE || "pr";   // "pr" = never merge  |  "auto" = merge when the gate passes
const MAIN = "master";

const sh = (cmd) => execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const run = (cmd) => { console.error(`$ ${cmd}`); execSync(cmd, { stdio: "inherit" }); };
const die = (msg) => { console.error(`graph: ${msg}`); process.exit(1); };
const out = (v) => process.stdout.write(JSON.stringify(v, null, 2) + "\n");

const REPO = (() => {
  try {
    const url = sh("git remote get-url origin").trim();
    const m = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    return `${m[1]}/${m[2]}`;
  } catch { return "samuelowles/flipflop"; }
})();

// ------------------------------------------------------------------ helpers

const epicId = (v = EPIC_DEFAULT) => {
  const id = String(v || EPIC_DEFAULT).trim().toUpperCase();
  if (!/^E-[A-Z0-9]+$/.test(id)) die(`invalid epic: ${v} (expected e.g. E-F)`);
  return id;
};
const epicLabel = (v) => `epic:${epicId(v)}`;

const names = (issue) => (issue.labels || []).map((l) => l.name);

// Labels that mean "not this loop's work", for four different reasons.
// `deferred` is the repo's existing "approved to defer until the core loop
// works" label — without it here, the selector happily offers deferred work
// (Outlook, which docs/PRD.md:141 puts out of scope for beta and launch) as
// the next thing to build.
const NOT_BUILDABLE = ["tracker/do-not-build", "status:superseded", "blocked:external", "deferred"];
export const buildable = (issue) => !names(issue).some((n) => NOT_BUILDABLE.includes(n));

// Two issue-body dialects declare dependencies, and both must parse:
//
//   Blocked by: #12, #13          engine-seeded issues — inline
//   ## Blocked by                 the product backlog — a heading, list below
//   #13, #14, #15
//   ## Blocks                     <- must NOT be swallowed: it is the inverse
//
// Reading only the matched line (the original behaviour) returned zero
// blockers for every heading-style issue, so the loop would happily start
// work whose dependencies were still open.
export const blockers = (body) => {
  const lines = (body || "").split("\n");
  const start = lines.findIndex((l) => /blocked by/i.test(l));
  if (start === -1) return [];

  // Continuation lines, up to the next blank line or markdown heading. "#13"
  // is not a heading — a heading needs whitespace after its hashes — which is
  // what keeps the issue references and the "## Blocks" section apart.
  const block = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    if (!lines[i].trim() || /^\s*#{1,6}\s/.test(lines[i])) break;
    block.push(lines[i]);
  }

  const text = block.join(" ");
  if (/\bnone\b/i.test(text)) return [];
  return [...new Set([...text.matchAll(/#(\d+)/g)].map((m) => Number(m[1])))];
};

export const slug = (title) =>
  title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").slice(0, 6).join("-");

// Files an issue declares it will touch. Used for the conflict guard and for
// deciding whether a change can reach production.
export const declaredFiles = (body) => {
  const m = (body || "").match(/^Files:\s*(.+)$/mi);
  return m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
};

const allStates = () => {
  const states = new Map();
  const issues = JSON.parse(sh(`gh issue list --repo ${REPO} --state all --limit 500 --json number,state`));
  for (const i of issues) states.set(i.number, i.state);
  return states;
};

const children = (epic) =>
  JSON.parse(
    sh(`gh issue list --repo ${REPO} --label ${epicLabel(epic)} --state all --limit 200 --json number,title,state,url,body,labels`)
  );

export const pickActionable = (issues, states) =>
  issues
    .filter((i) => i.state === "OPEN")
    .filter(buildable)
    .filter((i) => blockers(i.body).every((b) => states.get(b) === "CLOSED"))
    .sort((a, b) => a.number - b.number);

// `gate:human` issues are unblocked and buildable — they are simply not the
// loop's to start. They must therefore stay in `list` (an operator needs to
// see them) while being kept out of `next`.
//
// Without this split `next` returns the lowest-numbered actionable issue
// whatever its labels, so a human-gated issue at the front of the epic is
// handed back on every call and the loop cannot advance past it. The
// workaround was a hand-maintained skip-list in the run prompt, which makes
// the selector advisory rather than authoritative — the opposite of what a
// deterministic control plane is for.
export const partitionByGate = (ready) => ({
  auto: ready.filter((i) => !names(i).includes("gate:human")),
  gated: ready.filter((i) => names(i).includes("gate:human")),
});

// ---------------------------------------------------------------- commands

function next(epic) {
  const issues = children(epic);
  const open = issues.filter((i) => i.state === "OPEN").filter(buildable);
  if (open.length === 0) return out({ done: true, reason: `no open buildable issues in ${epicLabel(epic)}` });

  const ready = pickActionable(issues, allStates());
  if (ready.length === 0)
    return out({ blocked: true, reason: "all open issues are blocked", open: open.map((i) => i.number) });

  const { auto, gated } = partitionByGate(ready);
  if (auto.length === 0)
    return out({
      done: true,
      reason: "nothing left that may be started unattended",
      humanGated: gated.map((i) => i.number),
      open: open.map((i) => i.number),
    });

  const i = auto[0];
  const labels = names(i);
  out({
    number: i.number,
    title: i.title,
    url: i.url,
    slug: slug(i.title),
    branch: `glm/issue-${i.number}-${slug(i.title)}`,
    radius: labels.find((l) => l.startsWith("radius:")) || "radius:small",
    tier: labels.find((l) => l.startsWith("tier:")) || "tier:standard",
    humanGate: false, // `next` never returns a gated issue; `start` refuses one too
    files: declaredFiles(i.body),
    // Waiting on a person, not on the loop — surfaced so a run report can say
    // what is parked rather than silently omitting it.
    humanGated: gated.map((i) => i.number),
    remaining: auto.length,
  });
}

function list(epic) {
  const issues = children(epic);
  const states = allStates();
  console.log(`\n  ${epicLabel(epic)} — ${REPO}\n`);
  for (const i of issues.sort((a, b) => a.number - b.number)) {
    const openBlockers = blockers(i.body).filter((b) => states.get(b) !== "CLOSED");
    const l = names(i);
    const tag =
      i.state !== "OPEN" ? "done"
      : !buildable(i) ? "do not build"
      : l.includes("gate:human") ? "HUMAN GATE"
      : openBlockers.length ? `blocked by ${openBlockers.map((n) => "#" + n).join(",")}`
      : "ACTIONABLE";
    console.log(`  #${String(i.number).padEnd(4)} ${tag.padEnd(24)} ${i.title}`);
  }
  console.log("");
}

function start(issueNumber) {
  const n = Number(issueNumber);
  if (!n) die("usage: graph.mjs start <issue-number>");
  const issue = JSON.parse(sh(`gh issue view ${n} --repo ${REPO} --json number,title,body,labels`));

  if (names(issue).includes("gate:human"))
    die(`#${n} is labelled gate:human — it must not be started unattended. Park it and report.`);

  const states = allStates();
  const open = blockers(issue.body).filter((b) => states.get(b) !== "CLOSED");
  if (open.length) die(`#${n} is blocked by ${open.map((x) => "#" + x).join(", ")}`);

  const branch = `glm/issue-${n}-${slug(issue.title)}`;
  run(`git fetch origin ${MAIN} --quiet`);
  run(`git checkout ${MAIN}`);
  run(`git pull --ff-only origin ${MAIN}`);
  run(`git checkout -b ${branch}`);
  out({ branch, issue: n, title: issue.title });
}

function merge(branch) {
  if (!branch) die("usage: graph.mjs merge <branch>");
  if (branch === MAIN || branch === "main") die("refusing to merge the trunk into itself");
  if (!/^glm\/issue-\d+-[a-z0-9-]+$/.test(branch)) die(`unsafe branch name: ${branch}`);

  const issue = Number((branch.match(/issue-(\d+)-/) || [])[1]);
  if (!issue) die(`cannot derive an issue number from ${branch}`);

  // 1. The gate. Un-foolable, deterministic, no model involved.
  console.error("\n--- gate ---");
  try {
    execSync(`node engine/gate.mjs ${branch}`, { stdio: "inherit" });
  } catch {
    die("gate failed — fix on the branch, push, and re-run merge");
  }

  // 2. Production-reachability check. Flip deploys to production on merge to
  //    master, so a change that touches runtime code must not merge unattended.
  const changed = sh(`git diff --name-only origin/${MAIN}...HEAD`).trim().split("\n").filter(Boolean);
  const runtime = changed.filter((f) => /^(workers\/src|python\/(?!tests)|workers\/migrations)/.test(f));

  if (MERGE_MODE === "pr") {
    console.error(`\ngraph: MERGE_MODE=pr — opening the PR and stopping. Nothing is merged, nothing deploys.`);
    ensurePr(branch, issue);
    out({ merged: false, reason: "MERGE_MODE=pr", pr: prUrl(branch), issue });
    return;
  }

  if (runtime.length) {
    console.error(`\ngraph: this branch touches runtime code and would deploy to production on merge:`);
    for (const f of runtime) console.error(`  ${f}`);
    ensurePr(branch, issue);
    out({ merged: false, reason: "touches-production", files: runtime, pr: prUrl(branch), issue });
    return;
  }

  ensurePr(branch, issue);
  run(`gh pr merge ${branch} --repo ${REPO} --squash --delete-branch`);
  run(`git checkout ${MAIN}`);
  run(`git pull --ff-only origin ${MAIN}`);
  out({ merged: true, issue, branch });
}

function ensurePr(branch, issue) {
  run(`git push -u origin ${branch}`);
  const existing = JSON.parse(sh(`gh pr list --repo ${REPO} --head ${branch} --state open --json number,url`));
  if (existing.length === 0) {
    const title = sh(`git log -1 --pretty=%s`).trim();
    run(`gh pr create --repo ${REPO} --base ${MAIN} --head ${branch} --title "${title.replace(/"/g, "'")}" --body "Fixes #${issue}"`);
  } else if (existing.length > 1) {
    die(`${existing.length} open PRs for ${branch} — resolve by hand`);
  }
}

const prUrl = (branch) => {
  const prs = JSON.parse(sh(`gh pr list --repo ${REPO} --head ${branch} --state open --json url`));
  return prs[0]?.url || null;
};

function status() {
  try {
    execSync("node engine/ledger.mjs report", { stdio: "inherit" });
  } catch {
    console.log("no ledger entries yet");
  }
}

// -------------------------------------------------------------------- entry
//
// Guarded so the selector functions above can be imported and tested. Without
// this, `import` alone falls through to `default` and exits 1, which is why
// the exported helpers had no tests despite being exported for them.

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , cmd, arg] = process.argv;
  switch (cmd) {
    case "next": next(arg); break;
    case "list": list(arg); break;
    case "start": start(arg); break;
    case "merge": merge(arg); break;
    case "status": status(); break;
    default:
      console.log("usage: graph.mjs next|list [EPIC] | start <issue> | merge <branch> | status");
      process.exit(1);
  }
}
