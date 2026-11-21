'use client';

// The simulated order book (M8b-2, D-98 to D-102). INFORMATIONAL: its best bid and ask are the quote's own, the levels beyond are
// synthetic, and fills use the simulated execution model, not this book. Every number is a string from the API; this component
// does no arithmetic (the spread, mid, depth-bar percentages and the order placement are computed by the server).
import { DEPTH_NOTE } from '@vantage/contracts';
import type { DepthResponse, MyDepthOrder } from '@vantage/contracts';
import { bookRows, outsideBook, unavailableMessage } from '../lib/depth';
import type { BookRow } from '../lib/depth';
import { formatMoney, formatPrice, formatQty } from '../lib/money';
import type { DepthState } from '../lib/use-depth-poll';
import { Alert } from './ui';

const CELL = 'px-2 py-0.5';

function Row({
  row,
  tone,
  canPick,
  onPick,
  hintId,
}: {
  row: BookRow;
  tone: 'ask' | 'bid';
  canPick: boolean;
  onPick: (price: string) => void;
  hintId: string;
}) {
  const colour = tone === 'ask' ? 'text-down' : 'text-up';
  return (
    <tr
      data-testid={`depth-${tone}-row`}
      data-level={row.level}
      data-mine={row.mine.length > 0 ? 'true' : 'false'}
      className="relative border-t border-line"
    >
      <td className={`${CELL} relative text-right`}>
        <span
          aria-hidden="true"
          data-testid="depth-bar"
          className={`pointer-events-none absolute inset-y-0 right-0 opacity-20 ${tone === 'ask' ? 'bg-down' : 'bg-up'}`}
          style={{ width: `${String(row.cumPct)}%` }}
        />
        <button
          type="button"
          data-testid="depth-price"
          aria-disabled={canPick ? undefined : true}
          aria-describedby={canPick ? undefined : hintId}
          aria-label={`${tone === 'ask' ? 'Ask' : 'Bid'} level ${String(row.level)}, price ${formatPrice(row.price)}${canPick ? ': use as limit price' : ''}`}
          onClick={() => {
            if (canPick) onPick(row.price);
          }}
          className={`num relative min-h-6 text-right font-medium underline-offset-2 hover:underline ${colour} ${canPick ? '' : 'cursor-not-allowed'}`}
        >
          {formatPrice(row.price)}
        </button>
      </td>
      <td className={`${CELL} num text-right text-text-1`} data-testid="depth-size">
        {formatQty(row.size)}
      </td>
      <td className={`${CELL} text-[11px]`}>
        {row.mine.map((o) => (
          <span key={o.orderId} data-testid="depth-your-order" className="font-medium text-text-0">
            <span aria-hidden="true">◆ </span>Your order · {o.side === 'BUY' ? 'buy' : 'sell'}{' '}
            <span className="num">{formatQty(o.qty)}</span>
          </span>
        ))}
      </td>
    </tr>
  );
}

function Outside({ orders }: { orders: readonly MyDepthOrder[] }) {
  if (orders.length === 0) return null;
  return (
    <div data-testid="depth-outside" className="mt-2 text-[12px] text-text-1">
      <p className="font-medium text-text-0">Your orders outside the visible book</p>
      <ul className="mt-0.5">
        {orders.map((o) => (
          <li key={o.orderId} data-testid="depth-outside-order" className="num">
            {o.side === 'BUY' ? 'Buy' : 'Sell'} {formatQty(o.qty)} at {formatPrice(o.price)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Book({
  depth,
  mine,
  symbol,
  canPick,
  onPick,
}: {
  depth: DepthResponse;
  mine: readonly MyDepthOrder[];
  symbol: string;
  canPick: boolean;
  onPick: (price: string) => void;
}) {
  const levels = depth.levels;
  if (levels === null) return null;
  // asks on top with the LOWEST ask nearest the spread, so they are shown in reverse; bids below, best first
  const asks = bookRows(levels.asks, 'SELL', mine).reverse();
  const bids = bookRows(levels.bids, 'BUY', mine);
  const hintId = 'depth-pick-hint';
  return (
    <>
      <table className="w-full text-[12px]" data-testid="depth-table">
        <caption className="mb-1 text-left text-[13px] font-medium text-text-0">
          Simulated order book for {symbol}
        </caption>
        <thead>
          <tr className="text-text-2">
            <th scope="col" className={`${CELL} text-right font-normal`}>
              Price (USD)
            </th>
            <th scope="col" className={`${CELL} text-right font-normal`}>
              Size
            </th>
            <th scope="col" className={`${CELL} text-left font-normal`}>
              Yours
            </th>
          </tr>
        </thead>
        <tbody>
          {asks.map((r) => (
            <Row
              key={`a${String(r.level)}`}
              row={r}
              tone="ask"
              canPick={canPick}
              onPick={onPick}
              hintId={hintId}
            />
          ))}
          <tr className="border-t border-line bg-bg-2" data-testid="depth-spread-row">
            <td colSpan={3} className={`${CELL} num text-center text-text-1`}>
              Spread <span data-testid="depth-spread">{formatMoney(depth.spread)}</span> · Mid{' '}
              <span data-testid="depth-mid">{formatMoney(depth.mid)}</span>
            </td>
          </tr>
          {bids.map((r) => (
            <Row
              key={`b${String(r.level)}`}
              row={r}
              tone="bid"
              canPick={canPick}
              onPick={onPick}
              hintId={hintId}
            />
          ))}
        </tbody>
      </table>
      <p id={hintId} data-testid="depth-pick-hint" className="mt-1 text-[11px] text-text-2">
        {canPick
          ? 'Select a price to copy it into the limit price.'
          : 'Switch the order ticket to Limit to copy a price from the book.'}
      </p>
      <Outside orders={outsideBook(mine)} />
    </>
  );
}

/**
 * The book panel. The honesty sentence is always visible text next to the book (also while loading, on error and when there
 * is no book); the "Simulated market data" banner of the layout stays. Without levels (stale, closed, unavailable, error) no
 * level is rendered at all.
 */
export function DepthBook({
  symbol,
  state,
  canPick,
  onPick,
}: {
  symbol: string;
  state: DepthState;
  canPick: boolean;
  onPick: (price: string) => void;
}) {
  return (
    <section
      aria-labelledby="depth-title"
      data-testid="depth-panel"
      className="rounded-md border border-line bg-bg-1 p-3"
    >
      <h2 id="depth-title" className="mb-1 text-[16px] font-semibold leading-[22px] text-text-0">
        Market depth
      </h2>
      <p data-testid="depth-honesty" className="mb-2 text-[12px] text-text-1">
        {DEPTH_NOTE}
      </p>
      {state.kind === 'loading' ? (
        <p role="status" data-testid="depth-loading" className="text-[13px] text-text-2">
          Loading depth…
        </p>
      ) : state.kind === 'error' ? (
        <div data-testid="depth-error">
          <Alert kind="info">Depth is not available right now. It will retry shortly.</Alert>
        </div>
      ) : state.depth.levels === null ? (
        <p role="status" data-testid="depth-unavailable" className="text-[13px] text-text-1">
          {unavailableMessage(state.depth.freshness)}
        </p>
      ) : (
        <div data-testid="depth-ready" className="overflow-x-hidden">
          <Book
            depth={state.depth}
            mine={state.mine === null ? [] : state.mine.orders}
            symbol={symbol}
            canPick={canPick}
            onPick={onPick}
          />
        </div>
      )}
    </section>
  );
}
