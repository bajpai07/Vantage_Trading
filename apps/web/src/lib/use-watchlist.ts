'use client';
// The watchlist state of the terminal (D-104). The first render is the default list so the server and the browser agree; the
// saved list is read in an effect and replaces it (`loaded` says when). Storage failures never break anything.
import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_STATE,
  WATCHLIST_MAX,
  browserStorage,
  dropUnknown,
  loadWatchlist,
  saveWatchlist,
  toggleSymbol,
} from './watchlist-store';
import type { WatchlistState } from './watchlist-store';

export interface Watchlist {
  readonly state: WatchlistState;
  /** false until the saved list has been read (the rail shows its skeleton, then the list: no flicker of the default). */
  readonly loaded: boolean;
  /** false when browser storage is blocked or full: the list then lives in memory for this visit only. */
  readonly saved: boolean;
  readonly full: boolean;
  readonly toggle: (symbol: string, name?: string) => void;
  readonly forget: (unknown: readonly string[]) => void;
}

export function useWatchlist(): Watchlist {
  const [state, setState] = useState<WatchlistState>(DEFAULT_STATE);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(true);

  useEffect(() => {
    const r = loadWatchlist(browserStorage());
    setState(r.state);
    setSaved(r.saved);
    setLoaded(true);
  }, []);

  const commit = useCallback((next: WatchlistState): void => {
    setState(next);
    setSaved(saveWatchlist(browserStorage(), next));
  }, []);

  const toggle = useCallback(
    (symbol: string, name?: string) => commit(toggleSymbol(state, symbol, name)),
    [commit, state],
  );
  const forget = useCallback(
    (unknown: readonly string[]) => {
      const next = dropUnknown(state, unknown);
      if (next !== state) commit(next);
    },
    [commit, state],
  );
  return { state, loaded, saved, full: state.symbols.length >= WATCHLIST_MAX, toggle, forget };
}
