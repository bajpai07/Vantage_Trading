// M9a D-106: the shortcut decisions. Inactive in inputs, never an order action, off switch, no wrap at the ends.
import { describe, expect, it } from 'vitest';
import {
  SHORTCUTS_KEY,
  isTypingTarget,
  loadShortcutsEnabled,
  resolveShortcut,
  saveShortcutsEnabled,
  stepIndex,
  stepInterval,
} from './shortcuts';

const on = { enabled: true, dialogOpen: false };
const body = { tagName: 'BODY' };

describe('resolveShortcut', () => {
  it.each([
    ['b', { type: 'side', side: 'BUY' }],
    ['s', { type: 'side', side: 'SELL' }],
    ['[', { type: 'interval', delta: -1 }],
    [']', { type: 'interval', delta: 1 }],
    ['j', { type: 'watch', delta: 1 }],
    ['k', { type: 'watch', delta: -1 }],
    ['?', { type: 'help' }],
  ])('%s on the page does %j', (key, action) => {
    expect(resolveShortcut({ key }, body, on)).toEqual(action);
  });

  it.each([
    { tagName: 'INPUT' },
    { tagName: 'TEXTAREA' },
    { tagName: 'SELECT' },
    { tagName: 'input' },
  ])('is inactive while typing in %j', (target) => {
    for (const key of ['b', 's', '[', ']', 'j', 'k', '?'])
      expect(resolveShortcut({ key }, target, on)).toBeNull();
  });

  it('is inactive in contenteditable and in a textbox / combobox role', () => {
    expect(resolveShortcut({ key: 'b' }, { isContentEditable: true }, on)).toBeNull();
    expect(resolveShortcut({ key: 'b' }, { getAttribute: () => 'textbox' }, on)).toBeNull();
    expect(resolveShortcut({ key: 'b' }, { getAttribute: () => 'combobox' }, on)).toBeNull();
    expect(isTypingTarget({ getAttribute: () => 'button' })).toBe(false); // control
  });

  it('is inactive with a modifier, while composing, when switched off and while a dialog is open', () => {
    expect(resolveShortcut({ key: 'b', ctrlKey: true }, body, on)).toBeNull();
    expect(resolveShortcut({ key: 'b', metaKey: true }, body, on)).toBeNull();
    expect(resolveShortcut({ key: 'b', altKey: true }, body, on)).toBeNull();
    expect(resolveShortcut({ key: 'b', isComposing: true }, body, on)).toBeNull();
    expect(resolveShortcut({ key: 'b' }, body, { enabled: false, dialogOpen: false })).toBeNull();
    expect(resolveShortcut({ key: 'b' }, body, { enabled: true, dialogOpen: true })).toBeNull();
  });

  it('NEVER resolves to anything that could submit, confirm or cancel an order: Enter, space, Tab, digits and letters outside the list are not shortcuts', () => {
    for (const key of [
      'Enter',
      ' ',
      'Tab',
      'Escape',
      'c',
      'x',
      'r',
      'o',
      'm',
      'l',
      '0',
      '1',
      'Delete',
      'Backspace',
    ])
      expect(resolveShortcut({ key }, body, on)).toBeNull();
    // and every action type is UI state only
    const types = new Set(
      ['b', 's', '[', ']', 'j', 'k', '?'].map((key) => resolveShortcut({ key }, body, on)?.type),
    );
    expect([...types].sort()).toEqual(['help', 'interval', 'side', 'watch']);
  });
});

describe('steps', () => {
  it('stepInterval stops at both ends (no wrap)', () => {
    expect(stepInterval('15m', 1)).toBe('1h');
    expect(stepInterval('15m', -1)).toBe('5m');
    expect(stepInterval('1m', -1)).toBe('1m');
    expect(stepInterval('1d', 1)).toBe('1d');
  });
  it('stepIndex starts at the first row, stops at both ends and handles an empty list', () => {
    expect(stepIndex(-1, 1, 5)).toBe(0);
    expect(stepIndex(2, 1, 5)).toBe(3);
    expect(stepIndex(4, 1, 5)).toBe(4);
    expect(stepIndex(0, -1, 5)).toBe(0);
    expect(stepIndex(0, 1, 0)).toBe(-1);
  });
});

describe('the on/off choice is remembered with try/catch', () => {
  it('defaults to on; reads off; survives blocked storage', () => {
    const data: Record<string, string> = {};
    const store = {
      getItem: (k: string) => data[k] ?? null,
      setItem: (k: string, v: string) => void (data[k] = v),
    };
    expect(loadShortcutsEnabled(store)).toBe(true);
    saveShortcutsEnabled(store, false);
    expect(data[SHORTCUTS_KEY]).toBe('off');
    expect(loadShortcutsEnabled(store)).toBe(false);
    saveShortcutsEnabled(store, true);
    expect(loadShortcutsEnabled(store)).toBe(true);
    const bad = {
      getItem: () => {
        throw new Error('x');
      },
      setItem: () => {
        throw new Error('x');
      },
    };
    expect(loadShortcutsEnabled(bad)).toBe(true);
    expect(() => saveShortcutsEnabled(bad, false)).not.toThrow();
    expect(loadShortcutsEnabled(null)).toBe(true);
  });
});
