#!/usr/bin/env node
// Seeds the E-F Foundations epic: labels, then issues, in dependency order.
// Idempotent — re-running will not duplicate an issue with the same title.
//
//   node engine/seed-foundations.mjs --dry-run
//   node engine/seed-foundations.mjs

import { execSync } from "node:child_process";

const DRY = process.argv.includes("--dry-run");
const sh = (c) => execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const run = (c) => { if (DRY) { console.log(`  [dry] ${c.slice(0, 160)}`); return ""; } return sh(c); };

const LABELS = [
  ["epic:E-F", "5319e7", "Foundations — the engine cannot run without these"],
  ["ready", "0e8a16", "Unblocked and buildable"],
  ["radius:small", "c2e0c6", "Low blast radius — docs, tests, tooling"],
  ["radius:large", "e99695", "High blast radius — runtime, schema, money, auth"],
  ["tier:trivial", "ededed", "Mechanical"],
  ["tier:standard", "ededed", "Normal"],
  ["tier:complex", "ededed", "Needs a real spec"],
  ["gate:human", "b60205", "Must not be started unattended"],
  ["tracker/do-not-build", "000000", "Excluded from the loop"],
];

// Ordered. `blocked` refers to the ISSUE KEY of an earlier entry.
const ISSUES = [
  {
    key: "deepseek",
    title: "Move DeepSeek to deepseek-v4-pro (retired model in production)",
    labels: ["epic:E-F", "radius:large", "tier:standard", "gate:human"],
    body: `DeepSeek retired \`deepseek-chat\` and \`deepseek-reasoner\` on **2026-07-24**. Both are still in the Worker.

**Call sites**
- \`workers/src/services/deepseek.ts:11\` — \`FLASH_MODEL = 'deepseek-chat'\`
- \`workers/src/services/deepseek.ts:12\` — \`PRO_MODEL = 'deepseek-reasoner'\`
- \`workers/src/services/comparisonIntelligence.ts:64\`
- \`workers/src/services/ingestionIntelligence.ts:43\`
- \`workers/src/services/usageIntelligence.ts:41\`

**Decision:** \`deepseek-v4-pro\` across the board.

**Why this is human-gated.** The reasoner returned a different response shape from chat, and all four call sites parse the response directly. A blind identifier swap could break parsing silently. Verify a live round-trip on each call path before merging.

**Acceptance**
- [ ] One live call per call site returns a parseable response
- [ ] No occurrence of \`deepseek-chat\` or \`deepseek-reasoner\` outside tests
- [ ] \`engine/drift-exemptions.json\` entry removed
- [ ] \`docs/ARCHITECTURE.md\` §8 model line matches

Files: workers/src/services/deepseek.ts, workers/src/services/comparisonIntelligence.ts, workers/src/services/ingestionIntelligence.ts, workers/src/services/usageIntelligence.ts
Blocked by: none`,
  },
  {
    key: "acceptance",
    title: "Build the acceptance suite scaffold and manifest",
    labels: ["epic:E-F", "radius:small", "tier:standard"],
    body: `Create \`acceptance/\` — the live probe suite that tests the deployed product against the product documentation, rather than against unit-test assertions.

Every probe cites the doc claim it proves. A numbered PRD section with no probe is a drift failure once the manifest exists.

**Deliverables**
- \`acceptance/manifest.json\` — \`{ probes: [{ id, claim, file, owner, lastGreen }] }\`
- \`acceptance/README.md\` — how to add a probe, how to run the suite
- \`acceptance/run.mjs\` — runner; takes \`--probe <id>\` or runs all; writes results back to the manifest
- At least three real probes against \`docs/PRD.md\`:
  - \`001-below-threshold\` — PRD §6.1: nothing is sent under $200/yr
  - \`002-stop-honoured\` — PRD §6.4: STOP suppresses everything
  - \`003-parse-reconciliation\` — PRD §8.3: a bill that fails \`reconcile_total\` does not alert

Probes are HTTP + D1 assertions against a staging environment. **Do not run them against production.** Where staging does not yet exist, the probe must skip loudly rather than pass.

**Acceptance**
- [ ] \`node acceptance/run.mjs\` runs and reports
- [ ] \`node engine/drift.mjs --report\` shows the acceptance check active
- [ ] Every probe names a PRD section

Files: acceptance/
Blocked by: none`,
  },
  {
    key: "ci",
    title: "Add e2e tests and the drift detector to CI",
    labels: ["epic:E-F", "radius:small", "tier:trivial"],
    body: `\`workers/package.json\` already defines \`test:e2e\` and \`test:all\`. CI runs neither. The drift detector is not wired in at all.

**Change** \`.github/workflows/ci.yml\`:
- Replace \`npm test\` with \`npm run test:all\` in the \`ci\` job
- Add a step: \`node engine/drift.mjs\`
- Add a step: \`node engine/ledger.mjs check\` (non-blocking, \`continue-on-error: true\`)

**Acceptance**
- [ ] CI runs unit and e2e tests
- [ ] CI fails when documentation drifts
- [ ] A green run exists on master

Files: .github/workflows/ci.yml
Blocked by: none`,
  },
  {
    key: "hygiene",
    title: "Repo hygiene: gitignore agent state, remove stray artefacts",
    labels: ["epic:E-F", "radius:small", "tier:trivial"],
    body: `The tree carries agent state and build debris that has no business being tracked.

**Remove or ignore**
- \`.claude-flow/\`, \`.swarm/\`, \`.remember/\` — gitignore (do not delete \`.claude/\`, which is the agent contract)
- \`ruvector.db\` — delete and ignore
- \`test_eval.pdf\` at repo root — move to \`workers/src/__fixtures__/\` or delete
- \`python/**/*.tmp.*\` — four stray temp files from an interrupted edit
- \`scripts/capture-log.txt\`, \`scripts/probe-out.txt\` — transient output, ignore

Leave \`example bills/\` — it is the real-bill corpus the accuracy bar depends on.

**Acceptance**
- [ ] \`git status\` is clean on a fresh checkout
- [ ] No agent-state directory is tracked

Files: .gitignore
Blocked by: none`,
  },
  {
    key: "prune",
    title: "Prune merged and abandoned branches",
    labels: ["epic:E-F", "radius:small", "tier:trivial"],
    body: `Roughly 40 local branches remain from earlier work: \`feat/issue-NN-*\`, \`fix/NN-*\`, \`chore/*\`, \`ci/*\`, plus three remote \`claude/*\` branches.

The current checkout, \`fix/powerswitch-glued-prefix\`, is 6 commits **behind** master with no unique commits — it is stale and can go.

Delete every branch fully merged into master. List anything unmerged in a comment rather than deleting it.

**Acceptance**
- [ ] Only master and in-flight \`glm/*\` branches remain
- [ ] Unmerged branches are listed, not deleted

Files: (no source changes)
Blocked by: none`,
  },
  {
    key: "docsync",
    title: "Regenerate derived doc inventories and close remaining drift",
    labels: ["epic:E-F", "radius:small", "tier:standard"],
    body: `Bring every derived inventory in the docs back into agreement with source, and keep it that way.

**Regenerate from code into \`docs/ARCHITECTURE.md\`**
- Route table (26 routes registered in \`workers/src/index.ts\`)
- Table list (14 tables across 21 migrations)
- Cron schedules (5 in \`wrangler.toml\`)
- Feature flags with their current values
- Outbound hosts, cross-checked against the processor list in \`docs/PRD.md\` §10.2

Mark each generated block so a future regeneration is mechanical.

**Acceptance**
- [ ] \`node engine/drift.mjs --report\` reports zero findings other than active exemptions
- [ ] Generated blocks are delimited and labelled

Files: docs/ARCHITECTURE.md, docs/OPERATIONS.md
Blocked by: ci`,
  },
  {
    key: "checkin",
    title: "Remove the free-tier monthly check-in",
    labels: ["epic:E-F", "radius:large", "tier:standard", "gate:human"],
    body: `**Decided:** the free tier receives no proactive messages at all. The monthly check-in is removed.

**Remove**
- \`workers/src/services/freeTierCheckin.ts\`
- \`getFreeTierUsers\` in \`workers/src/models/users.ts\`
- The day-of-month branch in the \`0 8 * * *\` cron in \`workers/src/index.ts\`
- \`free_tier_checkin\` from the \`notifications.type\` and \`notification_audit.notification_type\` CHECK constraints — **schema change, needs a migration**

**Replace with:** a monthly "still on the best plan" reassurance for **paying** customers, in months where no saving alert fired.

**Why this is human-gated.** It touches the notification path and requires a migration, and Flip's remote D1 has no \`d1_migrations\` ledger — see \`docs/OPERATIONS.md\` §4.1. **Do not apply any migration to production until that ledger is rebuilt.**

**Acceptance**
- [ ] No free-tier user receives a proactive message
- [ ] Paid users receive at most one reassurance per calendar month
- [ ] \`docs/PRD.md\` §6.3 matches behaviour

Files: workers/src/services/freeTierCheckin.ts, workers/src/models/users.ts, workers/src/index.ts, workers/migrations/
Blocked by: none`,
  },
  {
    key: "ledger",
    title: "Audit the remote D1 schema and rebuild the migrations ledger",
    labels: ["epic:E-F", "radius:large", "tier:complex", "gate:human"],
    body: `**The single most dangerous outstanding task in this repo. Do not attempt unattended.**

The remote D1 has no \`d1_migrations\` ledger, so \`wrangler d1 migrations apply\` must never be run against production — it would replay all 21 migrations against a database that already has most of them. Nobody currently knows which migration production is on.

**Procedure** — take a backup first. See \`docs/OPERATIONS.md\` §4.1.
1. Dump the live schema
2. Diff against the 21 files in \`workers/migrations/\`
3. Identify the highest applied migration
4. Hand-insert the corresponding \`d1_migrations\` rows
5. Verify \`wrangler d1 migrations list\` reports zero pending

**This blocks every future schema change**, including the check-in removal and the threshold rename.

**Acceptance**
- [ ] Backup taken and its location recorded
- [ ] Ledger rebuilt and verified
- [ ] \`docs/OPERATIONS.md\` §4.1 updated with what was actually found

Files: (operational — no source changes)
Blocked by: none`,
  },
];

// ------------------------------------------------------------------- labels

console.log(`\n  Seeding E-F Foundations${DRY ? " (dry run)" : ""}\n`);

const existing = new Set(
  (sh(`gh label list --limit 300 --json name -q ".[].name"`) || "").split("\n").filter(Boolean)
);
for (const [name, color, desc] of LABELS) {
  if (existing.has(name)) { console.log(`  label exists   ${name}`); continue; }
  run(`gh label create "${name}" --color ${color} --description "${desc}"`);
  console.log(`  label created  ${name}`);
}

// ------------------------------------------------------------------- issues

const openTitles = new Set(
  JSON.parse(sh(`gh issue list --state all --limit 400 --json title`) || "[]").map((i) => i.title)
);

const numbers = {};
for (const issue of ISSUES) {
  if (openTitles.has(issue.title)) {
    const found = JSON.parse(sh(`gh issue list --state all --limit 400 --json number,title`))
      .find((i) => i.title === issue.title);
    numbers[issue.key] = found.number;
    console.log(`  issue exists   #${found.number}  ${issue.title}`);
    continue;
  }

  let body = issue.body;
  if (issue.blocked) {
    const refs = issue.blocked.map((k) => `#${numbers[k]}`).join(", ");
    body = body.replace(/^Blocked by: none$/m, `Blocked by: ${refs}`);
  }

  const labels = [...issue.labels];
  if (!issue.blocked && !labels.includes("gate:human")) labels.push("ready");

  const tmp = `.engine-issue-body.md`;
  if (!DRY) execSync(`node -e "require('fs').writeFileSync(process.argv[1], process.argv[2])" "${tmp}" ${JSON.stringify(body)}`);
  const out = run(`gh issue create --title ${JSON.stringify(issue.title)} --body-file "${tmp}" --label "${labels.join(",")}"`);
  const n = Number((out.match(/\/issues\/(\d+)/) || [])[1]) || `<${issue.key}>`;
  numbers[issue.key] = n;
  console.log(`  issue created  #${n}  ${issue.title}`);
  if (!DRY) execSync(`node -e "require('fs').unlinkSync('${tmp}')"`);
}

console.log(`\n  Done. Inspect with:  node engine/graph.mjs list E-F\n`);
