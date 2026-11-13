// Geometry for the equity line. The values are money, so they are never converted to JS numbers: they are read as
// scaled BigInt integers (exact), and only the resulting PIXEL positions, which are not money, become numbers. The
// labels shown next to the chart are the original strings, untouched.
import { splitDecimal } from './money';

const SCALE_DIGITS = 8;

/** "10049.60" -> 1004960000000n (8 fraction digits, exact). Null when it is not a plain decimal. */
export function toScaledBigInt(value: string): bigint | null {
  const p = splitDecimal(value);
  if (p === null) return null;
  const frac = p.frac.padEnd(SCALE_DIGITS, '0').slice(0, SCALE_DIGITS);
  const n = BigInt(`${p.int}${frac}`);
  return p.negative ? -n : n;
}

export interface ChartPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Maps the values to an `width` x `height` box: the first value at the left edge, the last at the right edge, equal
 * spacing in between (trading days are not drawn to calendar scale), the highest value at the top (y = 0). A flat
 * series is drawn through the middle. Returns null when there are fewer than two valid values.
 */
export function scaleSeries(
  values: readonly string[],
  width: number,
  height: number,
): ChartPoint[] | null {
  const scaled = values.map(toScaledBigInt);
  if (scaled.length < 2 || scaled.some((v) => v === null)) return null;
  const vs = scaled as bigint[];
  let min = vs[0] as bigint;
  let max = min;
  for (const v of vs) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  const last = vs.length - 1;
  return vs.map((v, i) => ({
    x: Math.round((i * width) / last),
    y:
      range === 0n ? Math.round(height / 2) : height - Number(((v - min) * BigInt(height)) / range),
  }));
}
