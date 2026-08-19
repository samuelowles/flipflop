// Tests for the parts of the control plane that decide what gets built.
//
// These functions pick the next issue and judge whether its dependencies are
// met. A silent wrong answer here does not crash — it starts the wrong work,
// or starts blocked work, and nothing downstream notices. Both bugs this file
// pins down shipped precisely because there was no test here.
//
// stdlib only: node --test engine/

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";

import { blockers, slug, declaredFiles, pickActionable } from "./graph.mjs";

// ------------------------------------------------------------------ blockers
//
// Two dialects exist in the repo and both are load-bearing.

test("blockers: inline dialect, none", () => {
  assert.deepEqual(blockers("Files: acceptance/\nBlocked by: none"), []);
});

test("blockers: inline dialect, references", () => {
  assert.deepEqual(blockers("Blocked by: #12, #13"), [12, 13]);
});

test("blockers: heading dialect reads the lines below the heading", () => {
  // The product backlog's shape (issue #89). Reading only the heading line —
  // the original behaviour — returned [] and made every blocked issue look
  // actionable.
  const body = ["## Spec sections", "ARCHITECTURE /public/", "", "## Blocked by", "#13, #14, #15, #16", "## Blocks", "10.02-10.08", "", "parent: #10"].join("\n");
  assert.deepEqual(blockers(body), [13, 14, 15, 16]);
});

test("blockers: the '## Blocks' section is not swallowed", () => {
  // "## Blocks" is the inverse relation. Numbers under it must never be read
  // as blockers, and "parent: #10" must not leak in either.
  const body = ["## Blocked by", "#15", "## Blocks", "#900, #901", "", "parent: #10"].join("\n");
  assert.deepEqual(blockers(body), [15]);
});

test("blockers: heading with an empty section", () => {
  // Issue #133 — the heading is present with nothing under it.
  assert.deepEqual(blockers("## Spec reference\n- AI_RULES\n\n## Blocked by\n"), []);
});

test("blockers: no declaration at all", () => {
  assert.deepEqual(blockers("## Goal\nDo the thing."), []);
});

test("blockers: empty and missing bodies", () => {
  assert.deepEqual(blockers(""), []);
  assert.deepEqual(blockers(null), []);
  assert.deepEqual(blockers(undefined), []);
});

test("blockers: repeats collapse to one entry", () => {
  assert.deepEqual(blockers("Blocked by: #7, #7, #8"), [7, 8]);
});

test("blockers: 'none' wins over stray references on the same line", () => {
  assert.deepEqual(blockers("Blocked by: none (was #4)"), []);
});

// -------------------------------------------------------------- pickActionable

const issue = (number, body, { state = "OPEN", labels = [] } = {}) => ({
  number,
  title: `issue ${number}`,
  state,
  body,
  labels: labels.map((name) => ({ name })),
});

test("pickActionable: an issue whose blocker is open is withheld", () => {
  const issues = [issue(89, "## Blocked by\n#15")];
  const states = new Map([[15, "OPEN"]]);
  assert.deepEqual(pickActionable(issues, states), []);
});

test("pickActionable: the same issue is released once its blocker closes", () => {
  const issues = [issue(89, "## Blocked by\n#15")];
  const states = new Map([[15, "CLOSED"]]);
  assert.deepEqual(pickActionable(issues, states).map((i) => i.number), [89]);
});

test("pickActionable: an unknown blocker is treated as open, not as absent", () => {
  // A reference to an issue the query never returned must fail closed.
  assert.deepEqual(pickActionable([issue(89, "Blocked by: #9999")], new Map()), []);
});

test("pickActionable: closed and do-not-build issues are excluded", () => {
  const issues = [
    issue(1, "Blocked by: none", { state: "CLOSED" }),
    issue(2, "Blocked by: none", { labels: ["tracker/do-not-build"] }),
    issue(3, "Blocked by: none", { labels: ["status:superseded"] }),
    issue(4, "Blocked by: none", { labels: ["blocked:external"] }),
    issue(5, "Blocked by: none"),
  ];
  assert.deepEqual(pickActionable(issues, new Map()).map((i) => i.number), [5]);
});

test("pickActionable: results are ordered by issue number", () => {
  const issues = [issue(30, "Blocked by: none"), issue(7, "Blocked by: none"), issue(19, "Blocked by: none")];
  assert.deepEqual(pickActionable(issues, new Map()).map((i) => i.number), [7, 19, 30]);
});

// ---------------------------------------------------------------------- slug

test("slug: builds a branch-safe, six-word slug", () => {
  assert.equal(slug("Build the acceptance suite scaffold and manifest"), "build-the-acceptance-suite-scaffold-and");
});

test("slug: punctuation and case never reach the branch name", () => {
  const s = slug("E9.2.1 — Stripe signature verification (Stripe-Signature header)");
  assert.match(s, /^[a-z0-9-]+$/, `slug must be branch-safe, got "${s}"`);
  assert.ok(!s.startsWith("-") && !s.endsWith("-"), `slug must not have loose dashes, got "${s}"`);
});

test("slug: the result satisfies the branch pattern the gate enforces", () => {
  // gate.mjs refuses any branch not matching this shape, so a slug that fails
  // it strands the issue after implementation, at the gate.
  assert.match(`glm/issue-284-${slug("Regenerate derived doc inventories & close remaining drift")}`, /^glm\/issue-\d+-[a-z0-9-]+$/);
});

// -------------------------------------------------------------- declaredFiles

test("declaredFiles: reads the Files: line", () => {
  assert.deepEqual(declaredFiles("Body text\nFiles: acceptance/, engine/graph.mjs\nBlocked by: none"), ["acceptance/", "engine/graph.mjs"]);
});

test("declaredFiles: absent when the issue declares nothing", () => {
  assert.deepEqual(declaredFiles("## Goal\nDo the thing."), []);
});

// ------------------------------------------------------------- gate self-hash
//
// gate.mjs proves it is unmodified by comparing its own git object id against
// the trunk's. It previously hashed raw file bytes on one side and a trimmed
// command substitution on the other, so the two could never match and the
// gate failed on every branch. This pins the invariant that makes it work:
// the two ways of naming the same blob agree.

test("gate: git hash-object agrees with the committed blob id", () => {
  const sh = (c) => execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const dirty = sh("git status --porcelain -- engine/gate.mjs");
  if (dirty) return; // uncommitted edit in flight — nothing to compare against
  assert.equal(sh("git hash-object engine/gate.mjs"), sh("git rev-parse HEAD:engine/gate.mjs"));
});
