// Simulated depth view helpers (M8b-2). Pure text and lookups: NO arithmetic on prices or sizes (the ESLint money guard applies to
// the whole app). Every number shown is a string from the API; the order marker comes from the server's `level`.
import type { DepthLevel, MyDepthOrder } from '@vantage/contracts';

/** What the book area says when the API sent no levels (D-100). Never a level, never a price. */
export function unavailableMessage(freshness: string): string {
  switch (freshness) {
    case 'STALE':
      return 'Depth unavailable: quote is stale.';
    case 'CLOSED':
      return 'Depth unavailable: market is closed.';
    case 'UNAVAILABLE':
      return 'Depth unavailable: no quote right now.';
    default:
      return 'Depth unavailable right now.';
  }
}

/** One row of the book: the level as the server sent it, its 1-based level number and the caller's orders sitting there. */
export interface BookRow {
  readonly level: number;
  readonly price: string;
  readonly size: string;
  readonly cumPct: number;
  readonly mine: readonly MyDepthOrder[];
}

/**
 * Rows for one side. The caller's orders are matched to a row by the `level` the SERVER decided (exact decimal comparison), and
 * only on the side of the order (BUY orders sit on the bid ladder, SELL orders on the ask ladder).
 */
export function bookRows(
  levels: readonly DepthLevel[],
  side: 'BUY' | 'SELL',
  orders: readonly MyDepthOrder[],
): BookRow[] {
  return levels.map((l, index) => {
    const level = index + 1; // an ordinal, not a price
    return {
      level,
      price: l.price,
      size: l.size,
      cumPct: l.cumPct,
      mine: orders.filter((o) => o.onBook && o.side === side && o.level === level),
    };
  });
}

/** The caller's orders that are not on the displayed ladder (listed in a note, no arithmetic). */
export function outsideBook(orders: readonly MyDepthOrder[]): MyDepthOrder[] {
  return orders.filter((o) => !o.onBook);
}
