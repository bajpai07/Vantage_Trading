'use client';
// M8b-2: the simulated book of the open instrument and the caller's own open limit orders on it, refreshed like the quote feed
// (D-73): every `pollMs` while the tab is visible, paused while hidden (and refreshed at once when it returns), exponential
// backoff after errors. At most ONE cycle is in flight (a new cycle starts only after the previous one finished), and an
// unmount aborts the request in flight. The browser keeps the last answer; it does no arithmetic and reads no clock.
import { useCallback, useEffect, useRef, useState } from 'react';
import { DepthResponse, MyDepthOrdersResponse } from '@vantage/contracts';
import { nextDelayMs } from './backoff';
import { clientGet } from './client-api';

export type DepthState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | {
      readonly kind: 'ready';
      readonly depth: DepthResponse;
      /** null when the caller's orders could not be read (the book is still shown, without markers). */
      readonly mine: MyDepthOrdersResponse | null;
    };

export interface DepthPoll {
  readonly state: DepthState;
  readonly refreshNow: () => void;
}

export function useDepthPoll(symbol: string, pollMs: number, levels?: number): DepthPoll {
  const [state, setState] = useState<DepthState>({ kind: 'loading' });
  const refreshRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inflight = false;
    let failures = 0;
    let controller: AbortController | undefined;
    const q = `symbol=${encodeURIComponent(symbol)}${levels === undefined ? '' : `&levels=${String(levels)}`}`;

    async function cycle(): Promise<void> {
      if (inflight || cancelled) return;
      inflight = true;
      controller = new AbortController();
      const signal = controller.signal;
      const book = await clientGet(`/v1/market/depth?${q}`, DepthResponse, signal);
      // my-orders needs a book to be placed on; it is read in the same cycle, never in parallel with the next one
      const mine = book.ok
        ? await clientGet(`/v1/market/depth/my-orders?${q}`, MyDepthOrdersResponse, signal)
        : null;
      inflight = false;
      if (cancelled) return;
      if (book.ok) {
        failures = 0;
        setState({
          kind: 'ready',
          depth: book.data,
          mine: mine !== null && mine.ok ? mine.data : null,
        });
      } else {
        failures += 1;
        setState({ kind: 'error' }); // never keep levels that may be out of date
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
      } else {
        void cycle();
      }
    };
    refreshRef.current = () => void cycle();
    void cycle();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [symbol, pollMs, levels]);

  // stable identity: a consumer may use it as an effect dependency
  const refreshNow = useCallback(() => refreshRef.current(), []);
  return { state, refreshNow };
}
