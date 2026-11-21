'use client';

// Phone-only pieces of the instrument page (M9b): the sticky Buy / Sell action bar and the watchlist drawer. Both are rendered only
// below 768 px (CSS `md:hidden`; the drawer is a native modal <dialog>, so focus trap, Esc and focus return come from the browser).
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { secondaryButtonClass } from './ui';

/**
 * The sticky action bar directly above the bottom tab bar. It sits in the page flow at the end of the instrument page and sticks
 * to the bottom of the screen while the page scrolls, so it can never hide content (at the end of the page it is simply the last
 * block). Each button presets the side and opens the ticket sheet.
 */
export function PhoneActionBar(props: {
  onBuy: (opener: HTMLElement) => void;
  onSell: (opener: HTMLElement) => void;
}) {
  return (
    <div
      data-testid="phone-action-bar"
      role="group"
      aria-label="Trade"
      className="sticky bottom-[calc(3rem+env(safe-area-inset-bottom))] z-30 grid grid-cols-2 gap-3 border-t border-line bg-bg-1 px-4 py-2 md:hidden"
    >
      <button
        type="button"
        data-testid="action-buy"
        onClick={(e) => props.onBuy(e.currentTarget)}
        className="inline-flex min-h-12 items-center justify-center rounded-md bg-buy px-4 text-[15px] font-semibold text-text-0"
      >
        <span aria-hidden="true">▲ </span>Buy
      </button>
      <button
        type="button"
        data-testid="action-sell"
        onClick={(e) => props.onSell(e.currentTarget)}
        className="inline-flex min-h-12 items-center justify-center rounded-md bg-sell px-4 text-[15px] font-semibold text-text-0"
      >
        <span aria-hidden="true">▼ </span>Sell
      </button>
    </div>
  );
}

/** The full-screen watchlist drawer (phone). A native modal dialog: closes with Esc, the Close button and a tap on the backdrop. */
export function FullScreenDrawer(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  testId: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const d = ref.current;
    if (d === null) return;
    if (props.open && !d.open) d.showModal();
    if (!props.open && d.open) d.close();
  }, [props.open]);
  return (
    <dialog
      ref={ref}
      data-testid={props.testId}
      aria-labelledby={`${props.testId}-title`}
      onClose={props.onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose(); // a tap on the backdrop
      }}
      className="sheet-anim m-0 h-dvh max-h-none w-screen max-w-none overflow-y-auto bg-bg-1 p-0 text-text-1 backdrop:bg-bg-0/70"
    >
      {props.open ? (
        <div className="pb-[env(safe-area-inset-bottom)]">
          <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-bg-1 px-4 py-2">
            <h2 id={`${props.testId}-title`} className="text-[16px] font-semibold text-text-0">
              {props.title}
            </h2>
            <button
              type="button"
              data-testid={`${props.testId}-close`}
              onClick={props.onClose}
              className={`${secondaryButtonClass} min-w-11`}
            >
              Close
            </button>
          </div>
          {props.children}
        </div>
      ) : null}
    </dialog>
  );
}
