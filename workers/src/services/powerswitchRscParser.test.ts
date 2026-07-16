import { describe, it, expect, vi } from 'vitest';
import { parseRscResults, extractFlightRows, findFlightObject } from './powerswitchRscParser';
import { rsc_results_flight, rsc_results_flight_drift } from './powerswitchLiveFixtures';

/**
 * Issue #240 — RSC results parser, rebuilt against the REAL capture
 * (workers/tests/fixtures/powerswitch-live/18-results.res.txt). Strict schema
 * guard: drift on ANY shape mismatch, never a partial parse. No live calls.
 */
describe('extractFlightRows', () => {
  it('parses id:JSON lines into values', () => {
    const rows = extractFlightRows('0:{"a":1}\n1:{"b":2}\n');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ a: 1 });
    expect(rows[1]).toEqual({ b: 2 });
  });

  it('skips non-JSON / prose lines (the 2:T…/3:T… flight text)', () => {
    const rows = extractFlightRows('0:{"a":1}\nnot json\n2:[1,2]\n');
    expect(rows).toHaveLength(2);
  });

  it('extracts the payload row from the real results flight', () => {
    const rows = extractFlightRows(rsc_results_flight);
    const payload = rows.find(
      (r) => typeof r === 'object' && r !== null && !Array.isArray(r) && 'household' in (r as object)
    );
    expect(payload).toBeDefined();
  });
});

describe('findFlightObject', () => {
  it('returns the first object row containing the key', () => {
    expect(findFlightObject('0:["$@1",[]]\n1:{"completions":[{"a":"x"}]}', 'completions'))
      .toEqual({ completions: [{ a: 'x' }] });
  });

  it('returns null when no row carries the key', () => {
    expect(findFlightObject(rsc_results_flight, 'completions')).toBeNull();
  });
});

describe('parseRscResults — real capture (18-results.res.txt)', () => {
  it('parses the real flight to 15 plans across 9 retailers', () => {
    const out = parseRscResults(rsc_results_flight);
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;

    expect(out.results.plans).toHaveLength(15);
    const retailers = new Set(out.results.plans.map((p) => p.retailerId));
    // 1=Contact, 19=Meridian, 24=Genesis, 40=Octopus, 45=Hanergy,
    // 58=Pulse, 59=Powershop, 68=Electric Kiwi, 75=Mercury.
    expect(retailers.size).toBe(9);
    expect(retailers).toContain('Contact Energy');
    expect(retailers).toContain('Electric Kiwi');
    expect(retailers).toContain('Powershop');
  });

  it('reads usage from household.usage.electricity (NOT annual_kwh)', () => {
    const out = parseRscResults(rsc_results_flight);
    if (out.status !== 'ok') throw new Error('expected ok');
    expect(out.results.usage.annualKwh).toBe(7007.6875);
    expect(out.results.usage.monthlyKwh).toHaveLength(12);
    expect(out.results.usage.monthlyKwh[0]).toBeCloseTo(440.867, 1);
  });

  it('stringifies the NUMERIC plan id + reads retailer name at the boundary', () => {
    const out = parseRscResults(rsc_results_flight);
    if (out.status !== 'ok') throw new Error('expected ok');
    const first = out.results.plans[0]!;
    expect(first.id).toBe('176000'); // numeric 176000 → "176000"
    expect(first.name).toContain('Sunday Saver');
    expect(first.retailerId).toBe('Electric Kiwi'); // from plan.retailer.name
    expect(first.energyType).toBe('electricity');
    expect(first.fixedTerm).toBe(false);
    expect(first.priceChangeDue).toBe(false);
  });

  it('keeps the real register_content_code vocabulary (PK/OP, NOT OFFPEAK)', () => {
    const out = parseRscResults(rsc_results_flight);
    if (out.status !== 'ok') throw new Error('expected ok');
    const sundaySaver = out.results.plans.find((p) => p.id === '176000')!;
    const codes = new Set(sundaySaver.tariffs.map((t) => t.registerContentCode));
    // Real codes for 176000: PK, TD3, FREE, F, OP (NOT "OFFPEAK").
    expect(codes).toEqual(new Set(['PK', 'TD3', 'FREE', 'F', 'OP']));

    const peak = sundaySaver.tariffs.find((t) => t.registerContentCode === 'PK')!;
    expect(peak.value).toBe(0.3567); // $/kWh, ex-GST
    expect(peak.displayType).toBe('amount');
    const td3 = sundaySaver.tariffs.find((t) => t.registerContentCode === 'TD3')!;
    expect(td3.displayType).toBe('percentage');
    expect(td3.value).toBe(0.2685); // 26.85% free, encoded as a fraction
  });

  it('captures price_change_due=true on the Broadband Bundle (174456)', () => {
    const out = parseRscResults(rsc_results_flight);
    if (out.status !== 'ok') throw new Error('expected ok');
    const bundle = out.results.plans.find((p) => p.id === '174456')!;
    expect(bundle.priceChangeDue).toBe(true);
    const others = out.results.plans.filter((p) => p.id !== '174456');
    expect(others.every((p) => p.priceChangeDue === false)).toBe(true);
  });

  it('does NOT carry per-tariff description/prices_last_changed (real: plan-level)', () => {
    const out = parseRscResults(rsc_results_flight);
    if (out.status !== 'ok') throw new Error('expected ok');
    const t = out.results.plans[0]!.tariffs[0]!;
    expect(t).not.toHaveProperty('description');
    expect(t).not.toHaveProperty('pricesLastChanged');
  });
});

describe('parseRscResults — strict schema guard (drift, fail-closed)', () => {
  it('rejects the drift variant (usage field renamed electricity→annual_kwh)', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = parseRscResults(rsc_results_flight_drift);
    expect(out.status).toBe('drift');
    if (out.status === 'drift') expect(out.reason).toBe('usage_electricity_not_number');
    const logged = errSpy.mock.calls.find((c) => String(c[0]).includes('powerswitch_schema_drift'));
    expect(logged).toBeDefined();
    errSpy.mockRestore();
  });

  it('drifts when the household block is missing', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseRscResults('1:{"results":[]}').status).toBe('drift');
    errSpy.mockRestore();
  });

  it('drifts when results block is missing', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const flight = '1:{"household":{"usage":{"electricity":1000,"electricity_monthly":' +
      '[1,2,3,4,5,6,7,8,9,10,11,12]}}}';
    expect(parseRscResults(flight).status).toBe('drift');
    errSpy.mockRestore();
  });

  it('drifts when a plan id is not numeric (the old invented shape)', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const flight = '1:{"household":{"usage":{"electricity":100,"electricity_monthly":' +
      '[1,1,1,1,1,1,1,1,1,1,1,1]}},' +
      '"results":[{"plans":[{"id":"abc","name":"x","retailer_id":1,"energy_type":"electricity",' +
      '"fixed_term":false,"price_change_due":false,"tariffs":[]}]}]}';
    const out = parseRscResults(flight);
    expect(out.status).toBe('drift');
    if (out.status === 'drift') expect(out.reason).toBe('plan_id_not_number');
    errSpy.mockRestore();
  });

  it('drifts when a tariff display_type is invalid', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const flight = '1:{"household":{"usage":{"electricity":100,"electricity_monthly":' +
      '[1,1,1,1,1,1,1,1,1,1,1,1]}},' +
      '"results":[{"plans":[{"id":1,"name":"x","retailer_id":1,"energy_type":"electricity",' +
      '"fixed_term":false,"price_change_due":false,"tariffs":[{"code":"F","name":"d","value":1,' +
      '"display_type":"dollars","register_content_code":"F"}]}]}]}';
    const out = parseRscResults(flight);
    expect(out.status).toBe('drift');
    if (out.status === 'drift') expect(out.reason).toBe('tariff_display_type_invalid');
    errSpy.mockRestore();
  });

  it('NEVER returns partial results on drift', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = parseRscResults(rsc_results_flight_drift);
    expect(out.status).toBe('drift');
    if (out.status === 'drift') {
      expect((out as { results?: unknown }).results).toBeUndefined();
    }
    errSpy.mockRestore();
  });
});
