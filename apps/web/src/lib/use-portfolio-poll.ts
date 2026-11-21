'use client';
// M9a: ONE portfolio poll for the whole terminal (the header's Equity and the bottom panel's positions both read it): every
// `pollMs` while the tab is visible, paused while hidden, one request in flight, aborted on unmount. A failed refresh keeps the
// last answer and says so. Strings only: nothing here computes a number.
import { useCallback, useEffect, useRef, useState } from 'react';
import { PortfolioResponse } from '@vantage/contracts';
import { clientGet } from './client-api';

export interface PortfolioPoll {
  readonly data: PortfolioResponse | null;
  /** True after a refresh failed: `data` is the last good answer (or null if there never was one). */
  readonly failed: boolean;
  readonly refreshNow: () => void;
}

export function usePortfolioPoll(initial: PortfolioResponse | null, pollMs: number): PortfolioPoll {
  const [state, setState] = useState<{ data: PortfolioResponse | null; failed: boolean }>({
    data: initial,
    failed: false,
  });
  const refreshRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inflight = false;
    let controller: AbortController | undefined;

    async function cycle(): Promise<void> {
      if (inflight || cancelled) return;
      inflight = true;
      controller = new AbortController();
      const r = await clientGet('/v1/portfolio', PortfolioResponse, controller.signal);
      inflight = false;
      if (cancelled) return;
      setState((s) => (r.ok ? { data: r.data, failed: false } : { data: s.data, failed: true }));
      schedule();
    }
    function schedule(): void {
      if (cancelled || document.hidden) return;
      clearTimeout(timer);
      timer = setTimeout(() => void cycle(), pollMs);
    }
    const onVisibility = (): void => {
      if (document.hidden) {
        clearTimeout(timer);
        timer = undefined;
      } else void cycle();
    };
    refreshRef.current = () => void cycle();
    schedule();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [pollMs]);

  const refreshNow = useCallback(() => refreshRef.current(), []);
  return { ...state, refreshNow };
}
