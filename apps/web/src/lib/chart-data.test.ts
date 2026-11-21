// M9a T6: the one audited number module. Exact string -> plotted number -> axis label round trips, the exact-string lookup by
// candle time, and the lint rule that keeps this module away from order, ticket, money and portfolio code.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { CandleItem } from '@vantage/contracts';
import {
  axisLabel,
  decimalsOf,
  plotNumber,
  plotPriceFormat,
  plotTime,
  toPlotSeries,
} from './chart-data';
import { KEEP_MAX, mergeCandles } from './candles-merge';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');

const candle = (t: string, o: string, c: string, closed = true): CandleItem => ({
  t,
  o,
  h: c,
  l: o,
  c,
  v: '1.5',
  closed,
});

describe('round trip: a server price string -> plotted number -> axis label at the tick decimals', () => {
  it.each([
    ['90010.00', '0.01'],
    ['189.95', '0.01'],
    ['0.5500', '0.0001'],
    ['0.15000', '0.00001'],
    ['3100.00', '0.01'],
  ])('%s at tick %s comes back digit for digit', (price, tick) => {
    expect(axisLabel(plotNumber(price), decimalsOf(tick))).toBe(price);
  });

  it('holds for every price on the tick grid up to 9,999,999.99 (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 999_999_999 }), (ticks) => {
        const whole = String(Math.trunc(ticks / 100));
        const frac = String(ticks % 100).padStart(2, '0');
        const s = `${whole}.${frac}`;
        expect(axisLabel(plotNumber(s), 2)).toBe(s);
      }),
      { numRuns: 500 },
    );
  });

  it('decimalsOf counts the decimals of the tick string', () => {
    expect([decimalsOf('1'), decimalsOf('0.01'), decimalsOf('0.00001')]).toEqual([0, 2, 5]);
  });

  it('plotPriceFormat takes precision and minimum move from the tick string', () => {
    expect(plotPriceFormat('0.01')).toEqual({ type: 'price', precision: 2, minMove: 0.01 });
  });

  it('plotTime is whole epoch seconds', () => {
    expect(plotTime('2026-11-10T15:00:00.000Z')).toBe(1_794_322_800);
    expect(plotTime('2026-11-10T15:00:00.999Z')).toBe(1_794_322_800);
  });
});

describe('the legend lookup returns the exact server strings by candle time', () => {
  it('byTime maps every plotted time to the candle as received (strings untouched)', () => {
    const items = [
      candle('2026-11-10T14:45:00.000Z', '89990.00', '90010.00'),
      candle('2026-11-10T15:00:00.000Z', '90010.00', '90100.55', false),
    ];
    const s = toPlotSeries(items);
    expect(s.candles).toHaveLength(2);
    expect(s.volume).toHaveLength(2);
    const t = plotTime('2026-11-10T15:00:00.000Z');
    expect(s.byTime.get(t)).toBe(items[1]);
    expect(s.byTime.get(t)?.c).toBe('90100.55');
    expect(s.byTime.get(t)?.v).toBe('1.5');
  });
});

describe('mergeCandles (the bounded refresh)', () => {
  const a = candle('2026-11-10T14:45:00.000Z', '1.00', '2.00');
  const b = candle('2026-11-10T15:00:00.000Z', '2.00', '2.50', false);
  it('replaces the forming candle and appends a newer one', () => {
    const merged = mergeCandles(
      [a, b],
      [{ ...b, c: '2.75' }, candle('2026-11-10T15:15:00.000Z', '2.75', '2.80', false)],
    );
    expect(merged.map((c) => c.c)).toEqual(['2.00', '2.75', '2.80']);
  });
  it('ignores an older candle it does not know (closed candles never change) and is bounded', () => {
    expect(mergeCandles([b], [candle('2026-11-10T14:00:00.000Z', '9', '9')])).toEqual([b]);
    const many = Array.from({ length: KEEP_MAX + 20 }, (_, i) =>
      candle(`2026-11-10T00:00:00.${String(i).padStart(3, '0')}Z`, '1.00', '1.00'),
    );
    expect(mergeCandles(many, [])).toHaveLength(KEEP_MAX);
  });
});

describe('lint: the number module is importable by the chart components only (ESLint, the real config)', () => {
  const eslint = new ESLint({ cwd: repoRoot });
  const lint = async (code: string, file: string) => {
    const [r] = await eslint.lintText(code, { filePath: join(repoRoot, file) });
    return (r?.messages ?? []).filter((m) => m.severity === 2);
  };
  const IMPORT = "import { plotNumber } from '../lib/chart-data';\nexport const a = plotNumber;";

  it.each([
    'apps/web/src/lib/ticket.ts',
    'apps/web/src/lib/money.ts',
    'apps/web/src/components/order-ticket.tsx',
    'apps/web/src/components/portfolio-view.tsx',
    'apps/web/src/components/orders-list.tsx',
    'apps/web/src/components/depth-book.tsx',
  ])('forbids the import in %s', async (file) => {
    expect((await lint(IMPORT, file)).length).toBeGreaterThan(0);
  });

  it.each(['apps/web/src/components/price-chart.tsx', 'apps/web/src/components/chart-panel.tsx'])(
    'allows the import in %s (control)',
    async (file) => {
      const found = await lint(IMPORT, file);
      expect(found.filter((m) => m.ruleId === 'no-restricted-imports')).toEqual([]);
    },
  );
});
