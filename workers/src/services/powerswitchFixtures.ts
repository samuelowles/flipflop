// AUTO-GENERATED from workers/tests/fixtures/powerswitch/*.html
// Inlined so tests run under @cloudflare/vitest-pool-workers (no node:fs).

export const contact_auckland_standard = '<!DOCTYPE html>\n<html lang="en-NZ">\n<head>\n  <meta charset="utf-8">\n  <title>Contact Energy — Good Nights — Powerswitch</title>\n  <meta name="retailer" content="Contact Energy">\n  <meta name="plan-name" content="Good Nights">\n  <meta name="region" content="Auckland">\n</head>\n<body>\n  <h1>Contact Energy</h1>\n  <h2 class="plan-name">Good Nights</h2>\n  <div class="plan-card"\n       data-retailer="Contact Energy"\n       data-plan-name="Good Nights"\n       data-region="Auckland"\n       data-variable-rate="28.54"\n       data-daily-charge="2.1" data-prompt-payment-discount="12" data-low-user-eligible="true">\n    <span class="rate c-per-kwh">28.54c/kWh</span>\n    <span class="rate c-per-day">2.1c/day</span>\n  </div>\n</body>\n</html>\n';

export const contact_wellington_lowuser = '<!DOCTYPE html>\n<html lang="en-NZ">\n<head>\n  <meta charset="utf-8">\n  <title>Contact Energy — Good Nights Low User — Powerswitch</title>\n  <meta name="retailer" content="Contact Energy">\n  <meta name="plan-name" content="Good Nights Low User">\n  <meta name="region" content="Wellington">\n</head>\n<body>\n  <h1>Contact Energy</h1>\n  <h2 class="plan-name">Good Nights Low User</h2>\n  <div class="plan-card"\n       data-retailer="Contact Energy"\n       data-plan-name="Good Nights Low User"\n       data-region="Wellington"\n       data-variable-rate="35.2"\n       data-daily-charge="0.65" data-low-user-eligible="true">\n    <span class="rate c-per-kwh">35.2c/kWh</span>\n    <span class="rate c-per-day">0.65c/day</span>\n  </div>\n</body>\n</html>\n';

export const drifted_structure = '<!DOCTYPE html>\n<html><head><title>Redesign</title></head>\n<body>\n  <div class="price-box"><span>$2.50/day</span><span>30.1c/kWh</span></div>\n</body></html>\n';

export const electric_kiwi_christchurch = '<!DOCTYPE html>\n<html lang="en-NZ">\n<head>\n  <meta charset="utf-8">\n  <title>Electric Kiwi — Fair Go — Powerswitch</title>\n  <meta name="retailer" content="Electric Kiwi">\n  <meta name="plan-name" content="Fair Go">\n  <meta name="region" content="Christchurch">\n</head>\n<body>\n  <h1>Electric Kiwi</h1>\n  <h2 class="plan-name">Fair Go</h2>\n  <div class="plan-card"\n       data-retailer="Electric Kiwi"\n       data-plan-name="Fair Go"\n       data-region="Christchurch"\n       data-variable-rate="27.8"\n       data-daily-charge="2.4" data-prompt-payment-discount="20">\n    <span class="rate c-per-kwh">27.8c/kWh</span>\n    <span class="rate c-per-day">2.4c/day</span>\n  </div>\n</body>\n</html>\n';

export const flick_incomplete = '<!DOCTYPE html>\n<html lang="en-NZ">\n<head><meta charset="utf-8"><title>Flick Electric — Flick LE</title>\n<meta name="retailer" content="Flick Electric">\n<meta name="plan-name" content="Flick LE">\n<meta name="region" content="Auckland"></head>\n<body>\n  <h1>Flick Electric</h1>\n  <h2 class="plan-name">Flick LE</h2>\n  <!-- incomplete: money fields missing (selector-drift / incompleteness case) -->\n  <div class="plan-card" data-retailer="Flick Electric" data-plan-name="Flick LE" data-region="Auckland">\n    <p>Pricing unavailable.</p>\n  </div>\n</body>\n</html>\n';

export const genesis_auckland_standard = '<!DOCTYPE html>\n<html lang="en-NZ">\n<head>\n  <meta charset="utf-8">\n  <title>Genesis Energy — Variable — Powerswitch</title>\n  <meta name="retailer" content="Genesis Energy">\n  <meta name="plan-name" content="Variable">\n  <meta name="region" content="Auckland">\n</head>\n<body>\n  <h1>Genesis Energy</h1>\n  <h2 class="plan-name">Variable</h2>\n  <div class="plan-card"\n       data-retailer="Genesis Energy"\n       data-plan-name="Variable"\n       data-region="Auckland"\n       data-variable-rate="30.05"\n       data-daily-charge="2.15" data-prompt-payment-discount="15">\n    <span class="rate c-per-kwh">30.05c/kWh</span>\n    <span class="rate c-per-day">2.15c/day</span>\n  </div>\n</body>\n</html>\n';

export const mercury_auckland_standard = '<!DOCTYPE html>\n<html lang="en-NZ">\n<head>\n  <meta charset="utf-8">\n  <title>Mercury — Open Variable — Powerswitch</title>\n  <meta name="retailer" content="Mercury">\n  <meta name="plan-name" content="Open Variable">\n  <meta name="region" content="Auckland">\n</head>\n<body>\n  <h1>Mercury</h1>\n  <h2 class="plan-name">Open Variable</h2>\n  <div class="plan-card"\n       data-retailer="Mercury"\n       data-plan-name="Open Variable"\n       data-region="Auckland"\n       data-variable-rate="29.1"\n       data-daily-charge="2.3" data-prompt-payment-discount="10">\n    <span class="rate c-per-kwh">29.1c/kWh</span>\n    <span class="rate c-per-day">2.3c/day</span>\n  </div>\n</body>\n</html>\n';

export const mercury_christchurch_tou = '<!DOCTYPE html>\n<html lang="en-NZ">\n<head>\n  <meta charset="utf-8">\n  <title>Mercury — Evolve TOU — Powerswitch</title>\n  <meta name="retailer" content="Mercury">\n  <meta name="plan-name" content="Evolve TOU">\n  <meta name="region" content="Christchurch">\n</head>\n<body>\n  <h1>Mercury</h1>\n  <h2 class="plan-name">Evolve TOU</h2>\n  <div class="plan-card"\n       data-retailer="Mercury"\n       data-plan-name="Evolve TOU"\n       data-region="Christchurch"\n       data-variable-rate="31.0"\n       data-daily-charge="2.5" data-prompt-payment-discount="8" data-tou="true">\n    <span class="rate c-per-kwh">31.0c/kWh</span>\n    <span class="rate c-per-day">2.5c/day</span>\n  </div>\n</body>\n</html>\n';

export const meridian_wellington_standard = '<!DOCTYPE html>\n<html lang="en-NZ">\n<head>\n  <meta charset="utf-8">\n  <title>Meridian Energy — Simple — Powerswitch</title>\n  <meta name="retailer" content="Meridian Energy">\n  <meta name="plan-name" content="Simple">\n  <meta name="region" content="Wellington">\n</head>\n<body>\n  <h1>Meridian Energy</h1>\n  <h2 class="plan-name">Simple</h2>\n  <div class="plan-card"\n       data-retailer="Meridian Energy"\n       data-plan-name="Simple"\n       data-region="Wellington"\n       data-variable-rate="28.9"\n       data-daily-charge="2.05" data-prompt-payment-discount="5">\n    <span class="rate c-per-kwh">28.9c/kWh</span>\n    <span class="rate c-per-day">2.05c/day</span>\n  </div>\n</body>\n</html>\n';

export const nova_auckland_lowuser = '<!DOCTYPE html>\n<html lang="en-NZ">\n<head>\n  <meta charset="utf-8">\n  <title>Nova Energy — Go Low User — Powerswitch</title>\n  <meta name="retailer" content="Nova Energy">\n  <meta name="plan-name" content="Go Low User">\n  <meta name="region" content="Auckland">\n</head>\n<body>\n  <h1>Nova Energy</h1>\n  <h2 class="plan-name">Go Low User</h2>\n  <div class="plan-card"\n       data-retailer="Nova Energy"\n       data-plan-name="Go Low User"\n       data-region="Auckland"\n       data-variable-rate="36.4"\n       data-daily-charge="0.7" data-low-user-eligible="true">\n    <span class="rate c-per-kwh">36.4c/kWh</span>\n    <span class="rate c-per-day">0.7c/day</span>\n  </div>\n</body>\n</html>\n';

export const powershop_auckland = '<!DOCTYPE html>\n<html lang="en-NZ">\n<head>\n  <meta charset="utf-8">\n  <title>Powershop — Variable Online — Powerswitch</title>\n  <meta name="retailer" content="Powershop">\n  <meta name="plan-name" content="Variable Online">\n  <meta name="region" content="Auckland">\n</head>\n<body>\n  <h1>Powershop</h1>\n  <h2 class="plan-name">Variable Online</h2>\n  <div class="plan-card"\n       data-retailer="Powershop"\n       data-plan-name="Variable Online"\n       data-region="Auckland"\n       data-variable-rate="29.75"\n       data-daily-charge="2.2" data-prompt-payment-discount="0">\n    <span class="rate c-per-kwh">29.75c/kWh</span>\n    <span class="rate c-per-day">2.2c/day</span>\n  </div>\n</body>\n</html>\n';

export const pulse_auckland_full = '<!DOCTYPE html>\n<html lang="en-NZ">\n<head>\n  <meta charset="utf-8">\n  <title>Pulse Energy — Variable Saver — Powerswitch</title>\n  <meta name="retailer" content="Pulse Energy">\n  <meta name="plan-name" content="Variable Saver">\n  <meta name="region" content="Auckland">\n</head>\n<body>\n  <h1>Pulse Energy</h1>\n  <h2 class="plan-name">Variable Saver</h2>\n  <div class="plan-card"\n       data-retailer="Pulse Energy"\n       data-plan-name="Variable Saver"\n       data-region="Auckland"\n       data-variable-rate="28.1"\n       data-daily-charge="2.0" data-prompt-payment-discount="11">\n    <span class="rate c-per-kwh">28.1c/kWh</span>\n    <span class="rate c-per-day">2.0c/day</span>\n  </div>\n</body>\n</html>\n';

export const trustpower_wellington = '<!DOCTYPE html>\n<html lang="en-NZ">\n<head>\n  <meta charset="utf-8">\n  <title>Trustpower — Stay Ahead — Powerswitch</title>\n  <meta name="retailer" content="Trustpower">\n  <meta name="plan-name" content="Stay Ahead">\n  <meta name="region" content="Wellington">\n</head>\n<body>\n  <h1>Trustpower</h1>\n  <h2 class="plan-name">Stay Ahead</h2>\n  <div class="plan-card"\n       data-retailer="Trustpower"\n       data-plan-name="Stay Ahead"\n       data-region="Wellington"\n       data-variable-rate="31.5"\n       data-daily-charge="2.6" data-prompt-payment-discount="8" data-tou="true">\n    <span class="rate c-per-kwh">31.5c/kWh</span>\n    <span class="rate c-per-day">2.6c/day</span>\n  </div>\n</body>\n</html>\n';

// ---------------------------------------------------------------------------
// Issue #220 — Powerswitch per-user address resolution fixtures.
// Captured SHAPES from the 2026-07-15 live walkthrough (issue #218). Tests mock
// `fetch` against these strings; no live calls ever run in CI. The shapes here
// are the authoritative contract powerswitchSession.ts validates against; if
// Powerswitch redeploys and these drift, the session resolver emits a
// `powerswitch_drift` structured error and returns a typed failure rather than
// persisting a partial/garbage guess.
// ---------------------------------------------------------------------------

/**
 * Autocomplete server-action response shape. Addressfinder-backed. The POST to
 * `https://www.powerswitch.org.nz/` returns a JSON array under `completions`,
 * each entry carrying the full address string (`a`), the Powerswitch address id
 * (`pxid`), and a version marker (`v`). `paid`/`success` are wrapper fields.
 */
export interface PowerswitchAutocompleteResponse {
  readonly completions: ReadonlyArray<{
    readonly a: string;
    readonly pxid: string;
    readonly v: number;
  }>;
  readonly paid: boolean;
  readonly success: boolean;
}

/**
 * Single, exact completion: "1 Queen Street, Auckland Central, Auckland 1010".
 * Used by the clean-address → auto-accept resolution path.
 */
export const autocomplete_single_match: PowerswitchAutocompleteResponse = {
  completions: [
    { a: '1 Queen Street, Auckland Central, Auckland 1010', pxid: '2-.1.6.6.1aoR.', v: 1 },
  ],
  paid: true,
  success: true,
};

/**
 * Ambiguous: the user gave a base address with no unit, but Powerswitch returns
 * multiple unit-level completions. The resolver picks the base (non-unit)
 * address when the user supplied no unit, else flags for manual review.
 */
export const autocomplete_ambiguous_units: PowerswitchAutocompleteResponse = {
  completions: [
    { a: '12 Birkdale Road, Birkdale, Auckland 0626', pxid: '2-.1.3.5.birkA.', v: 1 },
    { a: '12A Birkdale Road, Birkdale, Auckland 0626', pxid: '2-.1.3.5.birkB.', v: 1 },
    { a: '12B Birkdale Road, Birkdale, Auckland 0626', pxid: '2-.1.3.5.birkC.', v: 1 },
  ],
  paid: true,
  success: true,
};

/**
 * Zero completions — the address could not be matched. Must NOT persist a guess.
 */
export const autocomplete_zero_match: PowerswitchAutocompleteResponse = {
  completions: [],
  paid: false,
  success: true,
};

/**
 * Drift: Powerswitch redeploys and the response shape changes (e.g. the
 * `completions` key is renamed or restructured). The resolver detects this and
 * emits a `powerswitch_drift` error rather than silently persisting garbage.
 */
export const autocomplete_drift_response = {
  results: [{ full_address: '1 Queen Street, Auckland Central', id: 'abc' }],
  status: 'ok',
};

/**
 * Questionnaire redirect: GET /questionnaire/household?address_id={pxid}
 * resolves the pxid to an internal location id. The redirect target carries
 * the location id as a path segment (e.g. /questionnaire/266/...). The session
 * resolver extracts the first integer path segment as the location id.
 *
 * Captured shape (2026-07-15): a 303/307 redirect to a location-scoped URL, or
 * a 200 whose body contains a `<meta>` / link with the location id. We model
 * the redirect Location header here; the resolver reads `response.headers.get('Location')`.
 */
export const questionnaire_redirect_location_for_pxid =
  (pxid: string, locationId: number): Record<string, string> => ({
    Location: `/questionnaire/${locationId}/household?address_id=${encodeURIComponent(pxid)}`,
  });

/**
 * The resolved internal location id for the single-match fixture (Auckland
 * Central). 266 was observed in the 2026-07-15 walkthrough.
 */
export const SINGLE_MATCH_LOCATION_ID = '266';

