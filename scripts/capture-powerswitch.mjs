// scripts/capture-powerswitch.mjs
// ============================================================================
// #240 — REAL wire-protocol capture harness for powerswitch.org.nz.
//
// THE CARDINAL RULE (issue #240): capture first, code second. This script
// drives the live questionnaire for the fixture address and records EVERY
// request/response exchanged with the origin, so the wire layer can be rebuilt
// from observation rather than invention. Captures are the source of truth for
// every schema assertion in workers/src/services/powerswitch*.ts.
//
// COMPLIANCE (docs/POWERSWITCH_COMPLIANCE.md, Gate 1 satisfied 2026-07-16):
//   - One capture run (~10 requests). Well within the 200 req/day budget.
//   - Sequential, delayed navigation (the browser paces it naturally; we also
//     wait_for_load_state between steps).
//   - ICP is NEVER captured or replayed: the ICP step is skipped (we click the
//     site's "Skip"/"Not sure" control); no ICP value is typed or submitted.
//   - Cookies are STRIPPED from every saved artifact (set-cookie + Cookie
//     headers removed before writing).
//
// RUN (operator, one-time, from repo root):
//   npx playwright install chromium          # one-time browser download
//   npm --prefix scripts/.playwright install # one-time Playwright JS bindings (gitignored)
//   node scripts/capture-powerswitch.mjs
//
// Outputs sanitized pairs under workers/tests/fixtures/powerswitch-live/ :
//   NN-<slug>.req.txt   (method, URL, headers, raw body)
//   NN-<slug>.res.txt   (status, headers, raw body)
// ============================================================================

import { mkdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Playwright is NOT a project dependency. It resolves from the gitignored local
// install at scripts/.playwright/node_modules (see RUN above).
const pwUrl = new URL('./.playwright/node_modules/playwright/index.js', import.meta.url);
const pw = await import(pwUrl.href);
const chromium = pw.chromium ?? pw.default?.chromium;

const BASE = 'https://www.powerswitch.org.nz';
const ADDRESS = '1 Queen Street, Auckland Central, Auckland 1010';
const REPO_ROOT = dirname(fileURLToPath(import.meta.url)); // .../scripts
const OUT = join(dirname(REPO_ROOT), 'workers', 'tests', 'fixtures', 'powerswitch-live');
mkdirSync(OUT, { recursive: true });

const LOG = join(REPO_ROOT, 'capture-log.txt');
if (existsSync(LOG)) writeFileSync(LOG, '');
const log = (m) => { console.log(m); appendFileSync(LOG, m + '\n'); };

// Headers that must NEVER be persisted (session/PII).
const STRIP_REQ = new Set(['cookie', 'set-cookie']);
const STRIP_RES = new Set(['set-cookie', 'cookie']);

// Content types we care about for the wire protocol. Static assets are skipped.
const SKIP_EXT = /\.(js|css|woff2?|ttf|png|jpe?g|gif|svg|ico|webp|map|wasm|mp4|pdf)(\?|$)/i;

let counter = 0;
const written = [];

function slugFromUrl(method, url) {
  try {
    const u = new URL(url, BASE);
    if (method === 'POST' && (u.pathname === '/' || u.pathname === '')) return 'autocomplete';
    const parts = u.pathname.split('/').filter(Boolean); // drop leading ''
    if (parts[0] === 'questionnaire') return 'q-' + (parts.slice(1).join('-') || 'root');
    if (parts[0] === 'api' && parts[1] === 'locations') return 'api-locations-' + (parts[2] || '') + '-retailers';
    if (parts[0] === 'results') return 'results';
    if (parts[0] === 'questionnaire') return 'q-' + parts.join('-');
    return parts.join('-').slice(0, 40) || 'root';
  } catch {
    return 'req';
  }
}

function headerLines(headers, strip) {
  return Object.entries(headers)
    .filter(([k]) => !strip.has(k.toLowerCase()))
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

/** Capture a request/response pair (sanitized). */
async function capturePair(resp) {
  const req = resp.request();
  const url = req.url();
  // Only the origin; skip static assets.
  if (!url.startsWith(BASE)) return;
  if (SKIP_EXT.test(url)) return;
  const method = req.method();
  // Skip nav/header prefetch noise (footer link RSC prefetches). Keep only the
  // questionnaire wire: / (autocomplete POST), /questionnaire/*, /api/*, /results.
  if (method === 'GET') {
    try {
      const u = new URL(url, BASE);
      const p = u.pathname;
      const isWire = p === '/' || p.startsWith('/questionnaire') || p.startsWith('/api') || p.startsWith('/results');
      if (!isWire) return;
    } catch { /* keep */ }
  }
  const status = resp.status();
  const ct = (resp.headers()['content-type'] || '').toLowerCase();
  // Skip opaque static-ish types even without extension.
  if (/\b(image|font|wasm|video|text\/css|javascript|x-css)\b/.test(ct) && !/x-component|json|html|plain/.test(ct)) return;

  counter += 1;
  const n = String(counter).padStart(2, '0');
  const slug = slugFromUrl(method, url);

  // Request side.
  const reqHeaders = headerLines(req.headers(), STRIP_REQ);
  const postBody = req.postData() ?? '';
  const reqText =
    `${method} ${url.replace(BASE, '')}\n` +
    `# captured-from: ${url}\n` +
    `${reqHeaders}\n` +
    `\n---- body ----\n${postBody}\n`;
  writeFileSync(join(OUT, `${n}-${slug}.req.txt`), reqText);

  // Response side.
  let resBody = '';
  try {
    resBody = await resp.text();
  } catch (e) {
    resBody = `<body-unavailable: ${e.message}>`;
  }
  const resHeaders = headerLines(resp.headers(), STRIP_RES);
  const resText =
    `HTTP ${status}\n` +
    `${resHeaders}\n` +
    `\n---- body ----\n${resBody}\n`;
  writeFileSync(join(OUT, `${n}-${slug}.res.txt`), resText);

  written.push(`${n} ${method} ${status} ${url.replace(BASE, '')}  [${ct}]`);
  log(`  captured ${n} ${method} ${status} ${slug}  (${resBody.length}b)`);
}

// ----------------------------------------------------------------------------
// UI driving helpers
// ----------------------------------------------------------------------------

/**
 * Click the first control whose TRIMMED label text matches one of the regex
 * patterns. Matching is on innerText (RENDERED text), not textContent: the
 * option labels embed inline SVG icons whose `<style>` block leaks into
 * textContent (e.g. "None" reads as ".none_svg__cls-1{fill:none;…}"). innerText
 * excludes non-rendered <style>/<script> content, so "None" reads as "None".
 * We also normalise whitespace so anchored patterns like /^none$/i match.
 */
async function clickByText(page, patterns, logPrefix) {
  const sel = 'button, label, a, [role=button], [role=radio], [role=option], [role=checkbox], li';
  const els = page.locator(sel);
  const n = await els.count().catch(() => 0);
  // Snapshot normalised RENDERED text of every candidate once.
  const texts = [];
  for (let i = 0; i < n; i++) {
    const t = (await els.nth(i).innerText().catch(() => '') || '').replace(/\s+/g, ' ').trim();
    texts.push(t);
  }
  for (const pat of patterns) {
    const re = new RegExp(pat, 'i');
    for (let i = 0; i < n; i++) {
      if (texts[i] && re.test(texts[i])) {
        await els.nth(i).click({ timeout: 4000 }).catch((e) => log(`    ${logPrefix} click "${pat}" err: ${e.message}`));
        log(`    ${logPrefix} clicked "${texts[i]}" (matched ${pat})`);
        return pat;
      }
    }
  }
  log(`    ${logPrefix} NO option matched [${patterns.join(' | ')}]`);
  return null;
}

// The advance control is "Next step" on steps 1-5 and "View results" on the
// final (insulation) step. Match both.
const ADVANCE_RE = /^next step$|^continue$|^next$|^view results$/i;

function advanceLocator(page) {
  return page.locator('button, a, [role=button]').filter({ hasText: ADVANCE_RE });
}

/** True when an advance button exists AND is enabled (not disabled=""). */
async function isAdvanceEnabled(page) {
  const loc = advanceLocator(page);
  if (await loc.count().catch(() => 0) === 0) return false;
  return loc.first().isEnabled().catch(() => false);
}

/** Click the advance button (Next step / View results). */
async function clickAdvance(page) {
  const loc = advanceLocator(page);
  if (await loc.count().catch(() => 0) === 0) return false;
  await loc.first().click({ timeout: 8000 }).catch((e) => log(`    clickAdvance err: ${e.message}`));
  log('    clicked advance (next/view results)');
  return true;
}

async function clickNext(page) {
  // Back-compat wrapper (used by the address step + skip fallback).
  return clickAdvance(page);
}

/** Dump the current step's question + clickable options (for diagnostics). */
async function dumpStep(page) {
  const info = await page.evaluate(() => {
    const heading = document.querySelector('h1,h2,[class*=Question],[class*=title]')?.textContent?.trim().slice(0, 120) || '';
    const opts = Array.from(document.querySelectorAll('button, label, [role=radio], [role=option], [role=checkbox], input[type=radio]'))
      .map(el => (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 60))
      .filter(Boolean);
    return { url: location.pathname + location.search, heading, opts: [...new Set(opts)].slice(0, 25) };
  }).catch(() => ({ url: '(unknown)', heading: '(unknown)', opts: [] }));
  log(`  STEP ${info.url}  Q="${info.heading}"`);
  log(`    OPTIONS: ${JSON.stringify(info.opts)}`);
  return info;
}

// Answer map keyed by URL + heading keyword. Patterns tried in order; first
// match wins. ICP + current-retailer steps are SKIPPED (no ICP ever submitted).
const ANSWERS = [
  { match: /region/i, picks: [/^auckland$/i, /auckland/] },
  { match: /gas/i, picks: [/^none$/i, /no gas/i, /don.t have gas/i, /not connected/i, /no,? i don/i] },
  // Real label is "3-4 people" — do NOT anchor (/^3-4$/ never matches it).
  { match: /household|people|occupant/i, picks: [/3-4/i, /3 to 4/i, /three/i] },
  // The weekday-occupancy question (revealed on the SAME page as household size)
  // has plain "Yes"/"No" radio labels — NOT "not home"/"out during". Answer "No".
  { match: /home|weekday|daytime|during the day|occupancy/i, picks: [/^no$/i, /not home/i, /out during/i] },
  // Real label is "Electric hot water cylinder" — match on the distinctive tail.
  { match: /hot ?water|cylinder/i, picks: [/hot water cylinder/i, /electric.*cylinder/i, /^electric$/i] },
  { match: /heat/i, picks: [/heat pump/i, /heatpump/i] },
  { match: /air ?con|a\/c|ac\b|cooling|summer/i, picks: [/no,? i don/i, /^no$/i, /never/i, /not used/i] },
  { match: /insulat/i, picks: [/ceiling/i, /roof/i, /fully insulated/i, /top/i] },
];

// ----------------------------------------------------------------------------
// Drive
// ----------------------------------------------------------------------------

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent: 'FlipNZ-BillMonitor/1.0 (+https://flip.nz; issue #240 capture; contact: ops@flip.nz)',
  viewport: { width: 1280, height: 1000 },
});
ctx.on('response', (resp) => { capturePair(resp).catch((e) => log(`  capture err ${e.message}`)); });

const page = await ctx.newPage();
page.setDefaultTimeout(15000);

try {
  log('=== LOAD HOME ===');
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForLoadState('networkidle').catch(() => {});

  log('=== TYPE ADDRESS + AUTOCOMPLETE ===');
  await page.locator('#address').click();
  await page.fill('#address', ADDRESS);
  // react-select: options render with role=option (id react-select-N-option-K).
  // The exact-address match is option-0; click the [role=option] whose text matches.
  let picked = false;
  for (let i = 0; i < 25 && !picked; i++) {
    await page.waitForTimeout(300);
    const opt = page.locator('[role=option]').filter({ hasText: /Queen Street.*Auckland 1010/i });
    if (await opt.count().catch(() => 0) > 0) {
      await opt.first().click({ timeout: 4000 }).catch(() => {});
      picked = true;
      log('  selected autocomplete match (role=option)');
    }
  }
  if (!picked) log('  WARNING: autocomplete option not clicked');

  await page.waitForTimeout(800);
  await clickNext(page); // homepage Next — enabled once address selected
  await page.waitForLoadState('networkidle').catch(() => {});
  log(`  after-address URL: ${page.url()}`);

  // Walk the questionnaire steps. Stop at /results, after a stuck step, or
  // after a hard ceiling.
  let lastUrl = '';
  let stuck = 0;
  for (let step = 0; step < 25; step++) {
    const cur = page.url();
    if (cur.includes('/results')) { log('=== REACHED /results ==='); break; }
    if (cur === lastUrl) { stuck++; } else { stuck = 0; }
    lastUrl = cur;
    if (stuck >= 3) { log('=== STUCK on ' + cur + ' for 3 iterations — stopping driver ==='); break; }

    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1200); // etiquette pacing between steps
    const info = await dumpStep(page);

    // Skip-only steps (ICP + current retailer): never submit those values.
    const isIcp = /icp|meter|installation/i.test(info.url + info.heading);
    const isRetailer = /retailer|provider|company|currently with/i.test(info.url + info.heading);
    if (isIcp || isRetailer) {
      log(`    SKIP step (icp/retailer) — clicking skip/not-sure`);
      const skipped = await clickByText(page, [/skip/i, /not sure/i, /i don.?t know/i, /don.t know/i, /skip this/i], 'SKIP')
        || (await clickNext(page) ? 'next' : null);
      if (!skipped) log('    WARNING: could not skip — clicking next anyway');
      await page.waitForTimeout(800);
      continue;
    }

    // Answerable step. IMPORTANT: some pages hold MORE THAN ONE question on a
    // single URL — the household-size page reveals a second question ("Is someone
    // usually home on weekdays 9-5pm?") only AFTER the size is picked, and the
    // advance button stays disabled until BOTH are answered. Answering one
    // question then clicking a disabled Next is what stalled the earlier driver
    // (misread as bot protection). So: keep applying every answer map whose picks
    // match a visible option until the advance button enables, then click it.
    const beforeNext = page.url();
    for (let attempt = 0; attempt < 6 && page.url() === beforeNext; attempt++) {
      if (await isAdvanceEnabled(page)) {
        await clickAdvance(page); // "Next step" or "View results"
        try {
          await page.waitForURL((u) => u.toString() !== beforeNext, { timeout: 10000 });
        } catch {
          log('    URL did not change after advance');
        }
        break;
      }
      // Apply any answer map whose picks match an option currently on the page.
      // Re-clicking an already-selected radio is idempotent, so trying all
      // matching maps safely covers multi-question pages (size + occupancy).
      let answeredSomething = false;
      for (const a of ANSWERS) {
        const hit = await clickByText(page, a.picks, 'ANSWER');
        if (hit) answeredSomething = true;
      }
      if (!answeredSomething) log('    no answer map matched a visible option this attempt');
      await page.waitForTimeout(600);
    }
    log(`    -> ${page.url()}`);
  }

  // Final results flight fetch.
  log('=== RESULTS ===');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1500);
  log(`  final URL: ${page.url()}`);
} catch (e) {
  log('CAPTURE ERROR: ' + e.message + '\n' + (e.stack || ''));
} finally {
  // Give any in-flight response captures a moment to flush.
  await page.waitForTimeout(2500).catch(() => {});
  await browser.close();
  log('\n=== CAPTURED PAIRS ===');
  for (const w of written) log(w);
  log(`\nTotal: ${written.length} pairs in ${OUT}`);
  if (written.length === 0) {
    console.error('\n!! ZERO captures — capture failed. Do NOT proceed with invented fixtures. !!');
    process.exit(2);
  }
}
