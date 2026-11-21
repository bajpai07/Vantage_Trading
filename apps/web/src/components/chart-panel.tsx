'use client';

// The chart panel (M9a T3, D-103, D-105): interval tabs, the candlestick chart with a volume strip, the crosshair legend and the
// honest states. The chart library is loaded dynamically, on the instrument page only. Candles come from the existing
// GET /v1/market/candles contract: ONE request per interval switch (limit 200), then a bounded refresh of the latest two candles
// every REFRESH_MS while the tab is visible and the quote is live (the forming candle moves; closed candles never change). The
// legend, the last price and the header show the exact server strings, looked up by candle time; the only numbers made here go to
// the chart library through lib/chart-data.ts (pixels only).
import dynamic from 'next/dynamic';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CANDLE_INTERVALS, CandlesResponse } from '@vantage/contracts';
import type { CandleInterval, CandleItem, InstrumentItem, QuoteItem } from '@vantage/contracts';
import { toPlotSeries } from '../lib/chart-data';
import { mergeCandles } from '../lib/candles-merge';
import { clientGet } from '../lib/client-api';
import { formatUtc } from '../lib/format';
import { DASH, formatPrice, formatQty } from '../lib/money';
import { Alert, secondaryButtonClass } from './ui';

/** Height of the chart area (the price pane plus the 56 px volume strip). */
export const CHART_HEIGHT = 440;
/** The forming candle is refreshed this often while the tab is visible (bounded: at most 12 requests a minute). */
export const REFRESH_MS = 5000;
const FIRST_LIMIT = 200;
const A11Y_ROWS = 8;

function ChartSkeleton() {
  return (
    <div
      data-testid="chart-skeleton"
      aria-hidden="true"
      className="h-[440px] rounded-md bg-bg-2 motion-safe:animate-pulse"
    />
  );
}

// the library is a separate chunk, fetched only when this page asks for it
const PriceChart = dynamic(() => import('./price-chart'), { ssr: false, loading: ChartSkeleton });

type Data =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'unavailable' }
  | {
      readonly kind: 'ready';
      readonly items: readonly CandleItem[];
      readonly synthetic: boolean;
      readonly source: string;
    };

const LIVE = new Set(['REAL_TIME', 'DELAYED']);

function Legend({ candle, forming }: { candle: CandleItem | undefined; forming: boolean }) {
  if (candle === undefined)
    return (
      <p className="text-[12px] text-text-2" data-testid="chart-legend">
        {DASH}
      </p>
    );
  return (
    <p
      className="num flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-text-1"
      data-testid="chart-legend"
      aria-live="off"
    >
      <span data-testid="legend-time">{formatUtc(candle.t)}</span>
      <span>
        O{' '}
        <b data-testid="legend-o" className="font-medium text-text-0">
          {formatPrice(candle.o)}
        </b>
      </span>
      <span>
        H{' '}
        <b data-testid="legend-h" className="font-medium text-text-0">
          {formatPrice(candle.h)}
        </b>
      </span>
      <span>
        L{' '}
        <b data-testid="legend-l" className="font-medium text-text-0">
          {formatPrice(candle.l)}
        </b>
      </span>
      <span>
        C{' '}
        <b data-testid="legend-c" className="font-medium text-text-0">
          {formatPrice(candle.c)}
        </b>
      </span>
      <span>
        Vol{' '}
        <b data-testid="legend-v" className="font-medium text-text-0">
          {formatQty(candle.v)}
        </b>
      </span>
      {forming ? <span className="text-text-2">forming</span> : null}
    </p>
  );
}

/**
 * The chart panel. `interval` is owned by the terminal (the `[` and `]` shortcuts move it too). Without a live quote the chart is
 * not drawn as if it were live: STALE and UNAVAILABLE replace it with a message, CLOSED shows the closed candles and says the
 * forming candle is not updating.
 */
export function ChartPanel(props: {
  instrument: InstrumentItem;
  quote: QuoteItem;
  interval: CandleInterval;
  onIntervalChange: (i: CandleInterval) => void;
}) {
  const { instrument, quote, interval } = props;
  const symbol = instrument.symbol;
  const uid = useId();
  const panelId = `${uid}-panel`;
  const [data, setData] = useState<Data>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const live = LIVE.has(quote.freshness);
  const drawable = live || quote.freshness === 'CLOSED';

  // ONE request per interval switch (and per retry)
  useEffect(() => {
    if (!drawable) return undefined;
    const controller = new AbortController();
    setData({ kind: 'loading' });
    setHover(null);
    void clientGet(
      `/v1/market/candles?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${String(FIRST_LIMIT)}`,
      CandlesResponse,
      controller.signal,
    ).then((r) => {
      if (controller.signal.aborted) return;
      if (r.ok)
        setData({
          kind: 'ready',
          items: r.data.candles,
          synthetic: r.data.synthetic,
          source: r.data.source,
        });
      else if (r.kind === 'not_found') setData({ kind: 'unavailable' });
      else setData({ kind: 'error' });
    });
    return () => controller.abort();
    // drawable is deliberately not a dependency: a quote that flips between live and closed must not refetch the history
  }, [symbol, interval, attempt]);

  // the bounded refresh of the forming candle (live quotes only, tab visible, one request in flight)
  const ready = data.kind === 'ready';
  useEffect(() => {
    if (!ready || !live) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inflight = false;
    let controller: AbortController | undefined;
    async function cycle(): Promise<void> {
      if (inflight || cancelled) return;
      inflight = true;
      controller = new AbortController();
      const r = await clientGet(
        `/v1/market/candles?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=2`,
        CandlesResponse,
        controller.signal,
      );
      inflight = false;
      if (cancelled) return;
      if (r.ok)
        setData((d) =>
          d.kind === 'ready' ? { ...d, items: mergeCandles(d.items, r.data.candles) } : d,
        );
      schedule();
    }
    function schedule(): void {
      if (cancelled || document.hidden) return;
      clearTimeout(timer);
      timer = setTimeout(() => void cycle(), REFRESH_MS);
    }
    const onVisibility = (): void => {
      if (document.hidden) {
        clearTimeout(timer);
        timer = undefined;
      } else void cycle();
    };
    schedule();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [ready, live, symbol, interval]);

  const series = useMemo(() => (data.kind === 'ready' ? toPlotSeries(data.items) : null), [data]);
  const items = data.kind === 'ready' ? data.items : [];
  const lastCandle = items[items.length - 1];
  const shown =
    hover !== null && series !== null ? (series.byTime.get(hover) ?? lastCandle) : lastCandle;
  const lastPrice = lastCandle?.c ?? quote.last;
  const summary = `Candlestick chart of ${symbol}, ${interval} candles, simulated data${
    lastPrice === undefined ? '' : `, last price ${formatPrice(lastPrice)}`
  }`;

  function onTabKey(e: React.KeyboardEvent, index: number): void {
    const n = CANDLE_INTERVALS.length;
    const to =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? (index + 1) % n
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? (index + n - 1) % n
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? n - 1
              : -1;
    if (to < 0) return;
    e.preventDefault();
    const next = CANDLE_INTERVALS[to] as CandleInterval;
    props.onIntervalChange(next);
    tabRefs.current[to]?.focus();
  }

  return (
    <div data-testid="chart-panel" data-interval={interval}>
      <div role="tablist" aria-label="Candle interval" className="mb-2 flex flex-wrap gap-1.5">
        {CANDLE_INTERVALS.map((iv, i) => {
          const selected = iv === interval;
          return (
            <button
              key={iv}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${uid}-tab-${iv}`}
              data-testid={`interval-${iv}`}
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={selected ? 0 : -1}
              onClick={() => props.onIntervalChange(iv)}
              onKeyDown={(e) => onTabKey(e, i)}
              className={`rounded-md px-3 py-1.5 text-[13px] ${
                selected
                  ? 'bg-bg-4 font-semibold text-text-0'
                  : 'text-text-2 hover:bg-bg-3 hover:text-text-0'
              }`}
            >
              {iv}
            </button>
          );
        })}
      </div>

      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={`${uid}-tab-${interval}`}
        tabIndex={-1}
        className="min-h-[440px] rounded-md border border-line bg-bg-1"
      >
        {!drawable ? (
          <div
            role="status"
            data-testid="chart-unavailable"
            className="min-h-[440px] flex items-center justify-center px-6 text-center text-[13px] text-text-1"
          >
            {quote.freshness === 'STALE'
              ? 'Chart unavailable: quote is stale.'
              : 'Chart unavailable: no quote right now.'}
          </div>
        ) : data.kind === 'loading' ? (
          <ChartSkeleton />
        ) : data.kind === 'unavailable' ? (
          <div
            role="status"
            data-testid="chart-no-candles"
            className="min-h-[440px] flex items-center justify-center px-6 text-center text-[13px] text-text-1"
          >
            No candles are available for this instrument.
          </div>
        ) : data.kind === 'error' ? (
          <div
            data-testid="chart-error"
            className="min-h-[440px] flex flex-col items-center justify-center gap-3 px-6"
          >
            <Alert kind="info">The chart could not be loaded.</Alert>
            <button
              type="button"
              data-testid="chart-retry"
              onClick={() => setAttempt((n) => n + 1)}
              className={secondaryButtonClass}
            >
              Try again
            </button>
          </div>
        ) : (
          <div role="group" aria-label={summary} data-testid="chart-ready">
            {quote.freshness === 'CLOSED' ? (
              <p
                role="status"
                data-testid="chart-closed-note"
                className="border-b border-line px-3 py-1.5 text-[12px] text-text-1"
              >
                The market is closed: these are the closed candles, the forming candle is not
                updating.
              </p>
            ) : null}
            <div className="border-b border-line px-3 py-1.5">
              <Legend candle={shown} forming={shown !== undefined && shown.closed === false} />
            </div>
            {series === null ? null : (
              <PriceChart
                series={series}
                dataKey={`${symbol}|${interval}`}
                tickSize={instrument.tickSize}
                showVolume
                onHover={setHover}
              />
            )}
            <table className="sr-only" data-testid="chart-a11y-table">
              <caption>
                Latest {String(A11Y_ROWS)} {interval} candles of {symbol} (simulated data), newest
                first
              </caption>
              <thead>
                <tr>
                  <th scope="col">Open time</th>
                  <th scope="col">Open</th>
                  <th scope="col">High</th>
                  <th scope="col">Low</th>
                  <th scope="col">Close</th>
                  <th scope="col">Volume</th>
                </tr>
              </thead>
              <tbody>
                {items
                  .slice(-A11Y_ROWS)
                  .reverse()
                  .map((c) => (
                    <tr key={c.t}>
                      <th scope="row">{formatUtc(c.t)}</th>
                      <td>{c.o}</td>
                      <td>{c.h}</td>
                      <td>{c.l}</td>
                      <td>{c.c}</td>
                      <td>{c.v}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="mt-2 text-[12px] text-text-2" data-testid="chart-footer">
        Candles are simulated and deterministic. The forming candle updates live; closed candles
        never change.{' '}
        <span data-testid="chart-axis-note">
          Axis labels are rounded; exact prices in the legend.
        </span>{' '}
        <a
          href="https://www.tradingview.com/"
          data-testid="chart-attribution"
          target="_blank"
          rel="noopener noreferrer"
        >
          Charts by TradingView
        </a>
      </p>
    </div>
  );
}
