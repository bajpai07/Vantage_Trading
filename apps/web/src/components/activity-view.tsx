'use client';

import { ListActivityResponse, ListExecutionsResponse } from '@vantage/contracts';
import type { ActivityItem, ExecutionItem } from '@vantage/contracts';
import { formatUtcShort, shortId } from '../lib/format';
import { formatMoney, formatPrice, formatQty } from '../lib/money';
import { usePagedList } from '../lib/use-paged-list';
import type { Page } from '../lib/use-paged-list';
import { PnlCell } from './money';
import { Alert, EmptyState, secondaryButtonClass } from './ui';

const pickExecutions = (r: ListExecutionsResponse): Page<ExecutionItem> => ({
  items: r.executions,
  nextCursor: r.nextCursor,
});
const pickActivity = (r: ListActivityResponse): Page<ActivityItem> => ({
  items: r.activity,
  nextCursor: r.nextCursor,
});

const TH = 'whitespace-nowrap px-2 py-1.5 text-left text-[12px] font-medium text-text-2';

function LoadMore(props: {
  hasMore: boolean;
  loading: boolean;
  error: { message: string; support: string | null } | null;
  onClick: () => void;
  testId: string;
  endText: string;
}) {
  return (
    <>
      {props.error === null ? null : (
        <div className="mt-3">
          <Alert kind="error" support={props.error.support}>
            {props.error.message}
          </Alert>
        </div>
      )}
      {props.hasMore ? (
        <div className="mt-3 text-center">
          <button
            type="button"
            onClick={props.onClick}
            disabled={props.loading}
            aria-busy={props.loading}
            data-testid={props.testId}
            className={secondaryButtonClass}
          >
            {props.loading ? 'Loading…' : props.error === null ? 'Load more' : 'Try again'}
          </button>
        </div>
      ) : (
        <p className="mt-3 text-center text-[12px] text-text-2">{props.endText}</p>
      )}
    </>
  );
}

function Executions({ initial }: { initial: ListExecutionsResponse }) {
  const list = usePagedList({
    initial: { items: initial.executions, nextCursor: initial.nextCursor },
    path: '/v1/executions?limit=50',
    schema: ListExecutionsResponse,
    pick: pickExecutions,
  });
  if (list.items.length === 0) {
    return (
      <EmptyState title="No fills yet">
        Each time an order fills, the fill appears here with the price it used.
      </EmptyState>
    );
  }
  return (
    <div>
      <div
        className="relative overflow-x-auto rounded-md border border-line bg-bg-1"
        role="region"
        aria-label="Executions table"
        tabIndex={0}
      >
        <table
          className="w-full min-w-[820px] border-collapse text-[12px] leading-4"
          data-testid="executions-table"
        >
          <caption className="sr-only">Your executions, newest first</caption>
          <thead className="bg-bg-2">
            <tr>
              <th scope="col" className={TH}>
                Time
              </th>
              <th scope="col" className={TH}>
                Symbol
              </th>
              <th scope="col" className={TH}>
                Side
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Qty
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Price
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Fee
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Realised P&amp;L
              </th>
              <th scope="col" className={TH}>
                Quote used
              </th>
            </tr>
          </thead>
          <tbody>
            {list.items.map((e) => (
              <tr
                key={e.id}
                data-testid="execution-row"
                className="border-t border-line hover:bg-bg-3"
              >
                <td className="num whitespace-nowrap px-2 py-1 align-top text-text-1">
                  {formatUtcShort(e.executedAt)}
                </td>
                <th scope="row" className="px-2 py-1 text-left align-top font-semibold text-text-0">
                  {e.symbol}
                </th>
                <td
                  className={`px-2 py-1 align-top font-medium ${e.side === 'BUY' ? 'text-up' : 'text-down'}`}
                >
                  <span aria-hidden="true">{e.side === 'BUY' ? '▲ ' : '▼ '}</span>
                  {e.side}
                </td>
                <td className="num px-2 py-1 text-right align-top">{formatQty(e.qty)}</td>
                <td
                  className="num px-2 py-1 text-right align-top"
                  title={`Notional ${e.exact.notional}`}
                >
                  {formatPrice(e.price)}
                </td>
                <td
                  className="num px-2 py-1 text-right align-top"
                  title={`Exact fee ${e.exact.fee}`}
                >
                  {formatMoney(e.fee)}
                </td>
                <td className="px-2 py-1 text-right align-top">
                  {e.realisedPnl === null ? (
                    <span className="num text-text-2" data-testid="no-pnl">
                      —<span className="sr-only">a purchase has no realised result</span>
                    </span>
                  ) : (
                    <PnlCell value={e.realisedPnl} exact={e.exact.realisedPnl} testId="realised" />
                  )}
                </td>
                <td className="px-2 py-1 align-top text-text-2">
                  <span className="num">{e.quote.source}</span> ·{' '}
                  {e.quote.entitlement === 'DELAYED' ? 'delayed' : 'real-time'}
                  <div className="num text-[11px]">{formatUtcShort(e.quote.asOf)}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <LoadMore
        hasMore={list.hasMore}
        loading={list.loading}
        error={list.error}
        onClick={() => void list.loadMore()}
        testId="load-more-executions"
        endText="That is every fill."
      />
    </div>
  );
}

function Ledger({ initial }: { initial: ListActivityResponse }) {
  const list = usePagedList({
    initial: { items: initial.activity, nextCursor: initial.nextCursor },
    path: '/v1/ledger/activity?limit=50',
    schema: ListActivityResponse,
    pick: pickActivity,
  });
  if (list.items.length === 0) {
    return (
      <EmptyState title="No account activity yet">
        Your starting capital and every trade appear here.
      </EmptyState>
    );
  }
  return (
    <div>
      <div
        className="relative overflow-x-auto rounded-md border border-line bg-bg-1"
        role="region"
        aria-label="Account activity table"
        tabIndex={0}
      >
        <table
          className="w-full min-w-[620px] border-collapse text-[12px] leading-4"
          data-testid="activity-table"
        >
          <caption className="sr-only">Your account activity, newest first</caption>
          <thead className="bg-bg-2">
            <tr>
              <th scope="col" className={TH}>
                Time
              </th>
              <th scope="col" className={TH}>
                What
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Cash effect
              </th>
              <th scope="col" className={TH}>
                Order
              </th>
            </tr>
          </thead>
          <tbody>
            {list.items.map((a) => (
              <tr
                key={a.id}
                data-testid="activity-row"
                className="border-t border-line hover:bg-bg-3"
              >
                <td className="num whitespace-nowrap px-2 py-1 align-top text-text-1">
                  {formatUtcShort(a.createdAt)}
                </td>
                <th scope="row" className="px-2 py-1 text-left align-top font-normal text-text-0">
                  <span className="font-semibold">{a.title}</span>
                  {a.description === null ? null : (
                    <div className="text-text-2">{a.description}</div>
                  )}
                </th>
                <td className="px-2 py-1 text-right align-top">
                  <PnlCell value={a.cashEffect} exact={a.exact.cashEffect} testId="cash-effect" />
                </td>
                <td className="num px-2 py-1 align-top text-text-2">
                  {a.orderId === null ? '—' : `#${shortId(a.orderId)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <LoadMore
        hasMore={list.hasMore}
        loading={list.loading}
        error={list.error}
        onClick={() => void list.loadMore()}
        testId="load-more-activity"
        endText="That is all your account activity."
      />
    </div>
  );
}

/** Two lists on one page: your fills (with the quote each used) and your account activity in plain language. */
export function ActivityView(props: {
  executions: ListExecutionsResponse;
  activity: ListActivityResponse;
}) {
  return (
    <div>
      <h2 className="mb-2 text-[16px] font-semibold leading-[22px] text-text-0">Fills</h2>
      <Executions initial={props.executions} />
      <h2 className="mb-2 mt-8 text-[16px] font-semibold leading-[22px] text-text-0">
        Account activity
      </h2>
      <Ledger initial={props.activity} />
    </div>
  );
}
