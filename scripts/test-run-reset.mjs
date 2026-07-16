#!/usr/bin/env node
/**
 * #242 — Operator client for POST /admin/test-run/reset.
 *
 * Clears ONE user's per-user flow state (trace, replay cache, poll cursor, scan
 * progress, conversation state, and the notify/compare dedup+cooldown keys) so
 * the end-to-end /auth/gmail → switch flow can be re-run cleanly. The actual
 * deletion + key list lives server-side (routes/flow.ts → services/testRunReset.ts,
 * which imports the real KV key constants — no drift). This script holds NO key
 * strings; it just resolves the target and POSTs to the deployed Worker.
 *
 * Usage:
 *   npm run test-run:reset -- --phone +6421... [--url https://flip-api.<sub>.workers.dev] [--key $ADMIN_API_KEY]
 *   npm run test-run:reset -- --userId <id>
 *
 * --url defaults to $FLIP_API_URL; --key defaults to $ADMIN_API_KEY.
 * Run `npm run test-run:reset -- --help` for full flags.
 */

const HELP = `Usage: test-run-reset --phone <e164> | --userId <id> [options]

Clears one user's per-user flow state (KV) so the end-to-end flow can be re-run.
Delegates to POST /admin/test-run/reset (admin-authed). See docs/TESTING_RUN.md §5.

Options:
  --phone <e164>   User phone (E.164, e.g. +6421xxxxxxx). Resolved to userId server-side.
  --userId <id>    Target user id directly (skips phone lookup).
  --url <url>      Deployed Worker origin. Default: $FLIP_API_URL.
  --key <secret>   ADMIN_API_KEY. Default: $ADMIN_API_KEY.
  -h, --help       Show this help.

Examples:
  npm run test-run:reset -- --phone +64215558888
  npm run test-run:reset -- --userId 01HQ... --url https://flip-api.dev.workers.dev`;

function parseArgs(argv) {
  const args = { phone: undefined, userId: undefined, url: undefined, key: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--phone') args.phone = argv[++i];
    else if (a === '--userId') args.userId = argv[++i];
    else if (a === '--url') args.url = argv[++i];
    else if (a === '--key') args.key = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }

  if (!args.phone && !args.userId) {
    console.error('Error: provide --phone <e164> or --userId <id> (see --help).');
    process.exit(2);
  }
  const url = (args.url ?? process.env.FLIP_API_URL ?? '').replace(/\/$/, '');
  const key = args.key ?? process.env.ADMIN_API_KEY;
  if (!url) { console.error('Error: --url or $FLIP_API_URL is required.'); process.exit(2); }
  if (!key) { console.error('Error: --key or $ADMIN_API_KEY is required.'); process.exit(2); }

  const endpoint = `${url}/admin/test-run/reset`;
  const body = args.userId ? { userId: args.userId } : { phone: args.phone };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  if (!res.ok) {
    console.error(`Reset failed: HTTP ${res.status}`);
    console.error(JSON.stringify(json, null, 2));
    process.exit(1);
  }

  console.log(`Reset OK — user ${json.userId}, cleared ${json.count} key(s):`);
  for (const k of json.deleted ?? []) console.log(`  - ${k}`);
}

main().catch((err) => {
  console.error('Reset error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
