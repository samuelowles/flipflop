import { describe, it, expect } from 'vitest';
import { renderProgressPage } from './gmailProgressPage';

const FLOW_URL = '/flow/status?u=abc-123&exp=1784344752&sig=deadbeef';

describe('renderProgressPage — signed flow URL embedding', () => {
  it('embeds the JSON poll URL in JS context with RAW ampersands (not &amp;)', () => {
    // HTML-entity escaping inside <script> broke signature verification on a
    // real deployed run: the browser does not decode &amp; in script blocks,
    // so the signed fetch 401'd and the trace card never appeared.
    const html = renderProgressPage('user-1', [], false, FLOW_URL);
    expect(html).toContain('var flowJsonUrl = "/flow/status.json?u=abc-123&exp=1784344752&sig=deadbeef";');
    expect(html).not.toContain('status.json?u=abc-123&amp;');
  });

  it('keeps the entity-escaped URL for the href (attribute context)', () => {
    const html = renderProgressPage('user-1', [], false, FLOW_URL);
    expect(html).toContain('href="/flow/status?u=abc-123&amp;exp=1784344752&amp;sig=deadbeef"');
  });

  it('renders the trace card and event log containers when a flow URL exists', () => {
    const html = renderProgressPage('user-1', [], false, FLOW_URL);
    expect(html).toContain('id="trace-card"');
    expect(html).toContain('id="event-log"');
    expect(html).toContain('id="trace-stages"');
  });

  it('omits the poll URL when no flow URL was minted (error path)', () => {
    const html = renderProgressPage('user-1', ['Error: no phone'], true);
    expect(html).toContain('var flowJsonUrl = "";');
  });
});
