'use client';

import Link from 'next/link';
import type {
  InstrumentItem,
  MarketStatusResponse,
  OrderResponse,
  PositionResponse,
  QuoteItem,
} from '@vantage/contracts';
import { formatUtcShort } from '../lib/format';
import { formatMoney, formatPrice, formatQty } from '../lib/money';
import { ASSET_CLASS_LABELS, statusView } from '../lib/market';
import { rejectMessage } from '../lib/reject-copy';
import { useQuotePoll } from '../lib/use-quote-poll';
import { OrderTicket } from './order-ticket';
import { QuotePanel } from './quote-panel';
import { Alert, EmptyState } from './ui';

/** The status badge of an instrument: a word and a glyph, never colour alone. */
export function StatusBadge({ status }: { status: InstrumentItem['status'] }) {
  const v = statusView(status);
  const tone =
    v.tone === 'ok'
      ? 'border-up text-up'
      : v.tone === 'warn'
        ? 'border-warn text-warn'
        : 'border-down text-down';
  return (
    <span
      data-testid="instrument-status"
      data-status={status}
      className={`inline-flex items-center gap-1 rounded-sm border px-1.5 text-[11px] font-medium leading-[14px] ${tone}`}
    >
      <span aria-hidden="true">{v.tone === 'ok' ? '●' : v.tone === 'warn' ? '▲' : '✕'}</span>
      {v.label}
    </span>
  );
}

function PositionPanel({
  symbol,
  position,
}: {
  symbol: string;
  position: PositionResponse | null | undefined;
}) {
  return (
    <section aria-labelledby="position-title" data-testid="position-panel">
      <h2 id="position-title" className="mb-2 text-[16px] font-semibold leading-[22px] text-text-0">
        Your position
      </h2>
      {position === undefined ? (
        <p className="text-[13px] text-text-2" data-testid="position-error">
          Your position is not available right now.
        </p>
      ) : position === null ? (
        <p className="text-[13px] text-text-1" data-testid="position-none">
          You do not hold {symbol}.
        </p>
      ) : (
        <dl className="num grid max-w-xs grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
          <dt className="text-text-2">Shares</dt>
          <dd className="text-right text-text-0" data-testid="position-qty">
            {formatQty(position.qty)}
          </dd>
          <dt className="text-text-2">Average cost</dt>
          <dd className="text-right text-text-0" data-testid="position-avg-cost">
            {formatPrice(position.avgCost)}
          </dd>
        </dl>
      )}
    </section>
  );
}

function RecentOrders({
  symbol,
  orders,
}: {
  symbol: string;
  orders: readonly OrderResponse[] | null;
}) {
  return (
    <section aria-labelledby="recent-title" data-testid="recent-orders">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 id="recent-title" className="text-[16px] font-semibold leading-[22px] text-text-0">
          Recent orders in {symbol}
        </h2>
        <Link href="/orders" className="text-[12px]">
          All orders
        </Link>
      </div>
      {orders === null ? (
        <p className="text-[13px] text-text-2">Your recent orders are not available right now.</p>
      ) : orders.length === 0 ? (
        <EmptyState title={`No ${symbol} orders yet`}>
          Orders you place in this instrument appear here.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line bg-bg-1">
          {orders.map((o) => (
            <li
              key={o.id}
              data-testid="recent-order"
              data-status={o.status}
              className="px-3 py-2 text-[12px]"
            >
              <span className="num text-text-2">{formatUtcShort(o.createdAt)}</span>{' '}
              <span className={`font-medium ${o.side === 'BUY' ? 'text-up' : 'text-down'}`}>
                <span aria-hidden="true">{o.side === 'BUY' ? '▲ ' : '▼ '}</span>
                {o.side}
              </span>{' '}
              <span className="num text-text-0">{formatQty(o.qty)}</span> ·{' '}
              {o.status === 'FILLED' && o.execution !== null ? (
                <span className="num">
                  <span aria-hidden="true" className="text-up">
                    ✓{' '}
                  </span>
                  Filled @ {formatPrice(o.execution.price)}, fee {formatMoney(o.execution.fee)}
                </span>
              ) : (
                <span>
                  <span aria-hidden="true" className="text-down">
                    ✕{' '}
                  </span>
                  Rejected: {rejectMessage(o.rejectCode)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The instrument page body: header, an explanation of any non-ACTIVE status, the live quote panel (D-73), the user's
 * position and recent orders in this symbol. The first render comes from the server; the quote then refreshes itself.
 */
export function InstrumentView(props: {
  instrument: InstrumentItem;
  initialQuote: QuoteItem;
  market: MarketStatusResponse | null;
  position: PositionResponse | null | undefined;
  orders: readonly OrderResponse[] | null;
  quotePollMs: number;
}) {
  const { instrument } = props;
  const poll = useQuotePoll(instrument.symbol, props.initialQuote, props.quotePollMs);
  const sv = statusView(instrument.status);
  return (
    <div data-testid="instrument-page" data-symbol={instrument.symbol}>
      <div className="mb-3">
        <h1 className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[20px] font-semibold leading-[26px] text-text-0">
          <span className="num" data-testid="instrument-symbol">
            {instrument.symbol}
          </span>
          <span className="text-[14px] font-normal text-text-1" data-testid="instrument-name">
            {instrument.name}
          </span>
        </h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-text-2">
          <span>
            {instrument.exchange} · {ASSET_CLASS_LABELS[instrument.assetClass]} ·{' '}
            {instrument.currency}
          </span>
          <StatusBadge status={instrument.status} />
        </p>
      </div>
      {sv.explanation === null ? null : (
        <div className="mb-3" data-testid="status-explanation">
          <Alert kind="info">{sv.explanation}</Alert>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
        <div className="space-y-6">
          <QuotePanel
            instrument={instrument}
            quote={poll.quote}
            market={props.market}
            refreshFailed={poll.refreshFailed}
          />
          <PositionPanel symbol={instrument.symbol} position={props.position} />
          <RecentOrders symbol={instrument.symbol} orders={props.orders} />
        </div>
        <OrderTicket
          instrument={instrument}
          quote={poll.quote}
          refreshFailed={poll.refreshFailed}
          refreshQuote={poll.refreshNow}
          position={props.position}
        />
      </div>
    </div>
  );
}
