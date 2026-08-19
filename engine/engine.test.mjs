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

import { blockers, slug, declaredFiles, pickActionable, partitionByGate, filesConflict, planBatch, lintEdges } from "./graph.mjs";
import { share } from "./ledger.mjs";

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

test("pickActionable: closed and non-buildable issues are excluded", () => {
  const issues = [
    issue(1, "Blocked by: none", { state: "CLOSED" }),
    issue(2, "Blocked by: none", { labels: ["tracker/do-not-build"] }),
    issue(3, "Blocked by: none", { labels: ["status:superseded"] }),
    issue(4, "Blocked by: none", { labels: ["blocked:external"] }),
    // Deferred work is unblocked and buildable in the literal sense, which is
    // exactly why it has to be named: without it the selector offered Outlook
    // (out of scope for beta and launch) as the next thing to build.
    issue(5, "Blocked by: none", { labels: ["deferred"] }),
    issue(6, "Blocked by: none"),
  ];
  assert.deepEqual(pickActionable(issues, new Map()).map((i) => i.number), [6]);
});

test("pickActionable: results are ordered by issue number", () => {
  const issues = [issue(30, "Blocked by: none"), issue(7, "Blocked by: none"), issue(19, "Blocked by: none")];
  assert.deepEqual(pickActionable(issues, new Map()).map((i) => i.number), [7, 19, 30]);
});

// ------------------------------------------------------------ partitionByGate

test("partitionByGate: a human-gated issue at the front does not stall the loop", () => {
  // The E-F epic's shape: #283 is gate:human and lowest-numbered, so the
  // unfiltered selector returned it on every call and the loop never advanced.
  const ready = [
    issue(283, "Blocked by: none", { labels: ["gate:human"] }),
    issue(284, "Blocked by: none"),
    issue(286, "Blocked by: none"),
  ];
  const { auto, gated } = partitionByGate(ready);
  assert.deepEqual(auto.map((i) => i.number), [284, 286]);
  assert.deepEqual(gated.map((i) => i.number), [283]);
});

test("partitionByGate: gated issues are reported, never silently dropped", () => {
  const { auto, gated } = partitionByGate([
    issue(289, "Blocked by: none", { labels: ["gate:human"] }),
    issue(290, "Blocked by: none", { labels: ["gate:human", "radius:large"] }),
  ]);
  assert.deepEqual(auto, []);
  assert.deepEqual(gated.map((i) => i.number), [289, 290]);
});

test("partitionByGate: an epic with no gated issues is unchanged", () => {
  const ready = [issue(1, "Blocked by: none"), issue(2, "Blocked by: none")];
  const { auto, gated } = partitionByGate(ready);
  assert.deepEqual(auto.map((i) => i.number), [1, 2]);
  assert.deepEqual(gated, []);
});

// ------------------------------------------------------------ filesConflict
//
// Guardrail 2: one writer per file. A wrong answer here puts two agents on the
// same artifact, which is the failure the whole batching idea rests on avoiding.

test("filesConflict: identical paths conflict", () => {
  assert.equal(filesConflict(["workers/src/index.ts"], ["workers/src/index.ts"]), true);
});

test("filesConflict: a directory conflicts with a file inside it", () => {
  assert.equal(filesConflict(["workers/src/"], ["workers/src/index.ts"]), true);
  assert.equal(filesConflict(["workers/src/index.ts"], ["workers/src"]), true);
});

test("filesConflict: sibling files do not conflict", () => {
  assert.equal(filesConflict(["workers/src/routes/gmail.ts"], ["workers/src/services/logger.ts"]), false);
});

test("filesConflict: overlap is boundary-aware, not a bare prefix match", () => {
  // "workers/src" is a prefix of the STRING "workers/src2" but not of the PATH.
  // A naive startsWith would serialise two unrelated directories forever.
  assert.equal(filesConflict(["workers/src"], ["workers/src2"]), false);
  assert.equal(filesConflict(["docs"], ["docs-history"]), false);
});

test("filesConflict: trailing slashes and ./ prefixes do not change the answer", () => {
  assert.equal(filesConflict(["./docs/"], ["docs/PRD.md"]), true);
  assert.equal(filesConflict(["docs//"], ["docs"]), true);
});

test("filesConflict: an undeclared file set conflicts with everything", () => {
  // Unknown blast radius must fail closed. Treating "no Files: line" as
  // "touches nothing" would hand two writers the same file.
  assert.equal(filesConflict([], ["docs/PRD.md"]), true);
  assert.equal(filesConflict(["docs/PRD.md"], []), true);
  assert.equal(filesConflict([], []), true);
});

// ---------------------------------------------------------------- planBatch

const withFiles = (number, files, extra = "") =>
  issue(number, `Blocked by: none\n${files === null ? extra : `Files: ${files}`}`);

test("planBatch: disjoint issues batch in parallel", () => {
  const plan = planBatch([
    withFiles(97, "workers/src/services/logger.ts"),
    withFiles(99, "workers/src/index.ts"),
    withFiles(106, "docs/OPERATIONS.md"),
  ]);
  assert.equal(plan.mode, "parallel");
  assert.deepEqual(plan.batch.map((i) => i.number), [97, 99, 106]);
  assert.deepEqual(plan.held, []);
});

test("planBatch: an overlapping issue is held, and says who it clashes with", () => {
  const plan = planBatch([
    withFiles(99, "workers/src/index.ts"),
    withFiles(101, "workers/src/index.ts, workers/src/services/digest.ts"),
  ]);
  assert.deepEqual(plan.batch.map((i) => i.number), [99]);
  assert.equal(plan.held.length, 1);
  assert.equal(plan.held[0].issue, 101);
  assert.match(plan.held[0].why, /#99/);
});

test("planBatch: sequential work reports the stop rule rather than a thin batch", () => {
  // Every multi-agent configuration LOST on sequential work. A batch of one is
  // the rule firing, not a shortage of issues, and must read that way.
  const plan = planBatch([withFiles(99, "workers/src/index.ts")]);
  assert.equal(plan.mode, "serial");
  assert.match(plan.reason, /does not split/);
});

test("planBatch: an issue with no Files: line runs alone", () => {
  const plan = planBatch([
    withFiles(500, null, "no file declaration here"),
    withFiles(501, "docs/PRD.md"),
  ]);
  assert.deepEqual(plan.batch.map((i) => i.number), [500]);
  assert.equal(plan.mode, "serial");
  assert.match(plan.held[0].why, /blast radius/);
});

test("planBatch: the parallel cap is enforced and the overflow is reported", () => {
  const plan = planBatch(
    [withFiles(1, "a.ts"), withFiles(2, "b.ts"), withFiles(3, "c.ts"), withFiles(4, "d.ts")],
    { max: 2 }
  );
  assert.deepEqual(plan.batch.map((i) => i.number), [1, 2]);
  assert.equal(plan.held.length, 2);
  assert.match(plan.held[0].why, /cap of 2/);
});

test("planBatch: held issues are never silently dropped", () => {
  const ready = [withFiles(1, "a.ts"), withFiles(2, "a.ts"), withFiles(3, "b.ts")];
  const plan = planBatch(ready, { max: 2 });
  const accounted = plan.batch.length + plan.held.length;
  assert.equal(accounted, ready.length, "every ready issue must appear in batch or held");
});

// ---------------------------------------------------------------- lintEdges

test("lintEdges: an edge between file-disjoint issues is flagged as suspect", () => {
  // "Draw an arrow only when a job needs another job's RESULT." #101 touching
  // nothing #99 writes is the question worth asking.
  const issues = [withFiles(99, "workers/src/index.ts"), issue(101, "Blocked by: #99\nFiles: docs/OPERATIONS.md")];
  const found = lintEdges(issues, new Map([[99, "OPEN"], [101, "OPEN"]]));
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "suspect");
  assert.equal(found[0].dep, 99);
});

test("lintEdges: a real edge over shared files is not flagged", () => {
  const issues = [withFiles(97, "workers/src/services/logger.ts"), issue(98, "Blocked by: #97\nFiles: workers/src/services/logger.ts, workers/src/index.ts")];
  assert.deepEqual(lintEdges(issues, new Map([[97, "OPEN"], [98, "OPEN"]])), []);
});

test("lintEdges: an edge to an issue that does not exist is dead", () => {
  const found = lintEdges([issue(101, "Blocked by: #9999\nFiles: docs/x.md")], new Map([[101, "OPEN"]]));
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "dead");
});

test("lintEdges: closed issues are not linted", () => {
  const issues = [issue(101, "Blocked by: #9999\nFiles: docs/x.md", { state: "CLOSED" })];
  assert.deepEqual(lintEdges(issues, new Map([[101, "CLOSED"]])), []);
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

// -------------------------------------------------------------- ledger share
//
// The governor's job is to keep the expensive model at 15-20% of tokens. It
// must never issue that verdict from data it does not have.

test("share: a real split is reported as a ratio", () => {
  const s = share([
    { model: "opus", tokensIn: 10_000, tokensOut: 5_000 },
    { model: "glm-5.3", tokensIn: 70_000, tokensOut: 15_000 },
  ]);
  assert.equal(s.measurable, true);
  assert.equal(s.total, 100_000);
  assert.equal(s.ratio, 0.15);
});

test("share: zero-token Anthropic rows are unmeasurable, not a 0% share", () => {
  // What the orchestrator actually records: it cannot read its own usage, so
  // LAUNCH.md tells it to write zeroes rather than invent numbers. Treating
  // that as "0% Anthropic" made check() advise MORE review — from no data.
  const s = share([
    { model: "opus", tokensIn: 0, tokensOut: 0, estimated: true },
    { model: "opus", tokensIn: 0, tokensOut: 0, estimated: true },
    { model: "glm-5.3", tokensIn: 117_457, tokensOut: 29_255 },
  ]);
  assert.equal(s.measurable, false, "must not claim a measurable split");
  assert.equal(s.unmeasured, 2);
  assert.equal(s.glm, 146_712, "the GLM side is still counted");
});

test("share: node share is reported even when tokens are not", () => {
  const s = share([
    { model: "opus", tokensIn: 0, tokensOut: 0 },
    { model: "glm-5.3", tokensIn: 0, tokensOut: 0 },
    { model: "glm-5.3", tokensIn: 0, tokensOut: 0 },
  ]);
  assert.equal(s.measurable, false);
  assert.deepEqual(s.nodes, { anthropic: 1, glm: 2 });
});

test("share: an empty ledger is unmeasurable rather than 0%", () => {
  const s = share([]);
  assert.equal(s.measurable, false);
  assert.equal(s.total, 0);
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
