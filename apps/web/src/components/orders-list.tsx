'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ListOrdersResponse, OrderResponse } from '@vantage/contracts';
import { clientGet, clientRequest } from '../lib/client-api';
import { describeFailure } from '../lib/errors';
import { formatUtc, formatUtcShort } from '../lib/format';
import { formatMoney, formatPrice, formatQty } from '../lib/money';
import { heldLabel, releasedSentence, STATUS_CHIPS, typeLabel } from '../lib/orders-view';
import { rejectMessage } from '../lib/reject-copy';
import { loginUrlFor } from '../lib/return-to';
import { isRetryable } from '../lib/ticket';
import { usePagedList } from '../lib/use-paged-list';
import type { Page } from '../lib/use-paged-list';
import { Alert, EmptyState, secondaryButtonClass } from './ui';

const pick = (r: ListOrdersResponse): Page<OrderResponse> => ({
  items: r.orders,
  nextCursor: r.nextCursor,
});

const TH = 'whitespace-nowrap px-2 py-1.5 text-left text-[12px] font-medium text-text-2';
/** How often the lists look for changes made by the matcher (a fill, an expiry) while the page is open. */
const ORDERS_POLL_MS = 3000;

function StatusChip({ status }: { status: OrderResponse['status'] }) {
  const c = STATUS_CHIPS[status];
  return (
    <span className={`font-medium ${c.tone}`} data-testid="status-chip" data-status={status}>
      <span aria-hidden="true">{c.glyph} </span>
      {c.label}
    </span>
  );
}

/**
 * Orders: the open (resting) limit orders with a Cancel button each, then the history, newest first, with "Load more".
 * Cancel sends one Idempotency-Key per attempt and reuses it for a retry after a network error, so a double click or a retry
 * can never cancel twice; the answer says what was released. A reject is shown as a plain sentence. No arithmetic: every
 * figure is a string the API sent.
 */
export function OrdersList({
  initial,
  open,
}: {
  initial: ListOrdersResponse;
  open: ListOrdersResponse;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const list = usePagedList({
    initial: { items: initial.orders, nextCursor: initial.nextCursor },
    path: '/v1/orders?limit=50',
    schema: ListOrdersResponse,
    pick,
  });
  const [head, setHead] = useState<readonly OrderResponse[]>(initial.orders);
  const [openOrders, setOpenOrders] = useState<readonly OrderResponse[]>(open.orders);
  const [updated, setUpdated] = useState<Readonly<Record<string, OrderResponse>>>({});
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const attempts = useRef(new Map<string, string>());
  const inflight = useRef(new Set<string>());

  // look for what the matcher did (fills, expiries) while the page is open
  useEffect(() => {
    let stopped = false;
    const tick = async (): Promise<void> => {
      const [a, b] = await Promise.all([
        clientGet('/v1/orders?limit=50', ListOrdersResponse),
        clientGet('/v1/orders?status=open&limit=100', ListOrdersResponse),
      ]);
      if (stopped) return;
      if (a.ok) {
        setHead(a.data.orders);
        setUpdated({});
      }
      if (b.ok) setOpenOrders(b.data.orders);
    };
    const id = setInterval(() => void tick(), ORDERS_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, []);

  async function cancel(o: OrderResponse): Promise<void> {
    if (inflight.current.has(o.id)) return; // a second click while the first is in flight does nothing
    inflight.current.add(o.id);
    setBusy(new Set(inflight.current));
    const key = attempts.current.get(o.id) ?? crypto.randomUUID();
    attempts.current.set(o.id, key);
    const r = await clientRequest('POST', `/v1/orders/${o.id}/cancel`, OrderResponse, {
      headers: { 'Idempotency-Key': key },
    });
    inflight.current.delete(o.id);
    setBusy(new Set(inflight.current));
    if (r.ok) {
      attempts.current.delete(o.id);
      setUpdated((u) => ({ ...u, [o.id]: r.data }));
      setOpenOrders((l) => l.filter((x) => x.id !== o.id));
      setNotice({
        kind: 'ok',
        text: r.data.released ? releasedSentence(r.data.released, o.symbol) : 'Cancelled.',
      });
      router.refresh();
      return;
    }
    if (r.kind === 'unauthenticated') {
      router.replace(loginUrlFor(pathname));
      return;
    }
    if (r.kind === 'conflict') {
      attempts.current.delete(o.id);
      setOpenOrders((l) => l.filter((x) => x.id !== o.id));
      setNotice({
        kind: 'error',
        text: 'This order is no longer open, so there is nothing to cancel.',
      });
      router.refresh();
      return;
    }
    if (isRetryable(r)) {
      // the key is kept: pressing Cancel again is the same request and cannot cancel twice
      setNotice({
        kind: 'error',
        text: "We couldn't confirm the cancel. It may or may not have gone through: press Cancel again, it is safe to retry.",
      });
      return;
    }
    attempts.current.delete(o.id);
    setNotice({ kind: 'error', text: describeFailure(r, 'load').message });
  }

  const headIds = new Set(head.map((o) => o.id));
  const rows = [...head, ...list.items.filter((o) => !headIds.has(o.id))].map(
    (o) => updated[o.id] ?? o,
  );

  if (rows.length === 0 && openOrders.length === 0) {
    return (
      <EmptyState title="No orders yet">
        Orders you place appear here, filled, resting, cancelled or rejected, newest first.
      </EmptyState>
    );
  }
  return (
    <div>
      <section aria-labelledby="open-orders-title" className="mb-6" data-testid="open-orders">
        <h2
          id="open-orders-title"
          className="mb-2 text-[16px] font-semibold leading-[22px] text-text-0"
        >
          Open orders
        </h2>
        <div
          role="status"
          aria-live="polite"
          data-testid="cancel-notice"
          className="mb-2 min-h-[0px]"
        >
          {notice === null ? null : (
            <Alert kind={notice.kind === 'ok' ? 'info' : 'error'}>{notice.text}</Alert>
          )}
        </div>
        {openOrders.length === 0 ? (
          <p className="text-[13px] text-text-2" data-testid="open-orders-empty">
            No open orders. A limit order that is not filled right away rests here until it fills,
            you cancel it or it expires.
          </p>
        ) : (
          <div
            className="relative overflow-x-auto rounded-md border border-line bg-bg-1"
            role="region"
            aria-label="Open orders table"
            tabIndex={0}
          >
            <table
              className="w-full min-w-[720px] border-collapse text-[12px] leading-4"
              data-testid="open-orders-table"
            >
              <caption className="sr-only">Your open orders</caption>
              <thead className="bg-bg-2">
                <tr>
                  <th scope="col" className={TH}>
                    Placed
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
                    Type
                  </th>
                  <th scope="col" className={TH}>
                    Held
                  </th>
                  <th scope="col" className={TH}>
                    Expires
                  </th>
                  <th scope="col" className={TH}>
                    <span className="sr-only">Cancel</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {openOrders.map((o) => (
                  <tr
                    key={o.id}
                    data-testid="open-order-row"
                    className="border-t border-line hover:bg-bg-3"
                  >
                    <td className="num whitespace-nowrap px-2 py-1 align-top text-text-1">
                      {formatUtcShort(o.createdAt)}
                    </td>
                    <th
                      scope="row"
                      className="px-2 py-1 text-left align-top font-semibold text-text-0"
                    >
                      {o.symbol}
                    </th>
                    <td
                      className={`px-2 py-1 align-top font-medium ${o.side === 'BUY' ? 'text-up' : 'text-down'}`}
                    >
                      <span aria-hidden="true">{o.side === 'BUY' ? '▲ ' : '▼ '}</span>
                      {o.side}
                    </td>
                    <td className="num px-2 py-1 text-right align-top">{formatQty(o.qty)}</td>
                    <td
                      className="num px-2 py-1 align-top text-text-1"
                      data-testid="open-order-type"
                    >
                      {typeLabel(o)}
                    </td>
                    <td
                      className="num px-2 py-1 align-top text-text-1"
                      data-testid="open-order-held"
                    >
                      {heldLabel(o) ?? '—'}
                    </td>
                    <td
                      className="num whitespace-nowrap px-2 py-1 align-top text-text-1"
                      data-testid="open-order-expires"
                    >
                      {o.expiresAt === null ? '—' : formatUtc(o.expiresAt)}
                    </td>
                    <td className="px-2 py-1 align-top">
                      <button
                        type="button"
                        data-testid="cancel-button"
                        disabled={busy.has(o.id)}
                        aria-busy={busy.has(o.id)}
                        aria-label={`Cancel ${o.side === 'BUY' ? 'buy' : 'sell'} ${formatQty(o.qty)} ${o.symbol} limit order`}
                        onClick={() => void cancel(o)}
                        className={secondaryButtonClass}
                      >
                        {busy.has(o.id) ? 'Cancelling…' : 'Cancel'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <h2 className="mb-2 text-[16px] font-semibold leading-[22px] text-text-0">History</h2>
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
                Type
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
            {rows.map((o) => (
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
                <td className="num px-2 py-1 align-top text-text-1">{typeLabel(o)}</td>
                <td className="whitespace-nowrap px-2 py-1 align-top">
                  {o.status === 'REJECTED' ? (
                    <span data-testid="reject-status">
                      <StatusChip status={o.status} />
                    </span>
                  ) : (
                    <StatusChip status={o.status} />
                  )}
                </td>
                <td className="px-2 py-1 align-top text-text-1" data-testid="order-result">
                  {o.status === 'FILLED' && o.execution !== null ? (
                    <span className="num">
                      {formatQty(o.execution.qty)} @ {formatPrice(o.execution.price)} · notional{' '}
                      {formatMoney(o.execution.notional)} · fee {formatMoney(o.execution.fee)}
                    </span>
                  ) : o.status === 'REJECTED' ? (
                    <span data-testid="reject-reason">{rejectMessage(o.rejectCode)}</span>
                  ) : o.status === 'ACCEPTED' ? (
                    <span>Resting until filled, cancelled or expired.</span>
                  ) : o.status === 'CANCELLED' ? (
                    <span>Cancelled by you. Nothing was bought or sold.</span>
                  ) : (
                    <span>Expired. Nothing was bought or sold.</span>
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
