// M9a D-104: the watchlist storage. Blocked storage, corrupt JSON, more than 50 items, unknown symbols dropped, the default list.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NAMES,
  DEFAULT_STATE,
  DEFAULT_WATCHLIST,
  WATCHLIST_KEY,
  WATCHLIST_MAX,
  dropUnknown,
  loadWatchlist,
  parseStored,
  sanitizeSymbols,
  saveWatchlist,
  toggleSymbol,
} from './watchlist-store';
import type { StorageLike } from './watchlist-store';

const memory = (
  initial: Record<string, string> = {},
): StorageLike & { data: Record<string, string> } => {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
};
const blocked: StorageLike = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('SecurityError');
  },
};

describe('the default list (D-104)', () => {
  it('is 9 documented seeded symbols, all valid and unique', () => {
    expect(DEFAULT_WATCHLIST).toHaveLength(9);
    expect(sanitizeSymbols([...DEFAULT_WATCHLIST])).toEqual([...DEFAULT_WATCHLIST]);
    for (const s of DEFAULT_WATCHLIST) expect(DEFAULT_NAMES[s]).toBeTruthy();
  });
});

describe('loading', () => {
  it('nothing saved: the default list, and storage works', () => {
    expect(loadWatchlist(memory())).toEqual({ state: DEFAULT_STATE, saved: true });
  });
  it('blocked storage (null or a throwing accessor): the default list, not saved, no exception', () => {
    expect(loadWatchlist(null)).toEqual({ state: DEFAULT_STATE, saved: false });
    expect(loadWatchlist(blocked)).toEqual({ state: DEFAULT_STATE, saved: false });
  });
  it.each(['not json', '{', '123', 'null', '"x"', '{"symbols":"AAPL"}', '{"v":1}', '[1,2]'])(
    'corrupt or wrong-shaped value %s gives the default list',
    (raw) => {
      expect(loadWatchlist(memory({ [WATCHLIST_KEY]: raw })).state).toEqual(DEFAULT_STATE);
    },
  );
  it('drops invalid, duplicate and non-string entries and upper-cases the rest', () => {
    const s = parseStored(
      JSON.stringify({ symbols: ['aapl', 'AAPL', 7, 'bad symbol', 'btc-usd', '', null] }),
    );
    expect(s?.symbols).toEqual(['AAPL', 'BTC-USD']);
  });
  it('caps a saved list at 50 symbols', () => {
    const many = Array.from({ length: 80 }, (_, i) => `S${String(i)}`);
    expect(parseStored(JSON.stringify({ symbols: many }))?.symbols).toHaveLength(WATCHLIST_MAX);
  });
  it('an explicitly saved empty list stays empty (a real choice)', () => {
    expect(parseStored(JSON.stringify({ symbols: [] }))?.symbols).toEqual([]);
  });
});

describe('saving and toggling', () => {
  it('round-trips through storage; a failing store reports false and never throws', () => {
    const store = memory();
    const next = toggleSymbol(DEFAULT_STATE, 'GOOGL', 'Alphabet Inc. Class A');
    expect(saveWatchlist(store, next)).toBe(true);
    const back = loadWatchlist(store).state;
    expect(back.symbols).toContain('GOOGL');
    expect(back.names.GOOGL).toBe('Alphabet Inc. Class A');
    expect(saveWatchlist(blocked, next)).toBe(false);
    expect(saveWatchlist(null, next)).toBe(false);
  });
  it('toggle removes a present symbol and adds an absent one at the end', () => {
    const removed = toggleSymbol(DEFAULT_STATE, 'AAPL');
    expect(removed.symbols).not.toContain('AAPL');
    const added = toggleSymbol(removed, 'AAPL');
    expect(added.symbols[added.symbols.length - 1]).toBe('AAPL');
  });
  it('a full list (50) refuses another add (control: it still removes)', () => {
    const full = {
      symbols: Array.from({ length: WATCHLIST_MAX }, (_, i) => `S${String(i)}`),
      names: {},
    };
    expect(toggleSymbol(full, 'NEW')).toBe(full);
    expect(toggleSymbol(full, 'S0').symbols).toHaveLength(WATCHLIST_MAX - 1);
  });
});

describe('unknown symbols (validated against the feed on load)', () => {
  it('drops exactly the symbols the feed does not know', () => {
    const s = { symbols: ['AAPL', 'NOPE', 'BTC-USD'], names: {} };
    expect(dropUnknown(s, ['NOPE']).symbols).toEqual(['AAPL', 'BTC-USD']);
    expect(dropUnknown(s, [])).toBe(s);
  });
});
