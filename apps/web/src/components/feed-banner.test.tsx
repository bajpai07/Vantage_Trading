import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { FeedInfoResponse } from '@vantage/contracts';
import { FeedBanner, feedBannerText } from './feed-banner';

const feed = (over: Partial<FeedInfoResponse> = {}): FeedInfoResponse => ({
  source: 'FIXTURE',
  entitlement: 'DELAYED',
  delaySeconds: 900,
  enabled: true,
  ...over,
});

describe('market data banner (driven by what the API reports, never by a flag in the app)', () => {
  it('FIXTURE says, in these words, that prices are not real', () => {
    expect(feedBannerText(feed())).toEqual({
      text: 'Simulated market data — not real prices',
      tone: 'warn',
    });
  });

  it('is persistent: no close button and no dismiss control in the markup', () => {
    const html = renderToStaticMarkup(<FeedBanner feed={feed()} />);
    expect(html).toContain('Simulated market data — not real prices');
    expect(html).toContain('role="status"');
    expect(html).not.toMatch(/<button|dismiss|close|aria-label="(close|dismiss)/i);
  });

  it('a non-fixture delayed feed shows the delay from the API instead (control: not the FIXTURE text)', () => {
    const b = feedBannerText(feed({ source: 'POLYGON', delaySeconds: 900 }));
    expect(b?.text).toBe('Prices are delayed by about 15 min (source: POLYGON)');
    expect(b?.text).not.toContain('Simulated');
  });

  it('a real-time non-fixture feed needs no banner', () => {
    expect(
      feedBannerText(feed({ source: 'POLYGON', entitlement: 'REAL_TIME', delaySeconds: 0 })),
    ).toBeNull();
    expect(
      renderToStaticMarkup(
        <FeedBanner
          feed={feed({ source: 'POLYGON', entitlement: 'REAL_TIME', delaySeconds: 0 })}
        />,
      ),
    ).toBe('');
  });

  it('a switched-off feed says prices are unavailable', () => {
    expect(feedBannerText(feed({ source: 'POLYGON', enabled: false }))?.text).toContain(
      'switched off',
    );
  });

  it('when the API cannot be asked the banner says the status is unknown, it never assumes real data', () => {
    const b = feedBannerText(null);
    expect(b?.text).toContain('unavailable');
    expect(b?.text).not.toMatch(/real prices|live/i);
  });

  it('the banner depends on the source string only: changing it changes the text (no hard-coded flag)', () => {
    expect(feedBannerText(feed({ source: 'FIXTURE' }))?.text).not.toBe(
      feedBannerText(feed({ source: 'OTHER' }))?.text,
    );
  });
});
