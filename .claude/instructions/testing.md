# Flip — Testing Requirements

## Coverage Targets

| Area | Target | Framework |
|------|--------|-----------|
| Workers TypeScript | 80%+ | Vitest + miniflare |
| Python parsers | 90%+ | pytest |
| Python comparator | 90%+ | pytest |
| State machine | 100% transitions | Vitest |

Zero failing tests before any deploy.

## Worker Tests (Vitest + miniflare)

Every Cloudflare Worker route must have an integration test:

- **Messaging webhook**: simulate Sent payloads (valid + invalid signatures), verify state transitions, verify D1 writes, verify queue messages dispatched
- **Stripe webhook**: simulate Stripe events (`checkout.session.completed`, etc.), verify signature validation, verify subscription state changes
- **Email webhook**: simulate OAuth callback, verify token encryption + storage
- **Admin endpoints**: verify authentication (valid + invalid API key), rate limiting

Test pattern:
```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';

describe('POST /webhook/messaging', () => {
  it('rejects invalid signature', async () => { ... });
  it('routes help intent to help handler', async () => { ... });
  it('enqueues parse job for bill media', async () => { ... });
});
```

## Python Parser Tests (pytest)

Each retailer parser must have unit tests with real anonymised sample PDFs:

- Test with a known good PDF → assert exact extracted values (cents, dates, kWh, ICP number)
- Test with a different plan variant from the same retailer → assert correct plan name detection
- Test with an intentionally bad/illegible file → assert confidence < 0.5
- Test with edge cases: zero usage, very high usage, multi-page PDF, missing fields

Test pattern:
```python
def test_contact_parser_standard_bill():
    result = parse("tests/fixtures/contact_standard_202601.pdf")
    assert result["retailer"] == "Contact Energy"
    assert result["total_cents"] == 21234  # $212.34
    assert result["days"] == 31
    assert result["confidence"] > 0.8
```

## Plan Comparator Tests (pytest)

Deterministic tests with known inputs and expected outputs:

- Single plan, single bill → exact projected cost
- Multiple plans, single bill → correct ranking by cost
- Multiple plans, multiple bills (annualized) → correct weighted average
- Tiered pricing: usage crosses tier boundaries → correct blended rate
- Low-user plan: usage qualifies for low-user rate → correct pricing applied
- Edge cases: zero usage, very high usage, missing daily charge, missing variable rate

All values asserted in exact cents. No approximate comparisons for monetary values.

## State Machine Tests

Exhaustive test of every valid transition. Table-driven approach:

```typescript
const validTransitions = [
  { from: 'NEW', command: 'help', to: 'ONBOARDING' },
  { from: 'ACTIVE', command: 'compare', to: 'ACTIVE' },
  { from: 'AWAITING_SWITCH_CONFIRM', command: 'yes', to: 'SWITCHING' },
  // ... every valid transition
];

const invalidTransitions = [
  { from: 'NEW', command: 'compare', error: 'invalid_transition' },
  { from: 'UNSUBSCRIBED', command: 'switch', error: 'invalid_transition' },
  // ... sample of invalid transitions
];
```

## DeepSeek Mock Tests

- Mock the DeepSeek API for all unit tests — never call the real API in unit tests.
- Integration tests use a test API key and a dedicated test WhatsApp number.
- Test intent classification accuracy: known messages → expected intents.
- Test Pro model disambiguation: ambiguous messages → clarification response.

## Test Fixtures

- Sample bills: anonymised PDFs from each supported retailer. Stored in `python/tests/fixtures/`.
- Sample webhook payloads: Sent and Stripe webhook bodies. Stored in `workers/src/__fixtures__/`.
- Plan data: sample EIEP14A responses and manual plan entries.

## Running Tests

```bash
# Workers tests
cd workers && npm test

# Python tests
cd python && pytest tests/ -v

# With coverage
cd workers && npm test -- --coverage
cd python && pytest tests/ -v --cov=parsers --cov=comparator --cov-report=term
```

## Pre-Deploy Gate

Before `wrangler deploy`:
1. `npm test` — all passing
2. `pytest tests/ -v` — all passing
3. TypeScript compilation: `tsc --noEmit` — no errors
4. Coverage meets targets (check reports)
5. No skipped or pending tests
