# Historical documents — NOT requirements

**Nothing in this directory describes the current product.** These files are kept for provenance only.

An agent reading this repository must treat everything here as **superseded**. Where a file here conflicts with a document in `docs/`, the file here is wrong.

Archived 2026-08-18 during the documentation alignment.

| File | Why it is here | Replaced by |
|---|---|---|
| `DEPLOY.md` | Secrets list was 7 of 14 and unguarded by CI; template copy stale; described a Pages portal and Outlook integration that never existed | `docs/OPERATIONS.md` |
| `TESTING_RUN.md` | Was the de-facto operations runbook and the only CI-validated secrets list | `docs/OPERATIONS.md` |
| `PLAN.md` | Opened with *"No code exists yet. No git repository is initialised."* — written before ~280 commits and a live deployment | Nothing; the roadmap lives in the issue graph |
| `POWERSWITCH_COMPLIANCE.md` | Gates-and-sign-off record, retired by decision | One line in `docs/AI_RULES.md` |
| `REQUIREMENTS.md` | Declared *"Current Phase: Phase 1 (Weeks 1-2)"*; duplicated AI_RULES; carried a flat prohibition on Powerswitch querying that the code had already overridden | `docs/AI_RULES.md` |
| `bugs.md` | Listed one open bug from May and recorded none of the ~14 fixes merged in August | GitHub issues |
| `logs.md` | Session build log; contradicted `python/fly.toml` on where the Python service runs | `docs/OPERATIONS.md` |

## Two things worth carrying forward

**`logs.md` was right about Cloud Run.** It recorded a live Google Cloud Run deployment while `python/fly.toml` claimed Fly.io. The Cloud Run URL is what `PYTHON_SERVICE_URL` actually points at. `fly.toml` has been deleted; confirm no Fly app is still billing.

**`TESTING_RUN.md` was the only honest secrets list.** `scripts/check-env-docs.mjs` validated against it, which is why it stayed accurate while `DEPLOY.md` rotted. That CI gate now points at `docs/OPERATIONS.md` — keep it pointed there.
