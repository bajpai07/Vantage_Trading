// M8b-1 T7: the matcher timer never overlaps itself. A slow tick (runMatcherOnce still pending) must not let the interval start a
// second tick, and a manual runOnce() during a tick is a no-op. Fake timers and a controllable runMatcherOnce: no database.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@vantage/config';
import type { MatcherResult } from './matcher.js';

const tick = vi.hoisted(() => ({
  started: 0,
  running: 0,
  maxRunning: 0,
  release: [] as Array<() => void>,
}));
vi.mock('./matcher.js', () => ({
  runMatcherOnce: vi.fn(
    () =>
      new Promise<MatcherResult>((resolve) => {
        tick.started += 1;
        tick.running += 1;
        tick.maxRunning = Math.max(tick.maxRunning, tick.running);
        tick.release.push(() => {
          tick.running -= 1;
          resolve({} as MatcherResult);
        });
      }),
  ),
}));

const { MatcherService } = await import('./matcher.service.js');

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const make = () =>
  new MatcherService(
    {} as never,
    { now: () => new Date('2026-11-10T15:00:00Z') },
    { matcher: 'on', matcherIntervalMs: 100 } as Config,
    logger,
    {} as never,
  );

beforeEach(() => {
  vi.useFakeTimers();
  tick.started = 0;
  tick.running = 0;
  tick.maxRunning = 0;
  tick.release = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the matcher timer never overlaps itself', () => {
  it('a tick that takes 50 intervals starts no second tick; the next one starts one interval after it ends', async () => {
    const m = make();
    m.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(100); // the first tick starts
    expect(tick.started).toBe(1);

    await vi.advanceTimersByTimeAsync(5_000); // 50 intervals pass while it is still running
    expect(tick.started).toBe(1);
    expect(tick.maxRunning).toBe(1);
    expect(await m.runOnce()).toBeUndefined(); // a manual call during a tick is a no-op
    expect(tick.started).toBe(1);

    tick.release.shift()?.(); // the slow tick ends
    await vi.advanceTimersByTimeAsync(99);
    expect(tick.started).toBe(1); // the next is chained one full interval AFTER the end
    await vi.advanceTimersByTimeAsync(1);
    expect(tick.started).toBe(2);
    expect(tick.maxRunning).toBe(1);

    tick.release.shift()?.();
    m.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick.started).toBe(2); // shutdown stops the chain
  });

  it('a tick that throws is logged and the chain continues', async () => {
    const { runMatcherOnce } = await import('./matcher.js');
    vi.mocked(runMatcherOnce).mockRejectedValueOnce(new Error('boom'));
    const m = make();
    m.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(100);
    expect(logger.error).toHaveBeenCalledWith('matcher_tick_failed', { error: 'boom' });
    await vi.advanceTimersByTimeAsync(100);
    expect(tick.started).toBe(1); // the second tick (the mocked implementation) started
    expect(tick.maxRunning).toBe(1);
    tick.release.shift()?.();
    m.onApplicationShutdown();
  });

  it('MATCHER=off starts no timer', async () => {
    const m = new MatcherService(
      {} as never,
      { now: () => new Date() },
      { matcher: 'off', matcherIntervalMs: 100 } as Config,
      logger,
      {} as never,
    );
    m.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick.started).toBe(0);
  });
});
