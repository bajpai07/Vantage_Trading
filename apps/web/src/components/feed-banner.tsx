import type { FeedInfoResponse } from '@vantage/contracts';

/**
 * The text of the persistent market data banner, decided from what the API reports (never from a flag in this app).
 * FIXTURE: synthetic data, said in so many words. Unknown (the API could not be asked): say so, do not assume.
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
  if (feed.source === 'FIXTURE')
    return { text: 'Simulated market data — not real prices', tone: 'warn' };
  if (!feed.enabled)
    return { text: 'Market data is switched off — prices are unavailable', tone: 'warn' };
  if (feed.entitlement === 'DELAYED') {
    const minutes = Math.round(feed.delaySeconds / 60);
    return {
      text: `Prices are delayed by about ${String(minutes)} min (source: ${feed.source})`,
      tone: 'info',
    };
  }
  return null;
}

/**
 * Persistent, NON-dismissible banner at the top of every page (no close button by design). Driven by `GET
 * /v1/market/feed`. Uses a polite live region so assistive technology announces it once, not on every update.
 */
export function FeedBanner({ feed }: { feed: FeedInfoResponse | null }) {
  const b = feedBannerText(feed);
  if (b === null) return null;
  return (
    <div
      role="status"
      data-testid="feed-banner"
      className={`sticky top-0 z-40 border-b border-line px-4 py-1.5 text-center text-[12px] font-medium ${
        b.tone === 'warn' ? 'bg-bg-2 text-warn' : 'bg-bg-2 text-info'
      }`}
    >
      {b.text}
    </div>
  );
}
