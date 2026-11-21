'use client';

import { useEffect, useRef } from 'react';
import { SHORTCUT_HELP } from '../lib/shortcuts';
import { secondaryButtonClass } from './ui';

/**
 * The `?` help dialog (D-106): a native modal <dialog> (focus trap, Escape closes, focus returns to the opener) listing every
 * shortcut, with the switch that turns them off. Shortcuts never place orders and are ignored while you type.
 */
export function ShortcutsHelp({
  open,
  onClose,
  enabled,
  onEnabledChange,
}: {
  open: boolean;
  onClose: () => void;
  enabled: boolean;
  onEnabledChange: (on: boolean) => void;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const d = ref.current;
    if (d === null) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      data-testid="shortcuts-dialog"
      aria-labelledby="shortcuts-title"
      onClose={onClose}
      className="m-auto w-[min(92vw,26rem)] rounded-lg border border-line-strong bg-bg-2 p-5 text-text-1 backdrop:bg-bg-0/70"
    >
      <h2 id="shortcuts-title" className="mb-3 text-[16px] font-semibold text-text-0">
        Keyboard shortcuts
      </h2>
      <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
        {SHORTCUT_HELP.map((s) => (
          <div key={s.keys} className="contents">
            <dt>
              <kbd className="num rounded-sm border border-line-strong bg-bg-3 px-1.5 py-0.5 text-text-0">
                {s.keys}
              </kbd>
            </dt>
            <dd>{s.what}</dd>
          </div>
        ))}
      </dl>
      <p className="mb-3 text-[12px] text-text-2">
        Shortcuts only change what you see. They never place, confirm or cancel an order, and they
        are off while you type in a field.
      </p>
      <label className="mb-4 flex items-center gap-2 text-[13px] text-text-0">
        <input
          type="checkbox"
          data-testid="shortcuts-toggle"
          checked={enabled}
          onChange={(e) => onEnabledChange(e.target.checked)}
        />
        Keyboard shortcuts are on
      </label>
      <button
        type="button"
        onClick={onClose}
        className={secondaryButtonClass}
        data-testid="shortcuts-close"
      >
        Close
      </button>
    </dialog>
  );
}
