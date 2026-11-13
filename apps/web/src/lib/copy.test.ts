import { describe, expect, it } from 'vitest';
import { FreshnessState, ORDER_REJECT_CODES } from '@vantage/contracts';
import { FRESHNESS, freshnessView } from './freshness';
import { GENERIC_REJECT_COPY, REJECT_COPY, rejectMessage } from './reject-copy';

describe('reject-code copy is exhaustive against the contract', () => {
  it('has exactly one sentence for each of the contract codes, no more and no fewer', () => {
    expect(Object.keys(REJECT_COPY).sort()).toEqual([...ORDER_REJECT_CODES].sort());
    expect(ORDER_REJECT_CODES.length).toBe(13);
  });

  it.each([...ORDER_REJECT_CODES])(
    '%s has a plain sentence (no code, no jargon, ends with a full stop)',
    (code) => {
      const text = rejectMessage(code);
      expect(text).toBe(REJECT_COPY[code]);
      expect(text.length).toBeGreaterThan(25);
      expect(text).not.toContain(code);
      expect(text).not.toMatch(/[A-Z]{3,}_[A-Z]{3,}/);
      expect(text.endsWith('.')).toBe(true);
      expect(text).not.toBe(GENERIC_REJECT_COPY);
    },
  );

  it('the sentences are all different', () => {
    expect(new Set(Object.values(REJECT_COPY)).size).toBe(ORDER_REJECT_CODES.length);
  });

  it.each([null, undefined, '', 'SOMETHING_NEW', 'toString', '__proto__', 'constructor'])(
    'an unknown or missing code (%s) gets the generic sentence, never a blank, the raw code or an inherited property',
    (code) => {
      expect(rejectMessage(code)).toBe(GENERIC_REJECT_COPY);
    },
  );
});

describe('freshness mapping is exhaustive against the contract', () => {
  it('has a view for every state the API can send, and nothing else', () => {
    expect(Object.keys(FRESHNESS).sort()).toEqual([...FreshnessState.options].sort());
  });

  it('labels (control: exact words) and tones', () => {
    expect(freshnessView('REAL_TIME')).toMatchObject({ label: 'REAL-TIME', tone: 'up' });
    expect(freshnessView('DELAYED')).toMatchObject({ label: 'DELAYED', tone: 'warn' });
    expect(freshnessView('STALE')).toMatchObject({ label: 'STALE', tone: 'stale' });
    expect(freshnessView('CLOSED')).toMatchObject({ label: 'CLOSED', tone: 'muted' });
    expect(freshnessView('UNAVAILABLE')).toMatchObject({ label: 'UNAVAILABLE', tone: 'down' });
  });

  it('only REAL_TIME is ever labelled as live; every other state says what it is', () => {
    for (const s of FreshnessState.options) {
      const v = freshnessView(s);
      expect(v.label === 'REAL-TIME').toBe(s === 'REAL_TIME');
      expect(v.description.length).toBeGreaterThan(10);
    }
    expect(freshnessView('UNAVAILABLE').description).toContain('not included');
  });
});
