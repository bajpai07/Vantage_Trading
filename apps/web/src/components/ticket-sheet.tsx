'use client';

// The phone bottom sheet around the order ticket (M9b, D-108, D-109). It does NOT own or fork the ticket: the ticket is the SAME
// component and the SAME element at every width. At 768 px and above this wrapper is invisible (it renders its children in flow).
// Below 768 px the same element is moved to the bottom of the screen by CSS classes (never unmounted: a submitting order, an
// uncertain "Retry safely" state and its idempotency key survive closing and reopening the sheet) and, while open, behaves as a
// modal dialog: labelled, aria-modal, focus moved in and trapped, Esc / Close / backdrop close it (not while an order is being
// sent), and focus returns to the control that opened it. The on-screen keyboard is handled with window.visualViewport: the sheet
// is lifted above the keyboard and the focused field is scrolled into view; without visualViewport nothing is needed.
// CSP: no style attributes are written in markup; the viewport numbers are set as CSS custom properties through the CSSOM.
import { useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { useIsPhone } from '../lib/use-is-phone';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function TicketSheet(props: {
  open: boolean;
  /** An order is being sent: the sheet cannot be closed (the reason is shown). */
  locked: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const { open, locked, onClose } = props;
  const phone = useIsPhone() === true;
  const ref = useRef<HTMLDivElement | null>(null);
  const modal = open && phone;

  // move focus into the sheet when it opens
  useEffect(() => {
    if (!modal) return;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[data-sheet-initial]');
    first?.focus();
  }, [modal]);

  // the soft keyboard: lift the sheet above it and keep the focused field visible (rAF-throttled, removed on close)
  useEffect(() => {
    if (!modal) return undefined;
    const el = ref.current;
    const vv = window.visualViewport;
    if (el === null || vv === null) return undefined; // no visualViewport: the browser resizes the layout itself
    let raf = 0;
    const update = (): void => {
      raf = 0;
      const covered = window.innerHeight - vv.offsetTop - vv.height;
      el.style.setProperty('--vv-h', `${String(vv.height)}px`);
      el.style.setProperty('--vv-bottom', `${String(covered > 0 ? covered : 0)}px`);
      const focused = document.activeElement;
      if (
        focused instanceof HTMLElement &&
        el.contains(focused) &&
        focused.matches('input, select, textarea')
      )
        focused.scrollIntoView({ block: 'nearest' });
    };
    const schedule = (): void => {
      if (raf === 0) raf = requestAnimationFrame(update);
    };
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    update();
    return () => {
      vv.removeEventListener('resize', schedule);
      vv.removeEventListener('scroll', schedule);
      if (raf !== 0) cancelAnimationFrame(raf);
      el.style.removeProperty('--vv-h');
      el.style.removeProperty('--vv-bottom');
    };
  }, [modal]);

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>): void {
    if (!modal) return;
    // keys inside the ticket's own native review dialog belong to that dialog (it traps focus and handles Esc itself)
    if ((e.target as HTMLElement).closest('dialog') !== null) return;
    if (e.key === 'Escape') {
      if (!locked) {
        e.preventDefault();
        onClose();
      }
      return;
    }
    if (e.key !== 'Tab') return;
    const el = ref.current;
    if (el === null) return;
    const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (x) => x.closest('dialog') === null && x.getClientRects().length > 0,
    );
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) return;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !el.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !el.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <>
      {modal ? (
        <div
          aria-hidden="true"
          data-testid="sheet-backdrop"
          onClick={() => {
            if (!locked) onClose();
          }}
          className="fixed inset-0 z-40 bg-bg-0/70 md:hidden"
        />
      ) : null}
      <div
        ref={ref}
        data-testid="ticket-sheet"
        data-open={modal ? 'true' : 'false'}
        role={modal ? 'dialog' : undefined}
        aria-modal={modal ? true : undefined}
        aria-labelledby={modal ? 'ticket-title' : undefined}
        inert={phone && !open ? true : undefined}
        onKeyDown={onKeyDown}
        className={`sheet-anim max-md:fixed max-md:inset-x-0 max-md:bottom-[var(--vv-bottom,0px)] max-md:z-50 max-md:max-h-[min(92dvh,var(--vv-h,100dvh))] max-md:overflow-y-auto max-md:overscroll-contain max-md:rounded-t-[18px] max-md:border-t max-md:border-line-strong max-md:bg-bg-2 max-md:px-4 max-md:pb-[calc(1rem+env(safe-area-inset-bottom))] max-md:pt-2 ${
          modal ? 'max-md:translate-y-0' : 'max-md:invisible max-md:translate-y-full'
        }`}
      >
        <div className="mb-2 flex items-center justify-between md:hidden">
          <span aria-hidden="true" className="mx-auto h-1 w-10 rounded-sm bg-line-strong" />
        </div>
        <div className="mb-2 flex items-center justify-between gap-2 md:hidden">
          <button
            type="button"
            data-testid="sheet-close"
            data-sheet-initial
            disabled={locked}
            aria-describedby={locked ? 'sheet-locked-reason' : undefined}
            onClick={onClose}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-line-strong bg-bg-3 px-3 text-[13px] font-medium text-text-0 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Close
          </button>
          {locked ? (
            <span
              id="sheet-locked-reason"
              data-testid="sheet-locked-reason"
              className="text-[12px] text-text-1"
            >
              Your order is being sent. You can close this when it finishes.
            </span>
          ) : null}
        </div>
        {props.children}
      </div>
    </>
  );
}
