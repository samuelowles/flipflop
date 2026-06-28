# Python Service — Deployment Strategy

Decision for [issue #20](../..//issues/20). Records the chosen target, the
rejected alternative, the migration triggers, and how Epic 5 parsers are
deployed today.

## Decision

**External container (Fly.io) running the Flask service in `python/server.py`.**

| | Option | Verdict |
|---|---|---|
| A | Pyodide inside the Cloudflare Worker | Rejected — see below |
| B | External container (Fly.io, Flask + gunicorn) | **Chosen** |

## Why not Pyodide

The default candidate from `docs/PLAN.md` § Key Decisions 1 is Pyodide
(single deploy target, no separate infra). It is rejected for the MVP on
three concrete blockers:

1. **C extensions.** `python/requirements.txt` pins `pdfplumber>=0.11.0` and
   `Pillow>=11.0.0`. Pillow has C extensions that Pyodide cannot load as of
   2026-06 (Pyodide ships pure-Python wheels only, and Pillow is not yet
   packaged). pdfplumber has no fallback parser. Every Flip bill parser
   imports pdfplumber transitively (`from pdfplumber import PDF`).
2. **Cold start.** Even for a pure-Python subset, Pyodide cold-start inside
   a Worker is in the 1-3s range today; combined with the 10 retailer
   parsers the first `/parse` would routinely exceed the 5s p95 ceiling.
3. **Memory.** Pyodide initial footprint is ~30MB compressed; Worker memory
   limit (128MB on standard plan) leaves little headroom for parsing PDFs.

These match the migration triggers in `docs/PLAN.md` verbatim: Pyodide is
the fallback *only* if external container proves inadequate on those same
three axes. The external container is the default in practice because the
Pyodide path is closed by blocker 1 today.

## Migration triggers (revisit the decision)

Stay on external container **unless** one of these flips:

- Pyodide ships an official Pillow wheel (or we replace pdfplumber with a
  pure-Python PDF library that Pyodide supports). Re-open the comparison.
- Cold-start p95 of the external container exceeds 5s for the first
  `/parse` after idle — measured via
  `python scripts/bench-python-deploy.py --target container --cold-start`.
  Above the threshold, move parsing latency-critical routes to a Pyodide
  Worker-side cache and keep container as fallback.
- Container memory exceeds 256MB steady-state — measured via Fly metrics
  on the `flip-python` app. Above the threshold, profile and prune before
  re-evaluating Pyodide.

## How Epic 5 parsers deploy today

`python/Dockerfile` builds a `python:3.12-slim` image that installs the
system libs Pillow needs (`libjpeg62-turbo`, `libopenjp2-7`) plus
`requirements.txt`. `python/fly.toml` is the Fly.io app config
(`flip-python`, region `syd`, internal-only). The Worker calls the
container at the URL stored in the `PYTHON_SERVICE_URL` Cloudflare secret.

Endpoint contract (also in `python/server.py` module docstring):

- `POST /parse` — multipart upload of a bill PDF; returns `ParserResult` JSON.
- `POST /compare` — JSON body; returns ranked plan-comparison JSON.
- `GET /health` — returns `{"status":"ok","service":"flip-python","version":"0.1.0"}`.

`SERVICE_AUTH_TOKEN` (Cloudflare secret of the same name) is sent as a
bearer token from the Worker and verified by the Flask app before any
parser is invoked.

## How to measure (benchmark harness)

`scripts/bench-python-deploy.py` measures the external-container path
today (cold start + per-parse latency against the deployed service). It
also documents the Pyodide measurement methodology so the comparison is
reproducible if/when the Pillow blocker is removed.

```bash
# Cold start: time from container wake-up to first successful /health
python scripts/bench-python-deploy.py --target container --cold-start

# Per-parse latency: 50 parses of python/tests/fixtures/sample_bill.pdf
python scripts/bench-python-deploy.py --target container --parse --iterations 50
```

Numbers are written to `bench-results.json` for trend tracking across
deploys.

## Status

- [x] Decision recorded (`python/DEPLOY.md`)
- [x] Benchmark harness committed (`scripts/bench-python-deploy.py`)
- [x] Epic 5 parsers deployed via this path (`python/Dockerfile` +
      `python/fly.toml`)
- [ ] Pyodide path revisited once Pillow wheel is published upstream.
