import { describe, expect, it } from 'vitest';
import { LIMITS, RateLimiter } from './rate-limiter.js';

function limiter(limit: number, windowMs: number) {
  const clock = { t: 1_000_000 };
  const l = new RateLimiter({ limit, windowMs, now: () => clock.t });
  return { l, clock };
}

describe('RateLimiter (injected clock)', () => {
  it('allows up to the limit, then blocks', () => {
    const { l } = limiter(3, 60_000);
    for (let i = 0; i < 3; i += 1) {
      expect(l.isBlocked('k')).toBe(false); // control: still allowed
      l.record('k');
    }
    expect(l.isBlocked('k')).toBe(true);
    expect(l.count('k')).toBe(3);
  });

  it('keys are independent', () => {
    const { l } = limiter(1, 60_000);
    l.record('a');
    expect(l.isBlocked('a')).toBe(true);
    expect(l.isBlocked('b')).toBe(false);
  });

  it('events leave the window as the clock advances (sliding)', () => {
    const { l, clock } = limiter(2, 60_000);
    l.record('k'); // t0
    clock.t += 30_000;
    l.record('k'); // t0 + 30 s
    expect(l.isBlocked('k')).toBe(true);
    clock.t += 30_001; // the first event is now outside the window
    expect(l.isBlocked('k')).toBe(false);
    expect(l.count('k')).toBe(1);
    clock.t += 30_000;
    expect(l.count('k')).toBe(0);
  });

  it('retryAfterSeconds counts down to the oldest event leaving the window', () => {
    const { l, clock } = limiter(1, 60_000);
    l.record('k');
    expect(l.retryAfterSeconds('k')).toBe(60);
    clock.t += 59_500;
    expect(l.retryAfterSeconds('k')).toBe(1); // never below 1
    clock.t += 1_000;
    expect(l.isBlocked('k')).toBe(false);
  });

  it('tryConsume records only when allowed', () => {
    const { l } = limiter(2, 60_000);
    expect([l.tryConsume('k'), l.tryConsume('k'), l.tryConsume('k')]).toEqual([true, true, false]);
    expect(l.count('k')).toBe(2); // the refused attempt was not counted
  });

  it('sweep forgets expired keys', () => {
    const { l, clock } = limiter(5, 1_000);
    for (let i = 0; i < 10; i += 1) l.record(`k${String(i)}`);
    expect(l.size).toBe(10);
    clock.t += 2_000;
    l.sweep();
    expect(l.size).toBe(0);
  });

  it('the documented limits are 5 and 20 failed logins per 15 minutes and 10 registrations per hour', () => {
    expect(LIMITS.loginPair).toEqual({ limit: 5, windowMs: 900_000 });
    expect(LIMITS.loginIp).toEqual({ limit: 20, windowMs: 900_000 });
    expect(LIMITS.register).toEqual({ limit: 10, windowMs: 3_600_000 });
  });
});
