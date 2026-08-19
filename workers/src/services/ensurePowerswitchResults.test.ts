import { describe, it, expect, vi, beforeEach } from 'vitest';

// #242 live-run fixes — unit checks for the pipeline wiring helper and the
// retailer-slug hint mapping (both found broken/missing in the live test run).

vi.mock('../models/users', () => ({ getUserById: vi.fn() }));
vi.mock('./powerswitchSession', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./powerswitchSession')>();
  return { ...orig, resolveUserAddress: vi.fn() };
});
vi.mock('./powerswitchReplay', () => ({
  replayQuestionnaire: vi.fn(),
  readCachedResults: vi.fn(),
  clearCachedResults: vi.fn(async () => undefined),
}));

import { ensurePowerswitchResults } from './ensurePowerswitchResults';
import { getUserById } from '../models/users';
import { resolveUserAddress } from './powerswitchSession';
import { replayQuestionnaire, readCachedResults, clearCachedResults } from './powerswitchReplay';
import { retailerParserSlug } from '../models/retailers';
import type { User } from '../types/user';
import type { ParsedResults } from './powerswitchRscParser';

const RESULTS = { usage: { annualKwh: 7000, monthlyKwh: [] }, plans: [{}] } as unknown as ParsedResults;
const ENV = { DB: {} as D1Database, KV: {} as KVNamespace, ENCRYPTION_KEY: 'k', POWERSWITCH_LIVE: 'true' };

function user(): User {
  return {
    id: 'u1', phone: '+6421', installationAddress: '1 Queen Street, Auckland',
    powerswitchPxid: null,
  } as unknown as User;
}

describe('ensurePowerswitchResults (#242 pipeline wiring)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns cached results when the pxid is intact (no live path)', async () => {
    // The user read is now unavoidable on a cache hit: a null pxid is the
    // address-changed signal, so we must load the user to confirm the pxid is
    // still intact before trusting a cached entry.
    vi.mocked(readCachedResults).mockResolvedValueOnce(RESULTS);
    vi.mocked(getUserById).mockResolvedValueOnce({ ...user(), powerswitchPxid: 'px9' } as User);
    const out = await ensurePowerswitchResults(ENV, 'u1');
    expect(out).toEqual({ status: 'ok', results: RESULTS, source: 'cache' });
    expect(replayQuestionnaire).not.toHaveBeenCalled();
    expect(resolveUserAddress).not.toHaveBeenCalled();
    expect(clearCachedResults).not.toHaveBeenCalled();
  });

  it('treats cached results as stale and clears them when the pxid is null (address changed)', async () => {
    // billParser nulls powerswitchPxid on a move; a null pxid means any cached
    // results belong to the PREVIOUS property, so they must be dropped and the
    // live path must run to rebuild for the new address.
    vi.mocked(readCachedResults).mockResolvedValueOnce(RESULTS);
    vi.mocked(getUserById).mockResolvedValueOnce(user()); // pxid null
    vi.mocked(resolveUserAddress).mockResolvedValueOnce({ status: 'resolved', pxid: 'px2', locationId: '267', confidence: 'exact' });
    vi.mocked(replayQuestionnaire).mockResolvedValueOnce({ status: 'ok', results: RESULTS, cached: false });
    const out = await ensurePowerswitchResults(ENV, 'u1');
    expect(out).toEqual({ status: 'ok', results: RESULTS, source: 'live' });
    // Stale cache cleared before rebuilding.
    expect(clearCachedResults).toHaveBeenCalledWith(expect.anything(), 'u1');
    expect(replayQuestionnaire).toHaveBeenCalledWith(expect.anything(), 'u1', 'px2');
  });

  it('is unavailable when POWERSWITCH_LIVE is off (no live calls)', async () => {
    vi.mocked(readCachedResults).mockResolvedValueOnce(null);
    const out = await ensurePowerswitchResults({ ...ENV, POWERSWITCH_LIVE: 'false' }, 'u1');
    expect(out).toEqual({ status: 'unavailable', reason: 'live_disabled' });
    expect(resolveUserAddress).not.toHaveBeenCalled();
  });

  it('resolves the address then replays when the user has no pxid', async () => {
    vi.mocked(readCachedResults).mockResolvedValueOnce(null);
    vi.mocked(getUserById).mockResolvedValueOnce(user());
    vi.mocked(resolveUserAddress).mockResolvedValueOnce({ status: 'resolved', pxid: 'px1', locationId: '267', confidence: 'exact' });
    vi.mocked(replayQuestionnaire).mockResolvedValueOnce({ status: 'ok', results: RESULTS, cached: false });
    const out = await ensurePowerswitchResults(ENV, 'u1');
    expect(out).toEqual({ status: 'ok', results: RESULTS, source: 'live' });
    expect(resolveUserAddress).toHaveBeenCalledWith(expect.anything(), 'u1', '1 Queen Street, Auckland');
    expect(replayQuestionnaire).toHaveBeenCalledWith(expect.anything(), 'u1', 'px1');
  });

  it('skips resolution when the user already has a pxid', async () => {
    vi.mocked(readCachedResults).mockResolvedValueOnce(null);
    vi.mocked(getUserById).mockResolvedValueOnce({ ...user(), powerswitchPxid: 'px9' } as User);
    vi.mocked(replayQuestionnaire).mockResolvedValueOnce({ status: 'ok', results: RESULTS, cached: false });
    const out = await ensurePowerswitchResults(ENV, 'u1');
    expect(out.status).toBe('ok');
    expect(resolveUserAddress).not.toHaveBeenCalled();
  });

  it('is unavailable (with inner reason) when address resolution fails', async () => {
    vi.mocked(readCachedResults).mockResolvedValueOnce(null);
    vi.mocked(getUserById).mockResolvedValueOnce(user());
    vi.mocked(resolveUserAddress).mockResolvedValueOnce({ status: 'error', reason: 'HTTP 500' });
    const out = await ensurePowerswitchResults(ENV, 'u1');
    expect(out).toEqual({ status: 'unavailable', reason: 'address_error: HTTP 500' });
    expect(replayQuestionnaire).not.toHaveBeenCalled();
  });

  it('is unavailable when the user has no installation address', async () => {
    vi.mocked(readCachedResults).mockResolvedValueOnce(null);
    vi.mocked(getUserById).mockResolvedValueOnce({ ...user(), installationAddress: null } as User);
    const out = await ensurePowerswitchResults(ENV, 'u1');
    expect(out).toEqual({ status: 'unavailable', reason: 'no_installation_address' });
  });
});

describe('retailerParserSlug (#242 UUID→slug hint fix)', () => {
  it('maps all 10 seeded retailer names to their python parser slugs', () => {
    expect(retailerParserSlug('Contact Energy')).toBe('contact');
    expect(retailerParserSlug('Mercury')).toBe('mercury');
    expect(retailerParserSlug('Genesis Energy')).toBe('genesis');
    expect(retailerParserSlug('Meridian Energy')).toBe('meridian');
    expect(retailerParserSlug('Trustpower')).toBe('trustpower');
    expect(retailerParserSlug('Nova Energy')).toBe('nova');
    expect(retailerParserSlug('Electric Kiwi')).toBe('electric_kiwi');
    expect(retailerParserSlug('Powershop')).toBe('powershop');
    expect(retailerParserSlug('Flick Electric')).toBe('flick');
    expect(retailerParserSlug('Pulse Energy')).toBe('pulse');
  });
});
