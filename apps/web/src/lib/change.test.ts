import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { ChangeCell } from '../components/change-cell';
import { BASIS_LABELS, BASIS_TITLES, changeView } from './change';
import { DASH, MINUS } from './money';

describe('changeView: exact strings in, exact strings out (the browser does no arithmetic)', () => {
  it.each([
    // change, pct, basis, direction, text
    ['3364.25', '4.67', 'ROLLING_24H', 'up', '+3,364.25 (+4.67%)'],
    ['-3.61', '-1.89', 'PREV_SESSION_CLOSE', 'down', `${MINUS}3.61 (${MINUS}1.89%)`],
    ['0.00', '0.00', 'ROLLING_24H', 'flat', '0.00 (0.00%)'],
    ['-0.00', '0.00', 'ROLLING_24H', 'flat', '0.00 (0.00%)'], // a negative zero shows no sign
    ['0.00001', '0.00', 'ROLLING_24H', 'up', '+0.00001 (0.00%)'], // very small: the digits as received, no rounding here
    ['-0.00001', '0.00', 'ROLLING_24H', 'down', `${MINUS}0.00001 (0.00%)`],
    [
      '99999999998.99',
      '9999999999899.00',
      'PREV_SESSION_CLOSE',
      'up',
      '+99,999,999,998.99 (+9,999,999,999,899.00%)',
    ], // very large
    [
      '-99999999998.99',
      '-100.00',
      'PREV_SESSION_CLOSE',
      'down',
      `${MINUS}99,999,999,998.99 (${MINUS}100.00%)`,
    ],
    ['1234.5', '12.34', 'ROLLING_24H', 'up', '+1,234.5 (+12.34%)'], // the API's own decimals are kept as sent
  ] as const)('%s / %s %% (%s)', (change, pct, basis, dir, text) => {
    const v = changeView({ change, changePct: pct, changeBasis: basis });
    expect(v.available).toBe(true);
    expect(v.direction).toBe(dir);
    expect(v.text).toBe(text);
    expect(v.basisLabel).toBe(BASIS_LABELS[basis]);
    expect(v.basisTitle).toBe(BASIS_TITLES[basis]);
  });

  it('the two bases are named differently, in words ("vs previous close" and "24h")', () => {
    expect(BASIS_LABELS).toEqual({ PREV_SESSION_CLOSE: 'vs previous close', ROLLING_24H: '24h' });
    expect(BASIS_LABELS.PREV_SESSION_CLOSE).not.toBe(BASIS_LABELS.ROLLING_24H);
  });

  it.each([
    ['everything null', { change: null, changePct: null, changeBasis: null }],
    ['everything missing', {}],
    ['only the change', { change: '1.00', changePct: null, changeBasis: 'ROLLING_24H' }],
    ['only the percentage', { change: null, changePct: '1.00', changeBasis: 'ROLLING_24H' }],
    [
      'a change that is not a decimal',
      { change: 'abc', changePct: '1.00', changeBasis: 'ROLLING_24H' },
    ],
    [
      'a percentage that is not a decimal',
      { change: '1.00', changePct: '1e5', changeBasis: 'ROLLING_24H' },
    ],
  ] as const)('%s: the dash, never 0 and never a number', (_n, input) => {
    const v = changeView(input);
    expect(v).toMatchObject({
      available: false,
      direction: 'none',
      text: DASH,
      changeText: DASH,
      pctText: DASH,
      basisLabel: null,
    });
    expect(v.text).not.toMatch(/\d/);
  });

  it('a decimal that goes in comes out with the same digits (property test)', () => {
    const dec = fc.tuple(
      fc.boolean(),
      fc.stringMatching(/^[1-9][0-9]{0,11}$|^0$/),
      fc.stringMatching(/^[0-9]{2,5}$/),
    );
    fc.assert(
      fc.property(dec, dec, (c, p) => {
        const change = `${c[0] ? '-' : ''}${c[1]}.${c[2]}`;
        const pct = `${p[0] ? '-' : ''}${p[1]}.${p[2].slice(0, 2)}`;
        const v = changeView({ change, changePct: pct, changeBasis: 'ROLLING_24H' });
        const digits = (s: string): string => s.replace(/[^0-9]/g, '');
        expect(digits(v.changeText)).toBe(digits(change));
        expect(digits(v.pctText)).toBe(digits(pct));
      }),
      { numRuns: 300 },
    );
  });
});

describe('ChangeCell: sign, glyph and word, never colour alone', () => {
  const html = (props: Parameters<typeof ChangeCell>[0]): string =>
    renderToStaticMarkup(createElement(ChangeCell, props));

  it('a gain: up arrow, plus sign, "up" for screen readers, the basis as tooltip and label', () => {
    const h = html({
      change: '3364.25',
      changePct: '4.67',
      changeBasis: 'ROLLING_24H',
      testId: 'c',
    });
    expect(h).toContain('data-direction="up"');
    expect(h).toContain('▲');
    expect(h).toContain('aria-hidden="true"');
    expect(h).toContain('+3,364.25 (+4.67%)');
    expect(h).toContain('(up, 24h)'); // the screen-reader text
    expect(h).toContain('title="Change over the last 24 hours."');
    expect(h).toContain('text-up');
  });

  it('a loss: down arrow and a real minus sign', () => {
    const h = html({ change: '-3.61', changePct: '-1.89', changeBasis: 'PREV_SESSION_CLOSE' });
    expect(h).toContain('▼');
    expect(h).toContain(`${MINUS}3.61 (${MINUS}1.89%)`);
    expect(h).toContain('(down, vs previous close)');
    expect(h).toContain('text-down');
    expect(h).not.toContain('-3.61'); // the ASCII hyphen is never shown
  });

  it('unchanged: no arrow and no sign; no data: the dash, "not available", no arrow', () => {
    const flat = html({ change: '0.00', changePct: '0.00', changeBasis: 'ROLLING_24H' });
    expect(flat).not.toMatch(/▲|▼/);
    expect(flat).toContain('0.00 (0.00%)');
    expect(flat).toContain('unchanged');
    const none = html({ change: null, changePct: null, changeBasis: null });
    expect(none).toContain(DASH);
    expect(none).toContain('not available');
    expect(none).not.toMatch(/▲|▼|0\.00/);
  });

  it('compact (search results) shows only the percentage', () => {
    const h = html({
      change: '3364.25',
      changePct: '4.67',
      changeBasis: 'ROLLING_24H',
      compact: true,
    });
    expect(h).toContain('+4.67%');
    expect(h).not.toContain('3,364.25');
  });
});
