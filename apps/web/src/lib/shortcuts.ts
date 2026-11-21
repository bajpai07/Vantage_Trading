// Keyboard shortcuts of the terminal (M9a, D-106). Pure decisions: which key means what, and when a key must be ignored. A
// shortcut only ever changes UI state (the ticket's side, the chart interval, the highlighted watchlist row, the help dialog): it
// can never submit, confirm or cancel an order, and it is inactive while the user is typing in any field.
import { CANDLE_INTERVALS } from '@vantage/contracts';
import type { CandleInterval } from '@vantage/contracts';

export type ShortcutAction =
  | { readonly type: 'side'; readonly side: 'BUY' | 'SELL' }
  | { readonly type: 'interval'; readonly delta: -1 | 1 }
  | { readonly type: 'watch'; readonly delta: -1 | 1 }
  | { readonly type: 'help' };

export interface KeyLike {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  readonly isComposing?: boolean;
}

export interface TargetLike {
  readonly tagName?: string;
  readonly isContentEditable?: boolean;
  readonly getAttribute?: (name: string) => string | null;
}

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** True when the focused element takes typed text (a shortcut must not fire). Also true for contenteditable and a role=textbox. */
export function isTypingTarget(t: TargetLike | null | undefined): boolean {
  if (t === null || t === undefined) return false;
  if (t.tagName !== undefined && TYPING_TAGS.has(t.tagName.toUpperCase())) return true;
  if (t.isContentEditable === true) return true;
  const role = t.getAttribute?.('role');
  return role === 'textbox' || role === 'combobox' || role === 'searchbox';
}

/**
 * The action of a key press, or null (not a shortcut, shortcuts are off, a modifier is held, the user is typing, a dialog is
 * open, or the key is being composed).
 */
export function resolveShortcut(
  e: KeyLike,
  target: TargetLike | null | undefined,
  o: { readonly enabled: boolean; readonly dialogOpen: boolean },
): ShortcutAction | null {
  if (!o.enabled || o.dialogOpen) return null;
  if (e.ctrlKey === true || e.metaKey === true || e.altKey === true || e.isComposing === true)
    return null;
  if (isTypingTarget(target)) return null;
  switch (e.key) {
    case 'b':
    case 'B':
      return { type: 'side', side: 'BUY' };
    case 's':
    case 'S':
      return { type: 'side', side: 'SELL' };
    case '[':
      return { type: 'interval', delta: -1 };
    case ']':
      return { type: 'interval', delta: 1 };
    case 'j':
    case 'J':
      return { type: 'watch', delta: 1 };
    case 'k':
    case 'K':
      return { type: 'watch', delta: -1 };
    case '?':
      return { type: 'help' };
    default:
      return null;
  }
}

/** The interval `delta` steps away, stopping at the ends (no wrap-around: `[` on the first interval stays on it). */
export function stepInterval(current: CandleInterval, delta: -1 | 1): CandleInterval {
  const i = CANDLE_INTERVALS.indexOf(current);
  const next = i + delta;
  return CANDLE_INTERVALS[next < 0 ? 0 : next >= CANDLE_INTERVALS.length ? i : next] ?? current;
}

export const SHORTCUTS_KEY = 'vantage.shortcuts.v1';

/** Reads the saved on/off choice; anything unreadable means ON (the default). Never throws. */
export function loadShortcutsEnabled(
  storage: { getItem(k: string): string | null } | null,
): boolean {
  if (storage === null) return true;
  try {
    return storage.getItem(SHORTCUTS_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function saveShortcutsEnabled(
  storage: { setItem(k: string, v: string): void } | null,
  enabled: boolean,
): void {
  if (storage === null) return;
  try {
    storage.setItem(SHORTCUTS_KEY, enabled ? 'on' : 'off');
  } catch {
    /* blocked or full: the choice lasts for this visit only */
  }
}

export const SHORTCUT_HELP: ReadonlyArray<{ readonly keys: string; readonly what: string }> = [
  { keys: '/', what: 'Focus the search box' },
  { keys: 'b  /  s', what: 'Switch the order ticket to Buy / Sell' },
  { keys: '[  /  ]', what: 'Previous / next chart interval' },
  { keys: 'j  /  k', what: 'Move down / up the watchlist' },
  { keys: 'Enter', what: 'Open the watchlist symbol you moved to' },
  { keys: '?', what: 'Show this help' },
  { keys: 'Esc', what: 'Close a dialog' },
];

/** localStorage, or null when blocked (the accessor can throw). */
export function browserStorageOrNull(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The index `delta` steps from `from` in a list of `length`, stopping at both ends (no wrap). `from` < 0 means none yet. */
export function stepIndex(from: number, delta: -1 | 1, length: number): number {
  if (length <= 0) return -1;
  if (from < 0) return 0;
  const next = from + delta;
  return next < 0 ? 0 : next >= length ? length - 1 : next;
}
