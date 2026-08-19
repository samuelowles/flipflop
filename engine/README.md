# Ponytail Graph — Flip

The deterministic control plane for autonomous work on this repo.

**The premise:** a cheap model can be trusted with the keyboard as long as the parts that matter — which issue is next, whether the gate passed, whether anything merges — are owned by scripts rather than by a model.

---

## Files

| File | Owns |
|---|---|
| `preflight.mjs` | Refuses to start when the repo or tooling is not in a fit state |
| `graph.mjs` | Which issue is next · branch creation · merge decision |
| `gate.mjs` | Whether a branch may merge. The un-foolable part |
| `engine.test.mjs` | Tests for the selector and the dependency parser. `node --test engine/engine.test.mjs` |
| `drift.mjs` | Whether the docs still match the code |
| `drift-exemptions.json` | Time-boxed, issue-linked exemptions. They expire loudly |
| `ledger.mjs` | Token accounting and the 15–20% Anthropic band |
| `seed-foundations.mjs` | Creates the E-F epic, labels and issues |
| `normalise-line-endings.mjs` | One-off CRLF fix. Run before anything else |

---

## The loop

```
graph.mjs next E-F     → the next startable issue
graph.mjs start <n>    → branch from fresh master
   ...implement...
graph.mjs merge <br>   → gate, then merge or open a PR
```

`next` returns only what the loop may actually start. It withholds four kinds
of issue and reports the human-gated ones back in a `humanGated` array so a run
report can say what is parked:

| Label | Why it is withheld |
|---|---|
| `gate:human` | Costs real money or is unrecoverable if wrong. `start` refuses it too |
| `deferred` | Approved to defer — e.g. Outlook, out of scope for beta and launch |
| `tracker/do-not-build` · `status:superseded` | Not work |
| open `Blocked by:` references | Its dependencies are not closed |

`list` is the human view and shows all of them.

Nodes and who does what:

| Node | Model | Why |
|---|---|---|
| SELECT | none | Deterministic |
| SPEC | Anthropic | A bad spec wastes an entire implementation cycle |
| IMPLEMENT | **GLM-5.3** | Mechanical, high volume, 1M context |
| GATE | none | A script. This is the trust boundary |
| REVIEW | Anthropic | Reads the diff **cold**, with no memory of the spec |
| MERGE | none | Deterministic |
| DOCSYNC | **GLM-5.3** | High volume, verified by the drift detector |

Review is skipped for `radius:small` + `tier:trivial`. That is where the Anthropic budget is protected.

---

## Two safety mechanisms that matter

### MERGE_MODE

Flip deploys to production **on merge to master** via the Workers Builds Git integration. A merge is a deploy.

| Mode | Behaviour |
|---|---|
| `pr` *(default)* | Never merges. Runs the gate, pushes, opens a PR, stops. **Nothing reaches production.** |
| `auto` | Merges when the gate passes — **but still refuses** any branch touching `workers/src`, `python/` or `workers/migrations` |

Even in `auto`, runtime code cannot merge unattended. It opens a PR and stops.

### gate:human

An issue labelled `gate:human` cannot be started by the loop. `graph.mjs start` refuses it outright.

Currently applied to: the DeepSeek model swap, the free-tier check-in removal, and the D1 ledger rebuild.

---

## The gate

`gate.mjs` refuses unless **all** of:

- Working tree clean; branch is not the trunk; branch name matches `glm/issue-N-slug`
- Local branch matches the pushed branch
- Exactly one open PR, based on `master`, whose body contains `Fixes #N`
- No protected file modified — the gate itself, CI config, tsconfig, test configs, `.gitattributes`
- `gate.mjs` hashes identical to the copy on master
- No secret-bearing file touched (`.env*`, `.dev.vars*`, MCP config)
- No test file deleted, and **the total assertion count has not fallen**
- The control-plane tests pass (`engine/engine.test.mjs`)
- `git diff --check` passes
- Env docs in sync · typecheck · lint · unit tests · e2e tests · deploy dry-run
- pytest and the parser eval, when `python/` is touched
- **Documentation drift is zero**

Build steps are skipped for paths they do not apply to — a docs-only branch does not run the Worker build.

### The same checks run in CI

The gate runs locally, on the branch, before a PR is opened. `.github/workflows/ci.yml`
re-runs the load-bearing parts on GitHub so a change that reaches master by any
other route — a hand-merged PR, a direct push — is still held to them:

| Job | Runs |
|---|---|
| `typecheck + lint + test` | env docs · typecheck · lint · unit · **e2e** · deploy dry-run |
| `control plane + docs drift + acceptance` | `engine.test.mjs` · `drift.mjs` · `acceptance/run.mjs` |
| `parser pytest + eval harness` | pytest · the parser eval |

The control-plane job is stdlib-only — no npm install, no Python — and needs
`fetch-depth: 0`, because both the drift replay and the gate's own blob-id
check read real history.

---

## The drift detector

Re-derives ground truth from source and compares it against the docs. Without it, this repo returns to its August 2026 state — 38 documented divergences — within a quarter.

| Check | Derived from |
|---|---|
| Routes | `app.<method>(...)` registrations in `index.ts` |
| Tables | All 21 migrations, replayed in order, **with SQL comments stripped** |
| Cron | `crons = [...]` in `wrangler.toml` |
| Flags | `[vars]` — presence **and current value** |
| Env vars | Every `env.X` / `env?.X` read under `workers/src` |
| Processors | Outbound `https://` hosts, excluding captured fixture modules |
| Models | Known-retired provider identifiers |
| Acceptance | Every numbered PRD section maps to a probe |

Two parsing traps this already handles, both of which produced wrong answers on the first pass:

- **Down-migrations live in the same files as commented-out blocks.** Not stripping comments made 14 tables look like 4.
- **A table row that merely mentions a flag is not that flag's row.** Matching on substring rather than first cell produced a false value mismatch.

### Exemptions

`drift-exemptions.json` allows a known finding to be time-boxed so it does not block every unrelated branch. Every entry carries an issue number and an expiry. After the expiry it becomes a hard failure again and says `EXEMPTION EXPIRED` in the output.

Renewing an exemption rather than fixing the cause is the failure this design is meant to make visible.

---

## Before the first run

```bash
git checkout master && git pull
node engine/normalise-line-endings.mjs            # dry run, verifies it is safe
node engine/normalise-line-endings.mjs --apply
git commit -m "chore: normalise line endings (.gitattributes)"
git push origin master

node engine/seed-foundations.mjs --dry-run
node engine/seed-foundations.mjs

node engine/preflight.mjs
```

Preflight must exit 0. If it does not, it prints the fix for each failure.

---

## Ledger

Every node execution appends a row:

```bash
node engine/ledger.mjs record '{"issue":283,"node":"IMPLEMENT","model":"glm-5.3","tokensIn":145000,"tokensOut":25000,"outcome":"ok"}'
node engine/ledger.mjs report
node engine/ledger.mjs check     # exit 1 if the band is breached
```

### The band can only be judged from measured tokens

The orchestrator cannot read its own token usage, so its rows are recorded as
zeroes with `estimated: true` rather than invented figures. That makes the
Anthropic side structurally `0` — and a ratio of 0 is **not a low ratio, it is
an absent measurement**.

Conflating the two made the governor read "0% Anthropic" and advise *"below
15%, the system is under-reviewing, re-enable review on trivial issues"* from
no data at all: a governor biased towards spending more of the expensive
model, which is the one thing it exists to prevent.

`report` and `check` now say `NOT MEASURABLE` instead, and both print the
**node share** — how many nodes ran on each model — which needs no token
counts and so stays honest either way. To get a real token ratio, record the
counts the delegation result reports for GLM and a genuine figure for
Anthropic; until the harness can supply the latter, the node share is the
signal to steer by.

Band: **15–20% Anthropic** by total tokens over a rolling 50 issues. Above 20% the system is over-escalating; below 15% it is under-reviewing. An escalation rate above 25% alerts regardless — a cascade that escalates most of its traffic costs more than no routing at all.
