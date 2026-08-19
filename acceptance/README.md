# Acceptance probes

A live probe suite that tests the **deployed product** against the product
documentation (`docs/PRD.md`), not against unit-test assertions. Where the
workers unit suite asks "does this function behave as written?", a probe asks
"does the running system do what the PRD claims?" — over HTTP, against a real
deployment. Each probe is an executable proof of one numbered PRD claim
(`PRD §6.1`, `PRD §8.3`, …) recorded in `manifest.json`.

## Running

```bash
node acceptance/run.mjs                  # every implemented probe
node acceptance/run.mjs --probe 002-stop-honoured   # one probe
```

Exit code is non-zero only when an implemented probe **fails**, when the base
URL points at production or an undeclared host, or on a usage error. Skips
and unproven claims exit 0 — they are a reported gap, not a failure. Every
run prints the coverage gap, e.g.:

```
coverage: 3/25 PRD claims have an executable probe — 22 declared with no proof
  unproven: PRD §4.1, PRD §4.2, ...
```

## The base URL contract

- `FLIP_ACCEPTANCE_BASE_URL` selects the deployment under test. If it is unset
  or empty, **every probe skips**, naming the variable — no probe issues any
  network request.
- The runner hard-errors (never skips) if that URL's host is production, or is
  a host that has not been declared staging via `FLIP_ACCEPTANCE_STAGING_HOSTS`
  (comma-separated; production can never be declared). Production means
  `flipflop.co.nz` and any subdomain — where the product is going — and
  `flip-api.<subdomain>.workers.dev`, the Worker actually serving production
  today. This refusal lives in `run.mjs` so no probe can bypass it.
- Probes issue reads and scenario-scoped writes against staging only — never
  destructive requests, never a production database.
- Probes may need fixtures or credentials: `FLIP_ACCEPTANCE_MIDBAND_PDF`,
  `FLIP_ACCEPTANCE_UNRECONCILED_PDF` (curated bill PDFs),
  `FLIP_ACCEPTANCE_ADMIN_KEY` (reads `GET /admin/notifications`),
  `FLIP_ACCEPTANCE_SENT_WEBHOOK_SECRET` (signs a `POST /webhook/messaging`
  inbound). A probe missing its own prerequisite skips, naming it.

## Writing a probe

1. Create `acceptance/probes/<nnn>-<slug>.mjs` with a default export:

   ```js
   import { skip, assert } from "../lib/probe.mjs";

   export default {
     id: "004-my-probe",
     claim: "PRD §7.2",
     describes: "one line: the doc claim in plain words",
     async run(ctx) {
       if (!ctx.baseUrl) throw skip("FLIP_ACCEPTANCE_BASE_URL is not set — no staging deployment to probe");
       const res = await ctx.fetch("/health");        // ctx: { baseUrl, fetch, log }
       assert(res.ok, `GET /health came back ${res.status}`);
     },
   };
   ```

   Return to pass; throw any `Error` to fail; throw `skip(reason)` to skip.
   No assertion library — `skip` and `assert` from `lib/probe.mjs` are the
   whole vocabulary. Write HTTP calls against the routes as they exist in
   `workers/src/index.ts`, and mark anything unverifiable without staging with
   a `TODO(staging):` comment rather than guessing.
2. Flip that claim's entry in `manifest.json` from `"file": null` to the path
   relative to `acceptance/` (e.g. `"probes/004-my-probe.mjs"`) and set a real
   `owner`. `lastGreen` is maintained by the runner: a passing run stamps it
   with an ISO-8601 UTC timestamp; skips, fails and unimplemented claims leave
   the manifest byte-identical.

## The manifest and drift

Every numbered section heading in `docs/PRD.md` must have a `manifest.json`
entry whose `claim` matches exactly, or `engine/drift.mjs` fails the branch.
The 22 `file: null` entries are an honest inventory of documented claims with
no executable proof yet — not a silencer. Adding a PRD section means adding a
manifest entry in the same change; implementing a probe means flipping its
entry's `file` and `owner`. Never edit `engine/drift-exemptions.json` to work
around this check.
