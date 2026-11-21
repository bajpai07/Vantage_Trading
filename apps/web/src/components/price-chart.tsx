'use client';

// The candlestick chart (M9a T3, D-103). A thin imperative wrapper around TradingView's lightweight-charts:
//   * the chart is created ONCE per mount and never recreated on a price tick or an interval switch (data is replaced with
//     setData, the forming candle is moved with update); it resizes itself (the library's ResizeObserver, `autoSize`);
//   * colours are read from the design tokens (CSS variables), never written here;
//   * the library's numbers come from lib/chart-data.ts only and are used to position pixels; every text the user reads (legend,
//     last price, header) is the exact server string, looked up by candle time by the parent;
//   * the in-chart TradingView logo is off (CSP, see below); the attribution link and notice are shown elsewhere on the page.
// This file is loaded dynamically, on the instrument page only (see chart-panel.tsx).
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  createChart,
} from 'lightweight-charts';
import type { IChartApi, ISeriesApi, MouseEventParams, UTCTimestamp } from 'lightweight-charts';
import { useEffect, useRef } from 'react';
import { axisLabel, decimalsOf, plotNumber } from '../lib/chart-data';
import type { PlotSeries } from '../lib/chart-data';

const cssVar = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Height of the volume strip under the price pane (the mock draws 56 px). */
const VOLUME_PANE_HEIGHT = 56;

export interface PriceChartProps {
  /** The plotted data. A new `dataKey` (symbol + interval) replaces the whole data set; otherwise only the latest candle moves. */
  readonly series: PlotSeries;
  readonly dataKey: string;
  /** The instrument's tick size string (axis precision and minimum move). */
  readonly tickSize: string;
  /** Plot the volume strip (false when the answer carries no volume). */
  readonly showVolume: boolean;
  /** The candle time under the crosshair (epoch seconds), or null when the pointer leaves the chart. */
  readonly onHover: (time: number | null) => void;
  /** A tap or click on a candle (epoch seconds), or null when the tap is on empty space. */
  readonly onSelect: (time: number | null) => void;
}

interface Handles {
  chart: IChartApi;
  candles: ISeriesApi<'Candlestick'>;
  volume: ISeriesApi<'Histogram'> | null;
}

export default function PriceChart(props: PriceChartProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const handles = useRef<Handles | null>(null);
  const shown = useRef<{ key: string; count: number } | null>(null);
  const onHover = useRef(props.onHover);
  onHover.current = props.onHover;
  const onSelect = useRef(props.onSelect);
  onSelect.current = props.onSelect;

  // created once per mount, removed on unmount
  useEffect(() => {
    const el = host.current;
    if (el === null) return undefined;
    const decimals = decimalsOf(props.tickSize);
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: cssVar('--bg-1') },
        textColor: cssVar('--text-2'),
        fontFamily: cssVar('--font-num'),
        // OFF by decision (D-103 amendment): the library's logo widget injects an inline <style> element, which our nonce-only
        // style-src blocks (measured: 2 violations on, 0 off). The attribution is given in the chart footer, in the footer of every
        // page and on /third-party-notices instead.
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: cssVar('--chart-grid') },
        horzLines: { color: cssVar('--chart-grid') },
      },
      crosshair: { mode: CrosshairMode.Normal },
      // M9b: a vertical swipe that starts on the chart must scroll the PAGE; a horizontal drag pans the chart, pinch zooms it
      handleScroll: { vertTouchDrag: false },
      rightPriceScale: { borderColor: cssVar('--line') },
      timeScale: { borderColor: cssVar('--line'), timeVisible: true, secondsVisible: false },
      localization: { priceFormatter: (p: number) => axisLabel(p, decimals) },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: cssVar('--up'),
      downColor: cssVar('--down'),
      wickUpColor: cssVar('--up'),
      wickDownColor: cssVar('--down'),
      borderVisible: false,
      lastValueVisible: false,
      priceFormat: {
        type: 'custom',
        minMove: plotNumber(props.tickSize),
        formatter: (p: number) => axisLabel(p, decimals),
      },
    });
    const volume = props.showVolume
      ? chart.addSeries(
          HistogramSeries,
          { priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false },
          1,
        )
      : null;
    if (volume !== null) chart.panes()[1]?.setHeight(VOLUME_PANE_HEIGHT);
    const move = (p: MouseEventParams): void => {
      onHover.current(typeof p.time === 'number' ? p.time : null);
    };
    const click = (p: MouseEventParams): void => {
      onSelect.current(typeof p.time === 'number' ? p.time : null);
    };
    chart.subscribeCrosshairMove(move);
    chart.subscribeClick(click);
    handles.current = { chart, candles, volume };
    return () => {
      chart.unsubscribeCrosshairMove(move);
      chart.unsubscribeClick(click);
      chart.remove();
      handles.current = null;
      shown.current = null;
    };
    // once per mount: the tick size and the volume option are fixed for the life of a page (the page is keyed by symbol)
  }, []);

  // data: replace on a new key or when the number of candles changed (a new forming candle), otherwise move the latest candle
  useEffect(() => {
    const h = handles.current;
    if (h === null) return;
    const { candles, volume } = props.series;
    const last = candles[candles.length - 1];
    if (last === undefined) {
      h.candles.setData([]);
      h.volume?.setData([]);
      shown.current = { key: props.dataKey, count: 0 };
      return;
    }
    const prev = shown.current;
    if (prev === null || prev.key !== props.dataKey || prev.count !== candles.length) {
      h.candles.setData(candles.map((c) => ({ ...c, time: c.time as UTCTimestamp })));
      h.volume?.setData(
        volume.map((v) => ({
          time: v.time as UTCTimestamp,
          value: v.value,
          color: cssVar(v.up ? '--up-bar' : '--down-bar'),
        })),
      );
      if (prev === null || prev.key !== props.dataKey) h.chart.timeScale().fitContent();
    } else {
      h.candles.update({ ...last, time: last.time as UTCTimestamp });
      const lv = volume[volume.length - 1];
      if (lv !== undefined)
        h.volume?.update({
          time: lv.time as UTCTimestamp,
          value: lv.value,
          color: cssVar(lv.up ? '--up-bar' : '--down-bar'),
        });
    }
    shown.current = { key: props.dataKey, count: candles.length };
  }, [props.series, props.dataKey]);

  return (
    <div
      ref={host}
      data-testid="price-chart-canvas"
      className="h-[clamp(220px,38dvh,320px)] md:h-[440px]"
    />
  );
}
