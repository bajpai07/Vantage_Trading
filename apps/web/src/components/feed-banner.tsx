import type { FeedInfoResponse, FeedSource } from '@vantage/contracts';

export const SIMULATED_TEXT = 'Simulated market data — not real prices';
export const SESSION_24_7_TEXT = 'Simulated 24/7 session';
export const DEMO_TEXT = 'Demo mode — virtual money, no real trading';

const isCrypto = (s: FeedSource): boolean => s.assetClass === 'CRYPTO';

/**
 * The text of the persistent market data banner, decided from what the API reports (never from a flag in this app).
 * Every asset class says where its prices come from (D-75): simulated data is said in so many words, live exchange data
 * is named as such, and a demo (D-77) says it is a demo with virtual money. Unknown (the API could not be asked): say
 * so, do not assume.
 */
export function feedBannerText(
  feed: FeedInfoResponse | null,
): { text: string; tone: 'warn' | 'info' } | null {
  if (feed === null) {
    return {
      text: 'Market data status unavailable — prices may be missing or out of date',
      tone: 'warn',
    };
  }
  if (!feed.enabled)
    return { text: 'Market data is switched off — prices are unavailable', tone: 'warn' };

  const active = feed.sources.filter((s) => s.status !== 'OFF');
  const parts: string[] = [];
  let tone: 'warn' | 'info' = 'info';

  if (active.length > 0 && active.every((s) => s.mode !== 'LIVE')) {
    // everything shown is simulated (or synthetic test data): one sentence says so for stocks and crypto alike
    parts.push(SIMULATED_TEXT);
    tone = 'warn';
  } else {
    // a mix (or all live): each group says its own truth
    const groups: Array<[string, FeedSource[]]> = [
      ['Stocks and ETFs', active.filter((s) => !isCrypto(s))],
      ['Crypto', active.filter(isCrypto)],
    ];
    for (const [name, list] of groups) {
      const first = list[0];
      if (first === undefined) continue;
      if (first.mode === 'LIVE') {
        parts.push(`${name}: live public exchange data — demo (source: ${first.source})`);
      } else {
        parts.push(`${name}: simulated market data — not real prices`);
        tone = 'warn';
      }
    }
  }
  // a delayed real feed (for example a licensed stock vendor) says how late it is
  if (parts.length === 0 && feed.entitlement === 'DELAYED') {
    const minutes = Math.round(feed.delaySeconds / 60);
    parts.push(`Prices are delayed by about ${String(minutes)} min (source: ${feed.source})`);
  }
  if (active.some((s) => !isCrypto(s) && s.session === 'ALWAYS_OPEN')) {
    parts.push(SESSION_24_7_TEXT);
    tone = 'warn';
  }
  if (feed.demoMode) {
    parts.push(DEMO_TEXT);
    tone = 'warn';
  }
  return parts.length === 0 ? null : { text: parts.join(' · '), tone };
}

/** A feed that should be publishing but is not says so (its prices age into STALE on their own). */
export function feedStatusNotice(feed: FeedInfoResponse | null): string | null {
  if (feed === null || !feed.enabled) return null;
  const down = feed.sources.filter((s) => s.status === 'DISCONNECTED');
  if (down.length === 0) return null;
  const names = [
    down.some((s) => !isCrypto(s)) ? 'stock' : null,
    down.some(isCrypto) ? 'crypto' : null,
  ].filter((n): n is string => n !== null);
  return `The ${names.join(' and ')} price feed is not publishing right now — prices may be out of date.`;
}

/**
 * Persistent, NON-dismissible banner at the top of every page (no close button by design). Driven by `GET
 * /v1/market/feed`. Uses a polite live region so assistive technology announces it once, not on every update.
 */
export function FeedBanner({ feed }: { feed: FeedInfoResponse | null }) {
  const b = feedBannerText(feed);
  const notice = feedStatusNotice(feed);
  if (b === null && notice === null) return null;
  return (
    <div className="sticky top-0 z-40">
      {b === null ? null : (
        <div
          role="status"
          data-testid="feed-banner"
          className={`border-b border-line px-4 py-1.5 text-center text-[12px] font-medium ${
            b.tone === 'warn' ? 'bg-bg-2 text-warn' : 'bg-bg-2 text-info'
          }`}
        >
          {b.text}
        </div>
      )}
      {notice === null ? null : (
        <div
          role="status"
          data-testid="feed-status-notice"
          className="border-b border-line bg-bg-2 px-4 py-1 text-center text-[12px] text-text-1"
        >
          {notice}
        </div>
      )}
    </div>
  );
}
