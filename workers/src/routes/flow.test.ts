/**
 * Issue #241 — /flow/status route tests (signed-link auth).
 *
 * AC coverage:
 *   - signed link → 200 on page AND json
 *   - expired/tampered → 401
 *   - no params + no Bearer → 401
 *   - Bearer alone → 200 (with ?u=)
 *   - phone param → 400 (removed)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { flowStatusPage, flowStatusJson, adminFlowLink } from './flow';
import { adminAuth } from '../middleware/adminAuth';
import * as users from '../models/users';
import * as flowTrace from '../services/flowTrace';
import { mintFlowLink } from '../services/flowLink';

const ENCRYPTION_KEY = 'test-encryption-key-32-bytes-aaaaaa';
const ADMIN_API_KEY = 'test-admin-key';
const USER_ID = 'u-flow-1';

/** In-memory KV mock (mirrors flowTrace.test.ts pattern). */
function makeKV(): KVNamespace & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, value: string) => { store.set(key, value); return Promise.resolve(); },
    delete: (key: string) => { store.delete(key); return Promise.resolve(); },
    list: () => Promise.resolve({ keys: [], list_complete: true }),
    getWithMetadata: (key: string) =>
      Promise.resolve({ value: store.get(key) ?? null, metadata: null }),
  } as unknown as KVNamespace & { store: Map<string, string> };
}

function buildApp(kv: KVNamespace): { app: Hono; signedLink: Promise<string> } {
  const app = new Hono();
  // /flow/* routes have NO adminAuth middleware now — auth is inside handlers.
  app.get('/flow/status', flowStatusPage);
  app.get('/flow/status.json', flowStatusJson);
  // /admin/flow-link inherits the /admin/* adminAuth (registered here).
  app.use('/admin/*', adminAuth);
  app.get('/admin/flow-link', adminFlowLink);
  return { app, signedLink: mintFlowLink(ENCRYPTION_KEY, USER_ID) };
}

describe('GET /flow/status — signed-link auth (#241)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 200 (HTML page) with a valid signed link', async () => {
    const kv = makeKV();
    const { app, signedLink } = buildApp(kv);
    const link = await signedLink;
    const res = await app.request(link, {}, { KV: kv, ENCRYPTION_KEY, ADMIN_API_KEY });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Pipeline Trace');
    expect(html).toContain(USER_ID);
  });

  it('returns 200 (JSON) with a valid signed link', async () => {
    const kv = makeKV();
    // Seed a trace so the JSON endpoint returns 200 (not 404).
    await flowTrace.startStage(kv, USER_ID, 'connect');
    const { app, signedLink } = buildApp(kv);
    const link = (await signedLink).replace('/flow/status', '/flow/status.json');
    const res = await app.request(link, {}, { KV: kv, ENCRYPTION_KEY, ADMIN_API_KEY });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string };
    expect(body.userId).toBe(USER_ID);
  });

  it('returns 401 when no params and no Bearer header', async () => {
    const kv = makeKV();
    const { app } = buildApp(kv);
    const res = await app.request('/flow/status', {}, { KV: kv, ENCRYPTION_KEY, ADMIN_API_KEY });
    expect(res.status).toBe(401);
  });

  it('returns 401 with a tampered userId (u)', async () => {
    const kv = makeKV();
    const { app, signedLink } = buildApp(kv);
    const link = await signedLink;
    const url = new URL('http://x' + link);
    url.searchParams.set('u', 'u-tampered');
    const res = await app.request(`/flow/status?${url.searchParams.toString()}`, {}, { KV: kv, ENCRYPTION_KEY, ADMIN_API_KEY });
    expect(res.status).toBe(401);
  });

  it('returns 401 with a tampered sig', async () => {
    const kv = makeKV();
    const { app, signedLink } = buildApp(kv);
    const link = await signedLink;
    const url = new URL('http://x' + link);
    const sig = url.searchParams.get('sig')!;
    url.searchParams.set('sig', sig.slice(0, -2) + (sig.endsWith('0') ? '1' : '0'));
    const res = await app.request(`/flow/status?${url.searchParams.toString()}`, {}, { KV: kv, ENCRYPTION_KEY, ADMIN_API_KEY });
    expect(res.status).toBe(401);
  });

  it('returns 401 with an expired signed link', async () => {
    const kv = makeKV();
    const { app } = buildApp(kv);
    // Expired exp in the past; sig won't match either, but assert 401.
    const pastExp = Math.floor(Date.now() / 1000) - 3600;
    const res = await app.request(
      `/flow/status?u=${USER_ID}&exp=${pastExp}&sig=deadbeef`,
      {},
      { KV: kv, ENCRYPTION_KEY, ADMIN_API_KEY }
    );
    expect(res.status).toBe(401);
  });

  it('returns 200 with admin Bearer + ?u= (no signed link)', async () => {
    const kv = makeKV();
    await flowTrace.startStage(kv, USER_ID, 'connect');
    const { app } = buildApp(kv);
    const res = await app.request(
      `/flow/status.json?u=${USER_ID}`,
      { headers: { Authorization: `Bearer ${ADMIN_API_KEY}` } },
      { KV: kv, ENCRYPTION_KEY, ADMIN_API_KEY }
    );
    expect(res.status).toBe(200);
  });

  it('returns 400 with admin Bearer but no ?u= (cannot resolve trace)', async () => {
    const kv = makeKV();
    const { app } = buildApp(kv);
    const res = await app.request(
      `/flow/status`,
      { headers: { Authorization: `Bearer ${ADMIN_API_KEY}` } },
      { KV: kv, ENCRYPTION_KEY, ADMIN_API_KEY }
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when the phone param is present (removed)', async () => {
    const kv = makeKV();
    const { app } = buildApp(kv);
    const res = await app.request(
      `/flow/status?phone=%2B64211234567`,
      {},
      { KV: kv, ENCRYPTION_KEY, ADMIN_API_KEY }
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when phone param present even with admin Bearer', async () => {
    const kv = makeKV();
    const { app } = buildApp(kv);
    const res = await app.request(
      `/flow/status.json?phone=%2B64211234567`,
      { headers: { Authorization: `Bearer ${ADMIN_API_KEY}` } },
      { KV: kv, ENCRYPTION_KEY, ADMIN_API_KEY }
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /admin/flow-link — signed-link minter (#241)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 401 without admin Bearer', async () => {
    const kv = makeKV();
    const { app } = buildApp(kv);
    const res = await app.request('/admin/flow-link?phone=%2B64211234567', {}, { KV: kv, ENCRYPTION_KEY, ADMIN_API_KEY });
    expect(res.status).toBe(401);
  });

  it('returns 400 when phone is missing', async () => {
    const kv = makeKV();
    const { app } = buildApp(kv);
    const res = await app.request(
      '/admin/flow-link',
      { headers: { Authorization: `Bearer ${ADMIN_API_KEY}` } },
      { KV: kv, ENCRYPTION_KEY, ADMIN_API_KEY, DB: {} as D1Database }
    );
    expect(res.status).toBe(400);
  });

  it('returns a signed {url} when phone resolves to a user', async () => {
    const kv = makeKV();
    vi.spyOn(users, 'getUserByPhone').mockResolvedValue({ id: USER_ID } as never);
    const { app } = buildApp(kv);
    const res = await app.request(
      '/admin/flow-link?phone=%2B64211234567',
      { headers: { Authorization: `Bearer ${ADMIN_API_KEY}` } },
      { KV: kv, ENCRYPTION_KEY, ADMIN_API_KEY, DB: {} as D1Database }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toContain('/flow/status?u=');
    expect(body.url).toContain('&exp=');
    expect(body.url).toContain('&sig=');
  });

  it('returns 404 when no user matches the phone', async () => {
    const kv = makeKV();
    vi.spyOn(users, 'getUserByPhone').mockResolvedValue(null);
    const { app } = buildApp(kv);
    const res = await app.request(
      '/admin/flow-link?phone=%2B64219999999',
      { headers: { Authorization: `Bearer ${ADMIN_API_KEY}` } },
      { KV: kv, ENCRYPTION_KEY, ADMIN_API_KEY, DB: {} as D1Database }
    );
    expect(res.status).toBe(404);
  });
});
