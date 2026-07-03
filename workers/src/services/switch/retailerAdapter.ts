/**
 * Issue #131 (Epic #8) — Retailer switch adapter.
 *
 * DOMAIN REALITY (audited): NZ electricity retailers (Contact, Mercury,
 * Meridian, Genesis, Nova, Frank, Flick, etc.) have NO public switch /
 * plan-change API. A third party cannot programmatically move a customer
 * between retailers. The honest, realistic implementation is a SIGNED
 * DEEP-LINK fallback: build a URL to the retailer's public plan/switch page,
 * attach an opaque signed token so the click is attributable to this switch
 * record, and hand it back to the user. The actual switch is then tracked
 * through the #129 state machine + later webhook/manual confirmation.
 *
 * The AC title itself says "(or graceful fallback)" — the fallback IS the
 * deliverable. Do NOT pretend to call a real API.
 *
 * SEAM: the `RetailerAdapter` interface + `getRetailerAdapter` factory let a
 * future per-retailer real-API implementation slot in without touching the
 * route or switchService. Today every retailer resolves to `DeepLinkAdapter`.
 */

import type { Switch } from '../../types/switch';
import type { Retailer } from '../../types/retailer';
import type { EncryptionEnv } from '../../models/encryption';

/** Result of asking a retailer adapter to action a switch. */
export interface RetailerSwitchResult {
  /** Absolute URL the user follows to action the switch on the retailer site. */
  readonly deepLink: string;
  /** How the link was produced — today always `deep_link`. Future: `api`. */
  readonly method: 'deep_link' | 'api';
}

/** Input to a retailer adapter. */
export interface RetailerSwitchInput {
  readonly switch: Switch;
  readonly retailer: Retailer;
  /** Target plan code/name, if known — passed through to the retailer page. */
  readonly planCode?: string | null;
}

/**
 * Per-retailer switch adapter. Today there is one implementation
 * (`DeepLinkAdapter`); the interface is the seam for future real-API adapters
 * (one per retailer that ever exposes one).
 */
export interface RetailerAdapter {
  requestSwitch(input: RetailerSwitchInput): Promise<RetailerSwitchResult>;
}

// ---------------------------------------------------------------------------
// Retailer switch-URL config map.
//
// ponytail: a static config map (retailerId → base switch URL) over a DB
// column. There are ~25 NZ retailers; a config map is cheaper to maintain
// than a migration and lives in code review where it belongs. Retailers not
// listed fall through to a domain-derived default (`https://<domain>/join`).
//
// URLs are best-effort PUBLIC sign-up / switch pages — no PII is encoded into
// the query string. The only query param appended is an opaque signed token
// (`s=<hmac>`) so the click is attributable to this switch record server-side
// without leaking user identity. Source: each retailer's public website
// (verified July 2026). Verify before relying in production.
// ---------------------------------------------------------------------------

const RETAILER_SWITCH_URLS: ReadonlyMap<string, string> = new Map([
  // Migration 0002 seeds (10 primary retailers)
  ['ffcfa737-7546-4d1f-9f5e-8bfa1e6fc31a', 'https://contact.co.nz/join'], // Contact Energy
  ['2951d6b6-436e-474b-8ea9-7fb5092cc069', 'https://www.mercury.co.nz/join'], // Mercury
  ['a20f39b2-7f2c-48ef-8b17-12886402e2fd', 'https://www.genesisenergy.co.nz/switch'], // Genesis
  ['5efa7fa6-0ec7-4f81-b3cf-229951b3896b', 'https://www.meridianenergy.co.nz/join'], // Meridian
  ['92a506ac-2ca0-4ff3-a46e-3a27d850ce6a', 'https://www.trustpower.co.nz/join'], // Trustpower
  ['02b3f36d-27b2-475b-bc08-2863e2cc96c9', 'https://www.novaenergy.co.nz/join'], // Nova
  ['9b60928a-0d44-4b49-8d76-bb0e6295c63d', 'https://www.electrickiwi.co.nz/join'], // Electric Kiwi
  ['989a6f4d-bf36-4c0b-b920-43679aecf9a0', 'https://www.powershop.co.nz/join'], // Powershop
  ['41f1cccd-ee33-4f96-b9be-925d5ee399e9', 'https://www.flickelectric.co.nz/join'], // Flick
  ['a14a71cc-a945-4fc2-a72f-80779a746429', 'https://www.pulseenergy.co.nz/join'], // Pulse
]);

/**
 * Resolve the switch base URL for a retailer. Known retailers use the explicit
 * config map; unknown retailers fall back to a domain-derived default so the
 * deep-link is still useful (graceful default — AC "fall-through adapter").
 */
function resolveBaseUrl(retailer: Retailer): string {
  const explicit = RETAILER_SWITCH_URLS.get(retailer.id);
  if (explicit) return explicit;
  if (retailer.domain) return `https://${retailer.domain}/join`;
  // Last-resort default — should not occur for seeded retailers.
  return 'https://switch.powerswitch.co.nz/';
}

// ---------------------------------------------------------------------------
// Opaque attribution token (HMAC-SHA256).
//
// The token is `switchId:hexHmac(switchId)`. It is opaque to the retailer and
// carries NO PII (no user id, phone, email, or name). Server-side we can recompute
// the HMAC from the `switchId` prefix to confirm the click came from us and tie it
// back to the switch record for analytics / state-machine advancement.
//
// ponytail: there is no shared HMAC sign helper in the repo (sentAuth computes
// HMAC inline over webhook bodies; encryption.ts exposes only SHA-256 digest).
// A 6-line helper here is simpler than introducing a new crypto util module for
// a single call site. Reuse opportunity is noted for whenever a second caller
// appears.
// ---------------------------------------------------------------------------

async function hmacHex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Build the opaque attribution token for a switch. Token shape:
 * `<switchId>.<hexHmac(switchId)>`. The retailer never sees user identity.
 */
async function buildAttributionToken(
  env: EncryptionEnv,
  switchId: string
): Promise<string> {
  const mac = await hmacHex(env.ENCRYPTION_KEY, switchId);
  return `${switchId}.${mac}`;
}

// ---------------------------------------------------------------------------
// DeepLinkAdapter — the one shipped adapter.
// ---------------------------------------------------------------------------

/** Options used by tests to stub env-derived bits without touching secrets. */
export interface DeepLinkAdapterOptions {
  readonly env: EncryptionEnv;
}

/** Deep-link-only adapter: builds a retailer switch URL + signed token. */
export class DeepLinkAdapter implements RetailerAdapter {
  private readonly env: EncryptionEnv;

  constructor(opts: DeepLinkAdapterOptions) {
    this.env = opts.env;
  }

  async requestSwitch(input: RetailerSwitchInput): Promise<RetailerSwitchResult> {
    const base = resolveBaseUrl(input.retailer);
    const token = await buildAttributionToken(this.env, input.switch.id);
    const url = new URL(base);
    url.searchParams.set('s', token);
    if (input.planCode) {
      url.searchParams.set('plan', input.planCode);
    }
    return { deepLink: url.toString(), method: 'deep_link' };
  }
}

/**
 * Factory: resolve the adapter for a retailer. Today every retailer uses the
 * deep-link path; this is the seam a future real-API adapter plugs into:
 *
 *   if (retailer.id === CONTACT_WITH_API_ID) return new ContactApiAdapter();
 *
 * Unknown retailers gracefully default to the deep-link adapter.
 */
export function getRetailerAdapter(retailerId: string, env: EncryptionEnv): RetailerAdapter {
  // retailerId is accepted but currently unused — the deep-link path serves all
  // retailers. The param exists so the future per-retailer switch lands here.
  void retailerId;
  return new DeepLinkAdapter({ env });
}

// ---------------------------------------------------------------------------
// Entry point — called by routes/switch.ts after createSwitch succeeds.
// ---------------------------------------------------------------------------

export interface RequestRetailerSwitchArgs {
  readonly switch: Switch;
  readonly retailer: Retailer;
  readonly planCode?: string | null;
}

/**
 * Build the retailer deep-link for a freshly-created switch. Used by the
 * POST /api/switch route to populate `switch_url` in the 201 response.
 *
 * Logs the request with request_id + retailer (AC #131 "All calls logged
 * with request_id and retailer"). The caller (route) owns request_id; this
 * helper emits a structured log line tagged with the retailer and switch id.
 */
export async function requestRetailerSwitch(
  env: EncryptionEnv,
  args: RequestRetailerSwitchArgs
): Promise<RetailerSwitchResult> {
  const adapter = getRetailerAdapter(args.retailer.id, env);
  const requestId = crypto.randomUUID();
  console.log(
    JSON.stringify({
      level: 'info',
      type: 'retailer_switch_request',
      request_id: requestId,
      retailer_id: args.retailer.id,
      retailer_name: args.retailer.name,
      switch_id: args.switch.id,
      method: 'deep_link',
      timestamp: new Date().toISOString(),
    })
  );
  return adapter.requestSwitch({
    switch: args.switch,
    retailer: args.retailer,
    planCode: args.planCode,
  });
}
