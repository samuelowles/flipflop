#!/usr/bin/env node
/**
 * Fail the build when the Worker reads an env value the operator is never told
 * to set.
 *
 * WHY THIS EXISTS. `docs/TESTING_RUN.md` §1b listed the secrets to provision and
 * claimed to be exhaustive: "Enumerated from `grep -rhoE "env\.[A-Z][A-Z0-9_]+"
 * workers/src` — no hand-waving." That pattern requires a literal `env.`, so it
 * silently missed `env?.SENT_WEBHOOK_SECRET` in middleware/sentAuth.ts — the one
 * place the codebase uses optional chaining on env.
 *
 * The consequence was not subtle. Provision exactly what the runbook lists,
 * deploy, and sentAuth hits `if (!secret) return 500 'Authentication
 * misconfigured'` on EVERY inbound webhook: no bill forwarded over WhatsApp is
 * ever received, `stop` never arrives, `delete my data` never arrives. The whole
 * inbound half of the product is dead, and nothing in the test suite notices
 * because every test supplies its own env.
 *
 * A prose list that has to be re-derived by hand will drift again. This makes
 * the drift a build failure instead.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'workers', 'src');
// 2026-08-18: TESTING_RUN.md and DEPLOY.md were merged into OPERATIONS.md, which
// is now the canonical secrets list. Both originals are in docs/history/.
const RUNBOOK = join(ROOT, 'docs', 'OPERATIONS.md');
const WRANGLER = join(ROOT, 'workers', 'wrangler.toml');

/** Optional chaining included — that omission is the whole point of this file. */
const ENV_READ = /env\??\.([A-Z][A-Z0-9_]+)/g;

/**
 * Names that are bindings or build-time injections, not operator-set secrets.
 * Bindings come from wrangler.toml; TEST_MIGRATIONS is injected by the e2e pool.
 */
const NOT_A_SECRET = new Set([
  'DB', 'KV', 'BILLS', 'PARSE_QUEUE', 'COMPARE_QUEUE', 'NOTIFY_QUEUE',
  'RATE_LIMITER', 'TEST_MIGRATIONS',
]);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.ts$/.test(entry) && !/\.test\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

const referenced = new Set();
for (const file of walk(SRC)) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(ENV_READ)) referenced.add(m[1]);
}

const runbook = readFileSync(RUNBOOK, 'utf8');
// Non-secret [vars] live in wrangler.toml; those are committed, not provisioned.
const wrangler = readFileSync(WRANGLER, 'utf8');

const undocumented = [...referenced]
  .filter((name) => !NOT_A_SECRET.has(name))
  .filter((name) => !runbook.includes(name) && !wrangler.includes(name))
  .sort();

if (undocumented.length > 0) {
  console.error(
    'Env values the Worker reads but the operator is never told to set:\n' +
    undocumented.map((n) => `  - ${n}`).join('\n') +
    `\n\nAdd each to docs/OPERATIONS.md §2 (or to wrangler.toml [vars] if it is` +
    ` not a secret).\nAn unset secret is not a warning at runtime — sentAuth` +
    ` returns 500 on every inbound webhook.\n`
  );
  process.exit(1);
}

console.log(
  `env-docs OK — ${referenced.size} env references checked, ` +
  `all documented or declared as bindings.`
);
