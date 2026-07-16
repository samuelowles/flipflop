# Powerswitch live capture fixtures (issue #240)

Real request/response pairs captured from powerswitch.org.nz by
`scripts/capture-powerswitch.mjs`, for the fixture address **1 Queen Street,
Auckland Central, Auckland 1010**. These are the **source of truth** for the
parser + replay in `workers/src/services/powerswitch*.ts`. Every schema
assertion in that code must trace to a byte in these files. Regenerate with:

```
cd scripts/.playwright && npm install playwright   # one-time (gitignored)
node scripts/.playwright/node_modules/playwright/cli.js install chromium  # one-time
node scripts/capture-powerswitch.mjs               # writes NN-<slug>.{req,res}.txt here
```

Files are `NN-<slug>.req.txt` / `NN-<slug>.res.txt`, numbered in capture order.
Cookies are stripped. No ICP is ever entered or captured.

## Verified flow mechanics (2026-07-16) — supersedes earlier assumptions

The previous build was written against invented fixtures and was wrong on every
point below. Corrections, in order:

1. **The questionnaire is driven by POST server actions, not per-step form
   endpoints.** Each step navigates via a `GET /questionnaire/<step>?_rsc=…`
   prefetch, but the ANSWER is committed by a Next.js server action POST. Answers
   accumulate in a **server-side session profile keyed by cookie** — the client
   does not resend prior answers.

2. **Address → location is a POST server action returning JSON, NOT a redirect.**
   `POST /questionnaire/household?address_id={pxid}` returns
   `{result:{electricity_location:{id:267,…}, gas_location:{id:266,…}}}`
   (see `07-q-household.res.txt`). Any `resolveLocationId()` that regexes a
   `Location` header is wrong.

3. **The results token comes from the FINAL step's POST.**
   `POST /questionnaire/insulation` returns the full accumulated profile with
   `"id":"<token>"` and `"icp":{}` (empty — ICP is never needed). That token is
   used as `?p={token}` for the results calls (see `16-q-insulation.res.txt`).

4. **The plans data is ONLY in the `POST /results?p={token}` server-action
   response** (`18-results.res.txt`). The `GET /results?…&_rsc=…` variants are
   the page shell / navigation flight and carry `1:null` for the data. Parse the
   POST flight's `1:{…}` line.

5. **Real results schema** (in `18-results.res.txt`, line `1:`):
   - `household.usage.electricity` : number (annual kWh) + `electricity_monthly`: number[12]
     (also `gas`, `gas_monthly`, `dual`, `dual_monthly`).
   - `results[].plans[]`:
     - `id`: **number** (e.g. 176000) — stringify at the boundary.
     - `retailer_id`: **number** (e.g. 68) — map to our retailers via
       `GET /api/locations/{id}/retailers` (`08-…retailers.res.txt`), which is plain JSON.
     - `energy_type`, `fixed_term` (bool), `price_change_due` (bool `false` OR a date string).
     - `tariffs[]`: `{id, code, name, type, value:number, weight:number,
       display:bool, value_array:number[12], display_type:"amount"|"percentage",
       requires_bill_input:bool, register_content_code}`.
   - **register_content_code vocabulary (real, from this capture):**
     `PK`(peak), `OP`(off-peak — NOT "OFFPEAK"), `FREE`, `F`(fixed daily, weight 365),
     `TD3`(assumed % free, display_type percentage), plus `EC`, `ED`, `IN`, `PP`,
     `SH`, `UN`, and `""`. The parser's TOU logic keys on `PK`/`OP`.
   - Per-tariff there is **no** `description` field; long plan descriptions are
     separate text lines (`2:T7ba,…`) in the flight, referenced positionally.
   - This capture: **15 plans across 9 retailers** (1, 19, 24, 40, 45, 58, 59, 68, 75).

## Why the earlier automated capture stalled (it was NOT bot protection)

The `household-size` page (step 3) holds **two questions on one URL**: the size,
and then — revealed only after a size is chosen — "Is someone usually home on
weekdays between 9-5pm?". The Next button stays `disabled` until BOTH are
answered. The earlier driver answered only the size and concluded (wrongly) that
progression was blocked. `answerTwoPartHouseholdSize()` in the harness handles it.
Two more real gotchas the harness now handles: option labels embed inline SVG
icons whose `<style>` leaks into `textContent` (match on `innerText`), and the
final step's advance button reads "View results", not "Next step".
