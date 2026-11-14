import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { FeedInfoResponse, FeedSource } from '@vantage/contracts';
import { Footer } from './footer';
import {
  DEMO_TEXT,
  FeedBanner,
  SESSION_24_7_TEXT,
  SIMULATED_TEXT,
  feedBannerText,
  feedStatusNotice,
} from './feed-banner';

const src = (over: Partial<FeedSource> = {}): FeedSource => ({
  assetClass: 'EQUITY',
  source: 'SIM',
  label: 'Simulated market data',
  mode: 'SIMULATED',
  session: 'NYSE',
  status: 'CONNECTED',
  lastMessageAt: '2026-11-10T15:00:00.000Z',
  ...over,
});
const sources = (
  over: Partial<FeedSource> = {},
  cryptoOver: Partial<FeedSource> = {},
): FeedSource[] => [
  src({ assetClass: 'EQUITY', ...over }),
  src({ assetClass: 'ETF', ...over }),
  src({ assetClass: 'CRYPTO', session: '24_7', ...over, ...cryptoOver }),
];
const feed = (over: Partial<FeedInfoResponse> = {}): FeedInfoResponse => ({
  source: 'SIM',
  entitlement: 'REAL_TIME',
  delaySeconds: 0,
  enabled: true,
  demoMode: false,
  sources: sources(),
  ...over,
});

describe('market data banner (driven by what the API reports, never by a flag in the app)', () => {
  it('simulated stocks and crypto say, in these words, that prices are not real', () => {
    expect(feedBannerText(feed())).toEqual({ text: SIMULATED_TEXT, tone: 'warn' });
    expect(SIMULATED_TEXT).toBe('Simulated market data — not real prices');
  });

  it('FIXTURE (test data) says the same: it is never presented as real', () => {
    const f = feed({ source: 'FIXTURE', sources: sources({ source: 'FIXTURE', mode: 'FIXTURE' }) });
    expect(feedBannerText(f)?.text).toBe(SIMULATED_TEXT);
  });

  it('demo mode (D-77) adds that it is a demo with virtual money', () => {
    const b = feedBannerText(feed({ demoMode: true }));
    expect(b?.text).toBe(`${SIMULATED_TEXT} · ${DEMO_TEXT}`);
    expect(DEMO_TEXT).toContain('virtual money');
    expect(feedBannerText(feed({ demoMode: false }))?.text).not.toContain('Demo');
  });

  it('the simulated 24/7 stock session (D-76) is named; crypto being 24/7 alone does not add it', () => {
    const always = feed({
      sources: [
        src({ session: 'ALWAYS_OPEN' }),
        src({ assetClass: 'ETF', session: 'ALWAYS_OPEN' }),
        src({ assetClass: 'CRYPTO', session: '24_7' }),
      ],
    });
    expect(feedBannerText(always)?.text).toBe(`${SIMULATED_TEXT} · ${SESSION_24_7_TEXT}`);
    expect(feedBannerText(feed())?.text).not.toContain('24/7'); // control: NYSE session, crypto 24_7
  });

  it('a mix tells the truth per class: live crypto is named as live exchange data, stocks stay simulated', () => {
    const mixed = feed({
      sources: [
        src(),
        src({ assetClass: 'ETF' }),
        src({
          assetClass: 'CRYPTO',
          source: 'BINANCE',
          label: 'Binance',
          mode: 'LIVE',
          session: '24_7',
        }),
      ],
    });
    expect(feedBannerText(mixed)).toEqual({
      text: 'Stocks and ETFs: simulated market data — not real prices · Crypto: live public exchange data — demo (source: BINANCE)',
      tone: 'warn',
    });
  });

  it('a class that is switched off is not described (crypto off: only the stock line)', () => {
    const off = feed({
      sources: [src(), src({ assetClass: 'ETF' }), src({ assetClass: 'CRYPTO', status: 'OFF' })],
    });
    expect(feedBannerText(off)?.text).toBe(SIMULATED_TEXT);
  });

  it('is persistent: no close button and no dismiss control in the markup', () => {
    const html = renderToStaticMarkup(<FeedBanner feed={feed()} />);
    expect(html).toContain(SIMULATED_TEXT);
    expect(html).toContain('role="status"');
    expect(html).not.toMatch(/<button|dismiss|close|aria-label="(close|dismiss)/i);
  });

  it('a non-simulated delayed feed shows the delay from the API instead (control: not the simulated text)', () => {
    const f = feed({
      source: 'POLYGON',
      entitlement: 'DELAYED',
      delaySeconds: 900,
      sources: sources({ source: 'POLYGON', mode: 'LIVE' }, { status: 'OFF' }),
    });
    const b = feedBannerText(f);
    expect(b?.text).toContain('Stocks and ETFs: live public exchange data');
    expect(b?.text).not.toContain('Simulated');
  });

  it('a real-time live feed with no demo needs no banner line beyond its own source', () => {
    const live = feed({ source: 'POLYGON', sources: [] });
    expect(feedBannerText(live)).toBeNull();
    expect(renderToStaticMarkup(<FeedBanner feed={live} />)).toBe('');
  });

  it('a switched-off feed says prices are unavailable', () => {
    expect(feedBannerText(feed({ enabled: false }))?.text).toContain('switched off');
  });

  it('when the API cannot be asked the banner says the status is unknown, it never assumes real data', () => {
    const b = feedBannerText(null);
    expect(b?.text).toContain('unavailable');
    expect(b?.text).not.toMatch(/real prices|live/i);
  });

  it('the banner follows what the API says (changing the mode changes the text: no hard-coded flag)', () => {
    const sim = feedBannerText(feed())?.text;
    const live = feedBannerText(feed({ sources: sources({ mode: 'LIVE', source: 'X' }) }))?.text;
    expect(sim).not.toBe(live);
  });
});

describe('a feed that stopped publishing is said, in a separate notice (not mixed into the banner)', () => {
  it('names the class, and is absent while everything is connected (control)', () => {
    expect(feedStatusNotice(feed())).toBeNull();
    const down = feed({
      sources: [
        src({ status: 'DISCONNECTED' }),
        src({ assetClass: 'ETF' }),
        src({ assetClass: 'CRYPTO' }),
      ],
    });
    expect(feedStatusNotice(down)).toBe(
      'The stock price feed is not publishing right now — prices may be out of date.',
    );
    const both = feed({ sources: sources({ status: 'DISCONNECTED' }) });
    expect(feedStatusNotice(both)).toContain('stock and crypto');
    expect(feedStatusNotice(null)).toBeNull();
  });
  it('renders as its own live region, and the banner element keeps only the data-source text', () => {
    const html = renderToStaticMarkup(
      <FeedBanner feed={feed({ sources: sources({ status: 'DISCONNECTED' }) })} />,
    );
    expect(html).toContain('data-testid="feed-status-notice"');
    expect(html).toContain('data-testid="feed-banner"');
    expect(html).not.toMatch(/<button/);
  });
  it('OFF is not a disconnect (crypto off by configuration says nothing)', () => {
    expect(
      feedStatusNotice(
        feed({
          sources: [
            src(),
            src({ assetClass: 'ETF' }),
            src({ assetClass: 'CRYPTO', status: 'OFF' }),
          ],
        }),
      ),
    ).toBeNull();
  });
});

describe('footer in demo mode', () => {
  it('always says virtual money; in demo mode (from the API) it also says the prices are simulated', () => {
    const plain = renderToStaticMarkup(<Footer feed={feed()} />);
    expect(plain).toContain('Virtual money — not real trading');
    expect(plain).not.toContain('demo-footer');
    const demo = renderToStaticMarkup(<Footer feed={feed({ demoMode: true })} />);
    expect(demo).toContain('data-testid="demo-footer"');
    expect(demo).toContain('This is a demo: prices are simulated and nothing here is real.');
    expect(renderToStaticMarkup(<Footer feed={null} />)).toContain('Virtual money'); // API unreachable: still says it
  });
});
