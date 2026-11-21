// THE ONE AUDITED NUMBER MODULE of the web app (M9a, D-103).
//
// The browser never does arithmetic on money: prices, sizes, spreads and percentages are decimal STRINGS from the API, shown as
// received. The charting library, however, can only be given JavaScript numbers to POSITION pixels. This is the only file allowed
// to turn a decimal string into a number (Number(), Math.* and decimal literals are banned in every other source file of apps/web
// by ESLint), and the rules for it are:
//   1. the numbers made here only ever go to the chart library, to place candles, bars and axis ticks;
//   2. they never reach order, ticket, money or portfolio code (a lint rule forbids importing this module from anywhere but the
//      chart components), and they are never shown as text except as the rounded tick labels of the price axis;
//   3. everything displayed as text (legend, last price, header) is the exact server string, found again by candle time.
// The axis note on the chart says: "axis labels are rounded; exact prices in the legend".
import type { CandleItem } from '@vantage/contracts';

/** A candle for the chart: time in whole seconds (UTC) and plotted numbers. */
export interface PlotCandle {
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}
export interface PlotVolume {
  readonly time: number;
  readonly value: number;
  /** true when the candle closed at or above its open (the bar takes the up colour) */
  readonly up: boolean;
}

/** The only string-to-number conversion of the app. For positioning pixels only. */
export function plotNumber(decimal: string): number {
  return Number(decimal);
}

/** Epoch seconds of an ISO instant (the chart's time unit). */
export function plotTime(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

/** Number of decimal places of a plain decimal string ("0.01" is 2, "1" is 0). String operation only. */
export function decimalsOf(decimal: string): number {
  const dot = decimal.indexOf('.');
  return dot < 0 ? 0 : decimal.length - dot - 1;
}

/** Axis tick label: a plotted number rounded to the instrument's price decimals (labels only, never an order value). */
export function axisLabel(value: number, decimals: number): string {
  return value.toFixed(decimals);
}

export interface PlotSeries {
  readonly candles: PlotCandle[];
  readonly volume: PlotVolume[];
  /** The exact server candle for every plotted time, for the legend (strings, as received). */
  readonly byTime: Map<number, CandleItem>;
}

/** Whether the candle's close is at or above its open, decided on the plotted numbers (colour of a volume bar only). */
function isUp(c: CandleItem): boolean {
  return plotNumber(c.c) >= plotNumber(c.o);
}

export function toPlotCandle(c: CandleItem): PlotCandle {
  return {
    time: plotTime(c.t),
    open: plotNumber(c.o),
    high: plotNumber(c.h),
    low: plotNumber(c.l),
    close: plotNumber(c.c),
  };
}

export function toPlotVolume(c: CandleItem): PlotVolume {
  return { time: plotTime(c.t), value: plotNumber(c.v), up: isUp(c) };
}

/** Converts a candle answer (ascending by open time, as the API sends it) into plot series plus the exact-string lookup. */
export function toPlotSeries(items: readonly CandleItem[]): PlotSeries {
  const byTime = new Map<number, CandleItem>();
  const candles: PlotCandle[] = [];
  const volume: PlotVolume[] = [];
  for (const c of items) {
    const p = toPlotCandle(c);
    byTime.set(p.time, c);
    candles.push(p);
    volume.push(toPlotVolume(c));
  }
  return { candles, volume, byTime };
}

/** The chart's price format for an instrument: axis precision and the smallest price move, both from the tick size string. */
export function plotPriceFormat(tickSize: string): {
  type: 'price';
  precision: number;
  minMove: number;
} {
  return { type: 'price', precision: decimalsOf(tickSize), minMove: plotNumber(tickSize) };
}
