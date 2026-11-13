import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CalendarError,
  exchangeDate,
  marketState,
  nextDate,
  parseCalendar,
  sessionsBetween,
} from './calendar.js';
import { NYSE_CALENDAR_2026_2027 as CAL } from './testing.js';

const at = (iso: string) => marketState(CAL, new Date(iso));
const iso = (d: Date | null) => (d === null ? null : d.toISOString());

// Every instant below was worked out by hand from the New York offset on that date:
// EST = UTC-5 (open 14:30Z, close 21:00Z, early close 18:00Z), EDT = UTC-4 (open 13:30Z, close 20:00Z).

describe('a normal weekday (Tuesday 2026-11-10, EST)', () => {
  it.each([
    ['one millisecond before the open', '2026-11-10T14:29:59.999Z', 'CLOSED', 'BEFORE_OPEN'],
    ['exactly at the open', '2026-11-10T14:30:00.000Z', 'OPEN', null],
    ['one millisecond before the close', '2026-11-10T20:59:59.999Z', 'OPEN', null],
    ['exactly at the close (closed)', '2026-11-10T21:00:00.000Z', 'CLOSED', 'AFTER_CLOSE'],
  ])('%s', (_n, instant, state, reason) => {
    const s = at(instant);
    expect(s.state).toBe(state);
    expect(s.reason).toBe(reason);
  });

  it('OPEN reports the REGULAR session, today close and the next session open', () => {
    const s = at('2026-11-10T16:00:00Z');
    expect(s).toMatchObject({ state: 'OPEN', session: 'REGULAR', localDate: '2026-11-10' });
    expect(iso(s.nextClose)).toBe('2026-11-10T21:00:00.000Z');
    expect(iso(s.nextOpen)).toBe('2026-11-11T14:30:00.000Z');
  });

  it('before the open: next open and close are today', () => {
    const s = at('2026-11-10T12:00:00Z');
    expect(iso(s.nextOpen)).toBe('2026-11-10T14:30:00.000Z');
    expect(iso(s.nextClose)).toBe('2026-11-10T21:00:00.000Z');
  });

  it('the local date follows the exchange zone, not UTC (04:59Z is still the previous evening)', () => {
    expect(at('2026-11-10T04:59:00Z').localDate).toBe('2026-11-09');
    expect(at('2026-11-10T05:00:00Z').localDate).toBe('2026-11-10');
  });
});

describe('weekends', () => {
  it('Saturday is closed; the next open is Monday', () => {
    const s = at('2026-11-14T15:00:00Z');
    expect(s).toMatchObject({ state: 'CLOSED', reason: 'WEEKEND', session: null });
    expect(iso(s.nextOpen)).toBe('2026-11-16T14:30:00.000Z');
    expect(iso(s.nextClose)).toBe('2026-11-16T21:00:00.000Z');
  });
  it('Friday evening after the close points at Monday', () => {
    const s = at('2026-11-13T21:30:00Z');
    expect(s).toMatchObject({ state: 'CLOSED', reason: 'AFTER_CLOSE' });
    expect(iso(s.nextOpen)).toBe('2026-11-16T14:30:00.000Z');
  });
});

describe('holidays', () => {
  it('Thanksgiving 2026-11-26 is closed and names the holiday; the next session is the early-close day', () => {
    const s = at('2026-11-26T15:00:00Z');
    expect(s).toMatchObject({ state: 'CLOSED', reason: 'HOLIDAY', note: 'Thanksgiving Day' });
    expect(iso(s.nextOpen)).toBe('2026-11-27T14:30:00.000Z');
    expect(iso(s.nextClose)).toBe('2026-11-27T18:00:00.000Z');
  });
  it('Independence Day observed on Friday 2026-07-03 (EDT): closed; Thursday closes at 20:00Z; next open Monday', () => {
    expect(at('2026-07-03T15:00:00Z')).toMatchObject({ state: 'CLOSED', reason: 'HOLIDAY' });
    const thu = at('2026-07-02T20:00:00Z');
    expect(thu).toMatchObject({ state: 'CLOSED', reason: 'AFTER_CLOSE' });
    expect(iso(thu.nextOpen)).toBe('2026-07-06T13:30:00.000Z');
    expect(at('2026-07-02T19:59:59Z').state).toBe('OPEN');
  });
  it('Good Friday 2026-04-03 and 2027-03-26 are closed', () => {
    expect(at('2026-04-03T15:00:00Z')).toMatchObject({
      state: 'CLOSED',
      reason: 'HOLIDAY',
      note: 'Good Friday',
    });
    expect(iso(at('2026-04-03T15:00:00Z').nextOpen)).toBe('2026-04-06T13:30:00.000Z');
    expect(at('2027-03-26T15:00:00Z')).toMatchObject({ state: 'CLOSED', reason: 'HOLIDAY' });
    expect(iso(at('2027-03-26T15:00:00Z').nextOpen)).toBe('2027-03-29T13:30:00.000Z');
  });
  it('observed holidays: Juneteenth on Friday 2027-06-18 and Christmas on Friday 2027-12-24', () => {
    expect(at('2027-06-18T15:00:00Z')).toMatchObject({ state: 'CLOSED', reason: 'HOLIDAY' });
    expect(at('2027-12-24T16:00:00Z')).toMatchObject({ state: 'CLOSED', reason: 'HOLIDAY' });
    expect(at('2027-12-23T16:00:00Z').state).toBe('OPEN'); // control: the day before is a normal day
  });
  it('New Year 2027-01-01 is closed; the next open is Monday 2027-01-04', () => {
    expect(iso(at('2027-01-01T15:00:00Z').nextOpen)).toBe('2027-01-04T14:30:00.000Z');
  });
});

describe('early closes (1:00 p.m. ET)', () => {
  it('Friday 2026-11-27 closes at 18:00Z and reports EARLY_CLOSE', () => {
    const open = at('2026-11-27T17:59:59.999Z');
    expect(open).toMatchObject({
      state: 'OPEN',
      session: 'EARLY_CLOSE',
      note: 'Day after Thanksgiving',
    });
    expect(iso(open.nextClose)).toBe('2026-11-27T18:00:00.000Z');
    const closed = at('2026-11-27T18:00:00.000Z');
    expect(closed).toMatchObject({ state: 'CLOSED', reason: 'AFTER_CLOSE' });
    expect(iso(closed.nextOpen)).toBe('2026-11-30T14:30:00.000Z');
  });
  it('Thursday 2026-12-24 closes early; Friday 2026-12-25 is closed; next open is Monday 2026-12-28', () => {
    expect(at('2026-12-24T17:59:59Z').session).toBe('EARLY_CLOSE');
    expect(at('2026-12-24T18:00:00Z').state).toBe('CLOSED');
    expect(iso(at('2026-12-24T19:00:00Z').nextOpen)).toBe('2026-12-28T14:30:00.000Z');
  });
  it('2027-11-26 closes early (control: an ordinary Friday at the same hour is still open)', () => {
    expect(at('2027-11-26T18:00:00Z').state).toBe('CLOSED');
    expect(at('2027-11-19T18:00:00Z').state).toBe('OPEN');
  });
});

describe('daylight-saving transitions (IANA zone, never a fixed offset)', () => {
  it('March 2026: the Friday before (EST) opens 14:30Z, the Monday after (EDT) opens 13:30Z', () => {
    expect(at('2026-03-06T14:29:59Z').state).toBe('CLOSED');
    expect(at('2026-03-06T14:30:00Z').state).toBe('OPEN');
    expect(at('2026-03-06T20:59:59Z').state).toBe('OPEN');
    expect(at('2026-03-06T21:00:00Z').state).toBe('CLOSED');
    const fri = at('2026-03-06T21:30:00Z');
    expect(iso(fri.nextOpen)).toBe('2026-03-09T13:30:00.000Z'); // across the change
    expect(at('2026-03-09T13:29:59Z').state).toBe('CLOSED');
    expect(at('2026-03-09T13:30:00Z').state).toBe('OPEN');
    expect(at('2026-03-09T19:59:59Z').state).toBe('OPEN');
    expect(at('2026-03-09T20:00:00Z').state).toBe('CLOSED');
  });
  it('November 2026: the Friday before (EDT) opens 13:30Z, the Monday after (EST) opens 14:30Z', () => {
    expect(at('2026-10-30T13:29:59Z').state).toBe('CLOSED');
    expect(at('2026-10-30T13:30:00Z').state).toBe('OPEN');
    expect(at('2026-10-30T19:59:59Z').state).toBe('OPEN');
    const close = at('2026-10-30T20:00:00Z');
    expect(close.state).toBe('CLOSED');
    expect(iso(close.nextOpen)).toBe('2026-11-02T14:30:00.000Z');
    expect(at('2026-11-02T14:29:59Z').state).toBe('CLOSED');
    expect(at('2026-11-02T14:30:00Z').state).toBe('OPEN');
    expect(at('2026-11-02T20:59:59Z').state).toBe('OPEN');
  });
  it('the transition Sundays themselves are weekends', () => {
    expect(at('2026-03-08T15:00:00Z').reason).toBe('WEEKEND');
    expect(at('2026-11-01T15:00:00Z').reason).toBe('WEEKEND');
  });
  it('2027: March 14 (Mon open 13:30Z from 2027-03-15) and November 7 (Mon open 14:30Z from 2027-11-08)', () => {
    expect(iso(at('2027-03-12T21:30:00Z').nextOpen)).toBe('2027-03-15T13:30:00.000Z');
    expect(iso(at('2027-11-05T20:30:00Z').nextOpen)).toBe('2027-11-08T14:30:00.000Z');
  });
});

describe('coverage: unknown is never guessed', () => {
  it('after the last covered day the state is CLOSED with CALENDAR_NOT_COVERED and no next times', () => {
    const s = at('2028-01-03T16:00:00Z');
    expect(s).toMatchObject({
      state: 'CLOSED',
      reason: 'CALENDAR_NOT_COVERED',
      nextOpen: null,
      nextClose: null,
    });
    expect(at('2025-12-31T16:00:00Z').reason).toBe('CALENDAR_NOT_COVERED');
  });
  it('on the last covered day the next open is unknown (null) rather than invented', () => {
    const s = at('2027-12-31T22:00:00Z');
    expect(s.state).toBe('CLOSED');
    expect(s.nextOpen).toBeNull();
  });
});

describe('parseCalendar (Zod)', () => {
  const good = JSON.parse(JSON.stringify(CAL)) as Record<string, unknown>;
  const change = (patch: Record<string, unknown>) => ({ ...good, ...patch });

  it('accepts the NYSE data (control)', () => {
    expect(parseCalendar(good).timezone).toBe('America/New_York');
  });
  it.each([
    ['an unknown time zone', change({ timezone: 'Mars/Olympus' })],
    ['a fixed offset instead of an IANA zone', change({ timezone: 'UTC-5' })],
    ['an unknown key', change({ extra: 1 })],
    ['close before open', change({ regular: { open: '16:00', close: '09:30', days: [1] } })],
    ['a bad time', change({ regular: { open: '9:30', close: '16:00', days: [1] } })],
    ['a bad weekday', change({ regular: { open: '09:30', close: '16:00', days: [7] } })],
    ['an impossible date', change({ holidays: [{ date: '2026-02-30', name: 'x' }] })],
    [
      'a duplicate holiday',
      change({
        holidays: [
          { date: '2026-01-01', name: 'a' },
          { date: '2026-01-01', name: 'b' },
        ],
      }),
    ],
    ['a holiday outside coverage', change({ holidays: [{ date: '2030-01-01', name: 'x' }] })],
    [
      'an early close after the regular close',
      change({ earlyCloses: [{ date: '2026-11-27', close: '16:30', name: 'x' }] }),
    ],
    [
      'an early close on a holiday',
      change({ earlyCloses: [{ date: '2026-12-25', close: '13:00', name: 'x' }] }),
    ],
    ['reversed coverage', change({ coverage: { from: '2027-12-31', to: '2026-01-01' } })],
    ['the wrong version', change({ version: 2 })],
  ])('rejects %s', (_n, bad) => {
    expect(() => parseCalendar(bad)).toThrow(CalendarError);
  });
});

describe('properties', () => {
  const instant = fc.integer({
    min: Date.parse('2026-01-01T05:00:00Z'),
    max: Date.parse('2027-12-31T04:00:00Z'),
  });

  it('OPEN always has a session and a future close; CLOSED never has a session; next times are in the future', () => {
    fc.assert(
      fc.property(instant, (ms) => {
        const s = marketState(CAL, new Date(ms));
        if (s.state === 'OPEN') {
          expect(s.session).not.toBeNull();
          expect(s.reason).toBeNull();
          expect(s.nextClose?.getTime() ?? 0).toBeGreaterThan(ms);
        } else {
          expect(s.session).toBeNull();
          expect(s.reason).not.toBeNull();
        }
        if (s.nextOpen !== null) expect(s.nextOpen.getTime()).toBeGreaterThan(ms);
        if (s.nextClose !== null) expect(s.nextClose.getTime()).toBeGreaterThan(ms);
      }),
      { numRuns: 1000 },
    );
  });

  it('is never open on a weekend or a listed holiday', () => {
    fc.assert(
      fc.property(instant, (ms) => {
        const s = marketState(CAL, new Date(ms));
        const weekday = new Date(`${s.localDate}T12:00:00Z`).getUTCDay();
        const holiday = CAL.holidays.some((h) => h.date === s.localDate);
        if (weekday === 0 || weekday === 6 || holiday) expect(s.state).toBe('CLOSED');
      }),
      { numRuns: 1000 },
    );
  });

  it('the open session length is 6.5 hours normally and 3.5 hours on an early close', () => {
    fc.assert(
      fc.property(instant, (ms) => {
        const s = marketState(CAL, new Date(ms));
        if (s.state !== 'OPEN' || s.nextClose === null) return;
        const remaining = s.nextClose.getTime() - ms;
        const max = s.session === 'EARLY_CLOSE' ? 3.5 * 3_600_000 : 6.5 * 3_600_000;
        expect(remaining).toBeLessThanOrEqual(max);
      }),
      { numRuns: 500 },
    );
  });
});

describe('sessionsBetween (the equity snapshot job)', () => {
  const dates = (from: string, to: string) => sessionsBetween(CAL, from, to).map((s) => s.date);

  it('lists only trading days: weekends and holidays are skipped (Thanksgiving week 2026)', () => {
    // Mon 23, Tue 24, Wed 25, Thu 26 = Thanksgiving (closed), Fri 27 = early close, Sat 28, Sun 29, Mon 30
    expect(dates('2026-11-23', '2026-11-30')).toEqual([
      '2026-11-23',
      '2026-11-24',
      '2026-11-25',
      '2026-11-27',
      '2026-11-30',
    ]);
    // control: an ordinary week has five sessions
    expect(dates('2026-11-09', '2026-11-13')).toHaveLength(5);
  });

  it('a regular session is 09:30 to 16:00 New York (EST = UTC-5 in November); the early close is 13:00', () => {
    const [tue] = sessionsBetween(CAL, '2026-11-10', '2026-11-10');
    expect(tue).toMatchObject({ date: '2026-11-10', kind: 'REGULAR', note: null });
    expect(tue?.open.toISOString()).toBe('2026-11-10T14:30:00.000Z');
    expect(tue?.close.toISOString()).toBe('2026-11-10T21:00:00.000Z');
    const [fri] = sessionsBetween(CAL, '2026-11-27', '2026-11-27');
    expect(fri).toMatchObject({ kind: 'EARLY_CLOSE', note: 'Day after Thanksgiving' });
    expect(fri?.close.toISOString()).toBe('2026-11-27T18:00:00.000Z');
  });

  it('follows daylight saving: the same 16:00 close is 20:00Z in summer', () => {
    const [s] = sessionsBetween(CAL, '2026-07-01', '2026-07-01');
    expect(s?.close.toISOString()).toBe('2026-07-01T20:00:00.000Z');
  });

  it('dates outside the coverage have no session (never guessed); an inverted range is empty; an absurd range is refused', () => {
    expect(dates('2025-01-02', '2025-01-03')).toEqual([]);
    expect(dates('2026-11-13', '2026-11-12')).toEqual([]);
    expect(() => sessionsBetween(CAL, '2026-01-01', '2029-01-01')).toThrow(CalendarError);
  });

  it('agrees with marketState: the market is OPEN just before each close and CLOSED at it', () => {
    for (const s of sessionsBetween(CAL, '2026-11-23', '2026-12-04')) {
      expect(marketState(CAL, new Date(s.close.getTime() - 1)).state).toBe('OPEN');
      expect(marketState(CAL, s.close).state).toBe('CLOSED');
      expect(exchangeDate(CAL, s.close)).toBe(s.date);
    }
  });

  it('nextDate and exchangeDate', () => {
    expect(nextDate('2026-11-30')).toBe('2026-12-01');
    expect(nextDate('2026-12-31')).toBe('2027-01-01');
    expect(exchangeDate(CAL, new Date('2026-11-11T03:00:00Z'))).toBe('2026-11-10'); // 22:00 the evening before in New York
  });
});
