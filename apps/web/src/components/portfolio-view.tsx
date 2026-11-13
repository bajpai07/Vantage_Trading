'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PortfolioResponse } from '@vantage/contracts';
import type { EquitySnapshot, PortfolioPosition } from '@vantage/contracts';
import { clientGet } from '../lib/client-api';
import { describeFailure } from '../lib/errors';
import type { FailureMessage } from '../lib/errors';
import { formatUtc, formatUtcShort } from '../lib/format';
import { DASH, formatPrice, formatQty } from '../lib/money';
import { EquityLine } from './equity-line';
import { FreshnessBadge } from './freshness-badge';
import { MetricCard, Money, PnlCell } from './money';
import { Alert, EmptyState } from './ui';

/**
 * The portfolio screen. Everything shown is a string from the API, validated against the contract, displayed as
 * received. First paint comes from the server; then it refreshes itself every `pollMs` while the tab is visible and
 * stops while it is hidden (D-67). A failed refresh keeps the last data on screen, says so, and shows how old it is.
 */
export function PortfolioView(props: {
  initial: PortfolioResponse;
  history: readonly EquitySnapshot[] | null;
  pollMs: number;
}) {
  const router = useRouter();
  const [data, setData] = useState<PortfolioResponse>(props.initial);
  const [refreshError, setRefreshError] = useState<FailureMessage | null>(null);
  const inflight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    async function refresh(): Promise<void> {
      if (inflight.current) return;
      inflight.current = true;
      const r = await clientGet('/v1/portfolio', PortfolioResponse);
      inflight.current = false;
      if (cancelled) return;
      if (r.ok) {
        setData(r.data);
        setRefreshError(null);
      } else if (r.kind === 'unauthenticated') {
        router.replace('/login?reason=expired');
        router.refresh();
      } else {
        setRefreshError(describeFailure(r, 'load'));
      }
    }
    const start = (): void => {
      timer ??= setInterval(() => void refresh(), props.pollMs);
    };
    const stop = (): void => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = (): void => {
      if (document.hidden) stop();
      else {
        void refresh(); // catch up at once when the tab comes back
        start();
      }
    };
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [props.pollMs, router]);

  const p = data;
  return (
    <section
      aria-labelledby="portfolio-title"
      data-testid="portfolio"
      data-generated-at={p.generatedAt}
    >
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h1 id="portfolio-title" className="text-[20px] font-semibold leading-[26px] text-text-0">
          Portfolio
        </h1>
        <p className="text-[12px] text-text-2" data-testid="updated-at">
          Updated <span className="num">{formatUtc(p.generatedAt)}</span>
        </p>
      </div>

      {refreshError === null ? null : (
        <div className="mb-3" data-testid="refresh-error">
          <Alert kind="error" support={refreshError.support}>
            Could not refresh. {refreshError.message} The figures below are from{' '}
            <span className="num">{formatUtc(p.generatedAt)}</span>.
          </Alert>
        </div>
      )}

      {p.incomplete ? (
        <div className="mb-3" data-testid="incomplete-notice">
          <Alert kind="info" testId="incomplete-alert">
            <strong>Incomplete valuation.</strong> {String(p.unvaluedCount)} position
            {p.unvaluedCount === 1 ? ' has' : 's have'} no usable price and{' '}
            {p.unvaluedCount === 1 ? 'is' : 'are'} not included in equity, unrealised P&amp;L or
            total return.
          </Alert>
        </div>
      ) : null}

      <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-6">
        <MetricCard
          label="Equity"
          testId="metric-equity"
          note={p.incomplete ? 'Excludes positions without a price' : undefined}
        >
          <Money value={p.equity} exact={p.exact.equity} />
        </MetricCard>
        <MetricCard label="Cash" testId="metric-cash">
          <Money value={p.cash} exact={p.exact.cash} />
        </MetricCard>
        <MetricCard
          label="Total return"
          testId="metric-total-return"
          note={
            p.totalReturn === null ? 'Not available while some positions have no price' : undefined
          }
        >
          {p.totalReturn === null ? (
            <span data-testid="total-return-unavailable">
              {DASH}
              <span className="sr-only">not available</span>
            </span>
          ) : (
            <PnlCell value={p.totalReturn} exact={p.exact.totalReturn} />
          )}
        </MetricCard>
        <MetricCard label="Unrealised P&L" testId="metric-unrealised">
          <PnlCell value={p.unrealisedPnl} exact={p.exact.unrealisedPnl} />
        </MetricCard>
        <MetricCard label="Realised P&L" testId="metric-realised">
          <PnlCell value={p.realisedPnl} exact={p.exact.realisedPnl} />
        </MetricCard>
        <MetricCard label="Fees paid" testId="metric-fees">
          <Money value={p.fees} exact={p.exact.fees} />
        </MetricCard>
      </div>

      <p className="mb-4 text-[12px] text-text-2" data-testid="marks-as-of">
        {p.asOf === null ? (
          'No prices were used for this valuation.'
        ) : (
          <>
            Oldest price used: <span className="num">{formatUtc(p.asOf)}</span>. Positions are
            valued at the bid.
          </>
        )}
      </p>

      <h2 className="mb-2 text-[16px] font-semibold leading-[22px] text-text-0">Holdings</h2>
      {p.positions.length === 0 ? (
        <EmptyState title="No positions yet">
          You hold only cash, so your equity equals your cash. Positions appear here after your
          first order fills.
        </EmptyState>
      ) : (
        <PositionsTable positions={p.positions} />
      )}

      <h2 className="mb-2 mt-6 text-[16px] font-semibold leading-[22px] text-text-0">
        Equity history
      </h2>
      {props.history === null ? (
        <p className="text-[13px] text-text-2" data-testid="history-error">
          The equity history is not available right now.
        </p>
      ) : (
        <EquityLine snapshots={props.history} />
      )}

      <details className="mt-6" data-testid="exact-amounts">
        <summary className="cursor-pointer text-[13px] text-accent">Exact amounts</summary>
        <dl className="num mt-2 grid max-w-md grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
          {(
            [
              ['Equity', p.exact.equity],
              ['Cash', p.exact.cash],
              ['Positions value', p.exact.positionsValue],
              ['Cost basis', p.exact.costBasis],
              ['Unrealised P&L', p.exact.unrealisedPnl],
              ['Realised P&L', p.exact.realisedPnl],
              ['Fees', p.exact.fees],
              ['Total return', p.exact.totalReturn],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-text-2">{k}</dt>
              <dd className="text-right text-text-1">{v ?? DASH}</dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
}

const TH = 'whitespace-nowrap px-2 py-1.5 text-right text-[12px] font-medium text-text-2';
const TD = 'whitespace-nowrap px-2 py-1 text-right align-top';

function PositionsTable({ positions }: { positions: readonly PortfolioPosition[] }) {
  return (
    <div
      className="relative overflow-x-auto rounded-md border border-line bg-bg-1"
      role="region"
      aria-label="Holdings table"
      tabIndex={0}
    >
      <table
        className="w-full min-w-[720px] border-collapse text-[12px] leading-4"
        data-testid="positions-table"
      >
        <caption className="sr-only">Your positions, valued at the bid price</caption>
        <thead className="bg-bg-2">
          <tr>
            <th
              scope="col"
              className="whitespace-nowrap px-2 py-1.5 text-left text-[12px] font-medium text-text-2"
            >
              Symbol
            </th>
            <th scope="col" className={TH}>
              Qty
            </th>
            <th scope="col" className={TH}>
              Avg cost
            </th>
            <th scope="col" className={TH}>
              Mark
            </th>
            <th scope="col" className={TH}>
              Market value
            </th>
            <th scope="col" className={TH}>
              Unrealised P&amp;L
            </th>
            <th
              scope="col"
              className="whitespace-nowrap px-2 py-1.5 text-left text-[12px] font-medium text-text-2"
            >
              Price status
            </th>
          </tr>
        </thead>
        <tbody>
          {positions.map((pos) => {
            const unavailable = pos.valuation === 'UNAVAILABLE';
            return (
              <tr
                key={pos.symbol}
                data-testid={`position-row-${pos.symbol}`}
                data-valuation={pos.valuation}
                className={`border-t border-line hover:bg-bg-3 ${unavailable ? 'border-l-2 border-l-down' : ''}`}
              >
                <th scope="row" className="px-2 py-1 text-left align-top font-semibold text-text-0">
                  {pos.symbol}
                  {unavailable ? (
                    <div
                      className="text-[11px] font-medium text-down"
                      data-testid="unavailable-flag"
                    >
                      <span aria-hidden="true">✕ </span>No price: excluded from totals
                    </div>
                  ) : null}
                </th>
                <td className={`num ${TD}`}>{formatQty(pos.qty)}</td>
                <td className={`num ${TD}`}>
                  <span title={`Cost basis ${pos.exact.costBasis}`}>
                    {formatPrice(pos.avgCost)}
                  </span>
                </td>
                <td className={`num ${TD}`} data-testid="mark">
                  {pos.mark === null ? (
                    <>
                      {DASH}
                      <span className="sr-only">no price</span>
                    </>
                  ) : (
                    <>
                      {formatPrice(pos.mark)}{' '}
                      <span className="text-[11px] text-text-2" data-testid="mark-basis">
                        {pos.markBasis}
                      </span>
                    </>
                  )}
                </td>
                <td className={TD} data-testid="market-value">
                  <Money value={pos.marketValue} exact={pos.exact.marketValue} />
                </td>
                <td className={TD}>
                  <PnlCell
                    value={pos.unrealisedPnl}
                    exact={pos.exact.unrealisedPnl}
                    testId="unrealised"
                  />
                </td>
                <td className="px-2 py-1 text-left align-top">
                  <FreshnessBadge
                    state={pos.quote.freshness}
                    source={pos.quote.source}
                    asOf={pos.quote.asOf}
                  />
                  <div className="num mt-0.5 text-[11px] text-text-2" data-testid="as-of">
                    {pos.quote.asOf === null ? 'No quote' : formatUtcShort(pos.quote.asOf)}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
