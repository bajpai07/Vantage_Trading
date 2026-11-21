'use client';

// The terminal's bottom panel (M9a T4): Positions | Open orders | History, full width under the three columns. It reuses the
// existing data and components: positions come from the terminal's ONE portfolio poll, the orders tabs are the existing
// OrdersList (open orders with Cancel, history), so the idempotent cancel flow is exactly the one tested since M8b-1. Tab
// counts are server data. Selecting a position row switches the terminal to that instrument.
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ListOrdersResponse } from '@vantage/contracts';
import type { PortfolioPosition } from '@vantage/contracts';
import { clientGet } from '../lib/client-api';
import { DASH, formatMoney, formatPrice, formatQty, isZeroDecimal } from '../lib/money';
import { OrdersList } from './orders-list';
import { PnlCell } from './money';
import { usePortfolio } from './terminal-chrome';
import { Alert, EmptyState, secondaryButtonClass } from './ui';

type Tab = 'positions' | 'open' | 'history';
const TABS: readonly Tab[] = ['positions', 'open', 'history'];
const TH = 'whitespace-nowrap px-2 py-1.5 text-[12px] font-medium text-text-2';

function PositionsTable({
  positions,
  current,
  onOpen,
}: {
  positions: readonly PortfolioPosition[];
  current: string;
  onOpen: (symbol: string) => void;
}) {
  if (positions.length === 0)
    return (
      <EmptyState title="No open positions">
        Positions you hold appear here with their market value and unrealised P&amp;L.
      </EmptyState>
    );
  return (
    <div className="overflow-x-auto" role="region" aria-label="Positions table" tabIndex={0}>
      <table
        className="w-full min-w-[640px] border-collapse text-[13px]"
        data-testid="bottom-positions-table"
      >
        <caption className="sr-only">Your open positions. Select a symbol to open it.</caption>
        <thead>
          <tr>
            <th scope="col" className={`${TH} text-left`}>
              Symbol
            </th>
            <th scope="col" className={`${TH} text-right`}>
              Qty
            </th>
            <th scope="col" className={`${TH} text-right`}>
              Avg cost
            </th>
            <th scope="col" className={`${TH} text-right`}>
              Market value
            </th>
            <th scope="col" className={`${TH} text-right`}>
              Unrealised P&amp;L
            </th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => (
            <tr
              key={p.symbol}
              data-testid="bottom-position-row"
              data-symbol={p.symbol}
              aria-current={p.symbol === current ? 'true' : undefined}
              className={`border-t border-line hover:bg-bg-3 ${p.symbol === current ? 'bg-bg-3' : ''}`}
            >
              <th scope="row" className="px-2 py-1.5 text-left font-semibold text-text-0">
                <button
                  type="button"
                  data-testid="bottom-position-open"
                  aria-label={`Open ${p.symbol}`}
                  onClick={() => onOpen(p.symbol)}
                  className="rounded-sm text-left font-semibold text-text-0 underline-offset-2 hover:underline"
                >
                  {p.symbol}
                </button>
                {p.valuation === 'UNAVAILABLE' ? (
                  <span className="ml-2 text-[11px] font-normal text-stale">no usable price</span>
                ) : null}
              </th>
              <td className="num px-2 py-1.5 text-right">
                {formatQty(p.qty)}
                {isZeroDecimal(p.qtyReserved) ? null : (
                  <span className="block text-[11px] text-text-2">
                    {formatQty(p.qtyReserved)} reserved
                  </span>
                )}
              </td>
              <td className="num px-2 py-1.5 text-right">{formatPrice(p.avgCost)}</td>
              <td className="num px-2 py-1.5 text-right">
                {p.marketValue === null ? DASH : formatMoney(p.marketValue)}
              </td>
              <td className="px-2 py-1.5 text-right">
                <PnlCell value={p.unrealisedPnl} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The two order lists need a first answer; this loads it once (with a retry) and then hands over to the OrdersList. */
function OrdersTabs({
  view,
  onOpenCount,
}: {
  view: 'open' | 'history';
  onOpenCount: (n: number) => void;
}) {
  const [data, setData] = useState<
    { all: ListOrdersResponse; open: ListOrdersResponse } | 'error' | null
  >(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    void Promise.all([
      clientGet('/v1/orders?limit=50', ListOrdersResponse, controller.signal),
      clientGet('/v1/orders?status=open&limit=100', ListOrdersResponse, controller.signal),
    ]).then(([a, o]) => {
      if (controller.signal.aborted) return;
      setData(a.ok && o.ok ? { all: a.data, open: o.data } : 'error');
    });
    return () => controller.abort();
  }, [attempt]);
  if (data === null)
    return (
      <div
        aria-hidden="true"
        className="h-[120px] rounded-md bg-bg-2 motion-safe:animate-pulse"
        data-testid="bottom-orders-skeleton"
      />
    );
  if (data === 'error')
    return (
      <div data-testid="bottom-orders-error" className="flex flex-col items-start gap-2">
        <Alert kind="info">Your orders could not be loaded.</Alert>
        <button
          type="button"
          className={secondaryButtonClass}
          onClick={() => setAttempt((n) => n + 1)}
        >
          Try again
        </button>
      </div>
    );
  return <OrdersList initial={data.all} open={data.open} view={view} onOpenCount={onOpenCount} />;
}

export function BottomPanel({ current }: { current: string }) {
  const router = useRouter();
  const uid = useId();
  const portfolio = usePortfolio();
  const [tab, setTab] = useState<Tab>('positions');
  const [openCount, setOpenCount] = useState<number | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const positions = portfolio.data?.positions ?? [];
  const onOpenCount = useCallback((n: number) => setOpenCount(n), []);

  const labels: Record<Tab, string> = {
    positions: portfolio.data === null ? 'Positions' : `Positions (${String(positions.length)})`,
    open: openCount === null ? 'Open orders' : `Open orders (${String(openCount)})`,
    history: 'History',
  };

  function onKey(e: React.KeyboardEvent, index: number): void {
    const n = TABS.length;
    const to =
      e.key === 'ArrowRight' ? (index + 1) % n : e.key === 'ArrowLeft' ? (index + n - 1) % n : -1;
    if (to < 0) return;
    e.preventDefault();
    setTab(TABS[to] as Tab);
    tabRefs.current[to]?.focus();
  }

  return (
    <section
      aria-label="Your positions and orders"
      data-testid="terminal-bottom"
      className="border-t border-line bg-bg-1 px-4 py-4 lg:px-6"
    >
      <div
        role="tablist"
        aria-label="Positions and orders"
        className="mb-3 flex gap-5 font-semibold"
      >
        {TABS.map((t, i) => (
          <button
            key={t}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${uid}-${t}`}
            data-testid={`bottom-tab-${t}`}
            aria-selected={tab === t}
            aria-controls={t === 'positions' ? `${uid}-panel-positions` : `${uid}-panel-orders`}
            tabIndex={tab === t ? 0 : -1}
            onClick={() => setTab(t)}
            onKeyDown={(e) => onKey(e, i)}
            className={`border-b-2 pb-1.5 text-[13px] ${
              tab === t
                ? 'border-accent text-text-0'
                : 'border-transparent text-text-2 hover:text-text-0'
            }`}
          >
            {labels[t]}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${uid}-panel-positions`}
        aria-labelledby={`${uid}-positions`}
        hidden={tab !== 'positions'}
        data-testid="bottom-panel-positions"
      >
        {portfolio.data === null ? (
          <p className="text-[13px] text-text-2" data-testid="bottom-positions-unavailable">
            Your positions are not available right now.
          </p>
        ) : (
          <PositionsTable
            positions={positions}
            current={current}
            onOpen={(s) => router.push(`/instruments/${encodeURIComponent(s)}`)}
          />
        )}
        {portfolio.failed ? (
          <p className="mt-2 text-[12px] text-stale" data-testid="bottom-positions-stale">
            Could not refresh your positions; showing the last values.
          </p>
        ) : null}
      </div>
      {/* ONE orders list (one poller) serves both order tabs; it stays mounted so the open count is always known */}
      <div
        role="tabpanel"
        id={`${uid}-panel-orders`}
        aria-labelledby={`${uid}-${tab === 'history' ? 'history' : 'open'}`}
        hidden={tab === 'positions'}
        data-testid={tab === 'history' ? 'bottom-panel-history' : 'bottom-panel-open'}
      >
        <OrdersTabs view={tab === 'history' ? 'history' : 'open'} onOpenCount={onOpenCount} />
      </div>
    </section>
  );
}
