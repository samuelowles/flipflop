import { describe, it, expect, vi } from 'vitest';
import { parseRscResults, extractFlightRows } from './powerswitchRscParser';
import { rsc_results_flight, rsc_results_flight_drift } from './powerswitchFixtures';

/**
 * Issue #221 — RSC results parser. Strict schema guard: drift on ANY shape
 * mismatch, never a partial parse. All tests run against captured fixtures
 * (no live calls).
 */
describe('extractFlightRows', () => {
  it('parses id:JSON lines into objects', () => {
    const rows = extractFlightRows('0:{"a":1}\n1:{"b":2}\n');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ a: 1 });
    expect(rows[1]).toEqual({ b: 2 });
  });
  it('skips non-JSON / control lines', () => {
    const rows = extractFlightRows('0:{"a":1}\nnot json\n2:[1,2]\n');
    expect(rows).toHaveLength(2);
  });
});

describe('parseRscResults (happy path)', () => {
  it('parses usage + a plan set with tariffs from the fixture flight', () => {
    const out = parseRscResults(rsc_results_flight);
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.results.usage.annualKwh).toBe(7840);
    expect(out.results.usage.monthlyKwh).toHaveLength(12);
    // 3 plans from the fixture
    expect(out.results.plans).toHaveLength(3);
    const names = out.results.plans.map((p) => p.name);
    expect(names).toEqual(['Open Variable', 'Good Nights', 'Flick LE']);
  });

  it('extracts a TOU plan with peak/off-peak tariffs (N1 + D1)', () => {
    const out = parseRscResults(rsc_results_flight);
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    const goodNights = out.results.plans.find((p) => p.name === 'Good Nights')!;
    expect(goodNights.tariffs.some((t) => t.code === 'N1')).toBe(true);
    expect(goodNights.tariffs.some((t) => t.code === 'D1')).toBe(true);
    const n1 = goodNights.tariffs.find((t) => t.code === 'N1')!;
    expect(n1.registerContentCode).toBe('OFFPEAK');
    expect(n1.valueArray).toHaveLength(12);
    expect(n1.description).toContain('21:00-07:00');
  });

  it('extracts a percentage (TD3) tariff', () => {
    const out = parseRscResults(rsc_results_flight);
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    const flick = out.results.plans.find((p) => p.name === 'Flick LE')!;
    const td3 = flick.tariffs.find((t) => t.code === 'TD3')!;
    expect(td3.displayType).toBe('percentage');
    expect(td3.value).toBe(-12);
    expect(td3.registerContentCode).toBe('FREE');
  });

  it('carries fixed_term + price_change_due through', () => {
    const out = parseRscResults(rsc_results_flight);
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    const openVar = out.results.plans.find((p) => p.name === 'Open Variable')!;
    expect(openVar.fixedTerm).toBe(false);
    expect(openVar.priceChangeDue).toBeNull();
    const goodNights = out.results.plans.find((p) => p.name === 'Good Nights')!;
    expect(goodNights.priceChangeDue).toBe('2026-09-01');
  });
});

describe('parseRscResults (strict schema guard — drift)', () => {
  it('aborts on the drift fixture (tariffs renamed to charges)', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = parseRscResults(rsc_results_flight_drift);
    expect(out.status).toBe('drift');
    if (out.status === 'drift') {
      // reason reflects the missing/renamed field chain
      expect(out.reason).toMatch(/tariff|plan/i);
    }
    const logged = errSpy.mock.calls.find((c) => String(c[0]).includes('powerswitch_schema_drift'));
    expect(logged).toBeDefined();
    errSpy.mockRestore();
  });

  it('drifts when usage monthly array is not 12 numbers', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const flight = '0:{"household":{"usage":{"annual_kwh":1000,"monthly_kwh":[1,2,3]}}}\n';
    expect(parseRscResults(flight).status).toBe('drift');
    errSpy.mockRestore();
  });

  it('drifts when results block is missing', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const flight =
      '0:{"household":{"usage":{"annual_kwh":1000,"monthly_kwh":[1,2,3,4,5,6,7,8,9,10,11,12]}}}\n';
    expect(parseRscResults(flight).status).toBe('drift');
    errSpy.mockRestore();
  });

  it('drifts when a tariff value_array is not 12 numbers', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const flight =
      '0:{"household":{"usage":{"annual_kwh":1000,"monthly_kwh":[1,2,3,4,5,6,7,8,9,10,11,12]}}}\n' +
      '1:{"results":[{"plans":[{"id":"p","name":"n","retailer_id":"r","energy_type":"electricity","fixed_term":false,"tariffs":[' +
      '{"code":"F","name":"f","value":2,"value_array":[2],"display_type":"amount","register_content_code":"PK","description":"d","prices_last_changed":null}' +
      ']}]}]}\n';
    expect(parseRscResults(flight).status).toBe('drift');
    errSpy.mockRestore();
  });

  it('NEVER returns partial results on drift', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = parseRscResults(rsc_results_flight_drift);
    expect(out.status).toBe('drift');
    if (out.status === 'drift') {
      // no `results` field on a drift outcome
      expect((out as { results?: unknown }).results).toBeUndefined();
    }
    errSpy.mockRestore();
  });
});
