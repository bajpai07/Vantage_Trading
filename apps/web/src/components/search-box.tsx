'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { SearchResponse } from '@vantage/contracts';
import type { InstrumentItem } from '@vantage/contracts';
import { clientGet } from '../lib/client-api';
import { describeFailure } from '../lib/errors';
import { ASSET_CLASS_LABELS, statusView } from '../lib/market';
import { inputClass } from './ui';

const DEBOUNCE_MS = 250;

type SearchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'results'; items: readonly InstrumentItem[] }
  | { kind: 'empty'; query: string }
  | { kind: 'error'; message: string };

/**
 * The header search (DESIGN_SYSTEM section 6/8): `/` focuses it, typing searches (debounced, the newest answer wins),
 * ArrowUp/ArrowDown move through the results, Enter opens one, Escape closes. "No results" is a normal answer and is
 * worded as one, never as an error. Implements the ARIA combobox pattern (listbox + aria-activedescendant).
 */
export function SearchBox() {
  const router = useRouter();
  const uid = useId();
  const listId = `${uid}-list`;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [state, setState] = useState<SearchState>({ kind: 'idle' });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const latest = useRef(0); // only the newest request may update the screen

  // "/" focuses the search unless the user is already typing somewhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const typing =
        t !== null &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT' ||
          t.isContentEditable);
      if (typing) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const run = useCallback(async (q: string): Promise<void> => {
    const id = (latest.current += 1);
    setState({ kind: 'loading' });
    const r = await clientGet(`/v1/instruments/search?q=${encodeURIComponent(q)}`, SearchResponse);
    if (id !== latest.current) return; // a newer search has started
    if (r.ok) {
      setState(
        r.data.results.length === 0
          ? { kind: 'empty', query: q }
          : { kind: 'results', items: r.data.results },
      );
      setActive(0);
    } else {
      setState({ kind: 'error', message: describeFailure(r, 'load').message });
    }
  }, []);

  // debounce: search 250 ms after the last keystroke
  useEffect(() => {
    const q = query.trim();
    if (q === '') {
      latest.current += 1; // drop any search in flight
      setState({ kind: 'idle' });
      return;
    }
    const t = setTimeout(() => void run(q), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, run]);

  const items = state.kind === 'results' ? state.items : [];
  const go = (item: InstrumentItem): void => {
    setOpen(false);
    setQuery('');
    inputRef.current?.blur();
    router.push(`/instruments/${encodeURIComponent(item.symbol)}`);
  };

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => (items.length === 0 ? 0 : (a + 1) % items.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (items.length === 0 ? 0 : (a - 1 + items.length) % items.length));
    } else if (e.key === 'Enter') {
      const item = items[active];
      if (open && item !== undefined) {
        e.preventDefault();
        go(item);
      }
    } else if (e.key === 'Escape') {
      if (open || query !== '') e.preventDefault();
      setOpen(false);
      if (query === '') inputRef.current?.blur();
      else setQuery('');
    }
  }

  const showPanel = open && query.trim() !== '' && state.kind !== 'idle';
  const activeId =
    state.kind === 'results' && items[active] !== undefined
      ? `${uid}-opt-${String(active)}`
      : undefined;

  return (
    <div className="relative w-full md:max-w-sm" data-testid="search">
      <label htmlFor={`${uid}-input`} className="sr-only">
        Search stocks and ETFs
      </label>
      <input
        ref={inputRef}
        id={`${uid}-input`}
        type="search"
        role="combobox"
        aria-expanded={showPanel}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        autoComplete="off"
        spellCheck={false}
        maxLength={40}
        placeholder="Search stocks and ETFs   ( / )"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={(e) => {
          // keep the panel open while a result is being clicked
          if (!e.currentTarget.parentElement?.contains(e.relatedTarget)) setOpen(false);
        }}
        onKeyDown={onKeyDown}
        className={`${inputClass} py-1.5 text-[13px]`}
        data-testid="search-input"
      />
      <div aria-live="polite" className="sr-only" data-testid="search-status">
        {state.kind === 'loading' ? 'Searching' : null}
        {state.kind === 'empty' ? 'No results' : null}
        {state.kind === 'results'
          ? `${String(items.length)} result${items.length === 1 ? '' : 's'}`
          : null}
        {state.kind === 'error' ? 'Search is unavailable' : null}
      </div>
      <div
        hidden={!showPanel}
        className="absolute left-0 right-0 top-full z-50 mt-1 max-h-80 overflow-auto rounded-lg border border-line-strong bg-bg-3 shadow-[var(--shadow-overlay)]"
      >
        {state.kind === 'loading' ? (
          <div className="px-3 py-2 text-[13px] text-text-2" data-testid="search-loading">
            Searching…
          </div>
        ) : null}
        {state.kind === 'empty' ? (
          <div className="px-3 py-2 text-[13px] text-text-1" data-testid="search-empty">
            No stocks or ETFs match “{state.query}”. Try a ticker (AAPL) or part of a name.
          </div>
        ) : null}
        {state.kind === 'error' ? (
          <div className="px-3 py-2 text-[13px] text-text-1" data-testid="search-error">
            <span className="font-medium text-down">
              <span aria-hidden="true">✕ </span>Search is unavailable right now.
            </span>{' '}
            {state.message}{' '}
            <button
              type="button"
              className="text-accent underline"
              onClick={() => void run(query.trim())}
            >
              Try again
            </button>
          </div>
        ) : null}
        <div
          id={listId}
          role="listbox"
          aria-label="Search results"
          hidden={state.kind !== 'results'}
        >
          {state.kind === 'results'
            ? state.items.map((item, i) => {
                const sv = statusView(item.status);
                return (
                  <div
                    key={item.symbol}
                    id={`${uid}-opt-${String(i)}`}
                    role="option"
                    aria-selected={i === active}
                    data-testid="search-option"
                    data-symbol={item.symbol}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => go(item)}
                    onMouseEnter={() => setActive(i)}
                    className={`flex cursor-pointer items-baseline gap-2 px-3 py-2 text-[13px] ${i === active ? 'bg-bg-4' : ''}`}
                  >
                    <span className="num w-16 shrink-0 font-semibold text-text-0">
                      {item.symbol}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-text-1">{item.name}</span>
                    <span className="shrink-0 text-[11px] text-text-2">
                      {item.exchange} · {ASSET_CLASS_LABELS[item.assetClass]}
                    </span>
                    {sv.tone === 'ok' ? null : (
                      <span
                        data-testid="search-status-badge"
                        className={`shrink-0 rounded-sm border px-1 text-[11px] font-medium ${sv.tone === 'down' ? 'border-down text-down' : 'border-warn text-warn'}`}
                      >
                        {sv.label}
                      </span>
                    )}
                  </div>
                );
              })
            : null}
        </div>
      </div>
    </div>
  );
}
