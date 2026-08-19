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

Use the **Bash** tool for every command below. PowerShell mangles the JSON quoting in `ledger.mjs record`.

---

## Before the loop — run these once

Run these four in order. If any fails, stop and say why.

```bash
cd "C:/Users/sam/Dropbox/THS/Joint Ventures/Project SAAS/Flip"

# 1. Anchor the clock. You have four hours from this value.
date +%s > /tmp/ponytail-start && cat /tmp/ponytail-start

# 2. The ledger writes .engine/ledger.jsonl, which is NOT gitignored.
#    gate.mjs fails on any dirty path, so the first ledger row would break
#    every gate run after it. Exclude it locally — .git/info/exclude is never
#    committed, so this costs no commit and no deploy.
grep -qx '.engine/' .git/info/exclude || echo '.engine/' >> .git/info/exclude
git status --porcelain   # must print nothing

# 3. Confirm nothing can merge. Default is "pr"; anything else, stop.
echo "MERGE_MODE=${MERGE_MODE:-pr}"

# 4. Preflight must exit 0.
node engine/preflight.mjs
```

---

## Hard rules

1. **Nothing merges tonight, and nothing is pushed to master.** Flip deploys to production on push/merge to master, so a push to master *is* a deploy. Every issue ends as a pushed **feature** branch with an open PR. `MERGE_MODE=pr` makes `graph.mjs merge` stop before merging — verify it before the loop rather than assuming it.
2. **Never start an issue labelled `gate:human`.** `graph.mjs start` refuses; do not work around it. Three issues carry it — #283, #289, #290 — and they are the three that could cost real money to undo.
3. **Never run `wrangler d1 migrations apply` against `--remote`.** The production migration ledger is unknown and replaying migrations would be unrecoverable. Local only.
4. **Never modify a protected file.** The gate rejects the branch if any of these change — this is the exact list it enforces, by exact path match:
   `engine/gate.mjs`, `engine/graph.mjs`, `engine/drift.mjs`, `engine/preflight.mjs`, `.github/workflows/ci.yml`, `workers/tsconfig.json`, `workers/vitest.config.ts`, `workers/vitest.e2e.config.ts`, `workers/eslint.config.js`, `.gitattributes`
5. **Never weaken a test.** The gate counts `expect(` / `assert*(` across the whole suite and fails if the total drops. If a test blocks you, the code is wrong, not the test.
6. **Never add a drift exemption.** Fix the drift or stop.
7. **Do not deploy anything, anywhere.**

---

## Picking the next issue

Use the selector. It is authoritative:

```bash
node engine/graph.mjs next <EPIC>
```

It returns the lowest-numbered issue that is open, unblocked and startable, and it will not hand you one you must not touch — `gate:human` and `deferred` issues are filtered out, and the gated ones come back in a `humanGated` array so your run report can name what is parked rather than silently omitting it. When nothing startable remains it returns `done: true` with that array.

*(It did not always. `next` used to sort by number and ignore both labels, so a human-gated issue at the front of an epic was returned on every call and the loop could not advance past it. The workaround was a hand-maintained skip-list here, which made the selector advisory rather than authoritative — the opposite of the point. Fixed, with tests, in `engine/engine.test.mjs`.)*

`node engine/graph.mjs list <EPIC>` remains the human view — it shows everything, including the gated and deferred rows the selector withholds.

Epics currently seeded: `E-F` (foundations), `E-11` (observability and launch), `E-12` (email).

---

## The loop

Repeat until the epic is empty, you are blocked, or four hours have elapsed.

1. **Pick** the issue, per the section above.

2. **Spec it yourself.** Read the issue, its acceptance criteria, and the code it touches. Write a complete specification: files, intended behaviour, acceptance assertions, and what must not change. GLM executes unattended — if the spec has a gap, it will guess, and the guess will be wrong.

3. **Branch.**

   ```bash
   node engine/graph.mjs start <issue>
   ```

   This branches from fresh master as `glm/issue-<n>-<slug>`. Note the branch name; every later command needs it.

4. **Delegate** implementation to GLM-5.3 with that spec, effort `high`. GLM works in its own worktree — make sure the result lands as commits **on the branch `graph.mjs start` created**, not on a branch GLM invents. Verify with `git log --oneline master..HEAD` before continuing.

5. **Push and open the PR — before the gate, not after.**

   ```bash
   git push -u origin <branch>
   gh pr create --base master --head <branch> \
     --title "<commit subject>" --body "Fixes #<issue>"
   ```

   The gate checks *"local branch matches pushed branch"* and *"PR exists, targets the trunk, and closes the issue"*. `graph.mjs merge` only creates the PR **after** it runs the gate, so skipping this step makes the gate fail every time on a branch that is otherwise fine. The body must contain the literal `Fixes #<issue>`.

6. **Gate.**

   ```bash
   node engine/gate.mjs <branch>
   ```

   Expect this to be slow: if the branch touches `workers/`, it runs typecheck, lint, the full unit suite, e2e, and a wrangler deploy dry-run. Two known flakes, neither of which is your change:

   * the full `npm --prefix workers test` run can die on Dropbox-evicted `node_modules` files — re-run once before treating it as a real failure;
   * `test:e2e` needs real D1 and queue consumers up.

   On a genuine failure, feed it back to GLM and retry. **Maximum two retries**, then park the issue with a `gh issue comment` explaining exactly where it stuck, add it to the skip-list, and move on.

7. **Review the diff yourself, cold.** Do not re-read your own spec first. Ask: does this do something other than what it claims; is anything irreversible; is there a simpler correct version. One round of findings back to GLM, then escalate or park.

   * Skip review only when the issue is `radius:small` **and** `tier:trivial`.

8. **Close out.**

   ```bash
   node engine/graph.mjs merge <branch>
   ```

   It re-runs the gate, confirms the PR, and stops on `MERGE_MODE=pr`. It will print `"merged": false, "reason": "MERGE_MODE=pr"`. That is success. If it ever prints `"merged": true`, something set `MERGE_MODE=auto` — stop the run immediately and report it.

9. **Record one row per node** (SPEC, IMPLEMENT, GATE, REVIEW), using the Bash tool:

   ```bash
   node engine/ledger.mjs record '{"issue":286,"node":"IMPLEMENT","model":"glm-5.3","tokensIn":48000,"tokensOut":12000,"outcome":"ok"}'
   ```

   Use the **real** token counts from the delegation result where it reports them. Where you genuinely cannot get a number, put `"tokensIn":0,"tokensOut":0` and add `"estimated":true` — do not invent figures. `ledger.mjs check` gates the 15–20% band on these numbers, and fabricated ones make the governor worthless.

   Return to step 1. Re-check the clock:

   ```bash
   echo $(( ($(date +%s) - $(cat /tmp/ponytail-start)) / 60 )) minutes elapsed
   ```

---

## Stop immediately and write the report if

* The gate fails three times on one issue
* Two consecutive issues fail for unrelated reasons
* `git status` shows changes on master you did not make (your own `.engine/` writes are excluded above and do not count)
* `graph.mjs merge` reports `"merged": true`
* Anything asks you to touch production, a secret, or a remote database
* Four hours have elapsed

---

## Morning report

Write it to **`.engine/RUN-<date>.md`** — not `engine/`. `.engine/` is locally excluded, so the report costs no commit; writing into `engine/` would dirty master, and the only way to preserve it would be a push, which is a deploy.

Finish your last message with the same summary:

* Issues attempted, completed, parked — with PR links
* For each parked issue: exactly where it stuck
* `node engine/ledger.mjs report` output, including the model share
* `node engine/drift.mjs --report` output
* Anything you found that nobody has decided. **Do not decide it yourself — write it down.**
* The three `gate:human` issues, untouched, and what each needs from Sam

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
