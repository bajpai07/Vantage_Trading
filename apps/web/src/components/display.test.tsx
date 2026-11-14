import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FreshnessState } from '@vantage/contracts';
import type { EquitySnapshot } from '@vantage/contracts';
import { EquityLine } from './equity-line';
import { FreshnessBadge } from './freshness-badge';
import { Money, PnlCell } from './money';

const html = (node: React.ReactElement): string => renderToStaticMarkup(node);

describe('FreshnessBadge: every state, always a dot and a word', () => {
  it.each(FreshnessState.options)('%s renders its label and its state attribute', (state) => {
    const out = html(<FreshnessBadge state={state} />);
    expect(out).toContain(`data-state="${state}"`);
    expect(out).toContain('aria-hidden="true"'); // the dot is decoration; the word carries the meaning
  });

  it('shows the exact words (control)', () => {
    expect(html(<FreshnessBadge state="REAL_TIME" />)).toContain('REAL-TIME');
    expect(html(<FreshnessBadge state="DELAYED" />)).toContain('DELAYED');
    expect(html(<FreshnessBadge state="STALE" />)).toContain('STALE');
    expect(html(<FreshnessBadge state="CLOSED" />)).toContain('CLOSED');
    expect(html(<FreshnessBadge state="UNAVAILABLE" />)).toContain('UNAVAILABLE');
  });

  it('the tooltip names the source and the quote time in UTC when given', () => {
    const out = html(
      <FreshnessBadge state="DELAYED" source="FIXTURE" asOf="2026-11-10T14:45:00.000Z" />,
    );
    expect(out).toContain('Source: FIXTURE.');
    expect(out).toContain('Quote time: 2026-11-10 14:45:00 UTC.');
  });

  it('only REAL-TIME is ever called live; STALE keeps its dotted underline (not colour alone)', () => {
    expect(html(<FreshnessBadge state="DELAYED" />)).not.toContain('REAL-TIME');
    expect(html(<FreshnessBadge state="STALE" />)).toContain('decoration-dotted');
  });
});

describe('Money and PnlCell show the API string, a sign, a glyph and a word', () => {
  it('Money formats by string and keeps the exact value on hover', () => {
    const out = html(<Money value="10049.60" exact="10049.60" />);
    expect(out).toContain('10,049.60');
    expect(out).toContain('title="Exact: 10049.60"');
  });

  it('a missing value is the dash with a screen-reader word, never 0', () => {
    const out = html(<Money value={null} />);
    expect(out).toContain('—');
    expect(out).toContain('not available');
    expect(out).not.toContain('0.00');
  });

  it('a gain has a plus, an up arrow and the word "gain"; a loss has a real minus, a down arrow and "loss"', () => {
    const up = html(<PnlCell value="49.60" exact="49.60" />);
    expect(up).toContain('▲');
    expect(up).toContain('+49.60');
    expect(up).toContain('(gain)');
    expect(up).toContain('data-direction="up"');
    const down = html(<PnlCell value="-5.17" />);
    expect(down).toContain('▼');
    expect(down).toContain('−5.17');
    expect(down).toContain('(loss)');
    expect(down).toContain('data-direction="down"');
  });

  it('zero has no sign and no arrow; null is the dash (controls)', () => {
    const zero = html(<PnlCell value="0.00" />);
    expect(zero).not.toMatch(/[▲▼+]/);
    expect(zero).toContain('data-direction="flat"');
    const none = html(<PnlCell value={null} />);
    expect(none).toContain('—');
    expect(none).toContain('data-direction="none"');
  });
});

const snap = (date: string, equity: string, valuedComplete = true): EquitySnapshot => ({
  date,
  cash: equity,
  positionsValue: '0.00',
  equity,
  valuedComplete,
  quoteAsOf: null,
  markSource: null,
  exact: { cash: equity, positionsValue: '0.00', equity },
});

describe('EquityLine', () => {
  it('hides the chart below two points and says why (control: two points draw it)', () => {
    expect(html(<EquityLine snapshots={[]} />)).toContain('equity-curve-empty');
    expect(html(<EquityLine snapshots={[snap('2026-11-09', '10000.00')]} />)).toContain(
      'equity-curve-empty',
    );
    const two = html(
      <EquityLine snapshots={[snap('2026-11-09', '10000.00'), snap('2026-11-10', '10049.60')]} />,
    );
    expect(two).toContain('data-testid="equity-curve"');
    expect(two).not.toContain('equity-curve-empty');
    expect(two).toContain('<polyline');
  });

  it('is accessible: an image role with a text summary, labels as received, and a data table alternative', () => {
    const out = html(
      <EquityLine snapshots={[snap('2026-11-09', '10000.00'), snap('2026-11-10', '10049.60')]} />,
    );
    expect(out).toContain('role="img"');
    expect(out).toContain(
      'aria-label="Equity from 2026-11-09: 10,000.00 to 2026-11-10: 10,049.60"',
    );
    expect(out).toContain('Open data table');
    expect(out).toContain('<table');
  });

  it('marks an incomplete day with a hollow point and says what it means (not colour alone)', () => {
    const out = html(
      <EquityLine
        snapshots={[snap('2026-11-09', '10000.00'), snap('2026-11-10', '8099.60', false)]}
      />,
    );
    expect(out).toContain('data-complete="false"');
    expect(out).toContain('Hollow points');
    expect(out).toContain('No: a position had no price');
    // control: a complete series has no such note
    const clean = html(
      <EquityLine snapshots={[snap('2026-11-09', '10000.00'), snap('2026-11-10', '10049.60')]} />,
    );
    expect(clean).not.toContain('Hollow points');
  });
});
