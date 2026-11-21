'use client';

import { useEffect, useRef, useState } from 'react';
import { FLASH_MS, flashDirection, shouldFlash } from '../lib/flash';
import type { FlashDirection } from '../lib/flash';

/** True when the user asked for less motion (re-read on change). */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const m = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(m.matches);
    const on = (e: MediaQueryListEvent): void => setReduced(e.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return reduced;
}

/**
 * A price that flashes when it changes (D-105): green with ▲ for a higher price, red with ▼ for a lower one, for at most
 * 600 ms. The arrow slot is always reserved (no layout shift) and the flash is disabled under prefers-reduced-motion. `value`
 * is the exact string from the API (compared as text); `text` is what is shown.
 */
export function FlashPrice(props: {
  value: string | undefined;
  text: string;
  testId?: string;
  className?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const prev = useRef<string | undefined>(props.value);
  const [flash, setFlash] = useState<FlashDirection | null>(null);

  useEffect(() => {
    const dir = flashDirection(prev.current, props.value);
    prev.current = props.value;
    if (!shouldFlash(reduced, dir)) return undefined;
    setFlash(dir);
    const id = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(id);
  }, [props.value, reduced]);

  const tone = flash === 'up' ? 'text-up' : flash === 'down' ? 'text-down-text' : 'text-text-0';
  return (
    <span
      data-testid={props.testId}
      data-flash={flash ?? 'none'}
      className={`${props.className ?? ''} ${tone}`}
    >
      <span
        aria-hidden="true"
        className="inline-block w-3 text-center text-[10px] align-middle"
        data-testid={props.testId === undefined ? undefined : `${props.testId}-arrow`}
      >
        {flash === 'up' ? '▲' : flash === 'down' ? '▼' : ''}
      </span>
      {props.text}
    </span>
  );
}
