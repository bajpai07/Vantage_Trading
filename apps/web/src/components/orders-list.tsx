'use client';

import { ListOrdersResponse } from '@vantage/contracts';
import type { OrderResponse } from '@vantage/contracts';
import { formatUtcShort } from '../lib/format';
import { formatMoney, formatPrice, formatQty } from '../lib/money';
import { rejectMessage } from '../lib/reject-copy';
import { usePagedList } from '../lib/use-paged-list';
import type { Page } from '../lib/use-paged-list';
import { Alert, EmptyState, secondaryButtonClass } from './ui';

const pick = (r: ListOrdersResponse): Page<OrderResponse> => ({
  items: r.orders,
  nextCursor: r.nextCursor,
});

const TH = 'whitespace-nowrap px-2 py-1.5 text-left text-[12px] font-medium text-text-2';

/** Order history, newest first, with "Load more" (cursor pagination). A reject is shown as a plain sentence. */
export function OrdersList({ initial }: { initial: ListOrdersResponse }) {
  const list = usePagedList({
    initial: { items: initial.orders, nextCursor: initial.nextCursor },
    path: '/v1/orders?limit=50',
    schema: ListOrdersResponse,
    pick,
  });

  if (list.items.length === 0) {
    return (
      <EmptyState title="No orders yet">
        Orders you place appear here, filled or rejected, newest first.
      </EmptyState>
    );
  }
  return (
    <div>
      <div
        className="relative overflow-x-auto rounded-md border border-line bg-bg-1"
        role="region"
        aria-label="Orders table"
        tabIndex={0}
      >
        <table
          className="w-full min-w-[640px] border-collapse text-[12px] leading-4"
          data-testid="orders-table"
        >
          <caption className="sr-only">Your orders, newest first</caption>
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
              <th scope="col" className={TH}>
                Status
              </th>
              <th scope="col" className={TH}>
                Result
              </th>
            </tr>
          </thead>
          <tbody>
            {list.items.map((o) => (
              <tr
                key={o.id}
                data-testid="order-row"
                data-status={o.status}
                className="border-t border-line hover:bg-bg-3"
              >
                <td className="num whitespace-nowrap px-2 py-1 align-top text-text-1">
                  {formatUtcShort(o.createdAt)}
                </td>
                <th scope="row" className="px-2 py-1 text-left align-top font-semibold text-text-0">
                  {o.symbol}
                </th>
                <td
                  className={`px-2 py-1 align-top font-medium ${o.side === 'BUY' ? 'text-up' : 'text-down'}`}
                >
                  <span aria-hidden="true">{o.side === 'BUY' ? '▲ ' : '▼ '}</span>
                  {o.side}
                </td>
                <td className="num px-2 py-1 text-right align-top">{formatQty(o.qty)}</td>
                <td className="whitespace-nowrap px-2 py-1 align-top">
                  {o.status === 'FILLED' ? (
                    <span className="text-text-0">
                      <span aria-hidden="true" className="text-up">
                        ✓{' '}
                      </span>
                      Filled
                    </span>
                  ) : (
                    <span className="text-text-0" data-testid="reject-status">
                      <span aria-hidden="true" className="text-down">
                        ✕{' '}
                      </span>
                      Rejected
                    </span>
                  )}
                </td>
                <td className="px-2 py-1 align-top text-text-1" data-testid="order-result">
                  {o.status === 'FILLED' && o.execution !== null ? (
                    <span className="num">
                      {formatQty(o.execution.qty)} @ {formatPrice(o.execution.price)} · notional{' '}
                      {formatMoney(o.execution.notional)} · fee {formatMoney(o.execution.fee)}
                    </span>
                  ) : (
                    <span data-testid="reject-reason">{rejectMessage(o.rejectCode)}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.error === null ? null : (
        <div className="mt-3">
          <Alert kind="error" support={list.error.support}>
            {list.error.message}
          </Alert>
        </div>
      )}
      {list.hasMore ? (
        <div className="mt-3 text-center">
          <button
            type="button"
            onClick={() => void list.loadMore()}
            disabled={list.loading}
            aria-busy={list.loading}
            data-testid="load-more"
            className={secondaryButtonClass}
          >
            {list.loading ? 'Loading…' : list.error === null ? 'Load more' : 'Try again'}
          </button>
        </div>
      ) : (
        <p className="mt-3 text-center text-[12px] text-text-2" data-testid="end-of-list">
          That is every order.
        </p>
      )}
    </div>
  );
}
