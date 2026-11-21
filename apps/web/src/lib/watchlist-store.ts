// The watchlist (M9a, D-104): a per-viewer convenience saved in THIS browser (localStorage), never on the server. Pure functions
// plus a storage wrapper that never throws: with storage blocked, corrupt, or over the limit the terminal still renders (the
// default list) and says the list is not saved. Strings only.
import { SYMBOL_PATTERN } from '@vantage/contracts';

/** The fixed default list (D-104): seeded instruments of the public feed, stocks and ETFs first, then crypto. */
export const DEFAULT_WATCHLIST: readonly string[] = [
  'AAPL',
  'MSFT',
  'NVDA',
  'SPY',
  'BTC-USD',
  'ETH-USD',
  'SOL-USD',
  'XRP-USD',
  'DOGE-USD',
];

/** The instrument master names of the default symbols (a quote carries no name). Other symbols show their ticker only. */
export const DEFAULT_NAMES: Readonly<Record<string, string>> = {
  AAPL: 'Apple Inc.',
  MSFT: 'Microsoft',
  NVDA: 'NVIDIA',
  SPY: 'S&P 500 ETF',
  'BTC-USD': 'Bitcoin',
  'ETH-USD': 'Ethereum',
  'SOL-USD': 'Solana',
  'XRP-USD': 'XRP',
  'DOGE-USD': 'Dogecoin',
};

export const WATCHLIST_MAX = 50;
export const WATCHLIST_KEY = 'vantage.watchlist.v1';

export interface WatchlistState {
  readonly symbols: readonly string[];
  /** Names learned when a symbol was starred from its own page (symbol -> name). */
  readonly names: Readonly<Record<string, string>>;
}

export const DEFAULT_STATE: WatchlistState = {
  symbols: DEFAULT_WATCHLIST,
  names: DEFAULT_NAMES,
};

/** A list of valid, unique, upper-case symbols, at most WATCHLIST_MAX. Anything else is dropped, not repaired. */
export function sanitizeSymbols(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const v of input) {
    if (typeof v !== 'string') continue;
    const s = v.trim().toUpperCase();
    if (!SYMBOL_PATTERN.test(s) || out.includes(s)) continue;
    out.push(s);
    if (out.length >= WATCHLIST_MAX) break;
  }
  return out;
}

function sanitizeNames(input: unknown, symbols: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof input !== 'object' || input === null) return out;
  for (const s of symbols) {
    const n = (input as Record<string, unknown>)[s];
    if (typeof n === 'string' && n.length > 0 && n.length <= 60) out[s] = n;
  }
  return out;
}

/** Parses what storage returned. Corrupt or wrong-shaped JSON gives null (the caller uses the default list). */
export function parseStored(raw: string | null): WatchlistState | null {
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return null;
    const stored = (v as { symbols?: unknown }).symbols;
    // an explicitly saved empty list is a real choice ("I removed everything"); a missing or non-array field is corruption
    if (!Array.isArray(stored)) return null;
    const symbols = sanitizeSymbols(stored);
    return {
      symbols,
      names: { ...DEFAULT_NAMES, ...sanitizeNames((v as { names?: unknown }).names, symbols) },
    };
  } catch {
    return null;
  }
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The browser's localStorage, or null when it is blocked (the accessor itself can throw). */
export function browserStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Loads the saved list. `saved` says whether storage works (false: the list lives in memory only). */
export function loadWatchlist(storage: StorageLike | null): {
  state: WatchlistState;
  saved: boolean;
} {
  if (storage === null) return { state: DEFAULT_STATE, saved: false };
  try {
    return { state: parseStored(storage.getItem(WATCHLIST_KEY)) ?? DEFAULT_STATE, saved: true };
  } catch {
    return { state: DEFAULT_STATE, saved: false };
  }
}

/** Saves the list; returns false when it could not be saved (blocked, quota). Never throws. */
export function saveWatchlist(storage: StorageLike | null, state: WatchlistState): boolean {
  if (storage === null) return false;
  try {
    storage.setItem(
      WATCHLIST_KEY,
      JSON.stringify({ v: 1, symbols: state.symbols, names: state.names }),
    );
    return true;
  } catch {
    return false;
  }
}

/** Adds the symbol (at the end) or removes it. A full list (50) refuses the add and returns the same list. */
export function toggleSymbol(state: WatchlistState, symbol: string, name?: string): WatchlistState {
  if (state.symbols.includes(symbol)) {
    return { ...state, symbols: state.symbols.filter((s) => s !== symbol) };
  }
  if (state.symbols.length >= WATCHLIST_MAX) return state;
  return {
    symbols: [...state.symbols, symbol],
    names: name === undefined ? state.names : { ...state.names, [symbol]: name },
  };
}

/** Drops the symbols the feed does not know (D-104: validated against the feed on load). */
export function dropUnknown(state: WatchlistState, unknown: readonly string[]): WatchlistState {
  if (unknown.length === 0) return state;
  const drop = new Set(unknown);
  return { ...state, symbols: state.symbols.filter((s) => !drop.has(s)) };
}
