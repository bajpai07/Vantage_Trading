import type { EquitySnapshot } from '@vantage/contracts';
import { scaleSeries } from '../lib/chart';
import { formatMoney } from '../lib/money';

const W = 600;
const H = 140;
const PAD = 8;

/**
 * A simple, accessible equity line from the daily snapshots. It hides itself (with a short note) below two points.
 * Every label is a string exactly as received; only pixel positions are computed, from exact BigInt values. A hollow
 * point marks a day with `valuedComplete: false` (some position had no price that day), so the curve never pretends a
 * partial day is complete, and the data table below the chart gives the same numbers in text.
 */
export function EquityLine({ snapshots }: { snapshots: readonly EquitySnapshot[] }) {
  const pts = scaleSeries(
    snapshots.map((s) => s.equity),
    W - 2 * PAD,
    H - 2 * PAD,
  );
  if (pts === null) {
    return (
      <p data-testid="equity-curve-empty" className="text-[13px] text-text-2">
        The equity curve appears once there are two daily snapshots (one is saved after each market
        close).
      </p>
    );
  }
  const placed = pts.map((p) => ({ x: p.x + PAD, y: p.y + PAD }));
  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  const anyIncomplete = snapshots.some((s) => !s.valuedComplete);
  const summary = `Equity from ${first?.date ?? ''}: ${formatMoney(first?.equity)} to ${last?.date ?? ''}: ${formatMoney(last?.equity)}`;
  return (
    <figure data-testid="equity-curve" className="m-0">
      <svg
        viewBox={`0 0 ${String(W)} ${String(H)}`}
        role="img"
        aria-label={summary}
        className="h-auto w-full"
      >
        <line
          x1={PAD}
          y1={H - PAD}
          x2={W - PAD}
          y2={H - PAD}
          className="stroke-line"
          strokeWidth={1}
        />
        <polyline
          points={placed.map((p) => `${String(p.x)},${String(p.y)}`).join(' ')}
          className="fill-none stroke-accent"
          strokeWidth={2}
          strokeLinejoin="round"
        />
        {placed.map((p, i) => {
          const complete = snapshots[i]?.valuedComplete ?? true;
          return (
            <circle
              key={snapshots[i]?.date ?? i}
              cx={p.x}
              cy={p.y}
              r={complete ? 2.5 : 3.5}
              data-complete={complete ? 'true' : 'false'}
              className={complete ? 'fill-accent stroke-accent' : 'fill-bg-1 stroke-warn'}
              strokeWidth={complete ? 0 : 2}
            />
          );
        })}
      </svg>
      <figcaption className="mt-1 flex flex-wrap justify-between gap-x-4 text-[12px] text-text-2">
        <span>
          {first?.date} <span className="num text-text-1">{formatMoney(first?.equity)}</span>
        </span>
        <span>
          {last?.date} <span className="num text-text-1">{formatMoney(last?.equity)}</span>
        </span>
      </figcaption>
      {anyIncomplete ? (
        <p className="mt-1 text-[12px] text-warn">
          Hollow points: on those days at least one position had no price, so its value is left out.
        </p>
      ) : null}
      <details className="mt-2">
        <summary className="cursor-pointer text-[13px] text-accent">Open data table</summary>
        <div
          className="relative mt-2 overflow-x-auto"
          tabIndex={0}
          role="region"
          aria-label="Equity history table"
        >
          <table className="w-full text-[12px]">
            <caption className="sr-only">Daily equity snapshots</caption>
            <thead>
              <tr className="text-left text-text-2">
                <th scope="col" className="py-1 pr-3 font-medium">
                  Date
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">
                  Cash
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">
                  Positions
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">
                  Equity
                </th>
                <th scope="col" className="py-1 font-medium">
                  Complete
                </th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map((s) => (
                <tr key={s.date} className="border-t border-line">
                  <th scope="row" className="num py-1 pr-3 text-left font-normal text-text-1">
                    {s.date}
                  </th>
                  <td className="num py-1 pr-3 text-right">{formatMoney(s.cash)}</td>
                  <td className="num py-1 pr-3 text-right">{formatMoney(s.positionsValue)}</td>
                  <td className="num py-1 pr-3 text-right text-text-0">{formatMoney(s.equity)}</td>
                  <td className="py-1">
                    {s.valuedComplete ? 'Yes' : 'No: a position had no price'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
