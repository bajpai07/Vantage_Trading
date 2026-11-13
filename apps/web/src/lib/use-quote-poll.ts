'use client';
// D-73: the open instrument's quote is refreshed from GET /v1/quotes every `pollMs` while the tab is visible, paused
// while it is hidden (and refreshed at once when it comes back), with exponential backoff after errors (reset on
// success, capped at one minute). Nothing here reads a clock or compares timestamps: the freshness shown is whatever
// the API reports; the browser only keeps the last good answer and says when a refresh failed.
import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { QuotesResponse } from '@vantage/contracts';
import type { QuoteItem } from '@vantage/contracts';
import { nextDelayMs } from './backoff';
import { clientGet } from './client-api';
import { loginUrlFor } from './return-to';

export interface QuotePoll {
  readonly quote: QuoteItem;
  /** True after a refresh failed: the quote on screen is the last good one and may be out of date. */
  readonly refreshFailed: boolean;
  /** Counts successful refreshes (lets a consumer react to a new quote). */
  readonly version: number;
  /** Refresh now (for example right after a rejected order, to show the current price). */
  readonly refreshNow: () => void;
}

type PollState = Omit<QuotePoll, 'refreshNow'>;

export function useQuotePoll(symbol: string, initial: QuoteItem, pollMs: number): QuotePoll {
  const router = useRouter();
  const pathname = usePathname();
  const [state, setState] = useState<PollState>({
    quote: initial,
    refreshFailed: false,
    version: 0,
  });
  const failures = useRef(0);
  const refreshRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inflight = false;

    async function refresh(): Promise<void> {
      if (inflight || cancelled) return;
      inflight = true;
      const r = await clientGet(`/v1/quotes?symbols=${encodeURIComponent(symbol)}`, QuotesResponse);
      inflight = false;
      if (cancelled) return;
      const item = r.ok ? r.data.quotes.find((q) => q.symbol === symbol) : undefined;
      if (r.ok && item !== undefined) {
        failures.current = 0;
        setState((s) => ({ quote: item, refreshFailed: false, version: s.version + 1 }));
      } else if (!r.ok && r.kind === 'unauthenticated') {
        router.replace(loginUrlFor(pathname));
        router.refresh();
        return;
      } else {
        failures.current += 1;
        setState((s) => ({ ...s, refreshFailed: true }));
      }
      schedule();
    }
    function schedule(): void {
      if (cancelled || document.hidden) return;
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), nextDelayMs(pollMs, failures.current));
    }
    const onVisibility = (): void => {
      if (document.hidden) {
        clearTimeout(timer);
        timer = undefined;
      } else {
        void refresh(); // catch up at once when the tab comes back
      }
    };
    refreshRef.current = () => void refresh();
    schedule();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [symbol, pollMs, router, pathname]);

  return { ...state, refreshNow: () => refreshRef.current() };
}
