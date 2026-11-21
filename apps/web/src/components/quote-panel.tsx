import type { InstrumentItem, MarketStatusResponse, QuoteItem } from '@vantage/contracts';
import { formatUtc } from '../lib/format';
import { ageText, marketLine } from '../lib/market';
import { DASH, formatPrice } from '../lib/money';
import { changeView } from '../lib/change';
import { ChangeCell } from './change-cell';
import { FlashPrice } from './flash-price';
import { FreshnessBadge } from './freshness-badge';
import { Alert } from './ui';

/** One labelled figure of the bid / ask / spread line (exact strings from the API). */
function Figure({ label, value, id }: { label: string; value: string | undefined; id: string }) {
  return (
    <span>
      {label}{' '}
      <span className="num text-text-1" data-testid={id}>
        {value === undefined ? (
          <>
            {DASH}
            <span className="sr-only">no price</span>
          </>
        ) : (
          formatPrice(value)
        )}
      </span>
    </span>
  );
}

/**
 * The instrument's price header (Terminal.dc.html): the big last price, the day change against the previous close or 24 hours
 * ago, the freshness badge with the source and the age ("REAL-TIME · SIM · 2 s ago"), and the bid / ask / spread line. Every
 * number is the exact string the API sent (the spread and the change are computed by the server). A quote that is not live says
 * what it is; no quote at all shows dashes, never a price.
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
  const change = changeView(quote);
  return (
    <section
      aria-labelledby="quote-title"
      data-testid="quote-panel"
      data-freshness={quote.freshness}
    >
      <h2 id="quote-title" className="sr-only">
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
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <FlashPrice
            value={quote.last}
            testId="quote-last"
            className="num text-[30px] font-semibold leading-9"
            text={quote.last === undefined ? DASH : formatPrice(quote.last)}
          />
          {quote.last === undefined ? <span className="sr-only">no price</span> : null}
          <span className="num text-[14px]" data-testid="quote-change-card">
            {hasPrice ? (
              <ChangeCell
                change={quote.change}
                changePct={quote.changePct}
                changeBasis={quote.changeBasis}
                testId="quote-change"
              />
            ) : (
              <span data-testid="quote-change" data-direction="none">
                —<span className="sr-only">no price</span>
              </span>
            )}
          </span>
          <span className="text-[12px] text-text-2" data-testid="quote-change-basis">
            {change.basisLabel ?? (hasPrice ? 'no prior close yet' : '')}
          </span>
        </div>
        <div className="flex flex-col items-start gap-1.5 text-[12px] text-text-2 sm:items-end">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <FreshnessBadge state={quote.freshness} source={quote.source} asOf={quote.asOf} />
            <span data-testid="quote-badge-detail" className="num">
              · {quote.source}
              {quote.asOf === null ? '' : ` · ${ageText(quote.ageSeconds)}`}
            </span>
          </span>
          <span className="num flex flex-wrap gap-x-3">
            <Figure label="Bid" value={quote.bid} id="quote-bid" />
            <Figure label="Ask" value={quote.ask} id="quote-ask" />
            <Figure label="Spread" value={quote.spread} id="quote-spread" />
          </span>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-text-2">
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
        <span data-testid="market-line" data-market-state={line.state}>
          {line.text}
        </span>
      </div>
      {!hasPrice ? (
        <p className="mt-2 text-[13px] text-text-1" data-testid="quote-unavailable">
          There is no usable price for this instrument right now, so it cannot be traded.
        </p>
      ) : null}
    </section>
  );
}
