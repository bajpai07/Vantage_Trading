// Merging the latest candles of the bounded refresh into the list on screen (M9a). Strings only: candles are compared by their open
// time text (ISO instants sort as text), never by number.
import type { CandleItem } from '@vantage/contracts';

/** At most this many candles are kept on screen. */
export const KEEP_MAX = 400;

/** A known open time is replaced (the forming candle moves), a newer one is appended, an older unknown one is ignored. */
export function mergeCandles(
  current: readonly CandleItem[],
  latest: readonly CandleItem[],
): CandleItem[] {
  const out = [...current];
  for (const c of latest) {
    const at = out.findIndex((x) => x.t === c.t);
    if (at >= 0) out[at] = c;
    else if (out.length === 0 || c.t > (out[out.length - 1] as CandleItem).t) out.push(c);
  }
  return out.length > KEEP_MAX ? out.slice(out.length - KEEP_MAX) : out;
}
