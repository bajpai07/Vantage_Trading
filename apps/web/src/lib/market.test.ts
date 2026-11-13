import { describe, expect, it } from 'vitest';
import { AssetClass, InstrumentStatus } from '@vantage/contracts';
import type { MarketStatusResponse } from '@vantage/contracts';
import { MAX_BACKOFF_MS, nextDelayMs } from './backoff';
import { ASSET_CLASS_LABELS, STATUS_VIEWS, ageText, marketLine, statusView } from './market';

describe('instrument status views are exhaustive against the contract', () => {
  it('has a view for every status the API can send, and nothing else', () => {
    expect(Object.keys(STATUS_VIEWS).sort()).toEqual([...InstrumentStatus.options].sort());
    expect(Object.keys(ASSET_CLASS_LABELS).sort()).toEqual([...AssetClass.options].sort());
  });

  it('ACTIVE needs no explanation; every other status explains itself in a full sentence', () => {
    expect(statusView('ACTIVE').explanation).toBeNull();
    for (const s of ['HALTED', 'SELL_ONLY', 'DELISTED'] as const) {
      const e = statusView(s).explanation;
      expect(e, s).not.toBeNull();
      expect((e ?? '').endsWith('.')).toBe(true);
      expect(e).not.toContain(s);
    }
  });

  it('which side each status blocks matches the engine rules (SELL_ONLY blocks only buying)', () => {
    expect(statusView('ACTIVE')).toMatchObject({ blocksBuy: false, blocksSell: false });
    expect(statusView('SELL_ONLY')).toMatchObject({ blocksBuy: true, blocksSell: false });
    expect(statusView('HALTED')).toMatchObject({ blocksBuy: true, blocksSell: true });
    expect(statusView('DELISTED')).toMatchObject({ blocksBuy: true, blocksSell: true });
  });
});

describe("ageText: the API's own ageSeconds as words", () => {
  it.each([
    [null, 'no quote'],
    [undefined, 'no quote'],
    [0, '0 s ago'],
    [14, '14 s ago'],
    [119, '119 s ago'],
    [120, '2 min ago'],
    [900, '15 min ago'],
    [7199, '119 min ago'],
    [7200, '2 h ago'],
    [90_000, '25 h ago'],
  ])('%s -> %s', (s, out) => {
    expect(ageText(s)).toBe(out);
  });
});

describe('marketLine', () => {
  const status = (
    over: Partial<MarketStatusResponse['exchanges'][number]>,
  ): MarketStatusResponse => ({
    asOf: '2026-11-10T15:00:00.000Z',
    exchanges: [
      {
        exchange: 'XNAS',
        name: 'Nasdaq',
        state: 'OPEN',
        session: 'REGULAR',
        reason: null,
        note: null,
        localDate: '2026-11-10',
        nextOpen: '2026-11-11T14:30:00.000Z',
        nextClose: '2026-11-10T21:00:00.000Z',
        ...over,
      },
    ],
  });

  it('open: says until when (UTC); an early close is named', () => {
    expect(marketLine('XNAS', status({}))).toEqual({
      state: 'OPEN',
      text: 'Nasdaq is open until 2026-11-10 21:00:00 UTC.',
    });
    expect(marketLine('XNAS', status({ session: 'EARLY_CLOSE' })).text).toContain('(early close)');
  });

  it('closed: says why when it knows and when it opens next', () => {
    const closed = status({
      state: 'CLOSED',
      session: null,
      reason: 'HOLIDAY',
      note: 'Thanksgiving Day',
      nextClose: null,
    });
    expect(marketLine('XNAS', closed)).toEqual({
      state: 'CLOSED',
      text: 'Nasdaq is closed (Thanksgiving Day). Next open: 2026-11-11 14:30:00 UTC.',
    });
    expect(marketLine('XNAS', status({ state: 'CLOSED', nextOpen: null })).text).toBe(
      'Nasdaq is closed.',
    );
  });

  it('an exchange the API did not list, or no market status at all, is UNKNOWN: never "open"', () => {
    for (const s of [status({}), null]) {
      const l = marketLine('XXXX', s);
      expect(l.state).toBe('UNKNOWN');
      expect(l.text).not.toContain('is open');
      expect(l.text).toContain('not available');
    }
    expect(marketLine('XNAS', null).state).toBe('UNKNOWN');
  });
});

describe('quote polling backoff (D-73)', () => {
  it('is the poll interval after a success and doubles with each consecutive failure, capped at one minute', () => {
    expect(nextDelayMs(5000, 0)).toBe(5000);
    expect(nextDelayMs(5000, 1)).toBe(10_000);
    expect(nextDelayMs(5000, 2)).toBe(20_000);
    expect(nextDelayMs(5000, 3)).toBe(40_000);
    expect(nextDelayMs(5000, 4)).toBe(MAX_BACKOFF_MS);
    expect(nextDelayMs(5000, 50)).toBe(MAX_BACKOFF_MS);
    expect(nextDelayMs(1000, 3)).toBe(8000);
  });
  it('never exceeds the cap, even for a poll interval above it', () => {
    expect(nextDelayMs(60_000, 0)).toBe(60_000);
    expect(nextDelayMs(60_000, 5)).toBe(60_000);
  });
  it('resets by construction: zero failures is the plain interval again', () => {
    expect(nextDelayMs(5000, 6)).toBe(MAX_BACKOFF_MS);
    expect(nextDelayMs(5000, 0)).toBe(5000);
  });
});
