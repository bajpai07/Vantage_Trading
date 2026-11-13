import type { InstrumentItem, MarketStatusResponse, QuoteItem } from '@vantage/contracts';
import { formatUtc } from '../lib/format';
import { ageText, marketLine } from '../lib/market';
import { DASH, formatPrice } from '../lib/money';
import { FreshnessBadge } from './freshness-badge';
import { Alert } from './ui';

/**
 * The quote panel: bid, ask, last and spread exactly as the API sent them (the spread is computed by the server), the
 * freshness badge, the source, the provider time and "x s ago" (the API's own ageSeconds), and whether the market is
 * open. A quote that is not live says what it is; no quote at all shows dashes, never a price.
 */
export function QuotePanel(props: {
  instrument: InstrumentItem;
  quote: QuoteItem;
  market: MarketStatusResponse | null;
  refreshFailed: boolean;
}) {
  const { instrument, quote, market, refreshFailed } = props;
  const line = marketLine(instrument.exchange, market);
  const hasPrice = quote.bid !== undefined && quote.ask !== undefined;
  return (
    <section
      aria-labelledby="quote-title"
      data-testid="quote-panel"
      data-freshness={quote.freshness}
    >
      <h2 id="quote-title" className="mb-2 text-[16px] font-semibold leading-[22px] text-text-0">
        Quote
      </h2>
      {refreshFailed ? (
        <div className="mb-2" data-testid="quote-refresh-failed">
          <Alert kind="error">
            Could not refresh the price. The figures below are the last ones received (
            {ageText(quote.ageSeconds)}) and may be out of date.
          </Alert>
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {(
          [
            ['Bid', quote.bid, 'quote-bid'],
            ['Ask', quote.ask, 'quote-ask'],
            ['Last', quote.last, 'quote-last'],
            ['Spread', quote.spread, 'quote-spread'],
          ] as const
        ).map(([label, value, id]) => (
          <div key={label} className="rounded-md border border-line bg-bg-1 px-3 py-2">
            <div className="text-[12px] leading-4 text-text-2">{label}</div>
            <div className="num mt-0.5 text-[18px] leading-6 text-text-0" data-testid={id}>
              {value === undefined ? (
                <>
                  {DASH}
                  <span className="sr-only">no price</span>
                </>
              ) : (
                formatPrice(value)
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-text-2">
        <FreshnessBadge state={quote.freshness} source={quote.source} asOf={quote.asOf} />
        <span>
          Source: <span className="num text-text-1">{quote.source}</span>
        </span>
        <span data-testid="quote-as-of">
          {quote.asOf === null ? (
            'No quote available'
          ) : (
            <>
              As of <span className="num text-text-1">{formatUtc(quote.asOf)}</span> (
              <span data-testid="quote-age">{ageText(quote.ageSeconds)}</span>)
            </>
          )}
        </span>
        {quote.entitlement === 'DELAYED' ? (
          <span>Delayed by {String(Math.round(quote.delaySeconds / 60))} min</span>
        ) : null}
      </div>
      {!hasPrice ? (
        <p className="mt-2 text-[13px] text-text-1" data-testid="quote-unavailable">
          There is no usable price for this instrument right now, so it cannot be traded.
        </p>
      ) : null}
      <p
        className="mt-2 text-[12px] text-text-2"
        data-testid="market-line"
        data-market-state={line.state}
      >
        {line.text}
      </p>
    </section>
  );
}
