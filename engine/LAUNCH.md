# Launch — Flip, overnight run

Two things to do by hand, then one prompt to paste.

---

## Step 1 — prepare (do this yourself; it needs your credentials)

> **You have uncommitted work in the repo.** `workers/src/services/powerswitchSession.ts` (+45/−2) and `powerswitchSession.test.ts` (+49/−0) carry roughly 94 lines of real, unpushed changes on branch `fix/powerswitch-glued-prefix` — presumably the glued-prefix fix.
>
> Everything else that shows as modified is pure line-ending churn. **Deal with this first**, or the normalisation will bury it.

### 1a — rescue the in-progress work

```bash
cd "C:\Users\sam\Dropbox\THS\Joint Ventures\Project SAAS\Flip"

# See what it is
git diff --ignore-cr-at-eol -- workers/src/services/powerswitchSession.ts

# Then either commit it on its branch...
git add workers/src/services/powerswitchSession.ts workers/src/services/powerswitchSession.test.ts
git commit -m "fix(powerswitch): glued prefix in address resolution"
git push origin fix/powerswitch-glued-prefix

# ...or park it if it is not ready
git stash push -m "powerswitch glued prefix WIP" \
  workers/src/services/powerswitchSession.ts \
  workers/src/services/powerswitchSession.test.ts
```

Note the branch is **6 commits behind master** and has no unique commits of its own, so it is otherwise disposable.

### 1b — commit the documentation and engine work

The docs rewrite, the archived history and the `engine/` directory are all uncommitted.

```bash
git checkout master
git pull --ff-only origin master

git add engine/ docs/ scripts/check-env-docs.mjs acceptance/ 2>$null
git add -A docs/history/
git status          # read this before committing
git commit -m "docs: align PRD/architecture/operations with code; add graph engine"
```

### 1c — normalise line endings

This rewrites ~600 files. Run the dry run first — it now checks **every** file, not a sample, and refuses if any real work is still uncommitted.

```bash
node engine/normalise-line-endings.mjs
node engine/normalise-line-endings.mjs --apply
git commit -m "chore: normalise line endings (.gitattributes)"
git push origin master
```

### 1d — create the epic

```bash
node engine/seed-foundations.mjs --dry-run
node engine/seed-foundations.mjs
node engine/graph.mjs list E-F
```

Then **edit `engine/drift-exemptions.json`** and set both `issue` values to the number the seed actually assigned to the DeepSeek issue. It is currently a guess of `283`, based on the highest open issue being #282.

### 1e — final checks

```bash
# ~/.glm-delegate/config.json → "primary": "glm-5.3", "standard": "glm-5.3"

node engine/preflight.mjs     # must exit 0
```

---

## Step 2 — paste this into Claude Code

Open Claude Code in the Flip repo and paste everything between the lines.

---

You are running the Ponytail Graph engine on Flip, unattended, overnight.

Read `engine/README.md` first. It describes the control plane you are operating inside. You do not modify it.

**Your role is orchestration, not typing.** You write specs and review diffs. GLM-5.3 does the implementation, via `mcp__plugin_glm-delegate_glm__glm_execute`. Read the `delegate-to-glm` skill before your first delegation. Target roughly 15–20% of total tokens on Anthropic — if you find yourself writing implementation code, you have taken the wrong role.

## Hard rules

1. **`MERGE_MODE=pr`. Nothing merges tonight.** Every issue ends as a pushed branch with an open PR. Flip deploys to production on merge to master, so a merge is a deploy, and no deploy happens without Sam.
2. **Never start an issue labelled `gate:human`.** `graph.mjs start` will refuse; do not work around it. Three issues carry it and they are the three that could cost real money to undo.
3. **Never run any `wrangler d1 migrations apply` against `--remote`.** The production migration ledger is unknown and replaying migrations would be unrecoverable. Local only.
4. **Never modify** `engine/gate.mjs`, `engine/graph.mjs`, `engine/drift.mjs`, `.github/workflows/ci.yml`, any tsconfig, any test config, or `.gitattributes`. The gate rejects branches that touch them.
5. **Never weaken a test.** The gate counts assertions across the whole suite and fails if the total drops. If a test blocks you, the code is wrong, not the test.
6. **Never add a drift exemption.** Fix the drift or stop.
7. **Do not deploy anything, anywhere.**

## The loop

Repeat until the epic is empty, you are blocked, or you have been running four hours:

1. `node engine/graph.mjs next E-F` — take the issue it names. If it reports `blocked` or `done`, stop and write the report.
2. **Spec it yourself.** Read the issue, its acceptance criteria, and the code it touches. Write a complete specification: files, intended behaviour, acceptance assertions, and what must not change. GLM executes unattended — if the spec has a gap, it will guess, and the guess will be wrong.
3. `node engine/graph.mjs start <issue>` — branches from fresh master.
4. **Delegate implementation to GLM-5.3** with that spec. Effort `high`.
5. `node engine/gate.mjs <branch>` — if it fails, feed the failure back to GLM and retry. **Maximum two retries**, then park the issue with a comment explaining where it stuck and move on.
6. **Review the diff yourself, cold.** Do not re-read your own spec first. Ask: does this do something other than what it claims; is anything irreversible; is there a simpler correct version. One round of findings back to GLM, then escalate or park.
   - Skip review only when the issue is `radius:small` **and** `tier:trivial`.
7. `node engine/graph.mjs merge <branch>` — runs the gate again, pushes, opens the PR, stops. It will not merge.
8. Record the row:
   ```
   node engine/ledger.mjs record '{"issue":N,"node":"IMPLEMENT","model":"glm-5.3","tokensIn":...,"tokensOut":...,"outcome":"ok"}'
   ```
   One row per node. Estimate token counts from the delegation result.

## Stop immediately and write the report if

- The gate fails three times on one issue
- Two consecutive issues fail for unrelated reasons
- `git status` shows unexpected changes on master
- Anything asks you to touch production, a secret, or a remote database
- You have been running four hours

## Morning report

Write `engine/RUN-<date>.md` and finish your last message with a summary:

- Issues attempted, completed, parked — with PR links
- For each parked issue: exactly where it stuck
- `node engine/ledger.mjs report` output, including the model share
- `node engine/drift.mjs --report` output
- **Anything you found that nobody has decided.** Do not decide it yourself — write it down.
- The three `gate:human` issues, untouched, and what each needs from Sam

Start with `node engine/preflight.mjs`. If it does not exit 0, stop and say why.

---

## What this will and will not do

**Will:** build the acceptance suite scaffold, wire e2e tests and the drift detector into CI, clean repo hygiene, prune branches, regenerate the derived doc inventories, and open a PR for each.

**Will not:** merge anything, deploy anything, touch the production database, change a model identifier, remove the free-tier check-in, or touch payments, auth or encryption.

**Three issues are parked for you by design:**

| Issue | Needs |
|---|---|
| DeepSeek → `deepseek-v4-pro` | A verified live round-trip per call site. The reasoner returned a different response shape and four call sites parse it directly. |
| Remove the free-tier check-in | A schema migration, which is blocked on the ledger rebuild below. |
| Rebuild the D1 migrations ledger | A backup, and a careful hand-reconciliation. Unrecoverable if wrong. |

In the morning: read the PRs, merge what you like, and start the ledger rebuild yourself.
