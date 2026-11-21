'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import type { QuoteItem } from '@vantage/contracts';
import { freshnessView } from '../lib/freshness';
import { DASH, formatPrice } from '../lib/money';
import type { useWatchlist } from '../lib/use-watchlist';
import { useWatchlistQuotes } from '../lib/use-watchlist-quotes';
import { ChangeCell } from './change-cell';
import { FlashPrice } from './flash-price';
import { Alert } from './ui';

const DOT: Record<ReturnType<typeof freshnessView>['tone'], string> = {
  up: 'bg-up',
  warn: 'bg-warn',
  stale: 'bg-stale',
  muted: 'bg-text-2',
  down: 'bg-down',
};

/** The freshness dot with a text alternative (a dot alone would be colour only). */
function FreshnessDot({ state }: { state: QuoteItem['freshness'] }) {
  const v = freshnessView(state);
  return (
    <span
      data-testid="watch-dot"
      data-state={state}
      title={v.description}
      className={`inline-block size-2 shrink-0 rounded-full ${DOT[v.tone]}`}
    >
      <span className="sr-only">{v.label}</span>
    </span>
  );
}

function Star({
  symbol,
  on,
  disabled,
  onToggle,
  className = '',
}: {
  symbol: string;
  on: boolean;
  disabled?: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      data-testid="watch-star"
      data-symbol={symbol}
      aria-pressed={on}
      disabled={disabled === true && !on}
      aria-label={on ? `Remove ${symbol} from your watchlist` : `Add ${symbol} to your watchlist`}
      onClick={onToggle}
      className={`inline-flex size-8 shrink-0 items-center justify-center rounded-md text-[15px] hover:bg-bg-3 disabled:cursor-not-allowed disabled:opacity-50 ${on ? 'text-warn' : 'text-text-2'} ${className}`}
    >
      <span aria-hidden="true">{on ? '★' : '☆'}</span>
    </button>
  );
}

/**
 * The watchlist rail (D-104). Rows come from ONE quotes request for the whole list; the selected row is the current route
 * (aria-current), every row is a link (Tab, j/k and Enter navigate), stars add and remove. The list is saved in this browser
 * only and says so. At 1024 to 1279 px only the symbol and the freshness dot are shown.
 */
export function WatchlistRail({
  current,
  currentName,
  pollMs,
  watchlist,
  full: fullLayout = false,
  onSelect,
}: {
  /** Show names, prices and stars at every width (the phone drawer). */
  full?: boolean;
  /** A row was chosen (the phone drawer closes). */
  onSelect?: () => void;
  current: string;
  currentName: string;
  pollMs: number;
  watchlist: ReturnType<typeof useWatchlist>;
}) {
  const { state, loaded, saved, full, toggle, forget } = watchlist;
  const q = useWatchlistQuotes(state.symbols, pollMs, loaded);

  // the feed does not know these: drop them from the saved list
  useEffect(() => {
    if (q.unknown.length > 0) forget(q.unknown);
  }, [q.unknown, forget]);

  return (
    <div data-testid="watchlist" className="flex h-full flex-col py-4">
      <div className="flex items-baseline justify-between px-3 pb-2 xl:px-4">
        <h2 className="text-[13px] font-semibold text-text-0">Watchlist</h2>
        <span
          className={`${fullLayout ? '' : 'hidden xl:inline'} text-[12px] text-text-2`}
          data-testid="watch-saved-note"
        >
          {saved ? 'Saved in this browser' : 'Not saved (browser storage is blocked)'}
        </span>
      </div>
      {!loaded ? (
        <ul aria-hidden="true" data-testid="watch-skeleton">
          {state.symbols.map((s) => (
            <li key={s} className="h-[56px] px-4 py-2">
              <div className="h-full rounded-sm bg-bg-2 motion-safe:animate-pulse" />
            </li>
          ))}
        </ul>
      ) : state.symbols.length === 0 ? (
        <p className="px-4 text-[12px] text-text-2" data-testid="watch-empty">
          Your watchlist is empty. Use the star next to a symbol to add it.
        </p>
      ) : (
        <ul role="list" aria-label="Watchlist symbols" data-testid="watch-list">
          {state.symbols.map((symbol) => {
            const quote = q.quotes[symbol];
            const selected = symbol === current;
            const name = state.names[symbol];
            return (
              <li
                key={symbol}
                data-testid="watch-row"
                data-symbol={symbol}
                data-selected={selected ? 'true' : 'false'}
                className={`group flex items-center border-l-[3px] ${selected ? 'border-accent bg-bg-3' : 'border-transparent hover:bg-bg-2'}`}
              >
                <Link
                  href={`/instruments/${encodeURIComponent(symbol)}`}
                  aria-current={selected ? 'page' : undefined}
                  data-testid="watch-link"
                  {...(onSelect === undefined ? {} : { onClick: onSelect })}
                  className="flex min-h-[56px] min-w-0 flex-1 items-center justify-between gap-2 px-2 py-2 text-text-0 hover:text-text-0 xl:px-3"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {quote === undefined ? null : <FreshnessDot state={quote.freshness} />}
                    <span className="min-w-0">
                      <span className="block truncate font-semibold text-text-0">{symbol}</span>
                      <span
                        className={`${fullLayout ? 'block' : 'hidden xl:block'} truncate text-[12px] text-text-2`}
                      >
                        {name ?? ''}
                        {quote?.changeBasis === 'ROLLING_24H' ? ' · 24h' : ''}
                      </span>
                    </span>
                  </span>
                  <span className={`${fullLayout ? 'block' : 'hidden xl:block'} text-right`}>
                    {quote === undefined ? (
                      <span
                        className="num text-text-2"
                        data-testid="watch-price"
                        aria-label={q.loading ? 'loading' : 'no price'}
                      >
                        {q.loading ? '…' : DASH}
                      </span>
                    ) : (
                      <>
                        <FlashPrice
                          value={quote.last}
                          testId="watch-price"
                          className="num block"
                          text={quote.last === undefined ? DASH : formatPrice(quote.last)}
                        />
                        <span className="block text-[12px]">
                          <ChangeCell
                            change={quote.change}
                            changePct={quote.changePct}
                            changeBasis={quote.changeBasis}
                            compact
                            testId="watch-change"
                          />
                        </span>
                      </>
                    )}
                  </span>
                </Link>
                <Star
                  symbol={symbol}
                  on
                  onToggle={() => toggle(symbol)}
                  className={`mr-1 ${fullLayout ? 'inline-flex' : 'hidden xl:inline-flex'}`}
                />
              </li>
            );
          })}
        </ul>
      )}
      {q.failed ? (
        <div className="px-3 pt-2 xl:px-4" data-testid="watch-failed">
          <Alert kind="info">Watchlist prices could not be refreshed. Retrying.</Alert>
        </div>
      ) : null}
      {loaded && !state.symbols.includes(current) ? (
        <div
          className={`mt-2 px-4 ${fullLayout ? 'block' : 'hidden xl:block'}`}
          data-testid="watch-add-current"
        >
          <button
            type="button"
            disabled={full}
            onClick={() => toggle(current, currentName)}
            className="w-full rounded-md border border-line-strong px-3 py-1.5 text-left text-[12px] text-text-1 hover:bg-bg-3 disabled:opacity-50"
          >
            <span aria-hidden="true">☆ </span>Add {current} to your watchlist
          </button>
          {full ? (
            <p className="mt-1 text-[11px] text-text-2">The watchlist is full (50 symbols).</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export { Star as WatchStar };
