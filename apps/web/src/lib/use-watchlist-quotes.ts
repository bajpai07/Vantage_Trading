'use client';
// ONE request for every watchlist row (GET /v1/quotes?symbols=A,B,...), never one per row (D-104, M9a T2): every `pollMs` while
// the tab is visible, paused while hidden (and refreshed at once when it returns), one cycle in flight, aborted on unmount, and
// restarted when the list changes. The browser keeps the last answer per symbol and says when a refresh failed.
import { useEffect, useState } from 'react';
import { QuotesResponse } from '@vantage/contracts';
import type { QuoteItem } from '@vantage/contracts';
import { nextDelayMs } from './backoff';
import { clientGet } from './client-api';

export interface WatchlistQuotes {
  readonly quotes: Readonly<Record<string, QuoteItem>>;
  /** true until the first answer */
  readonly loading: boolean;
  readonly failed: boolean;
  /** symbols the feed answered with known: false (to be dropped from the saved list) */
  readonly unknown: readonly string[];
}

export function useWatchlistQuotes(
  symbols: readonly string[],
  pollMs: number,
  enabled: boolean,
): WatchlistQuotes {
  const [state, setState] = useState<WatchlistQuotes>({
    quotes: {},
    loading: true,
    failed: false,
    unknown: [],
  });
  const key = symbols.join(',');

  useEffect(() => {
    if (!enabled) return undefined;
    if (key === '') {
      setState({ quotes: {}, loading: false, failed: false, unknown: [] });
      return undefined;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inflight = false;
    let failures = 0;
    let controller: AbortController | undefined;

    async function cycle(): Promise<void> {
      if (inflight || cancelled) return;
      inflight = true;
      controller = new AbortController();
      const r = await clientGet(
        `/v1/quotes?symbols=${encodeURIComponent(key)}`,
        QuotesResponse,
        controller.signal,
      );
      inflight = false;
      if (cancelled) return;
      if (r.ok) {
        failures = 0;
        const quotes: Record<string, QuoteItem> = {};
        const unknown: string[] = [];
        for (const q of r.data.quotes) {
          if (q.known) quotes[q.symbol] = q;
          else unknown.push(q.symbol);
        }
        setState({ quotes, loading: false, failed: false, unknown });
      } else {
        failures += 1;
        setState((s) => ({ ...s, loading: false, failed: true }));
      }
      schedule();
    }
    function schedule(): void {
      if (cancelled || document.hidden) return;
      clearTimeout(timer);
      timer = setTimeout(() => void cycle(), nextDelayMs(pollMs, failures));
    }
    const onVisibility = (): void => {
      if (document.hidden) {
        clearTimeout(timer);
        timer = undefined;
      } else void cycle();
    };
    void cycle();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [key, pollMs, enabled]);

  return state;
}
